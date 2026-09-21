import type { HarnessBartActivity } from '@openagent/contracts/renderer'
import type { AgentThreadRecord, BartThreadRecord } from '@openagent/contracts'
import type { ReportExecutionReference } from './report-thread'
import type { OpenAgentSettings } from './openagent-settings'

export type RendererBartThreadRecord = BartThreadRecord

export type RendererThreadRecord =
  | AgentThreadRecord
  | RendererBartThreadRecord

export interface RendererBartExecution {
  readonly threadId: string
  readonly executionId: string
  readonly status: 'running'
  readonly startedAt: number
}

/** Renderer-safe report summary. Full HTML stays in Main's report runtime. */
export interface RendererReport {
  readonly id: string
  readonly title: string
  readonly tags: readonly string[]
  readonly relatedExecutions: readonly ReportExecutionReference[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly archived: boolean
  readonly previewText: string
}

/**
 * One committed renderer aggregate. Harness state remains opaque to Core and is
 * interpreted only by the matching Renderer plugin.
 */
export interface RendererAppState {
  readonly revision: number
  readonly defaultCwd: string
  readonly threads: readonly RendererThreadRecord[]
  /** Process-local Bart execution only; Agent status lives in observation. */
  readonly executions: readonly RendererBartExecution[]
  readonly reports: readonly RendererReport[]
  readonly selectedThreadId: string | null
  readonly settings: OpenAgentSettings
}

/** Changed records are complete; provider-private fields stay opaque to Core. */
export interface RendererCollectionPatch<T> {
  readonly upserts: readonly T[]
  readonly removedIds: readonly string[]
  /** Present only when membership or ordering changes. */
  readonly order?: readonly string[]
}

/** Ordered, transient semantic input; never a durable Thread field. */
export interface RendererBartActivity {
  readonly threadId: string
  readonly harnessId: string
  readonly activity: HarnessBartActivity
}

/** Initial/recovery hydration uses RendererAppState; daily delivery is incremental. */
export interface RendererStateMutation {
  readonly type: 'state-patched'
  readonly bartActivities?: readonly RendererBartActivity[]
  readonly baseRevision: number
  readonly revision: number
  readonly threads?: RendererCollectionPatch<RendererThreadRecord>
  readonly reports?: RendererCollectionPatch<RendererReport>
  readonly defaultCwd?: string
  readonly executions?: RendererAppState['executions']
  readonly selectedThreadId?: string | null
  readonly settings?: OpenAgentSettings
  /** One-shot product choreography cue; never persisted or replayed as state. */
  readonly effect?: {
    readonly type: 'bart-generation'
    readonly target:
      | { readonly kind: 'thread'; readonly id: string }
      | { readonly kind: 'report'; readonly id: string }
  }
}
