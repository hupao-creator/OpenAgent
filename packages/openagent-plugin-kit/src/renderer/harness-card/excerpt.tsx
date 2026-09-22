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

interface ExcerptProps {
  readonly content: string
  readonly messageId?: string
  readonly messageText?: string
}

/** All buffer scheduling belongs to this leaf, never the card or Overview. */
export const ThreadCardExcerpt = memo(function ThreadCardExcerpt(props: ExcerptProps): React.JSX.Element {
  const text = props.messageText ?? props.content
  const [frame, setFrame] = useState(() => ({
    id: props.messageId, text, offset: tailStart(text), revision: 0, initial: true, snapshot: props.content
  }))
  if (frame.id !== props.messageId || frame.text !== text) {
    const append = frame.id === props.messageId && text.startsWith(frame.text)
    setFrame({ ...frame, id: props.messageId, text, initial: false,
      offset: append ? frame.offset : 0, revision: frame.revision + (append ? 0 : 1) })
  }
  const batch = batchAt(frame.text, frame.offset)
  const content = !props.messageId ? props.content : frame.initial ? frame.snapshot : batch.text
  const key = JSON.stringify([frame.id, frame.revision, frame.offset])
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
      current.id === frame.id && current.revision === frame.revision && current.offset === frame.offset
        ? { ...current, offset: batch.end } : current), delay)
    return () => clearTimeout(timer)
  }, [props.messageId, frame.id, frame.revision, frame.offset, frame.initial, batch.count, batch.end, key, more, settled])

  return <div className="thread-overview-excerpt" ref={bind}>
    <div className="thread-card-excerpt-text" ref={body}>{content}</div>
  </div>
}, (previous, next) => previous.messageId === next.messageId && previous.messageText === next.messageText &&
  (next.messageId !== undefined || previous.content === next.content))
