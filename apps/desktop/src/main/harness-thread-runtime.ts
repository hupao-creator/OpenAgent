import type { AgentInput } from '@openagent/contracts'
import { isJsonValue, parseThreadPublicObservation, type JsonValue } from '@openagent/contracts'
import {
  parseHarnessRespondRequest,
  type DeepReadonly,
  type HarnessThreadRecord,
  type HarnessExecutionClaim,
  type HarnessThreadHandle,
  type HarnessThreadOpenContext,
  type HarnessRespondRequest,
  type HarnessSessionStateStore,
  type HarnessSessionStateAdapter,
  type ThreadPublicObservation,
  type PublicExecution,
  type PublicInteraction
} from '@openagent/contracts'
import type { HarnessId } from '@openagent/contracts'
import type { BartTelemetryLedgerCapability } from '@openagent/contracts'
import {
  readHarnessThread,
  isAgentThreadRecord
} from '../shared/openagent-state'
import {
  createDebugTrace,
  debugDetail,
  debugError,
  debugLog,
  getDebugContext,
  startDebugSpan,
  withDebugContext
} from '@openagent/plugin-kit/main'
import { ThreadStateStore } from './services/thread-state-store'
import { SerialQueue } from './services/serial-queue'

type DebugContext = ReturnType<typeof createDebugTrace>

export interface ThreadSendResult {
  readonly executionId: string
  readonly startedNewExecution: boolean
}

/** Process-local, provider-neutral exclusion held while Core derives a fork. */
export interface ThreadForkReservation {
  release(): void
}

export type ThreadSendAdmitted = (result: ThreadSendResult) => void | Promise<void>

/** Cleanup or observation-durability failure after an opening cannot install. */
export class HarnessThreadOpeningCleanupError extends Error {
  constructor(
    readonly openingError: unknown,
    readonly cleanupError: unknown
  ) {
    super('Harness Thread Handle 打开后失去所有权且清理失败', {
      cause: cleanupError
    })
    this.name = 'HarnessThreadOpeningCleanupError'
  }
}

/** Core-owned process-local control state; never part of the Plugin contract. */
export interface ActiveThreadExecution {
  readonly threadId: string
  readonly executionId: string
  readonly status: 'running'
  readonly startedAt: number
}

export interface HarnessThreadCommitted<
  Id extends HarnessId = HarnessId,
  ThreadSettings = unknown
> {
  readonly record: DeepReadonly<HarnessThreadRecord<Id, ThreadSettings>>
  readonly observation: DeepReadonly<ThreadPublicObservation>
  /** True only when the derived public observation changed in this commit. */
  readonly observationChanged: boolean
  /** True only when latestExecution changed; background-only updates are not terminal events. */
  readonly executionChanged: boolean
}

export interface OpenHarnessThreadInstanceOptions<
  Id extends HarnessId,
  ThreadSettings
> {
  readonly store: ThreadStateStore
  readonly threadId: string
  readonly harnessId: Id
  readonly openThread: (
    context: HarnessThreadOpenContext<Id, ThreadSettings>
  ) => Promise<HarnessThreadHandle>
  readonly sessionStateAdapter: HarnessSessionStateAdapter
  readonly createExecutionId: () => string
  readonly now: () => number
  readonly signal: AbortSignal
  /**
   * Optional Thread-bound Core authorization applied to claimed native work
   * before the shared state durability barrier. Bart Threads use only the
   * provider-neutral durability portion.
   */
  readonly admitNativeExecution?: (signal: AbortSignal) => Promise<void>
  /** Fixed by the composition binding; direct Core tests may use the empty scope. */
  readonly telemetryLedger?: BartTelemetryLedgerCapability
  readonly committed: (
    change: HarnessThreadCommitted<Id, ThreadSettings>
  ) => void
}

interface ExecutionClaim {
  started: boolean
  terminal: boolean
  sendSettled: boolean
}

interface PendingSendAdmission {
  readonly executionId: string
  readonly callback: ThreadSendAdmitted
  readonly signal: AbortSignal
  operation?: Promise<void>
}

type HandleSendSettlement =
  | { readonly status: 'fulfilled' }
  | { readonly status: 'rejected' }

interface PendingSendOperation {
  readonly debugContext: DebugContext
  readonly controller: AbortController
  readonly handleSettlement: Promise<HandleSendSettlement>
  readonly settleHandle: (settlement: HandleSendSettlement) => void
  readonly completion: Promise<void>
  readonly settleCompletion: () => void
  executionId: string | null
  startedNewExecution: boolean
  nativeStarted: boolean
  stopRequested: boolean
}

interface PendingInterruptOperation {
  readonly executionId: string
  readonly operation: Promise<void>
}

interface PendingObservationSubmission {
  readonly observation: ThreadPublicObservation
  settled: boolean
}

interface ExecutionReservation {
  readonly executionId: string
  readonly source: 'send' | 'native'
  readonly debugContext: DebugContext
  state: 'pending' | 'consuming' | 'consumed' | 'abandoned'
}

interface NativeExecutionAdmission {
  readonly reservation: ExecutionReservation
  admitted: boolean
  operation?: Promise<void>
}

/** One process-local Handle owner for one persisted Harness Thread. */
export class HarnessThreadInstance<
  Id extends HarnessId = HarnessId,
  ThreadSettings = unknown
