import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname, join } from 'node:path'
import { JsonLines } from '@openagent/plugin-kit/main'
import spawn from 'cross-spawn'
import type { AgentInput } from '@openagent/contracts'
import type { JsonValue } from '@openagent/contracts'
import type {
  ClaudeActivity,
  ClaudeBackgroundTask,
  ClaudeInteraction,
  ClaudeInteractionStatus,
  ClaudePlanStep,
  ClaudeUsage
} from '../../shared/state.js'
import {
  CLAUDE_STATE_LIMITS,
  isBoundedInteractionJson
} from '../../shared/state.js'
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  CLAUDE_EFFORT_LEVELS,
  type ClaudePermissionMode,
  type ClaudeThreadSettings
} from '../../shared/settings.js'
import type { ClaudeToolBridge } from '../tool-bridge.js'
import {
  debugDetail,
  debugDuration,
  debugEnvironmentSummary,
  debugError,
  effectiveDebugContext,
  debugFrame,
  debugLog,
  debugNow,
  getDebugContext,
  inDebugContext,
  startDebugSpan,
  type DebugContext,
  type DebugSpan
} from '../debug.js'

type UnknownRecord = Record<string, unknown>

export type ClaudeExecutionNativeEvent =
  | { type: 'native-execution-start'; nativeExecutionId: string; prompt: string }
  | { type: 'session'; sessionId: string }
  | {
      type: 'runtime'
      runtime: {
        model?: string
        cwd?: string
        claudeVersion?: string
        permissionMode?: string
        backgroundTasks?: ClaudeBackgroundTask[]
      }
    }
  | { type: 'assistant-message-start'; messageId?: string }
  | { type: 'text'; delta: string; messageId?: string; synthetic?: true }
  | { type: 'reasoning'; delta: string }
  | { type: 'status'; label?: string }
  | { type: 'error'; message: string }
  | {
      type: 'done'
      outcome: 'completed' | 'failed' | 'interrupted'
      generation: number
      error?: string
    }
  | { type: 'activity-start'; activity: ClaudeActivity }
  | { type: 'activity-update'; id: string; detail?: string }
  | {
      type: 'activity-end'
      id: string
      status: 'completed' | 'failed' | 'cancelled'
      detail?: string
    }
  | { type: 'interaction'; interaction: ClaudeInteraction }
  | {
      type: 'interaction-resolved'
      id: string
      status: Exclude<ClaudeInteractionStatus, 'pending'>
    }
  | { type: 'plan-update'; plan: ClaudePlanStep[]; explanation?: string }
  | { type: 'diff-update'; diff: string }
  | { type: 'review-update'; text: string }
  | { type: 'context-compacted' }
  | {
      type: 'usage'
      usageKind: 'generation' | 'summary'
      /** In-flight snapshot for display; only stopped generations enter the ledger. */
      provisional?: boolean
      generationId: string
      model: string
      usage: ClaudeUsage
    }
  | { type: 'unsupported-interaction'; message: string }
  | {
      type: 'notice'
      level: 'info' | 'warning' | 'error'
      message: string
    }

export type ClaudeNativeEvent =
  | (ClaudeExecutionNativeEvent & { executionToken: number })
  | {
      type: 'native-notification'
      summary: string
      status?: string
      taskId?: string
    }
  /**
   * The CLI process is gone. Background agents are children of that process,
   * so every task it never reported terminal died with it.
   */
  | { type: 'process-exit' }

export interface ClaudeTransportOptions {
  executable: string
  cwd: string
  environment: NodeJS.ProcessEnv
  providerInjection?: import('@openagent/contracts').ProviderInjection
  sessionId: string
  resume: boolean
  settings: ClaudeThreadSettings
  systemPrompt?: string
  structuredOutputSchema?: Record<string, unknown>
  forkFromSessionId?: string
  forkAtMessageId?: string
  interactive: boolean
  persistSession: boolean
  nativeWorktreeName?: string
  applicationToolsOnly?: boolean
  toolBridge?: ClaudeToolBridge
  /** Diagnostics label for cold/prompt/catalog/usage launches. */
  debugPurpose?: string
  /** Narrow lifecycle timing override used by transport conformance tests. */
  interruptTimeouts?: {
    controlMs?: number
    termMs?: number
    killMs?: number
  }
  onEvent(event: ClaudeNativeEvent): void | Promise<void>
}

interface PendingControl {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  debugContext?: DebugContext
}

interface PendingInteraction {
  id: string
  kind: ClaudeInteraction['kind']
  interaction: ClaudeInteraction
  request: UnknownRecord
  executionToken: number
}

interface ResultBoundary {
  messageId: string
  admitted: boolean
  lifecycleEnded: boolean
  sawTextDelta: boolean
  sawReasoningDelta: boolean
}

interface ActiveNativeExecution {
  executionId: string
  token: number
  generation: number
  syntheticInteractionWake?: boolean
  boundaries: ResultBoundary[]
  cancelled: boolean
  deferredOutcome?: 'completed' | 'failed'
  deferredError?: string
  pendingCompletion?: {
    outcome: 'completed' | 'failed' | 'interrupted'
    error?: string
  }
  completionToken?: object
  acceptingFollowups: boolean
  /** Native result.modelUsage is cumulative across this execution. */
  modelCosts: Map<string, number>
  debugContext: DebugContext
  debugSpan: DebugSpan
  debugStartedAt: number
  firstMessageSentAt?: number
  firstReasoningAt?: number
  firstTextAt?: number
  debugSummaryEmitted: boolean
}

interface ClaudeMessageUsageAccumulator {
  readonly generationId: string
  readonly model: string
  usage: ClaudeUsage
}

interface StreamParserState {
  sawTextDelta: boolean
  sawReasoningDelta: boolean
  tools: Map<number, { id: string; name: string; input: unknown; partialJson: string }>
  knownToolIds: Set<string>
  nativeTasks: Map<string, ClaudePlanStep>
  pendingTaskMutations: Map<string, ClaudeNativeTaskMutation>
  messageUsageByStream: Map<string, ClaudeMessageUsageAccumulator>
}

type ClaudeNativeTaskMutation =
  | { type: 'create'; step: string }
  | {
      type: 'update'
      taskId: string
      step?: string
      status?: ClaudePlanStep['status'] | 'deleted'
    }

export class ClaudeTransport {
  private child?: ChildProcessWithoutNullStreams
  private providerSettingsDirectory?: string
  private decoder = new JsonLines()
  private stderr = ''
  private disposed = false
  private disposePromise?: Promise<void>
  private stopping = false
  private initialized?: Promise<unknown>
  private failedProcessShutdown?: Promise<void>
  private sessionEstablished: boolean
  private active?: ActiveNativeExecution
  private parser: StreamParserState = createParserState()
  private settings: ClaudeThreadSettings
  private readonly controls = new Map<string, PendingControl>()
  private readonly interactions = new Map<string, PendingInteraction>()
  private readonly localMessageIds = new Set<string>()
  private readonly processGroupIds = new Set<number>()
  private eventQueue: Promise<void> = Promise.resolve()
  private nextExecutionToken = 1
  private lastExecutionToken?: number
  private debugContext = getDebugContext()

  constructor(private readonly options: ClaudeTransportOptions) {
    this.sessionEstablished = options.resume
    this.settings = structuredClone(options.settings)
    if (options.systemPrompt) {
      inDebugContext(this.debugContext, () => debugDetail('claude.system-prompt', {
        purpose: options.debugPurpose || 'thread',
        sessionId: options.sessionId,
        systemPrompt: options.systemPrompt
      }))
    }
  }

  get activeExecutionId(): string | undefined {
    return this.active?.executionId
  }

  async inspectInitialization(): Promise<unknown> {
    this.assertOpen()
    const reused = Boolean(this.child && !this.child.killed && this.initialized)
    const span = startDebugSpan(
      reused ? 'claude.transport.reused' : 'claude.transport.cold',
      {
        harnessId: 'claude',
        purpose: this.options.debugPurpose || 'thread',
        cwd: this.options.cwd,
        sessionId: this.options.sessionId,
        resume: this.options.resume
      }
    )
    this.captureDebugContext(span.context)
    if (this.failedProcessShutdown) {
      try {
        await this.failedProcessShutdown
        this.assertOpen()
      } catch (error) {
        span.fail(error)
        debugError('claude.transport.lifecycle-error', error, {
          purpose: this.options.debugPurpose || 'thread',
          phase: 'failed-process-shutdown'
        })
        throw error
      }
    }
    try {
      this.assertOpen()
      if (!this.child || this.child.killed) {
        this.spawn({ parts: [] })
        this.initialized = this.initialize()
      }
      const result = await this.initialized
      span.end({ reused, initialized: true })
      return result
    } catch (error) {
      span.fail(error)
      debugError('claude.transport.lifecycle-error', error, {
        purpose: this.options.debugPurpose || 'thread',
        phase: reused ? 'reuse' : 'cold'
      })
      throw error
    }
  }

  /** Read-only native subscription quota capability owned by the Claude Plugin. */
  async readUsage(signal?: AbortSignal): Promise<unknown> {
    if (signal) throwIfAborted(signal)
    const initialized = this.inspectInitialization()
    if (signal) await abortable(initialized, signal)
    else await initialized
    if (signal) throwIfAborted(signal)
    const request = this.requestControl({ subtype: 'get_usage' }, 7_500)
    return signal ? abortable(request, signal) : request
  }

  async send(
    executionId: string,
    input: AgentInput,
    priority: 'now' | 'next',
    signal: AbortSignal
  ): Promise<{ executionToken: number; generation: number; messageId: string }> {
    throwIfAborted(signal)
    this.assertOpen()
    if (this.active && this.active.executionId !== executionId) {
      throw new Error('Claude transport 已有其他 Execution')
    }
    if (this.active && !this.active.acceptingFollowups) {
      throw new Error('Claude Execution 正在失败收敛，不能接受追加输入')
    }
    if (!this.active) {
      const token = this.nextExecutionToken++
      const debugSpan = startDebugSpan('claude.execution', {
        harnessId: 'claude',
        purpose: this.options.debugPurpose || 'thread',
        executionId,
        nativeSessionId: this.options.sessionId
      })
      this.active = {
        executionId,
        token,
        generation: 0,
        boundaries: [],
        cancelled: false,
        acceptingFollowups: true,
        modelCosts: new Map(),
        debugContext: debugSpan.context,
        debugSpan,
        debugStartedAt: debugNow(),
        debugSummaryEmitted: false
      }
      this.parser = createParserState()
    }
    const active = this.active
    if (!active) throw new Error('Claude execution context 缺失')
    this.captureDebugContext(active.debugContext)
    await this.ensureStarted(input, signal)
    throwIfAborted(signal)
    const content = await agentInputToClaudeContent(input, signal)
    throwIfAborted(signal)
    const previousCompletionToken = active.completionToken
    const previousGeneration = active.generation
    const previousPendingCompletion = active.pendingCompletion
    const generation = previousGeneration + 1
    active.generation = generation
    active.completionToken = undefined
    active.pendingCompletion = undefined
    const messageId = randomUUID()
    const boundary: ResultBoundary = {
      messageId,
      admitted: false,
      lifecycleEnded: false,
      sawTextDelta: false,
      sawReasoningDelta: false
    }
    this.active.boundaries.push(boundary)
    this.localMessageIds.add(messageId)
    try {
      throwIfAborted(signal)
      await this.write({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: this.options.sessionId,
        uuid: messageId,
        priority,
        origin: { kind: 'human' }
      })
      const sentAt = debugNow()
      active.firstMessageSentAt ??= sentAt
      inDebugContext(active.debugContext, () => debugLog('claude.message.sent', {
        harnessId: 'claude',
        executionId,
        nativeSessionId: this.options.sessionId,
        generation,
        messageId,
        priority,
        durationMs: debugDuration(active.debugStartedAt)
      }))
      return { executionToken: active.token, generation, messageId }
    } catch (error) {
      this.localMessageIds.delete(messageId)
      const current = this.active
      if (current === active) {
        const index = current.boundaries.indexOf(boundary)
        if (index >= 0) current.boundaries.splice(index, 1)
      }
      if (this.active === active && active.generation === generation) {
        const failedCompletion = !active.acceptingFollowups
          ? active.pendingCompletion
          : undefined
        active.generation = previousGeneration
        active.completionToken = previousCompletionToken
        active.pendingCompletion = failedCompletion ?? previousPendingCompletion
        if (active.pendingCompletion && active.boundaries.length === 0) {
          this.queueCompletion(
            active,
            active.pendingCompletion.outcome,
            active.pendingCompletion.error
          )
        }
      }
      throw error
    }
  }

