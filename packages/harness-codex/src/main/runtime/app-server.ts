import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { JsonLines } from '@openagent/plugin-kit/main'
import spawn from 'cross-spawn'
import { isJsonValue, type JsonObject, type JsonValue } from '@openagent/contracts'
import type { HarnessToolBinding } from '@openagent/contracts'
import type { ManagedWorkspaceWriteGrant } from '@openagent/contracts'
import type {
  CodexActivity,
  CodexBackgroundTerminal,
  CodexInteraction,
  CodexInteractionQuestion,
  CodexModelOption,
  CodexNativeEvent,
  CodexThreadSettings
} from '../../shared/types.js'
import type { CodexWireInput } from './input.js'
import { joinCodexAssistantTexts } from '../../shared/assistant-text.js'
import { isCodexAgentMessageId } from '../../shared/native-identity.js'
import { assertCodexInteractionAdmission } from '../../shared/interaction-admission.js'
import {
  debugDetail,
  debugDuration,
  debugEnvironmentSummary,
  debugError,
  debugFrame,
  debugLog,
  debugNow,
  effectiveDebugContext,
  getDebugContext,
  inDebugContext,
  startDebugSpan,
  type DebugContext,
  type DebugSpan
} from '../debug.js'

type UnknownRecord = Record<string, unknown>
type WireId = number | string
const closedChildren = new WeakSet<ChildProcessWithoutNullStreams>()
const failedChildren = new WeakSet<ChildProcessWithoutNullStreams>()
const terminatingChildren = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>()
const MAX_BACKGROUND_TERMINALS = 2_000
const MAX_BACKGROUND_TOMBSTONES = 4_000
const BACKGROUND_TERMINALS_TIMEOUT_MS = 2_000
const CODEX_WORKTREE_GIT_INSTRUCTIONS = `This Codex turn runs in an OpenAgent-managed detached linked worktree. Standard git add and git commit are available in the current worktree. Keep HEAD detached, do not create or switch branches, and do not operate on the base checkout, another worktree, or shared refs. Return the commit SHA; integration into the base branch is owned by the caller.`

export interface CodexTurnOptions {
  readonly executionId: string
  /** OpenAgent Thread identity; native `threadId` is kept as nativeSessionId. */
  readonly debugThreadId?: string
  readonly cwd: string
  /** Provider-neutral capability already validated and revalidated by Core. */
  readonly workspaceWriteGrant?: ManagedWorkspaceWriteGrant
  readonly inputs: readonly CodexWireInput[]
  readonly settings: CodexThreadSettings & {
    readonly ephemeral?: boolean
    readonly outputSchema?: UnknownRecord
  }
  readonly sessionId?: string
  readonly forkFromSessionId?: string
  readonly developerInstructions?: string
  readonly toolBindings?: readonly HarnessToolBinding[]
  readonly toolMode?: 'extend' | 'exclusive'
  /** Cancels only native admission; once admitted, `signal` owns the turn lifetime. */
  readonly admissionSignal?: AbortSignal
  readonly signal: AbortSignal
  emit(event: CodexNativeEvent): void
}

export interface CodexTurnHandle {
  readonly sessionId: string
  steer(inputs: readonly CodexWireInput[], signal: AbortSignal): Promise<void>
  cancel(): Promise<void>
}

export interface CodexAppServerLaunchOptions {
  readonly configOverrides?: readonly string[]
  readonly dispose?: () => void | Promise<void>
  readonly debugPurpose?: string
}

interface TurnContext {
  readonly executionId: string
  readonly threadId: string
  readonly emit: (event: CodexNativeEvent) => void
  readonly toolBindings: ReadonlyMap<string, HarnessToolBinding>
  readonly signal: AbortSignal
  readonly controller: AbortController
  readonly textByItem: Map<string, string>
  readonly reasoningByItem: Map<string, string>
  readonly finalTextByItem: Map<string, string>
  readonly activityOutput: Map<string, string>
  readonly completedCommandIdsBeforeFinalList: Set<string>
  readonly seenResponseIds: Set<string>
  model?: string
  turnId?: string
  interruptPromise?: Promise<void>
  abortListener?: () => void
  failure?: string
  protocolFailure?: Error
  terminal: boolean
  readonly debugContext: DebugContext
  readonly debugThreadId?: string
  readonly debugSpan: DebugSpan
  readonly debugStartedAt: number
  firstMessageSentAt?: number
  firstReasoningAt?: number
  firstTextAt?: number
  debugSummaryEmitted: boolean
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer?: ReturnType<typeof setTimeout>
  readonly debugContext?: DebugContext
}

/** Interaction seam shared with property tests: method, params and the parsed interaction. */
export interface CodexInteractionRequest {
  readonly method: string
  readonly params: UnknownRecord
  readonly interaction: CodexInteraction
}

interface NativeInteractionRequest extends CodexInteractionRequest {
  readonly context: TurnContext
  readonly wireIds: WireId[]
  timer?: ReturnType<typeof setTimeout>
}

interface BackgroundTerminalRefreshOptions {
  readonly excludedActivityIds?: ReadonlySet<string>
}

export type CodexNativeActivityEvent =
  | {
      readonly type: 'status-cleared'
      readonly threadId: string
      readonly at: number
    }
  | {
      readonly type: 'status'
      readonly threadId: string
      readonly status: string
      readonly detail?: string
      readonly at: number
    }
  | {
      readonly type: 'background-terminals'
      readonly threadId: string
      readonly terminals: readonly CodexBackgroundTerminal[]
      readonly at: number
    }
  | {
      readonly type: 'background-activity-completed'
      readonly threadId: string
      readonly activityId: string
      readonly status: 'completed' | 'failed' | 'cancelled'
      readonly detail?: string
      readonly at: number
    }

export class CodexAppServer {
  private process?: ChildProcessWithoutNullStreams
  private readonly children = new Set<ChildProcessWithoutNullStreams>()
  private launchPromise?: Promise<void>
  private readonly pending = new Map<number, PendingRequest>()
  private readonly loadedThreads = new Set<string>()
  private readonly threadModels = new Map<string, string>()
  private readonly turns = new Map<string, TurnContext>()
  /** Explicit execution contexts survive child-process callback boundaries. */
  private readonly debugContextsByExecution = new Map<string, TurnContext>()
  private readonly interactions = new Map<string, NativeInteractionRequest>()
  private readonly activityListeners = new Set<(event: CodexNativeActivityEvent) => void>()
  private readonly backgroundTerminalsByThread = new Map<string, CodexBackgroundTerminal[]>()
  private readonly backgroundTerminalRefreshes = new Map<string, Promise<void>>()
  private readonly backgroundTerminalTombstones = new Map<string, Set<string>>()
  private readonly backgroundTerminalRevisions = new Map<string, number>()
  private nextRequestId = 1
  private stderr = ''
  private disposed = false
  private disposePromise?: Promise<void>
  private reviewerProtocolSupported = false
  private models?: readonly CodexModelOption[]
  private warnedBackgroundTerminals = false
  private debugContext = getDebugContext()

  constructor(
    private readonly executable: string,
    private readonly environment: NodeJS.ProcessEnv,
  private readonly launchOptions: CodexAppServerLaunchOptions = {}
  ) {
    inDebugContext(this.debugContext, () => debugLog('codex.transport.created', {
      harnessId: 'codex',
      purpose: this.launchOptions.debugPurpose || 'thread',
      executable,
      ...debugEnvironmentSummary(environment),
      configOverrideCount: this.launchOptions.configOverrides?.length || 0
    }))
  }

  subscribeNativeActivity(
    listener: (event: CodexNativeActivityEvent) => void
  ): () => void {
    this.activityListeners.add(listener)
    return () => this.activityListeners.delete(listener)
  }

  /** Persist an independent native conversation without admitting a turn. */
  async forkThread(options: {
    readonly sourceSessionId: string
    readonly cwd: string
    readonly settings: CodexThreadSettings
    readonly signal: AbortSignal
  }): Promise<string> {
    const { signal } = options
    throwIfAborted(signal)
    await this.ensureReady(signal)
    if (options.settings.approvalsReviewer === 'auto_review' &&
        !await this.supportsAutoReview(options.cwd, signal)) {
      throw new Error('Codex approve-for-me 自动审批不可用：目标 runtime 不支持或禁止 auto_review')
    }
    return this.ensureThread({
      ...options,
      forkFromSessionId: options.sourceSessionId,
      // Core forks into the base cwd without the source's worktree grant.
      developerInstructions: '',
      settings: { ...options.settings, ephemeral: false }
    }, signal)
  }

