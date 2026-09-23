import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BartDriver } from './bart.mjs'
import { HeadlessClient, startHeadless } from './headless.mjs'
import { assertProviderModel, configureHost, hostEvidence, nativeModels } from './host.mjs'
import {
  DEFAULT_TIER,
  DEFAULT_TIMEOUT_MS,
  loadRunConfig,
  parseArguments,
  planScenarios,
  resolveWorkerCount,
  shardScenarios
} from './plan.mjs'
import { HARNESS_IDS } from './providers.mjs'
import { ScenarioContext } from './scenario.mjs'
import { SUITES, TIERS } from './suites/index.mjs'
import { errorMessage, errorSummary } from './support.mjs'
import { createAcceptanceLlm } from '../mock-llm/server.mjs'
import { installBartScript } from '../mock-llm/bart.mjs'
import { installStreamingScript } from '../mock-llm/streaming.mjs'
import { installMetadataScript } from '../mock-llm/metadata.mjs'
import { installTargetScript } from '../mock-llm/target.mjs'
import { nativeAdapter } from './providers.mjs'
import { isolatedNativeEnvironment } from './native-environment.mjs'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const repositoryRoot = resolve(desktopRoot, '../..')
const electronMain = join(desktopRoot, 'out/main/index.js')

export async function main(argv) {
  const cli = parseArguments(argv)
  if (cli.help) {
    printHelp()
    return 0
  }
  const config = await loadRunConfig(desktopRoot, cli)
  const scenarios = planScenarios(cli, config)
  if (!scenarios.length) throw new Error('No Bart headless acceptance scenarios selected')
  const workerCount = resolveWorkerCount(cli, scenarios.length)
  const shards = shardScenarios(scenarios, workerCount)

  if (cli.list) {
    printPlan(shards, workerCount)
    return 0
  }
  if (process.platform === 'win32') {
    throw new Error('Bart headless native acceptance currently requires a POSIX shell')
  }
  if (!existsSync(electronMain)) {
    throw new Error(`Missing ${electronMain}; run pnpm --dir apps/desktop build first`)
  }

  const artifactsDir = cli.artifactsDir ? resolve(cli.artifactsDir)
    : join(homedir(), 'Developer', 'OpenAgentValidation')
  await mkdir(artifactsDir, { recursive: true })
  const runRoot = await mkdtemp(join(artifactsDir, 'openagent-bart-acceptance-'))
  const startedAt = new Date().toISOString()
  const git = await candidateIdentity()
  const proofRoot = join(runRoot, 'proofs')
  await mkdir(proofRoot, { recursive: true })
  process.stdout.write(
    `Bart headless acceptance: ${scenarios.length} scenarios, up to ${workerCount} concurrent worker(s)\n`
  )
  process.stdout.write(`Run artifacts: ${runRoot}\n\n`)

  const results = []
  // A shard never mixes hosts. Respect --workers even when three hosts create
  // more isolated processes than can run concurrently.
  for (let offset = 0; offset < shards.length; offset += workerCount) {
    const batch = await Promise.all(shards.slice(offset, offset + workerCount)
      .map((shard, index) => runWorker({
        index: offset + index,
        scenarios: shard,
        cli,
        config,
        runRoot,
        proofRoot
      })))
    results.push(...batch.flat())
  }

  results.sort((left, right) => left.label.localeCompare(right.label))
  const failed = results.filter(result => result.status === 'failed')
  await writeFile(join(runRoot, 'results.json'), JSON.stringify({
    startedAt,
    completedAt: new Date().toISOString(),
    scenarioCount: scenarios.length,
    command: ['node', 'tests/bart-headless-acceptance.mjs', ...argv],
    git,
    config,
    provider: { id: 'mock', model: 'mock-model', authentication: 'none', network: 'loopback' },
    requestedHosts: [...new Set(scenarios.map(scenario => scenario.host))],
    targetHarnesses: [...new Set(scenarios.filter(scenario => scenario.scope !== 'host')
      .map(scenario => scenario.harness))],
    workerCount,
    isolatedProcessCount: shards.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results
  }, null, 2) + '\n')
  process.stdout.write('\nBart headless acceptance summary\n')
  for (const result of results) {
    process.stdout.write(
      `${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.label} ` +
      `${result.durationMs}ms${result.error ? ` — ${result.error}` : ''}\n`
    )
  }
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} passed\n`
  )

  if (!failed.length && !cli.keep) {
    await rm(runRoot, { recursive: true, force: true })
  } else {
    process.stdout.write(`Artifacts preserved at ${runRoot}\n`)
  }
  return failed.length ? 1 : 0
}

/**
 * One worker owns exactly one headless process and therefore exactly one Bart
 * conversation. Scenarios inside a worker stay serial; parallelism is only ever
 * added by adding workers.
 */
async function runWorker(input) {
  const name = `w${input.index}`
  const workerRoot = join(input.runRoot, name)
  await mkdir(workerRoot, { recursive: true })
  const processLog = join(workerRoot, 'headless.log')
  const openAgentHome = join(workerRoot, 'openagent-home')
  const results = []
  let headless
  let client
  let host
  let llm

  try {
    llm = await createAcceptanceLlm({ artifactPath: join(workerRoot, 'llm-requests.json') })
    installTargetScript(llm, HARNESS_IDS.map(nativeAdapter))
    installBartScript(llm)
    installMetadataScript(llm, HARNESS_IDS.map(nativeAdapter))
    installStreamingScript(llm)
    const environment = {
      ...await isolatedNativeEnvironment(join(workerRoot, 'native-profile'), process.env),
      OPENAGENT_BART_HEADLESS_PROVIDER: 'mock',
      OPENAGENT_MOCK_LLM_URL: llm.url
    }
    headless = await startHeadless({
      electronMain,
      desktopRoot,
      repositoryRoot,
      userData: join(workerRoot, 'user-data'),
      openAgentHome,
      environment,
      processLog
    })
    client = new HeadlessClient({ port: headless.port, timeoutMs: input.cli.timeoutMs })
    client.start()
    host = await configureHost(client, input.scenarios[0].host, input.config)
    process.stdout.write(
      `[ ${name} UP    ] http://127.0.0.1:${headless.port} — ${input.scenarios.length} scenarios\n`
    )
    const bart = new BartDriver(client)

    for (const scenario of input.scenarios) {
      const startedAt = Date.now()
      const llmStart = llm.requestCount
      const hostInteractionStart = bart.hostInteractions.length
      process.stdout.write(`[ ${name} RUN   ] ${scenario.label}\n`)
      const context = new ScenarioContext({
        client,
        bart,
        harness: scenario.harness,
        host,
        config: input.config,
        suiteId: scenario.suiteId,
        caseId: scenario.caseId,
        label: scenario.label,
        runRoot: input.runRoot,
        proofRoot: input.proofRoot,
        repositoryRoot,
        openAgentHome,
        token: createToken(scenario, input.index, results.length)
      })
      try {
        const facts = await scenario.run(context)
        llm.assertHealthy(llmStart)
        const state = await client.loadState()
        for (const thread of state.threads.filter(thread => context.threads.has(thread.id))) {
          assertProviderModel(thread, llm.providerOverride)
        }
        const actualHost = hostEvidence(state, scenario.host)
        assertProviderModel(state.threads.find(thread => thread.id === actualHost.threadId), llm.providerOverride)
        const evidencePath = join(workerRoot, `${context.token}.state.json`)
        await writeFile(evidencePath, JSON.stringify(state, null, 2) + '\n')
        results.push({
          label: scenario.label,
          worker: name,
          status: 'passed',
          durationMs: Date.now() - startedAt,
          host: hostEvidence(state, scenario.host, bart.hostInteractions.slice(hostInteractionStart)),
          targetHarnessId: scenario.scope === 'host' ? null : scenario.harness,
          targets: state.threads.filter(thread => context.threads.has(thread.id)).map(thread => ({
            threadId: thread.id,
            harnessId: thread.harnessId,
            effectiveSettings: thread.settings,
            nativeModels: nativeModels(thread)
          })),
          stateEvidence: evidencePath,
          facts
        })
        process.stdout.write(
          `[ ${name}    OK ] ${scenario.label} (${Date.now() - startedAt} ms)\n`
        )
      } catch (error) {
        results.push({
          label: scenario.label,
          worker: name,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          host: {
            requestedHarnessId: scenario.host,
            harnessId: host?.actualHost ?? null,
            interactions: structuredClone(bart.hostInteractions.slice(hostInteractionStart))
          },
          targetHarnessId: scenario.scope === 'host' ? null : scenario.harness,
          error: errorSummary(error),
          detail: errorMessage(error)
        })
        await client.loadState().then(state => writeFile(
          join(workerRoot, `${context.token}.failed-state.json`),
          JSON.stringify(state, null, 2) + '\n'
        )).catch(() => undefined)
        process.stderr.write(
          `[ ${name} FAIL  ] ${scenario.label}: ${errorMessage(error)}\n`
        )
      } finally {
        await context.cleanup()
      }
    }
  } catch (error) {
    const remaining = input.scenarios.filter(scenario =>
      !results.some(result => result.label === scenario.label))
    for (const scenario of remaining) {
      results.push({
        label: scenario.label,
        worker: name,
        status: 'failed',
        durationMs: 0,
        host: { requestedHarnessId: scenario.host, harnessId: host?.actualHost ?? null },
        targetHarnessId: scenario.scope === 'host' ? null : scenario.harness,
        error: `${name} could not run: ${errorSummary(error)}`,
        detail: errorMessage(error)
      })
    }
    process.stderr.write(`[ ${name} DOWN  ] ${errorMessage(error)}\n`)
  } finally {
    const cleanupErrors = []
    for (const cleanup of [() => client?.stop(), () => headless?.close(), () => llm?.close()]) {
      try { await cleanup() } catch (error) { cleanupErrors.push(errorSummary(error)) }
    }
    for (const result of results) {
      result.resourceRelease = cleanupErrors.length ? 'failed' : 'worker-process-tree-terminated'
      if (cleanupErrors.length) {
        result.status = 'failed'
        result.error = [result.error, ...cleanupErrors].filter(Boolean).join('; ')
      }
    }
  }

  return results
}

