import { describe, expect, it } from 'vitest'
import { forwardTimeline, redirectTimeline, sampleTimeline } from '../src/renderer/src/bart-motion/motion-timeline'
import { compileCrossPageProgram, redirectCrossPageKeyframes } from '../src/renderer/src/bart-motion/cross-page-program'
import { sampleMatrix } from '../src/renderer/src/bart-motion/program'

describe('continuous Bart interruption', () => {
  it('turns around from the live position and velocity instead of restarting at an endpoint', () => {
    const original = forwardTimeline(100, 760)
    const reverse = redirectTimeline(original, 0, 380)
    expect(sampleTimeline(reverse, 380)).toEqual(sampleTimeline(original, 380))
    expect(sampleTimeline(reverse, 381).position).toBeGreaterThan(280)
    expect(sampleTimeline(reverse, 380 + reverse.duration)).toEqual({ position: 0, velocity: 0 })
    const route = compileCrossPageProgram({ a: .2, b: 0, c: 0, d: .2, e: 100, f: 500 },
      { a: .1, b: 0, c: 0, d: .1, e: 700, f: 80 }, 760, 'seat', { activity: 'idle', phase: 'idle' })
    const keys = redirectCrossPageKeyframes(route, reverse, 256)
    expect(keys[0].offset).toBe(0)
    expect(keys.at(-1)!.offset).toBe(1)
    expect(keys.every(key => key.offset! >= 0 && key.offset! <= 1)).toBe(true)
    const before = sampleMatrix(route.character!.matrices, sampleTimeline(original, 380).position)
    const after = sampleMatrix(route.character!.matrices, sampleTimeline(reverse, 380).position)
    expect(after).toEqual(before)
    const epsilon = .001
    const velocity = (track: typeof original) => {
      const a = sampleMatrix(route.character!.matrices, sampleTimeline(track, 380).position)
      const b = sampleMatrix(route.character!.matrices, sampleTimeline(track, 380 + epsilon).position)
      return (b.e - a.e) / epsilon
    }
    expect(velocity(reverse)).toBeCloseTo(velocity(original), 3)
  })
  it('accepts repeated reversals, including after the old end, without position or velocity jumps', () => {
    let track = forwardTimeline(0, 1100)
    let now = 40
    for (let i = 0; i < 80; i++) {
      now += [17, 87, 240, 1800][i % 4]
      const current = sampleTimeline(track, now)
      const next = redirectTimeline(track, i % 2 ? 1100 : 0, now)
      expect(sampleTimeline(next, now)).toEqual(current)
      for (let t = 0; t <= next.duration; t += 8) {
        const position = sampleTimeline(next, now + t).position
        expect(position).toBeGreaterThanOrEqual(0)
        expect(position).toBeLessThanOrEqual(1100)
      }
      expect(sampleTimeline(next, now + next.duration + 1)).toEqual({ position: next.to, velocity: 0 })
      track = next
    }
  })
})
