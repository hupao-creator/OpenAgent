import type { MeasuredCharacter } from './typeset'

type VisibleBounds = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>
const intersects = (rect: DOMRect, clip: VisibleBounds): boolean =>
  rect.width > 0 && rect.height > 0 && rect.right > clip.left && rect.left < clip.right &&
  rect.bottom > clip.top && rect.top < clip.bottom

/** Measure the visible prefix, without allocating or visiting its hidden tail. */
export function measureVisibleCharacters(block: HTMLElement, bounds: DOMRect, singleLine: boolean): MeasuredCharacter[] {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const points: MeasuredCharacter[] = []
  const range = document.createRange()
  const styles = new Map<Element, CSSStyleDeclaration>()
  const clips = new Map<Element, VisibleBounds>([[block, {
    left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom
  }]])
  const styleFor = (element: Element): CSSStyleDeclaration => {
    let style = styles.get(element)
    if (!style) { style = getComputedStyle(element); styles.set(element, style) }
    return style
  }
  const clipFor = (element: Element): VisibleBounds => {
    const cached = clips.get(element)
    if (cached) return cached
    const clip = { ...clipFor(element.parentElement!) }
    const style = styleFor(element)
    const clipsX = /hidden|clip|auto|scroll/.test(style.overflowX || style.overflow)
    const clipsY = /hidden|clip|auto|scroll/.test(style.overflowY || style.overflow)
    if (clipsX || clipsY) {
      const rect = element.getBoundingClientRect()
      if (clipsX) { clip.left = Math.max(clip.left, rect.left); clip.right = Math.min(clip.right, rect.right) }
      if (clipsY) { clip.top = Math.max(clip.top, rect.top); clip.bottom = Math.min(clip.bottom, rect.bottom) }
    }
    clips.set(element, clip)
    return clip
  }
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.parentElement?.closest('.thread-card-rolling-digit-old')) continue
    const clip = clipFor(node.parentElement!)
    range.selectNodeContents(node)
    if (!intersects(range.getBoundingClientRect(), clip)) continue
    const style = styleFor(node.parentElement!)
    const scale = block.offsetWidth > 0 ? block.getBoundingClientRect().width / block.offsetWidth : 1
    const lineHeight = (Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2) * scale
    let offset = 0
    while (offset < node.length) {
      const char = String.fromCodePoint(node.data.codePointAt(offset)!)
      range.setStart(node, offset); offset += char.length; range.setEnd(node, offset)
      const rect = range.getBoundingClientRect()
      if (rect.height && rect.top >= clip.bottom) break
      if (rect.left >= clip.right || rect.right <= clip.left) {
        if (singleLine || style.whiteSpace === 'nowrap') {
          // A bidi run can return into view. Stop only when its whole tail is outside.
          range.setStart(node, offset); range.setEnd(node, node.length)
          if (!intersects(range.getBoundingClientRect(), clip)) break
        } else if (style.whiteSpace === 'pre') {
          // Skip the clipped rest of a code line, retaining any following lines.
          const newline = node.data.indexOf('\n', offset)
          if (newline < 0) break
          offset = newline + 1
        }
        continue
      }
      if (!intersects(rect, clip)) continue
      points.push({ left: Math.max(rect.left, clip.left) - bounds.left,
        right: Math.min(rect.right, clip.right) - bounds.left,
        top: rect.top - bounds.top, bottom: rect.bottom - bounds.top, lineHeight,
        weight: /[，。；：,.!?]/.test(char) ? 2.15 : /\s/.test(char) ? 0.42 : char.charCodeAt(0) <= 255 ? 0.56 : 1 })
    }
  }
  return points
}
