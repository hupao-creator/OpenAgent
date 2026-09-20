import type { HarnessBartActivity } from '@openagent/contracts/renderer'
import { MAX_BART_REASONING_TAIL_POINTS, tailPoints } from '@openagent/contracts/renderer'
import { isDedicatedBartTool } from './bart-visual-operation'

/**
 * The resident shape the Dock shows for the foreground semantic event Bart is
 * consuming right now. `idle` also covers assistant text and dedicated
 * choreography, which never paint a status dot or a decoration.
 */
export type BartDockRole =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reasoning'; readonly text: string; readonly segmentKey: string }
  | { readonly kind: 'tool'; readonly toolName: string }

const IDLE_BART_ROLE: BartDockRole = { kind: 'idle' }

/**
 * Dedicated choreography outranks the generic fallback: a tool call whose
 * canonical name owns a Core route keeps that route's own animation instead of
 * also painting the green-dot signature.
 */
export function resolveBartRole(
  activity: HarnessBartActivity | null | undefined,
  dedicatedRouteActive: boolean
): BartDockRole {
  if (!activity || dedicatedRouteActive) return IDLE_BART_ROLE
  switch (activity.kind) {
    case 'reasoning':
      return { kind: 'reasoning', text: reasoningArcText(activity.text),
        segmentKey: JSON.stringify([activity.executionId, activity.sequence]) }
    case 'tool-call':
      return isDedicatedBartTool(activity.toolName)
        ? IDLE_BART_ROLE
        : { kind: 'tool', toolName: activity.toolName }
    case 'assistant-text':
      return IDLE_BART_ROLE
  }
}

/**
 * Keep the bounded source tail, not a fixed count of visible glyphs: SVG fits
 * the text to the arc and keeps the newest end in view for every writing system.
 */
export function reasoningArcText(text: string): string {
  return tailPoints(text.replace(/\s+/g, ' ').trim(), MAX_BART_REASONING_TAIL_POINTS)
}
