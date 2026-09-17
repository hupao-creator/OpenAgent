import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertPlanCompleted, fullSteps, planVerification, selectPlan, selectTestJobs, runVerificationGroup } from '../verification-plan.mjs'

const scripts = dirname(dirname(fileURLToPath(import.meta.url)))
const workspaces = [
  { path: 'packages/contracts', name: 'contracts', dependencies: [] },
  { path: 'packages/harness-a', name: 'harness-a', dependencies: ['contracts'] },
  { path: 'packages/harness-b', name: 'harness-b', dependencies: ['contracts'] },
  { path: 'apps/desktop', name: 'desktop', dependencies: ['harness-a', 'harness-b'] }
]
const plan = files => selectPlan(files, { baseSha: 'b'.repeat(40), workspaces })
const has = (value, ...steps) => steps.forEach(step => assert.ok(value.requiredSteps.includes(step), step))
const skips = (value, ...steps) => steps.forEach(step => assert.ok(!value.requiredSteps.includes(step), step))

test('documentation and gate changes avoid desktop installation; mixed scopes union', () => {
  assert.deepEqual(plan(['docs/agents/pr-gate.md']).requiredSteps, ['tracked-diff'])
  assert.deepEqual(plan(['docs/agents/pr-gate.md', 'scripts/pr_gate_lib.py']).requiredSteps, ['pr-gate-tests', 'tracked-diff'])
  const mixed = plan(['scripts/pr-gate.py', 'apps/desktop/src/renderer/view.tsx'])
  has(mixed, 'pr-gate-tests', 'regressions', 'build')
  skips(mixed, 'development', 'report-runtime', 'lifecycle-runtime')
})

test('workspace changes select transitive consumers without unrelated siblings', () => {
  const harness = plan(['packages/harness-a/src/main/run.ts'])
  assert.deepEqual(harness.targets, ['desktop', 'harness-a'])
  has(harness, 'typecheck', 'regressions', 'build', 'report-runtime', 'lifecycle-runtime')
  skips(harness, 'development', 'browser-install')
  assert.deepEqual(plan(['packages/contracts/src/types.ts']).targets, ['contracts', 'desktop', 'harness-a', 'harness-b'])
  const renderer = plan(['packages/harness-a/src/renderer/view.tsx'])
  skips(renderer, 'report-runtime', 'lifecycle-runtime')
})

test('tests, renderer, native and development checks are independently selected', () => {
  const tests = plan(['apps/desktop/tests/example.test.ts'])
  has(tests, 'typecheck', 'regressions')
  skips(tests, 'build', 'development', 'report-runtime', 'lifecycle-runtime')
  has(plan(['apps/desktop/src/main/ipc.ts']), 'report-runtime', 'lifecycle-runtime')
  has(plan(['apps/desktop/src/preload/index.ts']), 'report-runtime', 'lifecycle-runtime')
  has(plan(['apps/desktop/src/renderer/theme.ts']), 'lifecycle-runtime')
  const native = plan(['apps/desktop/tests/report-runtime.electron.mjs'])
  has(native, 'build', 'report-runtime')
  skips(native, 'regressions', 'lifecycle-runtime', 'development')
  const development = plan(['scripts/dev.mjs'])
  has(development, 'dev-scripts', 'browser-install', 'development', 'build')
  assert.deepEqual(plan(['scripts/tests/dev-app.test.mjs']).requiredSteps, ['dev-scripts', 'tracked-diff'])
  has(plan(['scripts/open-dev-app.mjs']), 'script-syntax', 'dev-scripts')
})

test('Bart renderer sources require no native window gate', () => {
  for (const path of ['bart-motion/motion.worker.ts', 'overview-motion/camera.ts',
    'components/HarnessSettingsPage.tsx', 'components/BartLogo.css']) {
    const renderer = plan([`apps/desktop/src/renderer/src/${path}`])
    has(renderer, 'build')
    skips(renderer, 'bart-isolation', 'lifecycle-runtime', 'report-runtime')
  }
  // The Electron suites need a native window the hosted runner cannot size, so
  // changing them falls through to full verification rather than gating on them.
  assert.deepEqual(plan(['apps/desktop/tests/bart-worker-suite.mjs']).requiredSteps, fullSteps)
})

