import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ErasedHarnessMainPluginModule, HarnessPluginHostContext } from '@openagent/contracts'
import { createCliAvailabilityProbe } from '@openagent/plugin-kit/main'
import { bindMainHarnessComposition } from '../src/main/harness-composition'
import { canHostBart } from '../src/shared/harnesses'
import { loadHeadlessProviderConfiguration } from '../src/main/harness-execution-environment'
import { createDefaultOpenAgentSettings } from '../src/shared/openagent-settings'
import { harnessMainPluginModules } from '../src/generated/harness-registry.main'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

// The registered module set comes from the generated registry, so adding or
// removing a Harness package updates these shared execution guarantees
// without editing this file.
const modules: readonly ErasedHarnessMainPluginModule[] = harnessMainPluginModules

describe('Harness execution capabilities', () => {
  it('auto-detects the executable without consulting Harness settings', async () => {
    const resolveExecutable = vi.fn(async () => process.execPath)
    const availability = createCliAvailabilityProbe<{ model?: string }>(
      { resolveExecutable, environment: async () => ({}) }, spawn)

    await expect(availability.probe({
      settings: { model: 'harness-model' }, cwd: tmpdir(), signal: new AbortController().signal
    })).resolves.toEqual({ available: true })
    expect(resolveExecutable).toHaveBeenCalledWith(tmpdir())
  })

  // Opening and leaving settings both ask whether the same CLI runs, and the two
  // share one process start. A caller that leaves is not the only reader that
  // start has, and a start no caller is waiting on any more is a CLI nothing
  // will read.
  it('ends a shared availability probe once its last caller leaves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'availability-abandon-'))
    directories.push(directory)
    const executable = await probeCli(directory, 'setTimeout(() => process.exit(1), 30_000)')
    const availability = createCliAvailabilityProbe<{ model?: string }>(
      { resolveExecutable: async () => executable, environment: async () => ({}) }, spawn)
    const controller = new AbortController()
    const result = availability.probe({
      settings: { model: 'harness-model' }, cwd: tmpdir(), signal: controller.signal
    })
    await started(directory)

    const rejected = expect(result).rejects.toThrow('service stopped')
    controller.abort(new Error('service stopped'))
    await rejected
    // The CLI is already running, so ending it is a signal away. The window is
    // short on purpose: the probe's own 10s start timeout must not be what ends
    // the process a caller has walked away from.
    await vi.waitFor(async () =>
      expect(await readFile(join(directory, 'terminated'), 'utf8')).toBe('terminated'), { timeout: 4_000 })
  }, 20_000)

  it('keeps a shared availability probe for a caller that is still waiting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'availability-remaining-'))
    directories.push(directory)
    const executable = await probeCli(directory, 'setTimeout(() => process.exit(0), 300)')
    const availability = createCliAvailabilityProbe<{ model?: string }>(
      { resolveExecutable: async () => executable, environment: async () => ({}) }, spawn)
    const leaving = new AbortController()
    const result = availability.probe({
      settings: { model: 'harness-model' }, cwd: tmpdir(), signal: leaving.signal
    })
    const remaining = availability.probe({
      settings: { model: 'harness-model' }, cwd: tmpdir(), signal: new AbortController().signal
    })
    await started(directory)

    const rejected = expect(result).rejects.toThrow('service stopped')
    leaving.abort(new Error('service stopped'))
    await rejected
    // One reader leaving is not the CLI's last reader: the answer the two of them
    // started together is still owed to the other one.
    await expect(remaining).resolves.toEqual({ available: true })
  })

  it.each([
    { missing: 'instructions', capabilities: { instructions: false, threadContext: true, sendContext: true, toolModes: ['exclusive'] as const } },
    { missing: 'Thread context', capabilities: { instructions: true, threadContext: false, sendContext: true, toolModes: ['exclusive'] as const } },
    { missing: 'send context', capabilities: { instructions: true, threadContext: true, sendContext: false, toolModes: ['exclusive'] as const } },
    { missing: 'exclusive tools', capabilities: { instructions: true, threadContext: true, sendContext: true, toolModes: ['extend'] as const } }
  ])('requires $missing capability for the Core Bart role', ({ capabilities }) => {
    expect(canHostBart(capabilities)).toBe(false)
    expect(canHostBart({ instructions: true, threadContext: true, sendContext: true, toolModes: ['exclusive'] })).toBe(true)
  })

  // Per-module probe wiring (auto-detection, unavailability, cancellation)
  // belongs to each owning package under packages/harness-<id>/tests: the
  // registered Harnesses do not share one probe contract. What Core guarantees
  // here is the capability rule above and the composition binding below.
  // Composition-integration guarantee, exercised against one real registered
  // module: the binding's availability is exactly the bundle's own probe, run
  // once per call.
  it('uses ordinary availability as the only runtime probe', async () => {
    const module = modules[0]
    const bundle = module.createMainPlugin(hostContext())
    const probe = vi.fn(async () => ({ available: false, reason: 'native executable unavailable' }))
    const binding = bindMainHarnessComposition([{
      ...module,
      createMainPlugin: () => ({ ...bundle, availability: { probe } })
    }])[module.id]
    const settings = createDefaultOpenAgentSettings()
    try {
      await expect(binding.availability(settings, tmpdir(), new AbortController().signal))
        .resolves.toEqual({ available: false, reason: 'native executable unavailable' })
      expect(probe).toHaveBeenCalledOnce()
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({
        settings: { threadSettings: {} }, cwd: tmpdir(), signal: expect.any(AbortSignal)
      }))
    } finally {
      await binding.dispose()
    }
  })
})

