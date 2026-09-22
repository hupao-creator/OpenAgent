import type { HarnessBartActivity } from '@openagent/contracts/renderer'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ProviderConnections } from '@openagent/plugin-kit/main'
import type {
  ErasedHarnessMainPluginModule,
  HarnessAvailability,
  HarnessAvailabilityProbe,
  HarnessPluginHostContext
} from '@openagent/contracts'
import type { AgentInput } from '@openagent/contracts'
import {
  isJsonObject,
  isJsonValue,
  parseThreadPublicObservation,
  PublicExecutionSchema,
  type JsonObject,
  type JsonValue
} from '@openagent/contracts'
import type {
  AgentThreadRecord,
  BartContextContributor,
  BartContextEntryId,
  DeepReadonly,
  HarnessThreadInjection,
  HarnessThreadRecord,
  HarnessThreadCapabilities,
  HarnessInstallation,
  HarnessMainPlugin,
  HarnessPromptCompleteRequest,
  HarnessPromptCompleteResult,
  HarnessRespondRequest,
  HarnessThreadRef,
  HarnessThreadForkResult,
  ThreadPublicObservation,
  PublicExecution
} from '@openagent/contracts'
import { harnessMainPluginModules } from '../generated/harness-registry.main'
import type { HarnessPluginDescriptor } from '@openagent/contracts'
import type { OpenAgentSettings } from '../shared/openagent-settings'
import type { ManagedWorkspaceWriteCapability } from '@openagent/contracts'
import type { BartTelemetryLedgerCapability } from '@openagent/contracts'
import {
  ThreadSettingsRefreshUnavailableError,
  type ThreadSettingsDescriptionSource
} from './bart-v1'
import {
  HarnessThreadInstance,
  type ActiveThreadExecution,
  type HarnessThreadCommitted,
  type ThreadForkReservation,
  type ThreadSendAdmitted,
  type ThreadSendResult
} from './harness-thread-runtime'
import type { CliResolver } from './services/cli-resolver'
import type { ThreadStateStore } from './services/thread-state-store'
import type {
  ManagedWorktreeAuthorizationRequest
} from './services/worktree-manager'
import {
  createDebugTrace,
  debugDetail,
  debugError,
  getDebugContext,
  startDebugSpan,
  withDebugContext
} from '@openagent/plugin-kit/main'

type DebugContext = ReturnType<typeof createDebugTrace>

type ManagedWorkspaceWriteAuthorizer = (
  request: ManagedWorktreeAuthorizationRequest
) => ReturnType<ManagedWorkspaceWriteCapability['grant']>

export interface MainHarnessCompositionContext {
  readonly providerConnections?: ProviderConnections
  readonly providerBindings?: Readonly<Record<string, string>>
  readonly resolver: CliResolver
  readonly harnessDataRoot: string
  readonly temporaryWorkspaceRoot: string
  readonly authorizeManagedWorkspaceWrite: ManagedWorkspaceWriteAuthorizer
  /** Preloaded Core-owned scopes. Plugins never choose or observe the scope id. */
  readonly telemetryLedgerFor?: (
    harnessId: string
  ) => BartTelemetryLedgerCapability & {
    flush?(): Promise<void>
    dispose?(): Promise<void>
  }
}

/** Provider-neutral availability fact produced only at the composition root. */
export type { HarnessAvailability } from '@openagent/contracts'

export interface HarnessThreadInstanceView {
  readonly execution: DeepReadonly<ActiveThreadExecution> | null
  readonly observation: DeepReadonly<ThreadPublicObservation>
  reserveFork(): ThreadForkReservation
  send(
    input: AgentInput,
    signal: AbortSignal,
    contextEntries?: readonly {
      readonly id: string
      readonly content: string
    }[],
    onAdmitted?: ThreadSendAdmitted
  ): Promise<ThreadSendResult>
  interrupt(expectedExecutionId?: string | null): Promise<void>
  respond(response: HarnessRespondRequest): Promise<void>
  read(question: string, signal: AbortSignal): Promise<string>
  dispose(): Promise<void>
}

