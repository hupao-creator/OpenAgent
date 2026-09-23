import { describe, expect, it, vi } from 'vitest'
import { createCodexSettingsApi } from '../../../packages/harness-codex/src/main/settings'
import { describeThreadCreation } from '../src/main/bart-v1/thread-creation'
import type { CodexThreadSettings, CodexThreadSettingsRequest } from '../../../packages/harness-codex/src/shared/types'

const models = [{ value: 'model-a', displayName: 'A', isDefault: true,
  supportedReasoningEfforts: [{ value: 'high' }], serviceTiers: [{ value: 'priority' }] },
  { value: 'model-b', displayName: 'B', supportedReasoningEfforts: [{ value: 'low' }], serviceTiers: [] }]
const load = vi.fn(async () => ({ models, computerUse: false }))
const probeAutoReview = vi.fn(async () => true)
const invalidate = (): void => undefined
const adoptModels = (): void => undefined
const api = createCodexSettingsApi({ load, probeAutoReview, invalidate, adoptModels })
const signal = new AbortController().signal
const defaults: CodexThreadSettings = {
  executablePath: '/configured/codex', model: 'model-a', effort: 'high', serviceTier: 'priority',
  personality: 'friendly', summary: 'detailed', approvalPolicy: 'never', approvalsReviewer: 'auto_review',
  sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/extra'], networkAccess: true,
    excludeTmpdirEnvVar: true, excludeSlashTmp: true }
}
function resolve(requested: CodexThreadSettingsRequest = {}, base = defaults) {
  return api.resolveThreadSettings({ merged: { ...base, ...requested }, requested,
    cwd: '/target', sessionState: null, signal })
}

describe('Codex harness settings normalization', () => {
  it.each([undefined, true, false])('rejects implicit default permission at execution with defaults=%s and probe=false', async useDefaultThreadSettings => {
    const probe = vi.fn(async () => false)
    const unavailable = createCodexSettingsApi({ load, probeAutoReview: probe, invalidate, adoptModels })
    const settings = unavailable.normalizeHarnessSettings({
      ...(useDefaultThreadSettings === undefined ? {} : { useDefaultThreadSettings }), threadSettings: {}
    })
    expect(settings.threadSettings).toEqual({})
    await expect(unavailable.resolveThreadSettings({ merged: unavailable.defaultThreadSettings(settings),
      cwd: '/target', sessionState: null, signal })).rejects.toThrow('auto_review')
    expect(probe).toHaveBeenCalledOnce()
    await expect(unavailable.resolveThreadSettings({ merged: {}, requested: { permissionMode: 'approve-for-me' },
      cwd: '/target', sessionState: null, signal })).rejects.toThrow('auto_review')
    await expect(unavailable.resolveThreadSettings({ merged: {}, requested: { permissionMode: 'ask-for-approval' },
      cwd: '/target', sessionState: null, signal })).resolves.toMatchObject({ approvalsReviewer: 'user' })
  })

  it('keeps the use-default Thread settings flag only when explicitly false', () => {
    expect(api.normalizeHarnessSettings({ useDefaultThreadSettings: false, threadSettings: {} }))
      .toStrictEqual({ useDefaultThreadSettings: false, threadSettings: {} })
    // Explicitly on matches the absent flag: no flag key is persisted.
    expect(api.normalizeHarnessSettings({ useDefaultThreadSettings: true, threadSettings: {} }))
      .toStrictEqual({ threadSettings: {} })
    // Stored values without the flag are dropped rather than blanked: the gate
    // is on, so the Agent's defaults win and hidden values must never execute.
    expect(api.normalizeHarnessSettings({ threadSettings: { model: 'model-a' } }))
      .toStrictEqual({ threadSettings: {} })
    expect(api.normalizeHarnessSettings({ threadSettings: {} }))
      .toStrictEqual({ threadSettings: {} })
    // The defaults resolver returns the same empty set, so a hidden value can
    // never reach execution.
    expect(api.defaultThreadSettings({ threadSettings: { model: 'model-a' } }))
      .toStrictEqual({})
  })

  it('keeps stored Thread defaults only while the gate is off', () => {
    expect(api.normalizeHarnessSettings({
      useDefaultThreadSettings: false,
      threadSettings: { model: 'model-a', effort: 'high' }
    })).toStrictEqual({
      useDefaultThreadSettings: false,
      threadSettings: { model: 'model-a', effort: 'high' }
    })
  })

  it('rejects a non-boolean use-default flag instead of treating it as the defaults state', () => {
    for (const useDefaultThreadSettings of ['false', null, 0, 1, {}]) {
      expect(() => api.normalizeHarnessSettings({
        useDefaultThreadSettings,
        threadSettings: {}
      } as never)).toThrow(/useDefaultThreadSettings/)
    }
  })

  it('rejects a Harness-level threadSettings executablePath', async () => {
    expect(() => api.normalizeHarnessSettings({
      threadSettings: { executablePath: '/opt/codex' }
    })).toThrow(/executablePath/)
    expect(() => api.defaultThreadSettings({
      threadSettings: { executablePath: '/opt/codex' }
    })).toThrow(/executablePath/)
    // A Thread-level pinned identity remains legitimate.
    await expect(api.resolveThreadSettings({
      merged: { executablePath: '/opt/codex', model: 'model-a' },
      requested: { model: 'model-a' },
      cwd: '/target',
      sessionState: null,
      signal
    })).resolves.toMatchObject({ executablePath: '/opt/codex', model: 'model-a' })
  })
})

