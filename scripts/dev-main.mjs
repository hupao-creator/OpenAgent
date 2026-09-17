#!/usr/bin/env node
/** Keep a dev instance running the newest origin/main.
 *
 * The checkout lives in its own worktree so the branch you are working on is
 * never touched, and the instance gets its own renderer port, Electron profile
 * and attachment root so it runs beside your regular `pnpm dev` instead of
 * fighting it for the same port, profile reset and attachment owner index.
 *
 * The OpenAgent home (~/.OpenAgent) is still shared with the regular dev
 * instance: its thread workspaces are what makes generated no-CWD threads
 * recognizable as temporary, so that root deliberately stays put.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const BRANCH = 'main'
export const POLL_INTERVAL_MS = 30_000
export const DEFAULT_RENDERER_PORT = 5273
/** Only network-bound git calls get a deadline; local ones can be slow and are not at risk of hanging on a remote. */
const NETWORK_TIMEOUT_MS = 30_000
const WORKTREE_NAME = 'main-watch'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(`[dev-main] ${error.message}`)
    process.exit(1)
  })
}

/** Read the SHA of `refs/heads/<branch>` out of `git ls-remote` output. */
export function parseRemoteSha(stdout, branch = BRANCH) {
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const [sha, ref] = line.split(/\s+/)
    if (ref !== `refs/heads/${branch}`) continue
    if (!/^[0-9a-f]{40}$/.test(sha)) continue
    return sha
  }
  return null
}

export function worktreePath(mainRoot) {
  return join(mainRoot, '.claude', 'worktrees', WORKTREE_NAME)
}

export function statePath(mainRoot) {
  return join(mainRoot, '.claude', 'dev-main')
}

/**
 * The admin directory backing a linked worktree, read out of the `gitdir:`
 * line in its `.git` file. This is the worktree's registration, so it changes
 * when the worktree is recreated even at the same path.
 */
export function checkoutIdentity(checkoutRoot) {
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(checkoutRoot, '.git'), 'utf8'))
    return match ? resolve(checkoutRoot, match[1].trim()) : null
  } catch {
    return null
  }
}

const CLAIM_TOKEN_FILE = 'openagent-dev-main'

/**
 * `.claude/worktrees` is shared with every other checkout of this repository,
 * so reusing a path requires proof that dev-main created it. The token lives
 * in the worktree's own admin directory, so it disappears with the
 * registration: a worktree later recreated at the same path inherits neither
 * the token nor the right to be reset by `syncCheckout`.
 */
export function ownsCheckout(stateRoot, checkoutRoot) {
  try {
    const claim = JSON.parse(readFileSync(join(stateRoot, 'worktree.json'), 'utf8'))
    const identity = checkoutIdentity(checkoutRoot)
    if (!identity || claim.path !== checkoutRoot || claim.gitdir !== identity) return false
    return readFileSync(join(identity, CLAIM_TOKEN_FILE), 'utf8') === claim.token
  } catch {
    return false
  }
}

export function claimCheckout(stateRoot, checkoutRoot) {
  const gitdir = checkoutIdentity(checkoutRoot)
  if (!gitdir) throw new Error(`${checkoutRoot} is not a linked git worktree`)
  const token = randomUUID()
  mkdirSync(stateRoot, { recursive: true })
  // Write the token before the claim: a crash in between must leave a checkout
  // that looks unclaimed rather than one that looks owned.
  writeFileSync(join(gitdir, CLAIM_TOKEN_FILE), token)
  writeFileSync(
    join(stateRoot, 'worktree.json'),
    JSON.stringify({ path: checkoutRoot, gitdir, token })
  )
}

export function devEnvironment(input) {
  return {
    OPENAGENT_DEV_RENDERER_PORT: String(input.port),
    OPENAGENT_DEV_USER_DATA: join(input.stateRoot, 'user-data'),
    OPENAGENT_DEV_ATTACHMENT_ROOT: join(input.stateRoot, 'attachments')
  }
}

export function pnpmInvocation(args) {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && /pnpm(?:\.c?js)?$/i.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args] }
  }
  return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args }
}

/** The main worktree is the first entry of `git worktree list --porcelain`. */
export function parsePrimaryWorktree(stdout) {
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('worktree ')) return resolve(line.slice('worktree '.length))
  }
  return null
}

/**
 * Deriving this from the common Git directory's `dirname` only works while the
 * directory is `<checkout>/.git`, which a submodule or `--separate-git-dir`
 * checkout breaks. Ask Git for its worktree list instead.
 */
export function mainRepositoryRoot(cwd = repoRoot) {
  const path = parsePrimaryWorktree(git(['worktree', 'list', '--porcelain'], cwd))
  if (!path) throw new Error(`git reported no worktree for ${cwd}`)
  return path
}

