import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { HARNESS_IDS, HOST_HARNESS_IDS, provider } from './providers.mjs'
import { SUITES, TIERS, suiteById, suitesForTier } from './suites/index.mjs'

export const DEFAULT_TIMEOUT_MS = 180_000
export const DEFAULT_TIER = 'core'
const MAX_AUTO_WORKERS = 4

export function parseArguments(values) {
  const parsed = {
    harnesses: [],
    hosts: [],
    selectors: [],
    suites: [],
    config: undefined,
    provider: 'mock',
    artifactsDir: undefined,
    workers: 'auto',
    timeoutMs: Number(process.env.OPENAGENT_ACCEPTANCE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    keep: false,
    list: false,
    help: false
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--') continue
    if (value === '--harness') parsed.harnesses.push(requiredArgument(values, ++index, value))
    else if (value === '--host') parsed.hosts.push(requiredArgument(values, ++index, value))
    else if (value === '--suite') parsed.suites.push(requiredArgument(values, ++index, value))
    else if (value === '--case') parsed.selectors.push(requiredArgument(values, ++index, value))
    else if (value === '--config') parsed.config = requiredArgument(values, ++index, value)
    else if (value === '--provider') parsed.provider = requiredArgument(values, ++index, value)
    else if (value === '--artifacts-dir') parsed.artifactsDir = requiredArgument(values, ++index, value)
    else if (value === '--workers') parsed.workers = requiredArgument(values, ++index, value)
    else if (value === '--timeout-ms') {
      parsed.timeoutMs = Number(requiredArgument(values, ++index, value))
    } else if (value === '--keep') parsed.keep = true
    else if (value === '--list') parsed.list = true
    else if (value === '--help' || value === '-h') parsed.help = true
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (parsed.provider !== 'mock') throw new Error('--provider must be mock; native acceptance never calls a remote LLM')
  if (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs < 10_000) {
    throw new Error('--timeout-ms must be an integer >= 10000')
  }
  if (parsed.workers !== 'auto') {
    const workers = Number(parsed.workers)
    if (!Number.isInteger(workers) || workers < 1 || workers > 16) {
      throw new Error('--workers must be "auto" or an integer between 1 and 16')
    }
    parsed.workers = workers
  }
  return parsed
}

/** Mock runs cover the registered matrix without machine-local narrowing. */
export async function loadRunConfig(desktopRoot, cli, environment = process.env) {
  const selectedProvider = cli.provider ?? environment.OPENAGENT_BART_HEADLESS_PROVIDER
  const config = selectedProvider && !cli.config ? {} : await loadConfig(desktopRoot, cli.config)
  if (selectedProvider && !config.hosts) config.hosts = [...HOST_HARNESS_IDS]
  if (selectedProvider) config.providers = Object.fromEntries(HARNESS_IDS.map(id => [id,
    config.providers?.[id] ?? { useDefaultThreadSettings: false, threadSettings: structuredClone(provider(id).options) }
  ]))
  return config
}

export async function loadConfig(desktopRoot, path) {
  const resolved = path
    ? resolve(process.cwd(), path)
    : join(desktopRoot, 'tests/bart-headless.local.json')
  if (!existsSync(resolved)) {
    if (path !== undefined) {
      throw new Error(`Acceptance --config file does not exist: ${resolved}`)
    }
    return {}
  }
  const parsed = JSON.parse(await readFile(resolved, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('acceptance config must be an object')
  }
  return parsed
}

/**
 * Expands the selected suites, cases, and Harnesses into the concrete scenario
 * list. A case is skipped for one Harness only when that Harness genuinely
 * lacks the native capability the case is about; every other omission is an
 * error, never a silent pass.
 */
export function planScenarios(cli, config) {
  const harnesses = selectHarnesses(cli, config)
  const hosts = selectHosts(cli, config)
  const suites = selectSuites(cli, config)
  const selectors = normalizeSelectors([...cli.selectors, ...arrayFrom(config.cases)])
  const scenarios = []
  const unmatched = new Set(selectors.map(selector => selector.raw))

  for (const suite of suites) {
    for (const testCase of suite.cases) {
      const selector = matchSelector(selectors, suite, testCase)
      if (selectors.length && !selector) continue
      if (selector) unmatched.delete(selector.raw)
      const eligible = harnesses.filter(harness => supportsCase(harness, testCase))
      if (!eligible.length) continue
      const targets = ['once', 'host'].includes(testCase.scope) ? [eligible[0]] : eligible
      for (const host of hosts) {
        if (host !== 'auto' && testCase.hosts && !testCase.hosts.includes(host)) continue
        for (const harness of targets) {
          scenarios.push({
            suiteId: suite.id,
            caseId: testCase.id,
            tier: suite.tier,
            harness,
            host,
            scope: testCase.scope || 'harness',
            description: testCase.description,
            label: `host:${host}/target:${testCase.scope === 'host' ? 'none' : harness}/${suite.id}:${testCase.id}`,
            run: testCase.run
          })
        }
      }
    }
  }
  if (unmatched.size) {
    throw new Error(`No acceptance case matched: ${[...unmatched].join(', ')}`)
  }
  return scenarios
}

/**
 * Each worker owns one headless process and one Bart conversation, so a
 * scenario list must stay serial inside a worker. Interleaving Harnesses across
 * workers keeps a slow provider from serialising the whole run.
 */
export function shardScenarios(scenarios, workerCount) {
  const hosts = [...new Set(scenarios.map(scenario => scenario.host))]
  if (hosts.length > 1) {
    return hosts.flatMap(host => shardScenarios(
      scenarios.filter(scenario => scenario.host === host), workerCount
    ))
  }
  const byHarness = new Map()
  for (const scenario of scenarios) {
    const bucket = byHarness.get(scenario.harness) || []
    bucket.push(scenario)
    byHarness.set(scenario.harness, bucket)
  }
  const interleaved = []
  const buckets = [...byHarness.values()]
  const deepest = Math.max(0, ...buckets.map(bucket => bucket.length))
  for (let index = 0; index < deepest; index += 1) {
    for (const bucket of buckets) {
      if (index < bucket.length) interleaved.push(bucket[index])
    }
  }
  const shards = Array.from({ length: workerCount }, () => [])
  interleaved.forEach((scenario, index) => shards[index % workerCount].push(scenario))
  return shards.filter(shard => shard.length > 0)
}

function selectHosts(cli, config) {
  const requested = cli.hosts?.length ? cli.hosts : arrayFrom(config.hosts)
  const hosts = requested.length ? requested : ['auto']
  for (const host of hosts) if (host !== 'auto') provider(host)
  return [...new Set(hosts)]
}

export function resolveWorkerCount(cli, scenarioCount) {
  if (scenarioCount === 0) return 0
  if (cli.workers !== 'auto') return Math.min(cli.workers, scenarioCount)
  return Math.max(1, Math.min(MAX_AUTO_WORKERS, scenarioCount))
}

function selectHarnesses(cli, config) {
  const requested = cli.harnesses.length ? cli.harnesses : arrayFrom(config.harnesses)
  const harnesses = requested.length ? requested : [...HARNESS_IDS]
  for (const harness of harnesses) provider(harness)
  return [...new Set(harnesses)]
}

function selectSuites(cli, config) {
  const requested = cli.suites.length ? cli.suites : arrayFrom(config.suites)
  // An explicit case is already a narrower selection than the default tier.
  // Search the complete catalogue unless the caller also constrained suites;
  // otherwise `--case workspace:git-worktree` can never match because the
  // workspace suite is not part of the default core tier.
  if (!requested.length) {
    const selectors = [...cli.selectors, ...arrayFrom(config.cases)]
    return selectors.length ? [...SUITES] : suitesForTier(DEFAULT_TIER)
  }
  const selected = []
  for (const name of requested) {
    if (name === 'all') {
      selected.push(...SUITES)
      continue
    }
    if (TIERS.includes(name)) {
      selected.push(...suitesForTier(name))
      continue
    }
    const suite = suiteById(name)
    if (!suite) throw new Error(`Unknown suite: ${name}`)
    selected.push(suite)
  }
  return SUITES.filter(suite => selected.includes(suite))
}

function normalizeSelectors(values) {
  return values.filter(Boolean).map(raw => {
    const [head, tail] = String(raw).split(':')
    return tail === undefined
      ? { raw, suiteId: undefined, caseId: head }
      : { raw, suiteId: head, caseId: tail }
  })
}

function matchSelector(selectors, suite, testCase) {
  return selectors.find(selector => {
    if (selector.suiteId !== undefined) {
      return selector.suiteId === suite.id && selector.caseId === testCase.id
    }
    return selector.caseId === suite.id || selector.caseId === testCase.id
  })
}

function supportsCase(harness, testCase) {
  if (Array.isArray(testCase.harnesses) && !testCase.harnesses.includes(harness)) {
    return false
  }
  const required = testCase.requires || []
  return required.every(capability => provider(harness).capabilities.includes(capability))
}

function arrayFrom(value) {
  return Array.isArray(value) ? value.map(String) : []
}

function requiredArgument(values, index, flag) {
  const value = values[index]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}