  async applySettings(
    next: ClaudeThreadSettings,
    signal: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal)
    const previous = this.settings
    if (!this.child || this.child.killed) {
      this.settings = structuredClone(next)
      return
    }
    if (previous.model !== next.model) {
      await abortable(
        this.requestControl({ subtype: 'set_model', model: next.model || null }),
        signal
      )
      throwIfAborted(signal)
    }
    if (previous.permissionMode !== next.permissionMode) {
      await abortable(
        this.requestControl({
          subtype: 'set_permission_mode',
          mode: next.permissionMode || CLAUDE_DEFAULT_PERMISSION_MODE
        }),
        signal
      )
      throwIfAborted(signal)
    }
    if (previous.effort !== next.effort) {
      await abortable(
        this.requestControl({
          subtype: 'apply_flag_settings',
          settings: { effortLevel: next.effort || null }
        }),
        signal
      )
      throwIfAborted(signal)
    }
    this.settings = structuredClone(next)
  }

  async interrupt(): Promise<void> {
    const active = this.active
    if (!active || active.cancelled) return
    active.cancelled = true
    active.acceptingFollowups = false
    try {
      await this.requestControl(
        { subtype: 'interrupt', cancel_queued: true },
        this.options.interruptTimeouts?.controlMs ?? 10_000
      )
    } catch (error) {
      const child = this.child
      const processGroupIds = [...this.processGroupIds].filter((processGroupId) =>
        processGroupExists(processGroupId)
      )
      this.stopping = true
      signalProcessTree(child, processGroupIds, 'SIGTERM')
      if (!(await waitForProcessTreeExit(
        child,
        processGroupIds,
        this.options.interruptTimeouts?.termMs ?? 2_000
      ))) {
        signalProcessTree(child, processGroupIds, 'SIGKILL')
        if (!(await waitForProcessTreeExit(
          child,
          processGroupIds,
          this.options.interruptTimeouts?.killMs ?? 10_000
        ))) {
          throw new AggregateError(
            [error],
            `Claude interrupt 失败且进程组 SIGKILL 后仍未退出：${processGroupIds.join(', ')}`
          )
        }
      }
      for (const processGroupId of processGroupIds) {
        this.processGroupIds.delete(processGroupId)
      }
      // The fallback just confirmed the process tree is gone, so its background
      // children died with it. The close handler stays silent here (`stopping`),
      // which is why the session end has to be announced explicitly.
      void this.emit({ type: 'process-exit' })
      throw error
    }
  }

  abandonActiveExecution(
    executionId: string,
    preserveInteractions = false
  ): void {
    const active = this.active
    if (active?.executionId === executionId) {
      for (const boundary of active.boundaries) {
        this.localMessageIds.delete(boundary.messageId)
      }
      const pending = [...this.interactions.values()].filter(
        (interaction) => interaction.executionToken === active.token
      )
      const shouldPreserveInteractions =
        !active.cancelled && (preserveInteractions || pending.length > 0)
      if (!shouldPreserveInteractions) {
        for (const interaction of pending) this.interactions.delete(interaction.id)
      }
      this.finishDebugExecution(active, 'interrupted', 'execution abandoned')
      this.active = undefined
      this.parser = createParserState()
      if (shouldPreserveInteractions && pending.length > 0) {
        this.promoteInteractionsToWake(pending)
      }
    }
  }

  async respond(response: JsonValue): Promise<Exclude<ClaudeInteractionStatus, 'pending'>> {
    if (!isRecord(response)) throw new Error('Claude interaction response 必须是 object')
    const interactionId = stringValue(response.interactionId)
    const pending = interactionId ? this.interactions.get(interactionId) : undefined
    if (!pending) throw new Error('Claude interaction 已不存在')
    const behavior = stringValue(response.behavior)
    if (!['allow', 'deny', 'cancel', 'submit'].includes(behavior)) {
      throw new Error('Claude interaction behavior 无效')
    }
    let payload: UnknownRecord
    if (pending.kind === 'permission' || pending.kind === 'question') {
      if (behavior === 'allow' || behavior === 'submit') {
        const rawInput = isRecord(pending.request.input) ? pending.request.input : {}
        payload = {
          behavior: 'allow',
          updatedInput:
            pending.kind === 'question'
              ? {
                  questions: Array.isArray(rawInput.questions)
                    ? rawInput.questions
                    : [],
                  answers: nativeQuestionAnswers(
                    rawInput.questions,
                    response.questionResponses
                  )
                }
              : rawInput,
          toolUseID: stringValue(pending.request.tool_use_id) || undefined,
          ...(response.remember === true &&
          Array.isArray(pending.request.permission_suggestions)
            ? { updatedPermissions: pending.request.permission_suggestions }
            : {})
        }
      } else {
        payload = {
          behavior: 'deny',
          message:
            stringValue(response.message) ||
            (behavior === 'cancel' ? '用户取消了此操作' : '用户拒绝了此操作'),
          toolUseID: stringValue(pending.request.tool_use_id) || undefined
        }
      }
    } else if (pending.kind === 'elicitation') {
      payload =
        behavior === 'allow' || behavior === 'submit'
          ? {
              action: 'accept',
              ...(isRecord(response.values) ? { content: response.values } : {})
            }
          : { action: behavior === 'cancel' ? 'cancel' : 'decline' }
    } else {
      payload =
        behavior === 'allow' || behavior === 'submit'
          ? { behavior: 'completed', result: response.values ?? response.message ?? true }
          : { behavior: 'cancelled' }
    }
    const status = interactionResolutionStatus(pending.kind, behavior)
    await this.writeControlResponse(pending.id, payload)
    this.interactions.delete(interactionId)
    void this.emitExecution(pending.executionToken, {
      type: 'interaction-resolved',
      id: pending.id,
      status
    })
    this.completeInteractionWakeIfSettled(pending.executionToken)
    return status
  }

  async rejectInteraction(id: string, message: string): Promise<void> {
    const pending = this.interactions.get(id)
    if (!pending) return
    this.interactions.delete(id)
    const response =
      pending.kind === 'elicitation'
        ? { action: 'decline' }
        : pending.kind === 'dialog'
          ? { behavior: 'cancelled' }
          : {
              behavior: 'deny',
              message,
              toolUseID: stringValue(pending.request.tool_use_id) || undefined
            }
    await withTimeout(
      this.writeControlResponse(id, response),
      1_000,
      'Claude interaction rejection 写入超时'
    )
    this.completeInteractionWakeIfSettled(pending.executionToken)
  }

  dispose(): Promise<void> {
    this.disposePromise ||= this.disposeUnlocked().finally(async () => {
      if (this.providerSettingsDirectory) await rm(this.providerSettingsDirectory, { recursive: true, force: true })
    })
    return this.disposePromise
  }

  private async disposeUnlocked(): Promise<void> {
    const active = this.active
    if (active) this.finishDebugExecution(active, 'interrupted', 'transport disposed')
    this.disposed = true
    const interactionRejections = [...this.interactions.values()].map(
      (pending) => this.rejectInteraction(
        pending.id,
        'OpenAgent Claude Handle 已关闭'
      ).catch(() => undefined)
    )
    for (const control of this.controls.values()) {
      clearTimeout(control.timer)
      control.reject(new Error('Claude transport 已关闭'))
    }
    this.controls.clear()
    const child = this.child
    const processGroupIds = [...this.processGroupIds].filter((processGroupId) =>
      processGroupExists(processGroupId)
    )
    if (child || processGroupIds.length) {
      this.stopping = true
      // Reject every pending native request concurrently, but do not let a
      // large interaction set delay process termination. SIGTERM is issued in
      // the same turn and both drains share one fixed lifecycle window.
      signalProcessTree(child, processGroupIds, 'SIGTERM')
      const shutdown = (async (): Promise<void> => {
        if (!(await waitForProcessTreeExit(
          child,
          processGroupIds,
          this.options.interruptTimeouts?.termMs ?? 2_000
        ))) {
          signalProcessTree(child, processGroupIds, 'SIGKILL')
          if (!(await waitForProcessTreeExit(
            child,
            processGroupIds,
            this.options.interruptTimeouts?.killMs ?? 10_000
          ))) {
            throw new Error(
              `Claude Code 进程组 SIGKILL 后仍未退出：${processGroupIds.join(', ')}`
            )
          }
        }
      })()
      await Promise.all([
        Promise.allSettled(interactionRejections),
        shutdown,
        this.failedProcessShutdown
      ])
      for (const processGroupId of processGroupIds) {
        this.processGroupIds.delete(processGroupId)
      }
      return
    }
    await Promise.all([
      Promise.allSettled(interactionRejections),
      this.failedProcessShutdown
    ])
  }

  private async ensureStarted(
    input: AgentInput,
    signal: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal)
    const reused = Boolean(this.child && !this.child.killed && this.initialized)
    const span = startDebugSpan(
      reused ? 'claude.transport.reused' : 'claude.transport.cold',
      {
        harnessId: 'claude',
        purpose: this.options.debugPurpose || 'thread',
        cwd: this.options.cwd,
        sessionId: this.options.sessionId,
        resume: this.options.resume
      }
    )
    this.captureDebugContext(span.context)
    if (this.failedProcessShutdown) {
      try {
        await abortable(this.failedProcessShutdown, signal)
        throwIfAborted(signal)
        this.assertOpen()
      } catch (error) {
        span.fail(error)
        debugError('claude.transport.lifecycle-error', error, {
          purpose: this.options.debugPurpose || 'thread',
          phase: 'failed-process-shutdown'
        })
        throw error
      }
    }
    try {
      throwIfAborted(signal)
      this.assertOpen()
      if (this.child && !this.child.killed) {
        await abortable(Promise.resolve(this.initialized), signal)
        throwIfAborted(signal)
        span.end({ reused: true, initialized: true })
        return
      }
      throwIfAborted(signal)
      this.spawn(input)
      this.initialized = this.initialize()
      await abortable(this.initialized, signal)
      throwIfAborted(signal)
      span.end({ reused: false, initialized: true })
    } catch (error) {
      span.fail(error)
      debugError('claude.transport.lifecycle-error', error, {
        purpose: this.options.debugPurpose || 'thread',
        phase: reused ? 'reuse' : 'cold'
      })
      throw error
    }
  }

  private spawn(input: AgentInput): void {
    const environment = withSystemProxy({ ...this.options.environment, ...this.options.providerInjection?.environment })
    const args = buildClaudeArguments(
      this.options,
      this.settings,
      this.sessionEstablished,
      input,
      environment
    )
    if (this.options.providerInjection) {
      // Preserve --settings precedence without putting credentials in argv.
      // Synchronous creation keeps process acquisition atomic across callers.
      const index = args.indexOf('--settings')
      if (index < 0) throw new Error('Provider injection requires native settings')
      this.providerSettingsDirectory ??= mkdtempSync(join(tmpdir(), 'openagent-claude-provider-'))
      const path = join(this.providerSettingsDirectory, 'settings.json')
      writeFileSync(path, args[index + 1]!, { mode: 0o600 })
      args[index + 1] = path
    }
    inDebugContext(this.debugContext, () => debugDetail('claude.transport.spawn', {
      harnessId: 'claude',
      purpose: this.options.debugPurpose || 'thread',
      executable: this.options.executable,
      cwd: this.options.cwd,
      sessionId: this.options.sessionId,
      args: debugSpawnArguments(args),
      input: input.parts.map((part) => inputPartMetadata(part)),
      ...debugEnvironmentSummary(environment)
    }))
    const child = spawn(this.options.executable, args, {
      cwd: this.options.cwd,
      env: {
        ...environment,
        CLAUDE_CODE_ENTRYPOINT: 'openagent-desktop'
      },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams
    const processGroupId =
      process.platform !== 'win32' && child.pid ? child.pid : undefined
    if (processGroupId !== undefined) {
      this.processGroupIds.add(processGroupId)
    }
    this.child = child
    this.decoder = new JsonLines()
    this.stderr = ''
    this.stopping = false
    this.failedProcessShutdown = undefined
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      inDebugContext(this.active?.debugContext || this.debugContext, () => {
        debugDetail('claude.protocol.inbound-chunk', {
          purpose: this.options.debugPurpose || 'thread',
          bytes: chunk.byteLength,
          encoding: 'utf8'
        })
      })
      for (const line of this.decoder.push(chunk)) this.handleLine(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      const text = chunk.toString('utf8')
      inDebugContext(this.active?.debugContext || this.debugContext, () => {
        debugDetail('claude.protocol.stderr', {
          purpose: this.options.debugPurpose || 'thread',
          bytes: chunk.byteLength,
          text
        })
      })
      this.stderr = keepTail(this.stderr + text)
    })
    child.stdin.on('error', (error) => this.handleStdinFailure(child, error))
    child.once('error', (error) => {
      if (this.child === child) this.handleProcessFailure(error.message)
    })
    child.once('close', (code) => {
      if (
        processGroupId !== undefined &&
        !processGroupExists(processGroupId)
      ) {
        this.processGroupIds.delete(processGroupId)
      }
      if (this.child !== child) return
      inDebugContext(this.active?.debugContext || this.debugContext, () => debugLog('claude.transport.close', {
        purpose: this.options.debugPurpose || 'thread',
        sessionId: this.options.sessionId,
        code: code ?? null,
        signal: child.signalCode ?? null
      }))
      for (const line of this.decoder.end()) this.handleLine(line)
      this.child = undefined
      this.initialized = undefined
      if (this.disposed || this.stopping) return
      const message =
        this.stderr.trim() ||
        `Claude Code 异常退出（退出码 ${String(code ?? 'unknown')}）`
      this.handleProcessFailure(message)
    })
  }

  private handleStdinFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child || this.disposed || this.stopping) return
    // A broken input pipe cannot serve further requests even if the CLI has
    // not exited. Retire it before settling work or permitting a replacement.
    this.child = undefined
    this.initialized = undefined
    this.stopping = true
    this.handleProcessFailure(error.message)
    this.failedProcessShutdown = this.stopFailedProcess(child)
    // Recovery/disposal awaits this promise; a background failure must not
    // become an unhandled rejection while the caller is idle.
    void this.failedProcessShutdown.catch(() => undefined)
  }

  private async stopFailedProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
    const processGroupIds = [...this.processGroupIds].filter((processGroupId) =>
      processGroupExists(processGroupId)
    )
    signalProcessTree(child, processGroupIds, 'SIGTERM')
    if (!(await waitForProcessTreeExit(
      child,
      processGroupIds,
      this.options.interruptTimeouts?.termMs ?? 2_000
    ))) {
      signalProcessTree(child, processGroupIds, 'SIGKILL')
      if (!(await waitForProcessTreeExit(
        child,
        processGroupIds,
        this.options.interruptTimeouts?.killMs ?? 10_000
      ))) {
        throw new Error(
          `Claude Code 输入管道失败且进程组 SIGKILL 后仍未退出：${processGroupIds.join(', ')}`
        )
      }
    }
    for (const processGroupId of processGroupIds) {
      this.processGroupIds.delete(processGroupId)
    }
  }

  private async initialize(): Promise<unknown> {
    const span = startDebugSpan('claude.transport.initialize', {
      harnessId: 'claude',
      purpose: this.options.debugPurpose || 'thread',
      sessionId: this.options.sessionId,
      resume: this.options.resume
    })
    try {
      const result = await this.requestControl(
        initializationRequest(this.options),
        45_000
      )
      this.sessionEstablished = true
      span.end({ initialized: true })
      return result
    } catch (error) {
      span.fail(error)
      debugError('claude.transport.initialize-error', error, {
        purpose: this.options.debugPurpose || 'thread',
        sessionId: this.options.sessionId
      })
      throw error
    }
  }

  private handleLine(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      inDebugContext(this.debugContext, () => debugDetail('claude.protocol.inbound', {
        purpose: this.options.debugPurpose || 'thread',
        json: false,
        line
      }))
      this.stderr = keepTail(`${this.stderr}${line}\n`)
      return
    }
    inDebugContext(this.debugContext, () => debugDetail('claude.protocol.inbound', {
      purpose: this.options.debugPurpose || 'thread',
      json: true,
      frame: debugFrame(value)
    }))
    if (!isRecord(value)) return
    if (value.type === 'control_response') {
      this.handleControlResponse(value)
      return
    }
    if (value.type === 'control_request') {
      this.handleControlRequest(value)
      return
    }
    if (value.type === 'control_cancel_request') {
      const id = stringValue(value.request_id)
      const pending = id ? this.interactions.get(id) : undefined
      if (pending) {
        this.interactions.delete(id)
        void this.emitExecution(pending.executionToken, {
          type: 'interaction-resolved',
          id,
          status: 'cancelled'
        })
        this.completeInteractionWakeIfSettled(pending.executionToken)
      }
      return
    }
    if (value.type === 'command_lifecycle') {
      this.handleCommandLifecycle(value)
      return
    }
    if (value.type === 'transcript_mirror') return
    if (value.type === 'system' && value.subtype === 'task_notification') {
      const taskId = stringValue(value.task_id)
      void this.emit({
        type: 'native-notification',
        summary:
          stringValue(value.summary) ||
          `Claude task ${taskId || 'unknown'} updated`,
        ...(stringValue(value.status)
          ? { status: stringValue(value.status) }
          : {}),
        ...(taskId ? { taskId } : {})
      })
      return
    }
    if (isTopLevelUserFrame(value)) {
      const id = stringValue(value.uuid)
      if (id && this.localMessageIds.delete(id)) {
        const boundary = this.active?.boundaries.find(
          (candidate) => candidate.messageId === id
        )
        if (boundary) boundary.admitted = true
        return
      }
      const origin = isRecord(value.origin) ? stringValue(value.origin.kind) : ''
      if (origin === 'task-notification') {
        const summary = userFrameText(value)
        if (!this.active && id) {
          const token = this.nextExecutionToken++
          const debugSpan = startDebugSpan('claude.execution', {
            harnessId: 'claude',
            purpose: this.options.debugPurpose || 'thread',
            executionId: id,
            nativeSessionId: this.options.sessionId,
            origin: 'task-notification'
          })
          const active: ActiveNativeExecution = {
            executionId: id,
            token,
            generation: 1,
            boundaries: [{
              messageId: id,
              admitted: true,
              lifecycleEnded: false,
              sawTextDelta: false,
              sawReasoningDelta: false
            }],
            cancelled: false,
            acceptingFollowups: true,
            modelCosts: new Map(),
            debugContext: debugSpan.context,
            debugSpan,
            debugStartedAt: debugNow(),
            debugSummaryEmitted: false
          }
          this.active = active
          this.parser = createParserState()
          void this.emitExecution(active.token, {
            type: 'native-execution-start',
            nativeExecutionId: id,
            prompt: summary
          })
        }
        if (summary) void this.emit({ type: 'native-notification', summary })
      }
      return
    }
    if (value.type === 'result') {
      this.handleResult(value)
      return
    }
    const active = this.active
    if (
      !active &&
      value.type === 'system' &&
      value.subtype === 'background_tasks_changed'
    ) {
      const executionToken = this.lastExecutionToken
      if (executionToken !== undefined) {
        for (const event of parseNativeRecord(value, this.parser)) {
          if (event.type === 'runtime') {
            void this.emitExecution(executionToken, event)
          }
        }
      }
      return
    }
    // Claude can emit connection/retry status before replaying the submitted
    // user frame. Surface those diagnostics instead of leaving the execution
    // looking permanently stuck at "starting" while the CLI is retrying.
    if (active && value.type === 'system') {
      for (const event of parseNativeRecord(value, this.parser)) {
        void this.emitExecution(active.token, event)
      }
      return
    }
    if (!active || !active.boundaries.some((boundary) => boundary.admitted)) {
      return
    }
    const userMessageId = stringValue(value.user_message_uuid)
    if (
      userMessageId &&
      !active.boundaries.some(
        (boundary) =>
          boundary.messageId === userMessageId && boundary.admitted
      )
    ) {
      return
    }
    const eventBoundary = userMessageId
      ? active.boundaries.find((boundary) => boundary.messageId === userMessageId)
      : active.boundaries.findLast((boundary) => boundary.admitted)
    if (eventBoundary) {
      this.parser.sawTextDelta = eventBoundary.sawTextDelta
      this.parser.sawReasoningDelta = eventBoundary.sawReasoningDelta
    }
    const events = parseNativeRecord(value, this.parser)
    if (eventBoundary) {
      eventBoundary.sawTextDelta = this.parser.sawTextDelta
      eventBoundary.sawReasoningDelta = this.parser.sawReasoningDelta
    }
    for (const event of events) {
      void this.emitExecution(active.token, event)
    }
  }

  private handleResult(value: UnknownRecord): void {
    const active = this.active
    if (!active) return
    const userMessageId = stringValue(value.user_message_uuid)
    if (!userMessageId) return
    const boundaryIndex = active.boundaries.findIndex(
      (boundary) =>
        boundary.messageId === userMessageId &&
        boundary.admitted &&
        !boundary.lifecycleEnded
    )
    if (boundaryIndex < 0) return
    const index = boundaryIndex
    const consumed = active.boundaries[index]
    active.boundaries.splice(index, 1)
    this.localMessageIds.delete(consumed.messageId)
    active.boundaries = active.boundaries.filter(
      (boundary) => !boundary.lifecycleEnded
    )
    if (typeof value.session_id === 'string') {
      void this.emitExecution(active.token, {
        type: 'session',
        sessionId: value.session_id
      })
    }
    if (!consumed.sawTextDelta) {
      const structured = value.structured_output
      const result =
        structured === undefined
          ? stringValue(value.result)
          : typeof structured === 'string'
            ? structured
            : JSON.stringify(structured, null, 2)
      if (result) {
        void this.emitExecution(active.token, { type: 'text', delta: result, synthetic: true })
      }
    }
    if (isRecord(value.modelUsage)) {
      for (const event of claudeModelCostEvents(
        value.modelUsage,
        active.modelCosts,
        userMessageId
      )) {
        void this.emitExecution(active.token, event)
      }
    }
    const errors = Array.isArray(value.errors)
      ? value.errors.filter((item): item is string => typeof item === 'string')
      : []
    const failed =
      value.is_error === true ||
      (typeof value.subtype === 'string' && value.subtype !== 'success')
    const outcome: 'completed' | 'failed' = failed ? 'failed' : 'completed'
    const message =
      errors.join('\n') ||
      (failed ? stringValue(value.result) || `Claude 运行失败：${String(value.subtype)}` : '')
    if (active.boundaries.length > 0) {
      active.deferredOutcome = outcome
      active.deferredError = message || undefined
      this.parser = createParserState()
      void this.emitExecution(active.token, {
        type: 'status',
        label: '正在处理追加消息'
      })
      return
    }
    this.queueCompletion(
      active,
      active.cancelled ? 'interrupted' : outcome,
      message || undefined
    )
  }

  private handleCommandLifecycle(value: UnknownRecord): void {
    if (!['completed', 'cancelled', 'discarded'].includes(stringValue(value.state))) {
      return
    }
    const active = this.active
    const id = stringValue(value.command_uuid)
    if (!active || !id) return
    const boundary = active.boundaries.find(
      (candidate) => candidate.messageId === id
    )
    if (!boundary) return
    boundary.lifecycleEnded = true
    if (!active.deferredOutcome) return
    if (active.boundaries.some((candidate) => !candidate.lifecycleEnded)) return
    active.boundaries.length = 0
    this.queueCompletion(
      active,
      active.cancelled ? 'interrupted' : active.deferredOutcome,
      active.deferredError
    )
  }

  private handleControlResponse(value: UnknownRecord): void {
    if (!isRecord(value.response)) return
    const response = value.response
    const id = stringValue(response.request_id)
    const pending = this.controls.get(id)
    if (!pending) return
    this.controls.delete(id)
    clearTimeout(pending.timer)
    if (response.subtype === 'success') {
      inDebugContext(pending.debugContext, () => pending.resolve(response.response))
      this.registerPendingControlRequests(response.pending_permission_requests)
      this.registerPendingControlRequests(response.pending_user_dialog_requests)
    } else {
      const error = new Error(stringValue(response.error) || 'Claude 控制请求失败')
      inDebugContext(pending.debugContext, () => pending.reject(error))
    }
  }

  private handleControlRequest(envelope: UnknownRecord): void {
    const id = stringValue(envelope.request_id)
    if (!isRecord(envelope.request)) return
    const active = this.active
    if (!id || id.length > 512 || id.includes('\0')) {
      if (active) {
        void this.emitExecution(active.token, {
          type: 'unsupported-interaction',
          message: 'Claude 控制请求缺少有效 request_id'
        })
      }
      return
    }
    const interaction = controlRequestToInteraction(id, envelope.request)
    if (!interaction) {
      const message = `不支持的 Claude 控制请求：${stringValue(envelope.request.subtype)}`
      void this.writeControlError(id, message).catch((error) => {
        this.handleProcessFailure(asError(error).message)
      })
      if (active) {
        void this.emitExecution(active.token, {
          type: 'unsupported-interaction',
          message
        })
      }
      return
    }
    if (!this.options.interactive) {
      void this.rejectNonInteractiveControl(id, envelope.request, interaction.kind)
      return
    }
    const target = active || this.startInteractionWake(interaction.title)
    if (target.syntheticInteractionWake) {
      target.completionToken = undefined
      target.pendingCompletion = undefined
    }
    this.interactions.set(id, {
      id,
      kind: interaction.kind,
      interaction,
      request: envelope.request,
      executionToken: target.token
    })
    void this.emitExecution(target.token, { type: 'interaction', interaction })
  }

  private registerPendingControlRequests(value: unknown): void {
    if (!Array.isArray(value)) return
    for (const request of value) {
      if (isRecord(request)) this.handleControlRequest(request)
    }
  }

  private rejectNonInteractiveControl(
    id: string,
    request: UnknownRecord,
    kind: ClaudeInteraction['kind']
  ): Promise<void> {
    const response = kind === 'elicitation'
      ? { action: 'decline' }
      : kind === 'dialog'
        ? { behavior: 'cancelled' }
        : {
            behavior: 'deny',
            message: 'OpenAgent 非交互任务未启用交互式审批',
            toolUseID: stringValue(request.tool_use_id) || undefined
          }
    return this.writeControlResponse(id, response).catch(() => undefined)
  }

  private startInteractionWake(title: string): ActiveNativeExecution {
    const token = this.nextExecutionToken++
    const executionId = randomUUID()
    const debugSpan = startDebugSpan('claude.execution', {
      harnessId: 'claude',
      purpose: this.options.debugPurpose || 'thread',
      executionId,
      nativeSessionId: this.options.sessionId,
      origin: 'interaction-wake'
    })
    const active: ActiveNativeExecution = {
      executionId,
      token,
      generation: 1,
      boundaries: [],
      cancelled: false,
      acceptingFollowups: false,
      syntheticInteractionWake: true,
      modelCosts: new Map(),
      debugContext: debugSpan.context,
      debugSpan,
      debugStartedAt: debugNow(),
      debugSummaryEmitted: false
    }
    this.active = active
    this.parser = createParserState()
    void this.emitExecution(active.token, {
      type: 'native-execution-start',
      nativeExecutionId: active.executionId,
      prompt: title || 'Claude 后台任务需要你的响应'
    })
    return active
  }

  private promoteInteractionsToWake(
    pending: readonly PendingInteraction[]
  ): void {
    const wake = this.startInteractionWake(pending[0]?.interaction.title || '')
    for (const interaction of pending) {
      interaction.executionToken = wake.token
      void this.emitExecution(wake.token, {
        type: 'interaction',
        interaction: interaction.interaction
      })
    }
  }

  private completeInteractionWakeIfSettled(executionToken: number): void {
    const active = this.active
    if (
      active?.syntheticInteractionWake !== true ||
      active.token !== executionToken ||
      [...this.interactions.values()].some(
        (interaction) => interaction.executionToken === executionToken
      )
    ) {
      return
    }
    this.queueCompletion(active, 'completed')
  }

  private requestControl(
    request: UnknownRecord,
    timeoutMs = 20_000
  ): Promise<unknown> {
    const id = randomUUID()
    const debugContext = effectiveDebugContext(getDebugContext(), this.debugContext)
    inDebugContext(debugContext, () => debugDetail('claude.control.request', {
      purpose: this.options.debugPurpose || 'thread',
      requestId: id,
      request: debugFrame(request)
    }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id)
        const error = new Error(`Claude 控制请求超时：${String(request.subtype)}`)
        inDebugContext(debugContext, () => {
          debugError('claude.control.error', error, {
            purpose: this.options.debugPurpose || 'thread',
            requestId: id,
            subtype: String(request.subtype),
            phase: 'timeout'
          })
          reject(error)
        })
      }, timeoutMs)
      timer.unref()
      this.controls.set(id, { resolve, reject, timer, debugContext })
      void this.write({ type: 'control_request', request_id: id, request }).catch(
        (error) => {
          const pending = this.controls.get(id)
          if (!pending) return
          this.controls.delete(id)
          clearTimeout(pending.timer)
          const cause = asError(error)
          inDebugContext(pending.debugContext, () => {
            debugError('claude.control.error', cause, {
              purpose: this.options.debugPurpose || 'thread',
              requestId: id,
              subtype: String(request.subtype),
              phase: 'write'
            })
            pending.reject(cause)
          })
        }
      )
    })
  }

  private writeControlResponse(id: string, response: UnknownRecord): Promise<void> {
    return this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: id, response }
    })
  }

  private writeControlError(id: string, message: string): Promise<void> {
    return this.write({
      type: 'control_response',
      response: { subtype: 'error', request_id: id, error: message }
    })
  }

  private write(value: unknown): Promise<void> {
    const child = this.child
    if (!child || child.killed || child.stdin.destroyed) {
      const error = new Error('Claude Code 进程未运行')
      if (child) this.handleStdinFailure(child, error)
      return Promise.reject(error)
    }
    const debugContext = effectiveDebugContext(
      getDebugContext(),
      this.active?.debugContext || this.debugContext
    )
    inDebugContext(debugContext, () => debugDetail('claude.protocol.outbound', {
      purpose: this.options.debugPurpose || 'thread',
      frame: debugFrame(value)
    }))
    return new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(value)}\n`, 'utf8', (error) => {
        if (error) {
          this.handleStdinFailure(child, error)
          reject(error)
        } else resolve()
      })
    })
  }

  private emit(event: ClaudeNativeEvent): Promise<void> {
    const debugContext = event.type === 'native-notification'
      ? this.debugContext
      : this.active?.debugContext
    const next = this.eventQueue.then(async () => {
      if (this.disposed) return
      await inDebugContext(debugContext, () => this.options.onEvent(event))
    })
    this.eventQueue = next.catch(() => undefined)
    return next
  }

  private emitExecution(
    executionToken: number,
    event: ClaudeExecutionNativeEvent
  ): Promise<void> {
    this.lastExecutionToken = executionToken
    const active = this.active?.token === executionToken ? this.active : undefined
    if (active && (event.type === 'text' || event.type === 'reasoning') && event.delta.trim()) {
      const first = event.type === 'text' ? active.firstTextAt : active.firstReasoningAt
      if (first === undefined) {
        const at = debugNow()
        if (event.type === 'text') active.firstTextAt = at
        else active.firstReasoningAt = at
        inDebugContext(active.debugContext, () => debugLog(
          event.type === 'text'
            ? 'claude.execution.first-text'
            : 'claude.execution.first-reasoning',
          {
            harnessId: 'claude',
            executionId: active.executionId,
            nativeSessionId: this.options.sessionId,
            generation: active.generation,
            durationMs: Math.max(0, at - active.debugStartedAt)
          }
        ))
      }
    }
    const debugContext = active?.debugContext || this.debugContext
    return this.emitWithContext({ ...event, executionToken }, debugContext)
  }

  private emitWithContext(
    event: ClaudeNativeEvent,
    debugContext: DebugContext | undefined
  ): Promise<void> {
    const next = this.eventQueue.then(async () => {
      if (this.disposed) return
      await inDebugContext(debugContext, () => this.options.onEvent(event))
    })
    this.eventQueue = next.catch(() => undefined)
    return next
  }

  private queueCompletion(
    active: ActiveNativeExecution,
    outcome: 'completed' | 'failed' | 'interrupted',
    error?: string
  ): void {
    const token = {}
    const generation = active.generation
    active.pendingCompletion = {
      outcome,
      ...(error ? { error } : {})
    }
    active.completionToken = token
    const next = this.eventQueue.then(async () => {
      // Let a product follow-up that was accepted while Core still considered
      // the Execution active invalidate this native result boundary.
      await Promise.resolve()
      if (
        this.disposed ||
        this.active !== active ||
        active.completionToken !== token ||
        active.generation !== generation ||
        active.boundaries.length > 0 ||
        (active.syntheticInteractionWake === true &&
          [...this.interactions.values()].some(
            (interaction) => interaction.executionToken === active.token
          ))
      ) {
        return
      }
      this.finishDebugExecution(active, outcome, error)
      await inDebugContext(active.debugContext, () => this.options.onEvent({
        type: 'done',
        outcome,
        generation,
        ...(error ? { error } : {}),
        executionToken: active.token
      }))
      if (
        this.active === active &&
        active.completionToken === token &&
        active.generation === generation
      ) {
        this.active = undefined
        this.parser = createParserState()
      }
    })
    this.eventQueue = next.catch(() => undefined)
  }

  private handleProcessFailure(message: string): void {
    inDebugContext(this.active?.debugContext || this.debugContext, () => {
      debugError('claude.transport.process-error', new Error(message), {
        purpose: this.options.debugPurpose || 'thread',
        sessionId: this.options.sessionId,
        message
      })
    })
    for (const control of this.controls.values()) {
      clearTimeout(control.timer)
      control.reject(new Error(message))
    }
    this.controls.clear()
    for (const pending of this.interactions.values()) {
      void this.emitExecution(pending.executionToken, {
        type: 'interaction-resolved',
        id: pending.id,
        status: 'cancelled'
      })
    }
    this.interactions.clear()
    if (this.active) {
      const active = this.active
      active.acceptingFollowups = false
      // A dead process cannot acknowledge the remaining messages. Retiring
      // their boundaries lets the terminal event drain instead of waiting
      // forever for native results that can no longer arrive.
      for (const boundary of active.boundaries) {
        this.localMessageIds.delete(boundary.messageId)
      }
      active.boundaries.length = 0
      this.queueCompletion(
        active,
        active.cancelled ? 'interrupted' : 'failed',
        message
      )
    }
    // Queue behind the terminal completion: the Thread must settle the Execution
    // first, then release the background work that died with this process.
    void this.emit({ type: 'process-exit' })
  }

  private finishDebugExecution(
    active: ActiveNativeExecution,
    outcome: 'completed' | 'failed' | 'interrupted',
    error?: string
  ): void {
    if (active.debugSummaryEmitted) return
    active.debugSummaryEmitted = true
    const fields = {
      harnessId: 'claude',
      purpose: this.options.debugPurpose || 'thread',
      executionId: active.executionId,
      nativeSessionId: this.options.sessionId,
      outcome,
      generation: active.generation,
      durationMs: debugDuration(active.debugStartedAt),
      messageSentDurationMs: active.firstMessageSentAt === undefined
        ? null
        : Math.max(0, active.firstMessageSentAt - active.debugStartedAt),
      firstReasoningDurationMs: active.firstReasoningAt === undefined
        ? null
        : Math.max(0, active.firstReasoningAt - active.debugStartedAt),
      firstTextDurationMs: active.firstTextAt === undefined
        ? null
        : Math.max(0, active.firstTextAt - active.debugStartedAt),
      error: error || null
    }
    inDebugContext(active.debugContext, () => {
      if (outcome === 'failed') active.debugSpan?.fail(
        new Error(error || 'Claude execution failed'),
        fields
      )
      else active.debugSpan?.end(fields)
      debugLog('claude.execution.summary', fields)
    })
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Claude transport 已关闭')
  }

  private captureDebugContext(context: DebugContext): void {
    if (!this.debugContext.traceId && !this.debugContext.spanId) {
      this.debugContext = context
    }
  }
}

function nativeQuestionAnswers(
  rawQuestionsValue: unknown,
  responsesValue: unknown
): UnknownRecord {
  const rawQuestions = Array.isArray(rawQuestionsValue)
    ? rawQuestionsValue
    : []
  if (!Array.isArray(responsesValue) || responsesValue.length > 32) {
    throw new Error('Claude question response 无效')
  }
  const result: UnknownRecord = {}
  const answeredIndexes = new Set<number>()
  for (const rawResponse of responsesValue) {
    if (!isRecord(rawResponse)) throw new Error('Claude question response 无效')
    const questionIndex = rawResponse.questionIndex
    if (
      !Number.isSafeInteger(questionIndex) ||
      Number(questionIndex) < 0 ||
      Number(questionIndex) >= rawQuestions.length ||
      answeredIndexes.has(Number(questionIndex))
    ) {
      throw new Error('Claude question response identity 无效')
    }
    const rawQuestion = rawQuestions[Number(questionIndex)]
    if (!isRecord(rawQuestion) || !Array.isArray(rawResponse.values)) {
      throw new Error('Claude question response 无效')
    }
    const multiple = rawQuestion.multiSelect === true
    if (rawResponse.multiple !== multiple) {
      throw new Error('Claude question response multiplicity 不匹配')
    }
    const rawOptions = Array.isArray(rawQuestion.options)
      ? rawQuestion.options
      : []
    const values = rawResponse.values.map((rawValue): string => {
      if (!isRecord(rawValue)) throw new Error('Claude question answer 无效')
      if (Object.keys(rawValue).length !== 1) {
        throw new Error('Claude question answer 无效')
      }
      if (Object.hasOwn(rawValue, 'optionIndex')) {
        const optionIndex = rawValue.optionIndex
        if (
          !Number.isSafeInteger(optionIndex) ||
          Number(optionIndex) < 0 ||
          Number(optionIndex) >= rawOptions.length
        ) {
          throw new Error('Claude question option identity 无效')
        }
        const rawOption = rawOptions[Number(optionIndex)]
        if (!isRecord(rawOption) || typeof rawOption.label !== 'string') {
          throw new Error('Claude question option value 无效')
        }
        return rawOption.label
      }
      if (typeof rawValue.text !== 'string') {
        throw new Error('Claude question free-text answer 无效')
      }
      return rawValue.text
    })
    if (!multiple && values.length !== 1) {
      throw new Error('Claude single-select question 必须有且只有一个回答')
    }
    const nativeQuestion = typeof rawQuestion.question === 'string'
      ? rawQuestion.question
      : ''
    result[nativeQuestion] = multiple ? values : values[0]!
    answeredIndexes.add(Number(questionIndex))
  }
  return result
}

function withSystemProxy(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== 'darwin') return environment
  if (
    environment.HTTPS_PROXY ||
    environment.https_proxy ||
    environment.HTTP_PROXY ||
    environment.http_proxy ||
    environment.ALL_PROXY ||
    environment.all_proxy
  ) {
    return environment
  }
  try {
    const output = execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const httpsEnabled = /^\s*HTTPSEnable\s*:\s*1\s*$/m.test(output)
    const httpEnabled = /^\s*HTTPEnable\s*:\s*1\s*$/m.test(output)
    const httpsHost = proxyValue(output, 'HTTPSProxy')
    const httpsPort = proxyValue(output, 'HTTPSPort')
    const httpHost = proxyValue(output, 'HTTPProxy')
    const httpPort = proxyValue(output, 'HTTPPort')
    const httpsProxy = httpsEnabled && httpsHost
      ? `http://${httpsHost}${httpsPort ? `:${httpsPort}` : ''}`
      : undefined
    const httpProxy = httpEnabled && httpHost
      ? `http://${httpHost}${httpPort ? `:${httpPort}` : ''}`
      : undefined
    if (!httpsProxy && !httpProxy) return environment
    return {
      ...environment,
      ...(httpsProxy ? { HTTPS_PROXY: httpsProxy } : {}),
      ...(httpProxy ? { HTTP_PROXY: httpProxy } : {}),
      NO_PROXY: environment.NO_PROXY || environment.no_proxy || '127.0.0.1,localhost'
    }
  } catch {
    return environment
  }
}

