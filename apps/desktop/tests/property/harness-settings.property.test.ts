import fc from 'fast-check'
import { expect, it, vi } from 'vitest'
import type { HarnessPluginHostContext, JsonValue } from '@openagent/contracts'
import { createCodexSettingsApi } from '../../../../packages/harness-codex/src/main/settings'
import type {
  CodexCatalogSnapshot,
  CodexCatalogSource
} from '../../../../packages/harness-codex/src/main/catalog'
import type { CodexModelOption } from '../../../../packages/harness-codex/src/shared/types'
import { CODEX_PERMISSION_MODES } from '../../../../packages/harness-codex/src/shared/types'
import { createClaudeSettings } from '../../../../packages/harness-claude/src/main/settings'
import type { ClaudeCatalogSource } from '../../../../packages/harness-claude/src/main/catalog'
import { emptyClaudeThreadState } from '../../../../packages/harness-claude/src/shared/state'
import type {
  ClaudeModelPresentation,
  ClaudeSettingsPresentationData
} from '../../../../packages/harness-claude/src/shared/settings'
import { createPiSettings } from '../../../../packages/harness-pi/src/main/settings'
import { startPiRpc } from '../../../../packages/harness-pi/src/main/runtime/rpc.js'
import { checkAsync } from './check'

vi.mock('../../../../packages/harness-pi/src/main/runtime/rpc.js', () => ({ startPiRpc: vi.fn() }))

const timeout = process.env.FC_EXPLORE ? 130_000 : 35_000
const budget = process.env.FC_EXPLORE ? 120_000 : 30_000
// Every native boundary in this family is a test-owned mock, so these are pure
// in-memory properties and take the pure sample budget.
const samples = { normal: 100, explore: 1000 }
const cwd = '/property/workspace'
const signal = (): AbortSignal => new AbortController().signal