function createToken(scenario, workerIndex, sequence) {
  const slug = value => value.replace(/[^a-z0-9]+/gi, '_').toUpperCase()
  return [
    slug(scenario.harness),
    slug(scenario.suiteId),
    slug(scenario.caseId),
    `W${workerIndex}S${sequence}`,
    Date.now()
  ].join('_')
}

function printPlan(shards, workerCount) {
  const total = shards.reduce((sum, shard) => sum + shard.length, 0)
  process.stdout.write(`${total} scenarios across ${shards.length} isolated process(es); ` +
    `at most ${workerCount} concurrent worker(s)\n`)
  shards.forEach((shard, index) => {
    process.stdout.write(`\nworker ${index} (${shard.length})\n`)
    for (const scenario of shard) {
      process.stdout.write(`  ${scenario.label} — ${scenario.description}\n`)
    }
  })
}

function printHelp() {
  const catalogue = SUITES.map(suite => {
    const cases = suite.cases
      .map(testCase => `      ${suite.id}:${testCase.id} — ${testCase.description}`)
      .join('\n')
    return `  ${suite.id} [${suite.tier}] — ${suite.description}\n${cases}`
  }).join('\n')

  console.log(`Usage: node tests/bart-headless-acceptance.mjs [options]

Runs real Bart -> Harness -> native interaction -> GUI response acceptance
cases. No fake Harness or transport is used. Delegated targets and the Bart
host use the public GUI response command for pending interactions.
Each worker owns one isolated headless process.

Options:
  --suite <id|tier|all>                   Repeat to select suites (default: ${DEFAULT_TIER})
  --case <case|suite:case>                Repeat to select individual cases
  --harness <${HARNESS_IDS.join('|')}>  Repeat to select Harnesses
  --host <auto|${HARNESS_IDS.join('|')}>  Repeat to select Bart hosts independently
  --workers <auto|1-16>                   Parallel headless workers (default: auto)
  --config <path>                         Generic Harness profiles JSON
  --provider mock                         Local scripted LLM (default); no real key or login
  --artifacts-dir <path>                  Parent directory for isolated run artifacts
  --timeout-ms <milliseconds>             Per wait timeout (default: ${DEFAULT_TIMEOUT_MS})
  --keep                                  Preserve artifacts even when all cases pass
  --list                                  Print the planned matrix and exit
  --help                                  Show this help

Tiers: ${TIERS.join(', ')}

Suites and cases:
${catalogue}

Environment:
  No provider credentials are needed. All LLM requests use a worker-local HTTP server.
  OPENAGENT_ACCEPTANCE_TIMEOUT_MS         Override the wait timeout
`)
}

async function candidateIdentity() {
  const run = promisify(execFile)
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
    run('git', ['status', '--porcelain'], { cwd: repositoryRoot })
  ])
  return { head: head.trim(), dirty: Boolean(status.trim()) }
}