> {
  private readonly observations = new SerialQueue()
  private readonly sends = new SerialQueue()
  private readonly controller = new AbortController()
  private readonly claims = new Map<string, ExecutionClaim>()
  private readonly usedExecutionIds = new Set<string>()
  private readonly interruptedExecutionIds = new Set<string>()
  private readonly nativeInterruptSucceededExecutionIds = new Set<string>()
  private readonly interruptOperations = new Map<string, Promise<void>>()
  private readonly pendingSends = new Set<PendingSendOperation>()
  private readonly nativeExecutionAdmissions = new Map<
    string,
    NativeExecutionAdmission
  >()
  /** Captured once per execution so follow-ups cannot retarget its owner. */
  private readonly executionContexts = new Map<string, DebugContext>()
  private readonly unlinkParentSignal: () => void
  private handle: HarnessThreadHandle | undefined
  private active: ActiveThreadExecution | null = null
  private currentObservation: ThreadPublicObservation
  private terminalObservation: Promise<void> | undefined
  private latestObservationSubmission: PendingObservationSubmission | undefined
  private pendingInterrupt: PendingInterruptOperation | undefined
  private pendingExecution: ExecutionReservation | null = null
  private forkReservation: object | undefined
  private pendingSendAdmission: PendingSendAdmission | undefined
  private acceptingObservations = true
  private disposing = false
  private disposed = false
  private disposePromise: Promise<void> | undefined
  private refValid = true

  private constructor(
    private readonly options: OpenHarnessThreadInstanceOptions<Id, ThreadSettings>
  ) {
    const initial = this.currentRecord()
    if (initial.harnessId !== options.harnessId) {
      throw new Error(
        `Harness Thread 不匹配: expected ${options.harnessId}, actual ${initial.harnessId}`
      )
    }
    this.currentObservation = parseThreadPublicObservation(
      options.sessionStateAdapter.project(initial.sessionState)
    )
    const execution = this.currentObservation.latestExecution
    if (execution && !isTerminalPublicExecution(execution)) {
      const debugContext = ensureDebugContext({
        threadId: options.threadId,
        harnessId: options.harnessId,
        executionId: execution.executionId
      })
      this.executionContexts.set(execution.executionId, debugContext)
      this.active = Object.freeze({
        threadId: options.threadId,
        executionId: execution.executionId,
        status: 'running' as const,
        startedAt: execution.startedAt
      })
    }
    this.unlinkParentSignal = linkAbortSignal(options.signal, this.controller)
  }

  static async open<Id extends HarnessId, ThreadSettings>(
    options: OpenHarnessThreadInstanceOptions<Id, ThreadSettings>
  ): Promise<HarnessThreadInstance<Id, ThreadSettings>> {
    const instance = new HarnessThreadInstance(options)
    await instance.openHandle()
    return instance
  }

  get execution(): DeepReadonly<ActiveThreadExecution> | null {
    return this.active
  }

  get observation(): DeepReadonly<ThreadPublicObservation> {
    return this.currentObservation
  }

  reserveFork(): ThreadForkReservation {
    this.assertOperational()
    if (this.forkReservation) throw new Error('Thread fork 已在进行')
    const submittedExecution = this.latestObservationSubmission?.settled === false
      ? this.latestObservationSubmission.observation.latestExecution
      : null
    const current = this.currentObservation.latestExecution
    if (
      this.active ||
      this.pendingExecution ||
      this.pendingSends.size > 0 ||
      (submittedExecution !== null && !isTerminalPublicExecution(submittedExecution)) ||
      (current !== null && !isTerminalPublicExecution(current))
    ) {
      throw new Error('Thread 已有 active、pending Execution 或 send admission')
    }
    const reservation = {}
    this.forkReservation = reservation
    return Object.freeze({
      release: () => {
        if (this.forkReservation === reservation) this.forkReservation = undefined
      }
    })
  }

  send(
    input: AgentInput,
    signal: AbortSignal,
    contextEntries: readonly {
      readonly id: string
      readonly content: string
    }[] = [],
    onAdmitted?: ThreadSendAdmitted
  ): Promise<ThreadSendResult> {
    const parentContext = ensureDebugContext({
      threadId: this.options.threadId,
      harnessId: this.options.harnessId
    })
    const span = withDebugContext(parentContext, () => startDebugSpan(
      'harness.thread.send',
      {
        threadId: this.options.threadId,
        harnessId: this.options.harnessId,
        contextEntryIds: contextEntries.map(entry => entry.id)
      }
    ))
    const failSynchronously = (error: unknown): Promise<ThreadSendResult> => {
      span.fail(error, {
        threadId: this.options.threadId,
        harnessId: this.options.harnessId
      })
      return Promise.reject(error)
    }
    try {
      this.assertOperational()
      if (this.forkReservation) throw new Error('Thread fork 进行期间不能 send')
    } catch (error) {
      return failSynchronously(error)
    }
    let snapshot: AgentInput
    try {
      snapshot = structuredClone(input)
    } catch (error) {
      return failSynchronously(new Error('Agent input 无法复制', { cause: error }))
    }
    let contextSnapshot: typeof contextEntries
    try {
      contextSnapshot = structuredClone(contextEntries)
    } catch (error) {
      return failSynchronously(new Error('Agent context entries 无法复制', { cause: error }))
    }
    withDebugContext(span.context, () => debugDetail('harness.thread.send.input', {
      threadId: this.options.threadId,
      harnessId: this.options.harnessId,
      input: snapshot,
      contextEntries: contextSnapshot
    }))
    const observationBarrier = this.observations.drain()
    let settleHandle!: (settlement: HandleSendSettlement) => void
    const handleSettlement = new Promise<HandleSendSettlement>(resolve => {
      settleHandle = resolve
    })
    let settleCompletion!: () => void
    const completion = new Promise<void>(resolve => { settleCompletion = resolve })
    const pending: PendingSendOperation = {
      debugContext: span.context,
      controller: new AbortController(),
      handleSettlement,
      settleHandle,
      completion,
      settleCompletion,
      executionId: null,
      startedNewExecution: false,
      nativeStarted: false,
      stopRequested: false
    }
    this.pendingSends.add(pending)
    let operation: Promise<ThreadSendResult>
    try {
      operation = this.sends.run(() => withDebugContext(span.context, () =>
        this.sendSerial(
          snapshot,
          signal,
          contextSnapshot,
          onAdmitted,
          pending,
          observationBarrier
        )
      ))
    } catch (error) {
      return failSynchronously(error)
    }
    return operation.finally(() => {
      this.pendingSends.delete(pending)
      pending.settleCompletion()
    }).then(
      result => {
        span.end({
          threadId: this.options.threadId,
          harnessId: this.options.harnessId,
          executionId: result.executionId,
          startedNewExecution: result.startedNewExecution
        })
        return result
      },
      error => {
        span.fail(error, {
          threadId: this.options.threadId,
          harnessId: this.options.harnessId,
          executionId: pending.executionId
        })
        throw error
      }
    )
  }

  interrupt(expectedExecutionId?: string | null): Promise<void> {
    try {
      this.assertOperational()
    } catch (error) {
      return Promise.reject(error)
    }
    const span = withDebugContext(
      this.contextForExecution(expectedExecutionId),
      () => startDebugSpan('harness.thread.interrupt', {
        threadId: this.options.threadId,
        harnessId: this.options.harnessId,
        expectedExecutionId
      })
    )
    const observe = <Result>(
      operation: Promise<Result>,
      fields: Record<string, unknown> = {}
    ): void => {
      // Keep the owner Promise intact: callers use identity to coalesce
      // concurrent Stop requests. This observer consumes its rejection and
      // closes only this request's diagnostic span.
      void operation.then(
        () => span.end(fields),
        error => span.fail(error, fields)
      )
    }
    const reason = new Error('Harness Thread send interrupted before native admission')
    let cancelledPendingSend = false
    const cancelledUnownedCompletions: Promise<void>[] = []
    const submittedExecution = this.latestObservationSubmission?.settled === false
      ? this.latestObservationSubmission.observation.latestExecution
      : null
    let ownedPending: {
      readonly executionId: string
      readonly handleSettlement: Promise<HandleSendSettlement>
    } | undefined
    for (const pending of this.pendingSends) {
      if (pending.nativeStarted) {
        const executionId = pending.executionId
        if (typeof expectedExecutionId === 'string' &&
            pending.startedNewExecution &&
            executionId !== expectedExecutionId) {
          // An execution-scoped Stop must not revoke an entered successor that
          // has not published yet. It owns only its exact execution ID.
          continue
        }
        if (!pending.startedNewExecution) continue
        if (executionId === null) continue
        cancelledPendingSend = true
        ownedPending ??= {
          executionId,
          handleSettlement: pending.handleSettlement
        }
        if (pending.stopRequested) continue
        pending.stopRequested = true
        const hasPublishedAuthority = this.active?.executionId === executionId ||
          (submittedExecution?.executionId === executionId &&
            !isTerminalPublicExecution(submittedExecution))
        this.interruptedExecutionIds.add(executionId)
        if (!hasPublishedAuthority) {
          // Stop owns this exact entered send before it owns a public
          // Execution. Revoke the reservation before abort dispatch so even a
          // synchronous abort listener cannot publish a late running state.
          this.releasePendingSendExecution(executionId)
        }
        pending.controller.abort(reason)
        continue
      }
      if (pending.stopRequested) {
        cancelledPendingSend = true
        cancelledUnownedCompletions.push(pending.completion)
        continue
      }
      if (pending.controller.signal.aborted) continue
      pending.stopRequested = true
      cancelledPendingSend = true
      cancelledUnownedCompletions.push(pending.completion)
      pending.controller.abort(reason)
    }
    const observationBarrier = this.observations.drain()
    // An explicit null is a call-time assertion that Core observed no public
    // Execution. It may cancel a pre-native send ticket or bind to the exact
    // entered send whose publication raced that snapshot, but must never be
    // retargeted to a pending native claim or an unrelated submitted successor
    // (the pending/submitted ABA race).
    if (expectedExecutionId === null && !ownedPending) {
      const operation = cancelledPendingSend
        ? Promise.all(cancelledUnownedCompletions).then(() => undefined)
        : Promise.reject(new Error('Thread 当前没有 active Execution'))
      observe(operation, {
        outcome: cancelledPendingSend ? 'cancelled-pending-send' : 'no-active-execution'
      })
      return operation
    }
    const currentExecutionId = submittedExecution &&
      !isTerminalPublicExecution(submittedExecution)
      ? submittedExecution.executionId
      : this.active?.executionId ?? this.pendingExecution?.executionId ?? null
    const executionId = typeof expectedExecutionId === 'string'
      ? expectedExecutionId
      : expectedExecutionId === null
        ? ownedPending?.executionId ?? null
        : ownedPending?.executionId ?? currentExecutionId
    if (!executionId) {
      const operation = cancelledPendingSend
        ? Promise.all(cancelledUnownedCompletions).then(() => undefined)
        : Promise.reject(new Error('Thread 当前没有 active Execution'))
      observe(operation, {
        outcome: cancelledPendingSend ? 'cancelled-pending-send' : 'no-active-execution'
      })
      return operation
    }
    const existingInterrupt = this.interruptOperations.get(executionId)
    if (existingInterrupt) {
      observe(existingInterrupt, { executionId, outcome: 'joined' })
      return existingInterrupt
    }
    const previousInterrupt = this.pendingInterrupt
    // A native wake can publish successor B after A's terminal commit but before
    // A's native interrupt call returns. Stop(B) must not join A's old operation:
    // serialize behind it while retaining B as the exact call-time target.
    const interruptContext = this.executionContexts.get(executionId) ?? span.context
    const interruptExact = () => withDebugContext(interruptContext, () =>
      ownedPending?.executionId === executionId
        ? this.interruptPendingSendExecution(
            executionId,
            ownedPending.handleSettlement,
            observationBarrier
          )
        : this.interruptExecution(executionId, observationBarrier)
    )
    const operation = previousInterrupt
      ? previousInterrupt.operation
          .catch(() => undefined)
          .then(interruptExact)
      : interruptExact()
    const pending = { executionId, operation }
    // Execution IDs are unique for this Handle lifetime. Retaining the exact
    // operation makes Stop idempotent even after a native failure or after a
    // different Execution temporarily becomes the serialization tail.
    this.interruptOperations.set(executionId, operation)
    this.pendingInterrupt = pending
    void operation.then(
      () => {
        if (this.pendingInterrupt === pending) this.pendingInterrupt = undefined
      },
      () => {
        if (this.pendingInterrupt === pending) this.pendingInterrupt = undefined
        // A Stop can race native-session installation. Coalesce every caller
        // while that attempt is in flight, but do not turn a transient native
        // rejection into a permanent inability to stop this Execution.
        if (this.interruptOperations.get(executionId) === operation) {
          this.interruptOperations.delete(executionId)
        }
      }
    )
    observe(operation, { executionId })
    return operation
  }

  async respond(response: HarnessRespondRequest): Promise<void> {
    return runRuntimeDebugSpan(
      'harness.thread.respond',
      {
        threadId: this.options.threadId,
        harnessId: this.options.harnessId
      },
      async () => {
        const snapshot = normalizeRespondRequest(response)
        debugDetail('harness.thread.respond.input', {
          threadId: this.options.threadId,
          harnessId: this.options.harnessId,
          response: snapshot
        })
        const observationBarrier = this.observations.drain()
        await observationBarrier
        if (this.terminalObservation) await this.waitForTerminalObservation()
        this.assertOperational()
        const waiting = this.currentObservation.latestExecution
        if (!this.active || waiting?.status !== 'waiting-for-user') {
          throw new Error('Thread 当前没有等待响应的 Execution')
        }
        const interaction = waiting.interactions.find(
          candidate => candidate.id === snapshot.interactionId
        )
        if (!interaction) {
          throw new Error('Agent interaction 已处理或不存在')
        }
        const action = interaction.actions.find(
          candidate => candidate.id === snapshot.actionId
        )
        if (!action) {
          throw new Error(`Agent interaction action 不可用：${snapshot.actionId}`)
        }
        validateRespondAnswers(interaction, snapshot.answers)
        await withDebugContext(this.contextForExecution(waiting.executionId), () =>
          this.requiredHandle().respond(
            normalizeMultipleQuestionAnswers(interaction, snapshot)
          )
        )
      }
    )
  }

  async read(question: string, signal: AbortSignal): Promise<string> {
    return runRuntimeDebugSpan(
      'harness.thread.read',
      {
        threadId: this.options.threadId,
        harnessId: this.options.harnessId
      },
      async () => {
        this.assertOperational()
        if (typeof question !== 'string' || !question.trim()) {
          throw new Error('Thread read question 不能为空')
        }
        debugDetail('harness.thread.read.input', {
          threadId: this.options.threadId,
          harnessId: this.options.harnessId,
          question
        })
        const operationSignal = AbortSignal.any([signal, this.controller.signal])
        operationSignal.throwIfAborted()
        const execution = this.currentObservation.latestExecution
        const result = await withDebugContext(this.contextForExecution(execution?.executionId), () =>
          this.requiredHandle().read(question, operationSignal)
        )
        debugDetail('harness.thread.read.result', {
          threadId: this.options.threadId,
          harnessId: this.options.harnessId,
          question,
          result
        })
        return result
      }
    )
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      const span = withDebugContext(
        ensureDebugContext({
          threadId: this.options.threadId,
          harnessId: this.options.harnessId
        }),
        () => startDebugSpan('harness.thread.dispose', {
          threadId: this.options.threadId,
          harnessId: this.options.harnessId
        })
      )
      this.disposePromise = this.disposeOnce().then(
        result => {
          span.end({ threadId: this.options.threadId, harnessId: this.options.harnessId })
          return result
        },
        error => {
          span.fail(error, { threadId: this.options.threadId, harnessId: this.options.harnessId })
          throw error
        }
      )
    }
    return this.disposePromise
  }

  private async disposeOnce(): Promise<void> {
    if (this.disposed) return
    this.disposing = true
    this.forkReservation = undefined
    this.controller.abort(new Error('Harness Thread Instance disposed'))
    if (this.pendingExecution) this.pendingExecution.state = 'abandoned'
    this.pendingExecution = null
    let disposeError: unknown
    try {
      await this.handle?.dispose()
    } catch (error) {
      disposeError = error
    }
    await this.sends.drain()
    await this.observations.drain()
    try {
      await this.observations.run(() => this.convergeInterruptedObservation())
    } catch (error) {
      disposeError ??= error
    }
    this.acceptingObservations = false
    this.claims.clear()
    this.nativeExecutionAdmissions.clear()
    this.executionContexts.clear()
    this.interruptedExecutionIds.clear()
    this.nativeInterruptSucceededExecutionIds.clear()
    this.refValid = false
    this.disposed = true
    this.disposing = false
    this.unlinkParentSignal()
    if (disposeError) throw disposeError
  }

  private async openHandle(): Promise<void> {
    const span = withDebugContext(
      ensureDebugContext({
        threadId: this.options.threadId,
        harnessId: this.options.harnessId
      }),
      () => startDebugSpan('harness.thread.open', {
        threadId: this.options.threadId,
        harnessId: this.options.harnessId
      })
    )
    let openedHandle: HarnessThreadHandle | undefined
    let trackOpeningState = true
    const openingStateOperations: Promise<void>[] = []
    const trackOpeningStateOperation = (operation: Promise<void>): Promise<void> => {
      if (trackOpeningState) {
        openingStateOperations.push(operation)
        // The Plugin still owns the returned rejection. This observer only
        // prevents a fire-and-forget opening write from becoming an unhandled
        // rejection before the opening cleanup audits it.
        void operation.catch(() => undefined)
      }
      return operation
    }
    try {
      const sessionState: HarnessSessionStateStore = {
        read: () => this.currentRecord().sessionState,
        commit: state => trackOpeningStateOperation(this.commitSessionState(state))
      }
      openedHandle = await withDebugContext(span.context, () => this.options.openThread({
          thread: {
            id: this.options.threadId,
            read: () => {
              if (!this.refValid) throw new Error('HarnessThreadRef 已失效')
              return this.currentRecord()
            }
          },
          sessionState,
          executionClaims: { claim: () => this.claimNativeExecution() },
          executionAdmission: {
            admit: executionId => this.admitNativeExecution(executionId)
          },
          telemetryLedger: this.options.telemetryLedger ?? EMPTY_TELEMETRY_LEDGER,
          signal: this.controller.signal
        }))
      if (!openedHandle || typeof openedHandle.send !== 'function' ||
          typeof openedHandle.interrupt !== 'function' ||
          typeof openedHandle.respond !== 'function' ||
          typeof openedHandle.read !== 'function' ||
          typeof openedHandle.dispose !== 'function') {
        throw new Error('Harness openThread 返回了无效 Handle')
      }
      this.controller.signal.throwIfAborted()
      this.handle = openedHandle
      trackOpeningState = false
      span.end({ threadId: this.options.threadId, harnessId: this.options.harnessId })
    } catch (error) {
      this.controller.abort(error)
      // Revoke publication authority before awaiting native cleanup. Already
      // queued observations still finish, but a late producer cannot race a
      // successful convergence and republish `running` afterwards.
      this.acceptingObservations = false
      trackOpeningState = false
      const cleanupFailures: unknown[] = []
      if (openedHandle && typeof openedHandle.dispose === 'function') {
        try {
          await openedHandle.dispose()
        } catch (failure) {
          cleanupFailures.push(failure)
        }
      }
      this.handle = undefined
      try {
        await this.observations.drain()
      } catch (failure) {
        cleanupFailures.push(failure)
      }
      const stateResults = await Promise.allSettled(openingStateOperations)
      for (const result of stateResults) {
        if (result.status === 'rejected') cleanupFailures.push(result.reason)
      }
      try {
        await this.observations.run(
          () => this.convergeInterruptedObservation()
        )
      } catch (failure) {
        cleanupFailures.push(failure)
      }
      this.refValid = false
      this.disposed = true
      this.unlinkParentSignal()
      if (cleanupFailures.length) {
        const cleanupError = cleanupFailures.length === 1
          ? cleanupFailures[0]
          : new AggregateError(
              cleanupFailures,
              'Harness Thread opening cleanup had multiple failures'
            )
        const finalError = new HarnessThreadOpeningCleanupError(error, cleanupError)
        span.fail(finalError, { cleanupFailure: true })
        throw finalError
      }
      span.fail(error, { threadId: this.options.threadId, harnessId: this.options.harnessId })
      throw error
    }
  }

  private commitSessionState(state: JsonValue): Promise<void> {
    let snapshot: JsonValue
    let next: ThreadPublicObservation
    try {
      // Capture before queueing: native code may reuse and mutate its working state.
      snapshot = cloneJsonValue(state, 'sessionState')
      next = parseThreadPublicObservation(this.options.sessionStateAdapter.project(snapshot))
    } catch (error) {
      return Promise.reject(error)
    }
    const requestedExecutionId = next.latestExecution?.executionId
    const context = this.contextForExecution(requestedExecutionId)
    const span = withDebugContext(context, () => startDebugSpan(
      'harness.observation',
      {
        threadId: this.options.threadId,
        harnessId: this.options.harnessId,
        executionId: requestedExecutionId
      }
    ))
    if (!this.acceptingObservations) {
      const error = new Error('Harness Thread Instance 已释放，停止接收 observation')
      span.fail(error)
      return Promise.reject(error)
    }
    const normalized = next
    const submission: PendingObservationSubmission = {
      observation: normalized,
      settled: false
    }
    this.latestObservationSubmission = submission
    withDebugContext(span.context, () => debugDetail('harness.observation.input', {
      threadId: this.options.threadId,
      harnessId: this.options.harnessId,
      observation: normalized
    }))
    const operation = this.observations.run(() => withDebugContext(
      this.contextForExecution(normalized.latestExecution?.executionId),
      () => this.commitStateTransaction(snapshot, normalized)
    ))
    void operation.then(
      () => {
        submission.settled = true
        span.end({
          threadId: this.options.threadId,
          harnessId: this.options.harnessId,
          executionId: normalized.latestExecution?.executionId,
          status: normalized.latestExecution?.status
        })
      },
      error => {
        submission.settled = true
        span.fail(error, {
          threadId: this.options.threadId,
          harnessId: this.options.harnessId,
          executionId: normalized.latestExecution?.executionId
        })
      }
    )
    if (normalized.latestExecution && isTerminalPublicExecution(normalized.latestExecution)) {
      this.trackTerminalObservation(operation)
    }
    return operation
  }

  private async commitStateTransaction(
    sessionState: JsonValue,
    next: ThreadPublicObservation
  ): Promise<void> {
    if (this.disposed) throw new Error('Harness Thread Instance 已释放')
    const previous = this.currentObservation.latestExecution
    const current = next.latestExecution
    const executionContext = current
      ? this.contextForExecution(current.executionId)
      : previous
        ? this.contextForExecution(previous.executionId)
        : ensureDebugContext({
            threadId: this.options.threadId,
            harnessId: this.options.harnessId
          })
    if (current?.status === 'running' &&
        this.interruptedExecutionIds.has(current.executionId) &&
        this.active?.executionId !== current.executionId &&
        this.pendingExecution?.executionId !== current.executionId) {
      throw new Error(`Interrupted Execution 不接受迟到 running: ${current.executionId}`)
    }
    validateExecutionTransition(
      previous,
      current,
      this.active,
      this.pendingExecution?.executionId ?? null
    )
    const executionChanged = !sameJsonValue(previous, current)
    const observationChanged = !sameJsonValue(this.currentObservation, next)
    const record = this.currentRecord()
    if (!observationChanged && sameJsonValue(record.observation, next) &&
        sameJsonValue(record.sessionState, sessionState)) return
    const startsExecution = current?.status === 'running' && (
      previous === null || previous.executionId !== current.executionId
    )
    const reservation = startsExecution ? this.pendingExecution : null
    if (reservation) reservation.state = 'consuming'
    let replacement: {
      readonly record: DeepReadonly<HarnessThreadRecord<Id, ThreadSettings>>
    }
    try {
      replacement = await this.replaceSessionState(sessionState, next, this.readNow())
    } catch (error) {
      if (reservation) {
        reservation.state = 'abandoned'
        if (this.pendingExecution === reservation) this.pendingExecution = null
      }
      throw error
    }
    this.currentObservation = replacement.record.observation
    if (current?.status === 'running') {
      this.active = Object.freeze({
        threadId: this.options.threadId,
        executionId: current.executionId,
        status: 'running' as const,
        startedAt: current.startedAt
      })
      const claim = this.claims.get(current.executionId)
      if (claim) claim.started = true
      if (reservation) {
        reservation.state = 'consumed'
        if (this.pendingExecution === reservation) this.pendingExecution = null
      }
    } else if (current && isTerminalPublicExecution(current)) {
      withDebugContext(executionContext, () => debugLog('harness.execution.terminal', {
        threadId: this.options.threadId,
        harnessId: this.options.harnessId,
        executionId: current.executionId,
        status: current.status,
        startedAt: current.startedAt,
        finishedAt: 'finishedAt' in current ? current.finishedAt : undefined,
        summary: current.summary
      }))
      const claim = this.claims.get(current.executionId)
      if (claim) {
        claim.terminal = true
        if (claim.sendSettled) this.claims.delete(current.executionId)
      }
      this.active = null
      this.nativeExecutionAdmissions.delete(current.executionId)
      if (this.pendingExecution?.executionId === current.executionId) {
        this.pendingExecution.state = 'consumed'
        this.pendingExecution = null
      }
    }
    this.options.committed({
      record: replacement.record,
      observation: this.currentObservation,
      observationChanged,
      executionChanged
    })
    if (current?.status === 'running') {
      await this.admitPendingSend(current.executionId)
    } else if (current && isTerminalPublicExecution(current)) {
      this.executionContexts.delete(current.executionId)
    }
  }

  private async convergeInterruptedObservation(executionId?: string): Promise<void> {
    const execution = this.currentObservation.latestExecution
    if (!execution || isTerminalPublicExecution(execution) ||
        (executionId !== undefined && execution.executionId !== executionId)) return
    await this.settleSessionExecution(execution.executionId, 'interrupted')
  }

  private async convergeFailedObservation(executionId: string): Promise<void> {
    const execution = this.currentObservation.latestExecution
    if (!execution || execution.executionId !== executionId ||
        isTerminalPublicExecution(execution)) return
    await this.settleSessionExecution(executionId, 'failed')
  }

  private async settleSessionExecution(
    executionId: string,
    outcome: 'failed' | 'interrupted'
  ): Promise<void> {
    const snapshot = cloneJsonValue(this.options.sessionStateAdapter.settle({
      sessionState: this.currentRecord().sessionState,
      executionId,
      outcome,
      finishedAt: this.readNow()
    }), 'settled sessionState')
    const observation = parseThreadPublicObservation(
      this.options.sessionStateAdapter.project(snapshot)
    )
    const execution = observation.latestExecution
    if (execution?.executionId !== executionId || execution.status !== outcome) {
      throw new Error(`Harness 未收敛 Session Execution: ${executionId}`)
    }
    await this.commitStateTransaction(snapshot, observation)
  }

  private async replaceSessionState(
    sessionState: JsonValue,
    observation: ThreadPublicObservation,
    admittedAt: number
  ): Promise<{ readonly record: DeepReadonly<HarnessThreadRecord<Id, ThreadSettings>> }> {
    let current = this.currentRecord()
    for (;;) {
      try {
        const next = await this.options.store.commit({
          type: 'replace-thread-session-state',
          threadId: current.id,
          expectedRevision: current.revision,
          sessionState,
          observation,
          updatedAt: Math.max(admittedAt, current.updatedAt)
        })
        return {
          record: asHarnessRecord<Id, ThreadSettings>(
            readHarnessThread(next, this.options.threadId),
            this.options.harnessId
          )
        }
      } catch (error) {
        const latest = this.currentRecord()
        if (latest.revision === current.revision) throw error
        current = latest
      }
    }
  }

  private async sendSerial(
    input: AgentInput,
    signal: AbortSignal,
    contextEntries: readonly {
      readonly id: string
      readonly content: string
    }[],
    onAdmitted: ThreadSendAdmitted | undefined,
    pending: PendingSendOperation,
    observationBarrier: Promise<void>
  ): Promise<ThreadSendResult> {
    pending.controller.signal.throwIfAborted()
    await observationBarrier
    pending.controller.signal.throwIfAborted()
    // Interrupt owns an exact call-time Execution. A send submitted after the
    // Stop request must not steer that Execution while native cancellation is
    // still in flight, and an older terminal barrier must not retarget Stop to
    // a later Execution (the terminal ABA race).
    while (this.pendingInterrupt || this.terminalObservation) {
      const barrier = this.pendingInterrupt?.operation ?? this.terminalObservation
      if (barrier) await barrier.catch(() => undefined)
      pending.controller.signal.throwIfAborted()
    }
    this.assertOperational()
    // Core archive authority is checked after every queue/barrier and before
    // creating a send claim. Existing native work keeps its lifecycle owner.
    const current = readHarnessThread(this.options.store.read(), this.options.threadId)
    if (isAgentThreadRecord(current) && current.archived) {
      throw new Error(`Agent Thread 已归档，取消归档后才能追加任务: ${current.id}`)
    }
    if (this.currentObservation.latestExecution?.status === 'waiting-for-user') {
      throw new Error('Thread 正在等待 interaction response')
    }
    let executionId: string
    let startedNewExecution = false
    let claim: ExecutionClaim | undefined
    if (this.active) {
      executionId = this.active.executionId
    } else if (this.pendingExecution) {
      throw new Error('Thread 已有 pending native Execution claim')
    } else {
      executionId = this.options.createExecutionId()
      assertExecutionId(executionId)
      if (this.usedExecutionIds.has(executionId)) {
        throw new Error(`Execution ID 重复: ${executionId}`)
      }
      this.usedExecutionIds.add(executionId)
      this.pendingExecution = {
        executionId,
        source: 'send',
        debugContext: pending.debugContext,
        state: 'pending'
      }
      startedNewExecution = true
      claim = { started: false, terminal: false, sendSettled: false }
      this.claims.set(executionId, claim)
    }
    pending.executionId = executionId
    pending.startedNewExecution = startedNewExecution

    const executionOwnerContext = this.executionContexts.get(executionId)
    const executionContext = startedNewExecution
      ? {
          ...pending.debugContext,
          threadId: this.options.threadId,
          harnessId: this.options.harnessId,
          executionId
        }
      : {
          ...pending.debugContext,
          threadId: this.options.threadId,
          harnessId: this.options.harnessId,
          executionId,
          ...(executionOwnerContext?.spanId
            ? { parentSpanId: executionOwnerContext.spanId }
            : {})
        };
    // The first send owns this execution context for its whole lifetime. A
    // follow-up gets a linked child context while leaving the owner untouched.
    if (startedNewExecution && !this.executionContexts.has(executionId)) {
      this.executionContexts.set(executionId, executionContext)
    }
    withDebugContext(executionContext, () => debugDetail('harness.provider.send.input', {
      threadId: this.options.threadId,
      harnessId: this.options.harnessId,
      executionId,
      startedNewExecution,
      input,
      contextEntries
    }))

    const pendingAdmission: PendingSendAdmission | undefined = startedNewExecution && onAdmitted
      ? { executionId, callback: onAdmitted, signal: pending.controller.signal }
      : undefined
    if (pendingAdmission) {
      if (this.pendingSendAdmission) throw new Error('Thread send admission 已有 pending owner')
      this.pendingSendAdmission = pendingAdmission
    }

    try {
      const operationSignal = AbortSignal.any([
        signal,
        this.controller.signal,
        pending.controller.signal
      ])
      operationSignal.throwIfAborted()
      pending.nativeStarted = true
      const providerSpan = withDebugContext(executionContext, () => startDebugSpan(
        'harness.provider.send',
        {
          threadId: this.options.threadId,
          harnessId: this.options.harnessId,
          executionId,
          startedNewExecution
        }
      ))
      try {
        await withDebugContext(executionContext, () => this.requiredHandle().send({
            executionId,
            input,
            ...(contextEntries.length ? { contextEntries } : {}),
            signal: operationSignal
          }))
        pending.settleHandle({ status: 'fulfilled' })
        providerSpan.end({ accepted: true })
      } catch (error) {
        pending.settleHandle({ status: 'rejected' })
        providerSpan.fail(error, { accepted: false })
        throw error
      }
      operationSignal.throwIfAborted()
      if (startedNewExecution && claim) {
        if (!claim.started) {
          throw new Error(`Harness 接受 send 但未发布 running observation: ${executionId}`)
        }
      }
      const result = { executionId, startedNewExecution }
      if (pendingAdmission) {
        if (!pendingAdmission.operation) {
          throw new Error(`Harness running observation 未完成 send admission: ${executionId}`)
        }
        await withDebugContext(executionContext, () => pendingAdmission.operation!)
      } else if (onAdmitted) {
        await withDebugContext(executionContext, () => onAdmitted(result))
      }
      operationSignal.throwIfAborted()
      if (claim) {
        claim.sendSettled = true
        if (claim.terminal) this.claims.delete(executionId)
      }
      return result
    } catch (error) {
      if (startedNewExecution && claim) {
        claim.sendSettled = true
        if (!claim.started) {
          this.claims.delete(executionId)
          this.releasePendingSendExecution(executionId)
        } else if (claim.terminal) {
          this.claims.delete(executionId)
        } else if (!pending.stopRequested) {
          try {
            await this.observations.run(() =>
              this.convergeFailedObservation(executionId)
            )
          } catch (convergenceError) {
            throw new AggregateError(
              [error, convergenceError],
              `Harness Execution ${executionId} send failure convergence failed`
            )
          }
        }
      }
      if (startedNewExecution && claim && !claim.started &&
          this.executionContexts.get(executionId) === executionContext) {
        this.executionContexts.delete(executionId)
      }
      throw error
    } finally {
      if (this.pendingSendAdmission === pendingAdmission) {
        this.pendingSendAdmission = undefined
      }
    }
  }

  private async interruptPendingSendExecution(
    executionId: string,
    handleSettlement: Promise<HandleSendSettlement>,
    observationBarrier: Promise<void>
  ): Promise<void> {
    // Handle.send settlement is the provider-neutral ownership handoff:
    // rejected means the Plugin cleaned up before native work became live;
    // fulfilled plus an exact terminal means Plugin cleanup is complete; and
    // fulfilled plus a nonterminal means native interrupt is now available.
    const settlement = await handleSettlement
    await observationBarrier
    await this.observations.drain()
    this.assertOperational()
    if (settlement.status === 'rejected') {
      await this.observations.run(() =>
        this.convergeInterruptedObservation(executionId)
      )
      return
    }
    await this.interruptFulfilledPendingSendExecution(executionId)
  }

  private async interruptFulfilledPendingSendExecution(
    executionId: string
  ): Promise<void> {
    await this.observations.drain()
    this.assertOperational()
    const current = this.currentObservation.latestExecution
    if (current?.executionId === executionId && isTerminalPublicExecution(current)) return
    if (current && current.executionId !== executionId &&
        !isTerminalPublicExecution(current)) return
    await this.interruptNativeOnce(executionId)
    this.interruptedExecutionIds.add(executionId)
    if (this.terminalObservation) await this.waitForTerminalObservation()
    await this.observations.drain()
    if (this.disposed || this.disposing) return
    await this.observations.run(() => this.convergeInterruptedObservation(executionId))
  }

  private async interruptExecution(
    executionId: string,
    observationBarrier: Promise<void>
  ): Promise<void> {
    await observationBarrier
    this.assertOperational()
    if (!this.ownsNonTerminalExecution(executionId)) return
    await this.interruptNativeOnce(executionId)
    this.interruptedExecutionIds.add(executionId)
    if (this.terminalObservation) await this.waitForTerminalObservation()
    await this.observations.drain()
    if (this.disposed || this.disposing) return
    await this.observations.run(() => this.convergeInterruptedObservation(executionId))
  }

  private async interruptNativeOnce(executionId: string): Promise<void> {
    if (this.nativeInterruptSucceededExecutionIds.has(executionId)) return
    await withDebugContext(
      this.contextForExecution(executionId),
      () => this.requiredHandle().interrupt()
    )
    this.nativeInterruptSucceededExecutionIds.add(executionId)
  }

  private ownsNonTerminalExecution(executionId: string): boolean {
    if (this.active?.executionId === executionId ||
        this.pendingExecution?.executionId === executionId) return true
    const execution = this.currentObservation.latestExecution
    return execution?.executionId === executionId &&
      !isTerminalPublicExecution(execution)
  }

  private claimNativeExecution(): HarnessExecutionClaim {
    this.assertOperational()
    if (this.forkReservation) {
      throw new Error('Thread fork 进行期间不能 claim Execution')
    }
    const current = this.currentObservation.latestExecution
    if (
      this.active ||
      this.pendingExecution ||
      (current !== null && !isTerminalPublicExecution(current))
    ) {
      throw new Error('Thread 已有 active 或 pending Execution')
    }
    const executionId = this.options.createExecutionId()
    assertExecutionId(executionId)
    if (this.usedExecutionIds.has(executionId)) {
      throw new Error(`Execution ID 重复: ${executionId}`)
    }
    this.usedExecutionIds.add(executionId)
    const debugContext = ensureDebugContext({
      threadId: this.options.threadId,
      harnessId: this.options.harnessId,
      executionId
    })
    this.executionContexts.set(executionId, debugContext)
    const reservation: ExecutionReservation = {
      executionId,
      source: 'native',
      debugContext,
      state: 'pending'
    }
    this.pendingExecution = reservation
    const admission: NativeExecutionAdmission = {
      reservation,
      admitted: false
    }
    this.nativeExecutionAdmissions.set(executionId, admission)
    return Object.freeze({
      executionId,
      abandon: () => {
        if (reservation.state !== 'pending') return
        reservation.state = 'abandoned'
        if (this.pendingExecution === reservation) this.pendingExecution = null
        if (this.nativeExecutionAdmissions.get(executionId) === admission) {
          this.nativeExecutionAdmissions.delete(executionId)
        }
        if (this.executionContexts.get(executionId) === debugContext) {
          this.executionContexts.delete(executionId)
        }
      }
    })
  }

  private admitNativeExecution(executionId: string): Promise<void> {
    const context = this.contextForExecution(executionId)
    try {
      this.assertOperational()
      assertExecutionId(executionId)
      const admission = this.nativeExecutionAdmissions.get(executionId)
      if (!admission) {
        throw new Error(`Thread native Execution claim 不存在或已失效: ${executionId}`)
      }
      if (admission.admitted) return Promise.resolve()
      if (admission.operation) return admission.operation
      const operation = withDebugContext(context, () =>
        this.performNativeExecutionAdmission(executionId, admission)
      )
      admission.operation = operation
      void operation.then(
        () => undefined,
        () => {
          // A transient workspace/durability failure must not consume the
          // exact claim. The Plugin may retry while the same running Execution
          // remains authoritative.
          if (!admission.admitted && admission.operation === operation) {
            admission.operation = undefined
          }
        }
      )
      return operation
    } catch (error) {
      return Promise.reject(error)
    }
  }

  private async performNativeExecutionAdmission(
    executionId: string,
    admission: NativeExecutionAdmission
  ): Promise<void> {
    const span = withDebugContext(
      this.contextForExecution(executionId),
      () => startDebugSpan('harness.execution.admission', {
        threadId: this.options.threadId,
        harnessId: this.options.harnessId,
        executionId,
        phase: 'wait-before-execution'
      })
    )
    try {
    await this.observations.drain()
    this.assertOperational()
    this.assertNativeExecutionReadyForAdmission(executionId, admission)
    const signal = this.controller.signal
    signal.throwIfAborted()
    await withDebugContext(this.contextForExecution(executionId), () =>
      this.options.admitNativeExecution?.(signal)
    )
    signal.throwIfAborted()
    // Each queued commit contains state and its projection. Do not start
    // native work until their combined snapshot is on disk.
    await this.options.store.flushThread(this.options.threadId)
    signal.throwIfAborted()
    this.assertNativeExecutionReadyForAdmission(executionId, admission)
    admission.admitted = true
    span.end({ admitted: true })
    } catch (error) {
      debugError('harness.execution.admission.failed', error, {
        threadId: this.options.threadId,
        harnessId: this.options.harnessId,
        executionId,
        phase: 'wait-before-execution'
      })
      span.fail(error, { admitted: false })
      throw error
    }
  }

  private assertNativeExecutionReadyForAdmission(
    executionId: string,
    admission: NativeExecutionAdmission
  ): void {
    if (this.nativeExecutionAdmissions.get(executionId) !== admission ||
        admission.reservation.state !== 'consumed') {
      throw new Error(`Thread native Execution 尚未发布 running: ${executionId}`)
    }
    const current = this.currentObservation.latestExecution
    if (!this.active || this.active.executionId !== executionId || !current ||
        current.executionId !== executionId || isTerminalPublicExecution(current)) {
      throw new Error(`Thread native Execution 已失去 running authority: ${executionId}`)
    }
  }

  private releasePendingSendExecution(executionId: string): void {
    const reservation = this.pendingExecution
    if (
      !reservation ||
      reservation.source !== 'send' ||
      reservation.executionId !== executionId
    ) return
    reservation.state = 'abandoned'
    this.pendingExecution = null
  }

  private admitPendingSend(executionId: string): Promise<void> {
    const pending = this.pendingSendAdmission
    if (!pending || pending.executionId !== executionId) return Promise.resolve()
    pending.operation ??= Promise.resolve().then(async () => {
      pending.signal.throwIfAborted()
      await withDebugContext(this.contextForExecution(executionId), () => pending.callback({
          executionId,
          startedNewExecution: true
        }))
      pending.signal.throwIfAborted()
    })
    return pending.operation
  }

  private trackTerminalObservation(operation: Promise<void>): void {
    const barrier = operation.then(() => undefined, () => undefined)
    this.terminalObservation = barrier
    void barrier.then(() => {
      if (this.terminalObservation === barrier) this.terminalObservation = undefined
    })
  }

  private async waitForTerminalObservation(): Promise<void> {
    while (this.terminalObservation) await this.terminalObservation
  }

  private contextForExecution(executionId?: string | null): DebugContext {
    if (executionId) {
      const owner = this.executionContexts.get(executionId)
      if (owner) return owner
    }
    const context = ensureDebugContext({
      threadId: this.options.threadId,
      harnessId: this.options.harnessId,
      ...(executionId ? { executionId } : {})
    })
    if (executionId) this.executionContexts.set(executionId, context)
    return context
  }

  private currentRecord(): DeepReadonly<HarnessThreadRecord<Id, ThreadSettings>> {
    return asHarnessRecord<Id, ThreadSettings>(
      readHarnessThread(this.options.store.read(), this.options.threadId),
      this.options.harnessId
    )
  }

  private readNow(): number {
    const value = this.options.now()
    if (!Number.isFinite(value) || value < 0) throw new Error('now() 必须返回非负有限数')
    return value
  }

  private assertOperational(): void {
    if (this.disposed || this.disposing) throw new Error('Harness Thread Instance 已关闭')
  }

  private requiredHandle(): HarnessThreadHandle {
    if (!this.handle) throw new Error('Harness Thread Handle 尚未打开')
    return this.handle
  }
}