describe('Host-owned provider configuration', () => {
  it('uses a loopback endpoint without reading dotenv or ambient credentials', async () => {
    const cwd = await workspace('ignored-file-key', 'ignored-model')
    const environment = { DEEPSEEK_API_KEY: 'ignored-environment-key' }
    await expect(loadHeadlessProviderConfiguration({ cwd, environment })).resolves.toBeUndefined()
    await expect(loadHeadlessProviderConfiguration({ cwd, environment: {
      ...environment, OPENAGENT_BART_HEADLESS_PROVIDER: 'mock', OPENAGENT_MOCK_LLM_URL: 'http://127.0.0.1:12345'
    } })).resolves.toEqual({ provider: 'mock', model: 'mock-model', apiKey: 'openagent-mock-key', baseUrl: 'http://127.0.0.1:12345' })
  })

  it.each(['https://api.deepseek.com', 'http://localhost:1234', 'http://127.0.0.1', 'http://127.0.0.1:1234/path', 'http://key@127.0.0.1:1234'])('rejects an endpoint outside the local test contract: %s', async baseUrl => {
    await expect(loadHeadlessProviderConfiguration({ cwd: '/unused', environment: {
      OPENAGENT_BART_HEADLESS_PROVIDER: 'mock', OPENAGENT_MOCK_LLM_URL: baseUrl
    } })).rejects.toThrow('loopback origin')
  })

  it('rejects remote provider mode and a missing local server', async () => {
    await expect(loadHeadlessProviderConfiguration({ cwd: '/unused', environment: { OPENAGENT_BART_HEADLESS_PROVIDER: 'deepseek' } })).rejects.toThrow('local mock provider')
    await expect(loadHeadlessProviderConfiguration({ cwd: '/unused', environment: { OPENAGENT_BART_HEADLESS_PROVIDER: 'mock' } })).rejects.toThrow()
  })
})

function hostContext(): HarnessPluginHostContext {
  return {
    resolveExecutable: async () => process.execPath,
    environment: async () => ({}),
    harnessDataRoot: tmpdir(),
    temporaryWorkspaceRoot: tmpdir()
  }
}

/**
 * A CLI whose start and termination a test can watch for. `source` runs after
 * the start is recorded, so a test can hold the process open or let it answer.
 */
async function probeCli(directory: string, source: string): Promise<string> {
  const executable = join(directory, 'cli')
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs')
// Before the start is announced: a test that waits for it and then terminates
// the CLI has to find the handler already in place.
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(join(directory, 'terminated'))}, 'terminated')
  // A CLI ended before it answers does not report success: a caller still
  // waiting on this process must see it fail, not read its silence as a pass.
  process.exit(1)
})
fs.writeFileSync(${JSON.stringify(join(directory, 'started'))}, 'started')
${source}
`, { mode: 0o755 })
  await chmod(executable, 0o755)
  return executable
}

async function started(directory: string): Promise<void> {
  // Booting a CLI is a real process start, which is slower than the default
  // window allows on a busy machine.
  await vi.waitFor(async () =>
    expect(await readFile(join(directory, 'started'), 'utf8')).toBe('started'), { timeout: 10_000 })
}

async function workspace(apiKey: string, model: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-provider-config-'))
  directories.push(directory)
  await writeFile(join(directory, '.env'), `DEEPSEEK_API_KEY=${apiKey}\nDEEPSEEK_MODEL=${model}\n`)
  return directory
}
