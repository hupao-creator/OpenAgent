import type { ReasoningStreamStyle } from './reasoning-geometry'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export const graphemes = (value: string): string[] => Array.from(segmenter.segment(value), item => item.segment)
export interface ResidentGlyph { value: string; position: number; opacity: number }
type Glyph = { value: string; born: number }
export interface ResidentTextInput { text: string; sourceText?: string; sourceOffset?: number; segmentKey: string }

/** Worker counterpart of the SVG fallback's source-position FIFO. Only exited
 * glyphs are consumed; a bounded producer snapshot never drops unread text. */
export class ResidentText {
  private input = ''
  private inputOffset = 0
  private segment: string | undefined
  private mode: ReasoningStreamStyle = 'direct'
  private pending: string[] = []
  private glyphs: Glyph[] = []
  private boundaries = [0]
  private latestCount = 0
  private trailingSpace = false
  private offset = 0
  private width = 0
  private target = 0
  private length = 0

  clone(): ResidentText { return Object.assign(new ResidentText(), structuredClone({ ...this })) }
  private measure(measure: (text: string) => number): void {
    this.boundaries = [0]
    for (const glyph of this.glyphs) this.boundaries.push(this.boundaries.at(-1)! + measure(glyph.value) + 1.3)
    this.width = this.boundaries.at(-1)!
  }
  private feed(now: number, measure: (text: string) => number, limit = 112): void {
    const before = this.width
    const addition = this.pending.splice(0, Math.max(0, limit - this.glyphs.length))
    this.glyphs.push(...addition.map(value => ({ value, born: this.mode === 'soft' ? now : -Infinity })))
    this.measure(measure)
    this.offset += this.width - before
  }
  private append(delta: string): void {
    const normalized = ((this.trailingSpace ? ' ' : '') + delta).replace(/\s+/g, ' ')
    this.trailingSpace = normalized.endsWith(' ')
    const addition = normalized.trimEnd()
    if (!addition) return
    if (this.pending.length) this.pending.push(...graphemes(this.pending.pop()! + addition))
    else if (this.glyphs.length) {
      const previous = this.glyphs.at(-1)!
      const [first, ...rest] = graphemes(previous.value + addition)
      previous.value = first
      this.pending.push(...rest)
    } else this.pending.push(...graphemes(addition.trimStart()))
  }
  update(value: ResidentTextInput, mode: ReasoningStreamStyle, length: number, now: number, measure: (text: string) => number): void {
    const input = value.sourceText ?? value.text, offset = value.sourceOffset ?? 0
    if (this.segment === value.segmentKey && input === this.input && offset === this.inputOffset && mode === this.mode && length === this.length) return
    const end = this.inputOffset + this.input.length, nextEnd = offset + input.length
    const overlapStart = Math.max(offset, this.inputOffset), overlapEnd = Math.min(end, nextEnd)
    const continuous = offset <= end && nextEnd >= end &&
      this.input.slice(overlapStart - this.inputOffset, overlapEnd - this.inputOffset) === input.slice(overlapStart - offset, overlapEnd - offset)
    const reset = this.segment !== value.segmentKey || !continuous
    const resume = this.mode === 'direct' && mode !== 'direct'
    const latest = graphemes(value.text)
    this.latestCount = latest.length
    this.length = length
    this.target = (length + Math.min(length, latest.reduce((n, char) => n + measure(char) + 1.3, 0))) / 2
    this.mode = mode
    if (mode === 'direct' || resume && !reset) {
      this.pending = []
      this.glyphs = latest.map(value => ({ value, born: -Infinity }))
      this.trailingSpace = /\s$/.test(input)
      this.measure(measure)
      this.offset = this.target
    } else if (reset) {
      this.pending = []; this.glyphs = []; this.width = 0; this.offset = 0; this.trailingSpace = false
      this.append(input)
      this.feed(now, measure, Math.max(1, latest.length))
      this.offset = Math.max(this.width, (length + this.width) / 2)
      this.feed(now, measure)
    } else {
      this.append(input.slice(end - offset))
      this.feed(now, measure)
    }
    this.input = input; this.inputOffset = offset; this.segment = value.segmentKey
  }
  advance(dt: number, now: number, measure: (text: string) => number): void {
    if (this.mode === 'direct') return
    const obsolete = Math.max(0, Math.min(this.glyphs.length, this.glyphs.length + this.pending.length - this.latestCount))
    const destination = obsolete > 0 ? Math.min(this.target, this.width - this.boundaries[1]) : this.target
    const distance = destination - this.offset
    this.offset += Math.sign(distance) * Math.min(Math.abs(distance) * (1 - Math.exp(-dt / 72)), 120 * dt / 1000)
    if (Math.abs(destination - this.offset) < .02) this.offset = destination
    let exited = 0
    while (exited < obsolete && this.offset - this.width + this.boundaries[exited + 1] <= 0) exited++
    if (exited) { this.glyphs.splice(0, exited); this.measure(measure) }
    if (this.pending.length) this.feed(now, measure)
  }
  visible(now: number): ResidentGlyph[] {
    return this.glyphs.flatMap((glyph, index) => {
      const center = this.offset - this.width + (this.boundaries[index] + this.boundaries[index + 1]) / 2
      if (center < 0 || center > this.length) return []
      const age = Math.max(0, Math.min(1, (now - glyph.born) / 360))
      const fade = Math.min(1, center / 22, (this.length - center) / 22)
      return [{ value: glyph.value, position: this.length ? center / this.length : .5,
        opacity: fade * age * age * (3 - 2 * age) }]
    })
  }
  span(): number { return Math.min(this.length, this.width) / 90 * 180 / Math.PI }
}
