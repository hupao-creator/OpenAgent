import { describe, expect, it } from 'vitest'
import { bartColor, supportsBartGlass, tintOf } from '../src/renderer/src/bart-motion/appearance'
import { BODY_COLOR, EYE_COLOR, seatDescriptor } from '../src/renderer/src/bart-motion/character-model'
import { BART_BODY_DIAMETER, BART_BODY_RADIUS, BART_GLASS_CORNER, bartGlassBox, bartGlassFor } from '../src/renderer/src/liquid/bart-glass-recipe'
import { createLiquidFollow } from '../src/renderer/src/liquid/liquid-follow'

describe('Bart liquid material recipe', () => {
  it.each([
    ['#10110f', { r: 16 / 255, g: 17 / 255, b: 15 / 255, a: 0.8 }],
    ['#ffffff', { r: 1, g: 1, b: 1, a: 0.8 }],
    ['#000000', { r: 0, g: 0, b: 0, a: 0.8 }]
  ] as const)('normalizes %s without premultiplying the tint', (color, expected) => {
    expect(tintOf(color, 0.8)).toEqual(expected)
  })
  it('validates portable colours and rejects invalid optical values', () => {
    expect(bartColor('#ABCDEF', BODY_COLOR)).toBe('#abcdef')
    for (const color of [undefined, '', '#fff', 'red', '#gg0000']) expect(bartColor(color, EYE_COLOR)).toBe(EYE_COLOR)
    expect(() => tintOf('#bad', 0.8)).toThrow(RangeError)
    for (const alpha of [-1, 2, NaN, Infinity]) expect(() => tintOf(BODY_COLOR, alpha)).toThrow(RangeError)
    for (const scale of [0, -1, NaN, Infinity]) expect(() => bartGlassFor('light', BODY_COLOR, scale)).toThrow(RangeError)
  })
  it.each(['light', 'dark'] as const)('uses the agreed 328px circle recipe in %s', theme => {
    expect(bartGlassFor(theme)).toMatchObject({
      blur: 8, bezelWidth: 39, thickness: 234, specularOpacity: 0.6,
      shadowBlur: 78, shadowOffsetY: 23, tint: tintOf(BODY_COLOR, 0.8)
    })
    expect(BART_BODY_DIAMETER).toBe(2 * BART_BODY_RADIUS)
    expect(BART_GLASS_CORNER).toEqual({ cornerRadius: 164, cornerSmoothing: 0 })
  })
  it('scales lengths at the actual SVG size, but never scales blur or alpha', () => {
    const recipe = bartGlassFor('dark', '#ffffff', 0.1)
    expect(recipe).toMatchObject({ blur: 8, tint: { r: 1, g: 1, b: 1, a: 0.8 } })
    expect(recipe.bezelWidth).toBeCloseTo(3.9)
    expect(recipe.thickness).toBeCloseTo(23.4)
    expect(recipe.shadowBlur).toBeCloseTo(7.8)
  })
  it('admits only circular mark bodies and excludes expanded/intervention geometry', () => {
    for (const [activity, phase] of [['idle', 'idle'], ['thinking', 'running'], ['tool', 'running'], ['tool', 'completed'], ['tool', 'failed']] as const) {
      expect(supportsBartGlass('mark', seatDescriptor(activity, phase).shape)).toBe(true)
    }
    for (const shape of ['hex', 'drop', 'mark', 'triangle'] as const) expect(supportsBartGlass('mark', shape)).toBe(false)
    for (const layout of ['message', 'permission', 'question'] as const) expect(supportsBartGlass(layout, 'circle')).toBe(false)
    expect(supportsBartGlass('mark', 'circle', 'processing')).toBe(false)
  })
  it('maps the body centre, not the SVG viewport centre', () => {
    expect(bartGlassBox({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })).toEqual({ left: 156, top: 136, diameter: 328 })
    expect(bartGlassBox({ a: 0, b: 0.5, c: -0.5, d: 0, e: 500, f: 20 })).toEqual({ left: 268, top: 98, diameter: 164 })
  })
  it('does not pretend an ellipse/skew is a circle', () => {
    for (const matrix of [
      { a: 1, b: 0, c: 0, d: 2, e: 0, f: 0 },
      { a: 1, b: 0, c: 0.5, d: 1, e: 0, f: 0 },
      { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 },
      { a: 1, b: 0, c: 0, d: 1, e: NaN, f: 0 }
    ]) expect(bartGlassBox(matrix)).toBeNull()
  })
})

describe('bounded liquid invalidation', () => {
  it('coalesces a frame, extends an active window, then stops and disposes', () => {
    let time = 0, sequence = 0, draws = 0
    const callbacks = new Map<number, FrameRequestCallback>()
    const follow = createLiquidFollow(() => { draws++ }, {
      now: () => time,
      request: callback => { callbacks.set(++sequence, callback); return sequence },
      cancel: handle => { callbacks.delete(handle) }
    })
    const frame = (at: number): void => {
      time = at
      const batch = [...callbacks.values()]
      callbacks.clear()
      for (const callback of batch) callback(at)
    }
    follow.invalidate(); follow.invalidate(); follow.invalidate()
    expect(callbacks.size).toBe(1)
    frame(16)
    expect(draws).toBe(1)
    time = 200; follow.invalidate()
    frame(240)
    expect(callbacks.size).toBe(1)
    frame(440)
    expect(callbacks.size).toBe(0)
    follow.invalidate()
    expect(callbacks.size).toBe(1)
    follow.dispose()
    expect(callbacks.size).toBe(0)
    follow.invalidate(); frame(1000)
    expect(draws).toBe(3)
  })
})