const EMPTY_TELEMETRY_LEDGER: BartTelemetryLedgerCapability = Object.freeze({
  record: async () => undefined,
  read: () => ({ windows: [] })
})

async function runRuntimeDebugSpan<Result>(
  event: string,
  fields: Record<string, unknown>,
  operation: () => Promise<Result>
): Promise<Result> {
  const context = ensureDebugContext({
    ...(typeof fields.threadId === 'string' ? { threadId: fields.threadId } : {}),
    ...(typeof fields.harnessId === 'string'
      ? { harnessId: fields.harnessId as HarnessId }
      : {}),
    ...(typeof fields.executionId === 'string' ? { executionId: fields.executionId } : {})
  })
  const span = withDebugContext(context, () => startDebugSpan(event, fields))
  try {
    const result = await withDebugContext(span.context, operation)
    span.end()
    return result
  } catch (error) {
    debugError(`${event}.failed`, error, fields)
    span.fail(error, fields)
    throw error
  }
}

function ensureDebugContext(fields: Partial<DebugContext>): DebugContext {
  const current = getDebugContext()
  return current.traceId
    ? { ...current, ...fields }
    : createDebugTrace(fields)
}


function normalizeRespondRequest(value: HarnessRespondRequest): HarnessRespondRequest {
  return parseHarnessRespondRequest(value)
}

