import type { ComponentType } from 'react'
import type { HarnessOverviewDisplayPolicy } from './overview-contracts.js'
import type { HarnessBartPresentation } from './bart-presentation.js'
import type {
  DeepReadonly,
  HarnessThreadRecord,
  HarnessRespondRequest,
  ThreadPublicObservation
} from '../harness-plugin.js'
import type { JsonValue } from '../agent-core/values.js'

export type HarnessTranslationDictionary = Readonly<Record<string, string>>
/**
 * Catalog keys are Host locale identifiers. The contract layer stays
 * locale-open; the Host alone constrains which keys it composes.
 */
export type HarnessTranslationCatalog = Readonly<
  Partial<Record<string, HarnessTranslationDictionary>>
>

export interface HarnessRendererThreadInput {
  readonly thread: DeepReadonly<HarnessThreadRecord>
  /**
   * Public navigation request; the owning Harness resolves its private
   * historical row. `message` is an opaque target the owning Harness produced
   * itself: Core only carries it back and never interprets it.
   */
  readonly readingTarget?: {
    readonly executionId: string
    readonly requestId: string
    readonly mode: 'current' | 'history'
    readonly message?: JsonValue
  }
}

export function isPublicExecutionActive(
  observation: DeepReadonly<ThreadPublicObservation>
): boolean {
  const status = observation.latestExecution?.status
  return status === 'running' || status === 'waiting-for-user'
}

export interface HarnessRendererThreadActions {
  interrupt(): Promise<void>
  respond(response: HarnessRespondRequest): Promise<void>
  /** Provider-wide control plane, bound to this Thread's Plugin by composition. */
  invokeHarnessExtension(method: string, payload: JsonValue): Promise<JsonValue>
  /** Core-owned lifecycle action; Plugin request remains opaque JSON. */
  forkThread(request: JsonValue): Promise<{ readonly threadId: string }>
  /** Core-owned external navigation capability injected into Plugin UI. */
  openExternal(url: string): Promise<void>
  /** Open the Core-owned composer for this Thread with an exact editable draft. */
  openFollowUp(initialDraft: string): void
}

export interface HarnessOverviewProjection<OverviewView> {
  readonly footprint: { readonly columns: number; readonly rows: number }
  readonly structureKey: string
  readonly excerpt: string
  readonly view: OverviewView
}

export interface HarnessOverviewCardModule<OverviewView> {
  /** The same token total shown by this Harness's card, for a pinned Execution. */
  readonly executionTokenUsage?: (thread: DeepReadonly<HarnessThreadRecord>, executionId: string) =>
    { readonly value: string; readonly count: number; readonly suffix: string } | undefined
  project(input: HarnessRendererThreadInput & {
    readonly displayPolicy?: HarnessOverviewDisplayPolicy
    readonly layout: { readonly availableColumns: number }
  }): HarnessOverviewProjection<OverviewView>
  readonly Card: ComponentType<
    HarnessRendererThreadInput & {
      readonly projection: OverviewView
      readonly actions: HarnessRendererThreadActions & { openThread(): void }
    }
  >
}

/** `refresh` asks for a fresh probe instead of an answer the page already has. */
export type HarnessSettingsResource<SettingsPresentationData> =
  | {
      readonly status: 'loading'
      reload(options?: { readonly refresh?: boolean }): Promise<void>
    }
  | {
      readonly status: 'ready'
      readonly value: DeepReadonly<SettingsPresentationData>
      reload(options?: { readonly refresh?: boolean }): Promise<void>
    }
  | {
      readonly status: 'error'
      readonly message: string
      reload(options?: { readonly refresh?: boolean }): Promise<void>
    }

export interface HarnessThreadSettingsProps<
  ThreadSettingsUpdate,
  SettingsPresentationData
> extends HarnessRendererThreadInput {
  readonly resource: HarnessSettingsResource<SettingsPresentationData>
  update(change: ThreadSettingsUpdate): Promise<void>
}

/** Product settings location; each Plugin owns the fields shown in that location. */
export type HarnessSettingsSection = 'cli' | 'thread'

export interface HarnessSettingsProps<
  HarnessSettings,
  SettingsPresentationData
> {
  readonly section: HarnessSettingsSection
  readonly value: DeepReadonly<HarnessSettings>
  readonly resource: HarnessSettingsResource<SettingsPresentationData>
  /** Provider-neutral Host capabilities, bound to this Plugin by composition. */
  readonly host?: {
    readonly cwd: string
    invokeExtension(method: string, payload: JsonValue): Promise<JsonValue>
    openExternal(url: string): Promise<void>
  }
  change(value: HarnessSettings): void
}

export interface HarnessRendererPlugin<
  OverviewView,
  ThreadSettingsUpdate,
  HarnessSettings,
  SettingsPresentationData
> {
  /** Harness-owned brand asset used by Core shells such as Bart Dock. */
  readonly logoSource: string
  /** Harness-owned copy, composed once by the Renderer composition root. */
  readonly translations?: HarnessTranslationCatalog
  readonly ThreadView: ComponentType<
    HarnessRendererThreadInput & {
      readonly actions: HarnessRendererThreadActions
    }
  >
  readonly OverviewCard: HarnessOverviewCardModule<OverviewView>
  /**
   * Bart Dock presentation: the foreground activity Bart is consuming now and
   * the latest final answer of a successfully completed Execution. Both IDs are
   * opaque, stable across streaming updates, and distinct for separate messages
   * even with equal text. Only the owning Harness interprets its native
   * timeline or private session state.
   */
  projectBartDock?(input: HarnessRendererThreadInput): HarnessBartPresentation | undefined
  readonly ThreadSettings: ComponentType<
    HarnessThreadSettingsProps<ThreadSettingsUpdate, SettingsPresentationData>
  >
  readonly HarnessSettings: ComponentType<
    HarnessSettingsProps<HarnessSettings, SettingsPresentationData>
  >
}
