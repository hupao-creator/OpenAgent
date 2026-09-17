import { describe, expect, it } from 'vitest'
import { createCaretSampler, createClipSampler, typesetBlock, type MeasuredCharacter } from '../labs/bart/src/generation-typeset'

const character = (left: number, right: number, top: number): MeasuredCharacter => ({
  left, right, top, bottom: top + 14, lineHeight: 22, weight: 1
})
const input = [character(0, 10, 3.5), character(10, 20, 3.5),
  character(0, 10, 25.5), character(10, 20, 25.5)]
const vertices = (frame: Keyframe): number[] => String(frame.clipPath).match(/-?\d+(?:\.\d+)?/g)!.map(Number)

describe('Lab generation line reveal', () => {
  it('samples normal playback with full line height and an atomic wrap for both paint and caret', () => {
    const { frames, caret } = typesetBlock(input, { width: 100, height: 44 }, 400)
    const clip = createClipSampler(frames)
    const position = createCaretSampler(caret)
    const firstLine = vertices({ clipPath: clip(0.375) })
    expect(firstLine[6]).toBe(15)
    expect(firstLine[9]).toBeGreaterThanOrEqual(21.5)
    expect(position(199.5)).toEqual({ x: 19.95, y: 10.5 })
    expect(position(200)).toEqual({ x: 0, y: 32.5 })
    expect(position(200.5)).toEqual({ x: 0.05, y: 32.5 })
    expect(vertices({ clipPath: clip(0.5) })[6]).toBe(0)
    expect(vertices({ clipPath: clip(0.5) })[5]).toBeGreaterThanOrEqual(17.5)
  })

  it('keeps the entire Bart circle inside the card while the provider logo finishes revealing', () => {
    // Real layout: card right=771, logo right=755, Bart radius=9 and lead=10.
    // Following the reveal front without containment puts Bart beyond the card.
    const { frames, caret } = typesetBlock([
      { left: 0, right: 29, top: 0, bottom: 22, lineHeight: 22, weight: 1 }
    ], { width: 29, height: 22, singleLine: true }, 100)
    const position = createCaretSampler(caret.map(point => ({ ...point,
      x: 726 + point.x + 10, y: 146.75 + point.y
    })), { left: 411, top: 131, right: 771, bottom: 331, radius: 9, inset: 4 })
    for (const at of [0, 50, 80, 99, 100, 134]) {
      expect(position(at).x + 9).toBeLessThanOrEqual(771 - 4)
      expect(position(at).y).toBe(157.75)
    }
    expect(position(50).x).toBe(750.5)
    // Containing Bart must not shorten or slow the logo's reveal.
    expect(vertices({ clipPath: createClipSampler(frames)(1) })[6]).toBeGreaterThanOrEqual(29)
  })

  it('keeps the model row full-height when a rolling clock glyph moves above its baseline', () => {
    // Measured browser failure: normal text at y=1, an outgoing timer digit at
    // y=-8.5, then its replacement at y=1. These are one 13px metadata row.
    const normal = { left: 0, right: 116.9, top: 1, bottom: 12.5, lineHeight: 11.4, weight: 20 }
    const outgoing = { ...normal, left: 116.9, right: 120.8, top: -8.5, bottom: 3, weight: 1 }
    const incoming = { ...normal, left: 116.9, right: 122.7, weight: 1 }
    const { frames, caret } = typesetBlock([normal, outgoing, incoming],
      { width: 326, height: 13, singleLine: true }, 400)
    const modelFrame = vertices(frames.find(frame => frame.offset === 20 / 22)!)
    expect(modelFrame[5]).toBeLessThanOrEqual(0)
    expect(modelFrame[9]).toBeGreaterThanOrEqual(13)
    expect(new Set(caret.map(point => point.y)).size).toBe(1)
  })

  it('reveals full line height, including leading and fractional glyph bounds', () => {
    const { frames } = typesetBlock(input, { width: 100, height: 44 }, 400)
    const firstCharacter = vertices(frames.find(frame => frame.offset === 0.25)!)
    // The whole first line is visible vertically, not only the 14px font box.
    expect(firstCharacter[5]).toBeLessThanOrEqual(-0.5)
    expect(firstCharacter[9]).toBeGreaterThanOrEqual(21.5)
    expect(firstCharacter[6]).toBe(10)
  })

  it('teleports to the next line at the exact end of the preceding character', () => {
    const { caret } = typesetBlock(input, { width: 100, height: 44 }, 400)
    const boundary = caret.filter(point => point.at === 200)
    expect(boundary[0]).toMatchObject({ x: 20, y: 10.5 })
    expect(boundary.at(-1)).toMatchObject({ x: 0, y: 32.5 })
    for (let index = 1; index < caret.length; index++) {
      if (caret[index]!.y !== caret[index - 1]!.y) {
        expect(caret[index]!.at).toBe(caret[index - 1]!.at)
      }
    }
    // The next line's first character still gets its own full 100ms reveal.
    expect(caret.find(point => point.at === 300)).toEqual({ x: 10, y: 32.5, at: 300 })
  })

  it('does not interpolate line boundaries or mix inset and polygon shapes', () => {
    const { frames } = typesetBlock(input, { width: 100, height: 44 }, 400)
    for (const frame of frames) expect(String(frame.clipPath)).toMatch(/^polygon\(/)
    for (let index = 1; index < frames.length - 1; index++) {
      const before = frames[index - 1]!, after = frames[index]!
      if (after.offset === before.offset) continue
      expect(vertices(after)[5]).toBe(vertices(before)[5])
      expect(vertices(after)[9]).toBe(vertices(before)[9])
    }
    const boundary = frames.filter(frame => frame.offset === 0.5)
    expect(vertices(boundary[0]!)[6]).toBe(20)
    expect(vertices(boundary.at(-1)!)[6]).toBe(0)
  })

  it('handles empty blocks without invalid geometry or caret points', () => {
    const result = typesetBlock([], { width: 22, height: 22 }, 40)
    expect(result.caret).toEqual([])
    expect(result.frames.map(frame => frame.offset)).toEqual([0, 1])
    expect(result.frames.every(frame => vertices(frame).every(Number.isFinite))).toBe(true)
  })
})
