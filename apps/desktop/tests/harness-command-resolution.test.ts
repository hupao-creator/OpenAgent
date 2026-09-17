import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessPluginHostContext } from '@openagent/contracts'
import { CliResolver } from '../src/main/services/cli-resolver'
import { createMainHarnessComposition } from '../src/main/harness-composition'

const capture = vi.hoisted(() => ({ context: undefined as HarnessPluginHostContext | undefined }))
vi.mock('../src/generated/harness-registry.main', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/generated/harness-registry.main')>()
  return {
    harnessMainPluginModules: actual.harnessMainPluginModules.map(module => ({
      ...module,
      createMainPlugin(context: HarnessPluginHostContext) {
        if (module.id === 'codex') capture.context = context
        return module.createMainPlugin(context)
      }
    }))
  }
})

describe('Host command resolution capability', () => {
  it('accepts a command unrelated to the owning Harness ID and forwards its workspace', async () => {
    const resolver = new CliResolver()
    const resolve = vi.spyOn(resolver, 'resolve').mockResolvedValue('/workspace/bin/agent-tool')
    const composition = createMainHarnessComposition({
      resolver, harnessDataRoot: tmpdir(), temporaryWorkspaceRoot: tmpdir(),
      authorizeManagedWorkspaceWrite: () => { throw new Error('not used') }
    })
    try {
      await expect(capture.context!.resolveExecutable('agent-tool', '/workspace', './bin/agent-tool'))
        .resolves.toBe('/workspace/bin/agent-tool')
      expect(resolve).toHaveBeenCalledWith('agent-tool', './bin/agent-tool', '/workspace')
    } finally {
      await Promise.all(Object.values(composition).map(binding => binding.dispose()))
      vi.restoreAllMocks()
    }
  })
})
