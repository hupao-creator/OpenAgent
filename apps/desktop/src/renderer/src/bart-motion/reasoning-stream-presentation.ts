import type { ReasoningStreamStyle } from './reasoning-geometry'

const SVG = 'http://www.w3.org/2000/svg'
const GLIDE_SPEED = 120
// Only this front of the FIFO reaches SVG; unread input is plain text.
const WINDOW_GLYPHS = 112
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), item => item.segment)
const reveal = (born: number, now: number): number => {
  const progress = Math.max(0, Math.min(1, (now - born) / 360))
  return progress * progress * (3 - 2 * progress)
}
type Glyph = { value: string; born: number; node?: SVGTSpanElement }

/** Source positions feed a FIFO. The circle consumes its front at reading speed;
 * only glyphs that have left the circle are removed, never unread middle text. */
export function createStreamPresentation(arc: SVGSVGElement, source: SVGTextElement, sourcePath: SVGTextPathElement): {
  update(mode: ReasoningStreamStyle, end: number, width: number, length: number, segmentKey: string | null, input: string, inputOffset: number): void
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
  let input = '', inputOffset = 0, initialized = false
  let sourceWidth = 0, width = 0, offset = 0, target = 0, length = 0
  let latest: string[] = [], glyphs: Glyph[] = []
  let boundaries = [0]
  // The producer never edits this queue's unread middle. Repeated text is new
  // input when its absolute source position advances, even if snapshots match.
  let pending: string[] = [], read = 0
  let trailingSpace = false
  let frame = 0, lastTime = 0
  const waiting = (): boolean => read < pending.length
  const content = (items: readonly Glyph[]): string => items.map(glyph => glyph.value).join('')
  const measureGlyphs = (): number => {
    boundaries = [0]
    if (!glyphs.length) return 0
    const probe = source.cloneNode(false) as SVGTextElement
    probe.style.visibility = 'hidden'
    probe.textContent = content(glyphs)
    layer.append(probe)
    const measured = probe.getComputedTextLength()
    // All reads share one unchanged layout tree. Animation frames use cached
    // prefix geometry until the glyphs or their font/shape actually change.
    let characters = 0
    for (const glyph of glyphs) {
      characters += glyph.value.length
      boundaries.push(probe.getSubStringLength(0, characters))
    }
    probe.remove()
    return measured
  }
  const fresh = (value: string, now: number): Glyph => ({ value, born: mode === 'soft' ? now : -Infinity })
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
  const append = (delta: string): void => {
    // A terminal space is a boundary waiting for the next word, not a glyph
    // in the resting tail. Keep it out of the consumer until that word arrives.
    const normalized = ((trailingSpace ? ' ' : '') + delta).replace(/\s+/g, ' ')
    trailingSpace = normalized.endsWith(' ')
    const addition = normalized.trimEnd()
    if (!addition) return
    // Re-segment the boundary so split emoji, combining marks and whitespace
    // stay intact even when a provider divides them between updates.
    if (waiting()) {
      const previous = pending.pop()!
      pending.push(...graphemes(previous + addition))
    } else if (glyphs.length) {
      const previous = glyphs.at(-1)!
      const [first, ...rest] = graphemes(previous.value + addition)
      previous.value = first
      pending.push(...rest)
      const nextWidth = measureGlyphs()
      offset += nextWidth - width
      width = nextWidth
    } else pending.push(...graphemes(addition.trimStart()))
  }
  const feed = (now: number, limit = WINDOW_GLYPHS): boolean => {
    const count = Math.min(limit - glyphs.length, pending.length - read)
    if (count <= 0) return false
    for (let index = 0; index < count; index++) glyphs.push(fresh(pending[read++], now))
    if (read === pending.length || read > 1024) { pending = pending.slice(read); read = 0 }
    const nextWidth = measureGlyphs()
    offset += nextWidth - width
    width = nextWidth
    return true
  }
  const trim = (): boolean => {
    const obsolete = waiting() ? glyphs.length : glyphs.length - latest.length
    if (obsolete <= 0) return false
    const position = (index: number): number => offset - width + boundaries[index]
    if (position(1) > 0) return false
    let low = 0, high = obsolete + 1
    while (low < high) {
      const middle = (low + high) >>> 1
      if (position(middle) > 0) high = middle
      else low = middle + 1
    }
    const exited = Math.max(0, Math.min(obsolete, low - 1))
    if (!exited) return false
    glyphs = glyphs.slice(exited)
    width = measureGlyphs()
    return true
  }
  const paint = (now: number): void => {
    const dt = Math.min(64, Math.max(0, now - lastTime))
    lastTime = now
    // Even a visible glyph followed by zero-width characters must fully leave
    // the circle, freeing a slot for the next queued glyph.
    const destination = waiting() ? Math.min(target, width - boundaries[1]) : target
    const distance = destination - offset
    const travel = Math.min(Math.abs(distance) * (1 - Math.exp(-dt / 72)), GLIDE_SPEED * dt / 1000)
    offset += Math.sign(distance) * travel
    if (Math.abs(destination - offset) < .02) offset = destination
    const trimmed = trim()
    const fed = feed(now)
    if (!waiting() && offset === target) {
      // Finish on the same whitespace-trimmed visual tail as direct mode.
      glyphs = latest.map(value => fresh(value, -Infinity))
      width = sourceWidth
      draw(now)
    } else if (trimmed || fed) draw(now)
    path.setAttribute('startOffset', String(offset))
    let revealing = false
    if (mode === 'soft') for (const glyph of glyphs) {
      const opacity = reveal(glyph.born, now)
      glyph.node?.setAttribute('opacity', String(opacity))
      revealing ||= opacity < 1
    }
    frame = waiting() || offset !== target || revealing ? requestAnimationFrame(paint) : 0
  }

  return {
    update(nextMode, end, nextWidth, nextLength, nextSegment, nextInput, nextInputOffset) {
      if (initialized && nextInput === input && nextInputOffset === inputOffset && nextMode === mode &&
        end === target && nextWidth === sourceWidth && nextLength === length && segmentKey === nextSegment) return
      const now = performance.now()
      const inputEnd = inputOffset + input.length
      const nextEnd = nextInputOffset + nextInput.length
      const overlapStart = Math.max(inputOffset, nextInputOffset)
      const overlapEnd = Math.min(inputEnd, nextEnd)
      const continuous = nextInputOffset <= inputEnd && nextEnd >= inputEnd &&
        input.slice(overlapStart - inputOffset, overlapEnd - inputOffset) ===
        nextInput.slice(overlapStart - nextInputOffset, overlapEnd - nextInputOffset)
      const reset = !initialized || segmentKey !== nextSegment || !continuous
      const resume = initialized && mode === 'direct' && nextMode !== 'direct' && !reset
      mode = nextMode
      latest = graphemes(sourcePath.textContent ?? '')
      sourceWidth = nextWidth
      target = end
      length = nextLength

      // SVG probes need a connected layout tree, including the first burst.
      if (mode !== 'direct' && !layer.isConnected) arc.append(layer)
      if (mode === 'direct' || resume) {
        pending = []; read = 0
        trailingSpace = /\s$/.test(nextInput)
        glyphs = latest.map(value => fresh(value, now))
        width = nextWidth; offset = end
      } else if (reset) {
        pending = []; read = 0; glyphs = []; width = 0; offset = 0; trailingSpace = false
        append(nextInput)
        feed(now, Math.max(1, latest.length))
        offset = Math.max(width, (length + width) / 2)
        feed(now)
      } else {
        const nextLayerWidth = measureGlyphs()
        offset += nextLayerWidth - width
        width = nextLayerWidth
        append(nextInput.slice(inputEnd - nextInputOffset))
        feed(now)
      }
      input = nextInput
      inputOffset = nextInputOffset
      segmentKey = nextSegment
      initialized = true
      if (mode === 'direct') {
        cancelAnimationFrame(frame)
        frame = 0
        layer.remove()
        source.style.visibility = originalVisibility
      } else {
        source.style.visibility = 'hidden'
        draw(now)
        path.setAttribute('startOffset', String(offset))
        if (!frame) { lastTime = now; frame = requestAnimationFrame(paint) }
      }
    },
    dispose() {
      cancelAnimationFrame(frame)
      pending = []; glyphs = []
      layer.remove()
      source.style.visibility = originalVisibility
    }
  }
}