/** Native permission triples the public schema documents for each preset. */
const codexPresetTriple: Readonly<Record<(typeof CODEX_PERMISSION_MODES)[number],
  { sandbox: string; approvalPolicy: string; approvalsReviewer: string }>> = {
  'ask-for-approval': { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  'approve-for-me': { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
  'full-access': { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' }
}

function codexCatalog(models: readonly CodexModelOption[], autoReview?: boolean) {
  const load = vi.fn(async (): Promise<CodexCatalogSnapshot> => ({ models, computerUse: false }))
  const probeAutoReview = vi.fn(async () => autoReview === true)
  return { source: { load, probeAutoReview } as unknown as CodexCatalogSource, load }
}

function codexModels(values: readonly string[]): CodexModelOption[] {
  return values.map(value => ({
    value,
    displayName: value,
    supportedReasoningEfforts: ['low', 'high'].map(entry => ({ value: entry })),
    serviceTiers: ['priority', 'standard'].map(entry => ({ value: entry }))
  }))
}

const codexModelValues = ['alpha', 'beta'] as const
const codexEfforts = ['low', 'high'] as const
const codexTiers = ['priority', 'standard'] as const

it('Codex explicit model request never inherits an unbidden effort or service tier', async () => {
  await checkAsync('Codex explicit model request never inherits an unbidden effort or service tier', fc.asyncProperty(
    fc.record({
      mergedModel: fc.constantFrom(...codexModelValues),
      mergedEffort: fc.constantFrom(...codexEfforts),
      mergedTier: fc.constantFrom(...codexTiers),
      requestedModel: fc.constantFrom(...codexModelValues),
      requestedEffort: fc.option(fc.constantFrom(...codexEfforts), { nil: undefined }),
      requestedTier: fc.option(fc.constantFrom(...codexTiers), { nil: undefined })
    }),
    async ({ mergedModel, mergedEffort, mergedTier, requestedModel, requestedEffort, requestedTier }) => {
      const settings = createCodexSettingsApi(codexCatalog(codexModels(codexModelValues), true).source)
      const resolved = await settings.resolveThreadSettings({
        merged: { model: mergedModel, effort: mergedEffort, serviceTier: mergedTier },
        requested: {
          model: requestedModel,
          ...(requestedEffort === undefined ? {} : { effort: requestedEffort }),
          ...(requestedTier === undefined ? {} : { serviceTier: requestedTier })
        },
        sessionState: null, cwd, signal: signal()
      })
      // Model capabilities are per-model: an unrequested sibling must not survive.
      expect(resolved.model).toBe(requestedModel)
      expect(resolved.effort).toBe(requestedEffort)
      expect(resolved.serviceTier).toBe(requestedTier)
    }
  ), 'generated merged model/effort/serviceTier with an explicit model request naming neither or both siblings', budget, samples)
}, timeout)

it('Codex Thread updates never retain an unbidden effort or service tier across a model switch', async () => {
  await checkAsync('Codex Thread updates never retain an unbidden effort or service tier across a model switch', fc.asyncProperty(
    fc.record({
      currentModel: fc.constantFrom(...codexModelValues),
      currentEffort: fc.option(fc.constantFrom(...codexEfforts), { nil: undefined }),
      currentTier: fc.option(fc.constantFrom(...codexTiers), { nil: undefined }),
      updateModel: fc.option(fc.constantFrom(...codexModelValues), { nil: undefined }),
      updateEffort: fc.option(fc.constantFrom(...codexEfforts), { nil: undefined }),
      updateTier: fc.option(fc.constantFrom(...codexTiers), { nil: undefined })
    }),
    async ({ currentModel, currentEffort, currentTier, updateModel, updateEffort, updateTier }) => {
      const settings = createCodexSettingsApi(codexCatalog(codexModels(codexModelValues), true).source)
      const resolved = await settings.applyThreadSettingsUpdate({
        current: {
          model: currentModel,
          ...(currentEffort === undefined ? {} : { effort: currentEffort }),
          ...(currentTier === undefined ? {} : { serviceTier: currentTier })
        },
        defaults: {},
        update: {
          ...(updateModel === undefined ? {} : { model: updateModel }),
          ...(updateEffort === undefined ? {} : { effort: updateEffort }),
          ...(updateTier === undefined ? {} : { serviceTier: updateTier })
        } as never,
        hasContent: true, cwd, signal: signal()
      })
      const switched = updateModel !== undefined && updateModel !== currentModel
      // A named sibling is applied; otherwise the target model re-determines it,
      // so an unnamed one never rides along with a model switch.
      expect(resolved.model).toBe(updateModel ?? currentModel)
      expect(resolved.effort).toBe(updateEffort ?? (switched ? undefined : currentEffort))
      expect(resolved.serviceTier).toBe(updateTier ?? (switched ? undefined : currentTier))
    }
  ), 'generated current and updated model/effort/serviceTier; a model switch re-determines every sibling it does not name', budget, samples)
}, timeout)

it('Codex permission presets map to one native group and never degrade without auto review', async () => {
  await checkAsync('Codex permission presets map to one native group and never degrade without auto review', fc.asyncProperty(
    fc.record({
      mode: fc.constantFrom(...CODEX_PERMISSION_MODES),
      fromRequest: fc.boolean(),
      hasCatalog: fc.boolean(),
      autoReview: fc.constantFrom(true, false, undefined)
    }),
    async ({ mode, fromRequest, hasCatalog, autoReview }) => {
      const catalog = codexCatalog(codexModels(codexModelValues), autoReview)
      const settings = createCodexSettingsApi(hasCatalog ? catalog.source : undefined)
      const call = () => settings.resolveThreadSettings({
        merged: { model: 'alpha', ...(fromRequest ? {} : { permissionMode: mode }) },
        requested: { model: 'alpha', ...(fromRequest ? { permissionMode: mode } : {}) },
        sessionState: null, cwd, signal: signal()
      })
      const capabilityMissing = mode === 'approve-for-me' && !(hasCatalog && autoReview === true)
      if (capabilityMissing) {
        // Missing native auto-review rejects; it must not resolve a weaker preset.
        await expect(call()).rejects.toThrow()
        return
      }
      const resolved = await call()
      expect(resolved.permissionMode).toBe(mode)
      expect({
        sandbox: resolved.sandbox,
        approvalPolicy: resolved.approvalPolicy,
        approvalsReviewer: resolved.approvalsReviewer
      }).toEqual(codexPresetTriple[mode])
    }
  ), 'generated preset through either the request or merged defaults, with the auto-review capability present, absent or unknown', budget, samples)
}, timeout)

const claudeModels: ClaudeModelPresentation[] = [
  { value: 'opus', displayName: 'Opus', supportedEfforts: ['low', 'high'] },
  { value: 'sonnet', displayName: 'Sonnet', supportedEfforts: ['low', 'high'] }
]

function claudeCatalog() {
  const load = vi.fn(async (): Promise<ClaudeSettingsPresentationData> => ({
    cli: { status: 'available', executablePath: '/bin/claude' }, models: claudeModels
  }))
  return { source: { load } as unknown as ClaudeCatalogSource, load }
}

function claudePlugin(catalog: ReturnType<typeof claudeCatalog>) {
  return createClaudeSettings({
    resolveExecutable: async (_cwd, configured) => configured ?? '/bin/claude',
    environment: async () => ({})
  }, catalog.source)
}

const claudeTools = fc.array(fc.constantFrom('Bash', 'Read', 'Write'), { minLength: 1, maxLength: 3 })
  .map(values => [...new Set(values)])

it('Claude Threads with native content keep their fixed tool and goal configuration', async () => {
  await checkAsync('Claude Threads with native content keep their fixed tool and goal configuration', fc.asyncProperty(
    fc.record({
      field: fc.constantFrom('allowedTools', 'disallowedTools'),
      tools: claudeTools,
      goalMode: fc.boolean(),
      existingAllowed: fc.option(claudeTools, { nil: undefined }),
      existingDisallowed: fc.option(claudeTools, { nil: undefined })
    }),
    async ({ field, tools, goalMode, existingAllowed, existingDisallowed }) => {
      const { settings } = claudePlugin(claudeCatalog())
      const current = {
        executablePath: '/bin/claude',
        model: 'opus',
        goalMode: !goalMode,
        ...(existingAllowed === undefined ? {} : { allowedTools: existingAllowed }),
        ...(existingDisallowed === undefined ? {} : { disallowedTools: existingDisallowed })
      }
      const update = { [field]: tools } as never
      await expect(settings.applyThreadSettingsUpdate({
        current, defaults: { executablePath: '/bin/claude' }, update,
        hasContent: true, cwd, signal: signal()
      })).rejects.toThrow()
      const content = { ...emptyClaudeThreadState(), primarySessionId: 'native-session' } as unknown as JsonValue
      // The Host-default refresh carries fixed filters of its own. That is a
      // fact about the fixture, not about every sample: `claudeTools` can
      // generate exactly this pair, and for those samples the equalities below
      // cannot tell a session that kept its own filters from one that adopted
      // the refresh's. Wherever the two differ they can, and the recorded
      // mutation is detected from such a sample.
      const refresh = {
        executablePath: '/bin/claude', model: 'opus', goalMode: !goalMode,
        allowedTools: ['Write'], disallowedTools: ['Read']
      }
      await expect(settings.resolveThreadSettings({
        merged: { ...refresh, goalMode },
        existing: current, sessionState: content, cwd, signal: signal()
      })).rejects.toThrow()
      const resolved = await settings.resolveThreadSettings({
        merged: refresh, existing: current, sessionState: content, cwd, signal: signal()
      })
      expect(resolved.goalMode).toBe(!goalMode)
      // The session's own filters are what survives: a refresh may neither
      // replace them nor introduce one the native session never had.
      expect(resolved.allowedTools).toEqual(existingAllowed)
      expect(resolved.disallowedTools).toEqual(existingDisallowed)
    }
  ), 'generated tool-list update and goal-mode switch on a Thread that already owns native content, refreshed against a Host-default request carrying its own fixed filters', budget, samples)
}, timeout)

const piModels = [
  { provider: 'anthropic', id: 'reasoner', name: 'Reasoner', reasoning: true },
  { provider: 'openai', id: 'fast', name: 'Fast', reasoning: false }
] as const
const piLevels: Readonly<Record<string, readonly string[]>> = {
  reasoner: ['off', 'low', 'high'],
  fast: ['off']
}

/** Test-owned Pi RPC boundary; `startPiRpc` is module-mocked above. */
function piHarness(initial: { provider: string; id: string }) {
  const requests: Record<string, unknown>[] = []
  const dispose = vi.fn(async () => undefined)
  let selected = initial
  let abortAfterFirstQuery = false
  let controller: AbortController | undefined
  const request = vi.fn(async (command: Record<string, unknown>, rpcSignal?: AbortSignal) => {
    requests.push(structuredClone(command))
    if (abortAfterFirstQuery) {
      abortAfterFirstQuery = false
      controller?.abort()
      throw new DOMException('The operation was aborted', 'AbortError')
    }
    rpcSignal?.throwIfAborted()
    switch (command.type) {
      case 'get_available_models': return { models: [...piModels] }
      case 'get_state': return { model: selected, thinkingLevel: piLevels[selected.id]![0] }
      case 'get_available_thinking_levels': return { levels: [...piLevels[selected.id]!] }
      default: throw new Error(`Pi settings issued a non-query RPC: ${String(command.type)}`)
    }
  })
  vi.mocked(startPiRpc).mockImplementation(async options => {
    const providerIndex = options.args.indexOf('--provider')
    const modelIndex = options.args.indexOf('--model')
    selected = piModels.find(entry =>
      (providerIndex < 0 || entry.provider === options.args[providerIndex + 1]) &&
      (modelIndex < 0 || entry.id === options.args[modelIndex + 1])) ?? piModels[0]
    return { request, dispose, version: '1.0.0' } as unknown as Awaited<ReturnType<typeof startPiRpc>>
  })
  const host = {
    resolveExecutable: vi.fn(async (_command: string, _cwd: string, configured?: string) =>
      configured ?? '/bin/pi'),
    environment: vi.fn(async () => ({})),
    harnessDataRoot: '/data/pi',
    temporaryWorkspaceRoot: '/tmp/pi'
  } as unknown as HarnessPluginHostContext
  return {
    ...createPiSettings(host), requests, dispose,
    start: vi.mocked(startPiRpc),
    abortDuringFirstQuery(signal: AbortController) {
      abortAfterFirstQuery = true
      controller = signal
    }
  }
}

it('Pi settings release every query RPC they acquire', async () => {
  await checkAsync('Pi settings release every query RPC they acquire', fc.asyncProperty(
    fc.record({
      provider: fc.option(fc.constantFrom('anthropic', 'openai', 'missing'), { nil: undefined }),
      model: fc.option(fc.constantFrom('reasoner', 'fast', 'missing'), { nil: undefined }),
      outcome: fc.constantFrom('complete', 'cancel-during-query')
    }),
    async ({ provider, model, outcome }) => {
      const pi = piHarness({ provider: 'anthropic', id: 'reasoner' })
      const controller = new AbortController()
      if (outcome === 'cancel-during-query') pi.abortDuringFirstQuery(controller)
      const requested = {
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model })
      }
      // Independent oracle: Pi receives provider/model as session-local CLI
      // arguments, an unrequested field falls back to what that launch selected,
      // and the selection resolves only when the catalog holds exactly one match.
      const argvSelected = piModels.find(entry =>
        (provider === undefined || entry.provider === provider) &&
        (model === undefined || entry.id === model)) ?? piModels[0]!
      const effectiveProvider = provider ?? argvSelected.provider
      const effectiveModel = model ?? argvSelected.id
      const matches = piModels.filter(entry =>
        entry.provider === effectiveProvider && entry.id === effectiveModel)
      try {
        const result = pi.settings.resolveThreadSettings({
          merged: {}, requested, sessionState: null, cwd, signal: controller.signal
        })
        if (outcome !== 'complete' || matches.length !== 1) {
          await expect(result).rejects.toThrow()
        } else {
          const resolved = await result
          // Querying native state never writes a Pi global default: every issued
          // RPC is a read, and the level comes from the target catalog, not a setter.
          expect(resolved.provider).toBe(matches[0]!.provider)
          expect(resolved.model).toBe(matches[0]!.id)
          expect(piLevels[resolved.model!]).toContain(resolved.thinkingLevel)
        }
        expect(pi.requests.every(command => String(command.type).startsWith('get_'))).toBe(true)
        expect(pi.start).toHaveBeenCalledWith(expect.objectContaining({
          cwd,
          args: expect.arrayContaining(['--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates'])
        }))
        // Success, catalog rejection and cancellation all release the same RPC.
        expect(pi.dispose).toHaveBeenCalledTimes(1)
      } finally { vi.mocked(startPiRpc).mockReset() }
    }
  ), 'generated provider/model resolution ending in catalog completion, an unknown selection or a cancellation after acquisition', budget, samples)
}, timeout)

it('Pi provider and model switches re-determine an unrequested thinking level', async () => {
  await checkAsync('Pi provider and model switches re-determine an unrequested thinking level', fc.asyncProperty(
    fc.record({
      current: fc.constantFrom('anthropic/reasoner', 'openai/fast'),
      requested: fc.constantFrom('anthropic/reasoner', 'openai/fast'),
      // Any level the current model supports, including one the target does not:
      // that is exactly the stale level a switch must not carry across.
      carriedLevel: fc.constantFrom(...Object.values(piLevels).flat()),
      requestedLevel: fc.option(fc.constantFrom('off', 'low', 'high'), { nil: undefined })
    }),
    async ({ current, requested, carriedLevel, requestedLevel }) => {
      const [currentProvider, currentModel] = current.split('/') as [string, string]
      const [provider, model] = requested.split('/') as [string, string]
      const pi = piHarness({ provider: currentProvider, id: currentModel })
      const currentLevel = piLevels[currentModel]!.includes(carriedLevel)
        ? carriedLevel
        : piLevels[currentModel]![0]!
      const update = {
        provider, model,
        ...(requestedLevel === undefined ? {} : { thinkingLevel: requestedLevel })
      }
      const call = () => pi.settings.applyThreadSettingsUpdate({
        current: { provider: currentProvider, model: currentModel, thinkingLevel: currentLevel },
        defaults: {}, hasContent: true, update: update as never, cwd, signal: signal()
      })
      try {
        const levelSupported = requestedLevel === undefined || piLevels[model]!.includes(requestedLevel)
        if (!levelSupported) {
          await expect(call()).rejects.toThrow()
          return
        }
        const resolved = await call()
        expect(resolved.provider).toBe(provider)
        expect(resolved.model).toBe(model)
        // The previous model's level is never carried onto a different model.
        if (requestedLevel !== undefined) expect(resolved.thinkingLevel).toBe(requestedLevel)
        else expect(piLevels[model]).toContain(resolved.thinkingLevel)
        if (requested !== current && requestedLevel === undefined) {
          const carried = piLevels[currentModel]!.filter(entry => !piLevels[model]!.includes(entry))
          for (const level of carried) expect(resolved.thinkingLevel).not.toBe(level)
        }
      } finally { vi.mocked(startPiRpc).mockReset() }
    }
  ), 'generated provider/model switch with an optional explicit thinking level; an unsupported level is rejected by the target catalog', budget, samples)
}, timeout)
