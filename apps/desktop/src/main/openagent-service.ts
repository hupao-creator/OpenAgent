import { RendererStatePublisher } from './services/renderer-state-publisher'
import { mergeKnownDirectories } from './services/known-directories'
import type { KnownDirectory } from '../shared/known-directory'
import { AutoInterventionService } from './use-cases/auto-intervention-service'
import { publicThreadEnvelope } from './use-cases/thread-observation'
import { errorMessage } from './services/error-message'
import { normalizeThreadResponse, type ThreadResponseCommand } from './use-cases/thread-response'
import { ThreadLifecycleService } from './use-cases/thread-lifecycle-service'
import { ThreadMetadataService } from './use-cases/thread-metadata-service'
import { ensureDebugContext, runServiceDebugSpan } from './services/service-debug'
import { sameJson, isRevisionConflict } from './services/state-comparison'
import { ScheduledDispatcher } from './use-cases/scheduled-dispatcher'
import { ReportService, assertCompletedReportExecution } from './use-cases/report-service'
import { SerialQueue } from './services/serial-queue'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import {
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep
} from 'node:path'
import type { AgentInput, AgentInputPart, ReadThreadRequest } from '@openagent/contracts'
import type { BartSubmitRequest, ThreadInputRequest } from '../shared/desktop-api'
import { isJsonValue, type JsonObject, type JsonValue } from '@openagent/contracts'
import {
  DEFAULT_THREAD_EMOJI,
  type AgentThreadRecord,
  type BartMessage,
  type BartThreadRecord,
  type BartContextEntryId,
  type DeepReadonly,
  type HarnessPromptCompleteRequest,
  type HarnessPromptCompleteResult,
  type HarnessToolBinding,
  type PublicExecution
} from '@openagent/contracts'
import {
  HARNESS_IDS,
  harnessDescriptors,
  canHostBart,
  isHarnessId,
  type HarnessId
} from '../shared/harnesses'
import {
  parseOpenAgentSettings,
  createDefaultOpenAgentSettings,
  type HarnessSettingsPresentationRequest,
  type HarnessSettingsPresentationResult,
  type HarnessInstallationMap,
  type HarnessInstallationResult,
  type OpenAgentSettings,
  type OpenAgentUiStateUpdate,
  type UpdateThreadSettingsRequest
} from '../shared/openagent-settings'
import {
  createOpenAgentState,
  threadSettingsSourceFingerprint,
  isAgentThreadRecord,
  readAgentThread,
  readBartThread,
  type OpenAgentState,
  type OpenAgentStateMutation
} from '../shared/openagent-state'
import {
  reportThreadSummary,
  type ReportThreadRecord
} from '../shared/report-thread'
import type {
  RendererAppState,
  RendererStateMutation
} from '../shared/renderer-state-contracts'
import type { WorktreeOptions } from '@openagent/contracts'
import type { HarnessExtensionRequest } from '@openagent/contracts'
import type {
  ForkThreadRequest,
  ForkThreadResult
} from '../shared/thread-actions'
import {
  sameThreadTag,
  threadDirectoryTag,
  threadWorkspaceCwd
} from '@openagent/contracts'
import {
  BART_TOOL_INPUT_MAX_CHARACTERS,
  ThreadSettingsRefreshUnavailableError,
  createBartToolBindings,
  collectBartContextEntries,
  createRecordedHarnessToolBinding,
  describeThreadCreation,
  parseThreadCreationRequest,
  type ThreadCreationRequest,
  type BartContextEntryComposition,
  type CollectedBartContextEntry,
  type ThreadSettingsDescriptionComposition,
  type ThreadCreationDescription,
  type BartTranscriptMutation
} from './bart-v1'
import type {
  HarnessAvailability,
  HarnessThreadInstanceView,
  MainHarnessComposition,
  ResolvedHarnessTarget
} from './harness-composition'
import {
  createDebugTrace,
  debugDetail,
  debugError,
  debugLog,
  getDebugContext,
  startDebugSpan,
  withDebugContext
} from '@openagent/plugin-kit/main'
import {
  HarnessThreadOpeningCleanupError,
  type HarnessThreadCommitted,
  type ThreadSendResult
} from './harness-thread-runtime'
import { placeholderThreadTitle } from './internal-runs'
import {
  ScheduledDispatchStore,
  scheduledDispatchSummary,
  type ScheduledDispatch,
  type ScheduledDispatchRequest
} from './scheduled-dispatch'
import { AttachmentRepository } from './services/attachment-repository'
import { ThreadStateStore } from './services/thread-state-store'
import {
  WorktreeManager,
  type ManagedWorktreeValidation,
  type WorktreePreparation
} from './services/worktree-manager'

type DebugContext = ReturnType<typeof createDebugTrace>

const MAX_INPUT_TEXT = BART_TOOL_INPUT_MAX_CHARACTERS
const BART_RUN_CONTEXT_REFRESH_MS = 5 * 60 * 1_000
const BART_PENDING_TELEMETRY_CONTEXT: CollectedBartContextEntry =
  Object.freeze({
    id: 'telemetry',
    content: [
      'Live Harness capacity is still being refreshed.',
      'Treat usage limits and reset windows as unknown; never infer that missing telemetry means unlimited capacity.'
    ].join(' ')
  })
const BART_SYSTEM_PROMPT =
  'Delegate work to independent Agent Threads and coordinate them with the supplied OpenAgent tools.'
const DEFAULT_BART_ROUTING_GUIDANCE = [
  'Choose a Target Harness and its model from the currently advertised capabilities.',
  'Prefer the least costly option that can reliably complete the task, and use stronger reasoning only when complexity warrants it.',
  'Never invent a Harness, model, or option that is absent from the supplied Thread settings schema.'
].join(' ')

export interface OpenAgentServicePaths {
  readonly defaultCwd: string
  readonly bartCwd: string
  readonly temporaryWorkspaceRoot: string
}

type ResolvedTarget = ResolvedHarnessTarget

interface CreatedThread {
  readonly record: AgentThreadRecord
  readonly execution: ThreadSendResult
}

interface CreateThreadAndDispatchInput {
  readonly input: AgentInput
  readonly cwd?: string
  readonly worktree?: WorktreeOptions
  readonly resolved: ResolvedTarget
  readonly signal: AbortSignal
  readonly bartGeneration?: boolean
  readonly ownedTemporaryWorkspace?: boolean
}

interface OpenedBartThread {
  readonly instance: HarnessThreadInstanceView
  readonly threadCreation: ThreadCreationDescription
}

interface BartExecutionScope {
  readonly threadId: string
  readonly controller: AbortController
  readonly debugContext: DebugContext
}

interface BartUserAdmission {
  readonly controller: AbortController
  readonly debugContext: DebugContext
  message?: Omit<BartMessage, 'createdAt'>
  pending: boolean
  enteredRuntime: boolean
}

interface BartRunContextSnapshot {
  readonly settings: OpenAgentSettings
  readonly cwd: string
  readonly entries: readonly CollectedBartContextEntry[]
  readonly refreshedAt: number
}

interface BartRunContextRefresh {
  readonly settings: OpenAgentSettings
  readonly cwd: string
  readonly promise: Promise<void>
}

interface ThreadSettingsPresentationWorkspace {
  readonly cwd: string
  readonly managed?: ManagedWorktreeValidation
}

interface AgentSendClaim {
  readonly controller: AbortController
  readonly debugContext: DebugContext
  enteredRuntime: boolean
}

interface AgentSendCancellation {
  readonly claimed: boolean
  readonly enteredRuntime: boolean
}

class AgentOpeningCleanupError extends Error {
  constructor(readonly cleanupError: unknown) {
    super('Agent Thread stale opening cleanup failed', { cause: cleanupError })
    this.name = 'AgentOpeningCleanupError'
  }
}

class BartOpeningCleanupError extends Error {
  constructor(readonly cleanupError: unknown) {
    super('Bart Thread stale opening cleanup failed', { cause: cleanupError })
    this.name = 'BartOpeningCleanupError'
  }
}

/** Current-only OpenAgent use-case layer for Harness Plugin v1. */
export class OpenAgentService {
  private readonly serviceController = new AbortController()
  private bartInstance: HarnessThreadInstanceView | undefined
  private bartInstanceThreadId: string | undefined
  private readonly agentInstances = new Map<string, HarnessThreadInstanceView>()
  private readonly agentOpenings = new Map<string, Promise<HarnessThreadInstanceView>>()
  private readonly publisher: RendererStatePublisher
  private readonly bartCommands = new SerialQueue()
  private readonly reports: ReportService
  private readonly metadata: ThreadMetadataService
  private readonly autoIntervention: AutoInterventionService
  private readonly terminalEvents = new SerialQueue()
  private readonly agentCommands = new Map<string, SerialQueue>()
  private readonly agentInterruptRuns = new Map<string, Set<Promise<void>>>()
  private readonly forkingAgentThreads = new Set<string>()
  private readonly agentSendClaims = new Map<string, Set<AgentSendClaim>>()
  private readonly activeBartToolExecutions = new Set<Promise<void>>()
  private readonly activeCompositionOperations = new Set<Promise<void>>()
  private readonly activeBartRunContextRefreshes = new Set<Promise<void>>()
  private readonly activeBartRunContextContributors = new Set<Promise<void>>()
  private readonly bartExecutionScopes = new Map<string, BartExecutionScope>()
  private readonly bartUserAdmissions = new Set<BartUserAdmission>()
  private readonly threadLifecycle: ThreadLifecycleService<AgentSendCancellation>
  private pendingBartUserAdmissions = 0
  private agentOwnershipController = new AbortController()
  private agentOwnershipGeneration = 0
  private initialized = false
  private initializationPromise: Promise<void> | undefined
  private clearingHistory = false
  private shuttingDown = false
  private shutdownPromise: Promise<void> | undefined
  private lastBoundaryTimestamp = 0
  private bartUseCaseController = new AbortController()
  private bartThreadController: AbortController | undefined
  private bartOpening: Promise<HarnessThreadInstanceView> | undefined
  private startupRecovery: Promise<void> | undefined
  private startupBartRecoveryEpoch = 0
  private bartRunContextController = new AbortController()
  private bartRunContextGeneration = 0
  private bartRunContextSnapshot: BartRunContextSnapshot | undefined
  private bartRunContextRefresh: BartRunContextRefresh | undefined
  private bartRunContextRefreshTimer: NodeJS.Timeout | undefined
  /** Exact dynamic product generation adopted by the installed Bart Handle. */
  private bartThreadCreation: ThreadCreationDescription | undefined
  private readonly schedules: ScheduledDispatcher

  constructor(
    private readonly store: ThreadStateStore,
    private readonly main: MainHarnessComposition,
    private readonly worktrees: WorktreeManager,
    private readonly attachments: AttachmentRepository,
    scheduledDispatchStore: ScheduledDispatchStore,
    private readonly paths: OpenAgentServicePaths
  ) {
    this.publisher = new RendererStatePublisher({
      read: () => this.store.read(),
      execution: () => this.bartInstance?.execution ?? undefined,
      defaultCwd: this.paths.defaultCwd
    }, error => this.reportFailure('state-listener', error))
    this.threadLifecycle = new ThreadLifecycleService({
      read: threadId => readAgentThread(this.store.read(), threadId),
      delete: async threadId => {
        await this.commit({ type: 'delete-agent-thread', threadId })
        await this.attachments.releaseOwner(threadId)
          .catch(error => this.reportFailure('attachment-owner-delete', error))
      }
    }, {
      run: (threadId, operation) => this.runAgentCommand(threadId, operation),
      open: threadId => this.agentInstance(threadId),
      peek: threadId => this.agentInstances.get(threadId),
      forget: (threadId, instance) => {
        if (this.agentInstances.get(threadId) === instance) this.agentInstances.delete(threadId)
      },
      cancelPending: (threadId, reason) => this.cancelAgentSendClaims(threadId, reason),
      interrupt: (threadId, signal, cancellation, expectedExecutionId, allowDeleting) =>
        this.runAgentInterrupt(threadId, signal, cancellation, expectedExecutionId, allowDeleting),
      admit: (threadId, harnessId, signal) =>
        this.admitCurrentThreadExecution(threadId, harnessId, signal),
      forgetIntervention: threadId => this.autoIntervention.forgetThread(threadId),
      releaseWorkspace: async thread => {
        if (thread.worktree?.native === false && thread.worktree.cwd) {
          await this.worktrees.unregisterOwnedWorktree({
            ownerThreadId: thread.id,
            worktree: thread.worktree
          }).catch(error => this.reportFailure('managed-worktree-delete', error))
        }
      }
    })
    this.autoIntervention = new AutoInterventionService({
      operational: () => !this.shuttingDown && !this.clearingHistory,
      enabled: () => this.store.read().settings.bart.autoIntervention,
      pendingAdmissions: () => this.pendingBartUserAdmissions,
      hasThread: threadId => this.store.read().threads.some(
        thread => thread.id === threadId && isAgentThreadRecord(thread)),
      readThread: threadId => readAgentThread(this.store.read(), threadId),
      readBart: () => readBartThread(this.store.read())
    }, {
      openExecution: async threadId => (await this.agentInstance(threadId)).execution,
      execution: threadId => this.agentInstances.get(threadId)?.execution,
      activeThreadIds: () => [...this.agentInstances]
        .filter(([, instance]) => instance.execution)
        .map(([id]) => id),
      withThread: (threadId, operation) => this.runAgentCommand(threadId, async () =>
        operation(await this.agentInstance(threadId)))
    }, {
      run: operation => this.bartCommands.run(operation),
      append: message => this.appendBartLocalSystemMessage(message)
    },
    async (harnessId, request) => {
      // Automatic decisions are standalone prompts, not Bart Handle turns.
      // Their settings are read fresh by completePrompt, including automatic
      // Host fallback when a saved provider/model change removes availability.
      const { settings, bartAppliedSettings: applied } = this.store.read()
      const preference = settings.bart.hostHarnessPreference
      const changedHostSettings = !applied ||
        !sameJson(applied.harnesses[harnessId], settings.harnesses[harnessId])
      const resolveHost = preference === 'auto' ? changedHostSettings : preference !== harnessId
      const host = resolveHost
        ? await this.resolveBartHost(settings, request.signal, harnessId)
        : harnessId
      request.signal.throwIfAborted()
      return this.completePrompt(host, request)
    },
    error => this.reportFailure('auto-intervention', error))
    this.metadata = new ThreadMetadataService({
      readThread: threadId => readAgentThread(this.store.read(), threadId),
      readAgentThreads: () => this.agentRecords(),
      readTagPool: () => this.store.read().tagPool,
      commit: async mutation => { await this.commit(mutation) }
    },
    (harnessId, request, sourceThread) => this.completePrompt(harnessId, request, sourceThread),
    (...floors) => this.boundaryTimestamp(...floors),
    error => this.reportFailure('metadata', error))
    this.schedules = new ScheduledDispatcher(scheduledDispatchStore, {
      dispatch: async request => {
        await this.createThreadAndDispatch({
          input: request.input,
          cwd: request.cwd,
          worktree: request.worktree,
          resolved: {
            harnessId: request.harnessId,
            threadSettings: request.threadSettings,
            acknowledgement: request.targetAcknowledgement
          },
          signal: AbortSignal.any([this.serviceController.signal, this.agentOwnershipController.signal])
        })
      },
      reportDispatchFailure: (id, error) => this.appendBartLocalSystemMessage(
        `Scheduled dispatch ${id} failed: ${errorMessage(error)}`
      ),
      reportPersistenceFailure: error => this.reportFailure('scheduled-dispatch', error)
    }, () => this.wallClockTimestamp())
    this.reports = new ReportService({
      readReports: () => this.store.read().reports,
      archiveReport: async (reportId, relatedThreadIds) => {
        await this.commit({ type: 'archive-report', reportId, relatedThreadIds })
      },
      resolveExecution: (threadId, executionId) => {
        const thread = readAgentThread(this.store.read(), threadId)
        return this.main[thread.harnessId].resolveExecution(thread.sessionState, executionId)
      },
      readThreadTags: threadId => {
        const thread = readAgentThread(this.store.read(), threadId)
        return [threadDirectoryTag(thread), ...thread.tags]
      },
      replaceReports: async (reports, event, relatedExecutionChecks) => {
        await this.commit({ type: 'replace-reports', reports, relatedExecutionChecks },
          event ? { type: 'bart-generation', target: { kind: 'report', id: event.reportId } } : undefined,
          state => {
            for (const reference of relatedExecutionChecks ?? []) {
              const thread = readAgentThread(state, reference.threadId)
              assertCompletedReportExecution(reference,
                this.main[thread.harnessId].resolveExecution(thread.sessionState, reference.executionId))
            }
          })
      }
    }, {
      timestamp: (...floors) => this.boundaryTimestamp(...floors),
      createId: () => this.createId()
    })
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    this.initializationPromise ??= this.initializeOnce()
    return this.initializationPromise
  }

  private async initializeOnce(): Promise<void> {
    const span = withDebugContext(
      ensureDebugContext({}),
      () => startDebugSpan('service.initialize', {})
    )
    try {
      await withDebugContext(span.context, () => this.initializeOnceImpl())
      span.end({ initialized: true })
    } catch (error) {
      debugError('service.initialize.failed', error)
      span.fail(error)
      throw error
    }
  }