interface OpenThreadInput {
  readonly injection?: HarnessThreadInjection
  readonly store: ThreadStateStore
  readonly threadId: string
  readonly createExecutionId: () => string
  readonly now: () => number
  readonly signal: AbortSignal
  /** Core-owned, Thread-bound authorization before claimed native work. */
  readonly admitNativeExecution?: (signal: AbortSignal) => Promise<void>
  readonly publishBartActivity?: (activity: HarnessBartActivity) => void
  readonly committed: (change: HarnessThreadCommitted) => void
}

export interface ResolvedHarnessTarget {
  readonly harnessId: string
  readonly threadSettings: JsonValue
  readonly acknowledgement: JsonValue
}

/**
 * Type-erased only at the registry aggregation boundary. Each binding captures
 * one fully typed Main Plugin; Core never handles native
 * settings or state and never branches on a concrete Harness.
 */
export interface MainHarnessBinding {
  readonly id: string
  readonly displayName: string
  readonly threadCapabilities: HarnessThreadCapabilities
  detectInstallation(
    cwd: string,
    signal: AbortSignal
  ): Promise<HarnessInstallation>
  install(signal: AbortSignal): Promise<void>
  contextEntries(
    settings: OpenAgentSettings,
    cwd: string
  ): Partial<Record<BartContextEntryId, BartContextContributor>>
  normalizeSettings(settings: OpenAgentSettings): OpenAgentSettings
  loadSettingsPresentation(
    settings: OpenAgentSettings,
    cwd: string,
    signal: AbortSignal,
    thread?: {
      readonly settings: DeepReadonly<JsonValue>
    },
    refresh?: boolean
  ): Promise<JsonValue>
  availability(
    settings: OpenAgentSettings,
    cwd: string,
    signal: AbortSignal
  ): Promise<HarnessAvailability>
  invokeExtension(
    method: string,
    payload: JsonValue,
    signal: AbortSignal
  ): Promise<JsonValue>
  forkThread(
    source: DeepReadonly<AgentThreadRecord>,
    request: JsonValue,
    signal: AbortSignal
  ): Promise<HarnessThreadForkResult<JsonValue> & {
    readonly observation: ThreadPublicObservation
  }>
  dispose(): Promise<void>
  openThread(input: OpenThreadInput): Promise<HarnessThreadInstanceView>
  resolveThreadSettings(input: {
    readonly settings: OpenAgentSettings
    readonly cwd: string
    readonly signal: AbortSignal
    readonly current?: DeepReadonly<HarnessThreadRecord>
    readonly requested?: JsonObject
  }): Promise<JsonValue>
  settingsDescription(settings: OpenAgentSettings): ThreadSettingsDescriptionSource<string>
  completePrompt(
    settings: OpenAgentSettings,
    request: HarnessPromptCompleteRequest<never>,
    sourceThread?: DeepReadonly<AgentThreadRecord>
  ): Promise<HarnessPromptCompleteResult>
  resolveExecution(sessionState: DeepReadonly<JsonValue>, executionId: string): PublicExecution | null
  hasThreadContent(sessionState: DeepReadonly<JsonValue>): boolean
  applyThreadSettingsUpdate(input: {
    readonly settings: OpenAgentSettings
    readonly current: DeepReadonly<AgentThreadRecord>
    readonly change: JsonObject
    readonly signal: AbortSignal
  }): Promise<JsonValue>
}

/**
 * The only Main-process Harness composition. Adding a Harness means adding its
 * module package to the Host dependency set and regenerating the registry;
 * Service remains provider-blind.
 */
