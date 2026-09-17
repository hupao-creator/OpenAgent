import { startTransition, useDeferredValue, useEffect, useRef, useState } from 'react'

interface StreamingCadenceTier {
  minLength: number
  intervalMs: number
}

// These tiers keep parser work below the incoming 30 Hz stream. The long-content
// tier is deliberately more conservative because the parser cost grows faster
// than the appended payload (notably for GFM tables and open code fences).
const STREAMING_MARKDOWN_CADENCE: readonly StreamingCadenceTier[] = [
  { minLength: 40_000, intervalMs: 400 },
  { minLength: 8_000, intervalMs: 200 },
  { minLength: 0, intervalMs: 120 }
]

export function getStreamingMarkdownCadence(length: number): number {
  return (
    STREAMING_MARKDOWN_CADENCE.find((tier) => length >= tier.minLength) ??
    STREAMING_MARKDOWN_CADENCE[STREAMING_MARKDOWN_CADENCE.length - 1]
  ).intervalMs
}

/**
 * Limits expensive consumers of append-only streaming text while preserving an
 * immediate leading render, a trailing render, and an immediate settled value.
 */
export function useStreamingCadence(content: string, streaming: boolean): string {
  const [cadencedContent, setCadencedContent] = useState(content)
  const deferredContent = useDeferredValue(cadencedContent)
  const latestContentRef = useRef(content)
  const publishedContentRef = useRef(content)
  const lastPublishedAtRef = useRef(Date.now())
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const timerDeadlineRef = useRef(0)
  const generationRef = useRef(0)
  const wasStreamingRef = useRef(streaming)
  const mountedRef = useRef(true)

  const isImmediateStreamingValue =
    streaming &&
    content !== publishedContentRef.current &&
    (publishedContentRef.current.length === 0 || !content.startsWith(publishedContentRef.current))

  // `useDeferredValue` lags a publish by a render, so a consumer that re-renders
  // inside that window is handed text that has already been superseded: the
  // older prefix of an appended message, a message a replacement publication did
  // not extend, or the longer text a truncation cut short. The deferred value
  // can only ever be older than the last publication — it lags `cadencedContent`
  // and the publication has already been written — so any difference means
  // superseded text, and handing it over would read as the message reverting and
  // then rendering forward again. The last published text is handed over instead
  // — live content would outrun the cadence — and the deferred value takes back
  // over once it catches up.
  const deferredIsStale = deferredContent !== publishedContentRef.current

  useEffect(() => {
    latestContentRef.current = content
    const restarted = streaming && !wasStreamingRef.current
    wasStreamingRef.current = streaming

    const cancelPending = (): void => {
      generationRef.current += 1
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
        timerRef.current = undefined
        timerDeadlineRef.current = 0
      }
    }

    const publish = (nextContent: string, transition: boolean): void => {
      publishedContentRef.current = nextContent
      lastPublishedAtRef.current = Date.now()
      const update = (): void => setCadencedContent(nextContent)
      if (transition) startTransition(update)
      else update()
    }

    if (!streaming) {
      cancelPending()
      publish(content, false)
      return
    }

    if (restarted) cancelPending()

    if (content === publishedContentRef.current) return

    const leading = publishedContentRef.current.length === 0 && content.length > 0
    const discontinuity = !content.startsWith(publishedContentRef.current)
    if (leading || discontinuity || restarted) {
      cancelPending()
      publish(content, true)
      return
    }

    const intervalMs = getStreamingMarkdownCadence(content.length)
    const deadline = lastPublishedAtRef.current + intervalMs
    if (timerRef.current !== undefined && timerDeadlineRef.current === deadline) return

    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    const generation = ++generationRef.current
    timerDeadlineRef.current = deadline
    timerRef.current = setTimeout(
      () => {
        if (!mountedRef.current || generation !== generationRef.current) return
        timerRef.current = undefined
        timerDeadlineRef.current = 0
        publish(latestContentRef.current, true)
      },
      Math.max(0, deadline - Date.now())
    )
  }, [content, streaming])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      if (timerRef.current !== undefined) clearTimeout(timerRef.current)
      timerRef.current = undefined
      timerDeadlineRef.current = 0
    }
  }, [])

  if (!streaming || isImmediateStreamingValue) return content
  return deferredIsStale ? publishedContentRef.current : deferredContent
}