function validateRespondAnswers(
  interaction: PublicInteraction,
  answers: HarnessRespondRequest['answers']
): void {
  const supplied = answers ?? {}
  const questions = new Map(
    interaction.questions.map(question => [question.id, question] as const)
  )
  for (const [questionId, answer] of Object.entries(supplied)) {
    const question = questions.get(questionId)
    if (!question) {
      throw new Error(`Agent interaction answer 对应未知 question：${questionId}`)
    }
    const values = typeof answer === 'string' ? [answer] : answer
    if (question.multiple !== Array.isArray(answer)) {
      throw new Error(
        `Agent interaction answer 类型不匹配 question：${questionId}`
      )
    }
    if (values.some(value => !value.trim())) {
      throw new Error(`Agent interaction answer 不能为空：${questionId}`)
    }
    if (!question.allowOther && question.options.length > 0) {
      const allowed = new Set(question.options.map(option => option.value))
      if (values.some(value => !allowed.has(value))) {
        throw new Error(
          `Agent interaction answer 不在 question options 中：${questionId}`
        )
      }
    }
  }
}

/** Canonical public multi-select ordering before any Plugin-native encoding. */
function normalizeMultipleQuestionAnswers(
  interaction: PublicInteraction,
  response: HarnessRespondRequest
): HarnessRespondRequest {
  if (response.answers === undefined) return response
  const multipleQuestionIds = new Set(
    interaction.questions
      .filter(question => question.multiple)
      .map(question => question.id)
  )
  let changed = false
  const answers = Object.fromEntries(
    Object.entries(response.answers).map(([id, answer]) => {
      if (!multipleQuestionIds.has(id) || !Array.isArray(answer)) return [id, answer]
      const normalized = [...new Set(answer)]
      if (normalized.length !== answer.length) changed = true
      return [id, normalized]
    })
  )
  return changed ? { ...response, answers } : response
}