export function createMainHarnessComposition(
  context: MainHarnessCompositionContext
): MainHarnessComposition {
  const { resolver } = context
  const composition = bindMainHarnessComposition(harnessMainPluginModules, {
    hostContextFor: (id): HarnessPluginHostContext => ({
      resolveExecutable: (command, cwd, configuredPath) =>
        resolver.resolve(command, configuredPath, cwd),
      environment: () => resolver.environment(),
      harnessDataRoot: join(context.harnessDataRoot, id),
      temporaryWorkspaceRoot: context.temporaryWorkspaceRoot
    }),
    telemetryLedgerFor: context.telemetryLedgerFor,
    providerConnections: context.providerConnections,
    providerBindings: context.providerBindings,
    authorizeManagedWorkspaceWrite: context.authorizeManagedWorkspaceWrite
  })
  for (const binding of Object.values(composition)) {
    const detect = binding.detectInstallation.bind(binding)
    binding.detectInstallation = async (cwd, signal) => {
      await resolver.refreshEnvironment()
      signal.throwIfAborted()
      return detect(cwd, signal)
    }
  }
  return composition
}

/**
 * The composition is keyed by the generated Harness registry rather than a
 * closed union: bindings appear exactly where a module registered its id.
 */
export type MainHarnessComposition = Readonly<Record<string, MainHarnessBinding>>

export interface MainHarnessCompositionDeps {
  readonly providerConnections?: ProviderConnections
  readonly providerBindings?: Readonly<Record<string, string>>
  /** Host context derived per module id; the module factory never picks another module's root. */
  readonly hostContextFor?: (id: string) => HarnessPluginHostContext
  readonly telemetryLedgerFor?: MainHarnessCompositionContext['telemetryLedgerFor']
  readonly authorizeManagedWorkspaceWrite?: ManagedWorkspaceWriteAuthorizer
}

/**
 * The sole Main type-erasure boundary. Each module creates its own Plugin
 * bundle, preserving its own capabilities and bootstrap settings shape.
 */
export function bindMainHarnessComposition(
  modules: readonly ErasedHarnessMainPluginModule[],
  deps: MainHarnessCompositionDeps = {}
): MainHarnessComposition {
  const telemetryLedgerFor = deps.telemetryLedgerFor ?? (() => EMPTY_TELEMETRY_LEDGER)
  const hostContextFor = deps.hostContextFor ?? unavailableHostContext
  const composition: Record<string, MainHarnessBinding> = {}
  for (const id of Object.keys(deps.providerBindings ?? {})) {
    if (!modules.some(module => module.id === id)) throw new Error('Provider binding targets an unregistered Harness')
    if (!deps.providerConnections) throw new Error('Provider binding requires a connection registry')
  }
  for (const pluginModule of modules) {
    const id = pluginModule.id
    if (Object.hasOwn(composition, id)) {
      throw new Error(`Harness Main 模块重复注册: ${id}`)
    }
    const context = hostContextFor(id)
    const connectionId = deps.providerBindings?.[id]
    if (connectionId && !pluginModule.providerSupport) throw new Error('Harness does not support Provider injection')
    const providers = pluginModule.providerSupport && deps.providerConnections
      ? deps.providerConnections.forHarness({ harnessId: id, ...pluginModule.providerSupport }, connectionId)
      : context.providers
    const bundle = pluginModule.createMainPlugin({ ...context, providers,
      harnessDataRoot: providers?.explicit
        ? join(context.harnessDataRoot, 'connections', createHash('sha256').update(providers.explicit.connectionId).digest('hex'))
        : context.harnessDataRoot
    })
    composition[id] = bindMainHarness(
      id,
      bundle,
      pluginModule.descriptor,
      structuredClone(pluginModule.defaultHarnessSettings),
      telemetryLedgerFor(id),
      bundle.availability,
      deps.authorizeManagedWorkspaceWrite
    )
  }
  return composition
}

function unavailableHostContext(id: string): HarnessPluginHostContext {
  const fail = (): never => {
    throw new Error(`Harness ${id} 缺少宿主 HostContext（仅测试桩模块可忽略）`)
  }
  return {
    resolveExecutable: fail,
    environment: fail,
    harnessDataRoot: '',
    temporaryWorkspaceRoot: ''
  }
}