export function git(args, cwd = repoRoot, timeoutMs) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    // `ls-remote` and `fetch` reach the network, and spawnSync blocks the whole
    // event loop: a remote waiting on SSH credentials or a stalled connection
    // would freeze polling and the signal handlers that release the lock.
    timeout: timeoutMs,
    killSignal: 'SIGKILL'
  })
  if (result.error) {
    const detail = result.error.code === 'ETIMEDOUT'
      ? `timed out after ${timeoutMs}ms`
      : result.error.message
    throw new Error(`git ${args.join(' ')}: ${detail}`)
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim() || `exit ${result.status}`}`)
  }
  return result.stdout.trim()
}

function log(message) {
  console.info(`[dev-main] ${message}`)
}

function readLockFile(lockPath) {
  try {
    return readFileSync(lockPath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Take an abandoned lock out of the way, but only when the file that was moved
 * aside is the one that was judged abandoned. Judging and moving cannot be made
 * one operation, and in between a second process can replace the abandoned lock
 * with a live one; moving that away instead would let both of them own the lock
 * and reset the same checkout concurrently. Returns whether the caller may
 * retry the create.
 */
export function clearAbandonedLock(lockPath, abandoned, judgedStale) {
  try {
    renameSync(lockPath, abandoned)
  } catch {
    return false
  }
  if (readLockFile(abandoned) !== judgedStale) {
    try {
      renameSync(abandoned, lockPath)
    } catch {
      // Something else installed a lock there already; leave that one alone.
    }
    return false
  }
  rmSync(abandoned, { force: true })
  return true
}

export function acquireLock(lockPath, attempts = 5) {
  mkdirSync(dirname(lockPath), { recursive: true })
  // The token tells two writes apart, so a lock can be recognised as the one
  // that was inspected instead of merely as "some file at this path".
  const mine = JSON.stringify({ pid: process.pid, token: randomUUID() })
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      writeFileSync(lockPath, mine, { flag: 'wx' })
      // Creating the file is not proof of owning it: a process that judged our
      // predecessor abandoned may still be finishing its takeover, and its
      // rename can land on top of what we just wrote. Only a lock that reads
      // back as ours means the lock is ours.
      if (readLockFile(lockPath) === mine) return
      continue
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const judgedStale = readLockFile(lockPath)
    if (lockIsHeld(lockPath)) {
      let pid = 'unknown'
      try {
        pid = JSON.parse(judgedStale).pid
      } catch {
        // Report the path alone when the lock cannot be read.
      }
      throw new Error(`already running (pid ${pid}); stop it first (${lockPath})`)
    }
    const abandoned = `${lockPath}.abandoned-${process.pid}-${attempt}`
    if (!clearAbandonedLock(lockPath, abandoned, judgedStale)) continue
  }
  throw new Error(`could not take the dev-main lock at ${lockPath}`)
}

function lockIsHeld(lockPath) {
  try {
    const { pid } = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (!Number.isInteger(pid) || pid < 1) return false
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    // An unreadable lock with a recent mtime may belong to a process that is
    // still starting up; only take it over once it looks abandoned.
    try {
      return Date.now() - statSync(lockPath).mtimeMs <= 60_000
    } catch {
      return false
    }
  }
}

async function main() {
  const mainRoot = mainRepositoryRoot()
  const checkoutRoot = worktreePath(mainRoot)
  const stateRoot = statePath(mainRoot)
  const port = Number(process.env.OPENAGENT_DEV_MAIN_PORT ?? DEFAULT_RENDERER_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`OPENAGENT_DEV_MAIN_PORT must be a port number, got ${process.env.OPENAGENT_DEV_MAIN_PORT}`)
  }

  const lockPath = join(stateRoot, 'dev-main.lock')
  acquireLock(lockPath)

  const children = new Set()
  let devChild = null
  let timer = null
  let stopping = false
  let busy = false
  // The revision we last tried, and the one the instance is actually built
  // from. They diverge after a failed build, which is what keeps a revision
  // that does not build from being retried every poll.
  let attemptedSha = null
  let runningSha = null
  let crashes = 0
  let reviveGaveUp = false
  let startedAt = 0
  const MAX_REVIVES = 5
  // Long enough that reaching it means the app really came up and served, as
  // opposed to failing on the way through its own startup.
  const HEALTHY_RUN_MS = 60_000

  const killTree = (child, signal) => {
    if (!child.pid) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.once('error', () => undefined)
      killer.once('close', () => undefined)
      return
    }
    try {
      process.kill(-child.pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        // The instance already exited.
      }
    }
  }

  const exited = (child) => child.exitCode !== null || child.signalCode !== null

  const waitFor = (child) => {
    if (exited(child)) return Promise.resolve(child.exitCode ?? 1)
    return new Promise((resolveResult) => {
      child.once('error', () => resolveResult(1))
      child.once('close', (code) => resolveResult(code ?? 1))
    })
  }

  const spawnPnpm = (args, options = {}) => {
    const invocation = pnpmInvocation(args)
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd ?? checkoutRoot,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      windowsHide: true
    })
    children.add(child)
    child.once('close', () => children.delete(child))
    return child
  }

  const stopChild = async (child, label) => {
    if (exited(child)) return
    if (label) log(label)
    killTree(child, 'SIGTERM')
    const escalate = setTimeout(() => killTree(child, 'SIGKILL'), 5_000)
    await waitFor(child)
    clearTimeout(escalate)
  }

  const stopDev = async () => {
    const child = devChild
    if (!child) return
    devChild = null
    await stopChild(child, 'stopping the current instance')
  }

  // An install or build in flight holds the checkout just as firmly as the dev
  // instance does, and on Windows nothing else would stop it before the lock
  // is released.
  const stopChildren = async () => {
    await Promise.all([...children].map((child) => stopChild(child)))
  }

  // The desktop runner re-detaches its own Electron and vite children, so the
  // pnpm child closing is not proof that the old instance let go of the
  // checkout. The renderer port is the shared resource we can actually observe.
  const portIsFree = () => new Promise((resolveResult) => {
    const probe = createServer()
    probe.once('error', () => resolveResult(false))
    probe.once('listening', () => probe.close(() => resolveResult(true)))
    probe.listen(port, '127.0.0.1')
  })

  const waitForPortRelease = async (timeoutMs = 15_000, abort = () => stopping) => {
    const deadline = Date.now() + timeoutMs
    while (!abort()) {
      if (await portIsFree()) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolveResult) => setTimeout(resolveResult, 250))
    }
    return false
  }

  const runStep = async (label, args) => {
    log(label)
    const code = await waitFor(spawnPnpm(args))
    if (code !== 0) console.error(`[dev-main] ${label} failed with exit code ${code}`)
    return code
  }

  const worktreeExists = () => existsSync(join(checkoutRoot, '.git'))

  const fetchOrigin = () => {
    git(
      ['fetch', '--no-tags', 'origin', BRANCH],
      worktreeExists() ? checkoutRoot : mainRoot,
      NETWORK_TIMEOUT_MS
    )
  }

  const ensureWorktree = (sha) => {
    if (worktreeExists()) {
      if (!ownsCheckout(stateRoot, checkoutRoot)) {
        throw new Error(
          `${checkoutRoot} is a worktree dev:main did not create; ` +
            'move it aside or remove it with `git worktree remove` before retrying'
        )
      }
      return
    }
    if (existsSync(checkoutRoot)) {
      throw new Error(`${checkoutRoot} exists but is not a git worktree; move it aside before retrying`)
    }
    log(`creating worktree ${checkoutRoot}`)
    mkdirSync(dirname(checkoutRoot), { recursive: true })
    // `--force` is what clears a registration left behind by a worktree whose
    // directory is gone, the one case where a plain add refuses. It is preferred
    // over `git worktree prune`, which covers the whole repository and would
    // also drop the registrations of worktrees that are merely unreachable right
    // now, such as one on an unmounted volume.
    git(['worktree', 'add', '--detach', '--force', checkoutRoot, sha], mainRoot)
    claimCheckout(stateRoot, checkoutRoot)
  }

  const syncCheckout = (sha) => {
    git(['rev-parse', '--verify', `${sha}^{commit}`], checkoutRoot)
    git(['reset', '--hard', sha], checkoutRoot)
  }

  const buildRevision = async (sha) => {
    try {
      ensureWorktree(sha)
      syncCheckout(sha)
    } catch (error) {
      console.error(`[dev-main] ${error.message}`)
      return 1
    }
    if (await runStep('installing dependencies', ['install'])) return 1
    return await runStep('building workspace packages', ['run', 'build:packages'])
  }

  const startDev = async () => {
    await stopDev()
    const environment = devEnvironment({ port, stateRoot })
    log(`starting the dev instance (renderer port ${port}, profile ${environment.OPENAGENT_DEV_USER_DATA})`)
    const child = spawnPnpm(['run', 'dev:electron'], { env: environment })
    devChild = child
    startedAt = Date.now()
    child.once('close', (code, signal) => {
      if (stopping || devChild !== child) return
      devChild = null
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? 1}`
      // An instance that ran for a while exited for its own reasons, so this is
      // a fresh incident rather than another failure of the same startup; the
      // cap then counts consecutive failures instead of a lifetime total.
      if (Date.now() - startedAt >= HEALTHY_RUN_MS) crashes = 0
      console.error(`[dev-main] the dev instance stopped (${detail}); reviving it on the next poll`)
    })
  }

  // A crash would otherwise leave the instance down until origin/main moves,
  // which is not what a resident watcher is for. The poll tick is the restart
  // cadence; the attempt cap keeps a revision that cannot start from looping.
  const reviveIfDown = async () => {
    if (devChild || stopping || !runningSha || reviveGaveUp) return
    if (crashes >= MAX_REVIVES) {
      reviveGaveUp = true
      console.error(
        `[dev-main] the instance kept exiting; not reviving ${runningSha.slice(0, 12)} ` +
          `again until origin/${BRANCH} changes`
      )
      return
    }
    crashes += 1
    log(`the instance is down; reviving ${runningSha.slice(0, 12)} (attempt ${crashes}/${MAX_REVIVES})`)
    await startDev()
  }

  // Returns whether `sha` was put through a build, which is what the caller
  // records as the attempted revision. Two invariants hold on every path out:
  // a revision that leaves no instance running clears `runningSha` (revival
  // reads "not tracked but still owning a revision" as a crash, and would
  // otherwise restart a tree we deliberately stopped), and a path that bails
  // before building returns false so the revision is retried on a later poll.
  const applyRevision = async (sha) => {
    const fallback = runningSha
    log(`rebuilding ${sha.slice(0, 12)}`)
    await stopDev()
    if (stopping) return false
    if (!(await waitForPortRelease())) {
      // The tree we stopped still holds the port, so it outlived our handle on
      // it. Disown the revision rather than let the next poll start a second
      // instance on the same port.
      runningSha = null
      console.error(`[dev-main] the previous instance still holds port ${port}; retrying on the next poll`)
      return false
    }

    if (await buildRevision(sha) === 0) {
      runningSha = sha
      crashes = 0
      reviveGaveUp = false
      if (stopping) return true
      await startDev()
      log(`running ${sha.slice(0, 12)}`)
      return true
    }

    if (!fallback) {
      console.error('[dev-main] nothing is running to fall back to; skipping this revision')
      return true
    }
    log(`falling back to ${fallback.slice(0, 12)}`)
    if (await buildRevision(fallback) !== 0) {
      // The checkout is left half-built, so the fallback is not runnable
      // either. Say so and stay stopped until origin/main moves, instead of
      // having the next poll launch dev:electron from that tree unbuilt.
      runningSha = null
      console.error('[dev-main] falling back failed too; leaving the instance stopped')
      return true
    }
    if (stopping) return true
    await startDev()
    log(`still running ${fallback.slice(0, 12)}; skipped ${sha.slice(0, 12)}`)
    return true
  }

  const poll = async () => {
    if (busy || stopping) return
    busy = true
    try {
      await reviveIfDown()
      const remoteSha = parseRemoteSha(
        git(['ls-remote', 'origin', `refs/heads/${BRANCH}`], mainRoot, NETWORK_TIMEOUT_MS)
      )
      if (!remoteSha) {
        console.error(`[dev-main] origin/${BRANCH} is missing; retrying on the next poll`)
        return
      }
      if (remoteSha === attemptedSha) return
      try {
        // Fetch before touching the instance: a network failure must not take
        // down a dev instance that is still serving the previous revision.
        fetchOrigin()
      } catch (error) {
        console.error(`[dev-main] fetch failed, will retry: ${error.message}`)
        return
      }
      // Only a revision we actually put through a build is worth remembering:
      // recording one that was skipped for a retryable reason would keep the
      // early return above from ever trying it again.
      if (await applyRevision(remoteSha)) attemptedSha = remoteSha
    } catch (error) {
      console.error(`[dev-main] ${error.message}`)
    } finally {
      busy = false
    }
  }

  const shutdown = (code) => {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    // Hold the lock until the instance is actually gone: releasing it earlier
    // would let a second dev:main touch the same checkout, state and port
    // while this one is still draining. Descendants are re-detached, so the
    // port is what proves they let go.
    void stopChildren()
      .then(() => waitForPortRelease(5_000, () => false))
      .finally(() => {
        rmSync(lockPath, { force: true })
        process.exit(code)
      })
  }

  process.on('SIGINT', () => shutdown(130))
  process.on('SIGTERM', () => shutdown(143))
  process.on('SIGHUP', () => shutdown(129))
  process.on('exit', () => {
    // Last resort for exits that never reached shutdown; nothing async can run
    // here, so Windows has to use the synchronous killer.
    for (const child of children) {
      if (!child.pid) continue
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        continue
      }
      killTree(child, 'SIGKILL')
    }
  })

  log(`watching origin/${BRANCH} every ${POLL_INTERVAL_MS / 1000}s from ${checkoutRoot}`)
  await poll()
  if (!stopping) timer = setInterval(() => { void poll() }, POLL_INTERVAL_MS)
}
