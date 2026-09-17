import { describe, expect, it } from 'vitest'
import { cameraFrame, ramp } from '../src/renderer/src/bart-thread-transition/transitions'
import { eyeDivePose } from '../src/renderer/src/bart-thread-transition/eye-dive'

describe('Bart camera trajectory', () => {
  const world = { width: 1440, height: 900, x: 1220, y: 740, radius: 60 }

  it('starts at the exact Overview position and brings Bart to the viewport center', () => {
    const start = cameraFrame(world, 0)
    expect(start.scale).toBe(1)
    expect(start.x).toBe(0)
    expect(start.y).toBe(0)
    const end = cameraFrame(world, 1)
    expect(world.x * end.scale + end.x).toBeCloseTo(world.width / 2)
    expect(world.y * end.scale + end.y).toBeCloseTo(world.height / 2)
    expect(end.scale * world.radius).toBeGreaterThan(Math.hypot(world.width, world.height) / 2)
  })

  it('keeps moving toward Bart without scale overshoot or invalid tiny-eye geometry', () => {
    for (const radius of [0, 3, 60]) {
      let lastScale = 1
      for (let step = 0; step <= 100; step++) {
        const frame = cameraFrame({ ...world, radius }, step / 100)
        expect(Number.isFinite(frame.x + frame.y + frame.scale)).toBe(true)
        expect(frame.scale).toBeGreaterThanOrEqual(lastScale)
        lastScale = frame.scale
      }
    }
  })

  it('holds the ends of each narrative interval during scrubbing', () => {
    expect(ramp(0.58, 0.79, 0.2)).toBe(0)
    expect(ramp(0.58, 0.79, 0.9)).toBe(1)
    expect(ramp(0.58, 0.79, 0.685)).toBeCloseTo(0.5)
  })
})

describe('Bart reacts to the approaching camera', () => {
  it('joins the captured expression without moving or deforming the first frame', () => {
    const pose = eyeDivePose(0)
    const identity = {
      attention: 0, blink: 1, bodyX: 0, bodyY: 0,
      bodyScaleX: 1, bodyScaleY: 1, bodyRotation: 0, cameraProgress: 0, focusLock: 0
    }
    for (const key of Object.keys(identity) as Array<keyof typeof identity>) expect(pose[key]).toBeCloseTo(identity[key])
  })

  it('notices, opens the entrance eye, then settles before the camera passes through', () => {
    const notice = eyeDivePose(0.075)
    const curious = eyeDivePose(0.34)
    const settled = eyeDivePose(0.58)
    expect(notice.blink).toBeLessThan(0.6)
    expect(notice.bodyScaleY).toBeLessThan(1)
    expect(curious.eyeWidth).toBeGreaterThan(curious.otherEyeWidth * 2)
    expect(settled.eyeWidth).toBeGreaterThan(0.5)
    expect(settled).toMatchObject({ bodyX: 0, bodyY: 0, bodyScaleX: 1, bodyScaleY: 1, bodyRotation: 0, blink: 1, focusLock: 1 })
    expect(eyeDivePose(1).cameraProgress).toBe(1)
  })

  it('stays continuous and reversible without camera overshoot', () => {
    const frames = Array.from({ length: 1001 }, (_, index) => eyeDivePose(index / 1000))
    for (let index = 1; index < frames.length; index++) {
      const previous = frames[index - 1]!
      const current = frames[index]!
      expect(current.cameraProgress).toBeGreaterThanOrEqual(previous.cameraProgress)
      expect(current.eyeWidth).toBeGreaterThan(0)
      expect(current.eyeHeight).toBeGreaterThan(0)
      expect(current.otherEyeHeight).toBeGreaterThan(0)
      for (const key of Object.keys(current) as Array<keyof typeof current>) {
        expect(Number.isFinite(current[key])).toBe(true)
        expect(Math.abs(current[key] - previous[key])).toBeLessThan(0.3)
      }
    }
    for (let index = 1000; index >= 0; index--) expect(eyeDivePose(index / 1000)).toEqual(frames[index])
  })
})
