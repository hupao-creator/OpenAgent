import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_RENDERER_PORT,
  acquireLock,
  checkoutIdentity,
  claimCheckout,
  clearAbandonedLock,
  devEnvironment,
  mainRepositoryRoot,
  ownsCheckout,
  parsePrimaryWorktree,
  parseRemoteSha,
  pnpmInvocation,
  statePath,
  worktreePath
} from '../dev-main.mjs'

const sha = 'a'.repeat(40)

test('parseRemoteSha picks the branch and ignores other refs', () => {
  const output = [
    `${'b'.repeat(40)}\trefs/heads/other`,
    `${sha}\trefs/heads/main`,
    `${'c'.repeat(40)}\trefs/tags/v1`
  ].join('\n')
  assert.equal(parseRemoteSha(output), sha)
  assert.equal(parseRemoteSha(`${sha}\trefs/heads/other`), null)
  assert.equal(parseRemoteSha(`${'a'.repeat(39)}\trefs/heads/main`), null)
  assert.equal(parseRemoteSha(''), null)
})

test('the checkout, state and dev profile stay outside the working tree', () => {
  // Built with `join` rather than written out: the functions under test are
  // platform-native, so literal POSIX expectations would fail on Windows.
  const mainRoot = join('/repo')
  const stateRoot = join(mainRoot, '.claude', 'dev-main')
  assert.equal(worktreePath(mainRoot), join(mainRoot, '.claude', 'worktrees', 'main-watch'))
  assert.equal(statePath(mainRoot), stateRoot)
  assert.deepEqual(devEnvironment({ port: DEFAULT_RENDERER_PORT, stateRoot }), {
    OPENAGENT_DEV_RENDERER_PORT: '5273',
    OPENAGENT_DEV_USER_DATA: join(stateRoot, 'user-data'),
    OPENAGENT_DEV_ATTACHMENT_ROOT: join(stateRoot, 'attachments')
  })
})

test('pnpmInvocation reuses the running pnpm when there is one', () => {
  const previous = process.env.npm_execpath
  try {
    process.env.npm_execpath = '/usr/local/bin/pnpm'
    assert.deepEqual(pnpmInvocation(['run', 'dev']), {
      command: process.execPath,
      args: ['/usr/local/bin/pnpm', 'run', 'dev']
    })
    delete process.env.npm_execpath
    assert.deepEqual(pnpmInvocation(['run', 'dev']).args, ['run', 'dev'])
  } finally {
    if (previous === undefined) delete process.env.npm_execpath
    else process.env.npm_execpath = previous
  }
})

test('parsePrimaryWorktree takes the first worktree and skips the rest', () => {
  const output = [
    'worktree /repo',
    'HEAD aaaa',
    'branch refs/heads/main',
    '',
    'worktree /repo/.claude/worktrees/main-watch',
    'HEAD bbbb',
    'detached',
    ''
  ].join('\n')
  assert.equal(parsePrimaryWorktree(output), resolve('/repo'))
  // Linked worktrees come after the main one, and their `HEAD`/`branch` lines
  // must not be mistaken for a worktree path.
  assert.equal(parsePrimaryWorktree(''), null)
  assert.equal(parsePrimaryWorktree('HEAD aaaa\n'), null)
})

test('mainRepositoryRoot resolves the main checkout from a linked worktree', () => {
  const root = resolve(mainRepositoryRoot())
  assert.ok(existsSync(join(root, '.git')), `${root} should hold the shared .git`)
})

/** Lay out a linked worktree the way git does: `.git` file plus an admin dir. */
function linkedWorktree(root, name, gitdirLine) {
  const checkoutRoot = join(root, name)
  const gitdir = join(root, 'common', 'worktrees', name)
  mkdirSync(checkoutRoot, { recursive: true })
  mkdirSync(gitdir, { recursive: true })
  writeFileSync(join(checkoutRoot, '.git'), `gitdir: ${gitdirLine ?? gitdir}\n`)
  return { checkoutRoot, gitdir }
}

