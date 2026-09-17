import type {
  AgentThreadRecord,
  DeepReadonly
} from '../harness-plugin.js'

/**
 * Renderer-local overview envelope projected by the Harness Plugin. Host
 * grouping and attention are derived directly from public observation.
 */
export interface HarnessOverviewEnvelope {
  readonly footprint: {
    readonly columns: number
    readonly rows: number
  }
  readonly structureKey: string
  readonly excerpt: string
}

/** Core presentation policy; does not alter pending requests or Thread detail. */
export interface HarnessOverviewDisplayPolicy {
  readonly hideInterventions: boolean
}

/** Immutable Core facts supplied to one Harness overview projector. */
export interface HarnessOverviewThreadInput {
  readonly displayPolicy?: HarnessOverviewDisplayPolicy
  readonly thread: DeepReadonly<AgentThreadRecord>
}

/** Renderer-local projection carried through layout and generation choreography. */
export interface HarnessOverviewThread extends HarnessOverviewThreadInput {
  readonly envelope: HarnessOverviewEnvelope
}

/** Integer grid footprint, written as columns × rows. */
export interface OverviewCardSize {
  readonly cols: number
  readonly rows: number
}

/** Discrete responsive input shared by live rendering and mutation snapshots. */
export interface OverviewLayoutContext {
  readonly availableCols: number
}

export const DEFAULT_OVERVIEW_LAYOUT_CONTEXT: OverviewLayoutContext = {
  availableCols: 1
}

/** Historical production geometry; motion depends on these stable buckets. */
export const OVERVIEW_CARD_GEOMETRY = {
  columnWidth: 360,
  rowHeight: 200,
  gap: 16,
  maxResponsiveCols: 3
} as const

/** Stable 1/2/3-column buckets; pixel resize inside a bucket is structurally silent. */
export function overviewCardAvailableColumns(
  viewportWidth: number,
  reservedInlineSpace = 128
): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 1
  const usable = Math.max(0, viewportWidth - Math.max(0, reservedInlineSpace))
  const columns = Math.floor(
    (usable + OVERVIEW_CARD_GEOMETRY.gap) /
      (OVERVIEW_CARD_GEOMETRY.columnWidth + OVERVIEW_CARD_GEOMETRY.gap)
  )
  return Math.max(1, Math.min(OVERVIEW_CARD_GEOMETRY.maxResponsiveCols, columns))
}
