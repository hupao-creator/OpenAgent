/** Read-only workspace checks after the verifier has built packages and registry. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const [mode, checkout, input, evidence, pnpmJson] = process.argv.slice(2)
const { plan } = JSON.parse(readFileSync(input, 'utf8'))
const [program, prefix] = JSON.parse(pnpmJson)
const results = []
function run(args) {
  const child = spawnSync(program, [...prefix, ...args], { cwd: checkout, stdio: 'inherit' })
  if (child.error || child.status !== 0) throw new Error(`Workspace check failed (${child.error?.message || child.status}): ${args.join(' ')}`)
}
try {
  for (const workspace of plan.workspaces.filter(item => plan.targets.includes(item.name))) {
    const root = join(checkout, workspace.path)
    if (mode === 'typecheck') {
      const configs = workspace.path === 'apps/desktop'
        ? ['tsconfig.node.json', 'tsconfig.web.json', 'tsconfig.tests.json',
          ...(existsSync(join(root, 'playgrounds')) ? readdirSync(join(root, 'playgrounds')) : []).filter(name => existsSync(join(root, 'playgrounds', name, 'tsconfig.json')))
            .map(name => `playgrounds/${name}/tsconfig.json`)]
        : ['tsconfig.json']
      for (const config of configs) run(['--dir', workspace.path, 'exec', 'tsc', '--noEmit', '-p', config])
      continue
    }
    if (!workspace.hasTests) continue
    const job = plan.testJobs.find(item => item.workspace === workspace.name)
    const report = join(evidence, `tests-${results.length}.json`)
    const args = ['--dir', workspace.path, 'exec', 'vitest', 'run',
      ...job.inputs.map(path => resolve(checkout, path)), '--run', '--maxWorkers=4', '--testTimeout=15000',
      '--reporter=default', '--reporter=json', `--outputFile.json=${report}`]
    results.push({ ...job, report, status: 'running' })
    run(args)
    const data = JSON.parse(readFileSync(report, 'utf8'))
    if (!data.success || !(data.numPassedTests > 0)) throw new Error(`No passing regression coverage for ${workspace.name}; run --full and review the coverage gap`)
    Object.assign(results.at(-1), { status: 'passed', tests: data.numTotalTests, files: data.testResults.map(item => item.name) })
  }
} catch (error) {
  if (mode === 'regressions' && results.length) Object.assign(results.at(-1), { status: 'failed', error: error.message })
  throw error
} finally {
  if (mode === 'regressions') writeFileSync(join(evidence, 'test-selection.json'), JSON.stringify(results, null, 2) + '\n')
}