  private async initializeOnceImpl(): Promise<void> {
    this.serviceController.signal.throwIfAborted()
    const persisted = await this.store.load()
    this.serviceController.signal.throwIfAborted()
    if (persisted) {
      const normalized = this.normalizeSettings(persisted.settings)
      const applied = persisted.bartAppliedSettings === undefined
        ? undefined
        : this.normalizeSettings(persisted.bartAppliedSettings)
      if (!sameJson(normalized, persisted.settings) ||
          !sameJson(applied, persisted.bartAppliedSettings)) {
        await this.store.save({ ...persisted, settings: normalized,
          ...(applied ? { bartAppliedSettings: applied } : {}) })
      }
      const current = readBartThread(this.store.read())
      // Pending saved preferences belong to execution admission, even after
      // restart. Otherwise retain the existing startup Host selection policy.
      const hostHarnessId = applied && !sameBartRuntimeSettings(applied, normalized) &&
        canHostBart(this.main[current.harnessId].threadCapabilities)
        ? current.harnessId as HarnessId
        : await this.resolveBartHost(normalized, this.serviceController.signal, current.harnessId)
      if (hostHarnessId !== current.harnessId) {
        const threadSettings = await this.main[hostHarnessId]
          .resolveThreadSettings({
            settings: normalized,
            cwd: this.paths.bartCwd,
            signal: this.serviceController.signal
          })
        await this.store.commit({
          type: 'replace-bart-thread',
          expectedThreadId: current.id,
          threadId: this.createId(),
          hostHarnessId,
          settings: normalized,
          threadSettings,
          cwd: this.paths.bartCwd,
          createdAt: this.boundaryTimestamp(current.updatedAt)
        })
      }
    } else {
      const settings = this.normalizeSettings(createDefaultOpenAgentSettings())
      const createdAt = this.boundaryTimestamp()
      const bartThreadId = this.createId()
      const hostHarnessId = await this.resolveBartHost(
        settings,
        this.serviceController.signal
      )
      const bartThreadSettings = await this.main[hostHarnessId]
        .resolveThreadSettings({
          settings,
          cwd: this.paths.bartCwd,
          signal: this.serviceController.signal
        })
      await this.store.save(createOpenAgentState({
        bartThreadId,
        hostHarnessId,
        bartThreadSettings,
        bartCwd: this.paths.bartCwd,
        createdAt,
        selectedThreadId: bartThreadId,
        settings
      }))
    }
    await this.rehydrateManagedWorktreeOwners()
    await this.repairInvalidSelectedThread()
    const startupBart = readBartThread(this.store.read())
    if (hasStaleBartRuntime(startupBart)) {
      await this.store.commit({
        type: 'settle-stale-bart-runtime',
        threadId: startupBart.id,
        updatedAt: this.boundaryTimestamp(startupBart.updatedAt)
      })
    }
    try {
      await this.attachments.retainOwners(this.store.read().threads.map(thread => thread.id))
      await this.attachments.collectOrphans()
    } catch (error) {
      // Unknown ownership disables attachment maintenance, not unrelated work.
      // The repository keeps its fail-closed checks for attachment operations.
      this.reportFailure('attachment-gc', error)
    }
    this.seedBoundaryTimestamp(this.store.read())
    await this.metadata.settlePending()
    await this.schedules.initialize(this.serviceController.signal, () => {
      this.publisher.initialize()
      this.initialized = true
    })
    this.serviceController.signal.throwIfAborted()
    // Native Thread recovery may perform catalog discovery and wait for the
    // Plugin context collection. It owns no part of Core initialization:
    // state/IPC becomes usable first, while the first real operation joins the
    // same tracked opening and still fails closed if bootstrap cannot finish.
    this.startStartupRecovery()
    this.startBartRunContextLifecycle()
  }

  loadRendererState(): RendererAppState {
    this.assertInitialized()
    return this.publisher.snapshot()
  }

  onStateMutation(
    listener: (mutation: RendererStateMutation) => void
  ): () => void {
    return this.publisher.subscribe(listener)
  }

  async submitBartMessage(request: BartSubmitRequest): Promise<void> {
    const span = withDebugContext(
      ensureDebugContext({}),
      () => startDebugSpan('bart.submit', {
        directoryTag: request.directoryTag
      })
    )
    try {
      return await withDebugContext(span.context, async () => {
        this.assertOperational()
        assertAgentInput(request.input)
        debugDetail('bart.submit.input', {
          input: request.input,
          directoryTag: request.directoryTag
        })
        const workspaceHint = resolveBartWorkspaceHint(
          this.store.read(),
          request.directoryTag
        )
        // Claim authority before entering the shared Bart queue. An older auto
        // decision may already be queued behind another operation and must observe
        // this newer user input before it is allowed to respond.
        const admission = this.beginBartUserAdmission()
        try {
          const input = await this.attachments.canonicalizeInput(request.input)
          admission.message = bartUserMessage(input, this.createId())
          await this.bartCommands.run(() => withDebugContext(
            admission.debugContext,
            () => this.sendBartInput(input, false, admission, workspaceHint)
          ))
        } finally {
          this.finishBartUserAdmission(admission)
        }
        span.end({ outcome: 'accepted' })
      })
    } catch (error) {
      debugError('bart.submit.failed', error)
      span.fail(error)
      throw error
    }
  }

  async cancelBartTask(): Promise<void> {
    this.assertOperational()
    const snapshot = readBartThread(this.store.read()).observation.latestExecution
    const expectedExecutionId = snapshot && !isTerminalPublicExecution(snapshot)
      ? snapshot.executionId
      : null
    let claimed = false
    let enteredRuntime = false
    const reason = new Error('Bart task interrupted before native admission')
    for (const admission of this.bartUserAdmissions) {
      claimed = true
      enteredRuntime ||= admission.enteredRuntime
      if (!admission.enteredRuntime && !admission.controller.signal.aborted) {
        admission.controller.abort(reason)
      }
    }
    if (claimed && !enteredRuntime && expectedExecutionId === null) return
    if (this.bartOpening && !this.bartInstance) await this.bartOpening
    const instance = this.bartInstance
    if (!instance) throw new Error('Bart 当前没有 active Execution')
    try {
      await instance.interrupt(expectedExecutionId)
    } catch (error) {
      const latest = instance.observation.latestExecution
      if (claimed && (!latest || isTerminalPublicExecution(latest))) return
      throw error
    }
  }

  async clearBartSession(): Promise<void> {
    this.assertOperational()
    this.assertBartIdleForClear()
    await this.bartCommands.run(() => {
      this.assertBartIdleForClear()
      return this.replaceBartThread(this.store.read().settings)
    })
  }

  async clearAllHistory(): Promise<void> {
    this.assertOperational()
    const backgroundOwner = this.store.read().threads.find(
      thread => thread.observation.backgroundWork !== null
    )
    if (backgroundOwner) {
      throw new Error(
        `Thread 仍有后台任务，无法清空全部历史: ${backgroundOwner.id}`
      )
    }
    this.clearingHistory = true
    this.publisher.cancelPending()
    this.schedules.pause()
    this.stopBartRunContextLifecycle(new Error('OpenAgent history cleared'))
    const pendingBartOpening = this.bartOpening
    // Revoke installation authority synchronously. An opener that ignores its
    // abort signal may only return a Handle for immediate disposal.
    this.bartOpening = undefined
    this.startupBartRecoveryEpoch += 1
    // Invalidate openings before waiting for any command queue.
    this.agentOwnershipGeneration += 1
    const ownershipLoss = new Error('OpenAgent history cleared')
    this.agentOwnershipController.abort(ownershipLoss)
    this.cancelAllAgentSendClaims(ownershipLoss)
    this.bartUseCaseController.abort(new Error('OpenAgent history cleared'))
    this.metadata.cancel(new Error('OpenAgent history cleared'))
    this.autoIntervention.cancel(new Error('OpenAgent history cleared'))
    this.bartThreadController?.abort(new Error('OpenAgent history cleared'))
    this.bartThreadController = undefined
    this.abortBartExecutionScopes(new Error('OpenAgent history cleared'))
    try {
      await this.joinRevokedBartOpening(pendingBartOpening)
      await this.disposeOwnedAgentInstances()
      await this.drainStartupRecovery()
      await this.drainBartRunContextOperations()
      await this.drainAgentInterrupts()
      await this.schedules.drainCallbacks()
      await this.drainActiveBartToolExecutions()
      await this.drainAgentCommands()
      await this.bartCommands.run(() =>
        this.reports.withHistoryReset(() => this.metadata.withHistoryReset(async () => {
        await this.bartInstance?.dispose()
        this.bartInstance = undefined
        this.bartInstanceThreadId = undefined
        this.bartThreadCreation = undefined
        const settings = this.store.read().settings
        const applied = this.store.read().bartAppliedSettings
        const currentBart = readBartThread(this.store.read())
        const bartThreadId = this.createId()
        // Clearing history preserves configuration and must work even when the
        // provider is unavailable. Keep the required Bart record empty; its
        // live instance opens lazily, with the provider's runtime checks intact.
        // Validate the retained Host against its applied configuration, then
        // take only the empty history. Saved preferences may still be pending.
        const { threads, reports, tagPool, selectedThreadId } = createOpenAgentState({
          bartThreadId,
          hostHarnessId: currentBart.harnessId as HarnessId,
          bartThreadSettings: jsonValue(currentBart.settings),
          bartCwd: this.paths.bartCwd,
          createdAt: this.boundaryTimestamp(),
          selectedThreadId: bartThreadId,
          settings: applied ?? { ...settings, bart: { ...settings.bart, hostHarnessPreference: 'auto' } }
        })
        await this.store.save({
          threads, reports, tagPool, selectedThreadId,
          settings, bartAppliedSettings: applied
        })
        await this.attachments.retainOwners([bartThreadId])
          .catch(error => this.reportFailure('attachment-owner-clear', error))
        await this.worktrees.clearOwnedWorktrees().catch(error =>
          this.reportFailure('managed-worktree-clear', error)
        )
        this.autoIntervention.clearHistory()
        this.publisher.publish()
        }))
      )
      // Existing terminal deliveries re-check state after entering the Bart
      // queue, so they drain without reopening a replaced Thread.
      await this.terminalEvents.drain()
      await this.bartCommands.drain()
      await this.drainBackgroundRuns()
    } finally {
      this.metadata.resetAfterClear()
      this.autoIntervention.resetAfterClear()
      this.agentCommands.clear()
      this.agentInterruptRuns.clear()
      this.forkingAgentThreads.clear()
      this.agentSendClaims.clear()
      this.agentOwnershipController = new AbortController()
      this.bartUseCaseController = new AbortController()
      this.clearingHistory = false
      this.metadata.resumePending()
      this.schedules.resume()
      this.startBartRunContextLifecycle()
    }
  }

  async followUpThread(request: ThreadInputRequest): Promise<void> {
    const span = withDebugContext(
      ensureDebugContext({ threadId: request.threadId }),
      () => startDebugSpan('agent.follow-up', { threadId: request.threadId })
    )
    try {
      return await withDebugContext(span.context, async () => {
        this.assertOperational()
        assertIdentifier(request.threadId, 'threadId')
        assertAgentInput(request.input)
        debugDetail('agent.follow-up.input', {
          threadId: request.threadId,
          input: request.input
        })
        const claim = this.beginAgentSendClaim(request.threadId)
        try {
          const input = await this.attachments.canonicalizeInput(request.input)
          await this.runAgentCommand(request.threadId, () =>
            this.sendAgentThreadUnlocked(
              request.threadId,
              input,
              this.serviceController.signal,
              claim
            )
          )
          // An accepted steer is new user intent even when it reuses the active
          // public Execution. Refresh tags (and a still-pending title) for both
          // new turns and active follow-ups.
          this.metadata.request(request.threadId, input)
        } finally {
          this.finishAgentSendClaim(request.threadId, claim)
        }
        span.end({ outcome: 'accepted' })
      })
    } catch (error) {
      debugError('agent.follow-up.failed', error, { threadId: request.threadId })
      span.fail(error, { threadId: request.threadId })
      throw error
    }
  }

  async interruptThread(threadId: string): Promise<void> {
    this.assertOperational()
    if (readBartThread(this.store.read()).id === threadId) {
      await this.cancelBartTask()
      return
    }
    await this.threadLifecycle.interrupt(threadId, this.agentLifecycleSignal())
  }

  async deleteThread(threadId: string): Promise<void> {
    this.assertOperational()
    assertIdentifier(threadId, 'threadId')
    await this.threadLifecycle.delete(threadId, this.agentLifecycleSignal())
  }

  async respondToThreadInteraction(request: ThreadResponseCommand): Promise<void> {
    this.assertOperational()
    const { response } = normalizeThreadResponse(request)
    if (readBartThread(this.store.read()).id === request.threadId) {
      await this.bartCommands.run(async () => {
        const instance = await this.ensureBartThread()
        await instance.respond(response)
      })
      return
    }
    await this.threadLifecycle.respond(request.threadId, response, this.agentLifecycleSignal())
  }

  async readThread(request: ReadThreadRequest): Promise<string> {
    this.assertOperational()
    // A Bart Thread is not a Thread Read target: read objects are ordinary Agent
    // Threads. The Bart Handle carries the app-level mutation tools and
    // `thread_read` itself, so forwarding here would become a
    // self-reading recursion when a read inherits the source toolset.
    // This is the only entry that could hand such a Handle to read.
    const bart = readBartThread(this.store.read())
    if (bart.id === request.threadId) {
      throw new Error(
        `Bart Thread 不是 Thread Read 的对象: ${request.threadId}（read 只接受普通 Agent Thread）`
      )
    }
    return this.threadLifecycle.read(
      request.threadId, requiredText(request.question, 'question'), this.agentLifecycleSignal()
    )
  }

  private agentLifecycleSignal(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([
      this.serviceController.signal,
      this.agentOwnershipController.signal,
      ...(signal ? [signal] : [])
    ])
  }