function isTerminalPublicExecution(
  execution: PublicExecution
): boolean {
  return execution.status === 'completed' || execution.status === 'failed' ||
    execution.status === 'interrupted'
}

function validateExecutionTransition(
  previous: PublicExecution | null,
  current: PublicExecution | null,
  active: DeepReadonly<ActiveThreadExecution> | null,
  pendingExecutionId: string | null
): void {
  if (current === null) {
    if (previous !== null || active) {
      throw new Error('Thread public observation 不能清除已有 Execution')
    }
    return
  }
  if (previous === null || previous.executionId !== current.executionId) {
    if (previous !== null && !isTerminalPublicExecution(previous)) {
      throw new Error('Thread 不能在 active Execution 上切换 executionId')
    }
    if (
      current.status !== 'running' ||
      active ||
      pendingExecutionId !== current.executionId
    ) {
      throw new Error(`新 Execution running 状态无效: ${current.executionId}`)
    }
    return
  }
  if (previous.startedAt !== current.startedAt) {
    throw new Error(`Execution startedAt 不能变更: ${current.executionId}`)
  }
  if (previous.status === 'completed' || previous.status === 'failed' ||
      previous.status === 'interrupted') {
    if (JSON.stringify(previous) !== JSON.stringify(current)) {
      throw new Error('已终结 Execution 不能再次变更状态')
    }
    return
  }
  if (!active || active.executionId !== current.executionId) {
    throw new Error(`Execution ${current.status} 不匹配当前 active: ${current.executionId}`)
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function cloneJsonValue(value: unknown, label: string): JsonValue {
  let cloned: unknown
  try {
    cloned = structuredClone(value)
  } catch (error) {
    throw new Error(`${label} 无法复制`, { cause: error })
  }
  if (!isJsonValue(cloned)) throw new Error(`${label} 必须是 JSON`)
  return cloned
}


function asHarnessRecord<Id extends HarnessId, ThreadSettings>(
  record: HarnessThreadRecord,
  harnessId: Id
): DeepReadonly<HarnessThreadRecord<Id, ThreadSettings>> {
  if (record.harnessId !== harnessId) {
    throw new Error(
      `Harness Thread 不匹配: expected ${harnessId}, actual ${record.harnessId}`
    )
  }
  return record as DeepReadonly<HarnessThreadRecord<Id, ThreadSettings>>
}

function assertExecutionId(value: unknown, label = 'Execution ID'): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`${label} 不符合当前格式`)
  }
}

function linkAbortSignal(parent: AbortSignal, controller: AbortController): () => void {
  const abort = () => controller.abort(parent.reason)
  if (parent.aborted) {
    abort()
    return () => undefined
  }
  parent.addEventListener('abort', abort, { once: true })
  return () => parent.removeEventListener('abort', abort)
}
