import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

interface Snapshot { readonly body: HTMLElement; readonly height: number; readonly lineHeight: number }

function lineLayer(snapshot: Snapshot): HTMLElement {
  const layer = document.createElement('div')
  layer.className = 'thread-card-text-reveal'
  layer.setAttribute('aria-hidden', 'true')
  layer.inert = true
  const lines = Math.max(1, Math.floor((snapshot.height + 0.5) / snapshot.lineHeight))
  for (let index = 0; index < lines; index += 1) {
    const line = document.createElement('div')
    line.className = 'thread-card-reveal-line'
    line.style.setProperty('--stagger-index', String(index))
    line.style.top = `${index * snapshot.lineHeight}px`
    line.style.height = `${snapshot.lineHeight}px`
    const window = document.createElement('div')
    window.className = 'thread-card-reveal-window'
    const copy = snapshot.body.cloneNode(true) as HTMLElement
    copy.classList.add('thread-card-reveal-content')
    copy.style.top = `${-index * snapshot.lineHeight}px`
    window.append(copy)
    line.append(window)
    layer.append(line)
  }
  return layer
}

interface Reveal {
  readonly node: HTMLElement
  readonly text: HTMLElement
  readonly previousContent: string
  readonly settled: () => void
  cancelled: boolean
  restore?: () => void
}
const pending = new Set<Reveal>()

function textCopy(body: HTMLElement, content: string): HTMLElement {
  const copy = body.cloneNode(false) as HTMLElement
  copy.textContent = content
  copy.style.removeProperty('opacity')
  return copy
}

/** React commits all card effects before this microtask. Batch reads and writes
 * across cards so a multi-Thread boundary pays for layout once per phase. */
function flushReveals(): void {
  const jobs = [...pending].filter(job => !job.cancelled)
  pending.clear()
  const measured = jobs.map(job => {
    const { text, node } = job
    const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight) || 18
    const height = node.getBoundingClientRect().height
    const incoming = { body: textCopy(text, text.textContent ?? ''), height: Math.min(text.getBoundingClientRect().height, height), lineHeight }
    const oldBody = textCopy(text, job.previousContent)
    const probe = oldBody.cloneNode(true) as HTMLElement
    probe.style.position = 'absolute'
    probe.style.width = `${text.offsetWidth}px`
    probe.style.opacity = '0'
    return { job, incoming, oldBody, probe, height, lineHeight }
  })
  // Previous text is measured only at a reveal boundary, never for each token.
  for (const item of measured) item.job.node.append(item.probe)
  const prepared = measured.map(item => ({ ...item,
    outgoing: { body: item.oldBody, height: Math.min(item.probe.getBoundingClientRect().height, item.height), lineHeight: item.lineHeight }
  }))
  for (const item of prepared) item.probe.remove()
  const layers = prepared.map(({ job, incoming, outgoing }) => ({ job,
    incoming: lineLayer(incoming), outgoing: lineLayer(outgoing), opacity: job.text.style.opacity
  }))
  for (const item of layers) {
    item.outgoing.classList.add('is-shown', 'thread-card-reveal-previous')
    item.job.node.append(item.outgoing, item.incoming)
    item.job.node.dataset.bufferTransitioning = 'texts'
    item.job.text.style.opacity = '0'
  }
  // A single style/layout checkpoint establishes every layer's start frame.
  if (layers[0]) void layers[0].incoming.offsetHeight
  for (const item of layers) {
    item.incoming.classList.add('is-shown')
    item.outgoing.classList.remove('is-shown')
    item.outgoing.classList.add('is-hiding')
  }
  for (const { job, incoming, outgoing, opacity } of layers) {
    const animations = [...incoming.getAnimations({ subtree: true }), ...outgoing.getAnimations({ subtree: true })]
    const restore = (): void => {
      outgoing.remove(); incoming.remove()
      job.text.style.opacity = opacity
      delete job.node.dataset.bufferTransitioning
    }
    job.restore = () => { animations.forEach(animation => animation.cancel()); restore() }
    void Promise.all(animations.map(animation => animation.finished)).then(() => {
      if (job.cancelled) return
      restore()
      job.settled()
    }).catch(() => { /* A newer message or unmount cancelled this reveal. */ })
  }
}

/** Animation layers never participate in layout, accessibility, or parent state. */
export function useExcerptReveal(
  excerpt: RefObject<HTMLDivElement | null>, body: RefObject<HTMLDivElement | null>, key: string, content: string
): boolean {
  const [settledKey, setSettledKey] = useState(key)
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const previousKey = useRef(key)
  const previousContent = useRef(content)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useLayoutEffect(() => {
    if (previousKey.current === key && settledKey === key) return
    previousKey.current = key
    const node = excerpt.current
    const text = body.current
    if (!node || !text || reduced || typeof text.getAnimations !== 'function') {
      setSettledKey(key)
      return
    }
    const job: Reveal = { node, text, previousContent: previousContent.current,
      cancelled: false, settled: () => setSettledKey(key) }
    if (!pending.size) queueMicrotask(flushReveals)
    pending.add(job)
    return () => { job.cancelled = true; pending.delete(job); job.restore?.() }
    // Settling must not restart the boundary animation.
  }, [excerpt, body, key, reduced])

  useLayoutEffect(() => { previousContent.current = content }, [content])
  return settledKey === key
}
