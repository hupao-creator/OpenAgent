// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureVisibleCharacters } from '../labs/bart/src/generation-content'

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

function textLayout(text: string, width: number, height: number, wrap: boolean, codeUnits = 1) {
  const block = document.createElement('div')
  block.style.cssText = 'font-size:10px;line-height:20px;overflow:hidden'
  block.textContent = text
  document.body.append(block)
  const bounds = new DOMRect(0, 0, width, height)
  vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(bounds)
  const rects = vi.fn(function (this: Range) {
    const count = (this.endOffset - this.startOffset) / codeUnits
    const start = this.startOffset / codeUnits
    if (count > 1) return new DOMRect(wrap ? 0 : start * 10, 3, wrap ? width : count * 10,
      wrap ? Math.ceil(count / (width / 10)) * 20 - 6 : 14)
    return new DOMRect(wrap ? (start % (width / 10)) * 10 : start * 10,
      (wrap ? Math.floor(start / (width / 10)) * 20 : 0) + 3, 10, 14)
  })
  // jsdom has no layout engine; supply measured line boxes at the Range seam.
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = new Range()
    range.getBoundingClientRect = rects
    return range
  })
  return { block, bounds, rects }
}

describe('Lab generation visible content costs', () => {
  it.each([['文', 1], ['😀', 2]] as const)('stops measuring the hidden tail of a long %s paragraph', (glyph, codeUnits) => {
    const { block, bounds, rects } = textLayout(glyph.repeat(10_000), 100, 40, true, codeUnits)
    const points = measureVisibleCharacters(block, bounds, false)
    expect(points).toHaveLength(20)
    expect(points.at(-1)).toMatchObject({ left: 90, right: 100, top: 23, bottom: 37 })
    expect(rects.mock.calls.length).toBeLessThanOrEqual(22)
  })

  it('does not spend animation time on the clipped suffix of a single-line title', () => {
    const { block, bounds, rects } = textLayout('文'.repeat(10_000), 40, 20, false)
    expect(measureVisibleCharacters(block, bounds, true)).toHaveLength(4)
    expect(rects.mock.calls.length).toBeLessThanOrEqual(7)
  })

  it('respects a nested text container that clips before the card boundary', () => {
    const { block, bounds, rects } = textLayout('文'.repeat(10_000), 100, 40, true)
    const inner = document.createElement('div')
    inner.style.cssText = 'font-size:10px;line-height:20px;overflow:hidden'
    inner.append(block.firstChild!)
    block.append(inner)
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 20))
    expect(measureVisibleCharacters(block, bounds, false)).toHaveLength(10)
    expect(rects.mock.calls.length).toBeLessThanOrEqual(12)
  })

  it('rejects a whole offscreen text node before visiting its characters', () => {
    const { block, bounds, rects } = textLayout('文'.repeat(10_000), 100, 40, true)
    rects.mockReturnValue(new DOMRect(0, 80, 100, 20_000))
    expect(measureVisibleCharacters(block, bounds, false)).toEqual([])
    expect(rects).toHaveBeenCalledTimes(1)
  })

  it('skips a clipped code-line suffix while retaining the next visible line', () => {
    const { block, bounds, rects } = textLayout(`${'文'.repeat(10_000)}\n甲`, 100, 40, false)
    block.style.whiteSpace = 'pre'
    rects.mockImplementation(function (this: Range) {
      if (this.endOffset - this.startOffset > 1) return new DOMRect(0, 3, 100_000, 34)
      return this.startOffset <= 10_000
        ? new DOMRect(this.startOffset * 10, 3, 10, 14)
        : new DOMRect(0, 23, 10, 14)
    })
    const points = measureVisibleCharacters(block, bounds, false)
    expect(points).toHaveLength(11)
    expect(points.at(-1)).toMatchObject({ left: 0, right: 10, top: 23 })
    expect(rects.mock.calls.length).toBeLessThanOrEqual(13)
  })
})
