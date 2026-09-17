import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutableNotFoundError, type HarnessPluginHostContext } from '@openagent/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiSettings } from '../src/main/settings.js'
import { retirePiVersions, startPiRpc } from '../src/main/runtime/rpc.js'

vi.mock('../src/main/runtime/rpc.js', () => ({ startPiRpc: vi.fn(), retirePiVersions: vi.fn() }))
const models = [
  { provider: 'anthropic', id: 'reasoner', name: 'Reasoner', reasoning: true },
  { provider: 'openai', id: 'fast', name: 'Fast', reasoning: false }
]
let selected = models[0]!
let disposal = vi.fn()
let request = vi.fn()
let host: HarnessPluginHostContext
const signal = () => new AbortController().signal
beforeEach(async () => {
  vi.clearAllMocks()
  selected = models[0]!
  disposal = vi.fn()
  request = vi.fn(async (command: Record<string, unknown>) => {
    switch (command.type) {
      case 'get_available_models': return { models }
      case 'get_state': return { model: selected, thinkingLevel: selected.reasoning ? 'medium' : 'off' }
      case 'get_available_thinking_levels': return { levels: selected.reasoning ? ['off', 'low', 'medium', 'high'] : ['off'] }
      default: throw new Error('Unexpected RPC command')
    }
  })
  vi.mocked(startPiRpc).mockImplementation(async options => {
    const providerIndex = options.args.indexOf('--provider')
    const modelIndex = options.args.indexOf('--model')
    selected = models.find(model => (providerIndex < 0 || model.provider === options.args[providerIndex + 1]) &&
      (modelIndex < 0 || model.id === options.args[modelIndex + 1])) ?? models[0]!
    return { request, dispose: disposal } as unknown as Awaited<ReturnType<typeof startPiRpc>>
  })
  host = { resolveExecutable: vi.fn(async (_command, _cwd, configured) => configured ?? '/bin/pi'), environment: vi.fn(async () => ({})), harnessDataRoot: await mkdtemp(join(tmpdir(), 'pi-settings-')), temporaryWorkspaceRoot: '/tmp/pi' }
})

afterEach(async () => { await rm(host.harnessDataRoot, { recursive: true, force: true }) })

