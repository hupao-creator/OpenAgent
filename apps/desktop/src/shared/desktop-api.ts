import type { HarnessId } from './harnesses'
import type {
  AgentInput, ThreadInteractionResponseRequest, ReadThreadRequest,
  BartSubmitRequest as PublicBartSubmitRequest, FollowUpThreadRequest
} from '@openagent/contracts'
import type { JsonValue } from '@openagent/contracts'
import type {
  HarnessSettingsPresentationRequest,
  HarnessSettingsPresentationResult,
  HarnessInstallationMap,
  OpenAgentSettings,
  OpenAgentUiStateUpdate,
  UpdateThreadSettingsRequest
} from './openagent-settings'
import type {
  RendererAppState,
  RendererStateMutation
} from './renderer-state-contracts'
import type { AgentAttachment } from './attachments'
import type { KnownDirectory } from './known-directory'
import type { HarnessExtensionRequest } from '@openagent/contracts'
import type { RendererFirstCommitDiagnostic } from './diagnostic-tracing'
import type {
  ForkThreadRequest,
  ForkThreadResult
} from './thread-actions'

/** Report view content bounds in BrowserWindow content coordinates. */
export interface ReportRuntimeBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ReportRuntimeFailure {
  readonly reportId: string
  readonly message: string
}

/** Core callers additionally permit internal Host presentation intent. */
export type ThreadInputRequest = Readonly<Omit<FollowUpThreadRequest, 'input'> & { input: AgentInput }>
/** Includes the overview-selected, Core-validated directoryTag workspace hint. */
export type BartSubmitRequest = Readonly<Omit<PublicBartSubmitRequest, 'input'> & { input: AgentInput }>

export type { ThreadInteractionResponseRequest, ReadThreadRequest } from '@openagent/contracts'

/** Current-only renderer API exposed by the preload bridge. */
export interface DesktopApi {
  /** Static host platform used only for window-chrome layout. */
  readonly platform: string
  loadState(): Promise<RendererAppState>
  onStateMutation(
    listener: (mutation: RendererStateMutation) => void
  ): () => void

  submitBartMessage(request: BartSubmitRequest): Promise<void>
  /** Renderer-only timing hook; omitted by older bridge test doubles. */
  reportRendererFirstCommit?(input: RendererFirstCommitDiagnostic): void
  cancelBartTask(): Promise<void>
  clearBartSession(): Promise<void>
  clearAllHistory(): Promise<void>

  followUpThread(request: ThreadInputRequest): Promise<void>
  interruptThread(threadId: string): Promise<void>
  respondToThreadInteraction(
    request: ThreadInteractionResponseRequest
  ): Promise<void>
  readThread(request: ReadThreadRequest): Promise<string>
  forkThread(request: ForkThreadRequest): Promise<ForkThreadResult>
  updateThreadSettings(request: UpdateThreadSettingsRequest): Promise<void>

  updateAppSettings(settings: OpenAgentSettings): Promise<void>
  updateUiState(update: OpenAgentUiStateUpdate): Promise<void>
  loadHarnessSettingsPresentation(
    request: HarnessSettingsPresentationRequest
  ): Promise<HarnessSettingsPresentationResult>
  installHarness(harnessId: HarnessId): Promise<void>
  detectHarnessInstallations(): Promise<HarnessInstallationMap>
  listKnownDirectories(): Promise<readonly KnownDirectory[]>
  invokeHarnessExtension(request: HarnessExtensionRequest): Promise<JsonValue>

  chooseFiles(
    defaultPath: string | undefined,
    maxCount: number
  ): Promise<AgentAttachment[]>
  /** Stage pasted Clipboard Files into the Bart attachment area. */
  stageBartAttachments(files: File[]): Promise<AgentAttachment[]>

  openReportRuntime(
    reportId: string,
    bounds: ReportRuntimeBounds
  ): Promise<void>
  setReportRuntimeBounds(bounds: ReportRuntimeBounds): Promise<void>
  setThreadArchived(threadId: string, archived: boolean): Promise<void>
  setReportArchived(reportId: string, archived: boolean): Promise<void>
  closeReportRuntime(): Promise<void>
  onReportRuntimeFailure(
    listener: (failure: ReportRuntimeFailure) => void
  ): () => void

  openExternal(url: string): Promise<void>
}
