import type { ReactNode } from 'react'
import type { HarnessOverviewDisplayPolicy } from '@openagent/contracts/renderer'

/** Integer grid footprint. Sizes are always written as columns x rows. */
export interface ThreadCardSize {
  readonly cols: number
  readonly rows: number
}

export const SINGLE_CARD_SIZE: ThreadCardSize = { cols: 1, rows: 1 }

/** Discrete responsive input shared by live rendering and mutation snapshots. */
export interface ThreadCardLayoutContext {
  readonly displayPolicy?: HarnessOverviewDisplayPolicy
  readonly availableCols: number
}

/**
 * Pure Renderer identity copy. Harness-native facts are projected into these
 * fields by each Plugin; this package neither reads nor persists Harness state.
 */
export interface ThreadCardIdentityView {
  readonly title: ReactNode
  readonly providerStatus?: ReactNode
  readonly state?: ReactNode
  readonly model?: ReactNode
  readonly effort?: ReactNode
  readonly fastMode?: boolean
  /** Latest execution clock, projected by the Plugin; absent end means live. */
  readonly runtime?: { readonly startedAt: number; readonly endedAt?: number }
  readonly cwd?: string
  readonly cwdName?: string
  readonly usesWorktree?: boolean
  readonly steer?: string
  readonly excerpt: string
  /** Full current message for local buffering; native identity survives streaming deltas. */
  readonly message?: { readonly id: string; readonly text: string }
}

export type ThreadCardActivityStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ThreadCardIdentityToolKind = 'command' | 'file' | 'search' | 'tool'

export interface ThreadCardIdentityTool {
  readonly kind: ThreadCardIdentityToolKind
  readonly name: string
  /** Provider-bounded, single-line subject. Raw input and output never enter this field. */
  readonly summary?: string
  readonly status: ThreadCardActivityStatus
}

export interface ThreadCardIdentityUsagePart {
  readonly suffix?: string
  readonly description?: string
  readonly id: string
  readonly label?: string
  readonly value: string
  /** Optional raw value used only to choose rolling animation direction. */
  readonly numericValue?: number
}

/** Fully formatted latest-run usage. Token/cache semantics stop inside the Plugin projector. */
export interface ThreadCardIdentityUsage {
  readonly parts: readonly ThreadCardIdentityUsagePart[]
}

export interface ThreadCardIdentityProjection {
  /** Up to three recent activities, in chronological order, formatted by the Harness. */
  readonly recentTools?: readonly ThreadCardIdentityTool[]
  readonly latestTool?: ThreadCardIdentityTool
  readonly usage?: ThreadCardIdentityUsage
}

export interface ThreadCardPlanStep {
  readonly step: string
  readonly status: 'pending' | 'inProgress' | 'completed'
}

/** Used only by the Dynamic Workflow card composition. */
export interface ThreadCardAgentRow {
  readonly id: string
  readonly label: string
  readonly status: ThreadCardActivityStatus
}

export type ThreadCardDerivedKind = 'shell' | 'agent' | 'task'

export interface ThreadCardDerivedRow {
  readonly id: string
  readonly label: string
  readonly status: ThreadCardActivityStatus
  readonly kind: ThreadCardDerivedKind
  readonly commandLine: boolean
}

export interface ThreadCardDecisionAction {
  readonly id: string
  readonly label: string
}

export interface ThreadCardQuestionOption {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly value: string
}

export interface ThreadCardQuestion {
  readonly id: string
  readonly prompt: string
  readonly header?: string
  readonly multiple: boolean
  readonly allowOther: boolean
  readonly secret: boolean
  readonly options: readonly ThreadCardQuestionOption[]
}

export interface ThreadCardIntervention {
  readonly id: string
  readonly title: string
  readonly detail?: string
  readonly actions: readonly ThreadCardDecisionAction[]
  readonly questions?: readonly ThreadCardQuestion[]
  readonly submitActionId?: string
  /** Native action that skips all questions by receiving an empty answer map. */
  readonly skipAction?: ThreadCardDecisionAction
}

export interface ThreadCardInterventionResponse {
  readonly actionId: string
  readonly answers?: Record<string, string | string[]>
}

export type ThreadCardInterventionHandler = (
  response: ThreadCardInterventionResponse
) => void | Promise<void>

export type ThreadCardExtensionKind = 'todo' | 'intervention' | 'derived'

export type ThreadCardComponentKind =
  | 'identity'
  | 'todo'
  | 'derived'
  | 'permission'
  | 'question'

export interface ThreadCardSizeContract {
  readonly component: ThreadCardComponentKind
  readonly allowedSizes: readonly ThreadCardSize[]
  readonly preferredSize: ThreadCardSize
}

export interface ThreadCardSizeSelection extends ThreadCardSizeContract {
  readonly selectedSize: ThreadCardSize
}

export type ThreadCardExtensionProjection =
  | { readonly kind: 'todo'; readonly steps: readonly ThreadCardPlanStep[] }
  | { readonly kind: 'intervention'; readonly intervention: ThreadCardIntervention }
  | { readonly kind: 'derived'; readonly rows: readonly ThreadCardDerivedRow[] }

export interface ThreadCardDynamicWorkflowProjection {
  readonly phases: readonly string[]
  readonly phaseCount: number
  readonly agents: readonly ThreadCardAgentRow[]
}

/** Provider-native knowledge stops before this pure Renderer projection. */
export type ThreadCardProjection =
  | {
      readonly kind: 'standard'
      readonly identity?: ThreadCardIdentityProjection
      readonly extensions: readonly ThreadCardExtensionProjection[]
    }
  | {
      readonly kind: 'dynamic-workflow'
      readonly identity?: ThreadCardIdentityProjection
      readonly workflow: ThreadCardDynamicWorkflowProjection
    }

export type ThreadCardVariantId = 'compact' | 'wide' | 'tall'

export interface ThreadCardExtensionPlacement {
  readonly kind: ThreadCardExtensionKind
  readonly component: Exclude<ThreadCardComponentKind, 'identity'>
  readonly variant: ThreadCardVariantId
  readonly col: number
  readonly row: number
  readonly allowedSizes: readonly ThreadCardSize[]
  readonly preferredSize: ThreadCardSize
  readonly selectedSize: ThreadCardSize
}

export type ThreadCardComposition =
  | {
      readonly kind: 'standard'
      readonly size: ThreadCardSize
      readonly identity: ThreadCardSizeSelection
      readonly placements: readonly ThreadCardExtensionPlacement[]
      readonly key: string
    }
  | {
      readonly kind: 'dynamic-workflow'
      readonly size: { readonly cols: 2; readonly rows: 2 }
      readonly key: 'dynamic-workflow:2x2'
    }

/** Projection and composition travel together so sizing and rendering cannot drift. */
export interface ThreadCardPresentation {
  readonly projection: ThreadCardProjection
  readonly composition: ThreadCardComposition
  readonly size: ThreadCardSize
  /** Contains structure only; text, statuses, progress, and opaque state never enter it. */
  readonly key: string
}