describe('Pi settings public contract', () => {
  it('resolves DeepSeek from the Host key/model without Pi login or global setters', async () => {
    models.push({ provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek', reasoning: true })
    try {
      const bundle = createPiSettings({ ...host, providerOverride: { provider: 'deepseek', apiKey: 'host-key', baseUrl: 'http://127.0.0.1:12345', model: 'deepseek-v4-flash' } })
      const settings = await bundle.settings.resolveThreadSettings({ merged: {}, sessionState: null, cwd: '/workspace', signal: signal() })
      expect(settings).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-flash' })
      expect(vi.mocked(startPiRpc).mock.calls[0]?.[0]).toMatchObject({ env: { OPENAGENT_PROVIDER_API_KEY: 'host-key' }, args: expect.arrayContaining(['--provider', 'deepseek', '--model', 'deepseek-v4-flash']) })
      expect(await host.environment()).toEqual({})
      expect(request.mock.calls.every(([command]) => String(command.type).startsWith('get_'))).toBe(true)
    } finally { models.pop() }
  })

  it('honours the gate: a payload without the opt-out never executes its hidden thread defaults', () => {
    const { settings } = createPiSettings(host)
    expect(settings.normalizeHarnessSettings({} as never)).toEqual({ threadSettings: {} })
    expect(settings.normalizeHarnessSettings({ threadSettings: { model: 'reasoner' } })).toEqual({ threadSettings: {} })
    expect(settings.normalizeHarnessSettings({ useDefaultThreadSettings: true, threadSettings: { model: 'reasoner' } })).toEqual({ threadSettings: {} })
    expect(settings.defaultThreadSettings({ threadSettings: { model: 'reasoner' } })).toEqual({})
    expect(() => settings.normalizeHarnessSettings({ threadSettings: { surprise: true } } as never)).toThrow('unknown field')
  })
  it('derives the settings-page custom gate without leaking it into execution', () => {
    const { settings } = createPiSettings(host)
    expect(settings.normalizeHarnessSettings({ useDefaultThreadSettings: false, threadSettings: {} })).toEqual({ threadSettings: {}, useDefaultThreadSettings: false })
    expect(settings.normalizeHarnessSettings({ threadSettings: {} })).toEqual({ threadSettings: {} })
    expect(settings.normalizeHarnessSettings({ useDefaultThreadSettings: false, threadSettings: { model: 'reasoner' } })).toEqual({ threadSettings: { model: 'reasoner' }, useDefaultThreadSettings: false })
    expect(settings.defaultThreadSettings({ useDefaultThreadSettings: false, threadSettings: { model: 'reasoner' } })).toEqual({ model: 'reasoner' })
  })
  it('rejects a non-boolean useDefaultThreadSettings instead of treating it as the defaults gate', () => {
    const { settings } = createPiSettings(host)
    for (const flag of ['true', 'false', 0, 1, null, {}]) {
      expect(() => settings.normalizeHarnessSettings({ threadSettings: {}, useDefaultThreadSettings: flag } as never)).toThrow('useDefaultThreadSettings')
    }
  })
  it('pins runtime defaults with authenticated catalog validation and cleans up', async () => {
    const { settings } = createPiSettings(host)
    expect(await settings.resolveThreadSettings({ merged: {}, sessionState: null, cwd: '/workspace', signal: signal() })).toEqual({ executablePath: '/bin/pi', provider: 'anthropic', model: 'reasoner', thinkingLevel: 'medium' })
    expect(disposal).toHaveBeenCalledOnce()
    expect(startPiRpc).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace', args: ['--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates'] }))
  })
  it('rejects unknown GUI/Bart fields and unsupported model or thinking selections', async () => {
    const { settings } = createPiSettings(host)
    for (const requested of [{ unknown: 'value' }, { provider: 'missing', model: 'fake' }, { thinkingLevel: 'ultra' }]) {
      await expect(settings.resolveThreadSettings({ merged: {}, requested: requested as never, sessionState: null, cwd: '/workspace', signal: signal() })).rejects.toThrow()
    }
    expect(disposal).toHaveBeenCalledTimes(2)
  })
  it('clears inherited thinking when switching model and permits explicit null', async () => {
    const { settings } = createPiSettings(host)
    const current = { executablePath: '/bin/pi', provider: 'anthropic', model: 'reasoner', thinkingLevel: 'high' }
    expect(await settings.applyThreadSettingsUpdate({ current, defaults: {}, update: { provider: 'openai', model: 'fast' }, hasContent: true, cwd: '/workspace', signal: signal() })).toEqual({ executablePath: '/bin/pi', provider: 'openai', model: 'fast', thinkingLevel: 'off' })
    expect(await settings.applyThreadSettingsUpdate({ current, defaults: {}, update: { thinkingLevel: null }, hasContent: false, cwd: '/workspace', signal: signal() })).toMatchObject({ thinkingLevel: 'medium' })
  })
  it('rejects executable overrides on creation and updates even before history', async () => {
    const { settings } = createPiSettings(host)
    for (const field of ['executablePath', 'permissionMode', 'approvalPolicy', 'sandbox', 'unknown']) {
      const update = { [field]: '/other/pi' }
      await expect(settings.resolveThreadSettings({ merged: { executablePath: '/global/pi', ...update }, requested: update, sessionState: null, cwd: '/workspace', signal: signal() })).rejects.toThrow('unknown field')
      for (const hasContent of [false, true]) {
        await expect(settings.applyThreadSettingsUpdate({ current: { executablePath: '/bin/pi' }, defaults: {}, update, hasContent, cwd: '/workspace', signal: signal() })).rejects.toThrow('unknown field')
      }
    }
    expect(startPiRpc).not.toHaveBeenCalled()
    expect(() => settings.normalizeHarnessSettings({ threadSettings: { executablePath: '/other/pi' } } as never)).toThrow('unknown field')
  })
  it('retains the pinned internal path across resolution, updates and prompts', async () => {
    const { settings, availability, detectInstallation } = createPiSettings(host)
    const options = { provider: 'anthropic', model: 'reasoner', thinkingLevel: 'high' }
    const pinned = { executablePath: '/global/pi', ...options }
    const current = await settings.resolveThreadSettings({ merged: pinned, sessionState: null, cwd: '/workspace', signal: signal() })
    expect(current).toEqual(pinned)
    expect(await settings.applyThreadSettingsUpdate({ current, defaults: {}, update: {}, hasContent: true, cwd: '/workspace', signal: signal() })).toEqual(current)
    expect(settings.promptSettings({ threadSettings: {} }, current)).toEqual(current)
    await expect(settings.resolveThreadSettings({ merged: { ...pinned, executablePath: '/new/pi' }, existing: current, sessionState: { sessionFile: '/session' }, cwd: '/workspace', signal: signal() })).rejects.toThrow('cannot change')
    expect(host.resolveExecutable).toHaveBeenLastCalledWith('pi', '/workspace', '/global/pi')
    await expect(availability.probe({ settings: { useDefaultThreadSettings: false, threadSettings: { ...options, thinkingLevel: 'medium' } }, cwd: '/workspace', signal: signal() })).resolves.toEqual({ available: true })
    await expect(detectInstallation({ cwd: '/workspace', signal: signal() })).resolves.toEqual({ status: 'installed', executablePath: '/bin/pi' })
    expect(settings.hasThreadContent({ version: 1, messages: [], executions: [], latestExecutionId: null })).toBe(false)
    expect(settings.hasThreadContent({ sessionFile: '/native/session.jsonl' })).toBe(true)
  })
  it('loads provider/model-specific thinking choices and scoped schema examples', async () => {
    const { settingsPresentation, settings } = createPiSettings(host)
    const input = { settings: { threadSettings: {} }, cwd: '/workspace', signal: signal() }
    const data = await settingsPresentation.load(input)
    expect(data.models.map(model => model.thinkingLevels)).toEqual([['off', 'low', 'medium', 'high'], undefined])
    const other = await settingsPresentation.load({ ...input, settings: { useDefaultThreadSettings: false, threadSettings: { provider: 'openai', model: 'fast' } } })
    expect(other.models.map(model => model.thinkingLevels)).toEqual([undefined, ['off']])
    expect(request.mock.calls.every(([command]) => String(command.type).startsWith('get_'))).toBe(true)
    const schema = await settings.describe(input)
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties as object).sort()).toEqual(['model', 'provider', 'thinkingLevel'])
    expect((schema.properties as Record<string, Record<string, unknown>>).model).toMatchObject({ examples: ['reasoner', 'fast'] })
  })
  it('inherits omitted creation options and clears or explicitly replaces thinking on selection changes', async () => {
    const { settings } = createPiSettings(host)
    const defaults = { executablePath: '/global/pi', provider: 'anthropic', model: 'reasoner', thinkingLevel: 'high' }
    const resolve = (requested: Record<string, string | null>) => settings.resolveThreadSettings({ merged: { ...defaults, ...requested } as never, requested, sessionState: null, cwd: '/workspace', signal: signal() })
    await expect(resolve({})).resolves.toEqual(defaults)
    await expect(resolve({ provider: 'openai', model: 'fast' })).resolves.toMatchObject({ provider: 'openai', model: 'fast', thinkingLevel: 'off' })
    await expect(resolve({ provider: null, model: null, thinkingLevel: null })).resolves.toMatchObject({ provider: 'anthropic', model: 'reasoner', thinkingLevel: 'medium' })
    await expect(resolve({ model: 'reasoner', thinkingLevel: 'low' })).resolves.toMatchObject({ thinkingLevel: 'low' })
    await expect(resolve({ provider: 'openai', model: 'fast', thinkingLevel: 'high' })).rejects.toThrow('unsupported')
    await expect(resolve({ provider: 'anthropic', model: 'fast' })).rejects.toThrow('unavailable')
  })
  it('accepts a target-environment model absent from earlier schema examples', async () => {
    const { settings } = createPiSettings(host)
    const schema = await settings.describe({ settings: { threadSettings: {} }, cwd: '/workspace', signal: signal() })
    expect((schema.properties as Record<string, Record<string, unknown>>).model.examples).not.toContain('custom-new')
    models.push({ provider: 'custom', id: 'custom-new', name: 'Custom', reasoning: false })
    try {
      await expect(settings.resolveThreadSettings({ merged: {}, requested: { provider: 'custom', model: 'custom-new', thinkingLevel: 'off' }, sessionState: null, cwd: '/workspace', signal: signal() })).resolves.toMatchObject({ provider: 'custom', model: 'custom-new', thinkingLevel: 'off' })
    } finally { models.pop() }
  })
  it('keeps availability independent of full model discovery', async () => {
    const { availability } = createPiSettings(host)
    const state = request.getMockImplementation()!
    request.mockImplementation(async (command: Record<string, unknown>) => {
      if (String(command.type).startsWith('get_available')) throw new Error('catalog unavailable')
      return state(command)
    })
    // The session is what proves Pi can run, so a listing that fails must not
    // take the probe down with it.
    await expect(availability.probe({ settings: { threadSettings: {} }, cwd: '/workspace', signal: signal() })).resolves.toEqual({ available: true })
    expect(disposal).toHaveBeenCalledOnce()
  })
  it('never asks for the model catalog while probing availability', async () => {
    const { availability } = createPiSettings(host)
    const asked: unknown[] = []
    const state = request.getMockImplementation()!
    request.mockImplementation(async (command: Record<string, unknown>) => {
      asked.push(command.type)
      return state(command)
    })
    // Availability is a question about the native session; a listing that is
    // slow or hangs must not delay it or turn a working Pi into an unavailable
    // one, so the probe never issues it.
    await expect(availability.probe({ settings: { threadSettings: {} }, cwd: '/workspace', signal: signal() })).resolves.toEqual({ available: true })
    expect(asked).toEqual(['get_state'])
  })
  it('validates the configured provider/model pair against what the session applied, not the catalog', async () => {
    const { availability } = createPiSettings(host)
    request.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === 'get_available_models') return { models: [] }
      if (command.type === 'get_available_thinking_levels') return { levels: ['off', 'low', 'medium', 'high'] }
      return { model: selected, thinkingLevel: 'medium' }
    })
    // An empty catalog cannot make the applied pair untrue, and a populated one
    // cannot make an unapplied pair true.
    await expect(availability.probe({ settings: { useDefaultThreadSettings: false, threadSettings: { provider: 'anthropic', model: 'reasoner' } }, cwd: '/workspace', signal: signal() })).resolves.toEqual({ available: true })
    await expect(availability.probe({ settings: { useDefaultThreadSettings: false, threadSettings: { provider: 'openai', model: 'reasoner' } }, cwd: '/workspace', signal: signal() })).resolves.toMatchObject({ available: false })
  })
  it('ignores a persisted provider/model pair while the gate still points at the Agent defaults', async () => {
    const { availability, settings } = createPiSettings(host)
    await expect(availability.probe({ settings: { threadSettings: { provider: 'anthropic', model: 'fast' } }, cwd: '/workspace', signal: signal() })).resolves.toEqual({ available: true })
    expect(settings.defaultThreadSettings({ threadSettings: { provider: 'anthropic', model: 'fast' } })).toEqual({})
  })
  it('turns native startup disconnection into actionable configuration guidance', async () => {
    vi.mocked(startPiRpc).mockRejectedValue(new Error('Pi RPC output disconnected'))
    const { availability, settingsPresentation } = createPiSettings(host)
    const input = { settings: { threadSettings: { provider: 'invalid', model: 'invalid' } }, cwd: '/workspace', signal: signal() }
    const result = await availability.probe(input)
    expect(result.available).toBe(false)
    expect(result.reason).toContain('provider/model/thinking')
    expect(result.reason).toContain('pi /login')
    expect((await settingsPresentation.load(input)).cli.message).toContain('Pi executable')
  })
  it('accepts null clears in the shallow merged Bart request', async () => {
    const { settings } = createPiSettings(host)
    await expect(settings.resolveThreadSettings({ merged: { provider: 'anthropic', model: 'reasoner', thinkingLevel: null } as never, requested: { thinkingLevel: null }, sessionState: null, cwd: '/workspace', signal: signal() })).resolves.toMatchObject({ thinkingLevel: 'medium' })
  })
  it('distinguishes typed missing installation from resolution errors without starting Pi', async () => {
    const { detectInstallation } = createPiSettings(host)
    vi.mocked(host.resolveExecutable).mockRejectedValueOnce(new HarnessExecutableNotFoundError('pi'))
    await expect(detectInstallation({ cwd: '/workspace', signal: signal() })).resolves.toEqual({ status: 'missing' })
    vi.mocked(host.resolveExecutable).mockRejectedValueOnce(new Error('Permission denied'))
    await expect(detectInstallation({ cwd: '/workspace', signal: signal() })).rejects.toThrow('Permission denied')
    expect(startPiRpc).not.toHaveBeenCalled()
  })
  it('turns away a cancelled caller even when an observation is already cached', async () => {
    const { availability } = createPiSettings(host)
    await expect(availability.probe({ settings: { threadSettings: {} }, cwd: '/workspace', signal: signal() })).resolves.toEqual({ available: true })
    const controller = new AbortController(); controller.abort()
    // The answer is ready in the cache, but the request is already abandoned.
    // Whether a request aborts must not depend on a previous caller having
    // warmed the cache, so the hit cannot skip cancellation.
    await expect(availability.probe({ settings: { threadSettings: {} }, cwd: '/workspace', signal: controller.signal })).rejects.toThrow()
    expect(startPiRpc).toHaveBeenCalledOnce()
  })
  it('keeps the newest observation when an earlier one finishes last', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let sessions = 0
    vi.mocked(startPiRpc).mockImplementation(async () => {
      sessions += 1
      const previous = sessions === 1
      return {
        request: async (command: Record<string, unknown>) => {
          // The first session is the one that saw the account as it was, and it
          // is also the one that answers late.
          if (previous) await held
          switch (command.type) {
            case 'get_available_models': return { models }
            case 'get_available_thinking_levels': return { levels: previous ? ['off'] : ['off', 'low', 'medium', 'high'] }
            default: return { model: previous ? models[1] : models[0], thinkingLevel: previous ? 'off' : 'medium' }
          }
        },
        dispose: disposal
      } as unknown as Awaited<ReturnType<typeof startPiRpc>>
    })
    const { settingsPresentation } = createPiSettings(host)
    const input = { settings: { threadSettings: {} }, cwd: '/workspace', signal: signal() }
    const stale = settingsPresentation.load(input)
    await expect(settingsPresentation.load(input)).resolves.toBeDefined()
    release()
    await expect(stale).resolves.toBeDefined()
    // Only the observation that started last may say what the account is, so the
    // session it overlapped must not put the previous native selection back.
    const settled = await settingsPresentation.load(input)
    expect(settled.models.map(model => model.thinkingLevels)).toEqual([['off', 'low', 'medium', 'high'], undefined])
    expect(startPiRpc).toHaveBeenCalledTimes(2)
  })
  it('answers a forced presentation refresh from the account rather than the observation cache', async () => {
    const { settingsPresentation } = createPiSettings(host)
    const input = { settings: { threadSettings: {} }, cwd: '/workspace', signal: signal() }
    await settingsPresentation.load(input)
    expect(startPiRpc).toHaveBeenCalledOnce()
    // A reader who asks for a refresh is asking what the account is now — after
    // pi /login, say — so the window of shared observations must not replay the
    // state the refresh exists to replace.
    await settingsPresentation.load({ ...input, refresh: true })
    expect(startPiRpc).toHaveBeenCalledTimes(2)
  })
  it('retires the version memo before the steps a forced refresh can fail', async () => {
    const { settingsPresentation } = createPiSettings(host)
    vi.mocked(host.resolveExecutable).mockRejectedValue(new Error('Permission denied'))
    // The memo is keyed by what resolution and the environment return, so a
    // refresh that dies resolving the executable cannot name the key it needs
    // retired. Leaving the gate standing would answer the next read from the
    // installation as it was, which is what the refresh set out to replace.
    await settingsPresentation.load({ settings: { threadSettings: {} }, cwd: '/workspace', signal: signal(), refresh: true })
    expect(retirePiVersions).toHaveBeenCalledOnce()
  })
  it('does not let a cache hit supersede a catalog probe already in flight', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let sessions = 0
    vi.mocked(startPiRpc).mockImplementation(async () => {
      sessions += 1
      const slow = sessions === 2
      return {
        request: async (command: Record<string, unknown>) => {
          if (slow) await held
          switch (command.type) {
            case 'get_available_models': return { models }
            case 'get_available_thinking_levels': return { levels: ['off', 'low', 'medium', 'high'] }
            default: return { model: selected, thinkingLevel: 'medium' }
          }
        },
        dispose: disposal
      } as unknown as Awaited<ReturnType<typeof startPiRpc>>
    })
    const { availability, settingsPresentation } = createPiSettings(host)
    const input = { settings: { threadSettings: {} }, cwd: '/workspace', signal: signal() }
    // An availability probe caches an observation without a catalog.
    await expect(availability.probe(input)).resolves.toEqual({ available: true })
    const catalog = settingsPresentation.load(input)
    await Promise.resolve()
    // The hit answers from what is already there and writes nothing, so it must
    // not count as the newest request: the probe on its way is the one that saw
    // the catalog, and the next reader would otherwise boot a session this cache
    // exists to avoid.
    await expect(availability.probe(input)).resolves.toEqual({ available: true })
    release()
    await expect(catalog).resolves.toBeDefined()
    await expect(settingsPresentation.load(input)).resolves.toBeDefined()
    expect(startPiRpc).toHaveBeenCalledTimes(2)
  })
  it('propagates cancellation and rejects unsupported provider overrides', async () => {
    const controller = new AbortController(); controller.abort()
    const { settingsPresentation } = createPiSettings(host)
    await expect(settingsPresentation.load({ settings: { threadSettings: {} }, cwd: '/workspace', signal: controller.signal })).rejects.toThrow()
    const { availability } = createPiSettings({ ...host, providerOverride: { provider: 'custom', model: 'fast', apiKey: 'secret', baseUrl: 'http://127.0.0.1:12345' } })
    await expect(availability.probe({ settings: { useDefaultThreadSettings: false, threadSettings: { provider: 'conflicting' } }, cwd: '/workspace', signal: signal() })).resolves.toMatchObject({ available: false, reason: expect.stringContaining('providerOverride') })
    expect(startPiRpc).not.toHaveBeenCalled()
  })
})
