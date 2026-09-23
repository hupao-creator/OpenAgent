import type { HarnessBartActivity } from './renderer/bart-presentation.js'
import type { AgentInput } from './agent-core/inputs.js'
import type { JsonObject, JsonValue } from './agent-core/values.js'
import type { HarnessId } from './harness-descriptor.js'
import type { HarnessExtensionApi } from './harness-extension.js'
import type { BartTelemetryLedgerCapability } from './bart-telemetry.js'
import type { AgentWorktree } from './workspace.js'
import type { ManagedWorkspaceWriteCapability } from './workspace.js'

export type DeepReadonly<T> =
  T extends (...arguments_: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T

export interface HarnessThreadRecord<
  Id extends HarnessId = HarnessId,
  ThreadSettings = unknown
> {
  readonly id: string
  readonly harnessId: Id
  readonly revision: number
  /**
   * Opaque Plugin-owned durable data. The Host may clone, persist, and deliver
   * it to the matching Main/Renderer Plugin, but must never interpret it.
   */
  readonly sessionState: JsonValue
  /** The complete public observation understood by Core and Bart. */
  readonly observation: ThreadPublicObservation
  readonly title: string
  readonly titlePending?: true
  /** Page-header emoji from initial metadata; omitted while unavailable. */
  readonly emoji?: string
  readonly tags: readonly string[]
  readonly cwd: string
  readonly worktree?: AgentWorktree
  readonly settings: ThreadSettings
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AgentThreadRecord<
  Id extends HarnessId = HarnessId,
  ThreadSettings = unknown
> extends HarnessThreadRecord<Id, ThreadSettings> {
  readonly archived: boolean
  readonly bart?: never
}

export interface BartThreadRecord<
  Id extends HarnessId = HarnessId,
  ThreadSettings = unknown
> extends HarnessThreadRecord<Id, ThreadSettings> {
  readonly bart: true
  /** Core-owned orchestration audit used by overview choreography, not Thread rendering. */
  readonly transcript: readonly BartTranscriptItem[]
}

export type ThreadRecord = AgentThreadRecord | BartThreadRecord

export interface HarnessThreadRef<
  Id extends HarnessId = HarnessId,
  ThreadSettings = unknown
> {
  readonly id: string
  read(): DeepReadonly<HarnessThreadRecord<Id, ThreadSettings>>
}

export type {
  PublicInteractionAction, PublicInteractionOption, PublicInteractionQuestion,
  PublicInteraction, PublicExecution, PublicBackgroundWork, ThreadPublicObservation
} from './public-observation.js'
import type { PublicExecution, ThreadPublicObservation } from './public-observation.js'

/** Provider-neutral transport ceiling for optional native-interaction feedback. */
export const MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS = 10_000

export type { HarnessRespondRequest } from './public-response.js'
import type { HarnessRespondRequest } from './public-response.js'

export interface HarnessSessionStateStore {
  read(): DeepReadonly<JsonValue>
  /** Snapshot at invocation; Host projects and commits this exact version atomically. */
  commit(state: JsonValue): Promise<void>
}

/** Plugin-owned interpretation of the sole durable Session authority. */
export interface HarnessSessionStateAdapter {
  /**
   * Pure and deterministic: no runtime identity, previous observation or clock.
   * Fresh null state and never-started fork state project an empty observation.
   */
  project(state: DeepReadonly<JsonValue>): ThreadPublicObservation
  /** Pure owning-Harness lookup; only executions belonging to this Session resolve. */
  resolveExecution(state: DeepReadonly<JsonValue>, executionId: string): PublicExecution | null
  /**
   * Pure state transition for Core's existing failure/cleanup convergence.
   * Settle only the named nonterminal Execution; retain unrelated Session work.
   * The Host commits the returned state through the same projection transaction.
   */
  settle(input: {
    readonly sessionState: DeepReadonly<JsonValue>
    readonly executionId: string
    readonly outcome: 'failed' | 'interrupted'
    readonly finishedAt: number
  }): JsonValue
}

/**
 * One-shot Core authority for an unsolicited native unit of work to become a
 * public Execution. Native identifiers remain Plugin-private.
 */
export interface HarnessExecutionClaim {
  readonly executionId: string
  /** Idempotent before running is accepted; a consumed claim is unaffected. */
  abandon(): void
}

export interface HarnessExecutionClaims {
  /** Fails while another public Execution or claim owns the Thread. */
  claim(): HarnessExecutionClaim
}

/**
 * Thread-bound Core admission for work that originated outside a normal
 * Service `send`. The Plugin must first commit its private input/state and the
 * matching public running observation, then await this boundary before it
 * starts or resumes any native I/O for that Execution.
 */
export interface HarnessExecutionAdmission {
  /**
   * Accepts only the current Execution produced by this Thread's
   * `executionClaims`. Concurrent/repeated calls for one admitted Execution
   * are idempotent; a failed attempt may be retried while it remains current.
   */
  admit(executionId: string): Promise<void>
}

export interface HarnessThreadOpenContext<
  Id extends HarnessId = HarnessId,
  ThreadSettings = unknown
> {
  readonly thread: HarnessThreadRef<Id, ThreadSettings>
  /** Transient presentation events, emitted before durable snapshots coalesce. */
  readonly bartDisplay?: { publish(activity: HarnessBartActivity): void }
  /** Single durable publication path for commands and Plugin-owned native events. */
  readonly sessionState: HarnessSessionStateStore
  /** Core-owned identity capability for unsolicited/background wake work. */
  readonly executionClaims: HarnessExecutionClaims
  /** Core-owned durability and workspace boundary for claimed native work. */
  readonly executionAdmission: HarnessExecutionAdmission
  /** Core-owned, composition-scoped usage ledger; native facts stay Plugin-owned. */
  readonly telemetryLedger: BartTelemetryLedgerCapability
  /** Optional Core-validated, Thread-bound managed-workspace capability. */
  readonly managedWorkspaceWrite?: ManagedWorkspaceWriteCapability
  /** Generic native composition, installed before the first model request. */
  readonly injection?: HarnessThreadInjection
  readonly signal: AbortSignal
}

export interface HarnessThreadSendRequest {
  readonly executionId: string
  readonly input: AgentInput
  /** Per-execution context, available to every ordinary Thread. */
  readonly contextEntries?: readonly HarnessContextEntry[]
  readonly signal: AbortSignal
}

export interface HarnessThreadHandle {
  send(request: HarnessThreadSendRequest): Promise<void>
  interrupt(): Promise<void>
  respond(request: HarnessRespondRequest): Promise<void>
  read(question: string, signal: AbortSignal): Promise<string>
  dispose(): Promise<void>
}

export interface HarnessThreadForkRequest<
  Id extends HarnessId = HarnessId,
  ThreadSettings = unknown
> {
  readonly source: DeepReadonly<AgentThreadRecord<Id, ThreadSettings>>
  /** Opaque Plugin-owned fork selector, such as a native checkpoint ID. */
  readonly request: DeepReadonly<JsonValue>
  readonly signal: AbortSignal
}

export interface HarnessThreadForkResult<ThreadSettings = unknown> {
  /** Complete current Plugin state for the new, never-started Thread. */
  readonly sessionState: JsonValue
  /** Omission means Core copies the source's opaque Thread settings. */
  readonly settings?: ThreadSettings
  /** Optional provider-native title suggestion; Core owns final validation. */
  readonly title?: string
}

export type HarnessSessionSeedItem =
  | {
      readonly type: 'message'
      readonly role: 'user' | 'assistant'
      readonly content: string
    }
  | {
      readonly type: 'tool-call'
      readonly callId: string
      readonly name: string
      readonly arguments: JsonValue
    }
  | {
      readonly type: 'tool-result'
      readonly callId: string
      readonly result: JsonValue
      readonly isError?: boolean
    }

export interface HarnessToolBinding {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
  readonly outputSchema?: JsonObject
  execute(input: {
    readonly callId?: string
    readonly arguments: JsonValue
    readonly signal: AbortSignal
  }): Promise<JsonValue>
}

export type BartContextEntryId = 'workspace' | 'telemetry' | 'evaluation'

export interface HarnessContextEntry {
  readonly id: string
  readonly content: string
}

export type HarnessToolMode = 'extend' | 'exclusive'

export interface HarnessThreadInjection {
  readonly instructions?: readonly string[]
  readonly contextEntries?: readonly HarnessContextEntry[]
  readonly seed?: readonly HarnessSessionSeedItem[]
  readonly tools?: {
    readonly mode: HarnessToolMode
    readonly bindings: readonly HarnessToolBinding[]
  }
}

/** Plugin-owned contributor with concrete settings visible only at composition. */
export type HarnessBartContextContributor<HarnessSettings> = (input: {
  readonly settings: DeepReadonly<HarnessSettings>
  readonly cwd: string
  /** The same pre-scoped capability supplied to this Plugin's Thread handles. */
  readonly telemetryLedger: BartTelemetryLedgerCapability
  readonly signal: AbortSignal
}) => string | undefined | Promise<string | undefined>

export interface HarnessPromptMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export type HarnessPromptOutputFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_schema'; readonly schema: JsonObject }

export interface HarnessPromptCompleteRequest<PromptSettings> {
  readonly messages: readonly HarnessPromptMessage[]
  readonly outputFormat: HarnessPromptOutputFormat
  readonly settings?: PromptSettings
  readonly signal: AbortSignal
}

export interface HarnessPromptCompleteResult {
  readonly output:
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'json'; readonly value: JsonValue }
  readonly finishReason: 'stop' | 'length' | 'filtered' | 'other'
}

export interface HarnessPromptApi<PromptSettings> {
  complete(
    request: HarnessPromptCompleteRequest<PromptSettings>
  ): Promise<HarnessPromptCompleteResult>
}

/**
 * Provider-neutral proof that a Harness command is present in the normal
 * executable search path or official install location. This is a presence check only: it
 * says nothing about authentication, startup, or model availability.
 */
export type HarnessInstallation =
  | {
      readonly status: 'installed'
      readonly executablePath: string
    }
  | {
      readonly status: 'missing'
    }

/** A resolver can use this typed failure without making Plugins parse errors. */
export class HarnessExecutableNotFoundError extends Error {
  readonly command: string

  constructor(command: string) {
    super('未找到 ' + command + '。请先安装 CLI。')
    this.name = 'HarnessExecutableNotFoundError'
    this.command = command
  }
}

export interface HarnessSettingsApi<
  HarnessSettings,
  ThreadSettings,
  ThreadSettingsRequest,
  ThreadSettingsUpdate,
  PromptSettings
> {
  normalizeHarnessSettings(settings: HarnessSettings): HarnessSettings
  /** Creation request schema. May expose Harness-owned presets instead of raw native settings. */
  describe(input: {
    readonly settings: DeepReadonly<HarnessSettings>
    readonly cwd: string
    readonly signal: AbortSignal
  }): Promise<JsonObject>
  /** Generic Thread defaults, shared by GUI creation and Core composition. */
  defaultThreadSettings(
    settings: DeepReadonly<HarnessSettings>
  ): ThreadSettings
  resolveThreadSettings(input: {
    readonly merged: DeepReadonly<ThreadSettings>
    readonly existing?: DeepReadonly<ThreadSettings>
    readonly requested?: DeepReadonly<ThreadSettingsRequest>
    /** Opaque data; only the Plugin may inspect it. */
    readonly sessionState: DeepReadonly<JsonValue>
    readonly cwd: string
    readonly signal: AbortSignal
  }): Promise<ThreadSettings>
  /**
   * Pure synchronous query owned by the Plugin. An allocated empty state envelope
   * is not content. Return whether native session/history facts constrain settings;
   * changes to streaming text alone must leave this fact stable. Core only compares
   * the result, including at the Thread-scoped settings commit boundary.
   */
  hasThreadContent(sessionState: DeepReadonly<JsonValue>): boolean
  applyThreadSettingsUpdate(input: {
    readonly current: DeepReadonly<ThreadSettings>
    readonly defaults: DeepReadonly<ThreadSettings>
    readonly update: DeepReadonly<ThreadSettingsUpdate>
    /** Stable content-presence fact; streaming history is outside settings resolution. */
    readonly hasContent: boolean
    readonly cwd: string
    readonly signal: AbortSignal
  }): Promise<ThreadSettings>
  promptSettings(
    settings: DeepReadonly<HarnessSettings>,
    /** Isolated metadata prompts retain the source Thread's native model and executable. */
    sourceThreadSettings?: DeepReadonly<ThreadSettings>
  ): PromptSettings
}

export interface HarnessSettingsPresentationSource<
  HarnessSettings,
  SettingsPresentationData
> {
  load(input: {
    readonly settings: DeepReadonly<HarnessSettings>
    /** Core-validated, provider-neutral workspace used for catalog discovery. */
    readonly cwd: string
    /**
     * Opaque current Thread facts supplied only for a Thread-scoped request.
     * Core never reads the settings payload and never supplies sessionState.
     */
    readonly thread?: {
      readonly settings: DeepReadonly<JsonValue>
    }
    /**
     * The reader asked for this refresh rather than the page opening again, so
     * a cached answer must not be replayed at them.
     */
    readonly refresh?: boolean
    readonly signal: AbortSignal
  }): Promise<SettingsPresentationData>
}

export interface HarnessMainPlugin<
  Id extends HarnessId,
  HarnessSettings,
  ThreadSettings,
  ThreadSettingsRequest,
  ThreadSettingsUpdate,
  PromptSettings,
  SettingsPresentationData
> {
  readonly sessionState: HarnessSessionStateAdapter
  /** Read native local workspace metadata without importing sessions or executing work. */
  discoverWorkspaceDirectories?(input: { readonly signal: AbortSignal }): Promise<readonly string[]>
  /**
   * Detect whether the standard command is installed in PATH or its native install location. Custom
   * settings paths and native process/model probing do not participate.
   */
  detectInstallation(input: {
    readonly cwd: string
    readonly signal: AbortSignal
  }): Promise<HarnessInstallation>
  /** Install the standard CLI using this Plugin's official installer. */
  install?(input: { readonly signal: AbortSignal }): Promise<void>
  openThread(
    context: HarnessThreadOpenContext<Id, ThreadSettings>
  ): Promise<HarnessThreadHandle>
  readonly prompt: HarnessPromptApi<PromptSettings>
  readonly settings: HarnessSettingsApi<
    HarnessSettings,
    ThreadSettings,
    ThreadSettingsRequest,
    ThreadSettingsUpdate,
    PromptSettings
  >
  readonly settingsPresentation: HarnessSettingsPresentationSource<
    HarnessSettings,
    SettingsPresentationData
  >
  /**
   * Plugin-owned derivation; may fork a native session without starting work or
   * modifying the source. Core alone creates the target OpenAgent Thread.
   */
  forkThread?(
    input: HarnessThreadForkRequest<Id, ThreadSettings>
  ): Promise<HarnessThreadForkResult<ThreadSettings>>
  /** Optional provider-owned context mapped to generic Bart entry slots. */
  readonly bartContextEntries?: Partial<
    Record<BartContextEntryId, HarnessBartContextContributor<HarnessSettings>>
  >
  /** Release process-wide Plugin resources after every operation/Thread drains. */
  dispose?(): void | Promise<void>
  /** Optional opaque control plane owned and interpreted only by this Plugin. */
  readonly extension?: HarnessExtensionApi
}

export type BartContextContributor = (input: {
  readonly signal: AbortSignal
}) => string | undefined | Promise<string | undefined>

export interface BartMessage {
  readonly type: 'message'
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly createdAt: number
  readonly status: 'complete' | 'streaming' | 'cancelled' | 'failed'
  readonly executionId?: string
  readonly reasoning?: string
  readonly statusLabel?: string
  readonly error?: string
  readonly attachments?: readonly {
    readonly id: string
    readonly path: string
    readonly name: string
    readonly mimeType: string
    readonly size: number
    readonly kind: 'image' | 'document' | 'file'
  }[]
  readonly systemEvent?: true
}

export interface BartToolOperation {
  readonly type: 'tool-operation'
  readonly id: string
  readonly executionId: string
  readonly callId: string
  readonly name: string
  readonly arguments: JsonValue
  readonly createdAt: number
  readonly completedAt?: number
  readonly result?: JsonValue
  readonly isError?: boolean
}

export type BartTranscriptItem = BartMessage | BartToolOperation