function proxyValue(output: string, key: string): string | undefined {
  const match = output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm'))
  return match?.[1]?.trim() || undefined
}

export async function runClaudePrompt(input: {
  executable: string
  cwd: string
  environment: NodeJS.ProcessEnv
  providerInjection?: import('@openagent/contracts').ProviderInjection
  prompt: string
  systemPrompt?: string
  model?: string
  effort?: string
  schema?: Record<string, unknown>
  resumeSessionId?: string
  snapshotFileAccess?: boolean
  /**
   * Source Thread's own application-tools determination. A native fork read
   * mirrors it so the fork request prefix matches the source's last request; a
   * one-shot prompt keeps the isolated default (`--tools ''`).
   */
  applicationToolsOnly?: boolean
  /**
   * Source Thread's native permission mode. A native fork read mirrors it so
   * the fork prefix matches; the isolated prompt / snapshot path keeps the
   * non-interactive `dontAsk` mode.
   */
  permissionMode?: ClaudePermissionMode
  /**
   * Source Thread's tool allow / deny lists. They become `--allowedTools` /
   * `--disallowedTools`, which determine the request's tool list, so a native
   * fork read must carry the source's values to keep the prefix aligned.
   */
  allowedTools?: string[]
  disallowedTools?: string[]
  signal: AbortSignal
}): Promise<{ value: unknown; text: string; failed: boolean }> {
  if (input.signal.aborted) throw abortError()
  if (
    input.effort &&
    !CLAUDE_EFFORT_LEVELS.includes(
      input.effort as (typeof CLAUDE_EFFORT_LEVELS)[number]
    )
  ) {
    throw new Error('无效的 Claude prompt effort')
  }
  let text = ''
  let error = ''
  let settle!: (value: 'completed' | 'failed' | 'interrupted') => void
  const terminal = new Promise<'completed' | 'failed' | 'interrupted'>((resolve) => {
    settle = resolve
  })
  let transport!: ClaudeTransport
  transport = new ClaudeTransport({
    executable: input.executable,
    cwd: input.cwd,
    environment: input.environment,
    providerInjection: input.providerInjection,
    sessionId: randomUUID(),
    resume: false,
    ...(input.resumeSessionId
      ? { forkFromSessionId: input.resumeSessionId }
      : {}),
    settings: {
      executablePath: input.executable,
      permissionMode: input.permissionMode ?? 'dontAsk',
      ...(input.snapshotFileAccess
        ? {
            allowedTools: ['Read', 'Glob', 'Grep'],
            disallowedTools: [
              'Bash',
              'Edit',
              'Write',
              'WebFetch',
              'WebSearch'
            ]
          }
        : {
            ...(input.allowedTools?.length
              ? { allowedTools: input.allowedTools }
              : {}),
            ...(input.disallowedTools?.length
              ? { disallowedTools: input.disallowedTools }
              : {})
          }),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort
        ? { effort: input.effort as ClaudeThreadSettings['effort'] }
        : {})
    },
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.schema ? { structuredOutputSchema: input.schema } : {}),
    interactive: false,
    persistSession: false,
    debugPurpose: 'prompt',
    applicationToolsOnly:
      input.applicationToolsOnly ?? !input.snapshotFileAccess,
    onEvent: async (event) => {
      if (event.type === 'text') {
        if (
          text.length + event.delta.length >
          CLAUDE_STATE_LIMITS.textCharacters
        ) {
          error = 'Claude prompt 输出超过大小限制'
          void transport.interrupt().catch(() => undefined)
          settle('failed')
          return
        }
        text += event.delta
      }
      else if (event.type === 'error') error = event.message
      else if (event.type === 'interaction') {
        error = `Claude prompt 意外请求 interaction：${event.interaction.title}`
        await transport.rejectInteraction(event.interaction.id, error).catch(
          (cause) => {
            error = `${error}\n${asError(cause).message}`
          }
        )
        void transport.interrupt().catch(() => undefined)
        settle('failed')
      } else if (event.type === 'unsupported-interaction') {
        error = event.message
        void transport.interrupt().catch(() => undefined)
        settle('failed')
      } else if (event.type === 'done') {
        if (event.error) error = event.error
        settle(event.outcome)
      }
    }
  })
  const onAbort = (): void => {
    void transport.interrupt().catch(() => undefined)
    settle('interrupted')
  }
  input.signal.addEventListener('abort', onAbort, { once: true })
  try {
    await abortable(
      transport.send(
        'claude-prompt-completion',
        { parts: [{ kind: 'text', text: input.prompt }] },
        'now',
        input.signal
      ),
      input.signal
    )
    const outcome = await terminal
    if (input.signal.aborted || outcome === 'interrupted') throw abortError()
    const normalizedText = text.trim()
    if (outcome === 'failed' && !normalizedText) {
      throw new Error(error || 'Claude prompt 失败')
    }
    let value: unknown = normalizedText
    if (input.schema) {
      try {
        value = JSON.parse(normalizedText) as unknown
      } catch {
        value = normalizedText
      }
    }
    return {
      value,
      text: normalizedText || error,
      failed: outcome === 'failed'
    }
  } finally {
    input.signal.removeEventListener('abort', onAbort)
    await transport.dispose()
  }
}

