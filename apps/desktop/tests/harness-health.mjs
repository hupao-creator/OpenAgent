#!/usr/bin/env node
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main as injection } from './harness-injection-native.mjs'
import { main as bart } from './bart-headless/runner.mjs'
import { parseArguments } from './bart-headless/plan.mjs'
import { HOST_HARNESS_IDS, HARNESS_IDS } from './bart-headless/providers.mjs'

/** All registered hosts and targets, in a credential-isolated local Mock LLM run. */
export async function main(argv) {
  const cli = parseArguments(argv)
  if (cli.help) {
    console.log('Usage: pnpm test:harness-health -- [--suite all|core|...] [--list] [--workers 1-16] [--timeout-ms ms] [--artifacts-dir path]')
    console.log('Uses local Mock LLM only; no API key or remote model is used. Default: ordinary injection/resume on every host, Bart host tools and start/follow-up/interrupt across all host-target pairs. Evidence is always retained. No native login or local acceptance config is reused.')
    return 0
  }
  if (cli.config || cli.harnesses.length || cli.hosts.length || cli.selectors.length) {
    throw new Error('Health covers every registered Harness; use the individual acceptance entry points to narrow hosts, targets or cases.')
  }
  const parent = cli.artifactsDir ? resolve(cli.artifactsDir) : join(homedir(), 'Developer', 'OpenAgentValidation')
  let root
  if (!cli.list) {
    await mkdir(parent, { recursive: true })
    root = await mkdtemp(join(parent, 'openagent-harness-health-'))
    console.log(`Harness health artifacts: ${root}`)
  }
  const shared = ['--provider', 'mock', '--timeout-ms', String(cli.timeoutMs),
    ...(cli.list ? ['--list'] : ['--keep', '--artifacts-dir', root])]
  const bartArgs = [...shared, '--workers', String(cli.workers),
    ...(cli.suites.length ? cli.suites.flatMap(suite => ['--suite', suite]) :
      ['host', 'lifecycle:start-complete', 'lifecycle:follow-up', 'lifecycle:interrupt'].flatMap(testCase => ['--case', testCase]))]
  const report = { startedAt: new Date().toISOString(), hosts: [...HOST_HARNESS_IDS], targets: [...HARNESS_IDS], stages: [] }
  if (root) await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  const controller = new AbortController()
  const interrupt = () => controller.abort(new Error('Harness health interrupted by SIGINT'))
  const terminate = () => controller.abort(new Error('Harness health interrupted by SIGTERM'))
  const stopObserving = () => {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    for (const [name, run, args] of [['ordinary', injection, shared], ['bart', bart, bartArgs]]) {
      // Ordinary handles signals and returns a failure code after cleanup. Keep
      // its cancellation distinct from a test failure so Bart cannot restart work.
      // Bart uses default signal termination; this observer must not swallow it.
      if (name === 'bart') stopObserving()
      if (controller.signal.aborted) {
        report.stages.push({ name, status: 'not-run', error: controller.signal.reason.message })
      } else {
        try {
          const code = name === 'ordinary' ? await run(args, { signal: controller.signal }) : await run(args)
          report.stages.push({ name, status: code ? 'failed' : 'passed', exitCode: code })
        } catch (error) {
          report.stages.push({ name, status: 'failed', error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (root) await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2) + '\n')
    }
  } finally { stopObserving() }
  report.completedAt = new Date().toISOString()
  report.aborted = controller.signal.aborted
  report.status = report.aborted ? 'aborted' : report.stages.every(stage => stage.status === 'passed') ? 'passed' : 'failed'
  if (root) await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  return report.status === 'passed' ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2)).catch(error => { console.error(error.message); return 1 })
}
