import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

test('Bart and its geometry dependencies require the native isolation gate', () => {
  for (const path of ['bart-motion/motion.worker.ts', 'overview-motion/camera.ts',
    'components/HarnessSettingsPage.tsx', 'components/BartLogo.css']) {
    has(plan([`apps/desktop/src/renderer/src/${path}`]), 'bart-isolation')
  }
  const native = plan(['apps/desktop/tests/bart-worker-suite.mjs'])
  has(native, 'bart-isolation', 'install', 'lint')
  skips(native, 'regressions', 'lifecycle-runtime')
})

test('unknown, global configuration, verifier, fixtures and no baseline require full verification', () => {
  for (const path of ['pnpm-lock.yaml', 'packages/harness-a/package.json', 'scripts/verify.mjs',
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

test('real runner executes lightweight scope, preserves hooks and cleans checkout without installation', context => {
  const f = fixture(context)
  for (const name of ['verify.mjs', 'verification-plan.mjs', 'verify-development.mjs', 'verification-workspace.mjs']) {
    mkdirSync(join(f.cwd, 'scripts'), { recursive: true })
    copyFileSync(join(scripts, name), join(f.cwd, 'scripts', name))
  }
  f.write('package.json', JSON.stringify({ packageManager: 'pnpm@10.17.1' }))
  f.write('docs/example.md', 'before\n')
  const base = f.commit()
  f.write('docs/example.md', 'after\n')
  f.commit()
  const fakePnpm = join(f.root, 'pnpm.cjs')
  writeFileSync(fakePnpm, "if(process.argv[2] === '--version') console.log('10.17.1'); else process.exit(99)\n")
  const home = join(f.root, 'home')
  mkdirSync(home)
  const env = { ...process.env, HOME: home, npm_execpath: fakePnpm }
  f.run(process.execPath, ['scripts/verify.mjs', '--base', base], { env })
  const evidenceRoot = join(home, 'Developer', '.openagent-verification')
  const evidence = JSON.parse(readFileSync(join(evidenceRoot, readdirSync(evidenceRoot)[0], 'result.json'), 'utf8'))
  assert.equal(evidence.status, 'passed')
  assert.equal(evidence.checkoutRemoved, true)
  assert.deepEqual(evidence.steps.map(step => step.name), ['tracked-diff'])
  assert.equal(evidence.plan.baseSha, base)
  assert.equal(f.git('config', 'core.hooksPath'), '/dev/null')
  assert.equal(f.git('status', '--porcelain'), '')
  f.write('scripts/open-dev-app.mjs', 'invalid syntax (\n')
  f.commit()
  const broken = spawnSync(process.execPath, ['scripts/verify.mjs', '--base', base], { cwd: f.cwd, env, encoding: 'utf8' })
  assert.equal(broken.status, 1)
  const failed = JSON.parse(readFileSync(join(evidenceRoot, readdirSync(evidenceRoot).sort().at(-1), 'result.json'), 'utf8'))
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.steps.map(step => [step.name, step.status]), [['script-syntax', 'failed']])
  assert.equal(failed.checkoutRemoved, true)
})

test('runner preserves an inconclusive Bart environment separately from product failure', context => {
  const f = fixture(context)
  for (const name of ['verify.mjs', 'verification-plan.mjs', 'verify-development.mjs', 'verification-workspace.mjs']) {
    mkdirSync(join(f.cwd, 'scripts'), { recursive: true })
    copyFileSync(join(scripts, name), join(f.cwd, 'scripts', name))
  }
  f.write('.gitignore', 'node_modules/\n')
  f.write('package.json', JSON.stringify({ packageManager: 'pnpm@10.17.1' }))
  f.write('apps/desktop/package.json', JSON.stringify({ name: 'desktop' }))
  f.write('apps/desktop/tests/bart-worker-suite.mjs', '// before\n')
  const base = f.commit()
  f.write('apps/desktop/tests/bart-worker-suite.mjs', '// after\n')
  f.commit()
  const fakePnpm = join(f.root, 'pnpm.cjs'), home = join(f.root, 'home')
  mkdirSync(home)
  for (const code of [75, 1]) {
    writeFileSync(fakePnpm, `
      const fs = require('node:fs'), args = process.argv.slice(2);
      if (args[0] === '--version') console.log('10.17.1');
      if (args[0] === 'install') {
        fs.mkdirSync('apps/desktop/node_modules/typescript', { recursive: true });
        fs.writeFileSync('apps/desktop/node_modules/typescript/package.json', '{"version":"test"}');
      }
      if (args.includes('test:bart-isolation')) process.exit(${code});
    `)
    const run = spawnSync(process.execPath, ['scripts/verify.mjs', '--base', base], {
      cwd: f.cwd, env: { ...process.env, HOME: home, npm_execpath: fakePnpm }, encoding: 'utf8'
    })
    assert.equal(run.status, code, run.stderr + run.stdout)
    const directory = join(home, 'Developer', '.openagent-verification')
    const evidence = JSON.parse(readFileSync(join(directory, readdirSync(directory).sort().at(-1), 'result.json'), 'utf8'))
    const expected = code === 75 ? 'environment-inconclusive' : 'failed'
    assert.equal(evidence.status, expected)
    assert.equal(evidence.steps.find(step => step.name === 'bart-isolation').status, expected)
    assert.equal(evidence.checkoutRemoved, true)
    assert.ok(!evidence.steps.some(step => step.name === 'tracked-diff'))
  }
})

test('runner dispatches filtered workspace checks and never turns a failed selected test green', context => {
  const f = fixture(context)
  for (const name of ['verify.mjs', 'verification-plan.mjs', 'verify-development.mjs', 'verification-workspace.mjs']) {
    mkdirSync(join(f.cwd, 'scripts'), { recursive: true })
    copyFileSync(join(scripts, name), join(f.cwd, 'scripts', name))
  }
  f.write('.gitignore', 'node_modules/\n')
  f.write('package.json', JSON.stringify({ packageManager: 'pnpm@10.17.1' }))
  f.write('apps/desktop/package.json', JSON.stringify({ name: 'desktop', scripts: { test: 'vitest run' } }))
  f.write('apps/desktop/src/renderer/view.css', 'body {}\n')
  const base = f.commit()
  f.write('apps/desktop/src/renderer/view.css', 'body { color: red; }\n')
  f.commit()
  const fakePnpm = join(f.root, 'pnpm.cjs')
  const home = join(f.root, 'home')
  mkdirSync(home)
  const env = { ...process.env, HOME: home, npm_execpath: fakePnpm }
  for (const outcome of ['pass', 'test-failure', 'empty']) {
    const fail = outcome !== 'pass'
    writeFileSync(fakePnpm, `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (args[0] === '--version') console.log('10.17.1');
      if (args[0] === 'install') {
        fs.mkdirSync('apps/desktop/node_modules/typescript', { recursive: true });
        fs.writeFileSync('apps/desktop/node_modules/typescript/package.json', '{"version":"test"}');
      }
      if (${outcome === 'test-failure'} && args.includes('vitest')) process.exit(7);
      const report = args.find(arg => arg.startsWith('--outputFile.json='));
      if (report) fs.writeFileSync(report.split('=')[1], JSON.stringify({ success: true, numTotalTests: 1, numPassedTests: ${outcome === 'empty' ? 0 : 1}, testResults: [{name:'fixture.test.ts'}] }));
    `)
    const run = spawnSync(process.execPath, ['scripts/verify.mjs', '--base', base], { cwd: f.cwd, env, encoding: 'utf8' })
    assert.equal(run.status, fail ? 1 : 0, run.stderr + run.stdout)
    const evidenceRoot = join(home, 'Developer', '.openagent-verification')
    const evidence = JSON.parse(readFileSync(join(evidenceRoot, readdirSync(evidenceRoot).sort().at(-1), 'result.json'), 'utf8'))
    assert.equal(evidence.status, fail ? 'failed' : 'passed')
    assert.equal(evidence.checkoutRemoved, true)
    const regressions = evidence.steps.find(step => step.name === 'regressions')
    assert.equal(regressions.command[2], 'regressions')
    if (!fail) assert.equal(evidence.testSelection[0].tests, 1)
    assert.equal(regressions.status, fail ? 'failed' : 'passed')
    assert.ok(!evidence.steps.some(step => ['development', 'report-runtime', 'lifecycle-runtime'].includes(step.name)))
    if (fail) assert.ok(!evidence.steps.some(step => step.name === 'build'))
  }
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