function initializationRequest(
  options: ClaudeTransportOptions
): UnknownRecord {
  return {
    subtype: 'initialize',
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.structuredOutputSchema
      ? { jsonSchema: options.structuredOutputSchema }
      : {}),
    agentProgressSummaries: true,
    forwardSubagentText: true,
    supportedDialogKinds: options.interactive
      ? ['refusal_fallback_prompt']
      : []
  }
}

function buildClaudeArguments(
  options: ClaudeTransportOptions,
  settings: ClaudeThreadSettings,
  resume: boolean,
  firstInput: AgentInput,
  environment: NodeJS.ProcessEnv,
): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--include-hook-events',
    '--forward-subagent-text',
    '--replay-user-messages',
    '--permission-prompt-tool',
    'stdio'
  ]
  if (options.forkFromSessionId) {
    args.push(
      `--resume=${options.forkFromSessionId}`,
      '--fork-session',
      `--session-id=${options.sessionId}`
    )
    if (options.forkAtMessageId) {
      args.push(`--resume-session-at=${options.forkAtMessageId}`)
    }
  } else if (resume) args.push(`--resume=${options.sessionId}`)
  else args.push(`--session-id=${options.sessionId}`)
  if (!options.persistSession) args.push('--no-session-persistence')
  // Claude's default snapshot replays the first system prompt on resume,
  // discarding updated Host instructions (including changed tool schemas).
  if (options.systemPrompt) args.push('--system-prompt-snapshot', 'off')
  if (settings.model) args.push('--model', settings.model)
  if (settings.effort) args.push('--effort', settings.effort)
  const permissionMode = settings.permissionMode || CLAUDE_DEFAULT_PERMISSION_MODE
  args.push('--permission-mode', permissionMode)
  if (permissionMode === 'bypassPermissions') {
      args.push('--allow-dangerously-skip-permissions')
  }
  if (options.applicationToolsOnly) {
    args.push('--tools', '', '--disable-slash-commands', '--strict-mcp-config')
    if (bareModeCanAuthenticate(environment)) args.push('--bare')
  }
  // Tool registration controls visibility. Permission bypasses and denies come
  // only from the same native settings used by ordinary Threads.
  if (settings.allowedTools?.length) {
    args.push('--allowedTools', settings.allowedTools.join(','))
  }
  if (settings.disallowedTools?.length) {
    args.push('--disallowedTools', settings.disallowedTools.join(','))
  }
  if (options.toolBridge) {
    args.push('--mcp-config', JSON.stringify(options.toolBridge.claudeConfiguration()))
  }
  const proxySettings = explicitProxySettings(environment)
  const cliSettings: UnknownRecord = {
    ...(Object.keys(proxySettings).length || options.providerInjection
      ? {
          env: { ...proxySettings, ...options.providerInjection?.environment }
        }
      : {}),
    ...(options.nativeWorktreeName !== undefined && !resume
      ? { worktree: { baseRef: 'head' } }
      : {})
  }
  if (Object.keys(cliSettings).length) {
    args.push('--settings', JSON.stringify(cliSettings))
  }
  if (options.nativeWorktreeName !== undefined && !resume) {
    args.push('--worktree')
    if (options.nativeWorktreeName) args.push(options.nativeWorktreeName)
  }
  const directories = new Set<string>()
  for (const part of firstInput.parts) {
    if ('file' in part) directories.add(dirname(part.file.path))
    if (part.kind === 'mention' || part.kind === 'skill') {
      directories.add(part.kind === 'mention' && part.pathType === 'directory' ? part.path : dirname(part.path))
    }
  }
  for (const directory of directories) {
    if (directory !== options.cwd) args.push('--add-dir', directory)
  }
  return args
}