test('unknown, global configuration, verifier, fixtures and no baseline require full verification', () => {
  for (const path of ['pnpm-lock.yaml', 'packages/harness-a/package.json', 'scripts/verify-ci.mjs',
    '.github/workflows/verify.yml',
    'scripts/verification-plan.mjs', 'scripts/tests/verification-plan.test.mjs', 'unknown.txt',
    'apps/desktop/tests/fixtures/data.json', 'apps/desktop/electron.vite.config.ts']) {
    assert.deepEqual(plan([path]).requiredSteps, fullSteps, path)
  }
  assert.deepEqual(selectPlan(['docs/a.md']).requiredSteps, fullSteps)
  assert.deepEqual(plan([]).requiredSteps, fullSteps)
  assert.deepEqual(selectPlan(['docs/a.md'], { baseSha: 'b', full: true }).requiredSteps, fullSteps)
})

test('success requires every selected step to have passed', () => {
  const value = plan(['scripts/pr-gate.py'])
  for (const steps of [[], [{ name: 'pr-gate-tests', status: 'failed' }], [{ name: 'tracked-diff', status: 'passed' }]]) {
    assert.throws(() => assertPlanCompleted(value, steps), /did not pass/)
  }
  assert.doesNotThrow(() => assertPlanCompleted(value, value.requiredSteps.map(name => ({ name, status: 'passed' }))))
})

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'verification-plan-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'repo')
  mkdirSync(cwd)
  function run(program, args, options = {}) {
    const result = spawnSync(program, args, { cwd, encoding: 'utf8', ...options })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    return result.stdout.trim()
  }
  const git = (...args) => run('git', args)
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'Verification Test')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  const write = (path, content) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), content) }
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD') }
  return { root, cwd, run, git, write, commit }
}

test('real Git planning uses merge-base, catches both rename paths and preserves unusual names', context => {
  const f = fixture(context)
  f.write('apps/desktop/package.json', JSON.stringify({ name: 'desktop', scripts: { test: 'vitest run' } }))
  f.write('apps/desktop/src/main/original.ts', 'export const value = 1\n')
  const ancestor = f.commit()
  f.git('checkout', '-qb', 'base')
  f.write('base-only.txt', 'not in PR\n')
  const base = f.commit()
  f.git('checkout', '-qb', 'feature', ancestor)
  f.git('mv', 'apps/desktop/src/main/original.ts', 'docs-renamed.md')
  f.write('docs/中文\n name.md', 'documentation\n')
  const sha = f.commit()
  const result = planVerification({ cwd: f.cwd, sha, base })
  assert.equal(result.mergeBase, ancestor)
  assert.ok(!result.files.includes('base-only.txt'))
  assert.ok(result.files.includes('apps/desktop/src/main/original.ts'))
  assert.ok(result.files.includes('docs-renamed.md'))
  assert.ok(result.files.includes('docs/中文\n name.md'))
  assert.equal(result.profile, 'full')
  assert.throws(() => planVerification({ cwd: f.cwd, sha, base: 'missing' }), /Cannot determine/)
})

