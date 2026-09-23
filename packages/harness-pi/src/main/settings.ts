import { piBackend } from './backend.js'
import { HarnessExecutableNotFoundError, type HarnessAvailabilityProbe, type HarnessInstallation, type HarnessPluginHostContext, type HarnessSettingsApi, type HarnessSettingsPresentationSource, type JsonObject } from '@openagent/contracts'
import type { PiHarnessSettings, PiModel, PiSettingsPresentation, PiThreadSettings, PiThreadSettingsUpdate } from '../shared/types.js'
import { retirePiVersions, startPiRpc, type PiRpc } from './runtime/rpc.js'
import { piModelArguments } from './runtime/model-options.js'
import { piEnvironment, piProviderSettings } from './runtime/provider-injection.js'

const keys = ['provider', 'model', 'thinkingLevel'] as const
const internalKeys = ['executablePath', ...keys] as const
const discoveryArgs = ['--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates']
/**
 * Pi answers discovery questions in milliseconds; the session that carries them
 * costs most of a second to boot. Availability, resolve and the settings page
 * ask about the same configuration during successive Bart turns. Keep a
 * complete, usable discovery for the native catalog's five-minute window;
 * partial or unavailable observations only share a short retry window.
 */
const stateObservationTtlMs = 15_000
const discoveryTtlMs = 5 * 60 * 1_000
type SettingsApi = HarnessSettingsApi<PiHarnessSettings, PiThreadSettings, PiThreadSettingsUpdate, PiThreadSettingsUpdate, PiThreadSettings>

/** Native facts for one (executable, cwd, provider/model/thinking) configuration. */
interface PiObservation {
  backend: import('@openagent/contracts').HarnessBackend
  executablePath: string
  version?: string
  provider?: string
  model?: string
  thinkingLevel?: string
  /** Absent when catalog discovery failed; availability answers without it. */
  discovery?: { models: PiModel[]; levels: string[] }
  discoveryError?: string
}

