#!/usr/bin/env node
/** Scope-aware verification for GitHub Actions: plans from the PR diff, runs the
 *  required steps in the CI checkout, and publishes one `verify` check run. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPlanCompleted, planVerification, runVerificationGroup } from './verification-plan.mjs'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const context = 'verify'
const options = parseOptions(process.argv.slice(2))
if (options.help) {
  console.log(`Usage: node scripts/verify-ci.mjs [--full] [--serial] [--force-build] [--evidence <dir>]

Reads the verified commit from VERIFY_HEAD (default: HEAD of the checkout) and the
comparison baseline from VERIFY_BASE (absent: full verification). Publishes a
GitHub check run when GITHUB_REPOSITORY and GITHUB_TOKEN are set.
Native and development checks require macOS.`)
} else {
  try { await verify() } catch (error) {
    console.error(`::error::${error.message}`)
    process.exitCode = 1
  }
}

function parseOptions(args) {
  const result = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') result.help = true
    else if (['--full', '--serial', '--force-build'].includes(arg)) result[arg.slice(2)] = true
    else if (arg === '--evidence') {
      const value = args[++index]
      if (!value || value.startsWith('-')) throw new Error('--evidence requires a path')
      result.evidence = value
    } else throw new Error(`Unknown option: ${arg}`)
  }
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

function git(...args) { return command('git', args) }

function pnpm(args) {
  const cli = process.env.npm_execpath
  return cli && /pnpm(?:\.c?js)?$/i.test(cli)
    ? [process.execPath, [cli, ...args]] : ['pnpm', args]
}

// Actions turns these lines into run annotations; stdout alone would only be a log line.
function annotate(level, message) {
  console.log(`::${level}::${message.replace(/\r?\n/g, ' ')}`)
}

async function verify() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || major === 22 && minor < 19) throw new Error('Node >=22.19 is required')
  const sha = git('rev-parse', '--verify', '--end-of-options', `${process.env.VERIFY_HEAD || 'HEAD'}^{commit}`)
  const checkoutHead = git('rev-parse', 'HEAD')
  if (checkoutHead !== sha) throw new Error(`Checkout is at ${checkoutHead}, not the verified commit ${sha}`)
  const base = process.env.VERIFY_BASE || null
  const plan = planVerification({ cwd: sourceRoot, sha, base, full: options.full })
  if (process.platform !== 'darwin' && plan.requiredSteps.some(name => ['development', 'report-runtime', 'lifecycle-runtime', 'dev-scripts'].includes(name))) {
    throw new Error('Selected native/development checks require macOS')
  }
  const packageJson = JSON.parse(git('show', `${sha}:package.json`))
  const pnpmVersion = command(...pnpm(['--version']))
  if (`pnpm@${pnpmVersion}` !== packageJson.packageManager) {
    throw new Error(`Use ${packageJson.packageManager}; found pnpm@${pnpmVersion}`)
  }

  const directory = resolve(options.evidence || join(process.env.RUNNER_TEMP || tmpdir(), 'verification-evidence'))
  mkdirSync(directory, { recursive: true })
  // Native probes keep screenshots and manifests under their own evidence root or,
  // failing that, under TMPDIR; both stay outside the checkout. Pointing them at
  // the uploaded directory is what lets a hosted runner's failure be inspected at
  // all, and the workflow uploads `tmp` separately so the passing artifact stays small.
  const temporaryRoot = join(directory, 'tmp')
  mkdirSync(temporaryRoot, { recursive: true })
  const result = {
    schemaVersion: 3, context, sha, repository: process.env.GITHUB_REPOSITORY || null, pr: process.env.VERIFY_PR || null,
    runId: process.env.GITHUB_RUN_ID || null, plan, execution: options.serial ? 'serial' : 'parallel-read-checks',
    startedAt: new Date().toISOString(), status: 'running',
    platform: `${process.platform} ${process.arch} ${release()}`,
    node: process.version, pnpm: pnpmVersion, steps: [], directory,
    publication: 'disabled'
  }
  const environment = {
    ...process.env,
    // Husky 9 has no CI check of its own; without this the checkout's `prepare`
    // writes core.hooksPath into the checkout's config during a cache-miss install.
    CI: 'true', HUSKY: '0', CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    TMPDIR: temporaryRoot + '/',
    OPENAGENT_BUILD_EVIDENCE_DIR: join(directory, 'build-cache'),
    OPENAGENT_LIFECYCLE_EVIDENCE_ROOT: join(directory, 'lifecycle'),
    OPENAGENT_APPEARANCE_EVIDENCE_ROOT: join(directory, 'appearance'),
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
  const check = await startCheck(sha)

  async function step(name, program, args, timeoutMs = stepTimeout(name)) {
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
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(logPath, `$ ${[program, ...args].join(' ')}\n`)
    try {
      await new Promise((done, reject) => {
        const child = spawn(program, args, { cwd: sourceRoot, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
          else reject(new Error(`${name}: ${interrupted || (timedOut ? 'timeout' : signal || `exit ${code}`)}`))
        })
      })
      entry.status = 'passed'
    } catch (error) {
      entry.status = 'failed'
      entry.error = error.message
      annotate('error', `verify: ${name} ${error.message}`)
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

  try {
    await step('install', ...pnpm(['install', '--frozen-lockfile']))
    await step('toolchain', ...pnpm(['--dir', 'apps/desktop', 'exec', 'tsc', '--version']))
    if (plan.requiredSteps.includes('toolchain')) {
      result.typescript = JSON.parse(readFileSync(join(sourceRoot, 'apps/desktop/node_modules/typescript/package.json'), 'utf8')).version
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
    const workspaceArgs = mode => [join(sourceRoot, 'scripts/verification-workspace.mjs'), mode, sourceRoot, join(directory, 'plan.json'), directory, JSON.stringify(pnpm([]))]
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
    await step('development', process.execPath, [join(sourceRoot, 'scripts/verify-development.mjs')])
    await step('build', ...pnpm(['--dir', 'apps/desktop', 'build:bundles']))
    await step('report-runtime', ...pnpm(['--dir', 'apps/desktop', 'test:report-runtime']))
    await step('lifecycle-runtime', ...pnpm(['--dir', 'apps/desktop', 'test:lifecycle-runtime']))
    await step('tracked-diff', 'git', ['diff', '--exit-code', 'HEAD'])
    if (command('git', ['status', '--porcelain'])) {
      throw new Error('Verification left unexpected tracked or untracked source changes')
    }
    assertPlanCompleted(plan, result.steps)
    result.status = 'passed'
  } catch (error) {
    result.status = interrupted ? 'interrupted' : 'failed'
    result.error = error.message
    process.exitCode = 1
  } finally {
    try {
      const cacheEvidence = join(directory, 'build-cache')
      result.buildCache = existsSync(cacheEvidence)
        ? readdirSync(cacheEvidence).filter(name => name.endsWith('.json')).map(name => {
          const run = JSON.parse(readFileSync(join(cacheEvidence, name), 'utf8'))
          return { evidence: `build-cache/${name}`, tasks: run.tasks.map(task => ({ task: task.taskId, hash: task.hash, cache: task.cache.status })) }
        })
        : []
    } catch (error) {
      result.status = 'failed'
      result.error = `Cannot read build cache evidence: ${error.message}`
      process.exitCode = 1
    }
    result.finishedAt = new Date().toISOString()
    save()
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(result) + '\n')
    }
    const publication = await finishCheck(check, result)
    result.publication = publication
    save()
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
    console.log(`${result.status.toUpperCase()} ${sha}\nSummary: ${summaryPath}`)
    if (result.error) console.error(result.error)
    if (publication.startsWith('failed')) console.error(publication)
  }
}

function stepTimeout(name) {
  const minutes = { install: 20, typecheck: 30, regressions: 45, build: 30, 'browser-install': 15, development: 20 }[name] || 15
  return minutes * 60_000
}

// `output.summary` is what the PR gate reads back, so it must always carry the scope
// evidence line even when the run fails early.
function checkOutput(result) {
  return {
    title: `${result.status}: ${result.plan.profile} verification`,
    summary: [
      `scope-v2:${result.plan.profile}:${result.sha}:${result.plan.baseSha || 'none'}`,
      '',
      summary(result)
    ].join('\n')
  }
}

async function startCheck(sha) {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository || !process.env.GITHUB_TOKEN) return null
  // Attach to the commit that was verified, never to an event payload's merge
  // commit: that field still names the previous head on a `synchronize`, and the
  // gate reads check runs off the head, so the run would be invisible.
  const payload = {
    name: context,
    head_sha: sha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
    details_url: runUrl(repository),
    output: { title: 'Verification running', summary: 'Scope-aware verification is running.' }
  }
  try {
    const created = JSON.parse(command('gh', ['api', '--method', 'POST', `repos/${repository}/check-runs`, '--input', '-'], {
      input: JSON.stringify(payload)
    }))
    return { repository, id: created.id }
  } catch (error) {
    // Report the verification anyway; finishCheck turns the publication failure
    // into a non-zero exit so an unreportable run never reads as a pass.
    annotate('warning', `verify: cannot open the check run (${error.message})`)
    return { repository, error: error.message }
  }
}

async function finishCheck(check, result) {
  if (!check) return 'disabled'
  if (check.error) {
    process.exitCode = process.exitCode || 1
    return `failed: ${check.error}`
  }
  try {
    command('gh', ['api', '--method', 'PATCH', `repos/${check.repository}/check-runs/${check.id}`, '--input', '-'], {
      input: JSON.stringify({
        status: 'completed',
        conclusion: result.status === 'passed' ? 'success' : 'failure',
        completed_at: new Date().toISOString(),
        details_url: runUrl(check.repository),
        output: checkOutput(result)
      })
    })
    return 'published'
  } catch (error) {
    // A run that cannot report its own result must not look green.
    annotate('error', `verify: cannot publish the check run (${error.message})`)
    process.exitCode = process.exitCode || 1
    return `failed: ${error.message}`
  }
}

function runUrl(repository) {
  return process.env.GITHUB_RUN_ID ? `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` : `https://github.com/${repository}`
}

function summary(result) {
  return [
    '## Desktop verification', '',
    `Result: **${result.status}**`, '',
    `- Tested commit: \`${result.sha}\``,
    `- Plan: ${result.plan.profile}; areas: ${result.plan.scopes.join(', ')}`,
    `- Base: \`${result.plan.baseSha || 'none'}\`; merge-base: \`${result.plan.mergeBase || 'none'}\``,
    `- Execution: ${result.execution}`,
    `- Required: ${result.plan.requiredSteps.join(', ')}`,
    `- Skipped (not required): ${result.plan.skippedSteps.join(', ') || 'none'}`,
    `- Affected workspaces: ${result.plan.targets.join(', ') || 'none'}`,
    `- Changed paths: ${result.plan.files.length} (complete list in result.json)`,
    `- Reasons: ${result.plan.reasons.join('; ')}`,
    `- Environment: ${result.platform}; Node ${result.node}; pnpm ${result.pnpm}; TypeScript ${result.typescript || 'not yet checked'}`,
    `- Started: ${result.startedAt}; finished: ${result.finishedAt || 'running'}`,
    `- Artifact: verification-evidence (full logs and result.json)`,
    ...(result.testSelection || []).map(job => `- Tests ${job.workspace}: ${job.mode}, ${job.tests} tests in ${job.files?.length || 0} files. ${job.notes.join(' ')}`),
    '', '| Step | Result | Seconds | Log |', '| --- | --- | ---: | --- |',
    ...result.steps.map(step => `| ${step.name} | ${step.status} | ${step.durationMs === undefined ? '' : (step.durationMs / 1000).toFixed(1)} | \`${step.log}\` |`),
    ...(result.error ? ['', `Failure: ${result.error}`] : []),
    '', 'This verifies the PR head, not a synthetic merge with the base branch. A new commit or base requires a new run.', ''
  ].join('\n')
}
