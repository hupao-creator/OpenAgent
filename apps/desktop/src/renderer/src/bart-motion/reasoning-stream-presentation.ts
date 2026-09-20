import type { ReasoningStreamStyle } from './reasoning-geometry'

const SVG = 'http://www.w3.org/2000/svg'
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), item => item.segment)
const reveal = (born: number, now: number): number => {
  const progress = Math.max(0, Math.min(1, (now - born) / 360))
  return progress * progress * (3 - 2 * progress)
}

/** Match the surviving tail so capped text can move without jumping at each delta. */
export function streamOverlap(previous: readonly string[], next: readonly string[]): number {
  for (let count = Math.min(previous.length, next.length); count > 0; count--) {
    if (previous.slice(-count).every((value, index) => value === next[index])) return count
  }
  return 0
}

/** Owned text layer, on the same SVG circle. React keeps its source text;
 * the layer only animates presentation and restores the source on disposal. */
export function createStreamPresentation(arc: SVGSVGElement, source: SVGTextElement, sourcePath: SVGTextPathElement): {
  update(mode: ReasoningStreamStyle, end: number, width: number): void
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
  let value = '', width = 0, offset = 0, target = 0
  let glyphs: { value: string; born: number; node?: SVGTSpanElement }[] = []
  let frame = 0, lastTime = 0
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
  const paint = (now: number): void => {
    const dt = Math.min(64, Math.max(0, now - lastTime))
    lastTime = now
    // Continue from the current visual position when another delta arrives.
    // This avoids restarting an easing curve at a network-chunk boundary.
    offset += (target - offset) * (1 - Math.exp(-dt / 72))
    if (Math.abs(target - offset) < .02) offset = target
    path.setAttribute('startOffset', String(offset))
    let revealing = false
    if (mode === 'soft') for (const glyph of glyphs) {
      const opacity = reveal(glyph.born, now)
      glyph.node?.setAttribute('opacity', String(opacity))
      revealing ||= opacity < 1
    }
    frame = offset !== target || revealing ? requestAnimationFrame(paint) : 0
  }

  return {
    update(nextMode, end, nextWidth) {
      const nextValue = sourcePath.textContent ?? ''
      if (nextValue === value && nextMode === mode && end === target && nextWidth === width) return
      const now = performance.now()
      const next = graphemes(nextValue)
      const overlap = streamOverlap(glyphs.map(glyph => glyph.value), next)
      const surviving = overlap ? glyphs.slice(-overlap) : []

      if (nextMode === 'direct') {
        cancelAnimationFrame(frame)
        frame = 0
        layer.remove()
        source.style.visibility = originalVisibility
        offset = end
      } else {
        if (!layer.isConnected) arc.append(layer)
        source.style.visibility = 'hidden'
        // At this offset the common substring occupies its previous position.
        // The new suffix then follows it onto the same, unchanged circular path.
        offset = mode !== 'direct' && overlap
          ? offset - width + measure(glyphs.slice(0, glyphs.length - overlap).map(glyph => glyph.value).join('')) + nextWidth
          : end
      }

      glyphs = next.map((value, index) => index < overlap ? surviving[index] : {
        value, born: nextMode === 'soft' ? now + Math.min(120, (index - overlap) * 28) : -Infinity
      })
      if (nextMode === 'soft') {
        path.replaceChildren(...glyphs.map(glyph => {
          const node = glyph.node ?? document.createElementNS(SVG, 'tspan')
          node.textContent = glyph.value
          // Existing glyphs retain their reveal age through tail truncation.
          node.setAttribute('opacity', String(reveal(glyph.born, now)))
          glyph.node = node
          return node
        }))
      } else if (nextMode === 'glide') path.textContent = nextValue

      value = nextValue
      mode = nextMode
      width = nextWidth
      target = end
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