describe('Codex creation options', () => {
  it('exposes only four optional fields through Core composition', async () => {
    const schema = await api.describe({ settings: { threadSettings: {} }, cwd: '/target', signal })
    expect(Object.keys(schema.properties!)).toEqual(['model', 'effort', 'serviceTier', 'permissionMode'])
    expect(schema.required).toBeUndefined()
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties).toMatchObject({ permissionMode: { enum: ['ask-for-approval', 'approve-for-me', 'full-access'] } })
    const composed = await describeThreadCreation({ composition: {
      codex: { id: 'codex', displayName: 'Codex', describe: async () => schema }
    }, targetHarnessIds: ['codex'], cwd: '/target', signal })
    expect(composed.inputSchema.oneOf).toMatchObject([{ properties: { options: schema } }])
  })

  it.each(['executablePath', 'personality', 'summary', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'sandboxPolicy', 'unknown'])(
    'rejects actual creation requests containing %s', async key => {
      await expect(resolve({ [key]: 'ignored' } as CodexThreadSettingsRequest)).rejects.toThrow(/未知字段/)
    })
  it.each(['untrusted', '', null, 1])('rejects invalid permissionMode %s', async permissionMode => {
    await expect(resolve({ permissionMode } as CodexThreadSettingsRequest)).rejects.toThrow(/permissionMode/)
  })

  it('inherits all application defaults for empty or omitted options', async () => {
    // A Harness on its Agent defaults persists no own keys.
    expect(api.defaultThreadSettings({ threadSettings: {} })).toEqual({})
    expect(api.defaultThreadSettings({
      useDefaultThreadSettings: false,
      threadSettings: { model: 'model-a' }
    })).toEqual({ model: 'model-a' })
    await expect(resolve()).resolves.toEqual(defaults)
    await expect(api.resolveThreadSettings({ merged: defaults, cwd: '/target', sessionState: null, signal })).resolves.toEqual(defaults)
    expect(load).toHaveBeenCalledWith({ cwd: '/target', executablePath: '/configured/codex', signal })
  })

  it('defaults to approve-for-me when no permission preset or native permission fields are configured', async () => {
    const base = { executablePath: '/configured/codex', model: 'model-a' }
    await expect(resolve({}, base)).resolves.toEqual({
      executablePath: '/configured/codex', model: 'model-a',
      sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review'
    })
  })

  it.each([
    ['ask-for-approval', 'workspace-write', 'on-request', 'user'],
    ['approve-for-me', 'workspace-write', 'on-request', 'auto_review'],
    ['full-access', 'danger-full-access', 'never', 'user']
  ] as const)('completely replaces permission defaults for %s', async (permissionMode, sandbox, approvalPolicy, approvalsReviewer) => {
    for (const base of [defaults, { ...defaults, sandboxPolicy: undefined, sandbox: 'danger-full-access' as const }]) {
      const result = await resolve({ permissionMode }, base)
      expect(result).toEqual({ executablePath: '/configured/codex', model: 'model-a', effort: 'high', serviceTier: 'priority',
        personality: 'friendly', summary: 'detailed', sandbox, approvalPolicy, approvalsReviewer, permissionMode })
    }
  })

  it('resolves permission presets from Thread defaults when the request omits permissionMode', async () => {
    const base = { executablePath: '/configured/codex', model: 'model-a', permissionMode: 'full-access' as const }
    await expect(resolve({}, base)).resolves.toEqual({
      executablePath: '/configured/codex',
      model: 'model-a',
      permissionMode: 'full-access',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    })
  })

  it('keeps model capability validation and clears model-associated defaults', async () => {
    await expect(resolve({ model: 'model-b' })).resolves.toMatchObject({ model: 'model-b' })
    const result = await resolve({ model: 'model-b' })
    expect(result).not.toHaveProperty('effort')
    expect(result).not.toHaveProperty('serviceTier')
    await expect(resolve({ model: 'missing' })).rejects.toThrow(/未知模型/)
    await expect(resolve({ model: 'model-b', effort: 'high' })).rejects.toThrow(/不支持 effort/)
    await expect(resolve({ model: 'model-b', serviceTier: 'priority' })).rejects.toThrow(/未报告 service tier/)
    await expect(resolve({ model: 'model-b', effort: 'low' })).resolves.toMatchObject({ effort: 'low' })
  })

  it('fails closed when the runtime does not report auto approval support', async () => {
    const unsupported = createCodexSettingsApi({ load, probeAutoReview: async () => false, invalidate, adoptModels })
    await expect(unsupported.resolveThreadSettings({ merged: {}, requested: { permissionMode: 'approve-for-me' },
      cwd: '/target', sessionState: null, signal })).rejects.toThrow(/自动审批不可用/)
    await expect(createCodexSettingsApi().resolveThreadSettings({ merged: {}, requested: { permissionMode: 'approve-for-me' },
      cwd: '/target', sessionState: null, signal })).rejects.toThrow(/自动审批不可用/)
  })

  it('retains the native reviewer when existing Thread settings are edited', async () => {
    await expect(api.applyThreadSettingsUpdate({ current: defaults, defaults: {}, update: { summary: 'concise' },
      hasContent: true, cwd: '/target', signal })).resolves.toMatchObject({ approvalsReviewer: 'auto_review', summary: 'concise' })
  })

  it('maps permissionMode updates onto the native preset triple and restores the default preset with null', async () => {
    const update = { current: defaults, defaults: {}, hasContent: true, cwd: '/target', signal }
    await expect(api.applyThreadSettingsUpdate({ ...update, update: { permissionMode: 'full-access' } })).resolves.toMatchObject({
      permissionMode: 'full-access', sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user'
    })
    const cleared = await api.applyThreadSettingsUpdate({ ...update, update: { permissionMode: null } })
    expect(cleared).not.toHaveProperty('permissionMode')
    expect(cleared).not.toHaveProperty('sandboxPolicy')
    expect(cleared).toMatchObject({
      sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review'
    })
  })

  it('probes only auto review when a permission-only update keeps a retired model', async () => {
    const retired = { executablePath: '/configured/codex', model: 'retired-model',
      sandbox: 'workspace-write' as const, approvalPolicy: 'on-request' as const, approvalsReviewer: 'user' as const }
    const update = { current: retired, defaults: {}, hasContent: true, cwd: '/target', signal }
    await expect(api.applyThreadSettingsUpdate({ ...update, update: { permissionMode: 'approve-for-me' } }))
      .resolves.toMatchObject({ model: 'retired-model', permissionMode: 'approve-for-me', approvalsReviewer: 'auto_review' })
    await expect(createCodexSettingsApi().applyThreadSettingsUpdate({ ...update, update: { permissionMode: 'approve-for-me' } }))
      .rejects.toThrow(/自动审批不可用/)
    await expect(createCodexSettingsApi({ load, probeAutoReview: async () => false, invalidate, adoptModels })
      .applyThreadSettingsUpdate({ ...update, update: { permissionMode: 'approve-for-me' } }))
      .rejects.toThrow(/自动审批不可用/)
  })

  it('asks a live runtime for the automatic reviewer, without waiting on the model catalog', async () => {
    const loads: Array<Record<string, unknown>> = []
    const probes: Array<Record<string, unknown>> = []
    const watched = createCodexSettingsApi({
      load: async (input) => { loads.push(input); return { models, computerUse: false } },
      probeAutoReview: async (input) => { probes.push(input); return true },
      invalidate,
      adoptModels
    })
    const retired = { executablePath: '/configured/codex', model: 'retired-model',
      sandbox: 'workspace-write' as const, approvalPolicy: 'on-request' as const, approvalsReviewer: 'user' as const }
    const update = { current: retired, defaults: {}, hasContent: true, cwd: '/target', signal }

    // A newly resolved Thread selecting approve-for-me turns the same capability
    // on: a cached answer could pass here and fail at the Thread's first turn.
    await expect(watched.resolveThreadSettings({
      merged: { executablePath: '/configured/codex', model: 'model-a' },
      requested: { permissionMode: 'approve-for-me' }, cwd: '/target', sessionState: null, signal
    })).resolves.toMatchObject({ approvalsReviewer: 'auto_review' })
    expect(probes).toEqual([{ cwd: '/target', executablePath: '/configured/codex', signal }])

    // A permission-only update is decided by that probe alone: the retired model
    // it keeps is not re-listed, so a slow model list cannot block the update.
    probes.length = 0
    loads.length = 0
    await watched.applyThreadSettingsUpdate({ ...update, update: { permissionMode: 'approve-for-me' } })
    expect(probes).toHaveLength(1)
    expect(loads).toHaveLength(0)

    // An update that does not touch the permission group asks nothing.
    probes.length = 0
    await watched.applyThreadSettingsUpdate({ ...update, update: { summary: 'concise' } })
    expect(probes).toHaveLength(0)

    probes.length = 0
    loads.length = 0
    await watched.applyThreadSettingsUpdate({ ...update, update: { model: 'model-b' } })
    expect(probes).toHaveLength(0)
    expect(loads).toEqual([{ cwd: '/target', executablePath: '/configured/codex', signal }])
  })

  it('drops a persisted preset when the native permission group is patched directly', async () => {
    const preset = { ...defaults, permissionMode: 'full-access' as const, sandboxPolicy: undefined, sandbox: 'danger-full-access' as const }
    const patched = await api.applyThreadSettingsUpdate({
      current: preset, defaults: {}, update: { sandbox: 'read-only' },
      hasContent: true, cwd: '/target', signal
    })
    expect(patched).not.toHaveProperty('permissionMode')
    expect(patched).toMatchObject({ sandbox: 'read-only' })
  })
})
