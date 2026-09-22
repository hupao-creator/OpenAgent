import { describe, expect, it, vi } from 'vitest'
import {
  createClaudeMainPlugin
} from '../../../packages/harness-claude/src/main'
import {
  createClaudeCatalogSource,
  type ClaudeCatalogSource
} from '../../../packages/harness-claude/src/main/catalog'
import type {
  ClaudeHarnessSettings,
  ClaudeSettingsPresentationData,
  ClaudeThreadSettings
} from '../../../packages/harness-claude/src/shared/settings'
import type { JsonValue } from '@openagent/contracts'
import { describeThreadCreation } from '../src/main/bart-v1/thread-creation'
import { createClaudeEvaluationContext } from '../../../packages/harness-claude/src/main/evaluation'

const versionProbe = vi.hoisted(() => vi.fn(async () => ({ stdout: 'A\n', stderr: '' })))
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: versionProbe })
}))

const signal = new AbortController().signal
const settings: ClaudeHarnessSettings = {
  threadSettings: {}
}

describe('Claude live catalog admission', () => {
  it('contributes final evaluation advice from native identities without involving the settings resolver', async () => {
    const load = vi.fn(async () => availableCatalog())
    const waitForBootstrap = vi.fn(async () => ({
      source: 'fixture evaluator', observedAt: null, availability: 'available' as const, releases: []
    }))
    const contribute = createClaudeEvaluationContext({ load }, { waitForBootstrap }, {
      resolveExecutable: async () => 'claude',
      environment: async () => ({ CLAUDE_CONFIG_DIR: '/nonexistent-openagent-fixture', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
    })
    const content = await contribute({
      settings: { threadSettings: {} },
      cwd: '/workspace/evaluation', signal,
      telemetryLedger: { record: async () => undefined, read: () => ({ windows: [] }) }
    })
    expect(load).toHaveBeenCalledWith({ executablePath: 'claude', cwd: '/workspace/evaluation', signal })
    expect(waitForBootstrap).toHaveBeenCalledWith([['opus', 'Opus'], ['sonnet', 'Sonnet']], signal)
    expect(content).toContain('Unmeasured native catalog identities: opus (Opus), sonnet (Sonnet)')
    expect(content).toContain('fixture evaluator')
  })

  it('describes every creation field with current GUI native examples without evaluation', async () => {
    const plugin = mainPlugin(source(availableCatalog()))
    const schema = await plugin.settings.describe({ settings, cwd: '/tmp/project', signal })
    const properties = schema.properties as Record<string, Record<string, unknown>>
    expect(Object.keys(properties).sort()).toEqual([
      'effort', 'model', 'permissionMode'
    ])
    const presentation = await plugin.settingsPresentation.load({ settings, cwd: '/tmp/project', signal })
    expect(properties.model.examples).toEqual(presentation.models.map(model => model.value))
    expect(properties.effort.examples).toEqual(['high', 'low', 'medium'])
    expect(properties.effort.enum).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(properties.permissionMode.enum).toEqual(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toBeUndefined()
    const composed = await describeThreadCreation({
      composition: { claude: { id: 'claude', displayName: 'Claude', describe: async () => schema } },
      targetHarnessIds: ['claude'], cwd: '/tmp/project', signal
    })
    expect(composed.inputSchema.oneOf).toMatchObject([{ properties: { options: schema } }])
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings({ model: 'opus', effort: 'high' }),
      requested: { model: 'opus', effort: 'high' },
      sessionState: null, cwd: '/tmp/project', signal
    })).resolves.toEqual(threadSettings({ model: 'opus', effort: 'high' }))
  })

  it('accepts native target choices absent from the description environment catalog', async () => {
    const targetExecutable = '/target/claude'
    const targetCwd = '/workspace/target'
    const targetModel = 'target-only-model'
    const source: ClaudeCatalogSource = {
      load: async input => input.executablePath === targetExecutable && input.cwd === targetCwd
        ? {
            cli: { status: 'available', executablePath: targetExecutable, version: 'target' },
            models: [{ value: targetModel, displayName: 'Target model', supportedEfforts: ['xhigh'] }]
          }
        : availableCatalog()
    }
    const plugin = mainPlugin(source)
    const schema = await plugin.settings.describe({ settings, cwd: '/workspace/bart', signal })
    const properties = schema.properties as Record<string, Record<string, unknown>>
    const requested = { model: targetModel, effort: 'xhigh' as const }
    const presentation = await plugin.settingsPresentation.load({
      settings,
      thread: { settings: { executablePath: targetExecutable, ...requested } },
      cwd: targetCwd,
      signal
    })
    expect(presentation.models).toEqual([
      { value: targetModel, displayName: 'Target model', supportedEfforts: ['xhigh'] }
    ])
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings({ executablePath: targetExecutable, ...requested }),
      requested,
      sessionState: null,
      cwd: targetCwd,
      signal
    })).resolves.toMatchObject(requested)
    expect(properties.model).not.toHaveProperty('enum')
    expect(properties.model.examples).toEqual(['opus', 'sonnet'])
    expect(properties.model).toMatchObject({ type: 'string' })
    expect(properties.model).not.toHaveProperty('not')
    expect(properties.effort.examples).toEqual(['high', 'low', 'medium'])
    expect(properties.effort.enum).toContain('xhigh')
    expect(schema).not.toHaveProperty('allOf')
    // Being advertised in Bart's environment does not authorize the same model
    // in the actual target environment.
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings({ executablePath: targetExecutable, model: 'opus' }),
      requested: { model: 'opus' },
      sessionState: null,
      cwd: targetCwd,
      signal
    })).rejects.toThrow('未知 Claude 模型')
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings({ executablePath: targetExecutable, ...requested, effort: 'high' }),
      requested: { ...requested, effort: 'high' },
      sessionState: null,
      cwd: targetCwd,
      signal
    })).rejects.toThrow('不支持 effort')
  })

  it('uses the complete same default request for GUI and composed Thread creation', async () => {
    const plugin = mainPlugin(source(availableCatalog()))
    const harnessSettings: ClaudeHarnessSettings = {
      useDefaultThreadSettings: false,
      threadSettings: {
        model: 'sonnet', effort: 'low',
        goalMode: true, permissionMode: 'auto', allowedTools: ['Read'], disallowedTools: ['Bash']
      }
    }
    const merged = plugin.settings.defaultThreadSettings(harnessSettings)
    // The host owns the executable, so opting into custom defaults still pins
    // the literal `claude` command while carrying the user-facing knobs.
    expect(merged).toEqual({
      executablePath: 'claude', permissionMode: 'auto', model: 'sonnet', effort: 'low',
      goalMode: true, allowedTools: ['Read'], disallowedTools: ['Bash']
    })
    const gui = await plugin.settings.resolveThreadSettings({ merged, sessionState: null, cwd: '/tmp/project', signal })
    const composed = await plugin.settings.resolveThreadSettings({
      merged, requested: {}, sessionState: null, cwd: '/tmp/project', signal
    })
    expect(composed).toEqual(gui)
  })

  it.each([
    { executablePath: '/other/claude' }, { goalMode: true },
    { allowedTools: ['Read'] }, { disallowedTools: ['Bash'] }, { unknown: true }
  ])('rejects excluded creation options %j even when absent from merged settings', async requested => {
    const plugin = mainPlugin(source(availableCatalog()))
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings(), requested: requested as never,
      sessionState: null, cwd: '/tmp/project', signal
    })).rejects.toThrow('未知字段')
  })

  it.each(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const)(
    'preserves explicit permission mode %s and omitted defaults', async permissionMode => {
      const plugin = mainPlugin(source(availableCatalog()))
      const merged = threadSettings({ model: 'opus', effort: 'high', goalMode: true, permissionMode })
      await expect(plugin.settings.resolveThreadSettings({
        merged, requested: { permissionMode }, sessionState: null, cwd: '/tmp/project', signal
      })).resolves.toEqual(merged)
    }
  )

  it.each(['default', '', null, 1])('rejects invalid creation permission mode %j', async permissionMode => {
    const plugin = mainPlugin(source(availableCatalog()))
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings(), requested: { permissionMode } as never,
      sessionState: null, cwd: '/tmp/project', signal
    })).rejects.toThrow('permissionMode')
  })

  it.each(['primary', 'fork'] as const)(
    'retains session-bound settings during a defaults refresh with %s native content',
    async kind => {
      const load = vi.fn(async () => availableCatalog())
      const plugin = mainPlugin({ load })
      const existing = threadSettings({
        executablePath: '/retained/claude',
        model: 'opus', effort: 'high', permissionMode: 'manual',
        allowedTools: ['Read'], disallowedTools: ['Bash']
      })
      const merged = threadSettings({
        executablePath: '/new-default/claude',
        model: 'sonnet', effort: 'medium', permissionMode: 'auto',
        allowedTools: ['Bash'], disallowedTools: []
      })

      await expect(plugin.settings.resolveThreadSettings({
        merged, existing, sessionState: retainedClaudeState(kind),
        cwd: '/workspace/retained', signal
      })).resolves.toEqual({
        ...merged,
        executablePath: existing.executablePath,
        allowedTools: existing.allowedTools,
        disallowedTools: existing.disallowedTools
      })
      expect(load).toHaveBeenCalledWith({
        executablePath: existing.executablePath,
        cwd: '/workspace/retained', signal
      })
      expect(existing).toEqual(threadSettings({
        executablePath: '/retained/claude',
        model: 'opus', effort: 'high', permissionMode: 'manual',
        allowedTools: ['Read'], disallowedTools: ['Bash']
      }))
    }
  )

  it.each([
    { existingTools: {}, newTools: { allowedTools: ['Read'], disallowedTools: ['Bash'] } },
    { existingTools: { allowedTools: [], disallowedTools: [] }, newTools: {} }
  ])('preserves retained tool-list absence and empty values during defaults refresh', async ({ existingTools, newTools }) => {
    const plugin = mainPlugin(source(availableCatalog()))
    const existing = threadSettings(existingTools)
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings(newTools), existing,
      sessionState: retainedClaudeState('primary'), cwd: '/workspace/retained', signal
    })).resolves.toStrictEqual(existing)
  })

  it('still rejects omitting an existing goal mode during a defaults refresh', async () => {
    const load = vi.fn(async () => availableCatalog())
    const plugin = mainPlugin({ load })
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings({ executablePath: '/new-default/claude' }),
      existing: threadSettings({ executablePath: '/retained/claude', goalMode: true }),
      sessionState: retainedClaudeState('primary'), cwd: '/workspace/retained', signal
    })).rejects.toThrow('不能切换 goal mode')
    expect(load).not.toHaveBeenCalled()
  })

  it.each([null, { version: 1, turns: [], nativeNotifications: [] }])(
    'adopts new defaults before native content exists (%j)',
    async sessionState => {
      const plugin = mainPlugin(source(availableCatalog()))
      const merged = threadSettings({
        executablePath: '/new-default/claude',
        allowedTools: ['Read'], disallowedTools: ['Bash']
      })
      await expect(plugin.settings.resolveThreadSettings({
        merged, existing: threadSettings({ executablePath: '/unused/claude' }),
        sessionState, cwd: '/workspace/unused', signal
      })).resolves.toEqual(merged)
    }
  )

  it('keeps ordinary Thread immutable locks while permitting mutable settings updates', async () => {
    const plugin = mainPlugin(source(availableCatalog()))
    const current = threadSettings({ allowedTools: ['Read'], disallowedTools: ['Bash'] })
    const defaults = threadSettings()
    const hasContent = plugin.settings.hasThreadContent(retainedClaudeState('primary'))
    expect(hasContent).toBe(true)
    for (const update of [{ allowedTools: ['Bash'] }, { disallowedTools: [] }]) {
      await expect(plugin.settings.applyThreadSettingsUpdate({
        current, defaults, update, hasContent, cwd: '/workspace/retained', signal
      })).rejects.toThrow('不能更改工具 allow/deny 列表')
      await expect(plugin.settings.applyThreadSettingsUpdate({
        current, defaults, update, hasContent: false, cwd: '/workspace/unused', signal
      })).resolves.toMatchObject(update)
    }
    await expect(plugin.settings.applyThreadSettingsUpdate({
      current, defaults, update: { executablePath: '/other/claude' } as never,
      hasContent, cwd: '/workspace/retained', signal
    })).rejects.toThrow('包含未知字段')
    await expect(plugin.settings.applyThreadSettingsUpdate({
      current, defaults, update: { model: 'sonnet', effort: 'medium', permissionMode: 'auto' },
      hasContent, cwd: '/workspace/retained', signal
    })).resolves.toEqual({ ...current, model: 'sonnet', effort: 'medium', permissionMode: 'auto' })
  })

  it('allows an effort-only override against a configured compatible model', async () => {
    const plugin = mainPlugin(source(availableCatalog()))
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings({ model: 'sonnet', effort: 'medium' }),
      requested: { effort: 'medium' }, sessionState: null, cwd: '/tmp/project', signal
    })).resolves.toEqual(threadSettings({ model: 'sonnet', effort: 'medium' }))
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings({ model: 'sonnet', effort: 'high' }),
      requested: { effort: 'high' }, sessionState: null, cwd: '/tmp/project', signal
    })).rejects.toThrow('不支持 effort')
  })

  it('rejects unknown models and retains other settings when catalog discovery fails', async () => {
    const plugin = mainPlugin(source(availableCatalog()))
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings({ model: 'invented' }), sessionState: null, cwd: '/tmp/project', signal
    })).rejects.toThrow('未知 Claude 模型')
    const unavailable = mainPlugin(source(unavailableCatalog()))
    const schema = await unavailable.settings.describe({ settings, cwd: '/tmp/project', signal })
    expect((schema.properties as Record<string, unknown>).model).toMatchObject({ type: 'string', examples: [] })
    expect((schema.properties as Record<string, unknown>).model).not.toHaveProperty('not')
    expect((schema.properties as Record<string, unknown>).permissionMode).toMatchObject({ type: 'string' })
    await expect(unavailable.settings.resolveThreadSettings({
      merged: threadSettings({ permissionMode: 'auto', goalMode: true }),
      sessionState: null, cwd: '/tmp/project', signal
    })).resolves.toEqual(threadSettings({ permissionMode: 'auto', goalMode: true }))
  })

  it('enforces the same catalog at create/update admission and resets model siblings', async () => {
    const plugin = mainPlugin(source(availableCatalog()))
    const created = await plugin.settings.resolveThreadSettings({
      merged: threadSettings({ model: 'sonnet', effort: 'high' }),
      requested: { model: 'sonnet' },
      sessionState: null,
      cwd: '/tmp/project',
      signal
    })
    expect(created).toEqual(threadSettings({ model: 'sonnet' }))

    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings({ model: 'sonnet', effort: 'high' }),
      requested: { model: 'sonnet', effort: 'high' },
      sessionState: null,
      cwd: '/tmp/project',
      signal
    })).rejects.toThrow('不支持 effort')

    const current = threadSettings({ model: 'opus', effort: 'high' })
    const defaults = threadSettings({ model: 'sonnet', effort: 'low' })
    await expect(plugin.settings.applyThreadSettingsUpdate({
      current,
      defaults,
      update: { model: 'sonnet' },
      hasContent: false,
      cwd: '/tmp/project',
      signal
    })).resolves.toEqual(threadSettings({ model: 'sonnet' }))
    await expect(plugin.settings.applyThreadSettingsUpdate({
      current,
      defaults,
      update: { model: null },
      hasContent: false,
      cwd: '/tmp/project',
      signal
    })).resolves.toEqual(defaults)
    await expect(plugin.settings.applyThreadSettingsUpdate({
      current,
      defaults,
      update: { model: null, effort: 'medium' },
      hasContent: false,
      cwd: '/tmp/project',
      signal
    })).resolves.toEqual(threadSettings({ model: 'sonnet', effort: 'medium' }))
    await expect(plugin.settings.applyThreadSettingsUpdate({
      current,
      defaults,
      update: { model: null, effort: 'high' },
      hasContent: false,
      cwd: '/tmp/project',
      signal
    })).rejects.toThrow('不支持 effort')
  })

  it('keeps Main provider-default only when catalog discovery fails', async () => {
    const plugin = mainPlugin(source(unavailableCatalog()))
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings({ permissionMode: 'auto' }),
      sessionState: null,
      cwd: '/tmp/project',
      signal
    })).resolves.toEqual(threadSettings({ permissionMode: 'auto' }))
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings({ model: 'invented' }),
      sessionState: null,
      cwd: '/tmp/project',
      signal
    })).rejects.toThrow('provider-default')
  })

  it('does not initialize a catalog for provider-default model and effort', async () => {
    const load = vi.fn(async () => availableCatalog())
    const plugin = mainPlugin({ load })
    await expect(plugin.settings.resolveThreadSettings({
      merged: threadSettings({ permissionMode: 'auto' }),
      sessionState: null,
      cwd: '/tmp/project',
      signal
    })).resolves.toEqual(threadSettings({ permissionMode: 'auto' }))
    await expect(plugin.settings.applyThreadSettingsUpdate({
      current: threadSettings({ permissionMode: 'manual' }),
      defaults: threadSettings({}),
      update: { permissionMode: 'auto' },
      hasContent: false,
      cwd: '/tmp/project',
      signal
    })).resolves.toEqual(threadSettings({ permissionMode: 'auto' }))
    expect(load).not.toHaveBeenCalled()
  })

  it.each(['executable', 'environment'] as const)(
    'cancels catalog loading while %s resolution is still pending',
    async (pendingStage) => {
      const controller = new AbortController()
      const catalog = createClaudeCatalogSource({
        resolveExecutable: () => pendingStage === 'executable'
          ? new Promise<string>(() => undefined)
          : Promise.resolve('/native/claude'),
        environment: () => pendingStage === 'environment'
          ? new Promise<NodeJS.ProcessEnv>(() => undefined)
          : Promise.resolve({})
      })
      const loading = catalog.load({ cwd: '/tmp/project', signal: controller.signal })
      const cancellation = new Error('catalog cancelled')
      const assertion = expect(loading).rejects.toBe(cancellation)
      controller.abort(cancellation)
      await assertion
    }
  )

  it('loads Thread presentation from its pinned executable and cwd, not current global settings', async () => {
    versionProbe.mockClear()
    const loads: Array<{ executablePath?: string; cwd: string }> = []
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => '/unused/claude',
      environment: async () => ({}),
      temporaryWorkspaceRoot: '/catalog/global'
    }, {
      load: async (input) => {
        loads.push({
          ...(input.executablePath ? { executablePath: input.executablePath } : {}),
          cwd: input.cwd
        })
        return input.executablePath === '/thread/claude-a'
          ? {
              cli: {
                status: 'available' as const,
                executablePath: '/thread/claude-a',
                version: 'A'
              },
              models: [{
                value: 'thread-model',
                displayName: 'Thread model',
                supportedEfforts: ['high']
              }]
            }
          : {
              cli: {
                status: 'unavailable' as const,
                executablePath: input.executablePath || 'claude',
                message: 'global executable B unavailable'
              },
              models: []
            }
      }
    })
    const globalSettings: ClaudeHarnessSettings = {
      threadSettings: {}
    }

    const globalPresentation = await plugin.settingsPresentation.load({
      settings: globalSettings,
      cwd: '/catalog/global',
      signal
    })
    const threadPresentation = await plugin.settingsPresentation.load({
      settings: globalSettings,
      cwd: '/workspace/thread-a',
      thread: {
        settings: threadSettings({
          executablePath: '/thread/claude-a',
          model: 'thread-model'
        }) as unknown as JsonValue
      },
      signal
    })
    expect(versionProbe).not.toHaveBeenCalled()

    expect(loads).toEqual([
      { executablePath: 'claude', cwd: '/catalog/global' },
      { executablePath: '/thread/claude-a', cwd: '/workspace/thread-a' }
    ])
    expect(globalPresentation.cli).toMatchObject({
      status: 'unavailable',
      executablePath: 'claude'
    })
    expect(threadPresentation).toMatchObject({
      cli: {
        status: 'available',
        executablePath: '/thread/claude-a',
        version: 'A'
      },
      models: [{ value: 'thread-model' }]
    })
  })

  it('only probes a missing version and retains the catalog when the probe fails', async () => {
    versionProbe.mockClear()
    const catalog = availableCatalog()
    delete (catalog.cli as { version?: string }).version
    const plugin = mainPlugin(source(catalog))
    versionProbe.mockResolvedValueOnce({ stdout: 'fallback-version\n', stderr: '' })
    await expect(plugin.settingsPresentation.load({
      settings,
      cwd: '/tmp/project',
      signal
    })).resolves.toMatchObject({
      cli: { status: 'available', version: 'fallback-version' },
      models: catalog.models
    })
    expect(versionProbe).toHaveBeenCalledExactlyOnceWith('/native/claude', ['--version'], {
      cwd: '/tmp/project', env: {}, signal, timeout: 10_000
    })

    versionProbe.mockRejectedValueOnce(new Error('version probe failed'))
    await expect(plugin.settingsPresentation.load({
      settings,
      cwd: '/tmp/project',
      signal
    })).resolves.toEqual(catalog)
  })

  it('cancels optional version discovery while environment resolution is pending', async () => {
    const controller = new AbortController()
    let resolveEnvironmentStarted!: () => void
    const environmentStarted = new Promise<void>((resolve) => {
      resolveEnvironmentStarted = resolve
    })
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => '/unused/claude',
      environment: () => {
        resolveEnvironmentStarted()
        return new Promise<NodeJS.ProcessEnv>(() => undefined)
      }
    }, source({
      cli: { status: 'available', executablePath: '/native/claude' },
      models: []
    }))
    const loading = plugin.settingsPresentation.load({
      settings,
      cwd: '/tmp/project',
      signal: controller.signal
    })
    const assertion = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    await environmentStarted
    controller.abort()
    await assertion
  })

})

