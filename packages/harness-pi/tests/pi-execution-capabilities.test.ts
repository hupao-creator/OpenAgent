import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutableNotFoundError } from '@openagent/contracts'
import { piMainModule } from '../src/main/entry.js'

// Pi's availability probe is not a generic CLI start check: it runs the real
// version handshake and then applies the configuration in a real RPC session.
// These guarantees therefore drive real probe processes — the RPC double under
// tests/fixtures stands in for the detected executable, never for the probe.
const rpcFixture = fileURLToPath(new URL('./fixtures/fake-pi-rpc.mjs', import.meta.url))

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function workspace(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `openagent-pi-capability-${label}-`)).then(directory => {
    directories.push(directory)
    return directory
  })
}

describe('Pi execution capabilities', () => {
  // The host always auto-detects the executable: the probe asks the resolver
  // which binary to run and never reads a configured path from settings, which
  // Pi rejects outright.
  it('auto-detects the executable without consulting Harness settings', async () => {
    const cwd = await workspace('auto-detect')
    const resolveExecutable = vi.fn(async () => rpcFixture)
    const plugin = piMainModule.createMainPlugin({
      resolveExecutable, environment: async () => ({ ...process.env }),
      harnessDataRoot: cwd, temporaryWorkspaceRoot: cwd
    })
    // The detected executable must actually apply a configuration: the probe
    // boots the native session and answers from what Pi reports, not from the
    // mere existence of a file on disk.
    await expect(plugin.availability.probe({
      settings: { threadSettings: {} }, cwd, signal: new AbortController().signal
    })).resolves.toEqual({ available: true })
    expect(resolveExecutable).toHaveBeenCalledWith('pi', cwd, undefined)
    // A configured path can never ride into the probe through settings: the
    // payload shape leaves no field for one.
    expect(() => plugin.settings.normalizeHarnessSettings({ threadSettings: { executablePath: '/pinned/pi' } } as never))
      .toThrow('unknown field')
    // Installation detection asks the same resolver, again without a
    // configured path, and types the missing result for callers.
    await expect(plugin.detectInstallation({ cwd, signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'installed', executablePath: rpcFixture })
    expect(resolveExecutable).toHaveBeenLastCalledWith('pi', cwd)
    vi.mocked(resolveExecutable).mockRejectedValueOnce(new HarnessExecutableNotFoundError('pi'))
    await expect(plugin.detectInstallation({ cwd, signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'missing' })
  }, 15_000)

  // The version gate is all that stands between an unsupported CLI and a
  // native session, so an incompatible version surfaces as an explicit
  // unavailability carrying the upgrade reason.
  it('reports an unsupported CLI version as unavailable with the version reason', async () => {
    const cwd = await workspace('unsupported-version')
    const executable = join(cwd, 'pi-unsupported')
    await writeFile(executable, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 })
    const plugin = piMainModule.createMainPlugin({
      resolveExecutable: async () => executable, environment: async () => ({ ...process.env }),
      harnessDataRoot: cwd, temporaryWorkspaceRoot: cwd
    })
    const result = await plugin.availability.probe({
      settings: { threadSettings: {} }, cwd, signal: new AbortController().signal
    })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('Unsupported Pi CLI version')
    expect(result.reason).toContain('install Pi 0.83.x')
  }, 15_000)
})