  async startTurn(options: CodexTurnOptions): Promise<CodexTurnHandle> {
    const admissionSignal = options.admissionSignal || options.signal
    throwIfAborted(admissionSignal)
    const debugSpan = startDebugSpan('codex.execution', {
      harnessId: 'codex',
      purpose: this.launchOptions.debugPurpose || 'thread',
      executionId: options.executionId,
      ...(options.debugThreadId ? { threadId: options.debugThreadId } : {}),
      cwd: options.cwd
    })
    const debugStartedAt = debugNow()
    let managedWorktree: ManagedWorkspaceWriteTranslation | undefined
    let turnContext: TurnContext | undefined
    try {
      managedWorktree = managedWorkspaceWrite(options)
      await inDebugContext(debugSpan.context, () => this.ensureReady(admissionSignal))
      throwIfAborted(admissionSignal)
      if (options.settings.approvalsReviewer === 'auto_review' &&
          !await this.supportsAutoReview(options.cwd, admissionSignal)) {
        throw new Error('Codex approve-for-me 自动审批不可用：目标 runtime 不支持或禁止 auto_review')
      }
      const threadId = await inDebugContext(
        debugSpan.context,
        () => this.ensureThread(options, admissionSignal, managedWorktree)
      )
      throwIfAborted(admissionSignal)
      if (this.turns.has(threadId)) throw new Error('该 Codex Primary Native Session 仍在运行')

      const controller = new AbortController()
      const activeContext: TurnContext = {
        executionId: options.executionId,
        threadId,
        ...(options.debugThreadId ? { debugThreadId: options.debugThreadId } : {}),
        emit: (event) => inDebugContext(debugSpan.context, () => options.emit(event)),
        toolBindings: new Map((options.toolBindings || []).map((tool) => [tool.name, tool])),
        signal: AbortSignal.any([options.signal, controller.signal]),
        controller,
        textByItem: new Map(),
        reasoningByItem: new Map(),
        finalTextByItem: new Map(),
        activityOutput: new Map(),
        completedCommandIdsBeforeFinalList: new Set(),
        seenResponseIds: new Set(),
        model: this.threadModels.get(threadId) || options.settings.model,
        terminal: false,
        debugContext: debugSpan.context,
        debugSpan,
        debugStartedAt,
        debugSummaryEmitted: false
      }
      turnContext = activeContext
      this.turns.set(threadId, activeContext)
      this.debugContextsByExecution.set(options.executionId, activeContext)
      activeContext.emit({ type: 'session', sessionId: threadId })
      if (activeContext.model) activeContext.emit({ type: 'runtime-model', model: activeContext.model })
      activeContext.emit({ type: 'status', label: '正在连接 Codex' })
      if (options.developerInstructions) {
        inDebugContext(activeContext.debugContext, () => debugDetail('codex.system-prompt.composed', {
          harnessId: 'codex',
          purpose: this.launchOptions.debugPurpose || 'thread',
          executionId: activeContext.executionId,
          threadId: options.debugThreadId || null,
          nativeSessionId: threadId,
          systemPrompt: options.developerInstructions
        }))
      }

      try {
        const effort = await this.filterReasoningEffort(
          options.settings.effort,
          options.settings.model,
          admissionSignal
        )
        const settings = options.settings.effort === effort
          ? options.settings
          : { ...options.settings, effort }
        const params: UnknownRecord = {
          threadId,
          clientUserMessageId: options.executionId,
          input: options.inputs,
          cwd: options.cwd,
          ...turnSettings(settings, managedWorktree?.writableRoots)
        }
        const response = record(await inDebugContext(
          activeContext.debugContext,
          () => this.request('turn/start', params)
        ))
        const turnId = nestedString(response, 'turn', 'id')
        if (!turnId) throw new Error('Codex app-server 未返回 turn id')
        activeContext.turnId = turnId
        if (activeContext.protocolFailure) {
          // Notifications can fail before turn/start acknowledges its ID.
          // Cancel that native turn as soon as its identity becomes available.
          void this.interruptTurn(activeContext).catch(() => undefined)
          throw activeContext.protocolFailure
        }
        const ackAt = debugNow()
        inDebugContext(activeContext.debugContext, () => debugLog('codex.message.ack', {
          harnessId: 'codex',
          purpose: this.launchOptions.debugPurpose || 'thread',
          executionId: activeContext.executionId,
          nativeSessionId: threadId,
          turnId,
          durationMs: Math.max(0, ackAt - activeContext.debugStartedAt),
          messageSentDurationMs: activeContext.firstMessageSentAt === undefined
            ? null
            : Math.max(0, activeContext.firstMessageSentAt - activeContext.debugStartedAt)
        }))
        if (admissionSignal.aborted) {
          await this.interruptTurn(activeContext).catch(() => undefined)
          throw abortError()
        }
        activeContext.abortListener = () => {
          if (activeContext.terminal || !activeContext.turnId) return
          void this.interruptTurn(activeContext).catch(() => undefined)
        }
        activeContext.signal.addEventListener('abort', activeContext.abortListener, { once: true })
        if (activeContext.signal.aborted) activeContext.abortListener()
      } catch (error) {
        activeContext.controller.abort(error)
        if (this.turns.get(threadId) === activeContext) this.turns.delete(threadId)
        this.finishDebugExecution(
          activeContext,
          admissionSignal.aborted ? 'interrupted' : 'failed',
          asError(error).message
        )
        throw error
      }

      return {
        sessionId: threadId,
        steer: async (inputs, signal) => {
          throwIfAborted(signal)
          if (activeContext.terminal || !activeContext.turnId) {
            throw new Error('Codex 当前没有可续发的 turn')
          }
          const params = {
            threadId,
            expectedTurnId: activeContext.turnId,
            input: inputs
          }
          for (let attempt = 0; ; attempt += 1) {
            throwIfAborted(signal)
            try {
              // A successful response means the follow-up crossed native
              // admission; a later operation abort must not undo the active turn.
              await inDebugContext(
                activeContext.debugContext,
                () => this.request('turn/steer', params)
              )
              return
            } catch (error) {
              throwIfAborted(signal)
              if (!pendingSteer(error) || attempt >= 4 || activeContext.terminal) throw error
              await delay(50 * (attempt + 1), signal)
            }
          }
        },
        cancel: async () => {
          if (activeContext.terminal || !activeContext.turnId) return
          await this.interruptTurn(activeContext)
        }
      }
    } catch (error) {
      // Failures before a native thread context exists still get a bounded
      // terminal record for the request that initiated the admission attempt.
      if (turnContext) {
        if (!turnContext.debugSummaryEmitted) {
          this.finishDebugExecution(
            turnContext,
            admissionSignal.aborted ? 'interrupted' : 'failed',
            asError(error).message
          )
        }
      } else {
        debugSpan.fail(error)
        inDebugContext(debugSpan.context, () => debugLog('codex.execution.summary', {
          harnessId: 'codex',
          purpose: this.launchOptions.debugPurpose || 'thread',
          executionId: options.executionId,
          outcome: admissionSignal.aborted ? 'interrupted' : 'failed',
          durationMs: Math.max(0, debugNow() - debugStartedAt),
          messageSentDurationMs: null,
          firstReasoningDurationMs: null,
          firstTextDurationMs: null,
          error: asError(error).message
        }))
      }
      throw error
    }
  }

  respond(interactionId: string, response: JsonValue): boolean {
    const pending = this.interactions.get(interactionId)
    if (!pending) return false
    const result = encodeInteractionResponse(pending, response)
    this.interactions.delete(interactionId)
    if (pending.timer) clearTimeout(pending.timer)
    for (const wireId of pending.wireIds) this.write({ id: wireId, result })
    pending.context.emit({
      type: 'interaction-closed',
      interactionId,
      resolution: responseSummary(result, response)
    })
    return true
  }

  async listModels(signal?: AbortSignal): Promise<readonly CodexModelOption[]> {
    throwIfAborted(signal)
    await this.ensureReady(signal)
    throwIfAborted(signal)
    if (this.models) return this.models
    const response = record(await this.request('model/list', {
      limit: 100,
      includeHidden: false
    }, 30_000, signal))
    throwIfAborted(signal)
    this.models = Array.isArray(response.data)
      ? response.data.flatMap(parseModel)
      : []
    return this.models
  }

  /** Conservative lifecycle baseline verified against Codex 0.153.4's generated protocol. */
  async supportsAutoReview(cwd: string, signal?: AbortSignal): Promise<boolean> {
    await this.ensureReady(signal)
    if (!this.reviewerProtocolSupported) return false
    try {
      const [configuration, constraints] = await Promise.all([
        this.request('config/read', { cwd, includeLayers: false }, 7_500, signal),
        this.request('configRequirements/read', {}, 7_500, signal)
      ])
      throwIfAborted(signal)
      const reviewer = record(record(configuration).config).approvals_reviewer
      const rawRequirements = record(constraints).requirements
      if (rawRequirements !== null && !isRecord(rawRequirements)) return false
      const requirements = record(rawRequirements)
      const allowed = requirements.allowedApprovalsReviewers
      return (reviewer === 'user' || reviewer === 'auto_review') &&
        (allowed === undefined || allowed === null ||
          Array.isArray(allowed) && allowed.includes('auto_review'))
    } catch {
      throwIfAborted(signal)
      return false
    }
  }

