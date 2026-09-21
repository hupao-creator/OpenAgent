import type { JsonValue } from '../agent-core/values.js'

/**
 * Resting visual tail, in Unicode code points. Transport retains a larger
 * source window so the renderer can queue bursts before displaying them.
 */
export const MAX_BART_REASONING_TAIL_POINTS = 56
/** At most 64 Ki UTF-16 units even when every source point is a surrogate pair. */
export const MAX_BART_REASONING_SOURCE_POINTS = 32 * 1024

/** Validate persisted source windows with the same budget the producer uses. */
export function isBartReasoningSource(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_BART_REASONING_SOURCE_POINTS * 2 || value.includes('\0')) return false
  for (let index = 0, points = 0; index < value.length; index += pointWidth(value, index)) {
    if (++points > MAX_BART_REASONING_SOURCE_POINTS) return false
  }
  return true
}
/** Source characters a final-reply preview payload is built from. */
export const MAX_BART_REPLY_EXCERPT_POINTS = 240
/** Single-line tool signature input bound, before the renderer ellipsizes. */
export const MAX_BART_TOOL_NAME_POINTS = 64

/**
 * What Bart is consuming right now. A Harness publishes an activity only for
 * a real foreground semantic event: reasoning content, intermediate assistant
 * text, or an accepted tool call whose name is already known.
 */
export type HarnessBartActivityBody =
  | {
      readonly kind: 'reasoning'
      /** Raw contiguous source window, before visual whitespace normalization. */
      readonly text: string
      /** UTF-16 position within this segment; omitted while the source starts at zero. */
      readonly textOffset?: number
    }
  | { readonly kind: 'assistant-text' }
  | {
      readonly kind: 'tool-call'
      /** Stable identity of this call, so later updates never re-trigger it. */
      readonly callId: string
      /** Canonical tool name as the owning Harness received it. */
      readonly toolName: string
    }

/**
 * The per-Execution snapshot a Harness persists where it accepts native
 * events. `sequence` advances only when the foreground semantic event itself
 * changes (new reasoning segment, new tool call), never for deltas of the
 * segment already showing, empty text, usage, settlement or tool progress.
 */
export type HarnessBartForeground = HarnessBartActivityBody & { readonly sequence: number }

/** The published activity: the owning Execution plus its foreground snapshot. */
export type HarnessBartActivity = HarnessBartForeground & { readonly executionId: string }

/** Validate the transient Main publication independently of the durable codec. */
export function isHarnessBartActivity(value: unknown): value is HarnessBartActivity {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (typeof item.executionId !== 'string' || !item.executionId ||
    !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 1) return false
  if (item.kind === 'assistant-text') return true
  if (item.kind === 'reasoning') return isBartReasoningSource(item.text) &&
    (item.textOffset === undefined || Number.isSafeInteger(item.textOffset) && (item.textOffset as number) >= 0)
  return item.kind === 'tool-call' && typeof item.callId === 'string' && item.callId.length > 0 &&
    typeof item.toolName === 'string' && item.toolName.trim().length > 0 &&
    !item.toolName.includes('\0') && headPoints(item.toolName, MAX_BART_TOOL_NAME_POINTS) === item.toolName
}

/**
 * The latest final answer of a successfully completed Execution. The owning
 * Harness alone decides which native message qualifies and how `target`
 * resolves back to it.
 */
export interface HarnessBartReply {
  /** Stable across streaming updates; distinct for messages with equal text. */
  readonly id: string
  readonly executionId: string
  readonly excerpt: string
  /** Opaque navigation target; Core only carries it back to this Harness. */
  readonly target: JsonValue
}

/**
 * Two independent dimensions of Bart's Dock presentation. Keeping them apart
 * prevents an unread final answer from being encoded as a transient run state.
 */
export interface HarnessBartPresentation {
  readonly activity: HarnessBartActivity | null
  readonly reply: HarnessBartReply | null
}

/**
 * Advance a persisted foreground snapshot. `sequence` bumps only when the
 * semantic event itself changes (new segment, new tool call), never for deltas
 * of the segment already showing, so the Dock extends its bounded tail in
 * place instead of remounting the character. A caller that knows this delta
 * began a new native segment says so: a same-kind successor is otherwise
 * indistinguishable from a continuation.
 */
export function advanceBartForeground(
  previous: HarnessBartForeground | undefined,
  next: HarnessBartActivityBody,
  options?: { readonly newSegment?: boolean }
): HarnessBartForeground {
  let sequence = (previous?.sequence ?? 0) + 1
  if (previous !== undefined && previous.kind === next.kind && options?.newSegment !== true) {
    const sameCall =
      previous.kind !== 'tool-call' ||
      (next.kind === 'tool-call' && previous.callId === next.callId)
    if (sameCall) sequence = previous.sequence
  }
  return { ...next, sequence }
}

/**
 * The foreground for a reasoning delta. One that continues the segment already
 * showing extends the positioned source window; one that begins a new native
 * segment — another event landed in between, or the harness started a new
 * message — restarts the source position and Bart's arrival with it.
 */
export function advanceBartReasoning(
  previous: HarnessBartForeground | undefined,
  delta: string,
  continuesSegment: boolean
): HarnessBartForeground {
  const previousText = continuesSegment && previous?.kind === 'reasoning' ? previous.text : ''
  const previousOffset = continuesSegment && previous?.kind === 'reasoning' ? previous.textOffset ?? 0 : 0
  const source = previousText + delta
  const text = tailPoints(source, MAX_BART_REASONING_SOURCE_POINTS)
  const textOffset = previousOffset + source.length - text.length
  return advanceBartForeground(
    previous,
    {
      kind: 'reasoning',
      text,
      ...(textOffset > 0 ? { textOffset } : {})
    },
    { newSegment: !continuesSegment }
  )
}

/**
 * Reads the string fields a Harness stamped into its own reply target. An
 * absent, foreign or malformed target yields nothing, so the navigation still
 * opens the Execution it was given.
 */
export function readBartReplyTarget<K extends string>(
  message: JsonValue | undefined,
  keys: readonly K[]
): Record<K, string> | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
  const record = message as Record<string, JsonValue>
  const target = {} as Record<K, string>
  for (const key of keys) {
    const value = record[key]
    if (typeof value !== 'string') return undefined
    target[key] = value
  }
  return target
}

/** UTF-16 width of the code point starting at `index`, matching the string iterator. */
function pointWidth(value: string, index: number): number {
  const first = value.charCodeAt(index)
  const second = value.charCodeAt(index + 1)
  return first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? 2 : 1
}

/**
 * Keep the trailing `limit` Unicode code points, preserving surrogate pairs.
 * A Harness may hand over a whole transcript, so the walk counts rather than
 * materialising an array of every code point it is about to discard.
 */
export function tailPoints(value: string, limit: number): string {
  let total = 0
  for (let index = 0; index < value.length; index += pointWidth(value, index)) total += 1
  if (total <= limit) return value
  let index = 0
  for (let skipped = total - limit; skipped > 0; skipped -= 1) index += pointWidth(value, index)
  return value.slice(index)
}

/** Keep the leading `limit` Unicode code points, preserving surrogate pairs. */
export function headPoints(value: string, limit: number): string {
  let index = 0
  for (let kept = 0; kept < limit && index < value.length; kept += 1) {
    index += pointWidth(value, index)
  }
  return index >= value.length ? value : value.slice(0, index)
}