function debugSpawnArguments(args: readonly string[]): string[] {
  const hiddenValueFlags = new Set(['--mcp-config'])
  const redactedValueFlags = new Set(['--settings'])
  const sensitiveEnvKeys = new Set([
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY'
  ])
  const result: string[] = []
  let hideNext = false
  let redactNext = false
  for (const arg of args) {
    if (hideNext) {
      result.push('[mcp configuration omitted]')
      hideNext = false
      continue
    }
    if (redactNext) {
      result.push(redactSettingsEnv(arg, sensitiveEnvKeys))
      redactNext = false
      continue
    }
    result.push(arg)
    if (hiddenValueFlags.has(arg)) hideNext = true
    if (redactedValueFlags.has(arg)) redactNext = true
  }
  return result
}

function redactSettingsEnv(
  settingsJson: string,
  sensitiveKeys: Set<string>
): string {
  try {
    const parsed = JSON.parse(settingsJson) as UnknownRecord
    const env = isRecord(parsed.env) ? (parsed.env as UnknownRecord) : undefined
    if (env) {
      parsed.env = Object.fromEntries(
        Object.entries(env).map(([key, value]) => [
          key,
          sensitiveKeys.has(key) ? '[redacted]' : value
        ])
      )
    }
    return JSON.stringify(parsed)
  } catch {
    return '[settings redacted]'
  }
}

