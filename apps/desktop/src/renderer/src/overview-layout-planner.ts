import type { CSSProperties } from 'react'
import { OVERVIEW_CARD_GEOMETRY, type OverviewLayoutContext } from '@openagent/contracts/renderer'
import type { OverviewLayoutSnapshot } from './conversation-overview-layout'
import { layoutOverview, type LayoutPlacement, type LayoutResult } from './overview-layout'

/** Geometric policy only. The Overview owner still commits and plays every revision. */
export interface OverviewLayoutPlanner {
  readonly context: OverviewLayoutContext
  readonly plan: typeof layoutOverview
}

/** Compose natural Harness footprints; the camera, not card layout, handles viewport size. */
export const OVERVIEW_LAYOUT_CONTEXT: OverviewLayoutContext = { availableCols: Number.MAX_SAFE_INTEGER }
export const OVERVIEW_LAYOUT_PLANNER: OverviewLayoutPlanner = { context: OVERVIEW_LAYOUT_CONTEXT, plan: layoutOverview }

export interface PlannedOverviewLayout extends OverviewLayoutSnapshot {
  readonly plan?: LayoutResult
}

export type OverviewLayoutPlanningState = { readonly plan: LayoutResult } | { readonly error: string }
export type OverviewGridPosition = Pick<LayoutPlacement, 'col' | 'row'>

export function planOverviewSnapshot(
  target: OverviewLayoutSnapshot,
  planner: OverviewLayoutPlanner = OVERVIEW_LAYOUT_PLANNER,
  previous: readonly LayoutPlacement[] = []
): PlannedOverviewLayout {
  return { ...target, plan: planner.plan(previous, target.items.map(item => ({
    id: item.entityId, cols: item.size.cols, rows: item.size.rows
  })), OVERVIEW_CARD_GEOMETRY) }
}

export function overviewGridPositionStyle(position?: OverviewGridPosition): CSSProperties {
  // Explicit ends preserve the footprint instead of replacing the CSS span with a start line.
  return position ? { gridColumnStart: position.col + 1, gridRowStart: position.row + 1,
    gridColumnEnd: 'span var(--thread-card-cols, 1)', gridRowEnd: 'span var(--thread-card-rows, 1)' } : {}
}