function bindMainHarness<
  Id extends string,
  HarnessSettings,
  ThreadSettings,
  ThreadSettingsRequest,
  ThreadSettingsUpdate,
  PromptSettings,
  SettingsPresentationData
>(
  id: Id,
  main: HarnessMainPlugin<
    Id,
    HarnessSettings,
    ThreadSettings,
    ThreadSettingsRequest,
    ThreadSettingsUpdate,
    PromptSettings,
    SettingsPresentationData
  >,
  descriptor: HarnessPluginDescriptor<Id>,
  defaultHarnessSettings: HarnessSettings,
  telemetryLedger: BartTelemetryLedgerCapability & {
    flush?(): Promise<void>
    dispose?(): Promise<void>
  },
  availabilityProbe: HarnessAvailabilityProbe<HarnessSettings>,
  authorizeManagedWorkspaceWrite?: ManagedWorkspaceWriteAuthorizer
): MainHarnessBinding & { readonly id: Id } {
  const harnessSettings = (
    settings: OpenAgentSettings
  ): HarnessSettings => {
    const persisted = settings.harnesses[id]
    return concreteJsonObject<HarnessSettings>(
      !persisted || Object.keys(persisted).length === 0
        ? defaultHarnessSettings
        : persisted
    )
  }
  const readonlyHarnessSettings = (
    settings: OpenAgentSettings
  ): DeepReadonly<HarnessSettings> =>
    harnessSettings(settings) as DeepReadonly<HarnessSettings>
  const loadAvailability = async (
    settings: OpenAgentSettings,
    cwd: string,
    signal: AbortSignal,
    probe: HarnessAvailabilityProbe<HarnessSettings>['probe']
  ): Promise<HarnessAvailability> => {
    const span = withDebugContext(
      ensureDebugContext({ harnessId: id }),
      () => startDebugSpan('harness.availability', { harnessId: id, cwd })
    )
    try {
      signal.throwIfAborted()
      const availability = await withDebugContext(span.context, () => probe({
        settings: readonlyHarnessSettings(settings),
        cwd,
        signal
      }))
      signal.throwIfAborted()
      if (typeof availability.available !== 'boolean') {
        throw new Error(`${descriptor.displayName} availability 无效`)
      }
      span.end({
        available: availability.available,
        ...(availability.reason ? { reason: availability.reason } : {})
      })
      return availability.reason
        ? { available: availability.available, reason: availability.reason }
        : { available: availability.available }
    } catch (error) {
      span.fail(error, { harnessId: id, cwd })
      throw error
    }
  }

  return {
    id,
    displayName: descriptor.displayName,
    threadCapabilities: descriptor.threadCapabilities,
    detectInstallation(cwd, signal) {
      return runHarnessDebugSpan(id, 'harness.installation.detect', { cwd }, () =>
        main.detectInstallation({ cwd, signal })
      )
    },
    async install(signal) {
      if (!main.install) throw new Error(`${descriptor.displayName} 暂不支持一键安装`)
      await main.install({ signal })
    },
    contextEntries(settings, cwd) {
      const result: Partial<Record<BartContextEntryId, BartContextContributor>> = {}
      for (const entryId of Object.keys(main.bartContextEntries ?? {}) as BartContextEntryId[]) {
        const contributor = main.bartContextEntries?.[entryId]
        if (contributor) result[entryId] = ({ signal }) => contributor({
          settings: readonlyHarnessSettings(settings), cwd, telemetryLedger, signal
        })
      }
      return result
    },
    normalizeSettings(settings) {
      const normalized = jsonObject(
        main.settings.normalizeHarnessSettings(harnessSettings(settings))
      )
      return {
        ...settings,
        harnesses: { ...settings.harnesses, [id]: normalized }
      } as OpenAgentSettings
    },
    async loadSettingsPresentation(settings, cwd, signal, thread, refresh) {
      return runHarnessDebugSpan(id, 'harness.settings.presentation', {
        cwd,
        hasThread: thread !== undefined
      }, async () => {
        signal.throwIfAborted()
        debugDetail('harness.settings.presentation.input', {
          harnessId: id,
          cwd,
          ...(thread ? { threadSettings: thread.settings } : {})
        })
        const value = await main.settingsPresentation.load({
          settings: readonlyHarnessSettings(settings),
          cwd,
          ...(thread
            ? {
                thread: {
                  settings: jsonValue(thread.settings)
                }
              }
            : {}),
          ...(refresh ? { refresh: true } : {}),
          signal
        })
        signal.throwIfAborted()
        const result = jsonValue(value)
        debugDetail('harness.settings.presentation.result', {
          harnessId: id,
          cwd,
          presentation: result
        })
        return result
      })
    },
    availability(settings, cwd, signal) {
      return loadAvailability(settings, cwd, signal, input => availabilityProbe.probe(input))
    },
    async invokeExtension(method, payload, signal) {
      return runHarnessDebugSpan(id, 'harness.extension.invoke', {
        method
      }, async () => {
        if (!main.extension) {
          throw new Error(`${descriptor.displayName} 未提供扩展控制面`)
        }
        signal.throwIfAborted()
        debugDetail('harness.extension.input', {
          harnessId: id,
          method,
          payload
        })
        const value = await main.extension.invoke({
          method,
          payload: jsonValue(payload),
          signal
        })
        signal.throwIfAborted()
        const result = jsonValue(value)
        debugDetail('harness.extension.result', {
          harnessId: id,
          method,
          result
        })
        return result
      })
    },
    async forkThread(source, request, signal) {
      return runHarnessDebugSpan(id, 'harness.thread.fork', {
        threadId: source.id
      }, async () => {
        if (!main.forkThread) {
          throw new Error(`${descriptor.displayName} 不支持 Thread fork`)
        }
        if (source.harnessId !== id) {
          throw new Error(`Thread Harness 不匹配: expected ${id}, actual ${source.harnessId}`)
        }
        signal.throwIfAborted()
        debugDetail('harness.thread.fork.input', {
          harnessId: id,
          threadId: source.id,
          request
        })
        const result = await main.forkThread({
          source: source as DeepReadonly<AgentThreadRecord<Id, ThreadSettings>>,
          request: jsonValue(request),
          signal
        })
        signal.throwIfAborted()
        const normalized = forkResult(result)
        const adapter = main.sessionState
        const observation = parseThreadPublicObservation(adapter.project(normalized.sessionState))
        if (observation.latestExecution !== null || observation.backgroundWork !== null) {
          throw new Error('Harness fork 必须返回尚未执行且无后台工作的 Session state')
        }
        debugDetail('harness.thread.fork.result', {
          harnessId: id,
          threadId: source.id,
          result: normalized
        })
        return { ...normalized, observation }
      })
    },
    async dispose() {
      await runHarnessDebugSpan(id, 'harness.dispose', {}, async () => {
        const failures: unknown[] = []
        for (const dispose of [
          () => main.extension?.dispose?.(),
          () => main.dispose?.(),
          () => telemetryLedger.dispose?.() ?? telemetryLedger.flush?.()
        ]) {
          try {
            await dispose()
          } catch (error) {
            debugError('harness.dispose.failure', error, { harnessId: id })
            failures.push(error)
          }
        }
        if (failures.length) {
          throw new AggregateError(
            failures,
            `${descriptor.displayName} Plugin disposal failed`
          )
        }
      })
    },
    openThread(input) {
      return HarnessThreadInstance.open<Id, ThreadSettings>({
        ...input,
        harnessId: id,
        sessionStateAdapter: main.sessionState,
        telemetryLedger,
        openThread: context => {
          const managedWorkspaceWrite = bindManagedWorkspaceWriteCapability(
            context.thread,
            authorizeManagedWorkspaceWrite
          )
          return main.openThread({
            ...context,
            ...(input.injection ? { injection: input.injection } : {}),
            ...(managedWorkspaceWrite ? { managedWorkspaceWrite } : {})
          })
        },
        committed: change => input.committed(change)
      })
    },
    async resolveThreadSettings(input) {
      return runHarnessDebugSpan(id, 'harness.thread.settings.resolve', {
        cwd: input.cwd, hasCurrent: input.current !== undefined
      }, async () => {
        input.signal.throwIfAborted()
        const defaults = main.settings.defaultThreadSettings(readonlyHarnessSettings(input.settings))
        const requested = input.requested === undefined
          ? undefined
          : concreteJsonObject<DeepReadonly<ThreadSettingsRequest>>(input.requested)
        const merged = Object.assign({}, defaults, requested) as DeepReadonly<ThreadSettings>
        const resolved = await main.settings.resolveThreadSettings({
          merged,
          ...(requested === undefined ? {} : { requested }),
          ...(input.current ? {
            existing: concreteJsonValue<DeepReadonly<ThreadSettings>>(input.current.settings)
          } : {}),
          sessionState: input.current?.sessionState ?? null,
          cwd: input.cwd,
          signal: input.signal
        })
        input.signal.throwIfAborted()
        return jsonValue(resolved)
      })
    },
    settingsDescription(settings) {
      return {
        id,
        displayName: descriptor.displayName,
        describe: async ({ cwd, signal }) => {
          signal.throwIfAborted()
          const harnessSettings = readonlyHarnessSettings(settings)
          let described: JsonObject
          try {
            described = await main.settings.describe({ settings: harnessSettings, cwd, signal })
          } catch (cause) {
            signal.throwIfAborted()
            const reason = cause instanceof Error ? cause.message : String(cause)
            throw new ThreadSettingsRefreshUnavailableError(
              `${descriptor.displayName} settings discovery unavailable: ${reason}`, { cause }
            )
          }
          signal.throwIfAborted()
          // Returned-data validation is a contract failure, not an outage.
          return jsonObject(described)
        }
      }
    },
    completePrompt(settings, request, sourceThread) {
      // Preserve the provider contract's synchronous identity guard. The
      // diagnostic wrapper is async and would otherwise turn this programmer
      // error into a rejected Promise.
      if (sourceThread && sourceThread.harnessId !== id) {
        throw new Error(`Thread Harness 不匹配: expected ${id}, actual ${sourceThread.harnessId}`)
      }
      return runHarnessDebugSpan(id, 'harness.prompt.complete', {
        messageCount: request.messages.length,
        outputFormat: request.outputFormat,
        threadId: sourceThread?.id
      }, async () => {
        debugDetail('harness.prompt.input', {
          harnessId: id,
          messages: request.messages,
          outputFormat: request.outputFormat,
          ...(sourceThread ? {
            threadId: sourceThread.id,
            threadSettings: sourceThread.settings
          } : {})
        })
        const result = await main.prompt.complete({
          messages: request.messages,
          outputFormat: request.outputFormat,
          signal: request.signal,
          settings: main.settings.promptSettings(
            readonlyHarnessSettings(settings),
            sourceThread
              ? concreteJsonValue<DeepReadonly<ThreadSettings>>(sourceThread.settings)
              : undefined
          )
        })
        debugDetail('harness.prompt.result', {
          harnessId: id,
          output: result.output
        })
        return result
      })
    },
    resolveExecution: (state, executionId) => {
      const adapter = main.sessionState
      const execution = adapter.resolveExecution(state, executionId)
      return execution === null ? null : PublicExecutionSchema.parse(execution)
    },
    hasThreadContent: sessionState => main.settings.hasThreadContent(sessionState),
    async applyThreadSettingsUpdate(input) {
      return runHarnessDebugSpan(id, 'harness.thread.settings.update', {
        threadId: input.current.id,
      }, async () => {
        const hasContent = main.settings.hasThreadContent(input.current.sessionState)
        debugDetail('harness.thread.settings.input', {
          harnessId: id,
          threadId: input.current.id,
          change: input.change,
          currentSettings: input.current.settings,
          hasContent
        })
        const settings = readonlyHarnessSettings(input.settings)
        const defaults = main.settings.defaultThreadSettings(settings)
        const resolved = await main.settings.applyThreadSettingsUpdate({
          current: concreteJsonValue<DeepReadonly<ThreadSettings>>(
            input.current.settings
          ),
          defaults: defaults as DeepReadonly<ThreadSettings>,
          update: concreteJsonObject<DeepReadonly<ThreadSettingsUpdate>>(
            input.change
          ),
          hasContent,
          cwd: input.current.worktree?.cwd || input.current.cwd,
          signal: input.signal
        })
        const result = jsonValue(resolved)
        debugDetail('harness.thread.settings.result', {
          harnessId: id,
          threadId: input.current.id,
          settings: result
        })
        return result
      })
    }
  }
}