  async updateThreadSettings(request: UpdateThreadSettingsRequest): Promise<void> {
    this.assertOperational()
    await this.runAgentCommand(request.threadId, async () => {
      const signal = AbortSignal.any([
        this.serviceController.signal,
        this.agentOwnershipController.signal
      ])
      if (this.agentInstances.get(request.threadId)?.execution) {
        throw new Error('Agent Thread active Execution 期间不能更新 settings')
      }
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const current = readAgentThread(this.store.read(), request.threadId)
        if (current.harnessId !== request.harnessId) {
          throw new Error(`Thread Harness 不匹配: ${current.harnessId}`)
        }
        // Settings/catalog work is discovery-only. It must prove the managed
        // workspace before and after the Plugin call, but must not mint or
        // advance an Execution write admission.
        const workspace = await this.validateAgentThreadWorkspace(current, signal)
        signal.throwIfAborted()
        const hasContent = this.main[request.harnessId].hasThreadContent(current.sessionState)
        const resolvedSettings = await this.applyThreadSettingsUpdate(
          request,
          current,
          signal
        )
        signal.throwIfAborted()
        const source = readAgentThread(this.store.read(), request.threadId)
        if (threadSettingsSourceFingerprint(source) !== threadSettingsSourceFingerprint(current) ||
            this.main[request.harnessId].hasThreadContent(source.sessionState) !== hasContent) {
          // Only actual resolver inputs invalidate discovery. Observations and
          // metadata updates do not change configuration or content-presence facts.
          continue
        }
        await this.validateAgentThreadWorkspace(source, signal, workspace)
        signal.throwIfAborted()
        // Every Thread send enters the same command queue, so this check also
        // covers the otherwise invisible pending-send claim.
        if (this.agentInstances.get(request.threadId)?.execution) {
          throw new Error('Agent Thread active Execution 期间不能更新 settings')
        }
        try {
          await this.commit({
            type: 'update-agent-thread-settings',
            threadId: source.id,
            expectedSource: threadSettingsSourceFingerprint(source),
            settings: resolvedSettings,
            updatedAt: this.boundaryTimestamp(source.updatedAt)
          }, undefined, state => {
            // Recheck the Plugin's fact after this command acquires its Thread
            // scope. Streaming can advance while the settings commit is queued.
            const latest = readAgentThread(state, source.id)
            if (this.main[request.harnessId].hasThreadContent(latest.sessionState) !== hasContent) {
              throw new Error(`Thread settings source conflict: ${source.id}`)
            }
          })
          return
        } catch (error) {
          if (attempt === 15 || !(error instanceof Error) ||
              !error.message.startsWith('Thread settings source conflict:')) throw error
        }
      }
      throw new Error(`Thread settings update source 持续变化: ${request.threadId}`)
    })
  }

  async updateAppSettings(settings: OpenAgentSettings): Promise<void> {
    this.assertOperational()
    const normalized = this.normalizeSettings(settings)
    const preference = normalized.bart.hostHarnessPreference
    if (preference !== 'auto' && !canHostBart(this.main[preference].threadCapabilities)) {
      throw new Error(`${harnessDescriptors[preference].displayName} 不支持 Bart Host`)
    }
    await this.bartCommands.run(async () => {
      const previous = this.store.read().settings
      // Saving is a durable configuration boundary, never runtime admission.
      // bartAppliedSettings remains unchanged until the next relevant send.
      await this.commit({ type: 'replace-settings', settings: normalized })
      if (sameJson(previous.bart, normalized.bart) &&
          sameJson(previous.harnesses, normalized.harnesses)) return
      if (previous.bart.autoIntervention && !normalized.bart.autoIntervention) {
        this.autoIntervention.cancel(new Error('Bart auto intervention disabled'))
      }
      if (!previous.bart.autoIntervention && normalized.bart.autoIntervention) {
        this.autoIntervention.renewAuthority()
        this.autoIntervention.invalidateDecisions()
        this.autoIntervention.requestActive()
      }
    })
  }

  async loadHarnessSettingsPresentation(
    request: HarnessSettingsPresentationRequest
  ): Promise<HarnessSettingsPresentationResult> {
    this.assertOperational()
    const settings = this.store.read().settings
    if (request.scope === 'global') {
      const signal = this.serviceController.signal
      const cwd = await this.validateRuntimeCwd()
      signal.throwIfAborted()
      const value = await this.trackCompositionOperation(() =>
        this.main[request.harnessId].loadSettingsPresentation(
          settings,
          cwd,
          signal,
          undefined,
          request.refresh
        )
      )
      signal.throwIfAborted()
      const currentSettings = this.store.read().settings
      // Match the plugin input and Renderer cache identity: unrelated global
      // settings must not invalidate this Harness's in-flight catalog load.
      if (!sameJson(
        currentSettings.harnesses[request.harnessId],
        settings.harnesses[request.harnessId]
      )) {
        throw new Error('Global settings presentation 期间 settings 已变化')
      }
      const currentCwd = await this.validateRuntimeCwd()
      signal.throwIfAborted()
      if (currentCwd !== cwd) {
        throw new Error('Global settings defaultCwd identity 已变化')
      }
      return {
        scope: 'global',
        harnessId: request.harnessId,
        value
      }
    }

    const source = readAgentThread(this.store.read(), request.threadId)
    const signal = AbortSignal.any([
      this.serviceController.signal,
      this.agentOwnershipController.signal
    ])
    const workspace = await this.validateThreadSettingsPresentationWorkspace(
      source,
      signal
    )
    this.assertThreadSettingsPresentationSourceCurrent(source)
    const value = await this.trackCompositionOperation(() =>
      this.main[source.harnessId].loadSettingsPresentation(
        settings,
        workspace.cwd,
        signal,
        {
          settings: jsonValue(source.settings)
        },
        request.refresh
      )
    )
    signal.throwIfAborted()
    const current = readAgentThread(this.store.read(), source.id)
    this.assertThreadSettingsPresentationSourceCurrent(source)
    await this.validateThreadSettingsPresentationWorkspace(current, signal, workspace)
    this.assertThreadSettingsPresentationSourceCurrent(source)
    return {
      scope: 'thread',
      threadId: source.id,
      harnessId: source.harnessId,
      value
    }
  }

  private readonly harnessInstalls = new Map<string, Promise<void>>()

  installHarness(harnessId: string): Promise<void> {
    this.assertOperational()
    if (!isHarnessId(harnessId)) throw new Error('未知 Harness ID')
    const pending = this.harnessInstalls.get(harnessId)
    if (pending) return pending
    const operation = this.trackCompositionOperation(async () => {
      const signal = this.serviceController.signal
      const cwd = await this.validateRuntimeCwd()
      const current = await this.main[harnessId].detectInstallation(cwd, signal)
      if (current.status === 'installed') return
      await this.main[harnessId].install(signal)
      const installed = await this.main[harnessId].detectInstallation(cwd, signal)
      if (installed.status !== 'installed') {
        throw new Error('安装程序已结束，但尚未找到 Agent。请检查安装路径后重试。')
      }
    }).finally(() => this.harnessInstalls.delete(harnessId))
    this.harnessInstalls.set(harnessId, operation)
    return operation
  }

  private knownWorkspaceCache?: { expires: number; promise: Promise<readonly string[]> }

  async listKnownDirectories(): Promise<readonly KnownDirectory[]> {
    this.assertOperational()
    const signal = this.serviceController.signal
    if (!this.knownWorkspaceCache || this.knownWorkspaceCache.expires < Date.now()) {
      const promise = this.trackCompositionOperation(async () => {
        const results = await Promise.allSettled(Object.values(this.main).map(binding =>
          binding.discoverWorkspaceDirectories(signal)))
        signal.throwIfAborted()
        return results.flatMap(result => result.status === 'fulfilled' ? [...result.value] : [])
      })
      this.knownWorkspaceCache = { expires: Date.now() + 30_000, promise }
    }
    const native = await this.knownWorkspaceCache.promise
    const threads = this.store.read().threads.filter(isAgentThreadRecord)
    return mergeKnownDirectories([...native, ...threads.map(thread => thread.worktree?.baseCwd || thread.cwd)], [
      this.paths.temporaryWorkspaceRoot, this.paths.bartCwd, ...this.worktrees.managedWorkspaceRoots(),
      ...threads.flatMap(thread => thread.worktree?.cwd ? [thread.worktree.cwd] : [])
    ])
  }

  async detectHarnessInstallations(): Promise<HarnessInstallationMap> {
    this.assertOperational()
    const signal = this.serviceController.signal
    // Installation detection is a presence probe from the Main-owned runtime
    // cwd. It never depends on a user-selected workspace.
    const cwd = await this.validateRuntimeCwd()
    signal.throwIfAborted()
    const results = await Promise.all(
      HARNESS_IDS.map(async (harnessId): Promise<readonly [HarnessId, HarnessInstallationResult]> => {
        try {
          if (this.harnessInstalls.has(harnessId)) return [harnessId, { status: 'installing' }]
          const installation = await this.trackCompositionOperation(() =>
            this.main[harnessId].detectInstallation(cwd, signal)
          )
          signal.throwIfAborted()
          return [harnessId, installation]
        } catch (error) {
          signal.throwIfAborted()
          return [harnessId, { status: 'error', message: errorMessage(error) }]
        }
      })
    )
    return Object.fromEntries(results) as HarnessInstallationMap
  }

  async invokeHarnessExtension(request: HarnessExtensionRequest): Promise<JsonValue> {
    this.assertOperational()
    return this.trackCompositionOperation(() =>
      this.main[request.harnessId].invokeExtension(
        request.method,
        structuredClone(request.payload),
        this.serviceController.signal
      )
    )
  }

  forkThread(request: ForkThreadRequest): Promise<ForkThreadResult> {
    return this.forkAgentThread(request, this.agentLifecycleSignal())
  }

  private async forkAgentThread(
    request: ForkThreadRequest,
    signal: AbortSignal
  ): Promise<ForkThreadResult> {
    this.assertOperational()
    signal.throwIfAborted()
    assertIdentifier(request.threadId, 'threadId')
    const forkRequest = jsonValue(request.request)
    const initial = readAgentThread(this.store.read(), request.threadId)
    this.assertThreadForkable(initial)
    if (this.forkingAgentThreads.has(request.threadId)) {
      throw new Error('Thread fork 已在进行')
    }
    // Claim before entering any asynchronous queue. This closes the inverse
    // race where an action could start and finish between the fork's two
    // source-state checks without changing the Core record revision.
    this.forkingAgentThreads.add(request.threadId)
    try {
      return await this.runAgentCommand(request.threadId, async () => {
        signal.throwIfAborted()
        const reservation = await this.reserveAgentFork(request.threadId, signal)
        try {
          const source = readAgentThread(this.store.read(), request.threadId)
          this.assertThreadForkable(source)
          const workspaceValidation = await this.validateForkSourceWorkspace(source, signal)
          signal.throwIfAborted()
          const derived = await this.trackCompositionOperation(() =>
            this.main[source.harnessId].forkThread(source, forkRequest, signal)
          )
          signal.throwIfAborted()

          // Plugin callbacks and worktree inspection are asynchronous. Refuse a
          // stale derivation instead of interpreting or merging Plugin data.
          const current = readAgentThread(this.store.read(), source.id)
          if (current.revision !== source.revision ||
              current.harnessId !== source.harnessId) {
            throw new Error(`源 Thread 在 fork 期间发生变化: ${source.id}`)
          }
          this.assertThreadForkable(current)
          // The Plugin derivation is asynchronous. Revalidate filesystem identity
          // at the commit boundary so it cannot reopen the worktree/path race.
          await this.validateForkSourceWorkspace(current, signal, workspaceValidation)
          signal.throwIfAborted()
          // Deletion/send claims are synchronous admissions outside the state
          // writer. Recheck after the final await, immediately before queuing
          // the revision-CAS lifecycle commit.
          this.assertThreadForkable(current)

          const threadId = this.createId()
          const at = this.boundaryTimestamp(current.updatedAt)
          // Persist inherited references before exposing a forked native history.
          await this.attachments.inheritOwners(current.id, threadId)
          try {
            signal.throwIfAborted()
            this.assertThreadForkable(current)
            await this.commit({
              type: 'add-and-select-agent-thread',
              sourceThreadId: current.id,
              expectedSourceRevision: current.revision,
              thread: {
                id: threadId,
                harnessId: current.harnessId,
                revision: 0,
                archived: false,
                sessionState: derived.sessionState,
                observation: derived.observation,
                title: derived.title ?? current.title,
                emoji: current.emoji ?? DEFAULT_THREAD_EMOJI,
                tags: [...current.tags],
                // A Core-managed worktree is never shared across Thread identities.
                // Fork starts from the same user/base cwd with no copied grant.
                cwd: current.cwd,
                settings: Object.hasOwn(derived, 'settings')
                  ? derived.settings!
                  : jsonValue(current.settings),
                createdAt: at,
                updatedAt: at
              }
            })
          } catch (error) {
            if (!this.store.read().threads.some(thread => thread.id === threadId)) {
              await this.attachments.releaseOwner(threadId)
                .catch(cleanupError => this.reportFailure('attachment-owner-fork-rollback', cleanupError))
            }
            throw error
          }
          return { threadId }
        } finally {
          reservation.release()
        }
      })
    } finally {
      this.forkingAgentThreads.delete(request.threadId)
    }
  }

  async updateUiState(update: OpenAgentUiStateUpdate): Promise<void> {
    this.assertOperational()
    if (!Object.hasOwn(update, 'selectedThreadId')) return
    let selectedThreadId = update.selectedThreadId ?? null
    if (selectedThreadId !== null &&
        readBartThread(this.store.read()).id !== selectedThreadId) {
      try {
        const source = readAgentThread(this.store.read(), selectedThreadId)
        await this.validateAgentThreadWorkspace(
          source,
          this.agentOwnershipController.signal
        )
        this.agentOwnershipController.signal.throwIfAborted()
        this.assertThreadWorkspaceSourceCurrent(source)
      } catch (error) {
        this.agentOwnershipController.signal.throwIfAborted()
        this.reportFailure('selected-thread-workspace', error)
        selectedThreadId = null
      }
    }
    await this.commit({
      type: 'select-thread',
      threadId: selectedThreadId
    })
  }

  readReport(reportId: string): ReportThreadRecord {
    this.assertInitialized()
    return this.reports.read(reportId)
  }

  async setThreadArchived(threadId: string, archived: boolean): Promise<void> {
    await this.initialize()
    this.assertOperational()
    await this.commit({ type: 'set-agent-thread-archived', threadId, archived })
  }

  async setReportArchived(reportId: string, archived: boolean): Promise<void> {
    this.assertOperational()
    await this.reports.setArchived(reportId, archived, this.serviceController.signal)
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shuttingDown = true
    this.publisher.close()
    this.shutdownPromise = this.performShutdown()
    return this.shutdownPromise
  }

  private async performShutdown(): Promise<void> {
    const errors: unknown[] = []
    const capture = async (
      stage: string,
      operation: () => void | Promise<void>
    ): Promise<void> => {
      debugLog('service.shutdown-stage', { stage, state: 'started' })
      try {
        await operation()
        debugLog('service.shutdown-stage', { stage, state: 'completed' })
      } catch (error) {
        debugLog('service.shutdown-stage', {
          stage,
          state: 'failed',
          message: error instanceof Error ? error.message : String(error)
        })
        if (error instanceof AggregateError) errors.push(...error.errors)
        else errors.push(error)
      }
    }
    debugLog('service.shutdown', { state: 'started' })
    this.schedules.close()
    this.stopBartRunContextLifecycle(
      new Error('OpenAgent Service shutting down')
    )
    const pendingBartOpening = this.bartOpening
    // Synchronously revoke installation authority before any abort can settle
    // the opening continuation. A late Handle may only clean itself up.
    this.bartOpening = undefined
    this.startupBartRecoveryEpoch += 1
    this.serviceController.abort(new Error('OpenAgent Service shutting down'))
    this.agentOwnershipGeneration += 1
    const ownershipLoss = new Error('OpenAgent Service shutting down')
    this.agentOwnershipController.abort(ownershipLoss)
    this.cancelAllAgentSendClaims(ownershipLoss)
    this.bartUseCaseController.abort(new Error('OpenAgent Service shutting down'))
    this.metadata.close(new Error('OpenAgent Service shutting down'))
    this.autoIntervention.close(new Error('OpenAgent Service shutting down'))
    this.bartThreadController?.abort(new Error('OpenAgent Service shutting down'))
    this.abortBartExecutionScopes(new Error('OpenAgent Service shutting down'))
    await capture('initialization-join', async () => {
      try {
        await this.initializationPromise
      } catch (error) {
        // Shutdown itself revoked the initialization authority. Its rejection
        // is the expected join result, not an additional disposal failure.
        if (!this.serviceController.signal.aborted) throw error
      }
    })
    await capture('bart-opening-join', async () => {
      await this.joinRevokedBartOpening(pendingBartOpening)
    })
    await capture('agent-instances-dispose', () => this.disposeOwnedAgentInstances())
    await capture('startup-recovery-drain', () => this.drainStartupRecovery())
    await capture('bart-run-context-drain', () => this.drainBartRunContextOperations())
    await capture('agent-interrupts-drain', () => this.drainAgentInterrupts())
    await capture('bart-tools-drain', () => this.drainActiveBartToolExecutions())
    await capture('agent-commands-drain', () => this.drainAgentCommands())
    await capture('scheduled-callbacks-drain', () => this.schedules.drainCallbacks())
    await capture('schedule-commands-drain', () => this.schedules.drainCommands())
    await capture('report-commands-drain', () => this.reports.drain())
    await capture('terminal-events-initial-drain', () => this.terminalEvents.drain())
    await capture('bart-commands-drain', () => this.bartCommands.drain())
    await capture('bart-instance-dispose', async () => {
      try {
        await this.bartInstance?.dispose()
      } finally {
        this.bartInstance = undefined
        this.bartInstanceThreadId = undefined
        this.bartThreadCreation = undefined
      }
    })
    await capture('terminal-events-final-drain', () => this.terminalEvents.drain())
    await capture('background-runs-drain', () => this.drainBackgroundRuns())
    await capture('metadata-commits-drain', () => this.metadata.drainCommits())
    await capture('composition-operations-drain', () => this.drainCompositionOperations())
    await capture('harness-composition-dispose', async () => {
      const results = await Promise.allSettled(
        HARNESS_IDS.map((harnessId) => this.main[harnessId].dispose())
      )
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length) {
        throw new AggregateError(failures, 'Harness Plugin shutdown failed')
      }
    })
    // Durability is attempted only after every known mutation producer has
    // settled, and is never skipped because an earlier disposer/drain failed.
    await capture('thread-state-flush', () => this.store.close())
    this.agentInstances.clear()
    this.agentOpenings.clear()
    this.agentCommands.clear()
    this.agentInterruptRuns.clear()
    this.forkingAgentThreads.clear()
    this.agentSendClaims.clear()
    debugLog('service.shutdown', {
      state: errors.length ? 'failed' : 'completed',
      errorCount: errors.length
    })
    if (errors.length) {
      throw new AggregateError(errors, 'OpenAgent Service shutdown failed')
    }
  }

  private async sendBartInput(
    input: AgentInput,
    systemEvent: boolean,
    admission?: BartUserAdmission,
    workspaceHint?: BartWorkspaceHint
  ): Promise<void> {
    const span = withDebugContext(
      admission?.debugContext ?? ensureDebugContext({}),
      () => startDebugSpan('bart.send', {
        systemEvent,
        threadId: this.bartInstanceThreadId
      })
    )
    try {
      return await withDebugContext(span.context, () => this.sendBartInputImpl(
        input,
        systemEvent,
        admission,
        workspaceHint
      )).then(() => {
        span.end({ systemEvent, threadId: this.bartInstanceThreadId })
      })
    } catch (error) {
      debugError('bart.send.failed', error, {
        systemEvent,
        threadId: this.bartInstanceThreadId
      })
      span.fail(error, { systemEvent })
      throw error
    }
  }

  private async sendBartInputImpl(
    input: AgentInput,
    systemEvent: boolean,
    admission?: BartUserAdmission,
    workspaceHint?: BartWorkspaceHint
  ): Promise<void> {
    try {
      const sendSignal = admission
        ? AbortSignal.any([this.serviceController.signal, admission.controller.signal])
        : this.serviceController.signal
      // Settings probes belong to this admission, including its cancellation.
      await this.applySavedBartSettings(sendSignal)
      const instance = admission
        ? await waitForAbortable(
            this.ensureBartThreadForUserAdmission(sendSignal),
            sendSignal
          )
        : await this.ensureBartThread()
      const collectedContextEntries = this.readBartRunContextEntries(
        this.appliedBartSettings()
      )
      const contextEntries = withBartWorkspaceHint(
        collectedContextEntries,
        workspaceHint
      )
      sendSignal.throwIfAborted()
      if (admission) admission.enteredRuntime = true
      let effectiveInput = systemEvent
        ? { ...input, presentation: 'internal' as const }
        : input
      debugDetail('bart.send.input', {
        systemEvent,
        input: effectiveInput,
        contextEntries,
        workspaceHint
      })
      const bartThreadId = readBartThread(this.store.read()).id
      effectiveInput = await this.attachments.retainInput(bartThreadId, effectiveInput)
      sendSignal.throwIfAborted()
      await instance.send(
        effectiveInput,
        sendSignal,
        contextEntries,
        async () => {
          try {
            if (admission) {
              const record = readBartThread(this.store.read())
              if (!admission.message) {
                throw new Error('Bart user admission 缺少已验证消息')
              }
              await this.appendBartMessage({
                ...admission.message,
                createdAt: this.boundaryTimestamp(record.updatedAt)
              })
            }
            // System/terminal events can also begin a fresh Bart Execution.
            // The Plugin cannot continue native start until its private input
            // and public running observation are in the current durable file.
            await this.store.flushThread(bartThreadId)
          } finally {
            if (admission) this.finishBartUserAdmission(admission)
          }
        }
      )
    } finally {
      // Reject/open/waiting failures occur before the runtime admission hook.
      // They release the gate without recording an attempted user message.
      if (admission) this.finishBartUserAdmission(admission)
    }
  }

  private beginBartUserAdmission(): BartUserAdmission {
    this.pendingBartUserAdmissions += 1
    const admission: BartUserAdmission = {
      pending: true,
      enteredRuntime: false,
      controller: new AbortController(),
      debugContext: ensureDebugContext({})
    }
    this.bartUserAdmissions.add(admission)
    withDebugContext(admission.debugContext, () => debugLog('bart.admission.queued', {
      pendingCount: this.pendingBartUserAdmissions
    }))
    return admission
  }

  private finishBartUserAdmission(admission: BartUserAdmission): void {
    if (!admission.pending) return
    admission.pending = false
    this.bartUserAdmissions.delete(admission)
    this.pendingBartUserAdmissions -= 1
    withDebugContext(admission.debugContext, () => debugLog('bart.admission.released', {
      enteredRuntime: admission.enteredRuntime,
      pendingCount: this.pendingBartUserAdmissions
    }))
    if (this.pendingBartUserAdmissions === 0) {
      // A decision invalidated while admission was pending must be rebuilt
      // even when native admission rejects and the durable transcript stays
      // unchanged; otherwise its previously consumed fingerprint suppresses
      // the retry forever.
      this.autoIntervention.invalidateDecisions()
      this.autoIntervention.requestActive()
    }
  }

  private async ensureBartThreadForUserAdmission(
    admissionSignal: AbortSignal
  ): Promise<HarnessThreadInstanceView> {
    const signal = AbortSignal.any([
      admissionSignal,
      this.bartUseCaseController.signal,
      this.serviceController.signal
    ])
    signal.throwIfAborted()
    if (!this.bartInstance && this.bartOpening) {
      // Startup recovery owns this opening. Join it before preparing the
      // admission generation, so cold bootstrap is single-flight. We still
      // describe again below: a generation published while opening was in
      // flight must be adopted (and safely reopen) before the user send.
      await waitForAbortable(this.bartOpening, signal)
      signal.throwIfAborted()
    }
    const beforeRefresh = readBartThread(this.store.read())
    const currentExecution = beforeRefresh.observation.latestExecution
    if (currentExecution && !isTerminalPublicExecution(currentExecution)) {
      // Steering belongs to the already-admitted native execution and must
      // keep the tools/catalog generation captured by that execution.
      return waitForAbortable(this.ensureBartThread(), signal)
    }

    let nextThreadCreation: ThreadCreationDescription
    try {
      nextThreadCreation = await this.describeTargets(signal)
    } catch (error) {
      signal.throwIfAborted()
      const currentInstance = this.bartInstance
      const current = readBartThread(this.store.read())
      if (
        error instanceof ThreadSettingsRefreshUnavailableError &&
        currentInstance &&
        this.bartThreadCreation &&
        this.bartInstanceThreadId === beforeRefresh.id &&
        current.id === beforeRefresh.id
      ) {
        // A warm Handle already owns a complete Thread creation schema.
        // A transient refresh failure must not turn that LKG into invalid tool schemas or
        // block an otherwise valid user turn. Cold start still fails closed.
        this.reportFailure('bart-settings-refresh', error)
        return currentInstance
      }
      throw error
    }
    signal.throwIfAborted()
    if (!this.bartInstance && !this.bartOpening) {
      return waitForAbortable(this.ensureBartThread(nextThreadCreation), signal)
    }

    const instance = await waitForAbortable(this.ensureBartThread(), signal)
    signal.throwIfAborted()
    const current = readBartThread(this.store.read())
    if (current.id !== beforeRefresh.id) {
      throw new Error(`Bart Thread 已替换: ${beforeRefresh.id}`)
    }
    const latestExecution = current.observation.latestExecution
    if (instance.execution || (latestExecution && !isTerminalPublicExecution(latestExecution))) {
      // A provider-neutral background wake may have admitted while prepare was
      // in flight. Never replace a Handle that now owns a live execution.
      return instance
    }
    if (this.bartThreadCreation && sameJson(this.bartThreadCreation, nextThreadCreation)) {
      return instance
    }
    if (current.observation.backgroundWork !== null) {
      // Background work still belongs to this Handle. Continue the user turn
      // with its current schema and leave bartThreadCreation unchanged
      // so the next safe admission retries adoption of the new generation.
      return instance
    }

    const previousController = this.bartThreadController
    if (this.bartInstance === instance) {
      this.bartInstance = undefined
      this.bartInstanceThreadId = undefined
      this.bartThreadCreation = undefined
    }
    this.bartThreadController = undefined
    previousController?.abort(new Error('Bart Thread creation schema changed'))
    await this.drainActiveBartToolExecutions()
    await instance.dispose()
    signal.throwIfAborted()
    return waitForAbortable(this.ensureBartThread(nextThreadCreation), signal)
  }

  private ensureBartThread(
    preparedThreadCreation?: ThreadCreationDescription
  ): Promise<HarnessThreadInstanceView> {
    const record = readBartThread(this.store.read())
    return runServiceDebugSpan(
      'bart.thread.ensure',
      {
        threadId: record.id,
        harnessId: record.harnessId,
        preparedThreadCreation: preparedThreadCreation !== undefined
      },
      async () => {
        if (this.bartInstance && this.bartInstanceThreadId === record.id) {
          return this.bartInstance
        }
        if (this.bartOpening) return this.bartOpening
        const opening = this.openBartThread(record, preparedThreadCreation).then(async opened => {
          const instance = opened.instance
          const current = readBartThread(this.store.read())
          if (
            this.shuttingDown ||
            this.serviceController.signal.aborted ||
            current.id !== record.id ||
            this.bartOpening !== opening
          ) {
            try {
              await instance.dispose()
            } catch (error) {
              throw new BartOpeningCleanupError(error)
            }
            throw new Error(
              this.shuttingDown
                ? 'OpenAgent Service shutting down'
                : `Bart Thread 已替换: ${record.id}`
            )
          }
          this.bartInstance = instance
          this.bartInstanceThreadId = record.id
          this.bartThreadCreation = opened.threadCreation
          return instance
        })
        this.bartOpening = opening
        void opening.finally(() => {
          if (this.bartOpening === opening) this.bartOpening = undefined
        }).catch(() => undefined)
        return opening
      },
      { threadId: record.id, harnessId: record.harnessId }
    )
  }

  private async openBartThread(
    record: DeepReadonly<BartThreadRecord>,
    preparedThreadCreation?: ThreadCreationDescription
  ): Promise<OpenedBartThread> {
    return runServiceDebugSpan(
      'bart.thread.open',
      { threadId: record.id, harnessId: record.harnessId },
      async () => {
        // Recovery must compose the same configuration as the retained native
        // record. Pending preferences only take effect at successful admission.
        const state = this.store.read()
        const settings = state.bartAppliedSettings ?? state.settings
        const threadController = new AbortController()
        this.bartThreadController = threadController
        const signal = AbortSignal.any([
          threadController.signal,
          this.bartUseCaseController.signal,
          this.serviceController.signal
        ])
        const [systemEntries, threadCreation] = await Promise.all([
          collectBartContextEntries({
            timing: 'system',
            composition: this.bartContextComposition(settings),
            signal,
            onFailure: failure => this.reportFailure('context', failure)
          }),
          preparedThreadCreation ?? this.describeTargets(signal, settings)
        ])
        const tools = this.createBartToolBindings(record.id, signal, threadCreation)
        try {
          withDebugContext(getDebugContext(), () => debugDetail('bart.thread.open.assembled', {
            threadId: record.id,
            harnessId: record.harnessId,
            systemEntries,
            instructions: [
              BART_SYSTEM_PROMPT,
              threadCreation.instructions,
              `Model routing guidance:\n${settings.bart.routingGuidance ?? DEFAULT_BART_ROUTING_GUIDANCE}`
            ],
            toolSchemas: tools.map(tool => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            }))
          }))
          const instance = await this.main[record.harnessId].openThread({
            store: this.store,
            threadId: record.id,
            createExecutionId: () => this.createId(),
            now: () => this.boundaryTimestamp(),
            signal,
            committed: change => this.onBartCommitted(change),
            publishBartActivity: activity => this.publisher.bartActivity({
              threadId: record.id, harnessId: record.harnessId, activity
            }),
            injection: {
              instructions: [
                BART_SYSTEM_PROMPT,
                threadCreation.instructions,
                `Model routing guidance:\n${settings.bart.routingGuidance ?? DEFAULT_BART_ROUTING_GUIDANCE}`
              ],
              contextEntries: systemEntries,
              tools: { mode: 'exclusive', bindings: tools }
            }
          })
          return { instance, threadCreation }
        } catch (error) {
          threadController.abort(error)
          if (this.bartThreadController === threadController) {
            this.bartThreadController = undefined
          }
          throw error
        }
      },
      { threadId: record.id, harnessId: record.harnessId }
    )
  }

  private describeTargets(
    signal: AbortSignal,
    settings = this.store.read().settings
  ): Promise<ThreadCreationDescription> {
    return runServiceDebugSpan(
      'bart.targets.refresh',
      {
        cwd: this.paths.bartCwd,
        targetHarnessIds: [...settings.bart.targetHarnessIds]
      },
      () => this.describeTargetsImpl(signal, settings),
      { harnessId: readBartThread(this.store.read()).harnessId }
    )
  }

  private async describeTargetsImpl(
    signal: AbortSignal,
    settings: OpenAgentSettings
  ): Promise<ThreadCreationDescription> {
    let availability: readonly {
      readonly harnessId: HarnessId
      readonly availability: HarnessAvailability
    }[]
    const availabilityResults = await Promise.allSettled(
      settings.bart.targetHarnessIds.map(harnessId =>
        this.harnessAvailability(harnessId, settings, signal)
      )
    )
    signal.throwIfAborted()
    availability = availabilityResults.map((result, index) => ({
      harnessId: settings.bart.targetHarnessIds[index],
      availability: result.status === 'fulfilled'
        ? result.value
        : { available: false, reason: errorMessage(result.reason) }
    }))
    debugDetail('bart.targets.availability', { availability })
    const unavailableAdoptedTarget = this.bartThreadCreation?.targetHarnessIds.find(
      harnessId => availability.some(candidate =>
        candidate.harnessId === harnessId && !candidate.availability.available
      )
    )
    if (unavailableAdoptedTarget) {
      throw new ThreadSettingsRefreshUnavailableError(
        `已采用的 Bart Target Harness 暂时不可用: ${unavailableAdoptedTarget}`
      )
    }
    const targetHarnessIds = availability.flatMap(({ harnessId, availability: result }) =>
      result.available ? [harnessId] : []
    )
    if (targetHarnessIds.length === 0) {
      const reasons = availability.map(({ harnessId, availability: result }) =>
        `${harnessDescriptors[harnessId].displayName}: ${result.reason || 'unavailable'}`
      )
      throw new Error(`Bart 没有可用的 Target Harness（${reasons.join('；')}）`)
    }
    const composition = Object.fromEntries(
      HARNESS_IDS.map(harnessId => [
        harnessId,
        this.main[harnessId].settingsDescription(settings)
      ])
    ) as ThreadSettingsDescriptionComposition
    const described = await describeThreadCreation({
      cwd: this.paths.bartCwd,
      signal,
      targetHarnessIds,
      composition,
    })
    debugDetail('bart.targets.result', { threadCreation: described })
    return described
  }

  private bartContextComposition(
    settings: OpenAgentSettings
  ): BartContextEntryComposition {
    return Object.fromEntries(HARNESS_IDS.map((harnessId) => [
      harnessId,
      {
        contextEntries: this.main[harnessId].contextEntries(
          settings,
          this.paths.bartCwd
        )
      }
    ])) as BartContextEntryComposition
  }

  private appliedBartSettings(): OpenAgentSettings {
    const state = this.store.read()
    return state.bartAppliedSettings ?? state.settings
  }

  private startBartRunContextLifecycle(): void {
    if (this.shuttingDown || this.clearingHistory) return
    if (this.bartRunContextController.signal.aborted) {
      this.bartRunContextController = new AbortController()
    }
    this.startBartRunContextRefresh(this.appliedBartSettings(), true)
    this.armBartRunContextRefreshTimer()
  }

  private stopBartRunContextLifecycle(reason: Error): void {
    if (this.bartRunContextRefreshTimer) {
      clearTimeout(this.bartRunContextRefreshTimer)
      this.bartRunContextRefreshTimer = undefined
    }
    this.bartRunContextGeneration += 1
    this.bartRunContextController.abort(reason)
    this.bartRunContextSnapshot = undefined
    this.bartRunContextRefresh = undefined
  }

  private replaceBartRunContextScope(): void {
    this.stopBartRunContextLifecycle(
      new Error('OpenAgent settings generation changed')
    )
    this.startBartRunContextLifecycle()
  }

  private armBartRunContextRefreshTimer(): void {
    if (
      this.bartRunContextRefreshTimer ||
      this.shuttingDown ||
      this.clearingHistory
    ) return
    const timer = setTimeout(() => {
      if (this.bartRunContextRefreshTimer === timer) {
        this.bartRunContextRefreshTimer = undefined
      }
      if (this.shuttingDown || this.clearingHistory) return
      this.startBartRunContextRefresh(this.appliedBartSettings(), true)
      this.armBartRunContextRefreshTimer()
    }, BART_RUN_CONTEXT_REFRESH_MS)
    timer.unref()
    this.bartRunContextRefreshTimer = timer
  }

  private startBartRunContextRefresh(
    settings: OpenAgentSettings,
    force: boolean
  ): void {
    if (
      this.shuttingDown ||
      this.clearingHistory ||
      this.bartRunContextController.signal.aborted
    ) return
    const cwd = this.paths.bartCwd
    const existing = this.bartRunContextRefresh
    if (existing && this.sameBartRunContextScope(existing, settings, cwd)) return
    const cached = this.bartRunContextSnapshot
    if (
      !force &&
      cached &&
      this.sameBartRunContextScope(cached, settings, cwd) &&
      this.wallClockTimestamp() - cached.refreshedAt < BART_RUN_CONTEXT_REFRESH_MS
    ) return

    const generation = this.bartRunContextGeneration
    const settingsSnapshot = structuredClone(settings)
    const signal = AbortSignal.any([
      this.serviceController.signal,
      this.bartRunContextController.signal
    ])
    const span = withDebugContext(
      ensureDebugContext({}),
      () => startDebugSpan('bart.context.refresh', {
        timing: 'run',
        force,
        cwd
      })
    )
    const promise = (async (): Promise<void> => {
      try {
        const entries = await withDebugContext(span.context, () =>
          collectBartContextEntries({
          timing: 'run',
          composition: this.bartContextComposition(settingsSnapshot),
          signal,
          onFailure: failure => {
            if (!signal.aborted && generation === this.bartRunContextGeneration) {
              this.reportFailure('context', failure)
            }
          },
          trackContributorOperation: operation => {
            this.trackBartRunContextContributor(operation)
          }
          })
        )
        if (
          signal.aborted ||
          generation !== this.bartRunContextGeneration ||
          !this.sameBartRunContextScope(
            { settings: settingsSnapshot, cwd },
            this.appliedBartSettings(),
            this.paths.bartCwd
          )
        ) {
          span.end({ outcome: 'discarded', entryCount: entries.length })
          return
        }
        this.bartRunContextSnapshot = {
          settings: settingsSnapshot,
          cwd,
          entries: structuredClone(entries),
          refreshedAt: this.wallClockTimestamp()
        }
        debugDetail('bart.context.refresh.snapshot', {
          timing: 'run',
          cwd,
          entries
        })
        span.end({ outcome: 'refreshed', entryCount: entries.length })
      } catch (error) {
        if (!signal.aborted && generation === this.bartRunContextGeneration) {
          this.reportFailure('context-refresh', error)
        }
        span.fail(error, { outcome: signal.aborted ? 'cancelled' : 'failed' })
      }
    })()
    const refresh: BartRunContextRefresh = {
      settings: settingsSnapshot,
      cwd,
      promise
    }
    this.bartRunContextRefresh = refresh
    this.activeBartRunContextRefreshes.add(promise)
    void promise.finally(() => {
      this.activeBartRunContextRefreshes.delete(promise)
      if (this.bartRunContextRefresh === refresh) {
        this.bartRunContextRefresh = undefined
      }
    }).catch(() => undefined)
  }

  private readBartRunContextEntries(
    settings: OpenAgentSettings
  ): readonly CollectedBartContextEntry[] {
    const cached = this.bartRunContextSnapshot
    const sameScope = cached !== undefined && this.sameBartRunContextScope(
      cached, settings, this.paths.bartCwd
    )
    const entries = sameScope && cached
      ? structuredClone(cached.entries)
      : []
    if (cached && !sameScope) {
      this.bartRunContextSnapshot = undefined
    }
    this.startBartRunContextRefresh(settings, false)
    return sameScope
      ? entries
      : [structuredClone(BART_PENDING_TELEMETRY_CONTEXT)]
  }

  private sameBartRunContextScope(
    snapshot: { readonly settings: OpenAgentSettings; readonly cwd: string },
    settings: OpenAgentSettings,
    cwd: string
  ): boolean {
    return snapshot.cwd === cwd && sameJson(snapshot.settings, settings)
  }

  private trackBartRunContextContributor(operation: Promise<unknown>): void {
    const settled = operation.then(
      () => undefined,
      () => undefined
    )
    this.activeBartRunContextContributors.add(settled)
    void settled.finally(() => {
      this.activeBartRunContextContributors.delete(settled)
    }).catch(() => undefined)
  }

  private async drainBartRunContextOperations(): Promise<void> {
    while (
      this.activeBartRunContextRefreshes.size > 0 ||
      this.activeBartRunContextContributors.size > 0
    ) {
      await Promise.allSettled([
        ...this.activeBartRunContextRefreshes,
        ...this.activeBartRunContextContributors
      ])
    }
  }

  private createBartToolBindings(
    threadId: string,
    threadSignal: AbortSignal,
    threadCreation: ThreadCreationDescription
  ): readonly HarnessToolBinding[] {
    return this.rawBartToolBindings(threadCreation).map(binding => {
      const recorded = createRecordedHarnessToolBinding({
        binding,
        threadId,
        threadSignal,
        currentExecution: () => {
          const execution = this.bartInstance?.execution
          if (!execution) return null
          const scope = this.bartExecutionScopes.get(execution.executionId)
          if (!scope || scope.threadId !== threadId) return null
          return {
            threadId,
            executionId: execution.executionId,
            signal: scope.controller.signal,
            debugContext: scope.debugContext
          }
        },
        createCallId: () => this.createId(),
        createOperationId: () => this.createId(),
        now: () => this.boundaryTimestamp(),
        recordTranscript: mutation => this.recordBartToolTranscript(
          threadId,
          mutation
        )
      })
      return {
        ...recorded,
        execute: request => this.trackBartToolExecution(
          () => recorded.execute(request)
        )
      }
    })
  }

  private rawBartToolBindings(
    threadCreation: ThreadCreationDescription
  ): readonly HarnessToolBinding[] {
    return createBartToolBindings(threadCreation.inputSchema, {
      listThreads: (_value, signal) => this.bartListThreads(signal),
      startThread: (value, signal) => this.bartStartThread(value, signal, threadCreation),
      forkThread: (value, signal) => this.bartForkThread(value, signal),
      threadStatus: (value, signal) => this.bartThreadStatus(value, signal),
      setThreadArchived: async (value, signal) => {
        signal.throwIfAborted()
        const object = requiredToolObject(value)
        if (typeof object.archived !== 'boolean') throw new Error('archived 必须是 boolean')
        await this.setThreadArchived(requiredObjectString(object, 'threadId'), object.archived)
        return { ok: true }
      },
      sendThread: (value, signal) => this.bartSendThread(value, signal),
      readThread: (value, signal) => this.bartReadThread(value, signal),
      interruptThread: (value, signal) => this.bartInterruptThread(value, signal),
      createReport: (value, signal) => this.bartCreateReport(value, signal),
      listReports: (_value, signal) => this.bartListReports(signal),
      readReport: (value, signal) => this.bartReadReport(value, signal),
      updateReport: (value, signal) => this.bartUpdateReport(value, signal),
      setReportArchived: (value, signal) => this.bartSetReportArchived(value, signal),
      createSchedule: (value, signal) => this.bartCreateSchedule(value, signal, threadCreation),
      listSchedules: (_value, signal) => this.bartListSchedules(signal),
      cancelSchedule: (value, signal) => this.bartCancelSchedule(value, signal)
    })
  }

  private async bartListThreads(signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted()
    const threads = this.agentRecords().filter(thread => !thread.archived).map(thread => publicThreadEnvelope(thread))
    return jsonValue({ ok: true, count: threads.length, threads })
  }

  private async bartStartThread(
    value: JsonValue,
    signal: AbortSignal,
    threadCreation: ThreadCreationDescription
  ): Promise<JsonValue> {
    signal.throwIfAborted()
    const target = parseThreadCreationRequest(value)
    if (!target) throw new Error('thread_create 参数无效')
    this.assertAllowedTarget(target.harnessId)
    let temporaryCwd: string | undefined
    let dispatchStarted = false
    try {
      temporaryCwd = target.cwd ? undefined : await this.createTemporaryWorkspace()
      signal.throwIfAborted()
      const executionCwd = target.cwd
        ? await this.validateCwd(target.cwd)
        : temporaryCwd!
      signal.throwIfAborted()
      const resolved = await this.resolveTarget(
        target,
        executionCwd,
        signal,
        threadCreation
      )
      signal.throwIfAborted()
      dispatchStarted = true
      const created = await this.createThreadAndDispatch({
        input: textInput(target.prompt),
        cwd: executionCwd,
        worktree: target.worktree ? { enabled: true } : undefined,
        resolved,
        signal,
        bartGeneration: true,
        ownedTemporaryWorkspace: temporaryCwd !== undefined
      })
      return {
        ok: true,
        threadId: created.record.id,
        executionId: created.execution.executionId,
        acknowledgement: resolved.acknowledgement
      }
    } catch (error) {
      if (temporaryCwd && !dispatchStarted) {
        await rm(temporaryCwd, { recursive: true, force: true }).catch(() => undefined)
      }
      throw error
    }
  }

  private async bartThreadStatus(value: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted()
    const thread = readAgentThread(this.store.read(), toolString(value, 'threadId'))
    return jsonValue({ ok: true, thread: publicThreadEnvelope(thread) })
  }

  private async bartForkThread(value: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted()
    const sourceThreadId = toolString(value, 'threadId')
    // Reject an invalid prompt before creating a durable child.
    const prompt = toolString(value, 'prompt', MAX_INPUT_TEXT)
    const { threadId } = await this.forkAgentThread({
      threadId: sourceThreadId, request: {}
    }, this.agentLifecycleSignal(signal))
    try {
      return await this.bartSendThread({ threadId, prompt }, signal)
    } catch (error) {
      throw new Error(
        `Thread 已 fork 为 ${threadId}，但发送指令失败：${errorMessage(error)}。请检查该 Thread 的状态后继续，避免重复 fork。`,
        { cause: error }
      )
    }
  }

  private async bartSendThread(value: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted()
    const threadId = toolString(value, 'threadId')
    const input = textInput(toolString(value, 'prompt', MAX_INPUT_TEXT))
    const result = await this.sendAgentThread(threadId, input, signal)
    this.metadata.request(threadId, input)
    return {
      ok: true,
      threadId,
      executionId: result.executionId,
      startedNewExecution: result.startedNewExecution
    }
  }

  private async bartReadThread(value: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    const threadId = toolString(value, 'threadId')
    const answer = await this.threadLifecycle.read(
      threadId, toolString(value, 'question', MAX_INPUT_TEXT), this.agentLifecycleSignal(signal)
    )
    return { ok: true, threadId, answer }
  }

  private async bartInterruptThread(value: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    const threadId = toolString(value, 'threadId')
    await this.threadLifecycle.interrupt(threadId, this.agentLifecycleSignal(signal))
    return { ok: true, threadId }
  }

  private async bartCreateReport(value: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted()
    const report = await this.reports.create(requiredToolObject(value), signal)
    return jsonValue({ ok: true, report })
  }

  private async bartListReports(signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted()
    return jsonValue({ ok: true, reports: this.reports.list() })
  }

  private async bartReadReport(value: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted()
    return jsonValue({
      ok: true,
      report: this.readReport(toolString(value, 'reportId'))
    })
  }

  private async bartUpdateReport(value: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted()
    const object = requiredToolObject(value)
    const report = await this.reports.update(requiredObjectString(object, 'reportId'), object, signal)
    return jsonValue({ ok: true, report })
  }

  private async bartSetReportArchived(
    value: JsonValue,
    signal: AbortSignal
  ): Promise<JsonValue> {
    signal.throwIfAborted()
    const object = requiredToolObject(value)
    const reportId = requiredObjectString(object, 'reportId')
    if (typeof object.archived !== 'boolean') throw new Error('archived 必须是 boolean')
    await this.reports.setArchived(reportId, object.archived, signal)
    return jsonValue({
      ok: true,
      report: reportThreadSummary(this.readReport(reportId))
    })
  }

  private async bartCreateSchedule(
    value: JsonValue,
    signal: AbortSignal,
    threadCreation: ThreadCreationDescription
  ): Promise<JsonValue> {
    signal.throwIfAborted()
    const object = requiredToolObject(value)
    const executeAt = parseScheduleTimestamp(object.executeAt)
    const targetObject = { ...object }
    delete targetObject.executeAt
    if (!isJsonValue(targetObject)) throw new Error('schedule target 必须是 JSON')
    const target = parseThreadCreationRequest(targetObject)
    if (!target) throw new Error('schedule_create 参数无效')
    this.assertAllowedTarget(target.harnessId)
    const now = this.wallClockTimestamp()
    if (executeAt <= now) throw new Error('executeAt 必须在未来')
    const settingsCwd = target.cwd
      ? await this.validateCwd(target.cwd)
      : await this.ensureTemporaryWorkspaceRoot()
    signal.throwIfAborted()
    const resolved = await this.resolveTarget(
      target,
      settingsCwd,
      signal,
      threadCreation
    )
    signal.throwIfAborted()
    const request: ScheduledDispatchRequest = {
      input: textInput(target.prompt),
      ...(target.cwd ? { cwd: settingsCwd } : {}),
      ...(target.worktree ? { worktree: { enabled: true } } : {}),
      harnessId: resolved.harnessId as HarnessId,
      threadSettings: resolved.threadSettings,
      targetAcknowledgement: resolved.acknowledgement
    }
    const dispatch: ScheduledDispatch = {
      id: this.createId(), executeAt, createdAt: now, request
    }
    await this.schedules.add(dispatch, signal)
    return jsonValue({ ok: true, schedule: scheduledDispatchSummary(dispatch) })
  }

  private async bartListSchedules(signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted()
    return jsonValue({
      ok: true,
      schedules: this.schedules.list()
    })
  }

  private async bartCancelSchedule(value: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted()
    const scheduleId = toolString(value, 'scheduleId')
    const removed = await this.schedules.cancel(scheduleId, signal)
    return jsonValue({ ok: true, schedule: scheduledDispatchSummary(removed) })
  }

  private async resolveTarget(
    target: ThreadCreationRequest,
    cwd: string,
    signal: AbortSignal,
    description: ThreadCreationDescription
  ): Promise<ResolvedTarget> {
    return runServiceDebugSpan(
      'bart.target.resolve',
      { harnessId: target.harnessId, cwd },
      async () => {
        signal.throwIfAborted()
        const settings = this.store.read().settings
        this.assertAllowedTarget(target.harnessId)
        if (!description.targetHarnessIds.includes(target.harnessId)) {
          throw new Error(`Harness is absent from the current Thread creation schema: ${target.harnessId}`)
        }
        debugDetail('bart.target.resolve.input', {
          harnessId: target.harnessId,
          cwd,
          options: target.options,
        })
        const availability = await this.harnessAvailability(target.harnessId, settings, signal)
        signal.throwIfAborted()
        if (!availability.available) {
          throw new Error(
            `Bart Target Harness 不可用: ${harnessDescriptors[target.harnessId].displayName}` +
            (availability.reason ? `（${availability.reason}）` : '')
          )
        }
        const threadSettings = await withDebugContext(
          ensureDebugContext({ harnessId: target.harnessId }),
          () => this.main[target.harnessId].resolveThreadSettings({
            requested: target.options,
            settings,
            cwd,
            signal
          })
        )
        const result = { harnessId: target.harnessId, threadSettings, acknowledgement: threadSettings }
        debugDetail('bart.target.resolve.result', {
          harnessId: target.harnessId,
          cwd,
          resolved: result
        })
        return result
      },
      { harnessId: target.harnessId }
    )
  }

  private async createThreadAndDispatch(
    input: CreateThreadAndDispatchInput
  ): Promise<CreatedThread> {
    const span = withDebugContext(
      ensureDebugContext({ harnessId: input.resolved.harnessId }),
      () => startDebugSpan('agent.create-dispatch', {
        harnessId: input.resolved.harnessId,
        cwd: input.cwd,
        worktree: input.worktree?.enabled === true,
        bartGeneration: input.bartGeneration === true
      })
    )
    try {
      withDebugContext(span.context, () => debugDetail('agent.create-dispatch.input', {
        input,
        resolved: input.resolved
      }))
      const result = await withDebugContext(span.context, () =>
        this.createThreadAndDispatchImpl(input)
      )
      span.end({
        threadId: result.record.id,
        executionId: result.execution.executionId,
        startedNewExecution: result.execution.startedNewExecution
      })
      return result
    } catch (error) {
      debugError('agent.create-dispatch.failed', error, {
        harnessId: input.resolved.harnessId,
        cwd: input.cwd
      })
      span.fail(error, { harnessId: input.resolved.harnessId })
      throw error
    }
  }

  private async createThreadAndDispatchImpl(
    input: CreateThreadAndDispatchInput
  ): Promise<CreatedThread> {
    const threadId = this.createId()
    const ownsTemporaryWorkspace = input.ownedTemporaryWorkspace === true || input.cwd === undefined
    // A caller-created temporary workspace transfers ownership at function
    // entry. Seed the rollback target before the first abort check so no
    // cancellation boundary can leave it ownerless.
    let baseCwd: string | undefined = input.ownedTemporaryWorkspace === true
      ? input.cwd
      : undefined
    let preparation: WorktreePreparation | undefined
    let recordCommitted = false
    try {
      input.signal.throwIfAborted()
      baseCwd = input.cwd
        ? await this.validateCwd(input.cwd)
        : await this.createTemporaryWorkspace()
      input.signal.throwIfAborted()
      if (input.worktree?.enabled) {
        if (!input.cwd) throw new Error('worktree 需要显式 cwd')
        preparation = await this.worktrees.prepareForStart({
          cwd: baseCwd,
          threadId,
          requested: input.worktree
        })
        input.signal.throwIfAborted()
      }
      const at = this.boundaryTimestamp()
      const metadataInput = {
        id: threadId,
        harnessId: input.resolved.harnessId,
        revision: 0,
        archived: false,
        title: placeholderThreadTitle(input.input),
        titlePending: true as const,
        tags: [] as string[],
        sessionState: null,
        observation: { latestExecution: null, backgroundWork: null },
        // The Core workspace remains the user-selected/base directory. Harness
        // execution uses worktree.cwd when present, preserving both facts.
        cwd: baseCwd,
        ...(preparation ? { worktree: preparation.worktree } : {}),
        settings: input.resolved.threadSettings,
        createdAt: at,
        updatedAt: at
      } satisfies AgentThreadRecord
      input.signal.throwIfAborted()
      await this.commit(
        { type: 'add-agent-thread', thread: metadataInput },
        input.bartGeneration
          ? {
              type: 'bart-generation',
              target: { kind: 'thread', id: threadId }
            }
          : undefined
      )
      recordCommitted = true
      const sendClaim = this.beginAgentSendClaim(threadId)
      let execution: ThreadSendResult
      try {
        execution = await this.runAgentCommand(threadId, async () => {
          try {
            input.signal.throwIfAborted()
            const result = await this.sendAgentThreadUnlocked(
              threadId,
              input.input,
              input.signal,
              sendClaim
            )
            input.signal.throwIfAborted()
            return result
          } catch (error) {
            if (
              input.signal.aborted ||
              this.createdThreadHasNoAdmittedExecution(threadId)
            ) {
              try {
                await this.rollbackCreatedAgentThread(threadId)
                recordCommitted = false
              } catch (rollbackError) {
                throw new AggregateError(
                  [error, rollbackError],
                  `失权 Agent Thread ${threadId} 回滚失败`
                )
              }
            }
            throw error
          }
        })
      } finally {
        this.finishAgentSendClaim(threadId, sendClaim)
      }
      input.signal.throwIfAborted()
      this.metadata.request(threadId, input.input)
      return {
        record: readAgentThread(this.store.read(), threadId),
        execution
      }
    } catch (error) {
      const cleanupErrors: unknown[] = []
      if (
        recordCommitted && (
          input.signal.aborted ||
          this.createdThreadHasNoAdmittedExecution(threadId)
        )
      ) {
        try {
          await this.rollbackCreatedAgentThread(threadId)
          recordCommitted = false
        } catch (rollbackError) {
          cleanupErrors.push(rollbackError)
        }
      }
      const recordStillExists = recordCommitted &&
        this.store.read().threads.some(item => item.id === threadId)
      if (preparation && !recordStillExists) {
        try {
          await this.worktrees.discard(preparation)
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (
        ownsTemporaryWorkspace &&
        baseCwd !== undefined &&
        !recordStillExists
      ) {
        try {
          await rm(baseCwd, { recursive: true, force: true })
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (cleanupErrors.length) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Agent Thread ${threadId} 创建回滚未完整完成`
        )
      }
      throw error
    }
  }

  private async sendAgentThread(
    threadId: string,
    input: AgentInput,
    signal: AbortSignal = this.serviceController.signal
  ): Promise<ThreadSendResult> {
    return runServiceDebugSpan(
      'agent.send',
      { threadId },
      async () => {
        const claim = this.beginAgentSendClaim(threadId)
        try {
          withDebugContext(claim.debugContext, () => debugDetail('agent.send.input', {
            threadId,
            input
          }))
          return await this.runAgentCommand(threadId, () =>
            this.sendAgentThreadUnlocked(threadId, input, signal, claim)
          )
        } finally {
          this.finishAgentSendClaim(threadId, claim)
        }
      },
      { threadId }
    )
  }

  private async sendAgentThreadUnlocked(
    threadId: string,
    input: AgentInput,
    signal: AbortSignal,
    claim: AgentSendClaim
  ): Promise<ThreadSendResult> {
    const combinedSignal = AbortSignal.any([
      signal,
      this.serviceController.signal,
      this.agentOwnershipController.signal,
      claim.controller.signal
    ])
    combinedSignal.throwIfAborted()
    // Losing send authority must reject immediately even when the shared
    // Handle opening is still blocked. The opening remains owned by Service
    // and may complete into an idle cached Instance.
    const instance = await waitForAbortable(
      this.agentInstance(threadId),
      combinedSignal
    )
    combinedSignal.throwIfAborted()
    const source = readAgentThread(this.store.read(), threadId)
    if (instance.execution) {
      // A follow-up is native I/O on the already-admitted Execution. Recheck
      // current workspace authority before entering the Plugin steer path.
      await this.admitCurrentThreadExecution(
        threadId,
        source.harnessId,
        combinedSignal
      )
      combinedSignal.throwIfAborted()
    }
    input = await this.attachments.retainInput(threadId, input)
    combinedSignal.throwIfAborted()
    if (readAgentThread(this.store.read(), threadId).archived) {
      throw new Error(`Agent Thread 已归档，取消归档后才能追加任务: ${threadId}`)
    }
    claim.enteredRuntime = true
    return withDebugContext(claim.debugContext, () => instance.send(
      input,
      combinedSignal,
      [],
      async result => {
        if (result.startedNewExecution) {
          await this.admitCurrentThreadExecution(
            threadId,
            source.harnessId,
            combinedSignal
          )
        }
        // For a new Execution this callback runs inside the running
        // observation commit, before Plugin native start can continue.
        // Active follow-ups reach it after native acceptance and still flush
        // their newly committed private input before Service acknowledges.
        await this.store.flushThread(threadId)
        combinedSignal.throwIfAborted()
      }
    ))
  }

  private agentInstance(
    threadId: string,
    allowForkReservation = false
  ): Promise<HarnessThreadInstanceView> {
    assertIdentifier(threadId, 'threadId')
    if (this.shuttingDown || this.clearingHistory) {
      return Promise.reject(new Error('Agent Thread ownership 正在关闭'))
    }
    if (this.threadLifecycle.isDeleting(threadId)) {
      return Promise.reject(new Error(`Agent Thread 正在删除: ${threadId}`))
    }
    const resolved = this.agentInstances.get(threadId)
    if (resolved) return Promise.resolve(resolved)
    const opening = this.agentOpenings.get(threadId)
    if (opening) return opening
    if (this.forkingAgentThreads.has(threadId) && !allowForkReservation) {
      return Promise.reject(new Error(`Agent Thread fork reservation 进行中: ${threadId}`))
    }
    const record = readAgentThread(this.store.read(), threadId)
    const ownershipGeneration = this.agentOwnershipGeneration
    let created: Promise<HarnessThreadInstanceView>
    created = this.openAgentInstance(record).then(async instance => {
      const stillExists = this.store.read().threads.some(candidate =>
        candidate.id === threadId && isAgentThreadRecord(candidate)
      )
      if (
        ownershipGeneration !== this.agentOwnershipGeneration ||
        this.shuttingDown ||
        this.clearingHistory ||
        this.threadLifecycle.isDeleting(threadId) ||
        this.agentOpenings.get(threadId) !== created ||
        !stillExists
      ) {
        if (this.agentOpenings.get(threadId) === created) {
          this.agentOpenings.delete(threadId)
        }
        try {
          await instance.dispose()
        } catch (error) {
          throw new AgentOpeningCleanupError(error)
        }
        throw new Error('Agent Thread ownership generation 已失效')
      }
      this.agentOpenings.delete(threadId)
      this.agentInstances.set(threadId, instance)
      return instance
    }, error => {
      if (this.agentOpenings.get(threadId) === created) {
        this.agentOpenings.delete(threadId)
      }
      if (
        ownershipGeneration !== this.agentOwnershipGeneration ||
        this.shuttingDown ||
        this.clearingHistory ||
        this.threadLifecycle.isDeleting(threadId)
      ) {
        if (error instanceof HarnessThreadOpeningCleanupError) {
          throw new AgentOpeningCleanupError(error.cleanupError)
        }
        throw new Error('Agent Thread ownership generation 已失效')
      }
      throw error
    })
    this.agentOpenings.set(threadId, created)
    return created
  }

  private beginAgentSendClaim(threadId: string): AgentSendClaim {
    if (readAgentThread(this.store.read(), threadId).archived) {
      throw new Error(`Agent Thread 已归档，取消归档后才能追加任务: ${threadId}`)
    }
    if (this.forkingAgentThreads.has(threadId)) {
      throw new Error(`Thread fork 进行期间不能 send: ${threadId}`)
    }
    const claim: AgentSendClaim = {
      controller: new AbortController(),
      debugContext: ensureDebugContext({ threadId }),
      enteredRuntime: false
    }
    let claims = this.agentSendClaims.get(threadId)
    if (!claims) {
      claims = new Set()
      this.agentSendClaims.set(threadId, claims)
    }
    claims.add(claim)
    withDebugContext(claim.debugContext, () => debugLog('agent.send.admission.queued', {
      threadId,
      pendingCount: claims?.size ?? 1
    }))
    return claim
  }

  private finishAgentSendClaim(threadId: string, claim: AgentSendClaim): void {
    const claims = this.agentSendClaims.get(threadId)
    claims?.delete(claim)
    withDebugContext(claim.debugContext, () => debugLog('agent.send.admission.released', {
      threadId,
      enteredRuntime: claim.enteredRuntime,
      pendingCount: claims?.size ?? 0
    }))
    if (claims?.size === 0) this.agentSendClaims.delete(threadId)
  }

  private cancelAgentSendClaims(
    threadId: string,
    reason: Error
  ): AgentSendCancellation {
    const claims = [...(this.agentSendClaims.get(threadId) ?? [])]
    let enteredRuntime = false
    for (const claim of claims) {
      enteredRuntime ||= claim.enteredRuntime
      // Runtime owns cancellation after its synchronous send ticket is
      // installed. Before that boundary this controller cuts off openings and
      // ordinary commands that were queued before Stop.
      if (!claim.enteredRuntime && !claim.controller.signal.aborted) {
        claim.controller.abort(reason)
      }
    }
    return { claimed: claims.length > 0, enteredRuntime }
  }

  private cancelAllAgentSendClaims(reason: Error): void {
    for (const threadId of this.agentSendClaims.keys()) {
      this.cancelAgentSendClaims(threadId, reason)
    }
  }

  private runAgentCommand<Result>(
    threadId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    let queue = this.agentCommands.get(threadId)
    if (!queue) {
      queue = new SerialQueue()
      this.agentCommands.set(threadId, queue)
    }
    return runServiceDebugSpan(
      'agent.command',
      { threadId },
      () => queue!.run(() => withDebugContext(
        ensureDebugContext({ threadId }),
        operation
      )),
      { threadId }
    )
  }

  /** Interrupt is a control-plane operation and never enters agentCommands. */
  private runAgentInterrupt(
    threadId: string,
    signal: AbortSignal,
    cancellation: AgentSendCancellation,
    expectedExecutionId: string | null,
    allowDeleting = false
  ): Promise<void> {
    // Bind the control decision to call-time ownership. In particular, an idle
    // Stop must not await an unrelated Handle opening and then cancel a send
    // submitted after the Stop request.
    const callTimeInstance = this.agentInstances.get(threadId)
    const span = withDebugContext(
      ensureDebugContext({ threadId, executionId: expectedExecutionId ?? undefined }),
      () => startDebugSpan('agent.interrupt', {
        threadId,
        expectedExecutionId,
        allowDeleting
      })
    )
    const operation = withDebugContext(span.context, async () => {
      const operationSignal = AbortSignal.any([
        signal,
        this.serviceController.signal,
        this.agentOwnershipController.signal
      ])
      operationSignal.throwIfAborted()
      if (cancellation.claimed && !cancellation.enteredRuntime &&
          expectedExecutionId === null) {
        return
      }
      if (expectedExecutionId === null && !cancellation.enteredRuntime &&
          !callTimeInstance) {
        throw new Error('Thread 当前没有 active Execution')
      }
      // Avoid an await for the common cached path. Consecutive Stop requests
      // therefore enter Runtime in call order and join its exact-execution
      // barrier instead of allowing A→B rethreadCreation in a Service queue.
      const instance = callTimeInstance ?? this.agentInstances.get(threadId) ??
        await this.agentInstance(threadId)
      operationSignal.throwIfAborted()
      if ((!allowDeleting && this.threadLifecycle.isDeleting(threadId)) ||
          this.agentInstances.get(threadId) !== instance) {
        throw new Error(`Agent Thread ownership 已失效: ${threadId}`)
      }
      try {
        await instance.interrupt(expectedExecutionId)
      } catch (error) {
        const latest = instance.observation.latestExecution
        if (cancellation.claimed &&
            (!latest || isTerminalPublicExecution(latest))) return
        throw error
      }
    })
    let runs = this.agentInterruptRuns.get(threadId)
    if (!runs) {
      runs = new Set()
      this.agentInterruptRuns.set(threadId, runs)
    }
    runs.add(operation)
    void operation.then(
      () => {
        span.end({ threadId, executionId: expectedExecutionId ?? undefined })
        this.finishAgentInterrupt(threadId, operation)
      },
      error => {
        debugError('agent.interrupt.failed', error, {
          threadId,
          expectedExecutionId
        })
        span.fail(error, { threadId, executionId: expectedExecutionId ?? undefined })
        this.finishAgentInterrupt(threadId, operation)
      }
    )
    return operation
  }

  private finishAgentInterrupt(threadId: string, operation: Promise<void>): void {
    const runs = this.agentInterruptRuns.get(threadId)
    runs?.delete(operation)
    if (runs?.size === 0) this.agentInterruptRuns.delete(threadId)
  }

  private async drainAgentCommands(): Promise<void> {
    while (true) {
      const queues = [...this.agentCommands.values()]
      if (!queues.length) return
      await Promise.all(queues.map(queue => queue.drain()))
      if (queues.length === this.agentCommands.size) return
    }
  }

  private async drainAgentInterrupts(threadId?: string): Promise<void> {
    while (true) {
      const operations = threadId === undefined
        ? [...this.agentInterruptRuns.values()].flatMap(runs => [...runs])
        : [...(this.agentInterruptRuns.get(threadId) ?? [])]
      if (!operations.length) return
      await Promise.allSettled(operations)
    }
  }

  private async disposeOwnedAgentInstances(): Promise<void> {
    const openings = [...this.agentOpenings.values()]
    const disposed = new Set<HarnessThreadInstanceView>()
    const errors: unknown[] = []
    const collect = (results: readonly PromiseSettledResult<unknown>[]): void => {
      for (const result of results) {
        if (result.status === 'rejected' && !errors.includes(result.reason)) {
          errors.push(result.reason)
        }
      }
    }
    const disposeSnapshot = async (): Promise<void> => {
      const instances = [...this.agentInstances.values()].filter(instance => {
        if (disposed.has(instance)) return false
        disposed.add(instance)
        return true
      })
      collect(await Promise.allSettled(instances.map(instance => instance.dispose())))
    }
    try {
      await disposeSnapshot()
      // Ownership invalidation intentionally rejects an opening that finishes
      // after shutdown began. It is still awaited, but that expected control
      // result is not a teardown failure.
      const openingResults = await Promise.allSettled(openings)
      for (const result of openingResults) {
        if (result.status === 'rejected' && result.reason instanceof AgentOpeningCleanupError &&
            !errors.includes(result.reason.cleanupError)) {
          errors.push(result.reason.cleanupError)
        }
      }
      // An opening may have installed just before the ownership generation was
      // invalidated. Dispose the final cache snapshot before clearing it.
      await disposeSnapshot()
    } finally {
      this.agentInstances.clear()
      this.agentOpenings.clear()
    }
    if (errors.length) throw new AggregateError(errors, 'Agent Thread disposal failed')
  }

  private async rollbackCreatedAgentThread(threadId: string): Promise<void> {
    if (this.threadLifecycle.isDeleting(threadId)) {
      throw new Error(`Agent Thread ${threadId} 已有删除 owner`)
    }
    const releaseDeletion = this.threadLifecycle.reserveDeletion(threadId)
    this.cancelAgentSendClaims(
      threadId,
      new Error(`Agent Thread rolled back: ${threadId}`)
    )
    try {
      const instance = this.agentInstances.get(threadId)
      if (instance) {
        if (instance.execution) await instance.interrupt().catch(() => undefined)
        await instance.dispose().catch(() => undefined)
        if (this.agentInstances.get(threadId) === instance) {
          this.agentInstances.delete(threadId)
        }
      }
      if (this.store.read().threads.some(candidate => candidate.id === threadId)) {
        await this.commit({ type: 'delete-agent-thread', threadId })
        await this.attachments.releaseOwner(threadId)
          .catch(error => this.reportFailure('attachment-owner-delete', error))
      }
    } finally {
      releaseDeletion()
    }
  }

  private createdThreadHasNoAdmittedExecution(threadId: string): boolean {
    const thread = this.store.read().threads.find(candidate => candidate.id === threadId)
    return thread !== undefined && isAgentThreadRecord(thread) &&
      thread.observation.latestExecution === null
  }

  private async openAgentInstance(
    record: DeepReadonly<AgentThreadRecord>
  ): Promise<HarnessThreadInstanceView> {
    return runServiceDebugSpan(
      'agent.thread.open',
      { threadId: record.id, harnessId: record.harnessId, cwd: record.cwd },
      async () => {
        const common = {
          store: this.store,
          threadId: record.id,
          createExecutionId: () => this.createId(),
          now: () => this.boundaryTimestamp(),
          signal: AbortSignal.any([
            this.serviceController.signal,
            this.agentOwnershipController.signal
          ])
        }
        withDebugContext(getDebugContext(), () => debugDetail('agent.thread.open.input', {
          threadId: record.id,
          harnessId: record.harnessId,
          cwd: record.cwd,
          worktree: record.worktree,
          settings: record.settings,
          sessionState: record.sessionState
        }))
        await this.validateAgentThreadWorkspace(record, common.signal)
        const instance = await this.main[record.harnessId].openThread({
          ...common,
          admitNativeExecution: signal => this.admitCurrentThreadExecution(
            record.id,
            record.harnessId,
            signal
          ),
          committed: change => this.onAgentCommitted(change)
        })
        return instance
      },
      { threadId: record.id, harnessId: record.harnessId }
    )
  }

  private async admitCurrentThreadExecution(
    threadId: string,
    harnessId: string,
    signal: AbortSignal
  ): Promise<void> {
    return runServiceDebugSpan(
      'agent.execution.admission',
      { threadId, harnessId, phase: 'wait-before-execution' },
      async () => {
        signal.throwIfAborted()
        const source = readAgentThread(this.store.read(), threadId)
        if (source.harnessId !== harnessId) {
          throw new Error(`Agent Thread Harness identity 已变化: ${threadId}`)
        }
        // Execution admission is allowed to adopt a legitimate new detached HEAD
        // produced by the preceding native execution. Check canonical path/source
        // ownership here, then let the WorktreeManager admission perform its own
        // multi-snapshot identity validation and durable proof update.
        await this.validateAgentThreadPaths(source, signal)
        signal.throwIfAborted()
        this.assertThreadWorkspaceSourceCurrent(source)
        await this.admitManagedThreadExecution(source, signal)
        signal.throwIfAborted()
        const current = readAgentThread(this.store.read(), threadId)
        if (
          current.harnessId !== source.harnessId ||
          current.cwd !== source.cwd ||
          !sameJson(current.worktree ?? null, source.worktree ?? null)
        ) {
          throw new Error(`Agent Thread workspace identity 已变化: ${threadId}`)
        }
      },
      { threadId, harnessId }
    )
  }

  private async validateAgentThreadWorkspace(
    record: DeepReadonly<AgentThreadRecord>,
    signal: AbortSignal,
    expected?: ManagedWorktreeValidation
  ): Promise<ManagedWorktreeValidation | undefined> {
    await this.validateAgentThreadPaths(record, signal)
    return this.validateManagedThreadWorkspace(record, signal, expected)
  }

  private async validateAgentThreadPaths(
    record: DeepReadonly<AgentThreadRecord>,
    signal: AbortSignal
  ): Promise<void> {
    const cwd = await this.validateCwd(record.cwd)
    signal.throwIfAborted()
    if (cwd !== record.cwd) {
      throw new Error(`Agent Thread cwd identity 已变化: ${record.id}`)
    }
    if (record.worktree?.cwd) {
      const worktreeCwd = await this.validateCwd(record.worktree.cwd)
      signal.throwIfAborted()
      if (worktreeCwd !== record.worktree.cwd) {
        throw new Error(`Agent Thread worktree cwd identity 已变化: ${record.id}`)
      }
    }
  }

  private assertThreadWorkspaceSourceCurrent(
    source: DeepReadonly<AgentThreadRecord>
  ): void {
    const current = readAgentThread(this.store.read(), source.id)
    if (
      current.harnessId !== source.harnessId ||
      current.cwd !== source.cwd ||
      !sameJson(current.worktree ?? null, source.worktree ?? null)
    ) {
      throw new Error(`Agent Thread workspace source 已变化: ${source.id}`)
    }
  }

  private async validateManagedThreadWorkspace(
    record: DeepReadonly<AgentThreadRecord>,
    signal: AbortSignal,
    expected?: ManagedWorktreeValidation
  ): Promise<ManagedWorktreeValidation | undefined> {
    if (record.worktree?.native !== false) return undefined
    const validation = await this.worktrees.validateManagedWorktree({
      ownerThreadId: record.id,
      worktree: record.worktree,
      ...(expected
        ? {
            expectedHeadOid: expected.headOid,
            expectedCwd: expected.cwd,
            expectedRepositoryIdentity: expected.repositoryIdentity
          }
        : {}),
      signal
    })
    signal.throwIfAborted()
    if (validation.cwd !== record.worktree.cwd) {
      throw new Error(`Agent Thread managed worktree cwd identity 已变化: ${record.id}`)
    }
    if (expected && (
      validation.headOid !== expected.headOid ||
      validation.cwd !== expected.cwd ||
      validation.repositoryIdentity !== expected.repositoryIdentity
    )) {
      throw new Error(`Agent Thread managed worktree validation facts 已变化: ${record.id}`)
    }
    return validation
  }

  private async admitManagedThreadExecution(
    record: DeepReadonly<AgentThreadRecord>,
    signal: AbortSignal
  ): Promise<void> {
    if (record.worktree?.native !== false) return
    const admission = await this.worktrees.admitManagedWorktreeExecution({
      ownerThreadId: record.id,
      worktree: record.worktree,
      signal
    })
    signal.throwIfAborted()
    if (admission.cwd !== record.worktree.cwd) {
      throw new Error(`Agent Thread managed worktree cwd identity 已变化: ${record.id}`)
    }
  }

  private async openPersistedAgentThreads(): Promise<void> {
    await Promise.all(this.agentRecords().map(async thread => {
      try {
        await this.agentInstance(thread.id)
      } catch (error) {
        if (this.shuttingDown || this.clearingHistory) return
        this.reportFailure('agent-recovery', error)
        await this.appendBartLocalSystemMessage(
          `Agent Thread ${thread.id} restart recovery failed: ${errorMessage(error)}`
        ).catch(reportError => this.reportFailure('agent-recovery-report', reportError))
      }
    }))
  }

  private async rehydrateManagedWorktreeOwners(): Promise<void> {
    const managed = this.agentRecords()
      .filter(thread => thread.worktree?.native === false && Boolean(thread.worktree.cwd))
      .map(thread => ({
        ownerThreadId: thread.id,
        worktree: structuredClone(thread.worktree!)
      }))
    const failures = await this.worktrees.rehydratePersistedOwners(managed)
    for (const failure of failures) {
      this.reportFailure(
        'managed-worktree-recovery',
        failure.ownerThreadId
          ? new Error(`Agent Thread ${failure.ownerThreadId}: ${failure.error.message}`, {
              cause: failure.error
            })
          : failure.error
      )
    }
  }

  private async repairInvalidSelectedThread(): Promise<void> {
    const state = this.store.read()
    const selectedThreadId = state.selectedThreadId
    if (selectedThreadId === null || readBartThread(state).id === selectedThreadId) return
    let valid = false
    try {
      const selected = readAgentThread(state, selectedThreadId)
      await this.validateAgentThreadWorkspace(
        selected,
        this.serviceController.signal
      )
      this.serviceController.signal.throwIfAborted()
      this.assertThreadWorkspaceSourceCurrent(selected)
      valid = true
    } catch (error) {
      this.serviceController.signal.throwIfAborted()
      this.reportFailure('selected-thread-workspace', error)
    }
    if (!valid) {
      await this.store.commit({ type: 'select-thread', threadId: null })
    }
  }

  private startStartupRecovery(): void {
    if (this.startupRecovery || this.shuttingDown || this.clearingHistory) return
    const bartRecoveryEpoch = this.startupBartRecoveryEpoch
    const span = withDebugContext(
      ensureDebugContext({}),
      () => startDebugSpan('service.startup.recovery', {})
    )
    const agentRecovery = withDebugContext(span.context, () =>
      this.openPersistedAgentThreads()
    )
    let bartRecovery: Promise<HarnessThreadInstanceView>
    try {
      // Invoke synchronously so bartOpening is the explicit ownership token
      // before initialize returns; only its settlement remains in background.
      bartRecovery = withDebugContext(span.context, () => this.ensureBartThread())
    } catch (error) {
      bartRecovery = Promise.reject(error)
    }
    const recovery = Promise.allSettled([
      agentRecovery,
      bartRecovery
    ]).then(results => {
      if (this.shuttingDown || this.clearingHistory) {
        span.end({ outcome: 'cancelled' })
        return
      }
      const [agentRecovery, bartRecovery] = results
      if (agentRecovery.status === 'rejected') {
        this.reportFailure('agent-recovery', agentRecovery.reason)
      }
      if (
        bartRecovery.status === 'rejected' &&
        this.startupBartRecoveryEpoch === bartRecoveryEpoch
      ) {
        this.reportFailure('bart-recovery', bartRecovery.reason)
      }
      span.end({
        agent: agentRecovery.status,
        bart: bartRecovery.status
      })
    }, error => {
      debugError('service.startup.recovery.failed', error)
      span.fail(error)
      throw error
    })
    this.startupRecovery = recovery
    void recovery.finally(() => {
      if (this.startupRecovery === recovery) this.startupRecovery = undefined
    }).catch(() => undefined)
  }

  private async drainStartupRecovery(): Promise<void> {
    await this.startupRecovery
  }

  private async joinRevokedBartOpening(
    opening: Promise<HarnessThreadInstanceView> | undefined
  ): Promise<void> {
    if (!opening) return
    try {
      await opening
    } catch (error) {
      if (error instanceof BartOpeningCleanupError) throw error.cleanupError
      if (error instanceof HarnessThreadOpeningCleanupError) {
        throw error.cleanupError
      }
      // Cancellation/open failure is expected after ownership revocation. A
      // cleanup AggregateError is not: preserve it for the caller.
      if (error instanceof AggregateError) throw error
    }
  }

  private onAgentCommitted(change: HarnessThreadCommitted): void {
    this.publishHarnessCommit(change)
    if (!this.initialized) return
    if (this.threadLifecycle.isDeleting(change.record.id)) return
    const execution = change.observation.latestExecution
    if (
      change.executionChanged &&
      execution && isTerminalPublicExecution(execution) &&
      !this.shuttingDown &&
      !this.clearingHistory
    ) {
      // Freeze the public projection at the commit boundary. Terminal delivery
      // is intentionally serialized and can run after a later Execution starts;
      // reading the aggregate from inside that queue would then mislabel the
      // earlier terminal event with the later Execution's observation.
      const threadId = change.record.id
      const event = publicThreadEnvelope(change.record)
      const suggestReport = execution.status === 'completed' &&
        change.observation.backgroundWork === null
      void this.terminalEvents.run(() =>
        this.deliverAgentTerminal(threadId, event, suggestReport)
      ).catch(error => this.reportFailure('terminal-event', error))
      return
    }
    if (
      !this.shuttingDown &&
      !this.clearingHistory &&
      this.store.read().settings.bart.autoIntervention
    ) {
      this.autoIntervention.request(change.record.id)
    }
  }

  private onBartCommitted(change: HarnessThreadCommitted): void {
    const execution = change.observation.latestExecution
    const executionContext = execution
      ? ensureDebugContext({
          threadId: change.record.id,
          harnessId: change.record.harnessId,
          executionId: execution.executionId
        })
      : ensureDebugContext({
          threadId: change.record.id,
          harnessId: change.record.harnessId
        })
    if (change.executionChanged && execution && !isTerminalPublicExecution(execution)) {
      for (const [executionId, scope] of this.bartExecutionScopes) {
        if (executionId === execution.executionId && scope.threadId === change.record.id) {
          continue
        }
        scope.controller.abort(new Error('Bart Execution scope replaced'))
        this.bartExecutionScopes.delete(executionId)
      }
      if (!this.bartExecutionScopes.has(execution.executionId)) {
        this.bartExecutionScopes.set(execution.executionId, {
          threadId: change.record.id,
          controller: new AbortController(),
          debugContext: executionContext
        })
      }
    } else if (change.executionChanged && execution && isTerminalPublicExecution(execution)) {
      const scope = this.bartExecutionScopes.get(execution.executionId)
      scope?.controller.abort(
        new Error(`Bart Execution ${execution.status}`)
      )
      this.bartExecutionScopes.delete(execution.executionId)
      withDebugContext(scope?.debugContext ?? executionContext, () => debugLog(
        'bart.execution.terminal',
        {
          threadId: change.record.id,
          harnessId: change.record.harnessId,
          executionId: execution.executionId,
          status: execution.status,
          startedAt: execution.startedAt,
          finishedAt: 'finishedAt' in execution ? execution.finishedAt : undefined,
          summary: execution.summary
        }
      ))
      void this.terminalEvents.run(async () => {
        const current = readBartThread(this.store.read())
        if (current.id !== change.record.id) return
        await this.store.commit({
          type: 'finish-bart-execution',
          threadId: current.id,
          executionId: execution.executionId,
          outcome: execution.status,
          updatedAt: this.boundaryTimestamp(current.updatedAt)
        })
        this.publisher.publish()
      }).catch(error => this.reportFailure('bart-tool-settlement', error))
    }
    this.publishHarnessCommit(change)
  }

  private async deliverAgentTerminal(
    threadId: string,
    event: JsonObject,
    suggestReport: boolean
  ): Promise<void> {
    if (this.shuttingDown || this.clearingHistory) return
    await this.bartCommands.run(async () => {
      if (this.shuttingDown || this.clearingHistory) return
      if (this.threadLifecycle.isDeleting(threadId)) return
      const current = this.store.read().threads.find(item => item.id === threadId)
      if (!current || !isAgentThreadRecord(current)) return
      // The terminal observation is already the exact public projection
      // committed by the Plugin. Bart receives no Harness-specific payload.
      await this.sendBartInput({
        presentation: 'internal',
        parts: [{
          kind: 'text',
          text: [
            `OpenAgent Agent Thread terminal event:\n${JSON.stringify(event)}`,
            ...(suggestReport ? [
              '请结合当前任务阶段和完整协调上下文，自行判断是否需要创建 Report Thread；已有对应报告则按需更新，避免重复创建。不要仅因本次 Execution 结束就认定用户任务已完成。'
            ] : [])
          ].join('\n\n')
        }]
      }, true)
    })
  }

  private completePrompt(
    harnessId: string,
    request: HarnessPromptCompleteRequest<never>,
    sourceThread?: DeepReadonly<AgentThreadRecord>
  ): Promise<HarnessPromptCompleteResult> {
    const settings = this.store.read().settings
    return runServiceDebugSpan(
      'service.prompt.complete',
      {
        harnessId,
        threadId: sourceThread?.id,
        messageCount: request.messages.length,
        outputFormat: request.outputFormat
      },
      () => this.main[harnessId].completePrompt(settings, request, sourceThread),
      {
        harnessId,
        threadId: sourceThread?.id
      }
    )
  }

  private async applyThreadSettingsUpdate(
    request: UpdateThreadSettingsRequest,
    current: DeepReadonly<AgentThreadRecord>,
    signal: AbortSignal
  ): Promise<JsonValue> {
    const settings = this.store.read().settings
    return this.main[request.harnessId].applyThreadSettingsUpdate({
      settings,
      current,
      change: request.change,
      signal
    })
  }

  private async resolveBartHost(
    settings: OpenAgentSettings,
    signal: AbortSignal,
    currentHost?: string
  ): Promise<HarnessId> {
    signal.throwIfAborted()
    const preference = settings.bart.hostHarnessPreference
    if (preference !== 'auto' && !canHostBart(this.main[preference].threadCapabilities)) {
      throw new Error(`${harnessDescriptors[preference].displayName} 不支持 Bart Host`)
    }
    const candidates = preference === 'auto'
      ? [...new Set([...(currentHost ? [currentHost] : []), ...HARNESS_IDS])]
          .filter((id): id is HarnessId => isHarnessId(id) && canHostBart(this.main[id].threadCapabilities))
      : [preference]
    const failures: string[] = []
    for (const harnessId of candidates) {
      const availability = await this.harnessAvailability(harnessId, settings, signal)
      if (availability.available) return harnessId
      failures.push(
        `${harnessDescriptors[harnessId].displayName}: ${availability.reason || 'unavailable'}`
      )
    }
    if (preference !== 'auto') {
      throw new Error(`Bart Host Harness 不可用（${failures[0]}）`)
    }
    throw new Error(`Bart 没有可用的 Host Harness（${failures.join('；')}）`)
  }

  private async harnessAvailability(
    harnessId: string,
    settings: OpenAgentSettings,
    signal: AbortSignal
  ): Promise<HarnessAvailability> {
    const span = withDebugContext(
      ensureDebugContext({ harnessId }),
      () => startDebugSpan('harness.availability', {
        harnessId,
        cwd: this.paths.defaultCwd
      })
    )
    try {
      const cwd = await this.validateRuntimeCwd()
      signal.throwIfAborted()
      const result = await withDebugContext(span.context, () =>
        this.trackCompositionOperation(() =>
          this.main[harnessId].availability(settings, cwd, signal)
        )
      )
      span.end({ available: result.available, reason: result.reason })
      return result
    } catch (error) {
      if (signal.aborted) {
        span.fail(error, { harnessId })
        signal.throwIfAborted()
      }
      const reason = errorMessage(error)
      span.end({ available: false, reason })
      return { available: false, reason }
    }
  }

  private normalizeSettings(settings: OpenAgentSettings): OpenAgentSettings {
    settings = parseOpenAgentSettings(settings)
    if (settings.bart.targetHarnessIds.length === 0) {
      throw new Error('OpenAgent Bart 至少需要一个 Target Harness')
    }
    const normalized = HARNESS_IDS.reduce(
      (current, harnessId) => this.main[harnessId].normalizeSettings(current),
      structuredClone(settings)
    )
    if (!isJsonValue(normalized)) throw new Error('OpenAgent settings 必须是 JSON')
    return normalized
  }

  private async replaceBartThread(
    settings: OpenAgentSettings,
    resolvedHostHarnessId?: HarnessId,
    signal = this.serviceController.signal
  ): Promise<void> {
    const current = readBartThread(this.store.read())
    const hostHarnessId = resolvedHostHarnessId ?? await waitForAbortable(this.resolveBartHost(
      settings,
      signal,
      current.harnessId
    ), signal)
    signal.throwIfAborted()
    const threadSettings = await waitForAbortable(this.main[hostHarnessId].resolveThreadSettings({
      settings,
      cwd: this.paths.bartCwd,
      signal
    }), signal)
    signal.throwIfAborted()
    const pendingBartOpening = this.bartOpening
    this.bartOpening = undefined
    this.startupBartRecoveryEpoch += 1
    this.bartUseCaseController.abort(new Error('Bart Thread replaced'))
    this.autoIntervention.cancel(new Error('Bart Thread replaced'))
    this.bartThreadController?.abort(new Error('Bart Thread replaced'))
    this.bartThreadController = undefined
    this.abortBartExecutionScopes(new Error('Bart Thread replaced'))
    try {
      await this.joinRevokedBartOpening(pendingBartOpening)
      await this.drainActiveBartToolExecutions()
      if (this.bartInstance?.execution) {
        await this.bartInstance.interrupt().catch(() => undefined)
      }
      await this.bartInstance?.dispose().catch(() => undefined)
      this.bartInstance = undefined
      this.bartInstanceThreadId = undefined
      this.bartThreadCreation = undefined
      signal.throwIfAborted()
      await this.store.commit({
        type: 'replace-bart-thread',
        expectedThreadId: current.id,
        threadId: this.createId(),
        hostHarnessId,
        settings,
        threadSettings,
        cwd: this.paths.bartCwd,
        createdAt: this.boundaryTimestamp()
      }, () => signal.throwIfAborted())
      await this.attachments.releaseOwner(current.id)
        .catch(error => this.reportFailure('attachment-owner-reset', error))
      this.publisher.publish()
    } finally {
      this.bartUseCaseController = new AbortController()
      this.autoIntervention.renewAuthority()
      this.autoIntervention.invalidateDecisions()
      this.autoIntervention.requestActive()
    }
  }

  private async applySavedBartSettings(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const current = readBartThread(this.store.read())
    const execution = current.observation.latestExecution
    // Follow-ups and native background work retain their owning Handle and
    // configuration. Apply pending preferences only at an idle admission.
    if (this.bartInstance?.execution || current.observation.backgroundWork !== null ||
        (execution && !isTerminalPublicExecution(execution))) return
    const { settings, bartAppliedSettings: applied } = this.store.read()
    if (applied && sameBartRuntimeSettings(applied, settings)) return
    const host = !applied || applied.bart.hostHarnessPreference !== settings.bart.hostHarnessPreference ||
      settings.bart.hostHarnessPreference === 'auto'
      ? await waitForAbortable(this.resolveBartHost(settings, signal, current.harnessId), signal)
      : current.harnessId as HarnessId
    signal.throwIfAborted()
    if (host !== current.harnessId) {
      await this.replaceBartThread(settings, host, signal)
      this.replaceBartRunContextScope()
      return
    }
    // Target/tool/context changes do not alter the Host's native settings.
    const resolveHostSettings = !applied ||
      !sameJson(applied.harnesses[host], settings.harnesses[host])
    try {
      await this.recycleBartThread(settings, resolveHostSettings, signal)
      this.replaceBartRunContextScope()
    } finally {
      if (this.bartUseCaseController.signal.aborted) {
        this.bartUseCaseController = new AbortController()
        this.autoIntervention.renewAuthority()
        this.autoIntervention.invalidateDecisions()
        this.autoIntervention.requestActive()
      }
    }
  }

  private async recycleBartThread(
    settings: OpenAgentSettings,
    resolveHostSettings: boolean,
    signal: AbortSignal
  ): Promise<void> {
    let current = readBartThread(this.store.read())
    const resolve = () => resolveHostSettings
      ? this.main[current.harnessId].resolveThreadSettings({
          settings,
          cwd: this.paths.bartCwd,
          signal,
          current
        })
      : Promise.resolve(jsonValue(current.settings))
    // Resolve and atomically commit against current Thread facts before revoking
    // anything. The Bart queue prevents another send until disposal completes;
    // recovery after a crash opens from these durable settings. Even a failed
    // conflict retry or persistence write must leave the old Handle intact.
    for (;;) {
      const threadSettings = await waitForAbortable(resolve(), signal)
      signal.throwIfAborted()
      try {
        await this.commit({
          type: 'replace-thread-settings',
          threadId: current.id,
          expectedRevision: current.revision,
          settings: threadSettings,
          bartAppliedSettings: settings,
          updatedAt: this.boundaryTimestamp(current.updatedAt)
        }, undefined, () => signal.throwIfAborted())
        break
      } catch (error) {
        const latest = readBartThread(this.store.read())
        if (!isRevisionConflict(error) || latest.id !== current.id ||
            latest.revision === current.revision) throw error
        current = latest
      }
    }
    const pendingBartOpening = this.bartOpening
    this.bartOpening = undefined
    this.startupBartRecoveryEpoch += 1
    this.bartUseCaseController.abort(
      new Error('Bart Thread composition changed')
    )
    this.autoIntervention.cancel(
      new Error('Bart Thread composition changed')
    )
    this.bartThreadController?.abort(new Error('Bart Thread composition changed'))
    this.bartThreadController = undefined
    this.abortBartExecutionScopes(new Error('Bart Thread composition changed'))
    const previousInstance = this.bartInstance
    this.bartInstance = undefined
    this.bartInstanceThreadId = undefined
    this.bartThreadCreation = undefined
    try {
      await this.joinRevokedBartOpening(pendingBartOpening)
      await this.drainActiveBartToolExecutions()
    } finally {
      if (previousInstance?.execution) {
        await previousInstance.interrupt().catch(() => undefined)
      }
      await previousInstance?.dispose().catch(() => undefined)
    }
  }

  private async recordBartToolTranscript(
    threadId: string,
    mutation: BartTranscriptMutation
  ): Promise<void> {
    const current = readBartThread(this.store.read())
    if (current.id !== threadId) throw new Error(`Bart Thread 已替换: ${threadId}`)
    if (mutation.type === 'append-tool-call') {
      await this.store.commit({
        type: 'append-bart-transcript-item',
        threadId,
        item: mutation.operation,
        updatedAt: this.boundaryTimestamp(current.updatedAt, mutation.operation.createdAt)
      })
      this.publisher.publish()
      return
    }
    if (mutation.type === 'complete-tool-result') {
      const latest = readBartThread(this.store.read())
      await this.store.commit({
        type: 'complete-bart-tool-operation',
        threadId,
        executionId: mutation.executionId,
        callId: mutation.callId,
        result: mutation.result,
        ...(mutation.isError ? { isError: true } : {}),
        completedAt: mutation.completedAt,
        updatedAt: this.boundaryTimestamp(latest.updatedAt, mutation.completedAt)
      })
      this.publisher.publish()
      return
    }
    throw new Error(`Core tool transcript 不接受 mutation: ${mutation.type}`)
  }

  private async appendBartMessage(message: BartMessage): Promise<void> {
    const bart = readBartThread(this.store.read())
    await this.store.commit({
      type: 'append-bart-transcript-item',
      threadId: bart.id,
      item: message,
      updatedAt: this.boundaryTimestamp(message.createdAt, bart.updatedAt)
    })
    this.publisher.publish()
  }

  private appendBartLocalSystemMessage(content: string): Promise<void> {
    const bart = readBartThread(this.store.read())
    return this.appendBartMessage({
      type: 'message',
      id: this.createId(),
      role: 'assistant',
      content,
      createdAt: this.boundaryTimestamp(bart.updatedAt),
      status: 'complete',
      systemEvent: true
    })
  }

  private assertBartIdleForClear(): void {
    const observation = readBartThread(this.store.read()).observation
    const execution = observation.latestExecution
    if (
      this.pendingBartUserAdmissions > 0 ||
      this.bartInstance?.execution ||
      observation.backgroundWork !== null ||
      (execution !== null && !isTerminalPublicExecution(execution))
    ) {
      throw new Error('Bart 正在运行，停止后才能清空 session')
    }
  }

  private publishHarnessCommit(change: HarnessThreadCommitted): void {
    if (!this.initialized || this.shuttingDown || this.clearingHistory) return
    this.publisher.threadCommitted(change)
  }

  private async commit(
    mutation: OpenAgentStateMutation,
    effect?: RendererStateMutation['effect'],
    assertCurrent?: (state: OpenAgentState) => void
  ): Promise<OpenAgentState> {
    const state = await this.store.commit(mutation, assertCurrent)
    this.publisher.publish(effect)
    return state
  }

  private agentRecords(): DeepReadonly<AgentThreadRecord>[] {
    return this.store.read().threads.filter(isAgentThreadRecord)
  }

  private assertAllowedTarget(harnessId: HarnessId): void {
    if (!this.store.read().settings.bart.targetHarnessIds.includes(harnessId)) {
      throw new Error(`Bart Target Harness 未启用: ${harnessId}`)
    }
  }

  private async validateCwd(cwd: string): Promise<string> {
    if (!isAbsolute(cwd) || cwd.includes('\0')) throw new Error('cwd 必须是绝对目录')
    const canonical = await realpath(cwd).catch(error => {
      throw new Error(`cwd 不可访问: ${cwd}`, { cause: error })
    })
    if (!(await stat(canonical)).isDirectory()) throw new Error(`cwd 不是目录: ${cwd}`)
    const bartCwd = await realpath(this.paths.bartCwd).catch(() =>
      resolvePath(this.paths.bartCwd)
    )
    const fromBart = relative(bartCwd, canonical)
    if (
      fromBart === '' ||
      fromBart !== '..' && !fromBart.startsWith(`..${sep}`) && !isAbsolute(fromBart)
    ) {
      throw new Error('Agent Thread 不能使用 Bart workspace')
    }
    return canonical
  }

  private async validateRuntimeCwd(): Promise<string> {
    const canonical = await this.validateCwd(this.paths.defaultCwd)
    if (canonical !== this.paths.defaultCwd) {
      throw new Error('Global settings defaultCwd identity 已变化')
    }
    return canonical
  }

  private assertThreadForkable(
    source: DeepReadonly<AgentThreadRecord>
  ): void {
    const execution = source.observation.latestExecution
    if (execution && !isTerminalPublicExecution(execution)) {
      throw new Error('active Execution 期间不能 fork Thread')
    }
    if (source.observation.backgroundWork !== null) {
      throw new Error('存在后台任务时不能 fork Thread')
    }
    if (this.agentInstances.get(source.id)?.execution) {
      throw new Error('active Execution 期间不能 fork Thread')
    }
    if ((this.agentSendClaims.get(source.id)?.size ?? 0) > 0) {
      throw new Error('Thread send pending 期间不能 fork')
    }
    if (this.threadLifecycle.isDeleting(source.id)) {
      throw new Error(`Agent Thread 正在删除: ${source.id}`)
    }
  }

  private async reserveAgentFork(
    threadId: string,
    signal: AbortSignal
  ): Promise<ReturnType<HarnessThreadInstanceView['reserveFork']>> {
    const instance = this.agentInstances.get(threadId) ?? await waitForAbortable(
      this.agentInstance(threadId, true),
      signal
    )
    signal.throwIfAborted()
    if (this.agentInstances.get(threadId) !== instance) {
      throw new Error(`Agent Thread ownership 已失效: ${threadId}`)
    }
    return instance.reserveFork()
  }

  private async validateForkSourceWorkspace(
    source: DeepReadonly<AgentThreadRecord>,
    signal: AbortSignal,
    expected?: ManagedWorktreeValidation
  ): Promise<ManagedWorktreeValidation | undefined> {
    const cwd = await this.validateCwd(source.cwd)
    signal.throwIfAborted()
    if (cwd !== source.cwd) {
      throw new Error('源 Thread cwd identity 已变化')
    }
    if (!source.worktree) return undefined
    if (source.worktree.native) {
      throw new Error('Core 不接受 native worktree 的 Thread fork')
    }
    const validation = await this.worktrees.validateManagedWorktree({
      ownerThreadId: source.id,
      worktree: source.worktree,
      ...(expected
        ? {
            expectedHeadOid: expected.headOid,
            expectedCwd: expected.cwd,
            expectedRepositoryIdentity: expected.repositoryIdentity
          }
        : {}),
      signal
    })
    signal.throwIfAborted()
    if (validation.cwd !== source.worktree.cwd) {
      throw new Error('源 Thread worktree identity 已变化')
    }
    if (expected && (
      validation.headOid !== expected.headOid ||
      validation.cwd !== expected.cwd ||
      validation.repositoryIdentity !== expected.repositoryIdentity
    )) {
      throw new Error('源 Thread worktree validation facts 已变化')
    }
    return validation
  }

  private async validateThreadSettingsPresentationWorkspace(
    source: DeepReadonly<AgentThreadRecord>,
    signal: AbortSignal,
    expected?: ThreadSettingsPresentationWorkspace
  ): Promise<ThreadSettingsPresentationWorkspace> {
    // Catalog presentation is read/discovery-only, so Core exposes no writable
    // grant. A managed linked worktree still has to prove ownership, repository
    // identity, HEAD, and cwd before its canonical cwd crosses into the Plugin.
    if (source.worktree && !source.worktree.native) {
      const validation = await this.worktrees.validateManagedWorktree({
        ownerThreadId: source.id,
        worktree: source.worktree,
        ...(expected?.managed
          ? {
              expectedHeadOid: expected.managed.headOid,
              expectedCwd: expected.managed.cwd,
              expectedRepositoryIdentity: expected.managed.repositoryIdentity
            }
          : {}),
        signal
      })
      signal.throwIfAborted()
      if (validation.cwd !== source.worktree.cwd) {
        throw new Error('Thread settings presentation worktree identity 已变化')
      }
      if (expected && (
        !expected.managed ||
        validation.cwd !== expected.cwd ||
        validation.headOid !== expected.managed.headOid ||
        validation.repositoryIdentity !== expected.managed.repositoryIdentity
      )) {
        throw new Error('Thread settings presentation worktree facts 已变化')
      }
      return { cwd: validation.cwd, managed: validation }
    }

    const persistedCwd = source.worktree?.cwd || source.cwd
    const cwd = await this.validateCwd(persistedCwd)
    signal.throwIfAborted()
    if (cwd !== persistedCwd) {
      throw new Error('Thread settings presentation cwd identity 已变化')
    }
    if (expected && expected.cwd !== cwd) {
      throw new Error('Thread settings presentation cwd identity 已变化')
    }
    return { cwd }
  }

  private assertThreadSettingsPresentationSourceCurrent(
    source: DeepReadonly<AgentThreadRecord>
  ): void {
    const current = readAgentThread(this.store.read(), source.id)
    if (threadSettingsSourceFingerprint(current) !== threadSettingsSourceFingerprint(source)) {
      throw new Error(`Thread settings presentation 期间发生变化: ${source.id}`)
    }
  }

  private async ensureTemporaryWorkspaceRoot(): Promise<string> {
    await mkdir(this.paths.temporaryWorkspaceRoot, { recursive: true })
    return this.paths.temporaryWorkspaceRoot
  }

  private async createTemporaryWorkspace(): Promise<string> {
    return mkdtemp(join(await this.ensureTemporaryWorkspaceRoot(), 'thread-'))
  }

  private seedBoundaryTimestamp(state: OpenAgentState): void {
    this.lastBoundaryTimestamp = Math.max(
      Date.now(),
      ...state.threads.map(thread => thread.updatedAt),
      ...state.reports.map(report => report.updatedAt),
      0
    )
  }

  private boundaryTimestamp(...floors: number[]): number {
    const value = Math.max(Date.now(), this.lastBoundaryTimestamp, ...floors)
    if (!Number.isFinite(value) || value < 0) throw new Error('系统时间无效')
    this.lastBoundaryTimestamp = value
    return value
  }

  private wallClockTimestamp(): number {
    const value = Date.now()
    if (!Number.isFinite(value) || value < 0) throw new Error('系统时间无效')
    return value
  }

  private createId(): string {
    return randomUUID()
  }

  private abortBartExecutionScopes(reason: Error): void {
    for (const scope of this.bartExecutionScopes.values()) scope.controller.abort(reason)
    this.bartExecutionScopes.clear()
  }

  private trackBartToolExecution<Result>(
    operation: () => Promise<Result>
  ): Promise<Result> {
    const result = Promise.resolve().then(operation)
    let marker!: Promise<void>
    marker = result.then(
      () => { this.activeBartToolExecutions.delete(marker) },
      () => { this.activeBartToolExecutions.delete(marker) }
    )
    this.activeBartToolExecutions.add(marker)
    return result
  }

  private trackCompositionOperation<Result>(
    operation: () => Promise<Result>
  ): Promise<Result> {
    const result = Promise.resolve().then(operation)
    let marker!: Promise<void>
    marker = result.then(
      () => { this.activeCompositionOperations.delete(marker) },
      () => { this.activeCompositionOperations.delete(marker) }
    )
    this.activeCompositionOperations.add(marker)
    return result
  }

  private async drainCompositionOperations(): Promise<void> {
    while (this.activeCompositionOperations.size) {
      await Promise.all([...this.activeCompositionOperations])
    }
  }

  private async drainActiveBartToolExecutions(): Promise<void> {
    while (this.activeBartToolExecutions.size) {
      await Promise.all([...this.activeBartToolExecutions])
    }
  }

  private async drainBackgroundRuns(): Promise<void> {
    await Promise.allSettled([
      this.metadata.drainRuns(),
      this.autoIntervention.drain()
    ])
  }

  private reportFailure(kind: string, error: unknown): void {
    console.error(`OpenAgent ${kind} failure`, error)
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('OpenAgent Service 尚未初始化')
  }

  private assertOperational(): void {
    this.assertInitialized()
    if (this.shuttingDown) throw new Error('OpenAgent Service 正在关闭')
    if (this.clearingHistory) throw new Error('OpenAgent history 正在清空')
  }
}

function jsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw new Error('Harness 返回了非 JSON value')
  return structuredClone(value)
}

function textInput(text: string): AgentInput {
  return { parts: [{ kind: 'text', text: requiredText(text, 'prompt') }] }
}

function inputAttachments(input: AgentInput): NonNullable<BartMessage['attachments']> {
  return input.parts.flatMap(part => {
    if (part.kind !== 'local-file' && part.kind !== 'image' && part.kind !== 'audio') return []
    return [{
      id: part.file.id,
      path: part.file.path,
      name: part.file.name,
      mimeType: part.file.mimeType,
      size: part.file.size,
      kind: part.kind === 'image'
        ? 'image' as const
        : part.file.mimeType === 'application/pdf' || part.file.mimeType.startsWith('text/')
          ? 'document' as const
          : 'file' as const
    }]
  })
}

function bartUserMessage(
  input: AgentInput,
  id: string
): Omit<BartMessage, 'createdAt'> {
  const attachments = inputAttachments(input)
  return {
    type: 'message',
    id,
    role: 'user',
    content: inputTextContent(input),
    status: 'complete',
    ...(attachments.length ? { attachments } : {})
  }
}

function inputTextContent(input: AgentInput): string {
  return input.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n')
}

function assertAgentInput(input: AgentInput): void {
  if (!input || !Array.isArray(input.parts) || input.parts.length < 1) {
    throw new Error('AgentInput 不能为空')
  }
  if (input.parts.length > 128) throw new Error('AgentInput parts 过多')
  for (const part of input.parts) assertInputPart(part)
}

function assertInputPart(part: AgentInputPart): void {
  if (part.kind === 'text' && part.text.length > MAX_INPUT_TEXT) {
    throw new Error('AgentInput text 过长')
  }
}

function parseScheduleTimestamp(value: unknown): number {
  const text = typeof value === 'string' ? value : ''
  const match = text.length <= 40
    ? /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(text)
    : null
  if (!match) {
    throw new Error('executeAt 必须是带时区的 RFC 3339 时间')
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const daysInMonth = [
    31,
    year % 400 === 0 || year % 4 === 0 && year % 100 !== 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31
  ]
  if (day > daysInMonth[month - 1]) throw new Error('executeAt 无效')
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) throw new Error('executeAt 无效')
  return parsed
}

function requiredToolObject(value: JsonValue): JsonObject {
  if (!jsonObject(value)) throw new Error('tool arguments 必须是 object')
  return value
}

function toolString(value: JsonValue, key: string, max = 128): string {
  return requiredObjectString(requiredToolObject(value), key, max)
}

function requiredObjectString(value: JsonObject, key: string, max = 128): string {
  const candidate = value[key]
  if (typeof candidate !== 'string') throw new Error(`${key} 必须是字符串`)
  const normalized = candidate.trim()
  if (!normalized || normalized.length > max || normalized.includes('\0')) {
    throw new Error(`${key} 无效`)
  }
  return normalized
}

function requiredText(value: string, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  const normalized = value.trim()
  if (!normalized || [...normalized].length > MAX_INPUT_TEXT) {
    throw new Error(`${label} 不能为空或过长`)
  }
  return normalized
}

function assertIdentifier(value: string, label: string): void {
  if (!value || value.length > 128 || value.includes('\0') || /\s/.test(value)) {
    throw new Error(`${label} 无效`)
  }
}

function jsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && isJsonValue(value)
}

interface BartWorkspaceHint {
  readonly cwds: readonly string[]
  readonly truncated: boolean
}

const MAX_BART_WORKSPACE_HINT_CWDS = 8

function resolveBartWorkspaceHint(
  state: DeepReadonly<OpenAgentState>,
  rawDirectoryTag: string | undefined
): BartWorkspaceHint | undefined {
  if (rawDirectoryTag === undefined) return undefined
  if (
    typeof rawDirectoryTag !== 'string' ||
    rawDirectoryTag.length > 256 ||
    rawDirectoryTag.includes('\0')
  ) throw new Error('directoryTag 无效')
  const requestedTag = rawDirectoryTag.trim()
  if (!requestedTag) throw new Error('directoryTag 无效')

  const candidates = state.threads
    .filter(isAgentThreadRecord)
    .map((thread, index) => ({ thread, index }))
    .sort((left, right) =>
      right.thread.updatedAt - left.thread.updatedAt || left.index - right.index
    )
  const cwds: string[] = []
  const seen = new Set<string>()
  let truncated = false
  for (const { thread } of candidates) {
    const candidateTag = threadDirectoryTag(thread)
    if (!candidateTag || !sameThreadTag(candidateTag, requestedTag)) continue
    const cwd = threadWorkspaceCwd(thread)
    if (cwd && !seen.has(cwd)) {
      seen.add(cwd)
      if (cwds.length < MAX_BART_WORKSPACE_HINT_CWDS) cwds.push(cwd)
      else {
        truncated = true
        break
      }
    }
  }
  return cwds.length ? { cwds, truncated } : undefined
}

function withBartWorkspaceHint(
  entries: readonly CollectedBartContextEntry[],
  hint: BartWorkspaceHint | undefined
): readonly CollectedBartContextEntry[] {
  if (!hint) return entries
  const content = hint.cwds.length === 1
    ? `The user's entire request concerns work in the directory ${JSON.stringify(hint.cwds[0])}.`
    : `The user's entire request concerns work in ${hint.truncated ? 'these and other matching directories (partial list)' : 'these directories'}:\n${hint.cwds.map(cwd => `- ${JSON.stringify(cwd)}`).join('\n')}`
  const index = entries.findIndex((entry) => entry.id === 'workspace')
  if (index < 0) {
    return [...entries, { id: 'workspace' satisfies BartContextEntryId, content }]
  }
  return entries.map((entry, entryIndex) => entryIndex === index
    ? { ...entry, content: `${entry.content}\n\n${content}` }
    : entry)
}

function sameBartRuntimeSettings(a: OpenAgentSettings, b: OpenAgentSettings): boolean {
  return sameJson(a.harnesses, b.harnesses) &&
    a.bart.hostHarnessPreference === b.bart.hostHarnessPreference &&
    sameJson(a.bart.targetHarnessIds, b.bart.targetHarnessIds) &&
    a.bart.routingGuidance === b.bart.routingGuidance
}

function isTerminalPublicExecution(
  execution: PublicExecution
): execution is Extract<PublicExecution, {
  readonly status: 'completed' | 'failed' | 'interrupted'
}> {
  return execution.status === 'completed' || execution.status === 'failed' ||
    execution.status === 'interrupted'
}

function hasStaleBartRuntime(record: DeepReadonly<BartThreadRecord>): boolean {
  return record.transcript.some(item =>
    item.type === 'message'
      ? item.role === 'assistant' && item.status === 'streaming'
      : item.completedAt === undefined
  )
}

function waitForAbortable<Result>(
  operation: Promise<Result>,
  signal: AbortSignal
): Promise<Result> {
  try {
    signal.throwIfAborted()
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise<Result>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      result => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
