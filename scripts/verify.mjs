#!/usr/bin/env node
/** Scope-aware verification on a committed revision in a disposable worktree. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPlanCompleted, planVerification, runVerificationGroup } from './verification-plan.mjs'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const context = 'local/desktop-verification'
const options = parseOptions(process.argv.slice(2))
if (options.help) {
  console.log(`Usage: pnpm verify [--ref <commit> --base <commit>] [--pr <number> [--publish]] [--full] [--plan] [--serial] [--force-build]

Defaults to trusted committed HEAD. Requires a clean checkout, Node >=22.19 and
the package.json pnpm version (native/development checks require macOS). --pr fetches that PR's head; --publish also writes
a PR summary and commit status using gh. --ref and --pr are mutually exclusive.
--pr accepts only same-repository PRs authored by the authenticated GitHub user.
--pr compares against the PR merge-base. --base enables scoped local verification.
Without a baseline, runs full verification. --full forces all checks.
--plan prints the committed-source plan without installing or executing checks.
--serial disables parallel read-only checks for timing comparisons.
--force-build rebuilds all selected build tasks without reading their cache.
This runs as your local user, not in a security sandbox.
Logs remain under ~/Developer/.openagent-verification; the worktree is removed.`)
} else {
  try { await verify() } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

function parseOptions(args) {
  const result = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') result.help = true
    else if (['--publish', '--full', '--plan', '--serial', '--force-build'].includes(arg)) result[arg.slice(2)] = true
    else if (arg === '--pr' || arg === '--ref' || arg === '--base') {
      const value = args[++index]
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`)
      result[arg.slice(2)] = value
    } else throw new Error(`Unknown option: ${arg}`)
  }
  if (result.pr && !/^[1-9]\d*$/.test(result.pr)) throw new Error('--pr requires a PR number')
  if (result.pr && result.ref) throw new Error('Use either --pr or --ref')
  if (result.base && result.pr) throw new Error('--base cannot override a PR baseline')
  if (result.plan && result.publish) throw new Error('--plan cannot publish verification success')
  if (result.publish && !result.pr) throw new Error('--publish requires --pr')
  return result
}

function command(program, args, { cwd = sourceRoot, input } = {}) {
  const result = spawnSync(program, args, {
    cwd, input, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')}: ${result.error?.message || result.stderr || `exit ${result.status}`}`)
  }
  return result.stdout.trim()
}

// `git config --get` exits 1 for a key that is simply not set, which is a legitimate
// state here rather than a failure, so this cannot use command()'s throw-on-nonzero.
function readConfig(key) {
  const result = spawnSync('git', ['config', '--get', key], { cwd: sourceRoot, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git config --get ${key}: ${result.stderr || `exit ${result.status}`}`)
  }
  return (result.stdout || '').trim()
}

// Returns { restored?, error? } rather than throwing: this runs from the verification's
// finally, where a throw would replace the error that made the run fail in the first place.
function restoreConfig(key, before) {
  try {
    const current = readConfig(key)
    if (current === before) return {}
    command('git', before ? ['config', key, before] : ['config', '--unset', key])
    const restored = readConfig(key)
    if (restored !== before) return { error: `${key} still ${restored || 'unset'} after restore` }
    return { restored: `${current || 'unset'} -> ${before || 'unset'}` }
  } catch (error) {
    return { error: error.message }
  }
}

function git(...args) { return command('git', args) }
function gh(...args) { return JSON.parse(command('gh', args)) }

function pnpm(args) {
  const cli = process.env.npm_execpath
  return cli && /pnpm(?:\.c?js)?$/i.test(cli)
    ? [process.execPath, [cli, ...args]] : ['pnpm', args]
}

async function verify() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || major === 22 && minor < 19) throw new Error('Node >=22.19 is required')
  if (!options.plan && git('status', '--porcelain')) throw new Error('Commit or stash changes first; verification runs committed source only')
  const verifierSha = git('rev-parse', 'HEAD')
  let repository
  let pr
  if (options.pr) {
    repository = gh('repo', 'view', '--json', 'nameWithOwner').nameWithOwner
    pr = gh('pr', 'view', options.pr, '--repo', repository, '--json', 'number,url,headRefOid,baseRefOid,baseRefName,state,author,isCrossRepository')
    if (pr.state !== 'OPEN') throw new Error(`PR #${pr.number} is not open`)
    const viewer = gh('api', 'user').login
    if (pr.isCrossRepository || pr.author.login !== viewer) {
      throw new Error('Local verification accepts only your own same-repository PRs. Run external contributions in a disposable machine/account without developer credentials.')
    }
    git('fetch', '--no-tags', 'origin', `pull/${pr.number}/head`)
    if (git('rev-parse', 'FETCH_HEAD') !== pr.headRefOid) throw new Error('PR head changed during fetch; rerun verification')
    git('fetch', '--no-tags', 'origin', `refs/heads/${pr.baseRefName}`)
    if (git('rev-parse', 'FETCH_HEAD') !== pr.baseRefOid) throw new Error('PR base changed during fetch; rerun verification')
  }
  const sha = git('rev-parse', '--verify', '--end-of-options', `${pr?.headRefOid || options.ref || 'HEAD'}^{commit}`)
  const plan = planVerification({ cwd: sourceRoot, sha, base: pr?.baseRefOid || options.base, full: options.full })
  if (options.plan) { console.log(JSON.stringify({ sha, verifierSha, plan }, null, 2)); return }
  if (process.platform !== 'darwin' && plan.requiredSteps.some(name => ['development', 'report-runtime', 'lifecycle-runtime', 'bart-isolation', 'dev-scripts'].includes(name))) {
    throw new Error('Selected native/development checks require macOS')
  }
  const packageJson = JSON.parse(git('show', `${sha}:package.json`))
  const pnpmVersion = command(...pnpm(['--version']))
  if (`pnpm@${pnpmVersion}` !== packageJson.packageManager) {
    throw new Error(`Use ${packageJson.packageManager}; found pnpm@${pnpmVersion}`)
  }

  const parent = join(homedir(), 'Developer', '.openagent-verification')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-${sha.slice(0, 8)}-`))
  const checkout = join(directory, 'checkout')
  const logRoot = join(directory, 'logs')
  const temporaryRoot = join(directory, 'tmp')
  mkdirSync(logRoot)
  mkdirSync(temporaryRoot)
  const developmentProbe = join(directory, 'verify-development.mjs')
  // Freeze the probe to the recorded verifier commit, even when testing another PR.
  writeFileSync(developmentProbe, git('show', `${verifierSha}:scripts/verify-development.mjs`) + '\n')
  const workspaceProbe = join(directory, 'verification-workspace.mjs')
  writeFileSync(workspaceProbe, git('show', `${verifierSha}:scripts/verification-workspace.mjs`) + '\n')
  const result = {
    schemaVersion: 2, context, sha, verifierSha, repository, pr: pr?.number, plan, execution: options.serial ? 'serial' : 'parallel-read-checks',
    startedAt: new Date().toISOString(), status: 'running',
    platform: `${process.platform} ${process.arch} ${release()}`,
    node: process.version, pnpm: pnpmVersion, steps: [],
    directory, checkout, publication: options.publish ? 'pending' : 'disabled'
  }
  // Keep gh credentials and unrelated agent/session configuration in the parent.
  // This limits accidental inheritance; it does not sandbox trusted local code.
  const environment = {
    ...Object.fromEntries([
      'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
      'PNPM_HOME', 'COREPACK_HOME', 'XDG_CACHE_HOME', 'HTTP_PROXY', 'HTTPS_PROXY',
      'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
      'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'
    ].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    // HUSKY=0 keeps the disposable checkout's `prepare` from writing core.hooksPath
    // into the shared git config. CI alone does not: husky 9 has no CI check.
    CI: 'true', HUSKY: '0', CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    TMPDIR: `${temporaryRoot}/`,
    OPENAGENT_LIFECYCLE_EVIDENCE_ROOT: join(directory, 'lifecycle'),
    OPENAGENT_BUILD_EVIDENCE_DIR: join(directory, 'build-cache'),
    OPENAGENT_FORCE_BUILD: options['force-build'] ? '1' : '0'
  }
  // Children read an immutable plan, never the concurrently updated result.json.
  writeFileSync(join(directory, 'plan.json'), JSON.stringify({ plan }) + '\n')
  const summaryPath = join(directory, 'summary.md')
  const save = () => {
    writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n')
    writeFileSync(summaryPath, summary(result))
  }
  const activeStops = new Set()
  let interrupted
  let worktreeAdded = false
  let hooksPathBefore = null
  let commentUrl
  const onSignal = signal => {
    interrupted = signal
    for (const stop of activeStops) stop()
  }
  const onInterrupt = () => onSignal('SIGINT')
  const onTerminate = () => onSignal('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  console.log(`Verifying ${sha}\nEvidence: ${directory}`)
  save()

  async function step(name, program, args, timeoutMs = 10 * 60_000) {
    if (!plan.requiredSteps.includes(name)) return
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`)
    const log = `logs/${String(result.steps.length + 1).padStart(2, '0')}-${name}.log`
    const entry = { name, command: [program, ...args], log, startedAt: new Date().toISOString(), status: 'running' }
    result.steps.push(entry)
    save()
    console.log(`START ${name}`)
    let tail = ''
    let timedOut = false
    const started = Date.now()
    const logPath = join(directory, log)
    writeFileSync(logPath, `$ ${[program, ...args].join(' ')}\n`)
    try {
      await new Promise((done, reject) => {
        const child = spawn(program, args, { cwd: checkout, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let forceTimer
        const signalGroup = signal => {
          if (child.pid) {
            try { process.kill(-child.pid, signal) } catch (error) {
              if (error.code !== 'ESRCH') throw error
            }
          }
        }
        const stop = () => {
          signalGroup('SIGTERM')
          forceTimer ??= setTimeout(() => signalGroup('SIGKILL'), 15_000)
        }
        activeStops.add(stop)
        const capture = data => {
          appendFileSync(logPath, data)
          tail = (tail + data.toString()).slice(-8_000)
        }
        child.stdout.on('data', capture)
        child.stderr.on('data', capture)
        const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
        child.once('error', error => { clearTimeout(timer); clearTimeout(forceTimer); activeStops.delete(stop); reject(error) })
        child.once('close', (code, signal) => {
          clearTimeout(timer)
          clearTimeout(forceTimer)
          activeStops.delete(stop)
          entry.exitCode = code
          entry.signal = signal
          if (!interrupted && !timedOut && code === 0) done()
          else reject(Object.assign(new Error(`${name}: ${interrupted || (timedOut ? 'timeout' : signal || `exit ${code}`)}`),
            { environmentInconclusive: name === 'bart-isolation' && code === 75 && !interrupted && !timedOut && !signal }))
        })
      })
      entry.status = 'passed'
    } catch (error) {
      entry.status = error.environmentInconclusive ? 'environment-inconclusive' : 'failed'
      entry.error = error.message
      console.error(tail)
      throw error
    } finally {
      entry.durationMs = Date.now() - started
      entry.finishedAt = new Date().toISOString()
      entry.logSha256 = createHash('sha256').update(readFileSync(logPath)).digest('hex')
      save()
      console.log(`${entry.status.toUpperCase()} ${name} (${(entry.durationMs / 1000).toFixed(1)}s)`)
    }
  }

  function publishStatus(state, description) {
    command('gh', ['api', '--method', 'POST', `repos/${repository}/statuses/${sha}`, '--input', '-'], {
      input: JSON.stringify({ state, context, description, target_url: commentUrl || pr.url })
    })
  }

  try {
    if (options.publish) publishStatus('pending', `Verification running (${plan.profile})`)
    git('worktree', 'add', '--detach', checkout, sha)
    worktreeAdded = true
    // The install below runs this repository's `prepare`; assert it left the shared git
    // config alone, so a missing HUSKY=0 fails loudly instead of silently rewriting it.
    // The check alone would strand the rewrite on the developer's config when it fires,
    // or skip entirely when install throws first, so the finally below also restores.
    if (plan.requiredSteps.includes('install')) hooksPathBefore = readConfig('core.hooksPath')
    await step('install', ...pnpm(['install', '--frozen-lockfile']))
    const hooksPathAfter = readConfig('core.hooksPath')
    if (hooksPathBefore !== null && hooksPathAfter !== hooksPathBefore) {
      throw new Error(`install rewrote core.hooksPath (${hooksPathBefore || 'unset'} -> ${hooksPathAfter || 'unset'})`)
    }
    await step('toolchain', ...pnpm(['--dir', 'apps/desktop', 'exec', 'tsc', '--version']))
    if (plan.requiredSteps.includes('toolchain')) {
      result.typescript = JSON.parse(readFileSync(join(checkout, 'apps/desktop/node_modules/typescript/package.json'), 'utf8')).version
    }
    await step('pr-gate-tests', 'python3', ['-B', '-m', 'unittest', 'discover', '-s', 'scripts/tests', '-p', 'test_pr_gate.py'])
    await step('script-syntax', process.execPath, ['--input-type=module', '--eval', `
      import { existsSync } from 'node:fs'
      import { spawnSync } from 'node:child_process'
      for (const path of process.argv.slice(1)) {
        if (!existsSync(path)) continue
        const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' })
        if (result.error || result.status !== 0) process.exit(1)
      }
    `, ...plan.files.filter(path => /^scripts\/.*\.mjs$/.test(path))])
    await step('dev-scripts', ...pnpm(['test:dev-scripts']))
    await step('registry', ...pnpm(['--dir', 'apps/desktop', 'generate:registry']))
    await step('registry-diff', 'git', ['diff', '--exit-code', 'HEAD', '--', 'apps/desktop/src/generated'])
    const workspaceArgs = mode => [workspaceProbe, mode, checkout, join(directory, 'plan.json'), directory, JSON.stringify(pnpm([]))]
    const typecheck = () => plan.profile === 'full'
      ? step('typecheck', ...pnpm(['typecheck']))
      : step('typecheck', process.execPath, workspaceArgs('typecheck'))
    const regressions = () => plan.profile === 'full'
      ? step('regressions', ...pnpm(['test']))
      : step('regressions', process.execPath, workspaceArgs('regressions'))
    // Full entry points rebuild packages/registry, so keep those writers serial.
    // Scoped helpers call tsc/vitest directly against the prepared artifacts.
    await runVerificationGroup([
      typecheck,
      () => step('lint', ...pnpm(['lint'])),
      () => step('browser-install', ...pnpm(['--dir', 'apps/desktop', 'exec', 'playwright', 'install', 'chromium'])),
      ...(plan.profile === 'full' ? [] : [regressions])
    ], options.serial)
    if (plan.profile === 'full') await regressions()
    if (plan.profile !== 'full' && plan.requiredSteps.includes('regressions')) {
      result.testSelection = JSON.parse(readFileSync(join(directory, 'test-selection.json'), 'utf8'))
      save()
    }
    await step('development', process.execPath, [developmentProbe])
    await step('build', ...pnpm(['--dir', 'apps/desktop', 'build:bundles']))
    await step('report-runtime', ...pnpm(['--dir', 'apps/desktop', 'test:report-runtime']))
    await step('lifecycle-runtime', ...pnpm(['--dir', 'apps/desktop', 'test:lifecycle-runtime']))
    await step('bart-isolation', ...pnpm(['--dir', 'apps/desktop', 'test:bart-isolation']))
    await step('tracked-diff', 'git', ['diff', '--exit-code', 'HEAD'])
    if (command('git', ['status', '--porcelain'], { cwd: checkout })) {
      throw new Error('Verification left unexpected tracked or untracked source changes')
    }
    assertPlanCompleted(plan, result.steps)
    result.status = 'passed'
  } catch (error) {
    result.status = interrupted ? 'interrupted' : error.environmentInconclusive ? 'environment-inconclusive' : 'failed'
    result.error = error.message
    process.exitCode = interrupted === 'SIGINT' ? 130 : error.environmentInconclusive ? 75 : 1
  } finally {
    if (hooksPathBefore !== null) {
      const { restored, error } = restoreConfig('core.hooksPath', hooksPathBefore)
      if (restored) result.hooksPathRestored = restored
      if (error) {
        result.cleanupError = error
        result.status = 'failed'
        process.exitCode = 1
      }
    }
    if (worktreeAdded) {
      try {
        // Only this run's freshly created checkout is disposable. Logs live outside it.
        git('worktree', 'remove', '--force', checkout)
        result.checkoutRemoved = true
      } catch (error) {
        result.cleanupError = error.message
        result.status = 'failed'
        process.exitCode = 1
      }
    }
    try {
      const cacheEvidence = join(directory, 'build-cache')
      if (existsSync(cacheEvidence)) {
        result.buildCache = readdirSync(cacheEvidence).filter(name => name.endsWith('.json')).map(name => {
          const run = JSON.parse(readFileSync(join(cacheEvidence, name), 'utf8'))
          return { evidence: `build-cache/${name}`, tasks: run.tasks.map(task => ({ task: task.taskId, hash: task.hash, cache: task.cache.status })) }
        })
      }
    } catch (error) {
      result.status = 'failed'
      result.error = `Cannot read build cache evidence: ${error.message}`
      process.exitCode = 1
    }
    result.finishedAt = new Date().toISOString()
    save()
    if (options.publish) {
      try {
        const current = gh('pr', 'view', options.pr, '--repo', repository, '--json', 'headRefOid,baseRefOid')
        result.prHeadChanged = current.headRefOid !== sha
        result.prBaseChanged = current.baseRefOid !== plan.baseSha
        if (result.prBaseChanged) { result.status = 'failed'; result.error = 'PR base changed; rerun scope planning and verification'; process.exitCode = 1 }
        const body = summary(result, true)
        const comment = JSON.parse(command('gh', ['api', '--method', 'POST', `repos/${repository}/issues/${pr.number}/comments`, '--input', '-'], {
          input: JSON.stringify({ body })
        }))
        commentUrl = comment.html_url
        result.commentUrl = commentUrl
        publishStatus(result.status === 'passed' ? 'success' : result.status === 'environment-inconclusive' ? 'error' : 'failure',
          result.status === 'passed' ? `scope-v1:${plan.profile}:${plan.baseSha}` : result.status === 'environment-inconclusive' ? 'Host capture inconclusive; rerun verification' : 'Local verification failed; see PR evidence')
        result.publication = 'published'
      } catch (error) {
        result.publication = 'failed'
        result.publicationError = error.message
        process.exitCode = 1
        // Never leave a successful status when evidence could not be published.
        try { publishStatus('error', 'Local evidence publication failed; inspect local summary') } catch {}
      }
    }
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
    save()
    console.log(`${result.status.toUpperCase()} ${sha}\nSummary: ${summaryPath}`)
    if (result.error) console.error(result.error)
    if (result.publicationError) console.error(result.publicationError)
    if (commentUrl) console.log(`PR evidence: ${commentUrl}`)
  }
}

function summary(result, remote = false) {
  return [
    '## Local desktop verification', '',
    `Result: **${result.status}**`, '',
    `- Tested commit: \`${result.sha}\``,
    `- Verification scripts commit: \`${result.verifierSha}\``,
    `- Plan: ${result.plan.profile}; areas: ${result.plan.scopes.join(', ')}`,
    `- Base: \`${result.plan.baseSha || 'none'}\`; merge-base: \`${result.plan.mergeBase || 'none'}\``,
    `- Execution: ${result.execution}`,
    '- Build cache: local Turborepo; task hashes and hit/miss evidence under build-cache/ when supported by the target commit.',
    `- Required: ${result.plan.requiredSteps.join(', ')}`,
    `- Skipped (not required): ${result.plan.skippedSteps.join(', ') || 'none'}`,
    `- Affected workspaces: ${result.plan.targets.join(', ') || 'none'}`,
    `- Changed paths: ${result.plan.files.length} (complete list in result.json)`,
    `- Reasons: ${result.plan.reasons.join('; ')}`,
    `- Environment: ${result.platform}; Node ${result.node}; pnpm ${result.pnpm}; TypeScript ${result.typescript || 'not yet checked'}`,
    `- Started: ${result.startedAt}; finished: ${result.finishedAt || 'running'}`,
    ...(remote ? [] : [`- Evidence directory: ${result.directory}`, `- Publication: ${result.publication}`]),
    ...(result.prHeadChanged ? ['- PR head changed during verification. These results apply only to the tested commit; rerun for the new head.'] : []),
    ...(result.testSelection || []).map(job => `- Tests ${job.workspace}: ${job.mode}, ${job.tests} tests in ${job.files?.length || 0} files. ${job.notes.join(' ')}`),
    '', '| Step | Result | Seconds | Log |', '| --- | --- | ---: | --- |',
    ...result.steps.map(step => `| ${step.name} | ${step.status} | ${step.durationMs === undefined ? '' : (step.durationMs / 1000).toFixed(1)} | ${remote ? `\`${step.log}\`` : `[${step.log}](${step.log})`} |`),
    ...(result.error ? ['', `Failure: ${result.error}`] : []),
    ...(result.cleanupError ? ['', `Cleanup failure: ${result.cleanupError}`] : []),
    '', 'All execution is local. Full logs, their SHA-256 hashes and runtime evidence are retained on the executing Mac; only this summary is published to GitHub.',
    'This verifies the PR head, not a synthetic merge with the base branch. A new commit requires a new run.', ''
  ].join('\n')
}