const EMPTY_TELEMETRY_LEDGER: BartTelemetryLedgerCapability = Object.freeze({
  record: async () => undefined,
  read: () => ({ windows: [] })
})

function bindManagedWorkspaceWriteCapability<Id extends string, ThreadSettings>(
  thread: HarnessThreadRef<Id, ThreadSettings>,
  authorize: ManagedWorkspaceWriteAuthorizer | undefined
): ManagedWorkspaceWriteCapability | undefined {
  if (!authorize) return undefined
  const record = thread.read()
  if (record.id !== thread.id) {
    throw new Error('HarnessThreadRef identity 与 record 不匹配')
  }
  if (!record.worktree?.cwd || record.worktree.native) return undefined
  const ownerThreadId = thread.id
  const worktree = structuredClone(record.worktree)
  return Object.freeze({
    grant(signal: AbortSignal) {
      signal.throwIfAborted()
      return authorize({ ownerThreadId, worktree, signal })
    }
  })
}

function jsonValue(value: unknown): JsonValue {
  const cloned: unknown = structuredClone(value)
  if (!isJsonValue(cloned)) throw new Error('Harness 返回了非 JSON value')
  return cloned
}

function jsonObject(value: unknown): JsonObject {
  const cloned: unknown = structuredClone(value)
  if (!isJsonObject(cloned)) throw new Error('Harness settings 必须是 JSON object')
  return cloned
}

