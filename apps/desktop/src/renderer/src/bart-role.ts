import type { HarnessBartActivity } from '@openagent/contracts/renderer'
import { MAX_BART_REASONING_TAIL_POINTS, tailPoints } from '@openagent/contracts/renderer'
import { isDedicatedBartTool } from './bart-visual-operation'

/**
 * The resident shape the Dock shows for the foreground semantic event Bart is
 * consuming right now. `running` covers active work without a more specific
 * expression; dedicated choreography owns its own appearance.
 */
export type BartDockRole =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'reasoning'; readonly text: string; readonly segmentKey: string; readonly sourceText?: string; readonly sourceOffset?: number }
  | { readonly kind: 'tool'; readonly toolName: string }

const IDLE_BART_ROLE: BartDockRole = { kind: 'idle' }
const reasoningSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Dedicated choreography outranks the generic fallback: a tool call whose
 * canonical name owns a Core route keeps that route's own animation instead of
 * also painting the green-dot signature.
 */
export function resolveBartRole(
  activity: HarnessBartActivity | null | undefined,
  dedicatedRouteActive: boolean,
  running = false
): BartDockRole {
  const fallback: BartDockRole = running ? { kind: 'running' } : IDLE_BART_ROLE
  if (dedicatedRouteActive) return IDLE_BART_ROLE
  if (!activity) return fallback
  switch (activity.kind) {
    case 'reasoning':
      return { kind: 'reasoning', text: reasoningArcText(activity.text),
        sourceText: activity.text, sourceOffset: activity.textOffset ?? 0,
        segmentKey: JSON.stringify([activity.executionId, activity.sequence]) }
    case 'tool-call':
      return isDedicatedBartTool(activity.toolName)
        ? fallback
        : { kind: 'tool', toolName: activity.toolName }
    case 'assistant-text':
      return fallback
  }
}

/**
 * Keep a code-point-bounded tail of whole graphemes. SVG fits the text to the
 * arc; a cluster crossing the budget boundary belongs to the consumed prefix.
 */
export function reasoningArcText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const tail = tailPoints(normalized, MAX_BART_REASONING_TAIL_POINTS)
  const start = normalized.length - tail.length
  if (start === 0) return normalized
  const cluster = reasoningSegmenter.segment(normalized).containing(start)!
  return normalized.slice(cluster.index === start ? start : cluster.index + cluster.segment.length)
}