function inputPartMetadata(
  part: AgentInput['parts'][number]
): Record<string, unknown> {
  if (part.kind === 'text') {
    return { kind: part.kind, characters: part.text.length }
  }
  if (part.kind === 'image-url' || part.kind === 'audio-url') {
    return { kind: part.kind, url: part.url }
  }
  if (part.kind === 'mention' || part.kind === 'skill') {
    return { kind: part.kind, name: part.name, path: part.path }
  }
  return {
    kind: part.kind,
    file: {
      id: part.file.id,
      name: part.file.name,
      mimeType: part.file.mimeType,
      size: part.file.size
    }
  }
}

function explicitProxySettings(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const) {
    const value = environment[key] || environment[key.toLowerCase()]
    if (value) result[key] = value
  }
  return result
}

async function agentInputToClaudeContent(
  input: AgentInput,
  signal: AbortSignal
): Promise<unknown> {
  throwIfAborted(signal)
  const blocks: UnknownRecord[] = []
  for (const part of input.parts) {
    throwIfAborted(signal)
    if (part.kind === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (part.kind === 'image') {
      if (isImageMime(part.file.mimeType)) {
        const data = await readFile(part.file.path, { signal })
        throwIfAborted(signal)
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.file.mimeType,
            data: data.toString('base64')
          }
        })
      } else {
        blocks.push({ type: 'text', text: `[Image: ${part.file.path}]` })
      }
      continue
    }
    if (part.kind === 'image-url') {
      blocks.push({ type: 'text', text: `[Image URL: ${part.url}]` })
      continue
    }
    if (part.kind === 'audio') {
      blocks.push({ type: 'text', text: `[Audio file: ${part.file.path}]` })
      continue
    }
    if (part.kind === 'audio-url') {
      blocks.push({ type: 'text', text: `[Audio URL: ${part.url}]` })
      continue
    }
    if (part.kind === 'local-file') {
      if (part.file.mimeType === 'application/pdf') {
        const data = await readFile(part.file.path, { signal })
        throwIfAborted(signal)
        blocks.push({
          type: 'document',
          title: part.file.name,
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: data.toString('base64')
          }
        })
      } else {
        blocks.push({
          type: 'text',
          text: `[Attached local file: ${part.file.name}\nPath: ${part.file.path}]`
        })
      }
      continue
    }
    blocks.push({
      type: 'text',
      text: `[${part.kind === 'skill' ? 'Skill' : 'Mention'}: ${part.name}\nPath: ${part.path}]`
    })
  }
  throwIfAborted(signal)
  if (blocks.length === 0) return ''
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text
  return blocks
}

