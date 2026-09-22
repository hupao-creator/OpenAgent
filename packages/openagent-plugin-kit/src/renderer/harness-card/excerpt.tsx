import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { measureThreadCardExcerptEnd, useThreadCardAnchor } from './spatial-anchors.js'
import { useExcerptReveal } from './excerpt-reveal.js'

const BATCH_SIZE = 600
const HOLD_MS = 800

/** Offsets are UTF-16 positions, advanced only across complete code points. */
function batchAt(text: string, start: number): { text: string; end: number; count: number } {
  let end = start
  let count = 0
  while (end < text.length && count < BATCH_SIZE) {
    end += text.codePointAt(end)! > 0xffff ? 2 : 1
    count += 1
  }
  return { text: text.slice(start, end), end, count }
}

function tailStart(text: string): number {
  let start = text.length
  for (let count = 0; start > 0 && count < BATCH_SIZE; count += 1) {
    start -= 1
    const unit = text.charCodeAt(start)
    if (unit >= 0xdc00 && unit <= 0xdfff && start > 0) {
      const previous = text.charCodeAt(start - 1)
      if (previous >= 0xd800 && previous <= 0xdbff) start -= 1
    }
  }
  return start
}

/** A capped stream can retain the old suffix while discarding its prefix.
 * KMP finds the longest overlap in linear time, even for repetitive output.
 * Short overlaps are treated as authoritative rewrites, not inferred appends. */
function windowShift(previous: string, next: string): number {
  if (previous.length <= BATCH_SIZE || next.length < BATCH_SIZE) return 0
  const prefix = new Uint32Array(next.length)
  for (let index = 1, matched = 0; index < next.length; index += 1) {
    while (matched > 0 && next[index] !== next[matched]) matched = prefix[matched - 1]!
    if (next[index] === next[matched]) matched += 1
    prefix[index] = matched
  }
  let matched = 0
  // Skip the first unit: a window shift must discard at least one old unit.
  for (let index = 1; index < previous.length; index += 1) {
    while (matched > 0 && previous[index] !== next[matched]) matched = prefix[matched - 1]!
    if (previous[index] === next[matched]) matched += 1
  }
  return matched >= BATCH_SIZE ? previous.length - matched : 0
}

interface ExcerptProps {
  readonly content: string
  readonly messageId?: string
  readonly messageText?: string
}

/** All buffer scheduling belongs to this leaf, never the card or Overview. */
export const ThreadCardExcerpt = memo(function ThreadCardExcerpt(props: ExcerptProps): React.JSX.Element {
  const text = props.messageText ?? props.content
  const [frame, setFrame] = useState(() => ({
    id: props.messageId, text, origin: 0, offset: tailStart(text), revision: 0, initial: true, snapshot: props.content
  }))
  if (frame.id !== props.messageId || frame.text !== text) {
    const sameMessage = frame.id === props.messageId
    const append = sameMessage && text.startsWith(frame.text)
    const shift = sameMessage && !append ? windowShift(frame.text, text) : 0
    const rewrite = !append && !shift
    // If upstream already discarded our visible batch, catch up to its tail.
    // Otherwise retain the absolute cursor and the current reveal/hold key.
    const offset = rewrite ? 0 : shift > frame.offset ? tailStart(text) : frame.offset - shift
    setFrame({ ...frame, id: props.messageId, text, initial: false, offset,
      origin: rewrite ? 0 : frame.origin + shift,
      revision: frame.revision + (rewrite ? 1 : 0) })
  }
  const batch = batchAt(frame.text, frame.offset)
  const content = !props.messageId ? props.content : frame.initial ? frame.snapshot : batch.text
  const key = JSON.stringify([frame.id, frame.revision, frame.origin + frame.offset])
  const excerpt = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const anchor = useThreadCardAnchor('excerpt-end', measureThreadCardExcerptEnd)
  const bind = useCallback((node: HTMLDivElement | null): void => {
    excerpt.current = node
    anchor(node)
  }, [anchor])
  const settled = useExcerptReveal(excerpt, body, key, content)
  const held = useRef<{ key: string; since: number } | null>(null)
  const more = batch.end < frame.text.length

  useEffect(() => {
    if (!props.messageId || frame.initial || batch.count !== BATCH_SIZE || !settled) {
      held.current = null
      return
    }
    if (held.current?.key !== key) held.current = { key, since: Date.now() }
    if (!more) return
    const delay = Math.max(0, HOLD_MS - (Date.now() - held.current.since))
    const timer = setTimeout(() => setFrame(current =>
      current.id === frame.id && current.revision === frame.revision &&
      current.origin + current.offset === frame.origin + frame.offset
        ? { ...current, offset: frame.origin + batch.end - current.origin } : current), delay)
    return () => clearTimeout(timer)
  }, [props.messageId, frame.id, frame.revision, frame.offset, frame.origin, frame.initial, batch.count, batch.end, key, more, settled])

  return <div className="thread-overview-excerpt" ref={bind}>
    <div className="thread-card-excerpt-text" ref={body}>{content}</div>
  </div>
}, (previous, next) => previous.messageId === next.messageId && previous.messageText === next.messageText &&
  (next.messageId !== undefined || previous.content === next.content))