test('checkoutIdentity reads the gitdir out of the .git file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openagent-dev-main-test-'))
  try {
    const { checkoutRoot, gitdir } = linkedWorktree(directory, 'main-watch')
    assert.equal(checkoutIdentity(checkoutRoot), gitdir)
    assert.equal(checkoutIdentity(join(directory, 'absent')), null)

    // A relative gitdir is resolved against the worktree root, as git does.
    const relative = linkedWorktree(directory, 'relative', '../common/worktrees/relative')
    assert.equal(checkoutIdentity(relative.checkoutRoot), relative.gitdir)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ownsCheckout only trusts a checkout this script claimed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openagent-dev-main-test-'))
  try {
    const { checkoutRoot, gitdir } = linkedWorktree(directory, 'main-watch')
    assert.equal(ownsCheckout(directory, checkoutRoot), false)

    claimCheckout(directory, checkoutRoot)
    assert.equal(ownsCheckout(directory, checkoutRoot), true)
    assert.equal(ownsCheckout(directory, join(directory, 'other')), false)

    // A worktree recreated at the same path reuses the gitdir, so the claim
    // has to rest on the token that lives and dies with the registration.
    rmSync(join(gitdir, 'openagent-dev-main'), { force: true })
    assert.equal(ownsCheckout(directory, checkoutRoot), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ownsCheckout rejects a claim that points somewhere else', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openagent-dev-main-test-'))
  try {
    const { checkoutRoot, gitdir } = linkedWorktree(directory, 'main-watch')
    claimCheckout(directory, checkoutRoot)

    const token = readFileSync(join(gitdir, 'openagent-dev-main'), 'utf8')
    writeFileSync(
      join(directory, 'worktree.json'),
      JSON.stringify({ path: join(directory, 'other'), gitdir, token })
    )
    assert.equal(ownsCheckout(directory, checkoutRoot), false)

    writeFileSync(
      join(directory, 'worktree.json'),
      JSON.stringify({ path: checkoutRoot, gitdir: join(directory, 'elsewhere'), token })
    )
    assert.equal(ownsCheckout(directory, checkoutRoot), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a takeover leaves a live lock that replaced the abandoned one alone', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openagent-dev-main-test-'))
  try {
    const lockPath = join(directory, 'dev-main.lock')
    const abandoned = join(directory, 'dev-main.lock.abandoned')
    const stale = JSON.stringify({ pid: 1, token: 'stale' })
    writeFileSync(lockPath, stale)

    // Another process wins the race in the window between judging the lock
    // abandoned and moving it aside, so what sits at the path is now live.
    const live = JSON.stringify({ pid: process.pid, token: 'live' })
    writeFileSync(lockPath, live)

    assert.equal(clearAbandonedLock(lockPath, abandoned, stale), false)
    // The live lock is put back rather than deleted, which is what would have
    // admitted a second owner.
    assert.equal(readFileSync(lockPath, 'utf8'), live)
    assert.deepEqual(readdirSync(directory).filter((name) => name.includes('abandoned')), [])

    // The genuine case still clears the way for a retry.
    writeFileSync(lockPath, stale)
    assert.equal(clearAbandonedLock(lockPath, abandoned, stale), true)
    assert.equal(existsSync(lockPath), false)
    assert.equal(existsSync(abandoned), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('acquireLock refuses a live owner and takes over an abandoned one', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openagent-dev-main-test-'))
  try {
    const lockPath = join(directory, 'dev-main.lock')
    acquireLock(lockPath)
    assert.throws(() => acquireLock(lockPath), /already running \(pid \d+\)/)

    const dead = spawn(process.execPath, ['-e', ''])
    await new Promise((resolveResult) => dead.once('close', resolveResult))
    writeFileSync(lockPath, JSON.stringify({ pid: dead.pid }))
    acquireLock(lockPath)

    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