function parseNativeRecord(
  value: UnknownRecord,
  parser: StreamParserState
): ClaudeExecutionNativeEvent[] {
  if (
    value.type === 'system' &&
    value.subtype === 'init' &&
    typeof value.session_id === 'string'
  ) {
    return [
      { type: 'session', sessionId: value.session_id },
      {
        type: 'runtime',
        runtime: {
          ...(stringValue(value.model) ? { model: stringValue(value.model) } : {}),
          ...(stringValue(value.cwd) ? { cwd: stringValue(value.cwd) } : {}),
          ...(stringValue(value.claude_code_version)
            ? { claudeVersion: stringValue(value.claude_code_version) }
            : {}),
          ...(stringValue(value.permissionMode)
            ? { permissionMode: stringValue(value.permissionMode) }
            : {})
        }
      }
    ]
  }
  if (value.type === 'stream_event' && isRecord(value.event)) {
    return parseStreamEvent(value.event, value.parent_tool_use_id, parser)
  }
  if (value.type === 'assistant' && isRecord(value.message)) {
    const events: ClaudeExecutionNativeEvent[] = []
    const parentId = stringValue(value.parent_tool_use_id)
    if (!parentId) {
      events.push({
        type: 'assistant-message-start',
        ...(stringValue(value.message.id) ? { messageId: stringValue(value.message.id) } : {})
      })
    }
    const content = Array.isArray(value.message.content) ? value.message.content : []
    for (const block of content) {
      if (!isRecord(block)) continue
      if (
        block.type === 'text' &&
        typeof block.text === 'string' &&
        !parser.sawTextDelta &&
        !parentId
      ) {
        events.push({
          type: 'text', delta: block.text,
          ...(stringValue(value.message.id) ? { messageId: stringValue(value.message.id) } : {})
        })
      }
      if (
        block.type === 'thinking' &&
        typeof block.thinking === 'string' &&
        !parser.sawReasoningDelta &&
        !parentId
      ) {
        events.push({ type: 'reasoning', delta: block.thinking })
      }
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        !parser.knownToolIds.has(block.id)
      ) {
        parser.knownToolIds.add(block.id)
        recordClaudeTaskMutation(parser, block.id, block.name, block.input)
        events.push({
          type: 'activity-start',
          activity: {
            id: block.id,
            kind: toolKind(stringValue(block.name)),
            label: stringValue(block.name) || '调用工具',
            status: 'running',
            ...(stringValue(block.name) ? { toolName: stringValue(block.name) } : {}),
            ...(compactJson(block.input) ? { detail: compactJson(block.input) } : {}),
            ...(parentId ? { parentId } : {})
          }
        })
      }
    }
    return events
  }
  if (value.type === 'diff_update' && typeof value.diff === 'string') {
    return [{ type: 'diff-update', diff: value.diff }]
  }
  if (value.type === 'review_update' && typeof value.text === 'string') {
    return [{ type: 'review-update', text: value.text }]
  }
  if (value.type === 'user' && isRecord(value.message) && Array.isArray(value.message.content)) {
    const events: ClaudeExecutionNativeEvent[] = []
    for (const block of value.message.content) {
      if (
        !isRecord(block) ||
        block.type !== 'tool_result' ||
        typeof block.tool_use_id !== 'string'
      ) {
        continue
      }
      const detail = extractText(block.content)
      events.push({
        type: 'activity-end',
        id: block.tool_use_id,
        status: block.is_error === true ? 'failed' : 'completed',
        ...(detail ? { detail } : {})
      })
      const mutation = parser.pendingTaskMutations.get(block.tool_use_id)
      parser.pendingTaskMutations.delete(block.tool_use_id)
      if (
        block.is_error !== true &&
        mutation &&
        applyClaudeTaskMutation(parser, mutation, detail)
      ) {
        events.push({ type: 'plan-update', plan: [...parser.nativeTasks.values()] })
      }
    }
    return events
  }
  if (value.type === 'system') {
    if (value.subtype === 'status') {
      if (value.status === 'compacting') return [{ type: 'status', label: '正在压缩上下文' }]
      if (value.status === 'requesting') return [{ type: 'status', label: '正在请求 Claude' }]
    }
    if (value.subtype === 'api_retry') {
      return [
        {
          type: 'notice',
          level: 'warning',
          message: `Claude API 请求失败，准备第 ${String(value.attempt ?? '?')} 次重试`
        }
      ]
    }
    if (value.subtype === 'compact_boundary') {
      return [{ type: 'context-compacted' }]
    }
    if (value.subtype === 'hook_started') {
      const id = stringValue(value.hook_id) || stringValue(value.uuid)
      if (!id) return []
      return [
        {
          type: 'activity-start',
          activity: {
            id,
            kind: 'hook',
            label: stringValue(value.hook_name) || '运行 Hook',
            status: 'running'
          }
        }
      ]
    }
    if (value.subtype === 'hook_response') {
      const id = stringValue(value.hook_id) || stringValue(value.uuid)
      return id
        ? [{ type: 'activity-end', id, status: value.exit_code === 0 ? 'completed' : 'failed' }]
        : []
    }
    if (value.subtype === 'task_started' || value.subtype === 'task_progress') {
      const id = stringValue(value.task_id)
      if (!id) return []
      const detail =
        stringValue(value.summary) ||
        stringValue(value.description) ||
        compactJson(value)
      return value.subtype === 'task_started'
        ? [
            {
              type: 'activity-start',
              activity: {
                id,
                taskId: id,
                kind: 'task',
                label: stringValue(value.description) || '后台任务',
                status: 'running',
                ...(detail ? { detail } : {})
              }
            }
          ]
        : [{ type: 'activity-update', id, detail: detail || '运行中' }]
    }
    if (value.subtype === 'background_tasks_changed' && Array.isArray(value.tasks)) {
      return [
        {
          type: 'runtime',
          runtime: {
            backgroundTasks: value.tasks.filter(isRecord).slice(0, 512).map((task) => ({
              id: stringValue(task.task_id) || 'task',
              ...(stringValue(task.task_type)
                ? { type: stringValue(task.task_type) }
                : {}),
              description: stringValue(task.description) || '后台任务',
              status: stringValue(task.status) || 'running'
            }))
          }
        }
      ]
    }
  }
  if (value.type === 'rate_limit_event') {
    return [
      {
        type: 'notice',
        level: 'warning',
        message: 'Claude Code 使用额度状态已更新'
      }
    ]
  }
  if (value.type === 'auth_status') {
    return value.error
      ? [{ type: 'error', message: stringValue(value.error) || 'Claude Code 认证失败' }]
      : [{ type: 'status', label: value.isAuthenticating === true ? '正在认证 Claude Code' : undefined }]
  }
  return []
}

function parseStreamEvent(
  event: UnknownRecord,
  rawParentId: unknown,
  parser: StreamParserState
): ClaudeExecutionNativeEvent[] {
  const parentId = stringValue(rawParentId)
  const streamId = parentId || '$root'
  if (event.type === 'message_start' && isRecord(event.message)) {
    const generationId = stringValue(event.message.id)
    const events: ClaudeExecutionNativeEvent[] = parentId ? [] : [{
      type: 'assistant-message-start',
      ...(generationId ? { messageId: generationId } : {})
    }]
    if (!generationId) return events
    const accumulator = {
      generationId,
      model: stringValue(event.message.model) || 'unknown',
      usage: isRecord(event.message.usage)
        ? claudeUsage(event.message.usage)
        : {}
    }
    parser.messageUsageByStream.set(streamId, accumulator)
    if (Object.keys(accumulator.usage).length > 0) {
      events.push({ type: 'usage', usageKind: 'generation', provisional: true, ...accumulator })
    }
    return events
  }
  if (event.type === 'content_block_delta' && isRecord(event.delta)) {
    if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
      if (parentId) return [{ type: 'activity-update', id: parentId, detail: event.delta.text }]
      parser.sawTextDelta = true
      const messageId = parser.messageUsageByStream.get(streamId)?.generationId
      return [{ type: 'text', delta: event.delta.text, ...(messageId ? { messageId } : {}) }]
    }
    if (
      event.delta.type === 'thinking_delta' &&
      typeof event.delta.thinking === 'string'
    ) {
      if (parentId) return [{ type: 'activity-update', id: parentId, detail: event.delta.thinking }]
      parser.sawReasoningDelta = true
      return [{ type: 'reasoning', delta: event.delta.thinking }]
    }
    if (
      event.delta.type === 'input_json_delta' &&
      typeof event.delta.partial_json === 'string' &&
      typeof event.index === 'number'
    ) {
      const tool = parser.tools.get(event.index)
      if (!tool) return []
      tool.partialJson = truncate(
        `${tool.partialJson}${event.delta.partial_json}`,
        8_000
      )
      return [
        {
          type: 'activity-update',
          id: tool.id,
          detail: truncate(tool.partialJson, 8_000)
        }
      ]
    }
  }
  if (event.type === 'content_block_start' && isRecord(event.content_block)) {
    const block = event.content_block
    const id = stringValue(block.id)
    if (block.type === 'tool_use' && id) {
      const index = typeof event.index === 'number' ? event.index : -1
      const canonicalName = stringValue(block.name)
      const name = canonicalName || '调用工具'
      parser.tools.set(index, { id, name, input: block.input, partialJson: '' })
      parser.knownToolIds.add(id)
      return [
        {
          type: 'activity-start',
          activity: {
            id,
            kind: toolKind(name),
            label: name,
            status: 'running',
            ...(canonicalName ? { toolName: canonicalName } : {}),
            ...(parentId ? { parentId } : {}),
            ...(compactJson(block.input) ? { detail: compactJson(block.input) } : {})
          }
        }
      ]
    }
    if (block.type === 'thinking') return [{ type: 'status', label: '正在思考' }]
  }
  if (event.type === 'content_block_stop' && typeof event.index === 'number') {
    const tool = parser.tools.get(event.index)
    if (!tool) return []
    recordClaudeTaskMutation(
      parser,
      tool.id,
      tool.name,
      parsedJson(tool.partialJson) ?? tool.input
    )
    return [{ type: 'activity-update', id: tool.id, detail: truncate(tool.partialJson, 8_000) }]
  }
  if (event.type === 'message_delta' && isRecord(event.usage)) {
    const accumulator = parser.messageUsageByStream.get(streamId)
    if (accumulator) {
      accumulator.usage = mergeClaudeUsageSnapshot(
        accumulator.usage,
        claudeUsage(event.usage)
      )
      return [{ type: 'usage', usageKind: 'generation', provisional: true, ...accumulator }]
    }
    return []
  }
  if (event.type === 'message_stop') {
    const accumulator = parser.messageUsageByStream.get(streamId)
    if (!accumulator) return []
    parser.messageUsageByStream.delete(streamId)
    if (Object.keys(accumulator.usage).length === 0) return []
    return [{
      type: 'usage',
      usageKind: 'generation',
      generationId: accumulator.generationId,
      model: accumulator.model,
      usage: accumulator.usage
    }]
  }
  return []
}