export function createPiSettings(host: HarnessPluginHostContext): {
  settings: SettingsApi
  evaluationIdentities(settings: PiHarnessSettings, cwd: string, signal: AbortSignal): Promise<{ selector: string; displayName: string }[]>
  backend(settings: PiHarnessSettings, cwd: string, signal: AbortSignal): Promise<import('@openagent/contracts').HarnessBackend>
  settingsPresentation: HarnessSettingsPresentationSource<PiHarnessSettings, PiSettingsPresentation>
  availability: HarnessAvailabilityProbe<PiHarnessSettings>
  detectInstallation(input: { cwd: string; signal: AbortSignal }): Promise<HarnessInstallation>
} {
  async function withRpc<T>(settings: PiThreadSettings, cwd: string, signal: AbortSignal, fn: (rpc: PiRpc, executablePath: string, signal: AbortSignal) => Promise<T>, refresh = false): Promise<T> {
    signal.throwIfAborted()
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    // Retired before the two steps that can fail: both name the configuration
    // the memo is keyed by, so a refresh that dies resolving the executable or
    // reading the environment would otherwise leave the gate answering from the
    // installation as it was.
    if (refresh) retirePiVersions()
    const executablePath = await host.resolveExecutable('pi', cwd, settings.executablePath)
    bounded.throwIfAborted()
    const env = await piEnvironment(host)
    bounded.throwIfAborted()
    let rpc: PiRpc
    try { rpc = await startPiRpc({ executablePath, cwd, env, args: [...discoveryArgs, ...piModelArguments(piProviderSettings(settings, host.providers?.explicit?.injection))], signal: bounded }) }
    catch (error) {
      bounded.throwIfAborted()
      throw new Error(`${message(error)}. Check the Pi executable and exact provider/model/thinking settings; run pi /login to configure authentication.`)
    }
    try { return await fn(rpc, executablePath, bounded) } finally { await rpc.dispose() }
  }
  const observations = new Map<string, { at: number; value: PiObservation }>()
  // The newest observation that has begun for a key. Two callers that overlap on
  // the same configuration talk to two native sessions, and neither boot order
  // nor completion order says which one saw the current account: only the
  // request that started last may decide what the window remembers, or a slower
  // earlier session puts the previous native state back.
  const started = new Map<string, number>()
  let sequence = 0

  function invalidateObservations(): void {
    observations.clear()
    // A foreground refresh can use a different cwd than Bart. Retire every
    // in-flight publisher too, including keys the refresh never reads itself.
    started.clear()
  }

  function observationKey(settings: PiThreadSettings, cwd: string): string {
    return [settings.executablePath ?? '', settings.provider ?? '', settings.model ?? '', settings.thinkingLevel ?? '', cwd].join('\0')
  }

  async function observe(settings: PiThreadSettings, cwd: string, signal: AbortSignal, needCatalog: boolean, refresh = false): Promise<PiObservation> {
    // A hit answers as promptly as a miss, so a cancelled caller has to be
    // turned away here too: whatever populated the cache must not decide
    // whether an abandoned request aborts.
    signal.throwIfAborted()
    const key = observationKey(settings, cwd)
    const request = ++sequence
    if (refresh) {
      // The reader asked for the account as it is now — after pi /login, say —
      // and this session may fail before it learns any of it. Retire the
      // observation up front so a broken refresh leaves the next read probing
      // instead of replaying the state it set out to replace.
      invalidateObservations()
    }
    const cached = refresh ? undefined : observations.get(key)
    const ttl = cached && reusableDiscovery(settings, cached.value) ? discoveryTtlMs : stateObservationTtlMs
    if (cached && Date.now() - cached.at < ttl && (!needCatalog || cached.value.discovery)) return cached.value
    // Only a caller about to talk to the native session can decide what the
    // window remembers. The hit above answers from what is already there and
    // writes nothing, so counting it as the newest request would make a probe
    // that does carry the catalog fail its own write, and the next reader would
    // boot the session this cache exists to avoid.
    started.set(key, request)
    const value = await withRpc(settings, cwd, signal, async (rpc, executablePath, bounded) => {
      const state = await rpc.request({ type: 'get_state' }, bounded)
      const nativeModel = record(state.model) ? state.model : undefined
      const observation: PiObservation = {
        backend: await piBackend(host, nativeModel ?? {}),
        executablePath,
        ...(rpc.version ? { version: rpc.version } : {}),
        ...(typeof nativeModel?.provider === 'string' ? { provider: nativeModel.provider } : {}),
        ...(typeof nativeModel?.id === 'string' ? { model: nativeModel.id } : {}),
        ...(typeof state.thinkingLevel === 'string' ? { thinkingLevel: state.thinkingLevel } : {})
      }
      // Catalog discovery stays a separate concern: availability answers from
      // native state alone, so a caller that does not ask for the listing
      // neither waits for it nor fails with it. What came back is remembered
      // for the callers that do ask.
      if (needCatalog) {
        try {
          observation.discovery = { models: await availableModels(rpc, bounded), levels: await thinkingLevels(rpc, bounded) }
        } catch (error) {
          bounded.throwIfAborted()
          observation.discoveryError = message(error)
        }
      }
      return observation
    }, refresh)
    if (started.get(key) === request) observations.set(key, { at: Date.now(), value })
    return value
  }

  async function resolve(next: PiThreadSettings, cwd: string, signal: AbortSignal): Promise<PiThreadSettings> {
    next = piProviderSettings(next, host.providers?.explicit?.injection)
    const observed = await observe(next, cwd, signal, true)
    const discovery = observed.discovery
    if (!discovery) throw new Error(observed.discoveryError ?? 'Pi returned no model catalog')
    const { models, levels } = discovery
    const provider = next.provider ?? observed.provider
    const model = next.model ?? observed.model
    const matches = models.filter(entry => (!provider || entry.provider === provider) && (!model || entry.id === model))
    if (matches.length !== 1) throw new Error('Pi provider/model is unavailable or ambiguous. Configure authentication with pi /login and select an available provider and model.')
    const selected = matches[0]!
    // Pi silently substitutes an unknown id under a known provider, so the
    // native selection must be checked rather than assumed from the arguments.
    if (observed.provider !== selected.provider || observed.model !== selected.id) throw new Error('Pi did not select the requested model; specify an exact provider/model pair')
    if (next.thinkingLevel !== undefined && !levels.includes(next.thinkingLevel)) throw new Error(`Pi thinkingLevel ${next.thinkingLevel} is unsupported by ${selected.provider}/${selected.id}`)
    const thinkingLevel = next.thinkingLevel ?? (observed.thinkingLevel && levels.includes(observed.thinkingLevel) ? observed.thinkingLevel : levels[0])
    if (!thinkingLevel) throw new Error('Pi returned no supported thinking levels')
    return { executablePath: observed.executablePath, provider: selected.provider, model: selected.id, thinkingLevel }
  }
  function defaults(raw: PiHarnessSettings): PiThreadSettings {
    return piProviderSettings(normalizeHarnessSettings(raw).threadSettings, host.providers?.explicit?.injection)
  }
  const settings: SettingsApi = {
    normalizeHarnessSettings,
    defaultThreadSettings: defaults,
    async describe(input) {
      const presentation = await settingsPresentation.load(input)
      const property = (description: string, examples: string[], maxLength = 256): JsonObject => ({ type: ['string', 'null'], minLength: 1, maxLength, description, ...(examples.length ? { examples: [...new Set(examples)] } : {}) })
      return { type: 'object', additionalProperties: false, description: 'Pi native settings. Examples are scoped to this executable and workspace; the target environment validates provider, model and thinking support. Null clears a selection.', properties: {
        provider: property('Authenticated provider identifier in the target environment.', presentation.models.map(model => model.provider)),
        model: property('Exact model identifier for the selected provider.', presentation.models.map(model => model.id)),
        thinkingLevel: property('Thinking level supported by the selected model. Changing model clears inherited thinking.', presentation.models.flatMap(model => model.thinkingLevels ?? []), 64)
      } }
    },
    async resolveThreadSettings(input) {
      // Validate the public request before reading the Core-composed defaults/request.
      const requested = normalizeUpdate(input.requested ?? {})
      assertRecord(input.merged)
      const hasContent = hasThreadContent(input.sessionState)
      const { executablePath, ...options } = input.merged
      // Harness-level settings cannot pin the binary, so a Core-composed request
      // never names one. A Thread with history is stuck with the binary its
      // native session came from: inherit that path rather than read the absent
      // request path as a change it never made.
      const path = identifier(executablePath, 'executablePath') ??
        (hasContent ? identifier(input.existing?.executablePath, 'executablePath') : undefined)
      const merged = apply(path ? { executablePath: path } : {}, normalizeUpdate(options))
      const next = apply(merged, requested)
      if (hasContent) assertExecutable(input.existing, next)
      const result = await resolve(next, input.cwd, input.signal)
      if (hasContent) assertExecutable(input.existing, result)
      return result
    },
    hasThreadContent,
    async applyThreadSettingsUpdate(input) {
      const current = normalizeThread(input.current)
      const next = apply(current, normalizeUpdate(input.update))
      if (input.hasContent) assertExecutable(current, next)
      const result = await resolve(next, input.cwd, input.signal)
      if (input.hasContent) assertExecutable(current, result)
      return result
    },
    promptSettings(raw, source) { return source ? normalizeThread(source) : defaults(raw) }
  }
  const settingsPresentation: HarnessSettingsPresentationSource<PiHarnessSettings, PiSettingsPresentation> = {
    async load(input) {
      const selected = input.thread ? normalizeThread(input.thread.settings) : defaults(input.settings)
      try {
        const observed = await observe(selected, input.cwd, input.signal, true, input.refresh === true)
        const discovery = observed.discovery
        if (!discovery) throw new Error(observed.discoveryError ?? 'Pi returned no model catalog')
        // The shared observation is never mutated: only the selected row carries
        // the levels that actually came back from the native session.
        const models = discovery.models.map(model =>
          model.provider === observed.provider && model.id === observed.model ? { ...model, thinkingLevels: [...discovery.levels] } : model)
        return {
          cli: { status: 'ready' as const, executablePath: observed.executablePath, ...(observed.version ? { version: observed.version } : {}) },
          models
        }
      } catch (error) {
        input.signal.throwIfAborted()
        return { cli: { status: 'unavailable', message: message(error) }, models: [] }
      }
    }
  }
  return {
    settings, settingsPresentation,
    async evaluationIdentities(settings, cwd, signal) {
      const observed = await observe(defaults(settings), cwd, signal, true)
      return (observed.discovery?.models ?? []).filter(model => model.provider === observed.provider)
        .map(model => ({ selector: model.id, displayName: model.name }))
    },
    async backend(settings, cwd, signal) {
      if (host.providers?.explicit) return host.providers.explicit
      try { return (await observe(defaults(settings), cwd, signal, false)).backend }
      catch { signal.throwIfAborted(); return { kind: 'unknown' } }
    },
    // Pi proves availability by applying a configuration, not by existing on
    // disk, so the probe keeps its native session and shares the observation
    // the following resolve would otherwise boot its own session for. The
    // catalog is not required: a failed listing must not fail the probe.
    availability: { async probe(input) {
      try {
        const selected = defaults(input.settings)
        const observed = await observe(selected, input.cwd, input.signal, false)
        if (!observed.model) return { available: false, reason: 'Pi has no configured model. Run pi /login to configure authentication.' }
        if ((selected.provider && observed.provider !== selected.provider) || (selected.model && observed.model !== selected.model) || (selected.thinkingLevel && observed.thinkingLevel !== selected.thinkingLevel)) {
          return { available: false, reason: 'Pi could not apply the selected provider/model/thinking configuration. Select exact native values in settings.' }
        }
        return { available: true }
      } catch (error) { input.signal.throwIfAborted(); return { available: false, reason: message(error) } }
    } },
    async detectInstallation(input) {
      input.signal.throwIfAborted()
      invalidateObservations()
      retirePiVersions()
      try {
        const executablePath = await host.resolveExecutable('pi', input.cwd)
        input.signal.throwIfAborted()
        return { status: 'installed', executablePath }
      } catch (error) {
        input.signal.throwIfAborted()
        if (error instanceof HarnessExecutableNotFoundError) return { status: 'missing' }
        throw error
      }
    }
  }
}

