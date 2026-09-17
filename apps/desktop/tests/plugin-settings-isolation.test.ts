import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { harnessMainPluginModules } from '../src/generated/harness-registry.main'
import { createMainHarnessComposition } from '../src/main/harness-composition'
import { CliResolver } from '../src/main/services/cli-resolver'
import { HARNESS_IDS, harnessDescriptors, type HarnessId } from '../src/shared/harnesses'
import {
  assertOpenAgentSettingsShell,
  createDefaultOpenAgentSettings,
  type HarnessSettingsMap,
  type OpenAgentSettings
} from '../src/shared/openagent-settings'

describe('Plugin settings isolation', () => {
  it('requires every registered Harness to declare native Thread capabilities', async () => {
    const metadata = JSON.parse(await source('../package.json'))
    const declared = Object.keys(metadata.dependencies).filter(name => name.startsWith('@openagent/harness-'))
    expect(HARNESS_IDS).toEqual(declared.map(name => name.slice('@openagent/harness-'.length)))
    expect(Object.keys(harnessDescriptors)).toEqual(HARNESS_IDS)
    for (const harnessId of HARNESS_IDS) {
      const descriptor = harnessDescriptors[harnessId]
      expect(Object.keys(descriptor).sort()).toEqual(['displayName', 'id', 'threadCapabilities'])
      expect(descriptor.threadCapabilities).toEqual({
        instructions: expect.any(Boolean),
        threadContext: expect.any(Boolean),
        sendContext: expect.any(Boolean),
        toolModes: expect.any(Array)
      })
      expect(descriptor.threadCapabilities.toolModes.every(mode => mode === 'extend' || mode === 'exclusive')).toBe(true)
    }
  })

  it('composes generic Main plugins without a Bart-specific bundle property', async () => {
    for (const module of harnessMainPluginModules) {
      const plugin = module.createMainPlugin({
        ...promptOnlyContext,
        harnessDataRoot: `/unused/plugin-settings-isolation/${module.id}`
      })
      try {
        expect(Object.hasOwn(plugin, 'bart')).toBe(false)
        expect(typeof plugin.settings.describe).toBe('function')
        expect(module.descriptor).toEqual(harnessDescriptors[module.id as HarnessId])
      } finally {
        await plugin.dispose?.()
      }
    }
  })

  it('keeps shared defaults and validation provider-neutral', () => {
    const defaults = createDefaultOpenAgentSettings()
    expect(defaults.harnesses).toEqual(Object.fromEntries(
      HARNESS_IDS.map(harnessId => [harnessId, {}])
    ))

    const opaqueHarnesses = Object.fromEntries(HARNESS_IDS.map(harnessId => [
      harnessId,
      {
        futureSchema: `opaque:${harnessId}`,
        nested: { enabled: true, values: [1, 'two', null] }
      }
    ])) as unknown as HarnessSettingsMap
    expect(() => assertOpenAgentSettingsShell({
      ...defaults,
      harnesses: opaqueHarnesses
    })).not.toThrow()

    const invalid: unknown = {
      ...defaults,
      harnesses: {
        ...defaults.harnesses,
        codex: { nonJson: undefined }
      }
    }
    expect(() => assertOpenAgentSettingsShell(invalid))
      .toThrow('codex Harness settings 必须是 JSON object')
  })

  it('lets each Main binding bootstrap and normalize its own empty slice', () => {
    const composition = createMainHarnessComposition({
      resolver: new CliResolver(),
      harnessDataRoot: '/tmp/openagent-plugin-isolation/harnesses',
      temporaryWorkspaceRoot: '/tmp/openagent-plugin-isolation/temporary',
      authorizeManagedWorkspaceWrite: async request => ({
        kind: 'managed-linked-worktree',
        cwd: request.worktree.cwd || request.worktree.baseCwd,
        headOid: request.expectedHeadOid || 'test-head',
        writableRoots: [request.worktree.cwd || request.worktree.baseCwd]
      })
    })
    expect(Object.keys(composition)).toEqual(HARNESS_IDS)

    const defaults = createDefaultOpenAgentSettings()
    const normalized = HARNESS_IDS.reduce<OpenAgentSettings>(
      (settings, harnessId) => composition[harnessId].normalizeSettings(settings),
      defaults
    )

    expect(defaults.harnesses).toEqual(emptyHarnessSettings())
    expect(Object.keys(normalized.harnesses)).toEqual(HARNESS_IDS)
    expect(normalized.harnesses).toMatchObject({
      codex: { threadSettings: {} },
      claude: { threadSettings: {} }
    })
    expect(() => assertOpenAgentSettingsShell(normalized)).not.toThrow()
  })

  it('keeps concrete imports and provider data-root derivation in composition roots', async () => {
    const [sharedSettings, mainComposition, mainIndex] = await Promise.all([
      source('../src/shared/openagent-settings.ts'),
      source('../src/main/harness-composition.ts'),
      source('../src/main/index.ts')
    ])

    expect(sharedSettings).not.toMatch(/from\s+['"][^'"]*\/harnesses\//)
    expect(sharedSettings).not.toMatch(
      /(?:Codex|Claude|Kimi|Cursor|MiniMax|Grok|Zcode)(?:Harness|Thread|Presentation)Settings/
    )
    expect(mainIndex).not.toMatch(/codexDataRoot/)
    expect(mainIndex).not.toMatch(
      /join\(\s*userDataPath\s*,\s*['"]harnesses['"]\s*,/
    )
    expect(mainIndex).toMatch(
      /harnessDataRoot:\s*join\(\s*userDataPath\s*,\s*['"]harnesses['"]\s*\)/
    )
    expect(mainComposition).toMatch(
      /harnessDataRoot:\s*join\(context\.harnessDataRoot,\s*id\)/
    )
    expect(mainIndex.match(/new WorktreeManager\(\s*\{/g)).toHaveLength(1)
    expect(mainIndex).toMatch(
      /authorizeManagedWorkspaceWrite:[\s\S]*?worktreeManager\.authorizeManagedWorkspaceWrite/
    )
    expect(mainIndex).toMatch(
      /new OpenAgentService\([\s\S]*?mainHarnesses,\s*worktreeManager,/
    )
  })
})

const promptOnlyContext = {
  temporaryWorkspaceRoot: '/unused/prompt-profile-test',
  async resolveExecutable(): Promise<string> { throw new Error('Unexpected native IO') },
  async environment(): Promise<NodeJS.ProcessEnv> { throw new Error('Unexpected native IO') }
}

function emptyHarnessSettings(): Record<HarnessId, object> {
  return Object.fromEntries(HARNESS_IDS.map(harnessId => [harnessId, {}])) as
    Record<HarnessId, object>
}

function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8')
}