function controlRequestToInteraction(
  id: string,
  request: UnknownRecord
): ClaudeInteraction | null {
  const subtype = stringValue(request.subtype)
  if (subtype === 'can_use_tool') {
    const toolName = stringValue(request.tool_name) || '工具'
    const isQuestion = toolName === 'AskUserQuestion'
    const input = jsonValue(request.input)
    return {
      id,
      kind: isQuestion ? 'question' : 'permission',
      title:
        stringValue(request.title) ||
        (isQuestion
          ? 'Claude 需要你的选择'
          : `允许 Claude 使用 ${stringValue(request.display_name) || toolName}？`),
      ...(stringValue(request.description) || stringValue(request.decision_reason)
        ? {
            description:
              stringValue(request.description) || stringValue(request.decision_reason)
          }
        : {}),
      toolName,
      canRemember:
        Array.isArray(request.permission_suggestions) &&
        request.permission_suggestions.length > 0,
      status: 'pending',
      // AskUserQuestion raw prompts/options remain only on the pending native
      // request used for protocol response encoding. The public/private
      // presentation is separately bounded and uses positional opaque IDs.
      ...(input === undefined || isQuestion ? {} : { input }),
      ...(isQuestion
        ? { questions: normalizeQuestions(isRecord(request.input) ? request.input.questions : undefined) }
        : {})
    }
  }
  if (subtype === 'elicitation') {
    const schema = jsonValue(request.requested_schema ?? request.requestedSchema)
    const url = safeHttpUrl(request.url)
    const elicitationMode =
      stringValue(request.mode).toLowerCase() === 'url' || url
        ? 'url'
        : 'form'
    return {
      id,
      kind: 'elicitation',
      title:
        stringValue(request.title) ||
        stringValue(request.display_name) ||
        'MCP 需要输入',
      status: 'pending',
      ...(stringValue(request.description) || stringValue(request.message)
        ? {
            description:
              stringValue(request.description) || stringValue(request.message)
          }
        : {}),
      ...(schema === undefined ? {} : { schema }),
      elicitationMode,
      ...(url ? { url } : {}),
      ...(stringValue(request.elicitation_id)
        ? { elicitationId: stringValue(request.elicitation_id) }
        : {}),
      ...(stringValue(request.mcp_server_name) || stringValue(request.server_name) ||
      stringValue(request.serverName)
        ? {
            serverName:
              stringValue(request.mcp_server_name) ||
              stringValue(request.server_name) ||
              stringValue(request.serverName)
          }
        : {})
    }
  }
  if (subtype === 'request_user_dialog') {
    return {
      id,
      kind: 'dialog',
      title: `Claude Code：${stringValue(request.dialog_kind) || '需要确认'}`,
      status: 'pending',
      ...(jsonValue(request.payload) === undefined
        ? {}
        : { input: jsonValue(request.payload) })
    }
  }
  return null
}

function interactionResolutionStatus(
  kind: ClaudeInteraction['kind'],
  behavior: string
): Exclude<ClaudeInteractionStatus, 'pending'> {
  if (behavior === 'cancel') return 'cancelled'
  if (behavior === 'deny') return 'denied'
  if (kind === 'permission') return 'allowed'
  if (kind === 'question' || kind === 'elicitation') return 'submitted'
  return 'resolved'
}

function normalizeQuestions(value: unknown): ClaudeInteraction['questions'] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).slice(0, 32).map((question) => ({
    question: stringValue(question.question) || '请选择',
    ...(stringValue(question.header) ? { header: stringValue(question.header) } : {}),
    multiSelect: question.multiSelect === true,
    options: Array.isArray(question.options)
      ? question.options.filter(isRecord).slice(0, 32).map((option) => ({
          label: stringValue(option.label) || '选项',
          ...(stringValue(option.description)
            ? { description: stringValue(option.description) }
            : {})
        }))
      : []
  }))
}

function createParserState(): StreamParserState {
  return {
    sawTextDelta: false,
    sawReasoningDelta: false,
    tools: new Map(),
    knownToolIds: new Set(),
    nativeTasks: new Map(),
    pendingTaskMutations: new Map(),
    messageUsageByStream: new Map()
  }
}

function toolKind(name: string): ClaudeActivity['kind'] {
  const lower = name.trim().toLowerCase()
  if (
    ['bash', 'shell', 'command', 'terminal'].includes(lower) ||
    lower.includes('terminal')
  ) return 'command'
  if (
    ['edit', 'write', 'read', 'apply_patch', 'patch', 'multiedit', 'notebookedit'].includes(lower)
  ) return 'file'
  if (
    ['web_search', 'websearch', 'webfetch', 'web fetch', 'grep', 'glob'].includes(lower) ||
    lower.includes('search')
  ) return 'search'
  if (lower === 'agent' || lower === 'workflow') return 'agent'
  if (lower === 'task') return 'task'
  if (lower.includes('hook')) return 'hook'
  return 'tool'
}

/** Claude Code 2.1 TaskCreate/TaskUpdate are the native plan facts. */
function recordClaudeTaskMutation(
  parser: StreamParserState,
  toolUseId: string,
  rawName: unknown,
  rawInput: unknown
): void {
  const name = stringValue(rawName)
  if (!isRecord(rawInput)) return
  if (name === 'TaskCreate') {
    const step = stringValue(rawInput.subject).trim()
    if (step) parser.pendingTaskMutations.set(toolUseId, { type: 'create', step })
    return
  }
  if (name !== 'TaskUpdate') return
  const taskId = stringValue(rawInput.taskId).trim()
  if (!taskId) return
  const rawStatus = stringValue(rawInput.status)
  const status = rawStatus === 'deleted'
    ? 'deleted'
    : rawStatus
      ? claudeTaskStatus(rawStatus)
      : undefined
  const step = stringValue(rawInput.subject).trim() || undefined
  if (status || step) {
    parser.pendingTaskMutations.set(toolUseId, {
      type: 'update',
      taskId,
      ...(status ? { status } : {}),
      ...(step ? { step } : {})
    })
  }
}

function applyClaudeTaskMutation(
  parser: StreamParserState,
  mutation: ClaudeNativeTaskMutation,
  result: string
): boolean {
  if (mutation.type === 'create') {
    const taskId = result.match(/Task\s+#([^\s]+)\s+created\s+successfully/i)?.[1]
    if (!taskId) return false
    parser.nativeTasks.set(taskId, { step: mutation.step, status: 'pending' })
    return true
  }
  if (mutation.status === 'deleted') return parser.nativeTasks.delete(mutation.taskId)
  const current = parser.nativeTasks.get(mutation.taskId)
  if (!current) return false
  parser.nativeTasks.set(mutation.taskId, {
    step: mutation.step || current.step,
    status: mutation.status || current.status
  })
  return true
}

function claudeTaskStatus(status: string): ClaudePlanStep['status'] {
  if (status === 'completed') return 'completed'
  if (status === 'in_progress' || status === 'in-progress' || status === 'inProgress') {
    return 'inProgress'
  }
  return 'pending'
}

function claudeUsage(usage: UnknownRecord): ClaudeUsage {
  const input = numberValue(usage.input_tokens)
  const output = numberValue(usage.output_tokens)
  const cached = numberValue(usage.cache_read_input_tokens)
  const cacheWrite = numberValue(usage.cache_creation_input_tokens)
  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : {}
  const reasoning = numberValue(outputDetails.thinking_tokens)
  const total = numberValue(usage.total_tokens)
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cached === undefined ? {} : { cachedTokens: cached }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(input === undefined
      ? {}
      : {
          contextTokens:
            input + (cached || 0) + (cacheWrite || 0) + (output || 0)
        }),
  }
}

function mergeClaudeUsageSnapshot(
  previous: ClaudeUsage,
  next: ClaudeUsage
): ClaudeUsage {
  const merged = { ...previous, ...next }
  if (
    merged.inputTokens !== undefined ||
    merged.cachedTokens !== undefined ||
    merged.cacheWriteTokens !== undefined ||
    merged.outputTokens !== undefined
  ) {
    merged.contextTokens =
      (merged.inputTokens || 0) +
      (merged.cachedTokens || 0) +
      (merged.cacheWriteTokens || 0) +
      (merged.outputTokens || 0)
  }
  return merged
}

export function claudeModelCostEvents(
  modelUsage: UnknownRecord,
  previousCosts: Map<string, number>,
  resultBoundaryId: string
): ClaudeExecutionNativeEvent[] {
  const events: ClaudeExecutionNativeEvent[] = []
  for (const [modelKey, rawUsage] of Object.entries(modelUsage)) {
    if (!isRecord(rawUsage)) continue
    const cumulative = numberValue(rawUsage.costUSD)
    if (cumulative === undefined || cumulative < 0) continue
    const previous = previousCosts.get(modelKey) || 0
    previousCosts.set(modelKey, cumulative)
    const delta = cumulative - previous
    if (delta <= 0) continue
    events.push({
      type: 'usage',
      usageKind: 'summary',
      generationId: `${resultBoundaryId}:model-cost:${modelKey}`,
      model: stringValue(rawUsage.canonicalModel) || modelKey,
      usage: { costUsd: delta }
    })
  }
  return events
}

function parsedJson(value: string): unknown {
  if (!value.trim()) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function isTopLevelUserFrame(value: UnknownRecord): boolean {
  if (value.type !== 'user' || value.parent_tool_use_id != null || !isRecord(value.message)) return false
  const content = value.message.content
  // Root tool results also use user frames. They must reach the activity/task parser.
  if (!Array.isArray(content)) return typeof content === 'string'
  return !content.some((block) => isRecord(block) && block.type === 'tool_result')
}

function userFrameText(value: UnknownRecord): string {
  if (!isRecord(value.message)) return ''
  const content = value.message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((item) => isRecord(item) && item.type === 'text')
    .map((item) => stringValue(item.text))
    .join('\n')
    .trim()
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return truncate(value, 20_000)
  if (!Array.isArray(value)) return compactJson(value)
  return truncate(
    value
      .filter(isRecord)
      .map((item) => stringValue(item.text) || compactJson(item))
      .filter(Boolean)
      .join('\n'),
    20_000
  )
}

function compactJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    return truncate(JSON.stringify(value), 8_000)
  } catch {
    return ''
  }
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (isBoundedInteractionJson(value)) return structuredClone(value)
  return undefined
}

function safeHttpUrl(value: unknown): string | undefined {
  const raw = stringValue(value)
  if (!raw || raw.length > 8_192) return undefined
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : undefined
  } catch {
    return undefined
  }
}

function isImageMime(
  value: string
): value is 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(value)
}

function bareModeCanAuthenticate(environment: NodeJS.ProcessEnv): boolean {
  if (environment.ANTHROPIC_API_KEY?.trim()) return true
  return [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY'
  ].some((key) => {
    const value = environment[key]?.trim().toLowerCase()
    return Boolean(value && value !== '0' && value !== 'false')
  })
}


function signalProcessTree(
  child: { pid?: number; kill?: (signal?: NodeJS.Signals) => boolean } | undefined,
  processGroupIds: readonly number[],
  signal: 'SIGTERM' | 'SIGKILL'
): void {
  if (process.platform !== 'win32' && processGroupIds.length) {
    for (const processGroupId of processGroupIds) {
      try {
        process.kill(-processGroupId, signal)
      } catch {
        // The group may have exited between the liveness probe and signal.
      }
    }
    return
  }
  if (child) {
    try {
      child.kill?.(signal)
    } catch {
      // Already gone.
    }
  }
}

async function waitForProcessTreeExit(
  child: ChildProcessWithoutNullStreams | undefined,
  processGroupIds: readonly number[],
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const childExited =
      child === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    const groupsExited = processGroupIds.every(
      (processGroupId) => !processGroupExists(processGroupId)
    )
    if (childExited && groupsExited) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(25, remaining))
    })
  }
}

function processGroupExists(processGroupId: number): boolean {
  if (process.platform === 'win32') return false
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    ) {
      return false
    }
    return true
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function abortError(): Error {
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  return error
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // The operation may already have started before its signal was aborted.
    // Always observe its rejection, even when cancellation wins immediately.
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
    if (signal.aborted) onAbort()
  })
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    timer.unref()
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function keepTail(value: string, max = 16_000): string {
  return value.length <= max ? value : value.slice(-max)
}

function truncate(value: string, max: number): string {
  const sanitized = value.replaceAll('\0', '')
  return sanitized.length <= max
    ? sanitized
    : `${sanitized.slice(0, max - 1)}…`
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