  async supportsComputerUse(cwd: string, signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal)
    await this.ensureReady(signal)
    throwIfAborted(signal)
    const response = record(await this.request(
      'plugin/installed',
      { cwds: [cwd] },
      7_500,
      signal
    ))
    throwIfAborted(signal)
    const marketplaces = Array.isArray(response.marketplaces) ? response.marketplaces : []
    const plugins = marketplaces.flatMap((marketplace) => {
      const listed = record(marketplace).plugins
      return Array.isArray(listed) ? listed : []
    })
    return plugins.some((value) => {
      const plugin = record(value)
      const name = string(plugin.name).trim().toLowerCase()
      const id = string(plugin.id).trim().toLowerCase()
      return (name === 'computer-use' || id === 'computer-use' || id.startsWith('computer-use@')) &&
        plugin.installed === true &&
        plugin.enabled === true &&
        string(plugin.availability).trim().toUpperCase() === 'AVAILABLE'
    })
  }

  /** Establish native subscription authority without exposing account credentials. */
  async hasNativeSubscription(signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal)
    await this.ensureReady(signal)
    const response = await this.request('account/read', { refreshToken: false }, 7_500, signal)
    return record(record(response).account).type === 'chatgpt'
  }

  /** Read-only native account quota capability owned by the Codex Plugin. */
  async readUsage(signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal)
    await this.ensureReady(signal)
    throwIfAborted(signal)
    return this.request('account/rateLimits/read', undefined, 7_500, signal)
  }

  private interruptTurn(context: TurnContext): Promise<void> {
    if ((context.terminal && !context.protocolFailure) || !context.turnId) return Promise.resolve()
    context.interruptPromise ??= inDebugContext(
      context.debugContext,
      () => this.request('turn/interrupt', {
        threadId: context.threadId,
        turnId: context.turnId
      })
    ).then(() => undefined)
    return context.interruptPromise
  }

  private async filterReasoningEffort(
    effort: string | undefined,
    modelSetting: string | undefined,
    signal: AbortSignal
  ): Promise<string | undefined> {
    const requested = effort?.trim()
    if (!requested || requested.toLowerCase() === 'default') return undefined
    try {
      const model = findCodexModel(await this.listModels(signal), modelSetting)
      const supported = model?.supportedReasoningEfforts
        .map((option) => option.value.trim().toLowerCase())
        .filter(Boolean) || []
      if (supported.length > 0) {
        return supported.includes(requested.toLowerCase()) ? requested : undefined
      }
    } catch {
      throwIfAborted(signal)
    }
    // Match the baseline's open-ended custom-model behavior when there is no
    // authoritative capability list. `minimal` is never a safe fallback.
    return requested.toLowerCase() === 'minimal' ? undefined : requested
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.disposePromise = Promise.resolve().then(() => this.disposeOnce())
    return this.disposePromise
  }

  private async disposeOnce(): Promise<void> {
    const error = new Error('Codex app-server 已关闭')
    const loadedThreadIds = [...this.loadedThreads]
    this.clearAllBackgroundActivities('cancelled', error.message)
    for (const threadId of loadedThreadIds) this.publishStatusCleared(threadId)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const context of this.turns.values()) {
      if (!context.terminal) {
        context.terminal = true
        context.controller.abort(error)
        context.emit({ type: 'error', message: error.message })
        this.finishDebugExecution(context, 'interrupted', error.message)
        context.emit({ type: 'done', outcome: 'interrupted' })
      } else {
        context.controller.abort(error)
      }
      if (context.abortListener) {
        context.signal.removeEventListener('abort', context.abortListener)
      }
    }
    this.turns.clear()
    this.debugContextsByExecution.clear()
    for (const pending of this.interactions.values()) {
      if (pending.timer) clearTimeout(pending.timer)
    }
    this.interactions.clear()
    this.process = undefined
    this.launchPromise = undefined
    try {
      const results = await Promise.allSettled(
        [...this.children].map((child) => this.terminateChild(child))
      )
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Codex app-server 关闭失败')
    } finally {
      await this.launchOptions.dispose?.()
    }
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    await terminateAndWait(child)
    this.children.delete(child)
  }

  private async ensureThread(
    options: Pick<CodexTurnOptions,
      'cwd' | 'settings' | 'sessionId' | 'forkFromSessionId' |
      'developerInstructions' | 'toolBindings' | 'toolMode'>,
    admissionSignal: AbortSignal,
    managedWorktree?: ManagedWorkspaceWriteTranslation
  ): Promise<string> {
    throwIfAborted(admissionSignal)
    let threadId = options.sessionId
    const settings = options.settings
    const applicationConfig = options.toolMode === 'exclusive'
      ? await this.exclusiveToolsConfig(options.cwd, admissionSignal)
      // Codex 0.152+ makes the checklist opt-in; ordinary Thread cards rely on it.
      : { tools: { update_plan: { enabled: true } } }
    const permissionConfig = settings.approvalsReviewer && settings.sandbox === 'workspace-write'
      ? { ...applicationConfig, sandbox_workspace_write: {
          writable_roots: [], network_access: false,
          exclude_tmpdir_env_var: false, exclude_slash_tmp: false
        } }
      : applicationConfig
    const config = managedWorktree
      ? withManagedWorktreeConfig(permissionConfig, managedWorktree.writableRoots)
      : permissionConfig
    const developerInstructions = appendInstructions(
      options.developerInstructions,
      managedWorktree?.instructions
    )
    throwIfAborted(admissionSignal)
    const base: UnknownRecord = {
      cwd: options.cwd,
      approvalPolicy: settings.approvalPolicy || 'on-request',
      ...(settings.approvalsReviewer ? { approvalsReviewer: settings.approvalsReviewer } : {}),
      ...threadSandbox(settings),
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {}),
      ...(config ? { config } : {}),
      ...(developerInstructions || options.developerInstructions === ''
        ? { developerInstructions: developerInstructions ?? '' } : {})
    }

    if (options.forkFromSessionId) {
      const response = record(await this.request('thread/fork', {
        threadId: options.forkFromSessionId,
        ...base,
        ephemeral: settings.ephemeral === true
      }, 30_000, admissionSignal))
      throwIfAborted(admissionSignal)
      assertNativeApprovalSettings(response, settings)
      threadId = nestedString(response, 'thread', 'id')
      if (!threadId) throw new Error('Codex app-server 未返回 forked thread id')
      this.rememberThreadModel(threadId, string(response.model) || settings.model)
      this.loadedThreads.add(threadId)
    } else if (threadId && !this.loadedThreads.has(threadId)) {
      const response = record(await this.request('thread/resume', {
        threadId,
        ...base,
        ...(settings.personality ? { personality: settings.personality } : {})
      }, 30_000, admissionSignal))
      throwIfAborted(admissionSignal)
      assertNativeApprovalSettings(response, settings)
      const resumed = nestedString(response, 'thread', 'id')
      if (!resumed) throw new Error('Codex app-server 未返回 resumed thread id')
      threadId = resumed
      this.rememberThreadModel(threadId, string(response.model) || settings.model)
      this.loadedThreads.add(threadId)
    }

    if (!threadId) {
      const response = record(await this.request('thread/start', {
        ...base,
        experimentalRawEvents: true,
        ...(settings.personality ? { personality: settings.personality } : {}),
        ephemeral: settings.ephemeral === true,
        serviceName: 'openagent_desktop',
        ...(options.toolBindings?.length
          ? {
              dynamicTools: options.toolBindings.map((tool) => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema
              }))
            }
          : {})
      }, 30_000, admissionSignal))
      throwIfAborted(admissionSignal)
      assertNativeApprovalSettings(response, settings)
      threadId = nestedString(response, 'thread', 'id')
      if (!threadId) throw new Error('Codex app-server 未返回 thread id')
      this.rememberThreadModel(threadId, string(response.model) || settings.model)
      this.loadedThreads.add(threadId)
    }
    if (threadId && !this.threadModels.has(threadId)) {
      this.rememberThreadModel(threadId, settings.model)
    }
    return threadId
  }

  private rememberThreadModel(threadId: string, model: string | undefined): void {
    const normalized = model?.trim()
    if (normalized) this.threadModels.set(threadId, normalized)
  }

  /** Complete persisted app-server items; a supported context replay, not native event import. */
  async readThreadHistory(threadId: string, signal: AbortSignal): Promise<JsonValue[]> {
    await this.ensureReady(signal)
    const history: JsonValue[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      throwIfAborted(signal)
      const response = record(await this.request('thread/turns/list', {
        threadId, itemsView: 'full', sortDirection: 'asc', limit: 100,
        ...(cursor ? { cursor } : {})
      }, 30_000, signal))
      if (!Array.isArray(response.data) || !isJsonValue(response.data)) {
        throw new Error('Codex native full history is unavailable')
      }
      for (const value of response.data) {
        const turn = record(value)
        if (!Array.isArray(turn.items) || turn.itemsView !== undefined && turn.itemsView !== 'full') {
          throw new Error('Codex native history did not provide full Thread items')
        }
        history.push(value)
      }
      if (Buffer.byteLength(JSON.stringify(history), 'utf8') > 8 * 1024 * 1024) {
        throw new Error('Codex full native history exceeds the 8 MiB context replay limit; existing session retained')
      }
      const next = response.nextCursor
      if (next !== null && next !== undefined && typeof next !== 'string') {
        throw new Error('Codex native history cursor is invalid')
      }
      cursor = typeof next === 'string' && next ? next : undefined
      if (cursor && cursors.has(cursor)) throw new Error('Codex native history pagination did not advance')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return history
  }

  /** Native preferences needed when tools use an isolated home, without user tool configuration. */
  async readThreadConfiguration(cwd: string, signal?: AbortSignal): Promise<UnknownRecord> {
    await this.ensureReady(signal)
    const response = await this.request('config/read', { cwd, includeLayers: false }, 30_000, signal)
    const config = record(record(response).config)
    const keys = [
      'model', 'model_provider', 'model_providers', 'model_reasoning_effort',
      'model_reasoning_summary', 'service_tier', 'personality', 'approval_policy',
      'approvals_reviewer', 'sandbox_mode', 'sandbox_workspace_write'
    ]
    return Object.fromEntries(keys.flatMap(key => config[key] === undefined || config[key] === null
      ? [] : [[key, config[key]]]))
  }

  private async exclusiveToolsConfig(
    cwd: string,
    signal: AbortSignal
  ): Promise<UnknownRecord> {
    throwIfAborted(signal)
    const [configResponse, skillsResponse] = await Promise.all([
      this.request('config/read', { cwd, includeLayers: false }, 30_000, signal),
      this.request('skills/list', { cwds: [cwd], forceReload: true }, 30_000, signal)
    ])
    throwIfAborted(signal)
    const effective = record(record(configResponse).config)
    const configuredMcpServers = record(effective.mcp_servers)
    const configuredPlugins = record(effective.plugins)
    const configuredWorkspaceWrite = record(effective.sandbox_workspace_write)
    const skillEntries = record(skillsResponse).data
    const skills: unknown[] = Array.isArray(skillEntries)
      ? skillEntries.flatMap((entry) => {
          const listed = record(entry).skills
          return Array.isArray(listed) ? listed : []
        })
      : []
    return {
      agents: { enabled: false },
      apps: { _default: { enabled: false } },
      features: {
        apps: false,
        goals: false,
        hooks: false,
        image_generation: false,
        memories: false,
        multi_agent: false,
        plugins: false,
        remote_plugin: false,
        shell_tool: false,
        skill_mcp_dependency_install: false,
        unified_exec: false,
        view_image: false
      },
      mcp_servers: Object.fromEntries(
        Object.keys(configuredMcpServers).map((name) => [name, { enabled: false }])
      ),
      memories: { generate_memories: false, use_memories: false },
      plugins: disablePluginMcpServers(configuredPlugins),
      ...(Object.keys(configuredWorkspaceWrite).length
        ? { sandbox_workspace_write: structuredClone(configuredWorkspaceWrite) }
        : {}),
      skills: {
        config: skills.flatMap((skill) => {
          const path = string(record(skill).path)
          return path ? [{ path, enabled: false }] : []
        })
      },
      tools: {
        experimental_request_user_input: { enabled: false },
        update_plan: { enabled: false },
        image_generation: false,
        view_image: false,
        web_search: false
      },
      web_search: 'disabled'
    }
  }

  private async ensureReady(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (this.disposed) throw new Error('Codex app-server 已关闭')
    const reused = Boolean(this.launchPromise)
    const span = startDebugSpan(
      reused ? 'codex.transport.reused' : 'codex.transport.cold',
      {
        harnessId: 'codex',
        purpose: this.launchOptions.debugPurpose || 'thread',
        executable: this.executable
      }
    )
    this.captureDebugContext(span.context)
    try {
      if (!this.launchPromise) {
        // Initialization belongs to the server. Cancelling one caller must not
        // tear down another caller's shared connection attempt.
        const launch = this.launch()
        const tracked = launch.catch((error) => {
          if (this.launchPromise === tracked) this.launchPromise = undefined
          throw error
        })
        this.launchPromise = tracked
      }
      await waitWithSignal(this.launchPromise, signal)
      if (this.disposed) throw new Error('Codex app-server 已关闭')
      throwIfAborted(signal)
      span.end({ reused, ready: true })
    } catch (error) {
      span.fail(error)
      debugError('codex.transport.lifecycle-error', error, {
        harnessId: 'codex',
        purpose: this.launchOptions.debugPurpose || 'thread',
        phase: reused ? 'reuse' : 'cold'
      })
      throw error
    }
  }

  private async launch(): Promise<void> {
    const span = startDebugSpan('codex.transport.spawn', {
      harnessId: 'codex',
      purpose: this.launchOptions.debugPurpose || 'thread',
      executable: this.executable,
      args: [
        ...(this.launchOptions.configOverrides || []).flatMap((override) => ['-c', override]),
        'app-server',
        '--listen',
        'stdio://'
      ],
      ...debugEnvironmentSummary(this.environment)
    })
    this.captureDebugContext(span.context)
    this.stderr = ''
    this.warnedBackgroundTerminals = false
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.executable, [
        ...(this.launchOptions.configOverrides || []).flatMap((override) => ['-c', override]),
        'app-server',
        '--listen',
        'stdio://'
      ], {
        env: this.environment,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      span.fail(error)
      throw error
    }
    this.process = child
    this.children.add(child)
    const decoder = new JsonLines()
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.process !== child) return
      inDebugContext(this.debugContext, () => debugDetail('codex.protocol.inbound-chunk', {
        purpose: this.launchOptions.debugPurpose || 'thread',
        bytes: chunk.byteLength,
        encoding: 'utf8'
      }))
      for (const line of decoder.push(chunk)) this.handleLine(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.process !== child) return
      const text = chunk.toString('utf8')
      inDebugContext(this.debugContext, () => debugDetail('codex.protocol.stderr', {
        purpose: this.launchOptions.debugPurpose || 'thread',
        bytes: chunk.byteLength,
        text
      }))
      this.stderr = tail(this.stderr + text, 32 * 1024)
    })
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on('error', (error) => {
        if (!this.disposed) this.handleExit(child, error)
      })
    }
    child.once('error', (error) => {
      failedChildren.add(child)
      if (!this.disposed) this.handleExit(child, error)
    })
    child.once('close', (code) => {
      closedChildren.add(child)
      if (this.process !== child) return
      for (const line of decoder.end()) this.handleLine(line)
      if (!this.disposed) {
        this.handleExit(child, new Error(
          this.stderr.trim() || `Codex app-server 已退出（退出码 ${String(code ?? 'unknown')}）`
        ))
      }
    })
    try {
      const initialized = record(await this.request('initialize', {
        clientInfo: { name: 'openagent_desktop', title: 'OpenAgent', version: '0.2.0' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          extensions: { 'openai/form': {} }
        }
      }, 30_000))
      // Older servers may ignore unknown request fields. Do not infer support
      // from a successful request alone, particularly on already-loaded turns.
      const version = string(initialized.userAgent).match(/\/(\d+)\.(\d+)\.(\d+)(?:[\s(]|$)/)
      this.reviewerProtocolSupported = Boolean(version && (Number(version[1]) > 0 ||
        Number(version[2]) > 153 || Number(version[2]) === 153 && Number(version[3]) >= 4))
      this.write({ method: 'initialized' })
      span.end({ initialized: true })
    } catch (error) {
      span.fail(error)
      debugError('codex.transport.initialize-error', error, {
        harnessId: 'codex',
        purpose: this.launchOptions.debugPurpose || 'thread'
      })
      await this.terminateChild(child)
      if (this.process === child) this.process = undefined
      throw error
    }
  }

  private request(
    method: string,
    params?: unknown,
    timeoutMs = 30_000,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('Codex app-server 已关闭'))
    if (signal?.aborted) return Promise.reject(abortError())
    const id = this.nextRequestId++
    const requestDebugContext = effectiveDebugContext(
      getDebugContext(),
      this.debugContext
    )
    const span = inDebugContext(requestDebugContext, () => startDebugSpan(
      'codex.protocol.request',
      {
        harnessId: 'codex',
        purpose: this.launchOptions.debugPurpose || 'thread',
        requestId: id,
        method
      }
    ))
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      const abort = (): void => {
        if (!this.pending.delete(id)) return
        cleanup()
        const error = abortError()
        inDebugContext(requestDebugContext, () => span.fail(error, { phase: 'abort' }))
        reject(error)
      }
      timer = timeoutMs > 0
        ? setTimeout(() => {
            if (!this.pending.delete(id)) return
            cleanup()
            const error = new Error(`Codex ${method} 请求超时`)
            inDebugContext(requestDebugContext, () => span.fail(error, { phase: 'timeout' }))
            reject(error)
          }, timeoutMs)
        : undefined
      timer?.unref?.()
      this.pending.set(id, {
        resolve: (value) => {
          cleanup()
          inDebugContext(requestDebugContext, () => span.end({ outcome: 'completed' }))
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          inDebugContext(requestDebugContext, () => span.fail(error, { phase: 'response' }))
          reject(error)
        },
        timer,
        debugContext: requestDebugContext
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }
      try {
        this.write(params === undefined ? { id, method } : { id, method, params })
      } catch (error) {
        this.pending.delete(id)
        cleanup()
        const cause = asError(error)
        inDebugContext(requestDebugContext, () => span.fail(cause, { phase: 'write' }))
        reject(cause)
      }
    })
  }

  private write(message: unknown): void {
    if (!this.process || this.process.stdin.destroyed) {
      throw new Error('Codex app-server 尚未连接')
    }
    const messageThreadId = isRecord(message) && isRecord(message.params)
      ? string(message.params.threadId)
      : ''
    const debugContext = effectiveDebugContext(
      this.turns.get(messageThreadId)?.debugContext,
      effectiveDebugContext(getDebugContext(), this.debugContext)
    )
    inDebugContext(debugContext, () => debugDetail('codex.protocol.outbound', {
      purpose: this.launchOptions.debugPurpose || 'thread',
      frame: debugFrame(message)
    }))
    const turnStartContext = isRecord(message) && message.method === 'turn/start'
      ? this.debugContextsByExecution.get(
          isRecord(message.params) ? string(message.params.clientUserMessageId) : ''
        )
      : undefined
    if (turnStartContext) {
      const executionId = turnStartContext.executionId
      const context = turnStartContext
      if (context.firstMessageSentAt === undefined) {
        const sentAt = debugNow()
        context.firstMessageSentAt = sentAt
        inDebugContext(context.debugContext, () => debugLog('codex.message.sent', {
          harnessId: 'codex',
          purpose: this.launchOptions.debugPurpose || 'thread',
          executionId,
          nativeSessionId: context.threadId,
          durationMs: Math.max(0, sentAt - context.debugStartedAt)
        }))
      }
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    let message: UnknownRecord
    try {
      message = record(JSON.parse(line))
    } catch {
      inDebugContext(this.debugContext, () => debugDetail('codex.protocol.inbound', {
        purpose: this.launchOptions.debugPurpose || 'thread',
        json: false,
        line
      }))
      return
    }
    const threadId = isRecord(message.params) ? string(message.params.threadId) : ''
    const pendingContext = typeof message.id === 'number'
      ? this.pending.get(message.id)?.debugContext
      : undefined
    const turnDebugContext = this.turns.get(threadId)?.debugContext
    const processDebugContext = effectiveDebugContext(getDebugContext(), this.debugContext)
    // Child stdout callbacks can retain the context of whichever operation
    // spawned the process. Resolve an inbound frame from its pending request
    // or native turn first so concurrent sessions cannot cross-correlate.
    const inboundDebugContext = effectiveDebugContext(
      pendingContext,
      effectiveDebugContext(turnDebugContext, processDebugContext)
    )
    inDebugContext(
      inboundDebugContext,
      () => debugDetail('codex.protocol.inbound', {
        purpose: this.launchOptions.debugPurpose || 'thread',
        json: true,
        frame: debugFrame(message)
      })
    )
    if (message.id !== undefined && typeof message.method === 'string') {
      inDebugContext(inboundDebugContext, () => this.handleServerRequest(message))
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (isRecord(message.error)) {
        pending.reject(new Error(string(message.error.message) || 'Codex 请求失败'))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    const notificationMethod = typeof message.method === 'string' ? message.method : undefined
    const notificationParams = isRecord(message.params) ? message.params : undefined
    if (!notificationMethod || !notificationParams) return
    if (notificationMethod === 'thread/status/changed') {
      const threadId = string(notificationParams.threadId)
      if (threadId) {
        const status = compact(notificationParams.status) || 'unknown'
        const event = { type: 'status' as const, threadId, status, at: Date.now() }
        for (const listener of this.activityListeners) listener(event)
        void this.refreshBackgroundTerminals(threadId)
      }
    }
    inDebugContext(
      inboundDebugContext,
      () => this.handleNotification(notificationMethod, notificationParams)
    )
  }

  private handleServerRequest(message: UnknownRecord): void {
    const wireId = message.id
    if ((typeof wireId !== 'number' && typeof wireId !== 'string') || !this.process) return
    const method = string(message.method)
    const params = record(message.params)
    if (method === 'currentTime/read') {
      this.write({ id: wireId, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } })
      return
    }
    const threadId = string(params.threadId)
    const context = this.turns.get(threadId)
    if (!context || context.terminal) {
      this.write({
        id: wireId,
        error: { code: -32_000, message: 'OpenAgent 找不到对应的活动 Codex turn' }
      })
      return
    }
    if (method === 'item/tool/call') {
      void this.handleToolCall(wireId, context, params).catch(() => undefined)
      return
    }
    let interaction: CodexInteraction | undefined
    try {
      interaction = parseInteraction(method, params)
      if (interaction) {
        // Reject the complete request before pending registration or private
        // publication; public identity collisions cannot be answered safely.
        assertCodexInteractionAdmission(interaction)
      }
    } catch (error) {
      this.write({ id: wireId, error: { code: -32_602, message: asError(error).message } })
      return
    }
    if (!interaction) {
      this.write({
        id: wireId,
        error: { code: -32_601, message: `OpenAgent 未启用该 Codex server request：${method}` }
      })
      return
    }
    const pending: NativeInteractionRequest = {
      context,
      method,
      params,
      interaction,
      wireIds: [wireId]
    }
    const autoResolutionMs = number(params.autoResolutionMs)
    if (autoResolutionMs && autoResolutionMs > 0) {
      pending.timer = setTimeout(() => {
        if (this.interactions.get(interaction.id) !== pending) return
        this.interactions.delete(interaction.id)
        const fallback = defaultInteractionDecline(pending)
        for (const pendingWireId of pending.wireIds) {
          try {
            this.write({ id: pendingWireId, ...fallback.response })
          } catch {
            // Transport failure is converged by handleExit.
          }
        }
        context.emit({
          type: 'interaction-closed',
          interactionId: interaction.id,
          resolution: fallback.resolution
        })
      }, autoResolutionMs)
      pending.timer.unref?.()
    }
    this.interactions.set(interaction.id, pending)
    context.emit({ type: 'interaction-opened', interaction })
  }

  private async handleToolCall(
    wireId: WireId,
    context: TurnContext,
    params: UnknownRecord
  ): Promise<void> {
    const name = string(params.tool)
    const tool = context.toolBindings.get(name)
    if (!tool) {
      inDebugContext(context.debugContext, () => debugDetail('codex.tool-bridge.unknown', {
        harnessId: 'codex',
        purpose: this.launchOptions.debugPurpose || 'thread',
        executionId: context.executionId,
        nativeSessionId: context.threadId,
        wireId,
        name,
        frame: debugFrame(params)
      }))
      this.write({
        id: wireId,
        result: {
          success: false,
          contentItems: [{ type: 'inputText', text: 'OpenAgent 未启用该工具' }]
        }
      })
      return
    }
    const span = inDebugContext(context.debugContext, () => startDebugSpan(
      'codex.tool-bridge.call',
      {
        harnessId: 'codex',
        purpose: this.launchOptions.debugPurpose || 'thread',
        executionId: context.executionId,
        nativeSessionId: context.threadId,
        wireId,
        name,
        callId: string(params.callId) || undefined
      }
    ))
    inDebugContext(context.debugContext, () => debugDetail('codex.tool-bridge.inbound', {
      harnessId: 'codex',
      purpose: this.launchOptions.debugPurpose || 'thread',
      executionId: context.executionId,
      nativeSessionId: context.threadId,
      wireId,
      name,
      arguments: debugFrame(params.arguments)
    }))
    try {
      const rawArguments = params.arguments
      const argumentsValue = isJsonValue(rawArguments) ? rawArguments : null
      const result = await inDebugContext(context.debugContext, () => tool.execute({
          ...(string(params.callId) ? { callId: string(params.callId) } : {}),
          arguments: argumentsValue,
          signal: context.signal
        }))
      inDebugContext(context.debugContext, () => debugDetail('codex.tool-bridge.result', {
        harnessId: 'codex',
        purpose: this.launchOptions.debugPurpose || 'thread',
        executionId: context.executionId,
        nativeSessionId: context.threadId,
        wireId,
        name,
        result: debugFrame(result)
      }))
      if (!this.canReplyToToolCall(context)) {
        span.end({ success: true, replySent: false })
        return
      }
      inDebugContext(context.debugContext, () => this.write({
          id: wireId,
          result: {
            success: true,
            contentItems: [{ type: 'inputText', text: formatJson(result) }]
          }
        }))
      span.end({ success: true, replySent: true })
    } catch (error) {
      inDebugContext(context.debugContext, () => debugError('codex.tool-bridge.error', error, {
        harnessId: 'codex',
        purpose: this.launchOptions.debugPurpose || 'thread',
        executionId: context.executionId,
        nativeSessionId: context.threadId,
        wireId,
        name,
        arguments: debugFrame(params.arguments)
      }))
      span.fail(error)
      if (!this.canReplyToToolCall(context)) return
      try {
        inDebugContext(context.debugContext, () => this.write({
            id: wireId,
            result: {
              success: false,
              contentItems: [{ type: 'inputText', text: asError(error).message }]
            }
          }))
      } catch {
        // Transport cleanup owns shutdown; a late tool result has no recipient.
      }
    }
  }

  private canReplyToToolCall(context: TurnContext): boolean {
    return !this.disposed && !context.terminal && !context.signal.aborted &&
      this.turns.get(context.threadId) === context &&
      Boolean(this.process && !this.process.stdin.destroyed)
  }

  private handleNotification(method: string, params: UnknownRecord): void {
    const threadId = string(params.threadId)
    const context = this.turns.get(threadId)
    const turnId = string(params.turnId)
    if (method === 'thread/settings/updated') {
      const model = string(record(params.threadSettings).model)
      if (threadId && model) this.threadModels.set(threadId, model)
      if (context && model) {
        context.model = model
        context.emit({ type: 'runtime-model', model })
      }
      return
    }
    if (method === 'item/completed' && threadId && isRecord(params.item)) {
      const itemId = string(params.item.id)
      if (params.item.type === 'commandExecution' && itemId && context &&
        (!context.turnId || !turnId || context.turnId === turnId)) {
        context.completedCommandIdsBeforeFinalList.add(itemId)
      }
      // A background command from an earlier turn may complete while another
      // turn is active. Resolve it before applying the active turnId guard.
      if (this.handleBackgroundActivityCompleted(threadId, params.item)) {
        void this.refreshBackgroundTerminals(threadId)
        return
      }
    }
    if (!context) return
    if (context.terminal) {
      // turn/completed is authoritative. Late item notifications must not
      // append a second assistant final after terminal projection.
      return
    }
    if (context.turnId && turnId && context.turnId !== turnId) return

    if (method === 'item/agentMessage/delta') {
      if (!isCodexAgentMessageId(params.itemId)) {
        this.failInvalidAgentMessage(context)
        return
      }
      const delta = string(params.delta)
      const itemId = params.itemId
      if (delta) {
        context.textByItem.set(itemId, (context.textByItem.get(itemId) || '') + delta)
        this.recordFirstContent(context, 'text')
        context.emit({ type: 'text-delta', itemId, delta })
      }
      return
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const delta = string(params.delta)
      const itemId = string(params.itemId)
      if (delta) {
        context.reasoningByItem.set(itemId, (context.reasoningByItem.get(itemId) || '') + delta)
        this.recordFirstContent(context, 'reasoning')
        context.emit({ type: 'reasoning-delta', delta })
      }
      context.emit({ type: 'status', label: '正在分析' })
      return
    }
    if (method === 'item/plan/delta') {
      context.emit({ type: 'status', label: '正在制定计划' })
      return
    }
    if (method === 'turn/plan/updated') {
      const steps = Array.isArray(params.plan) ? params.plan.flatMap(parsePlanStep) : []
      context.emit({
        type: 'plan',
        steps,
        ...(string(params.explanation) ? { explanation: string(params.explanation) } : {})
      })
      return
    }
    if (method === 'turn/diff/updated') {
      context.emit({ type: 'diff', diff: string(params.diff) })
      return
    }
    if (method === 'item/started' && isRecord(params.item)) {
      if (params.item.type === 'agentMessage') {
        if (!isCodexAgentMessageId(params.item.id)) {
          this.failInvalidAgentMessage(context)
          return
        }
        if (!context.textByItem.has(params.item.id)) {
          context.textByItem.set(params.item.id, '')
          context.emit({ type: 'text-delta', itemId: params.item.id, delta: '' })
        }
        return
      }
      const activity = parseActivity(params.item)
      if (activity) context.emit({ type: 'activity-start', activity })
      return
    }
    if (method === 'item/commandExecution/outputDelta') {
      const activityId = string(params.itemId)
      const detail = tail(
        (context.activityOutput.get(activityId) || '') + string(params.delta),
        32 * 1024
      )
      context.activityOutput.set(activityId, detail)
      context.emit({ type: 'activity-update', activityId, detail })
      return
    }
    if (method === 'item/mcpToolCall/progress') {
      context.emit({
        type: 'activity-update',
        activityId: string(params.itemId),
        detail: string(params.message) || compact(params) || '运行中'
      })
      return
    }
    if ((method === 'hook/started' || method === 'hook/completed') && isRecord(params.run)) {
      const id = string(params.run.id)
      if (!id) return
      if (method === 'hook/started') {
        context.emit({
          type: 'activity-start',
          activity: {
            id,
            kind: 'hook',
            label: string(params.run.name) || '运行 Hook',
            status: 'running'
          }
        })
      } else {
        context.emit({
          type: 'activity-end',
          activityId: id,
          status: params.run.status === 'failed' ? 'failed' : 'completed',
          ...(compact(params.run) ? { detail: compact(params.run) } : {})
        })
      }
      return
    }
    if (method === 'item/completed' && isRecord(params.item)) {
      this.handleCompletedItem(context, params.item)
      return
    }
    if (method === 'serverRequest/resolved') {
      const wireId = params.requestId
      const entry = [...this.interactions.entries()].find(([, pending]) =>
        pending.wireIds.includes(wireId as WireId)
      )
      if (entry) {
        const [interactionId, pending] = entry
        if (pending.timer) clearTimeout(pending.timer)
        this.interactions.delete(interactionId)
        pending.context.emit({
          type: 'interaction-closed',
          interactionId,
          resolution: '已由 Codex 结束'
        })
      }
      return
    }
    if (method === 'thread/tokenUsage/updated' && isRecord(params.tokenUsage)) {
      const last = record(params.tokenUsage.last)
      context.emit({
        type: 'usage',
        usage: cleanUsage({
          inputTokens: number(last.inputTokens),
          cachedInputTokens: number(last.cachedInputTokens),
          outputTokens: number(last.outputTokens),
          reasoningTokens: number(last.reasoningOutputTokens),
          contextWindow: number(params.tokenUsage.modelContextWindow)
        })
      })
      return
    }
    if (method === 'rawResponse/completed' && isRecord(params.usage)) {
      const responseId = string(params.responseId)
      if (!responseId || context.seenResponseIds.has(responseId)) return
      const usage = cleanGenerationUsage(params.usage)
      if (Object.keys(usage).length === 0) return
      context.seenResponseIds.add(responseId)
      context.emit({
        type: 'generation-usage',
        nativeSessionId: context.threadId,
        generationId: responseId,
        model: context.model || this.threadModels.get(threadId) || 'unknown',
        usage
      })
      return
    }
    if (method === 'warning' || method === 'configWarning' || method === 'guardianWarning') {
      const message = string(params.message) || string(params.summary) ||
        compact(params) || 'Codex 警告'
      context.emit({ type: 'warning', message })
      return
    }
    if (method === 'model/rerouted') {
      const model = string(params.toModel)
      if (model) {
        context.model = model
        this.threadModels.set(threadId, model)
        context.emit({ type: 'runtime-model', model })
      }
      context.emit({
        type: 'warning',
        message: `模型已从 ${string(params.fromModel)} 切换到 ${model || '未知模型'}`
      })
      return
    }
    if (method === 'error') {
      const message = nestedString(params, 'error', 'message') || string(params.message)
      if (message) {
        context.failure = message
        context.emit({ type: 'error', message })
      }
      return
    }
    if (method === 'turn/completed' && isRecord(params.turn)) {
      this.finishTurn(context, params.turn)
    }
  }

  private handleCompletedItem(context: TurnContext, item: UnknownRecord): void {
    const itemId = string(item.id)
    if (item.type === 'agentMessage') {
      if (!isCodexAgentMessageId(item.id)) {
        this.failInvalidAgentMessage(context)
        return
      }
      const finalText = string(item.text)
      // Empty messages still establish the last assistant message boundary.
      context.finalTextByItem.set(itemId, finalText)
      if (finalText) {
        this.recordFirstContent(context, 'text')
        const streamed = context.textByItem.get(itemId) || ''
        if (!streamed) {
          context.textByItem.set(itemId, finalText)
          context.emit({ type: 'text-delta', itemId, delta: finalText })
        } else if (finalText.startsWith(streamed) && finalText.length > streamed.length) {
          const suffix = finalText.slice(streamed.length)
          context.textByItem.set(itemId, finalText)
          context.emit({ type: 'text-delta', itemId, delta: suffix })
        }
      } else if (!context.textByItem.has(itemId)) {
        // Persist a standalone empty boundary before turn/completed, so Core
        // recovery cannot fall back to an earlier assistant message.
        context.textByItem.set(itemId, '')
        context.emit({ type: 'text-delta', itemId, delta: '' })
      }
      return
    }
    if (item.type === 'reasoning') {
      const parts = Array.isArray(item.summary)
        ? item.summary.filter((part): part is string => typeof part === 'string')
        : []
      const fallback = Array.isArray(item.content)
        ? item.content.filter((part): part is string => typeof part === 'string')
        : []
      const text = (parts.length ? parts : fallback).join('\n')
      const streamed = context.reasoningByItem.get(itemId) || ''
      if (text && !streamed) {
        this.recordFirstContent(context, 'reasoning')
        context.emit({ type: 'reasoning-delta', delta: text })
      } else if (text.startsWith(streamed) && text.length > streamed.length) {
        this.recordFirstContent(context, 'reasoning')
        context.emit({ type: 'reasoning-delta', delta: text.slice(streamed.length) })
      }
      return
    }
    if (item.type === 'exitedReviewMode') {
      const review = string(item.review)
      if (review) context.emit({ type: 'review', review })
    }
    if (item.type === 'contextCompaction') {
      context.emit({ type: 'context-compacted' })
      return
    }
    if (!isActivityItem(item)) return
    const detail = completedDetail(item) || context.activityOutput.get(itemId)
    context.emit({
      type: 'activity-end',
      activityId: itemId,
      status: completedActivityStatus(item),
      ...(detail ? { detail } : {})
    })
  }

  private recordFirstContent(
    context: TurnContext,
    kind: 'reasoning' | 'text'
  ): void {
    const current = kind === 'text' ? context.firstTextAt : context.firstReasoningAt
    if (current !== undefined) return
    const at = debugNow()
    if (kind === 'text') context.firstTextAt = at
    else context.firstReasoningAt = at
    inDebugContext(context.debugContext, () => debugLog(
      kind === 'text'
        ? 'codex.execution.first-text'
        : 'codex.execution.first-reasoning',
      {
        harnessId: 'codex',
        purpose: this.launchOptions.debugPurpose || 'thread',
        executionId: context.executionId,
        ...(context.debugThreadId ? { threadId: context.debugThreadId } : {}),
        nativeSessionId: context.threadId,
        nativeThreadId: context.threadId,
        durationMs: Math.max(0, at - context.debugStartedAt)
      }
    ))
  }

  private failInvalidAgentMessage(context: TurnContext): void {
    const error = invalidAgentMessageIdentity()
    context.protocolFailure = error
    void this.interruptTurn(context).catch(() => undefined)
    this.finishTurn(context, { status: 'failed' }, error)
  }

  private finishTurn(context: TurnContext, turn: UnknownRecord, protocolFailure?: Error): void {
    if (context.terminal) return
    // Validate the complete native terminal list before publishing any final.
    // A malformed ID cannot be replaced with an invented identity or ignored.
    const completedFinals = finalAgentMessages(turn)
    if (completedFinals === undefined) protocolFailure = invalidAgentMessageIdentity()
    const finalMessages = protocolFailure
      ? []
      : completedFinals && completedFinals.length > 0
        ? completedFinals
        : [...context.finalTextByItem].map(([id, text]) => ({ id, text }))
    if (protocolFailure) {
      context.protocolFailure = protocolFailure
      context.failure = protocolFailure.message
    }
    context.terminal = true
    context.controller.abort(new Error('Codex turn reached terminal'))
    const status = protocolFailure ? 'failed' : string(turn.status)
    const displayText = joinCodexAssistantTexts(finalMessages.map((message) => message.text))
    finalMessages.forEach((message, index) => {
      context.emit({
        type: 'text-final',
        itemId: message.id,
        text: message.text,
        ...(index === finalMessages.length - 1 && displayText !== message.text
          ? { displayText }
          : {})
      })
    })
    if (protocolFailure || (status === 'failed' && isRecord(turn.error))) {
      context.failure = protocolFailure?.message ||
        string(record(turn.error).message) || context.failure || 'Codex 运行失败'
      context.emit({ type: 'error', message: context.failure })
    }
    for (const [interactionId, pending] of this.interactions) {
      if (pending.context !== context) continue
      if (pending.timer) clearTimeout(pending.timer)
      this.interactions.delete(interactionId)
      context.emit({ type: 'interaction-closed', interactionId, resolution: '已由 Codex 结束' })
    }
    const outcome: 'completed' | 'failed' | 'interrupted' = status === 'interrupted'
      ? 'interrupted'
      : status === 'failed'
        ? 'failed'
        : status === 'completed'
          ? 'completed'
          : context.failure
            ? 'failed'
            : 'completed'
    void this.refreshBackgroundTerminals(context.threadId, {
      excludedActivityIds: context.completedCommandIdsBeforeFinalList
    }).finally(() => {
      if (this.turns.get(context.threadId) === context) {
        this.publishStatusCleared(context.threadId)
      }
      this.finishDebugExecution(context, outcome, context.failure)
      context.emit({
        type: 'done',
        outcome
      })
      if (context.abortListener) {
        context.signal.removeEventListener('abort', context.abortListener)
      }
      if (this.turns.get(context.threadId) === context) {
        this.turns.delete(context.threadId)
      }
    })
  }

  private finishDebugExecution(
    context: TurnContext,
    outcome: 'completed' | 'failed' | 'interrupted',
    error?: string
  ): void {
    if (context.debugSummaryEmitted) return
    context.debugSummaryEmitted = true
    const fields = {
      harnessId: 'codex',
      purpose: this.launchOptions.debugPurpose || 'thread',
      executionId: context.executionId,
      ...(context.debugThreadId ? { threadId: context.debugThreadId } : {}),
      turnId: context.turnId || null,
      nativeSessionId: context.threadId,
      nativeThreadId: context.threadId,
      outcome,
      durationMs: debugDuration(context.debugStartedAt),
      messageSentDurationMs: context.firstMessageSentAt === undefined
        ? null
        : Math.max(0, context.firstMessageSentAt - context.debugStartedAt),
      firstReasoningDurationMs: context.firstReasoningAt === undefined
        ? null
        : Math.max(0, context.firstReasoningAt - context.debugStartedAt),
      firstTextDurationMs: context.firstTextAt === undefined
        ? null
        : Math.max(0, context.firstTextAt - context.debugStartedAt),
      error: error || null
    }
    inDebugContext(context.debugContext, () => {
      if (outcome === 'failed') context.debugSpan?.fail(
        new Error(error || 'Codex execution failed'),
        fields
      )
      else context.debugSpan?.end(fields)
      debugLog('codex.execution.summary', fields)
    })
    if (this.debugContextsByExecution.get(context.executionId) === context) {
      this.debugContextsByExecution.delete(context.executionId)
    }
  }

  private refreshBackgroundTerminals(
    threadId: string,
    options: BackgroundTerminalRefreshOptions = {}
  ): Promise<void> {
    const child = this.process
    const previous = this.backgroundTerminalRefreshes.get(threadId)
    const ready = previous?.then(() => undefined, () => undefined) || Promise.resolve()
    const operation = ready.then(() => {
      if (!child || this.process !== child) return
      return this.performBackgroundTerminalRefresh(threadId, options, child)
    })
    this.backgroundTerminalRefreshes.set(threadId, operation)
    void operation.finally(() => {
      if (this.backgroundTerminalRefreshes.get(threadId) === operation) {
        this.backgroundTerminalRefreshes.delete(threadId)
      }
    })
    return operation
  }

  private async performBackgroundTerminalRefresh(
    threadId: string,
    options: BackgroundTerminalRefreshOptions,
    child: ChildProcessWithoutNullStreams,
    reconciliationAttempt = 0
  ): Promise<void> {
    if (this.process !== child || this.disposed || !this.loadedThreads.has(threadId)) return
    const revision = this.backgroundTerminalRevisions.get(threadId) || 0
    try {
      const listed = await this.listBackgroundTerminals(threadId, child)
      if (this.process !== child || this.disposed || !this.loadedThreads.has(threadId)) return
      if ((this.backgroundTerminalRevisions.get(threadId) || 0) !== revision &&
        reconciliationAttempt === 0 && !this.disposed && this.loadedThreads.has(threadId)) {
        await this.performBackgroundTerminalRefresh(threadId, options, child, 1)
        return
      }
      for (const activityId of options.excludedActivityIds || []) {
        this.rememberBackgroundTerminalCompletion(threadId, activityId)
      }
      const listedIds = new Set(listed.map((terminal) => terminal.id))
      const tombstones = this.backgroundTerminalTombstones.get(threadId)
      const terminals = listed.filter((terminal) =>
        !options.excludedActivityIds?.has(terminal.id) && !tombstones?.has(terminal.id)
      )
      if (tombstones) {
        for (const activityId of tombstones) {
          if (!listedIds.has(activityId)) tombstones.delete(activityId)
        }
        if (tombstones.size === 0) this.backgroundTerminalTombstones.delete(threadId)
      }
      const nextIds = new Set(terminals.map((terminal) => terminal.id))
      for (const terminal of this.backgroundTerminalsByThread.get(threadId) || []) {
        if (!nextIds.has(terminal.id)) {
          this.rememberBackgroundTerminalCompletion(threadId, terminal.id)
          this.publishBackgroundActivityCompleted(
            threadId,
            terminal.id,
            'completed',
            'Codex 后台终端已结束'
          )
        }
      }
      this.publishBackgroundTerminals(threadId, terminals)
    } catch (error) {
      if (!this.warnedBackgroundTerminals && !this.disposed && this.process === child) {
        this.warnedBackgroundTerminals = true
        console.warn(
          `Unable to list Codex background terminals for thread ${threadId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
  }

  private async listBackgroundTerminals(
    threadId: string,
    child: ChildProcessWithoutNullStreams
  ): Promise<CodexBackgroundTerminal[]> {
    let lastError: Error | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.process !== child || this.disposed) return []
      try {
        return await this.listBackgroundTerminalsOnce(threadId, child)
      } catch (error) {
        lastError = asError(error)
        if (attempt === 0) await waitForPoll(100)
      }
    }
    throw lastError || new Error('Codex background terminals list 失败')
  }

  private async listBackgroundTerminalsOnce(
    threadId: string,
    child: ChildProcessWithoutNullStreams
  ): Promise<CodexBackgroundTerminal[]> {
    const terminals: CodexBackgroundTerminal[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      if (this.process !== child || this.disposed) return []
      const response = record(await this.request('thread/backgroundTerminals/list', {
        threadId,
        limit: 1_000,
        ...(cursor ? { cursor } : {})
      }, BACKGROUND_TERMINALS_TIMEOUT_MS))
      const page = parseBackgroundTerminals(response.data)
      if (!page) throw new Error('Codex 返回了无效的 background terminals 列表')
      terminals.push(...page)
      if (terminals.length > MAX_BACKGROUND_TERMINALS) {
        throw new Error('Codex background terminals 数量超过本地上限')
      }
      if (response.nextCursor === null || response.nextCursor === undefined) break
      if (typeof response.nextCursor !== 'string' || !response.nextCursor.trim()) {
        throw new Error('Codex 返回了无效的 background terminals cursor')
      }
      cursor = response.nextCursor
      if (cursors.has(cursor)) throw new Error('Codex background terminals cursor 重复')
      cursors.add(cursor)
    } while (cursor)
    return terminals.sort((left, right) => left.id.localeCompare(right.id))
  }

  private handleBackgroundActivityCompleted(threadId: string, item: UnknownRecord): boolean {
    if (item.type !== 'commandExecution') return false
    const activityId = string(item.id)
    if (!activityId) return false
    const current = this.backgroundTerminalsByThread.get(threadId) || []
    const tracked = current.some((terminal) => terminal.id === activityId)
    const alreadyCompleted = this.backgroundTerminalTombstones.get(threadId)?.has(activityId)
    if (!tracked && !alreadyCompleted) return false
    if (tracked) {
      this.bumpBackgroundTerminalRevision(threadId)
      this.rememberBackgroundTerminalCompletion(threadId, activityId)
      this.publishBackgroundActivityCompleted(
        threadId,
        activityId,
        completedActivityStatus(item),
        completedDetail(item)
      )
      this.publishBackgroundTerminals(
        threadId,
        current.filter((terminal) => terminal.id !== activityId)
      )
    }
    return true
  }

  private publishBackgroundActivityCompleted(
    threadId: string,
    activityId: string,
    status: 'completed' | 'failed' | 'cancelled',
    detail?: string
  ): void {
    const event: CodexNativeActivityEvent = {
      type: 'background-activity-completed',
      threadId,
      activityId,
      status,
      ...(detail ? { detail } : {}),
      at: Date.now()
    }
    for (const listener of this.activityListeners) listener(event)
  }

  private publishBackgroundTerminals(
    threadId: string,
    terminals: readonly CodexBackgroundTerminal[]
  ): void {
    const sorted = [...terminals].sort((left, right) => left.id.localeCompare(right.id))
    const current = this.backgroundTerminalsByThread.get(threadId)
    if ((!current?.length && sorted.length === 0) || sameBackgroundTerminals(current, sorted)) {
      return
    }
    if (sorted.length) this.backgroundTerminalsByThread.set(threadId, sorted)
    else this.backgroundTerminalsByThread.delete(threadId)
    const event: CodexNativeActivityEvent = {
      type: 'background-terminals',
      threadId,
      terminals: sorted.map((terminal) => ({ ...terminal })),
      at: Date.now()
    }
    for (const listener of this.activityListeners) listener(event)
  }

  private rememberBackgroundTerminalCompletion(threadId: string, activityId: string): void {
    let tombstones = this.backgroundTerminalTombstones.get(threadId)
    if (!tombstones) {
      tombstones = new Set()
      this.backgroundTerminalTombstones.set(threadId, tombstones)
    }
    if (!tombstones.has(activityId) && tombstones.size >= MAX_BACKGROUND_TOMBSTONES) {
      const oldest = tombstones.values().next().value
      if (oldest !== undefined) tombstones.delete(oldest)
    }
    tombstones.add(activityId)
  }

  private bumpBackgroundTerminalRevision(threadId: string): void {
    this.backgroundTerminalRevisions.set(
      threadId,
      (this.backgroundTerminalRevisions.get(threadId) || 0) + 1
    )
  }

  private clearThreadBackgroundActivities(
    threadId: string,
    status: 'failed' | 'cancelled',
    detail: string
  ): void {
    this.bumpBackgroundTerminalRevision(threadId)
    for (const terminal of this.backgroundTerminalsByThread.get(threadId) || []) {
      this.rememberBackgroundTerminalCompletion(threadId, terminal.id)
      this.publishBackgroundActivityCompleted(threadId, terminal.id, status, detail)
    }
    this.publishBackgroundTerminals(threadId, [])
    this.backgroundTerminalTombstones.delete(threadId)
  }

  private clearAllBackgroundActivities(status: 'failed' | 'cancelled', detail: string): void {
    const threadIds = new Set([
      ...this.loadedThreads,
      ...this.backgroundTerminalsByThread.keys(),
      ...this.backgroundTerminalTombstones.keys()
    ])
    for (const threadId of threadIds) {
      this.clearThreadBackgroundActivities(threadId, status, detail)
    }
    this.backgroundTerminalRefreshes.clear()
  }

  private publishStatusCleared(threadId: string): void {
    const event: CodexNativeActivityEvent = {
      type: 'status-cleared',
      threadId,
      at: Date.now()
    }
    for (const listener of this.activityListeners) listener(event)
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return
    this.process = undefined
    this.launchPromise = undefined
    // A broken pipe or failed process can still own a live detached group.
    // Keep that generation reachable until termination settles so dispose
    // also joins cleanup after a replacement process has been launched.
    void this.terminateChild(child).catch((cleanupError) => {
      console.warn('Unable to terminate failed Codex app-server:', cleanupError)
    })
    const loadedThreadIds = new Set([
      ...this.loadedThreads,
      ...this.turns.keys(),
      ...this.backgroundTerminalsByThread.keys()
    ])
    this.clearAllBackgroundActivities('failed', error.message)
    for (const threadId of loadedThreadIds) this.publishStatusCleared(threadId)
    this.loadedThreads.clear()
    this.threadModels.clear()
    this.models = undefined
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const context of this.turns.values()) {
      if (context.terminal) continue
      context.terminal = true
      context.controller.abort(error)
      context.emit({ type: 'error', message: error.message })
      this.finishDebugExecution(context, 'failed', error.message)
      context.emit({ type: 'done', outcome: 'failed' })
      if (context.abortListener) {
        context.signal.removeEventListener('abort', context.abortListener)
      }
    }
    this.turns.clear()
    this.debugContextsByExecution.clear()
    this.loadedThreads.clear()
    this.threadModels.clear()
    for (const pending of this.interactions.values()) {
      if (pending.timer) clearTimeout(pending.timer)
    }
    this.interactions.clear()
  }

  private captureDebugContext(context: DebugContext): void {
    if (!this.debugContext.traceId && !this.debugContext.spanId) {
      this.debugContext = context
    }
  }
}

function assertNativeApprovalSettings(response: UnknownRecord, settings: CodexThreadSettings): void {
  if (!settings.approvalsReviewer) return
  if (response.approvalsReviewer !== settings.approvalsReviewer ||
      settings.approvalPolicy && response.approvalPolicy !== settings.approvalPolicy ||
      settings.sandbox && record(response.sandbox).type !== {
        'workspace-write': 'workspaceWrite', 'read-only': 'readOnly',
        'danger-full-access': 'dangerFullAccess'
      }[settings.sandbox]) {
    throw new Error('Codex runtime 未确认请求的权限配置（含 approvalsReviewer）；拒绝启动任务，不能降级权限模式')
  }
}

function turnSettings(
  settings: CodexThreadSettings & { readonly outputSchema?: UnknownRecord },
  managedWritableRoots: readonly string[] = []
): UnknownRecord {
  const sandbox = turnSandboxPolicy(settings, managedWritableRoots)
  return {
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {}),
    ...(settings.personality ? { personality: settings.personality } : {}),
    ...(settings.approvalPolicy ? { approvalPolicy: settings.approvalPolicy } : {}),
    ...(settings.approvalsReviewer ? { approvalsReviewer: settings.approvalsReviewer } : {}),
    ...(settings.summary ? { summary: settings.summary } : {}),
    ...(settings.outputSchema ? { outputSchema: settings.outputSchema } : {}),
    ...(sandbox ? { sandboxPolicy: sandbox } : {})
  }
}

function turnSandboxPolicy(
  settings: CodexThreadSettings,
  managedWritableRoots: readonly string[]
): UnknownRecord | undefined {
  if (settings.sandboxPolicy?.type === 'workspaceWrite') {
    return {
      ...structuredClone(settings.sandboxPolicy),
      writableRoots: managedWritableRoots.length
        ? uniqueStrings(managedWritableRoots)
        : uniqueStrings(settings.sandboxPolicy.writableRoots)
    }
  }
  if (settings.sandboxPolicy) return structuredClone(settings.sandboxPolicy)
  if (settings.sandbox) return sandboxPolicy(settings.sandbox, managedWritableRoots)
  return managedWritableRoots.length
    ? sandboxPolicy('workspace-write', managedWritableRoots)
    : undefined
}

function threadSandbox(settings: CodexThreadSettings): UnknownRecord {
  const policy = settings.sandboxPolicy
  if (!policy) return { sandbox: settings.sandbox || 'workspace-write' }
  if (policy.type === 'readOnly') return { sandbox: 'read-only' }
  if (policy.type === 'workspaceWrite') return { sandbox: 'workspace-write' }
  return { sandbox: 'danger-full-access' }
}

function sandboxPolicy(
  mode: NonNullable<CodexThreadSettings['sandbox']>,
  writableRoots: readonly string[] = []
): UnknownRecord {
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false }
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  return {
    type: 'workspaceWrite',
    writableRoots: uniqueStrings(writableRoots),
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  }
}

interface ManagedWorkspaceWriteTranslation {
  readonly writableRoots: readonly string[]
  readonly instructions: string
}

function managedWorkspaceWrite(
  options: Pick<CodexTurnOptions, 'cwd' | 'workspaceWriteGrant'>
): ManagedWorkspaceWriteTranslation | undefined {
  const grant = options.workspaceWriteGrant
  if (!grant) return undefined
  if (grant.kind !== 'managed-linked-worktree' || grant.cwd !== options.cwd) {
    throw new Error('Codex managed workspace-write grant 与 turn cwd 不匹配')
  }
  return {
    writableRoots: uniqueStrings(grant.writableRoots),
    instructions: CODEX_WORKTREE_GIT_INSTRUCTIONS
  }
}

function withManagedWorktreeConfig(
  config: UnknownRecord | undefined,
  roots: readonly string[]
): UnknownRecord {
  const workspaceWrite = record(config?.sandbox_workspace_write)
  return {
    ...config,
    sandbox_workspace_write: {
      ...workspaceWrite,
      // A managed worktree's extra native write authority comes exclusively
      // from the Core-verified grant. Provider config may tune other native
      // fields, but it cannot add an unverified filesystem root.
      writable_roots: uniqueStrings(roots)
    }
  }
}

function appendInstructions(
  existing: string | undefined,
  instructions: string | undefined
): string | undefined {
  const left = existing?.trim()
  const right = instructions?.trim()
  if (left && right) return `${left}\n\n${right}`
  return left || right
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

const MCP_FORM_VALUES_QUESTION_ID = 'values'

// The current native command/file approval protocol defines these decisions
// in its response union; neither request has an availableDecisions field.
const CODEX_APPROVAL_ACTIONS = [
  { id: 'allow-once', intent: 'allow', label: '允许一次' },
  { id: 'allow-session', intent: 'allow', label: '本会话允许' },
  { id: 'deny', intent: 'deny', label: '拒绝' },
  { id: 'cancel', intent: 'cancel', label: '取消' }
] as const satisfies CodexInteraction['actions']

const CODEX_APPROVAL_DECISIONS = {
  'allow-once': 'accept',
  'allow-session': 'acceptForSession',
  deny: 'decline',
  cancel: 'cancel'
} as const

export function parseInteraction(method: string, params: UnknownRecord): CodexInteraction | undefined {
  const id = string(params.interactionId) || string(params.elicitationId) || randomUUID()
  if (method === 'item/commandExecution/requestApproval') {
    return {
      id,
      kind: 'command-approval',
      title: string(params.reason) || 'Codex 请求运行命令',
      ...(string(params.command) || compact(params.commandActions)
        ? { detail: string(params.command) || compact(params.commandActions) }
        : {}),
      blocksTurn: true,
      status: 'pending',
      actions: CODEX_APPROVAL_ACTIONS,
      questions: []
    }
  }
  if (method === 'item/fileChange/requestApproval') {
    return {
      id,
      kind: 'file-approval',
      title: string(params.reason) || 'Codex 请求修改文件',
      ...(string(params.grantRoot) ? { detail: string(params.grantRoot) } : {}),
      blocksTurn: true,
      status: 'pending',
      actions: CODEX_APPROVAL_ACTIONS,
      questions: []
    }
  }
  if (method === 'item/permissions/requestApproval') {
    return {
      id,
      kind: 'permissions',
      title: string(params.reason) || 'Codex 请求额外权限',
      ...(compact(params.permissions) ? { detail: compact(params.permissions) } : {}),
      blocksTurn: true,
      status: 'pending',
      actions: CODEX_APPROVAL_ACTIONS.filter(action => action.id !== 'cancel'),
      questions: []
    }
  }
  if (method === 'item/tool/requestUserInput') {
    if (typeof params.isBlocking !== 'boolean') {
      throw new Error('Codex requestUserInput 缺少 isBlocking')
    }
    if (!Array.isArray(params.questions)) {
      throw new Error('Codex requestUserInput questions 必须是数组')
    }
    return {
      id,
      kind: 'user-input',
      title: 'Codex 需要补充信息',
      // Core only accepts interaction responses while an Execution is in its
      // waiting-for-user state. A native non-blocking request still needs a
      // response, so bridge it as waiting until Codex resolves or completes it.
      blocksTurn: true,
      status: 'pending',
      actions: [
        { id: 'submit', intent: 'submit', label: '提交' },
        { id: 'cancel', intent: 'cancel', label: '取消' }
      ],
      questions: params.questions.map(parseQuestion)
    }
  }
  if (method === 'mcpServer/elicitation/request') {
    const mode = string(params.mode)
    if (mode && mode !== 'form' && mode !== 'openai/form' && mode !== 'url') {
      return undefined
    }
    const serverName = string(params.serverName)
    const url = string(params.url)
    const isUrl = mode === 'url'
    if (isUrl && !url) throw new Error('Codex MCP URL elicitation 缺少 URL')
    const requestedSchema = params.requestedSchema ?? {}
    if (!isUrl && (!isRecord(requestedSchema) || !isJsonValue(requestedSchema))) {
      throw new Error('Codex MCP form elicitation schema 必须是 JSON object')
    }
    return {
      id,
      kind: 'mcp-elicitation',
      elicitation: isUrl
        ? { mode: 'url', url }
        : {
            mode: 'form',
            requestedSchema: requestedSchema as JsonObject,
            questionId: MCP_FORM_VALUES_QUESTION_ID
          },
      title: string(params.message) || (serverName
        ? `${serverName} 请求输入`
        : 'MCP server 请求输入'),
      blocksTurn: true,
      status: 'pending',
      actions: [
        { id: 'submit', intent: 'submit', label: '提交' },
        { id: 'deny', intent: 'deny', label: '拒绝' },
        { id: 'cancel', intent: 'cancel', label: '取消' }
      ],
      questions: isUrl
        ? []
        : [{
            id: MCP_FORM_VALUES_QUESTION_ID,
            prompt: 'JSON form values',
            secret: false,
            allowOther: true,
            options: []
          }]
    }
  }
  return undefined
}

function parseQuestion(value: unknown): CodexInteractionQuestion {
  if (!isRecord(value) || !string(value.id)) {
    throw new Error('Codex requestUserInput question 缺少 ID')
  }
  const id = string(value.id)
  if (value.options !== undefined && value.options !== null && !Array.isArray(value.options)) {
    throw new Error('Codex requestUserInput question options 必须是数组')
  }
  return {
    id,
    ...(string(value.header) ? { header: string(value.header) } : {}),
    prompt: string(value.question) || 'Codex question',
    secret: value.isSecret === true,
    allowOther: value.isOther === true,
    options: Array.isArray(value.options)
      ? value.options.map((option, index) => {
          if (!isRecord(option) || !string(option.label)) {
            throw new Error('Codex requestUserInput option 缺少 label')
          }
          return {
            id: `${id}:option:${index}`,
            label: string(option.label),
            ...(string(option.description) ? { description: string(option.description) } : {})
          }
        })
      : []
  }
}

export function encodeInteractionResponse(
  pending: CodexInteractionRequest,
  response: JsonValue
): UnknownRecord {
  if (!isRecord(response)) throw new Error('Codex interaction response 必须是对象')
  const actionId = string(response.actionId)
  if (!pending.interaction.actions.some((action) => action.id === actionId)) {
    throw new Error(`Codex interaction action 不可用：${actionId}`)
  }
  if (pending.interaction.kind === 'mcp-elicitation') {
    if (actionId === 'deny' || actionId === 'cancel') {
      return {
        action: actionId === 'deny' ? 'decline' : 'cancel',
        content: null,
        _meta: null
      }
    }
    const elicitation = pending.interaction.elicitation
    if (elicitation.mode === 'url') {
      return { action: 'accept', content: {}, _meta: null }
    }
    const answers = isRecord(response.answers) ? response.answers : {}
    const encoded = answers[elicitation.questionId]
    if (typeof encoded !== 'string') {
      throw new Error('Codex MCP elicitation 缺少 JSON form values')
    }
    let content: unknown
    try {
      content = JSON.parse(encoded)
    } catch (error) {
      throw new Error('Codex MCP elicitation form values 不是有效 JSON', { cause: error })
    }
    if (!isRecord(content) || !isJsonValue(content)) {
      throw new Error('Codex MCP elicitation form values 必须是 JSON object')
    }
    return {
      action: 'accept',
      content,
      // Native Codex reserves response metadata for accepted form-mode
      // handling. Preserve the request metadata exactly in that case; a
      // decline, cancel, or URL response must not invent/echo form metadata.
      _meta: isJsonValue(pending.params._meta) ? pending.params._meta : null
    }
  }
  if (pending.interaction.kind === 'user-input') {
    const answers = isRecord(response.answers) ? response.answers : {}
    return {
      answers: Object.fromEntries(
        Object.entries(answers).flatMap(([id, answer]) => {
          if (typeof answer === 'string') {
            return [[id, { answers: nativeQuestionAnswers(pending.interaction, id, [answer]) }]]
          }
          if (Array.isArray(answer) && answer.every((item) => typeof item === 'string')) {
            return [[id, { answers: nativeQuestionAnswers(pending.interaction, id, answer) }]]
          }
          return []
        })
      )
    }
  }
  if (pending.interaction.kind === 'permissions') {
    return {
      permissions: actionId.startsWith('allow') && isJsonValue(pending.params.permissions)
        ? pending.params.permissions
        : {},
      scope: actionId === 'allow-session' ? 'session' : 'turn'
    }
  }
  const decision = CODEX_APPROVAL_DECISIONS[
    actionId as keyof typeof CODEX_APPROVAL_DECISIONS
  ]
  if (!decision) {
    throw new Error(`Codex native approval 不支持 action：${actionId}`)
  }
  return { decision }
}

export function defaultInteractionDecline(
  pending: CodexInteractionRequest
): {
  readonly response: { readonly result: UnknownRecord } | { readonly error: UnknownRecord }
  readonly resolution: string
} {
  if (pending.method === 'item/permissions/requestApproval') {
    return {
      response: { result: { permissions: {}, scope: 'turn' } },
      resolution: 'decline'
    }
  }
  if (pending.method === 'item/tool/requestUserInput') {
    return { response: { result: { answers: {} } }, resolution: 'cancel' }
  }
  if (pending.method === 'mcpServer/elicitation/request') {
    return {
      response: { result: { action: 'cancel', content: null, _meta: null } },
      resolution: 'cancel'
    }
  }
  return { response: { result: { decision: 'cancel' } }, resolution: 'cancel' }
}

export function nativeQuestionAnswers(
  interaction: CodexInteraction,
  questionId: string,
  answers: readonly string[]
): string[] {
  const options = interaction.questions.find((question) => question.id === questionId)?.options || []
  return answers.map((answer) =>
    options.find((option) => option.id === answer)?.label || answer
  )
}

function parsePlanStep(value: unknown) {
  if (!isRecord(value)) return []
  const step = string(value.step)
  const status = string(value.status)
  if (!step || !['pending', 'inProgress', 'completed'].includes(status)) return []
  return [{ step, status: status as 'pending' | 'inProgress' | 'completed' }]
}

function parseActivity(item: UnknownRecord): CodexActivity | undefined {
  const id = string(item.id)
  if (!id) return undefined
  const base = { id, status: 'running' as const }
  if (item.type === 'commandExecution') {
    return optional(
      { ...base, kind: 'command' as const, label: string(item.command) || '运行命令' },
      'detail',
      string(item.cwd) || undefined
    )
  }
  if (item.type === 'fileChange') {
    return optional({ ...base, kind: 'file' as const, label: '修改文件' }, 'detail', compact(item.changes))
  }
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    const tool = string(item.tool)
    const label = item.type === 'dynamicToolCall'
      ? tool || '调用 OpenAgent 工具'
      : [string(item.server), tool].filter(Boolean).join(' / ') || '调用 MCP 工具'
    return optional(
      optional({ ...base, kind: 'tool' as const, label }, 'detail', compact(item.arguments)),
      'toolName',
      // Canonical name as Codex reports it. Injected tools register under their
      // own name; MCP calls stay qualified by server so equal names stay distinct.
      item.type === 'dynamicToolCall'
        ? tool || undefined
        : [string(item.server), tool].filter(Boolean).join('/') || undefined
    )
  }
  if (item.type === 'webSearch') {
    return optional(
      { ...base, kind: 'search' as const, label: string(item.query) || '搜索网络' },
      'detail',
      compact(item.action)
    )
  }
  if (item.type === 'imageView') {
    return optional(
      { ...base, kind: 'tool' as const, label: '查看图片' },
      'detail',
      string(item.path) || undefined
    )
  }
  if (item.type === 'imageGeneration') {
    return optional(
      { ...base, kind: 'tool' as const, label: '生成图片' },
      'detail',
      compact(item)
    )
  }
  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    return optional(
      { ...base, kind: 'review' as const, label: item.type === 'enteredReviewMode' ? '开始代码审查' : '完成代码审查' },
      'detail',
      string(item.review) || undefined
    )
  }
  if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') {
    return optional(
      {
        ...base,
        kind: 'subagent' as const,
        label: `${item.type === 'subAgentActivity' ? '子 Agent' : '协作 Agent'}：${
          string(item.tool) || string(item.kind)
        }`
      },
      'detail',
      compact(item)
    )
  }
  return undefined
}

function isActivityItem(item: UnknownRecord): boolean {
  return [
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'dynamicToolCall',
    'webSearch',
    'imageView',
    'imageGeneration',
    'enteredReviewMode',
    'exitedReviewMode',
    'collabAgentToolCall',
    'subAgentActivity'
  ].includes(string(item.type))
}

function completedDetail(item: UnknownRecord): string | undefined {
  if (item.type === 'commandExecution') return tail(string(item.aggregatedOutput), 32 * 1024) || undefined
  if (item.type === 'fileChange') return compact(item.changes)
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    return compact(item.result || item.error)
  }
  return compact(item)
}

function finalAgentMessages(turn: UnknownRecord): Array<{ id: string; text: string }> | undefined {
  if (!Array.isArray(turn.items)) return []
  const messages: Array<{ id: string; text: string }> = []
  for (const value of turn.items) {
    if (!isRecord(value) || value.type !== 'agentMessage') continue
    if (!isCodexAgentMessageId(value.id)) return undefined
    const text = string(value.text)
    messages.push({ id: value.id, text })
  }
  return messages
}

function invalidAgentMessageIdentity(): Error {
  return new Error('Codex app-server agentMessage ID 无效')
}

function failedItem(item: UnknownRecord): boolean {
  return item.status === 'failed' || item.status === 'declined' ||
    item.success === false || Boolean(item.error)
}

function completedActivityStatus(
  item: UnknownRecord
): 'completed' | 'failed' | 'cancelled' {
  return item.status === 'cancelled' || item.status === 'interrupted'
    ? 'cancelled'
    : failedItem(item)
      ? 'failed'
      : 'completed'
}

function parseModel(value: unknown): CodexModelOption[] {
  if (!isRecord(value)) return []
  const model = string(value.model)
  const displayName = string(value.displayName)
  if (!model || !displayName) return []
  return [{
    value: model,
    displayName,
    ...(string(value.description) ? { description: string(value.description) } : {}),
    ...(value.isDefault === true ? { isDefault: true } : {}),
    ...(string(value.defaultReasoningEffort)
      ? { defaultReasoningEffort: string(value.defaultReasoningEffort) }
      : {}),
    supportedReasoningEfforts: Array.isArray(value.supportedReasoningEfforts)
      ? value.supportedReasoningEfforts.flatMap((entry) => {
          if (!isRecord(entry) || !string(entry.reasoningEffort)) return []
          return [{
            value: string(entry.reasoningEffort),
            ...(string(entry.description) ? { description: string(entry.description) } : {})
          }]
        })
      : [],
    serviceTiers: Array.isArray(value.serviceTiers)
      ? value.serviceTiers.flatMap((entry) => {
          if (!isRecord(entry) || !string(entry.id)) return []
          return [{
            value: string(entry.id),
            ...(string(entry.name) ? { displayName: string(entry.name) } : {})
          }]
        })
      : []
  }]
}

function findCodexModel(
  models: readonly CodexModelOption[],
  modelSetting: string | undefined
): CodexModelOption | undefined {
  const normalized = modelSetting?.trim().toLowerCase()
  if (!normalized || normalized === 'codex-default') {
    return models.find((model) => model.isDefault) || models[0]
  }
  return models.find((model) => model.value.toLowerCase() === normalized)
}

function disablePluginMcpServers(plugins: UnknownRecord): UnknownRecord {
  return Object.fromEntries(
    Object.entries(plugins).flatMap(([pluginName, pluginValue]) => {
      const servers = record(record(pluginValue).mcp_servers)
      const disabled = Object.fromEntries(
        Object.keys(servers).map((serverName) => [serverName, { enabled: false }])
      )
      return Object.keys(disabled).length
        ? [[pluginName, { mcp_servers: disabled }]]
        : []
    })
  )
}

async function terminateAndWait(child: ChildProcessWithoutNullStreams): Promise<void> {
  const existing = terminatingChildren.get(child)
  if (existing) return existing
  const termination = terminateOnce(child)
  terminatingChildren.set(child, termination)
  return termination
}

async function terminateOnce(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (closedChildren.has(child) && !processGroupExists(child)) return
  const closed = waitForClose(child)
  signalProcess(child, 'SIGTERM')
  if (await terminationSettlesWithin(child, 2_000)) return

  // The detached group may outlive its leader without inheriting stdio, so
  // close/exit alone is not the OS-level termination barrier.
  signalProcess(child, 'SIGKILL')
  if (await terminationSettlesWithin(child, 2_000)) return

  // ChildProcess can fail to publish `exit`/`close` after a detached group is
  // killed (notably while Electron itself is quitting).  Never let that event
  // become an unbounded Main-process shutdown barrier.  Closing our pipe ends
  // gives `close` one final bounded opportunity, then report the exact OS
  // barrier that failed instead of hanging forever.
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
  if (await settlesWithin(closed, 500) && !processGroupExists(child)) return
  if (processGroupExists(child)) {
    throw new Error('Codex app-server process group 在 SIGKILL 后仍然存在')
  }
  throw new Error('Codex app-server 已终止，但 child close barrier 未能收敛')
}

async function terminationSettlesWithin(
  child: ChildProcessWithoutNullStreams,
  milliseconds: number
): Promise<boolean> {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    const groupExists = processGroupExists(child)
    if (!groupExists) {
      // Once the detached OS group is gone there is nothing left to signal.
      // Return immediately even when Node missed `close`; the caller owns the
      // bounded pipe teardown for that exact state.
      return closedChildren.has(child)
    }
    await waitForPoll(Math.min(25, deadline - Date.now()))
  }
  return closedChildren.has(child) && !processGroupExists(child)
}

function processGroupExists(child: ChildProcessWithoutNullStreams): boolean {
  if (process.platform === 'win32' || !child.pid) {
    return child.exitCode === null && child.signalCode === null && !failedChildren.has(child)
  }
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

function waitForPoll(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)))
}

function signalProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through to the direct child when a process group is unavailable.
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
}

function waitForClose(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (closedChildren.has(child)) return Promise.resolve()
  return new Promise((resolve) => child.once('close', () => resolve()))
}

function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds)
    void promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      reject(abortError())
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
    // Even a caller already cancelled during spawn must observe the shared
    // launch's eventual rejection when initialization fails or is disposed.
    if (signal.aborted) abort()
  })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}

function pendingSteer(error: unknown): boolean {
  return error instanceof Error && /no active turn to steer/i.test(error.message)
}

function cleanUsage(value: Record<string, number | undefined>) {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => entry[1] !== undefined)
  ) as {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    contextWindow?: number
  }
}

function cleanGenerationUsage(value: UnknownRecord) {
  return Object.fromEntries(
    [
      ['inputTokens', number(value.inputTokens)],
      ['cachedInputTokens', number(value.cachedInputTokens)],
      ['cacheWriteInputTokens', number(value.cacheWriteInputTokens)],
      ['outputTokens', number(value.outputTokens)],
      ['reasoningOutputTokens', number(value.reasoningOutputTokens)]
    ].filter((entry): entry is [string, number] => entry[1] !== undefined)
  ) as {
    inputTokens?: number
    cachedInputTokens?: number
    cacheWriteInputTokens?: number
    outputTokens?: number
    reasoningOutputTokens?: number
  }
}

function responseSummary(result: UnknownRecord, response: JsonValue): string {
  const actionId = isRecord(response) ? string(response.actionId) : ''
  if (actionId === 'submit') return 'submit'
  if (actionId === 'deny') return 'decline'
  if (actionId === 'cancel') return 'cancel'
  if (actionId === 'allow-session') return 'acceptForSession'
  if (actionId === 'allow-once') return 'accept'
  return string(result.decision) || string(result.action) || string(result.scope) || '已回答'
}

function parseBackgroundTerminals(value: unknown): CodexBackgroundTerminal[] | undefined {
  if (!Array.isArray(value)) return undefined
  const terminals: CodexBackgroundTerminal[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.itemId !== 'string' ||
      typeof item.command !== 'string' || typeof item.cwd !== 'string') {
      return undefined
    }
    terminals.push({ id: item.itemId, command: item.command, cwd: item.cwd })
  }
  return terminals.sort((left, right) => left.id.localeCompare(right.id))
}

function sameBackgroundTerminals(
  left: readonly CodexBackgroundTerminal[] | undefined,
  right: readonly CodexBackgroundTerminal[]
): boolean {
  return Boolean(
    left && left.length === right.length && left.every((terminal, index) => {
      const candidate = right[index]
      return Boolean(candidate && terminal.id === candidate.id &&
        terminal.command === candidate.command && terminal.cwd === candidate.cwd)
    })
  )
}

function formatJson(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function compact(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  try {
    return tail(typeof value === 'string' ? value : JSON.stringify(value, null, 2), 20_000)
  } catch {
    return undefined
  }
}

function tail(value: string, max: number): string {
  return value.length > max ? `…\n${value.slice(-max + 2)}` : value
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nestedString(value: UnknownRecord, key: string, nested: string): string {
  return isRecord(value[key]) ? string(value[key][nested]) : ''
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optional<Base extends object, Key extends string, Value>(
  base: Base,
  key: Key,
  value: Value | undefined
): Base & Partial<Record<Key, Value>> {
  return value === undefined ? base : { ...base, [key]: value }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
