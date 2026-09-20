import type { ReasoningStreamStyle } from './reasoning-geometry'

const SVG = 'http://www.w3.org/2000/svg'
// Circle coordinates per second, before the Dock's responsive scale. A batch
// changes how much is waiting, never how fast the visible text races past.
const GLIDE_SPEED = 120
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), item => item.segment)
const reveal = (born: number, now: number): number => {
  const progress = Math.max(0, Math.min(1, (now - born) / 360))
  return progress * progress * (3 - 2 * progress)
}
type Glyph = { value: string; born: number; node?: SVGTSpanElement }

/** Match the surviving tail so capped text can move without jumping at each delta. */
export function streamOverlap(previous: readonly string[], next: readonly string[]): number {
  for (let count = Math.min(previous.length, next.length); count > 0; count--) {
    if (previous.slice(-count).every((value, index) => value === next[index])) return count
  }
  return 0
}

/** React owns the latest bounded source. This layer keeps the visible text and
 * at most that latest tail waiting beyond the circle; obsolete, unseen batches
 * are discarded without moving any glyph already on screen. */
export function createStreamPresentation(arc: SVGSVGElement, source: SVGTextElement, sourcePath: SVGTextPathElement): {
  update(mode: ReasoningStreamStyle, end: number, width: number, length: number, segmentKey: string | null): void
  dispose(): void
} {
  const originalVisibility = source.style.visibility
  const layer = document.createElementNS(SVG, 'g')
  layer.dataset.bartStreamLayer = 'true'
  const text = source.cloneNode(false) as SVGTextElement
  text.style.visibility = 'visible'
  const path = sourcePath.cloneNode(false) as SVGTextPathElement
  text.append(path)
  layer.append(text)

  let mode: ReasoningStreamStyle = 'direct'
  let segmentKey: string | null = null
  let value = '', sourceWidth = 0, width = 0, offset = 0, target = 0
  let latest: string[] = [], glyphs: Glyph[] = []
  let frame = 0, lastTime = 0
  const content = (items: readonly Glyph[]): string => items.map(glyph => glyph.value).join('')
  const measure = (content: string): number => {
    if (!content) return 0
    const probe = source.cloneNode(false) as SVGTextElement
    probe.style.visibility = 'hidden'
    probe.textContent = content
    layer.append(probe)
    const measured = probe.getComputedTextLength()
    probe.remove()
    return measured
  }
  const draw = (now: number): void => {
    if (mode === 'soft') {
      path.replaceChildren(...glyphs.map(glyph => {
        const node = glyph.node ?? document.createElementNS(SVG, 'tspan')
        node.textContent = glyph.value
        node.setAttribute('opacity', String(reveal(glyph.born, now)))
        glyph.node = node
        return node
      }))
    } else path.textContent = content(glyphs)
  }
  // Only obsolete glyphs can be removed. Always retain the entire latest source
  // so a paused stream settles on precisely that text, including mixed scripts.
  const trim = (length: number): void => {
    let obsolete = glyphs.length - latest.length
    if (obsolete <= 0) return
    const position = (index: number): number => offset - width + measure(content(glyphs.slice(0, index)))
    const boundary = (predicate: (position: number) => boolean): number => {
      let low = 0, high = obsolete + 1
      while (low < high) {
        const middle = (low + high) >>> 1
        if (predicate(position(middle))) high = middle
        else low = middle + 1
      }
      return low
    }
    // Keep the glyph crossing the exit, and all glyphs from the current source.
    const exited = Math.max(0, Math.min(obsolete, boundary(point => point > 0) - 1))
    if (exited) {
      glyphs = glyphs.slice(exited)
      width = measure(content(glyphs))
      obsolete -= exited
    }
    // Replace only fully off-circle waiting text; the visible prefix keeps its
    // position because shortening the suffix shortens the end offset equally.
    const unseen = boundary(point => point >= length)
    if (unseen < obsolete) {
      glyphs.splice(unseen, obsolete - unseen)
      const nextWidth = measure(content(glyphs))
      offset += nextWidth - width
      width = nextWidth
    }
  }
  const paint = (now: number): void => {
    const dt = Math.min(64, Math.max(0, now - lastTime))
    lastTime = now
    const distance = target - offset
    const travel = Math.min(Math.abs(distance) * (1 - Math.exp(-dt / 72)), GLIDE_SPEED * dt / 1000)
    offset += Math.sign(distance) * travel
    if (Math.abs(target - offset) < .02) offset = target
    path.setAttribute('startOffset', String(offset))
    if (offset === target && glyphs.length > latest.length) {
      glyphs = glyphs.slice(-latest.length)
      width = sourceWidth
      draw(now)
    }
    let revealing = false
    if (mode === 'soft') for (const glyph of glyphs) {
      const opacity = reveal(glyph.born, now)
      glyph.node?.setAttribute('opacity', String(opacity))
      revealing ||= opacity < 1
    }
    frame = offset !== target || revealing ? requestAnimationFrame(paint) : 0
  }

  return {
    update(nextMode, end, nextWidth, length, nextSegment) {
      const nextValue = sourcePath.textContent ?? ''
      if (nextValue === value && nextMode === mode && end === target && nextWidth === sourceWidth && segmentKey === nextSegment) return
      const now = performance.now()
      const next = graphemes(nextValue)
      const overlap = streamOverlap(latest, next)
      const fresh = (values: string[]): Glyph[] => values.map((value, index) => ({
        value, born: nextMode === 'soft' ? now + Math.min(120, index * 28) : -Infinity
      }))
      const reset = mode === 'direct' || nextMode === 'direct' ||
        segmentKey !== nextSegment ||
        (nextValue === value && (nextWidth !== sourceWidth || end !== target))

      if (nextMode === 'direct') {
        cancelAnimationFrame(frame)
        frame = 0
        layer.remove()
        source.style.visibility = originalVisibility
      } else {
        if (!layer.isConnected) arc.append(layer)
        source.style.visibility = 'hidden'
      }
      if (reset) {
        glyphs = fresh(next)
        offset = end
        width = nextWidth
      } else if (nextValue !== value) {
        glyphs.push(...fresh(next.slice(overlap)))
        const nextLayerWidth = measure(content(glyphs))
        offset += nextLayerWidth - width
        width = nextLayerWidth
      }
      segmentKey = nextSegment
      latest = next
      value = nextValue
      mode = nextMode
      sourceWidth = nextWidth
      target = end
      if (mode !== 'direct') {
        trim(length)
        draw(now)
      }
      path.setAttribute('startOffset', String(offset))
      if (mode !== 'direct' && !frame) {
        lastTime = now
        frame = requestAnimationFrame(paint)
      }
    },
    dispose() {
      cancelAnimationFrame(frame)
      layer.remove()
      source.style.visibility = originalVisibility
    }
  }
}