function reusableDiscovery(settings: PiThreadSettings, observation: PiObservation): boolean {
  const { discovery, provider, model, thinkingLevel } = observation
  return discovery !== undefined &&
    discovery.models.some(entry => entry.provider === provider && entry.id === model) &&
    thinkingLevel !== undefined && discovery.levels.includes(thinkingLevel) &&
    (settings.provider === undefined || settings.provider === provider) &&
    (settings.model === undefined || settings.model === model) &&
    (settings.thinkingLevel === undefined || settings.thinkingLevel === thinkingLevel)
}

function normalizeHarnessSettings(value: PiHarnessSettings): PiHarnessSettings {
  assertRecord(value)
  assertKeys(value, ['threadSettings', 'useDefaultThreadSettings'])
  const flag = value.useDefaultThreadSettings
  if (flag !== undefined && typeof flag !== 'boolean') throw new Error('Pi useDefaultThreadSettings must be a boolean')
  // The gate is canonical: unless the user opted out, a Harness on its Agent
  // defaults owns no Thread keys even if a stale payload still carries them.
  const threadSettings = normalizeThread(value.threadSettings === undefined ? {} : value.threadSettings, keys)
  return flag === false ? { threadSettings, useDefaultThreadSettings: false } : { threadSettings: {} }
}
function normalizeThread(value: unknown, allowed: readonly string[] = internalKeys): PiThreadSettings {
  assertRecord(value); assertKeys(value, allowed)
  const result: PiThreadSettings = {}
  for (const key of internalKeys) { const field = identifier(value[key], key); if (field !== undefined) result[key] = field }
  return result
}
function normalizeUpdate(value: unknown): PiThreadSettingsUpdate {
  assertRecord(value); assertKeys(value, keys)
  const result: PiThreadSettingsUpdate = {}
  for (const key of keys) if (Object.hasOwn(value, key)) result[key] = value[key] === null ? null : identifier(value[key], key)
  return result
}
function apply(current: PiThreadSettings, update: PiThreadSettingsUpdate): PiThreadSettings {
  const result = { ...current }
  if ((Object.hasOwn(update, 'model') || Object.hasOwn(update, 'provider')) && !Object.hasOwn(update, 'thinkingLevel')) delete result.thinkingLevel
  for (const key of keys) if (Object.hasOwn(update, key)) { if (update[key] == null) delete result[key]; else result[key] = update[key] }
  return result
}
function hasThreadContent(value: unknown): boolean {
  return record(value) && (typeof value.sessionFile === 'string' || typeof value.nativeSessionJsonl === 'string' || record(value.forkSource) || Array.isArray(value.messages) && value.messages.length > 0 || Array.isArray(value.executions) && value.executions.length > 0)
}
function assertExecutable(existing: Readonly<PiThreadSettings> | undefined, next: PiThreadSettings): void {
  if (existing?.executablePath !== undefined && existing.executablePath !== next.executablePath) throw new Error('Pi executablePath cannot change after Thread history exists')
}
async function availableModels(rpc: PiRpc, signal: AbortSignal): Promise<PiModel[]> {
  const data = await rpc.request({ type: 'get_available_models' }, signal)
  if (!Array.isArray(data.models)) throw new Error('Pi returned an invalid model catalog')
  return data.models.map((value: unknown) => {
    if (!record(value) || typeof value.provider !== 'string' || typeof value.id !== 'string') throw new Error('Pi returned an invalid model')
    return { provider: value.provider, id: value.id, name: typeof value.name === 'string' ? value.name : value.id, reasoning: value.reasoning === true }
  })
}
async function thinkingLevels(rpc: PiRpc, signal: AbortSignal): Promise<string[]> {
  const data = await rpc.request({ type: 'get_available_thinking_levels' }, signal)
  if (!Array.isArray(data.levels) || !data.levels.every((value: unknown) => typeof value === 'string')) throw new Error('Pi returned invalid thinking levels')
  return data.levels as string[]
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function assertRecord(value: unknown): asserts value is Record<string, unknown> { if (!record(value)) throw new Error('Pi settings must be an object') }
function assertKeys(value: object, allowed: readonly string[]): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Pi settings contain unknown field: ${key}`) }
function identifier(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0') || value.length > (key === 'executablePath' ? 4096 : key === 'thinkingLevel' ? 64 : 256)) throw new Error(`Pi ${key} must be a nonempty canonical string`)
  return value
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