function mainPlugin(catalogSource: ClaudeCatalogSource) {
  return createClaudeMainPlugin({
    resolveExecutable: async () => '/unused/claude',
    environment: async () => ({})
  }, catalogSource)
}

function source(value: ClaudeSettingsPresentationData): ClaudeCatalogSource {
  return { load: async () => structuredClone(value) }
}

function availableCatalog(): ClaudeSettingsPresentationData {
  return {
    cli: { status: 'available', executablePath: '/native/claude' },
    models: [{
      value: 'opus',
      displayName: 'Opus',
      supportedEfforts: ['high']
    }, {
      value: 'sonnet',
      displayName: 'Sonnet',
      supportedEfforts: ['low', 'medium']
    }]
  }
}

function unavailableCatalog(): ClaudeSettingsPresentationData {
  return {
    cli: {
      status: 'unavailable',
      executablePath: 'claude',
      message: 'catalog unavailable'
    },
    models: []
  }
}

function threadSettings(
  patch: Partial<ClaudeThreadSettings> = {}
): ClaudeThreadSettings {
  return { executablePath: 'claude', ...patch }
}

function retainedClaudeState(kind: 'primary' | 'fork'): JsonValue {
  return {
    version: 1,
    ...(kind === 'primary'
      ? { primarySessionId: 'retained-native-session' }
      : { pendingFork: { sourceSessionId: 'fork-source-native-session' } }),
    turns: [],
    nativeNotifications: []
  }
}
