import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  loadConfig,
  loadRunConfig,
  parseArguments,
  planScenarios,
  resolveWorkerCount,
  shardScenarios
} from './bart-headless/plan.mjs'
import { HARNESS_IDS, HOST_HARNESS_IDS, nativeAdapter } from './bart-headless/providers.mjs'

describe('Bart headless acceptance planning', () => {
  it('covers all registered hosts and targets in provider mode despite local filters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'headless-full-matrix-'))
    try {
      await mkdir(join(root, 'tests'))
      await writeFile(join(root, 'tests/bart-headless.local.json'), JSON.stringify({
        harnesses: ['codex'], cases: ['permission'], hosts: ['codex']
      }))
      const cli = parseArguments(['--provider', 'mock', '--case', 'lifecycle:start-complete'])
      const config = await loadRunConfig(root, cli, {})
      const scenarios = planScenarios(cli, config)
      expect(scenarios).toHaveLength(HARNESS_IDS.length * HOST_HARNESS_IDS.length)
      expect(new Set(scenarios.map(s => s.harness))).toEqual(new Set(HARNESS_IDS))
      expect(new Set(scenarios.map(s => s.host))).toEqual(new Set(HOST_HARNESS_IDS))
      for (const id of HARNESS_IDS) expect(config.providers[id].threadSettings).toEqual(nativeAdapter(id).observationThreadSettings)
      expect(() => parseArguments(['--provider', 'unknown'])).toThrow('--provider')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects a missing explicit config while allowing an absent optional local config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-acceptance-config-'))
    try {
      const missing = join(root, 'misspelled-profiles.json')
      await expect(loadConfig(root, relative(process.cwd(), missing))).rejects.toThrow(
        `Acceptance --config file does not exist: ${missing}`
      )
      await expect(loadConfig(root)).resolves.toEqual({})
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the default run on the core tier', () => {
    const scenarios = planScenarios(parseArguments([]), {})

    expect(scenarios).not.toHaveLength(0)
    expect(new Set(scenarios.map(scenario => scenario.tier))).toEqual(new Set(['core']))
  })

  it('finds an explicitly selected case outside the default tier', () => {
    const cli = parseArguments([
      '--harness', 'codex',
      '--case', 'workspace:git-worktree'
    ])

    expect(planScenarios(cli, {}).map(scenario => scenario.label)).toEqual([
      'host:auto/target:codex/workspace:git-worktree'
    ])
  })

  it('filters cases by native Harness capability', () => {
    const cli = parseArguments([
      '--suite', 'question',
      '--case', 'cancel'
    ])

    expect(planScenarios(cli, {}).map(scenario => scenario.harness)).toEqual([
      'claude'
    ])
  })

  it.each(['kimi', 'cursor', 'minimax', 'zcode'])('rejects archived Harness %s', harness => {
    expect(() => planScenarios(parseArguments(['--harness', harness]), {})).toThrow()
  })

  it('honors a case that audits one Harness implementation only', () => {
    const cli = parseArguments(['--case', 'terminal-history'])

    expect(planScenarios(cli, {}).map(scenario => scenario.label)).toEqual([
      'host:auto/target:codex/terminal-history:multi-thread-injection'
    ])
  })

  it('runs Bart-level cases once and shards every scenario exactly once', () => {
    const cli = parseArguments(['--suite', 'reports', '--workers', '4'])
    const scenarios = planScenarios(cli, {})
    const workerCount = resolveWorkerCount(cli, scenarios.length)
    const shards = shardScenarios(scenarios, workerCount)

    expect(scenarios).toHaveLength(2)
    expect(shards.flat()).toEqual(scenarios)
    expect(new Set(shards.flat().map(scenario => scenario.label)).size).toBe(scenarios.length)
  })

  it('separates host selection from target selection and keeps each process on one host', () => {
    const cli = parseArguments([
      '--host', 'codex', '--host', 'claude', '--host', 'pi',
      '--harness', 'pi', '--case', 'lifecycle:start-complete', '--workers', '1'
    ])
    const scenarios = planScenarios(cli, {})
    expect(scenarios.map(scenario => [scenario.host, scenario.harness])).toEqual([
      ['codex', 'pi'], ['claude', 'pi'], ['pi', 'pi']
    ])
    const shards = shardScenarios(scenarios, 1)
    expect(shards).toHaveLength(3)
    for (const shard of shards) expect(new Set(shard.map(scenario => scenario.host)).size).toBe(1)
  })

  it('counts host-only proofs once per host instead of once per task target', () => {
    const scenarios = planScenarios(parseArguments([
      '--host', 'codex', '--host', 'claude', '--host', 'pi', '--suite', 'host'
    ]), {})
    expect(scenarios).toHaveLength(6)
    expect(scenarios.every(scenario => scenario.scope === 'host')).toBe(true)
    expect(scenarios.every(scenario => scenario.label.includes('/target:none/'))).toBe(true)
  })

  it('honors explicit host CLI selection over configured hosts', () => {
    const scenarios = planScenarios(parseArguments([
      '--host', 'claude', '--suite', 'host'
    ]), { hosts: ['codex'] })
    expect(new Set(scenarios.map(scenario => scenario.host))).toEqual(new Set(['claude']))
  })
})