test('CI runner executes a light scope, publishes scope evidence and never turns a failed step green', context => {
  const f = fixture(context)
  mkdirSync(join(f.cwd, 'scripts'), { recursive: true })
  for (const name of ['verify-ci.mjs', 'verification-plan.mjs', 'verify-development.mjs', 'verification-workspace.mjs']) {
    copyFileSync(join(scripts, name), join(f.cwd, 'scripts', name))
  }
  f.write('package.json', JSON.stringify({ packageManager: 'pnpm@10.17.1' }))
  f.write('docs/example.md', 'before\n')
  const base = f.commit()
  f.write('docs/example.md', 'after\n')
  const sha = f.commit()
  // A base branch that advanced after this run was queued: the PR's live base is
  // this commit, while the event payload still carries the older one.
  const feature = f.git('rev-parse', '--abbrev-ref', 'HEAD')
  f.git('checkout', '-q', '-b', 'advanced', base)
  f.write('base-only.txt', 'advanced\n')
  const liveBase = f.commit()
  f.git('checkout', '-q', feature)

  const bin = join(f.root, 'bin')
  mkdirSync(bin)
  const calls = join(f.root, 'gh-calls.txt')
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> ${calls}\ncase "$*" in *"--input -"*) cat >> ${calls};; esac\ncase "$*" in *"/pulls/1") echo '{"base":{"sha":"${liveBase}"}}';; *) echo '{"id": 42}';; esac\n`)
  chmodSync(join(bin, 'gh'), 0o755)
  const fakePnpm = join(f.root, 'pnpm.cjs')
  writeFileSync(fakePnpm, "if (process.argv[2] === '--version') console.log('10.17.1'); else process.exit(99)\n")
  const evidence = join(f.root, 'evidence')
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, npm_execpath: fakePnpm,
    VERIFY_HEAD: sha, VERIFY_BASE: base, VERIFY_PR: '1',
    GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'token'
  }
  f.run(process.execPath, ['scripts/verify-ci.mjs', '--evidence', evidence], { env })
  const result = JSON.parse(readFileSync(join(evidence, 'result.json'), 'utf8'))
  assert.equal(result.status, 'passed')
  assert.equal(result.plan.profile, 'scoped')
  assert.deepEqual(result.steps.map(step => step.name), ['tracked-diff'])
  assert.equal(result.publication, 'published')
  const published = readFileSync(calls, 'utf8')
  // The proof has to name the base the gate will compare against, which is the one
  // the PR has now — not the one the event payload captured when the run was queued.
  assert.match(published, new RegExp(`scope-v2:scoped:${sha}:${liveBase}`))
  assert.match(published, /check-runs\/42/)
  // The gate reads check runs off the head, and the event payload's merge commit
  // lags one head behind on a push, so the run has to name the verified commit.
  assert.match(published, new RegExp(`"head_sha":"${sha}"`))
  assert.match(readFileSync(join(evidence, 'summary.md'), 'utf8'), /Desktop verification/)

  f.write('scripts/open-dev-app.mjs', 'invalid syntax (\n')
  const brokenSha = f.commit()
  const broken = spawnSync(process.execPath, ['scripts/verify-ci.mjs', '--evidence', evidence], {
    cwd: f.cwd, env: { ...env, VERIFY_HEAD: brokenSha }, encoding: 'utf8'
  })
  assert.equal(broken.status, 1, broken.stderr + broken.stdout)
  const failed = JSON.parse(readFileSync(join(evidence, 'result.json'), 'utf8'))
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.steps.map(step => [step.name, step.status]), [['script-syntax', 'failed']])
})

test('CI runner refuses to verify a commit the checkout is not on', context => {
  const f = fixture(context)
  mkdirSync(join(f.cwd, 'scripts'), { recursive: true })
  copyFileSync(join(scripts, 'verify-ci.mjs'), join(f.cwd, 'scripts', 'verify-ci.mjs'))
  copyFileSync(join(scripts, 'verification-plan.mjs'), join(f.cwd, 'scripts', 'verification-plan.mjs'))
  f.write('package.json', JSON.stringify({ packageManager: 'pnpm@10.17.1' }))
  f.write('docs/example.md', 'before\n')
  const base = f.commit()
  f.write('docs/example.md', 'after\n')
  f.commit()
  const run = spawnSync(process.execPath, ['scripts/verify-ci.mjs'], {
    cwd: f.cwd, env: { ...process.env, VERIFY_HEAD: base, VERIFY_BASE: base }, encoding: 'utf8'
  })
  assert.equal(run.status, 1)
  assert.match(run.stdout + run.stderr, /not the verified commit/)
})

test('test-file selection unions changed tests, maps CSS, and falls back across package boundaries', () => {
  const spaces = workspaces.map(item => ({ ...item, hasTests: true }))
  const select = (files, existing) => selectTestJobs(files, ['desktop'], spaces, existing)[0]
  assert.equal(select(['apps/desktop/tests/a.test.ts']).mode, 'files')
  assert.equal(select(['apps/desktop/src/main/a.ts']).mode, 'related')
  assert.equal(select(['packages/harness-a/src/main/a.ts']).mode, 'suite')
  assert.equal(select(['apps/desktop/src/main/a.ts'], []).mode, 'suite')
  assert.equal(select(['apps/desktop/src/renderer/unknown.css']).mode, 'suite')
  const mapped = select(['apps/desktop/src/renderer/src/components/bart-reply.css'])
  assert.equal(mapped.mode, 'files')
  assert.equal(mapped.inputs.length, 2)
  assert.match(mapped.notes[0], /not screenshot/)
  assert.equal(select(['apps/desktop/src/renderer/src/components/bart-reply.css'], []).mode, 'suite')
  assert.equal(select(['apps/desktop/src/main/a.ts', 'apps/desktop/tests/a.test.ts']).inputs.length, 2)
})

test('parallel groups overlap independent tasks and drain siblings before reporting failure', async () => {
  let release
  const sibling = new Promise(resolve => { release = resolve })
  const events = []
  const running = runVerificationGroup([
    async () => { events.push('first'); await sibling; events.push('finished') },
    async () => { events.push('second'); throw new Error('failure') }
  ])
  await Promise.resolve()
  assert.deepEqual(events, ['first', 'second'])
  let settled = false
  const observed = running.catch(error => { settled = true; assert.match(error.message, /failure/) })
  await Promise.resolve()
  assert.equal(settled, false)
  release()
  await observed
  assert.deepEqual(events, ['first', 'second', 'finished'])
  const order = []
  await runVerificationGroup([async () => { order.push(1) }, async () => { order.push(2) }], true)
  assert.deepEqual(order, [1, 2])
})