function concreteJsonObject<Value>(value: unknown): Value {
  return jsonObject(value) as unknown as Value
}

function concreteJsonValue<Value>(value: unknown): Value {
  return jsonValue(value) as unknown as Value
}

async function runHarnessDebugSpan<Result>(
  harnessId: string,
  event: string,
  fields: Record<string, unknown>,
  operation: () => Promise<Result>
): Promise<Result> {
  const span = withDebugContext(
    ensureDebugContext({ harnessId }),
    () => startDebugSpan(event, { harnessId, ...fields })
  )
  try {
    const result = await withDebugContext(span.context, operation)
    span.end()
    return result
  } catch (error) {
    span.fail(error, { harnessId })
    throw error
  }
}

function ensureDebugContext(fields: Partial<DebugContext>): DebugContext {
  const current = getDebugContext()
  return current.traceId
    ? { ...current, ...fields }
    : createDebugTrace(fields)
}

function forkResult<ThreadSettings>(
  value: HarnessThreadForkResult<ThreadSettings>
): HarnessThreadForkResult<JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Harness Thread fork 结果无效')
  }
  const keys = Object.keys(value)
  if (keys.some(key => key !== 'sessionState' && key !== 'settings' && key !== 'title')) {
    throw new Error('Harness Thread fork 结果包含未知字段')
  }
  if (!Object.hasOwn(value, 'sessionState')) {
    throw new Error('Harness Thread fork 结果缺少 sessionState')
  }
  if (value.title !== undefined && typeof value.title !== 'string') {
    throw new Error('Harness Thread fork title 无效')
  }
  return {
    sessionState: jsonValue(value.sessionState),
    ...(value.settings === undefined ? {} : { settings: jsonValue(value.settings) }),
    ...(value.title === undefined ? {} : { title: value.title })
  }
}
