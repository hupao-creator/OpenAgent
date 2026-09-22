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

function snapshot(body: HTMLElement, excerpt: HTMLElement): Snapshot {
  const copy = body.cloneNode(true) as HTMLElement
  copy.style.removeProperty('opacity')
  return { body: copy, height: Math.min(body.getBoundingClientRect().height, excerpt.getBoundingClientRect().height),
    lineHeight: Number.parseFloat(getComputedStyle(body).lineHeight) || 18 }
}

/** Animation layers never participate in layout, accessibility, or parent state. */
export function useExcerptReveal(
  excerpt: RefObject<HTMLDivElement | null>, body: RefObject<HTMLDivElement | null>, key: string, content: string
): boolean {
  const [settledKey, setSettledKey] = useState(key)
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const previousKey = useRef(key)
  const previous = useRef<Snapshot | null>(null)

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
    const incoming = lineLayer(snapshot(text, node))
    const outgoing = lineLayer(previous.current ?? snapshot(text, node))
    outgoing.classList.add('is-shown', 'thread-card-reveal-previous')
    node.append(outgoing, incoming)
    node.dataset.bufferTransitioning = 'texts'
    const opacity = text.style.opacity
    text.style.opacity = '0'
    void incoming.offsetHeight
    incoming.classList.add('is-shown')
    outgoing.classList.remove('is-shown')
    outgoing.classList.add('is-hiding')
    const animations = [...incoming.getAnimations({ subtree: true }), ...outgoing.getAnimations({ subtree: true })]
    let disposed = false
    const restore = (): void => {
      outgoing.remove()
      incoming.remove()
      text.style.opacity = opacity
      delete node.dataset.bufferTransitioning
    }
    void Promise.all(animations.map(animation => animation.finished)).then(() => {
      if (disposed) return
      restore()
      setSettledKey(key)
    }).catch(() => { /* A newer message or unmount cancelled this reveal. */ })
    return () => {
      disposed = true
      animations.forEach(animation => animation.cancel())
      restore()
    }
    // Settling must not restart the boundary animation.
  }, [excerpt, body, key, reduced])

  useLayoutEffect(() => {
    if (body.current && excerpt.current) previous.current = snapshot(body.current, excerpt.current)
  }, [content, body, excerpt])
  return settledKey === key
}
