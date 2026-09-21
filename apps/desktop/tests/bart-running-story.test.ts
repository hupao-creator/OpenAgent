import { expect, it } from 'vitest'
import { RUNNING_BEAT_MS, sampleRunningStory } from '../src/renderer/src/bart-motion/running-story'

it('keeps three beats at the bottom, then sends each light exactly once around Bart and home', () => {
  const start = sampleRunningStory(0), unit = 640 / 210
  expect(RUNNING_BEAT_MS * 3).toBe(8400)
  for (let dot = 0; dot < 3; dot++) {
    const beat = sampleRunningStory((dot + .5) / 3)
    expect(beat.dots[dot].y).toBeCloseTo(start.dots[dot].y - 3 * unit)
    expect(beat.dots.filter((_, i) => i !== dot).map(p => p.y)).toEqual(
      start.dots.filter((_, i) => i !== dot).map(p => p.y))
    let previous = 0, rotation = 0
    for (let step = 0; step <= 100; step++) {
      const point = sampleRunningStory(1.22 + 1.33 * step / 100).dots[dot]
      expect(Math.hypot(point.x - 320, point.y - 300)).toBeCloseTo(78 * unit)
      const angle = Math.atan2(point.y - 300, point.x - 320)
      if (step) rotation += (angle - previous + Math.PI * 3) % (Math.PI * 2) - Math.PI
      previous = angle
    }
    expect(rotation).toBeCloseTo(Math.PI * 2)
    const landed = sampleRunningStory(2.78).dots[dot]
    expect(landed.x).toBeCloseTo(start.dots[dot].x)
    expect(landed.y).toBeCloseTo(start.dots[dot].y)
  }
  expect(sampleRunningStory(3)).toEqual(start)
})

it('keeps eyes and lights continuous across all stages, with a stable reduced-motion frame', () => {
  for (const at of [1, 1.22, 2.55, 2.78, 3]) {
    const before = sampleRunningStory(at - .00001), after = sampleRunningStory(at + .00001)
    for (const key of ['x', 'y', 'scaleX', 'scaleY'] as const) expect(Math.abs(before.eyes[key] - after.eyes[key])).toBeLessThan(.01)
    before.dots.forEach((dot, i) => {
      expect(Math.hypot(dot.x - after.dots[i].x, dot.y - after.dots[i].y)).toBeLessThan(.01)
    })
  }
  const still = sampleRunningStory(0, true)
  expect(still.eyes).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1 })
  expect(sampleRunningStory(1.8, true)).toEqual(still)
  expect(sampleRunningStory(8, true)).toEqual(still)
  expect(sampleRunningStory(1.8).eyes.x).toBeLessThan(0)
  expect(sampleRunningStory(2.2).eyes.x).toBeGreaterThan(0)
})
