// The animation clock now lives in the Worker. Test the same canvas character
// there, rather than advancing a renderer rAF that production no longer uses.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createCanvasCharacter } from '../src/renderer/src/bart-motion/character-canvas'
import type { CharacterDescription } from '../src/renderer/src/bart-motion/worker-types'

let now = 0
const context = new Proxy({ getTransform: () => ({ a: 1, b: 0 }) }, {
  get: (target, key) => Reflect.get(target, key) ?? (() => undefined),
  set: (target, key, value) => Reflect.set(target, key, value)
}) as unknown as OffscreenCanvasRenderingContext2D
function character(description: CharacterDescription) {
  const actor = createCanvasCharacter(description)
  const advance = (duration: number): void => {
    const end = now + duration
    while (now < end) { now = Math.min(end, now + 16); actor.paint(context, now, 210, 210) }
  }
  return { actor, advance }
}
beforeEach(() => {
  now = 0
  vi.stubGlobal('Path2D', class {})
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(Math, 'random').mockReturnValue(0)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Worker character clocks and geometry', () => {
  it('blinks faster while waiting on the model, including the next blink without Host input', () => {
    const waiting = character({ activity: 'thinking', phase: 'running' })
    waiting.advance(1600)
    const first = waiting.actor.capture()
    expect(first.blinkStarted).toBeGreaterThanOrEqual(1400)
    expect(first.eyes[0].h).toBeLessThan(60)
    waiting.advance(1400)
    expect(waiting.actor.capture().blinkStarted).toBeGreaterThan(first.blinkStarted)
  })

  it('starts a fresh action for a second run of the same activity', () => {
    const { actor, advance } = character({ activity: 'send', phase: 'running', key: 'send-1' })
    advance(2000)
    const first = actor.capture().bounceStarted
    actor.update({ activity: 'send', phase: 'running', key: 'send-2' })
    advance(400)
    expect(actor.capture().bounceStarted).toBeGreaterThan(first)
    expect(actor.capture().shape).toBe('drop')
  })

  it('keeps the 36-point silhouette and asymmetric eye expressions across layouts', () => {
    const { actor, advance } = character({ activity: 'idle', phase: 'idle' })
    for (const layout of ['mark', 'permission', 'question', 'message'] as const) {
      actor.update({ activity: 'thinking', phase: 'running', layout })
      advance(2000)
      const pose = actor.capture()
      expect(pose.body).toHaveLength(36)
      expect(pose.body.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true)
      expect(pose.eyes.every(eye => eye.w > 0 && eye.h > 0 && eye.opacity >= 0 && eye.opacity <= 1)).toBe(true)
    }
  })

  it('gives intervention feedback priority over the activity underneath it', () => {
    const { actor, advance } = character({ activity: 'thinking', phase: 'running', intervention: 'deny' })
    advance(1500)
    expect(actor.capture()).toMatchObject({ expression: 'skeptical', eagerBlink: false, thought: false })
    actor.update({ activity: 'thinking', phase: 'running', intervention: 'allow', key: 'answer-2' })
    advance(1500)
    expect(actor.capture().expression).toBe('happy')
  })

  it('rests between gestures and schedules its own wake for the next blink or gaze', () => {
    const { actor, advance } = character({ activity: 'idle', phase: 'idle' })
    advance(1900)
    expect(actor.nextWake(now)).toBeGreaterThan(now)
    const before = actor.capture()
    advance(500)
    expect(actor.capture().gaze.x).not.toBe(before.gaze.x)
    advance(1500)
    expect(actor.capture().gaze.x).toBeCloseTo(0, 1)
  })

  it('forks the actual spring state and clocks without sharing mutable ownership', () => {
    const { actor, advance } = character({ activity: 'send', phase: 'running', key: 'travelling' })
    advance(432)
    const fork = actor.fork()
    expect(fork.capture()).toEqual(actor.capture())
    for (let index = 0; index < 12; index++) {
      now += 16
      actor.paint(context, now, 210, 210); fork.paint(context, now, 210, 210)
      expect(fork.capture()).toEqual(actor.capture())
    }
    fork.update({ activity: 'idle', phase: 'idle', key: 'new-seat' })
    expect(actor.description().key).toBe('travelling')
    expect(fork.description().key).toBe('new-seat')
  })

  it('settles a character with animation disabled without a perpetual frame loop', () => {
    const { actor, advance } = character({ activity: 'thinking', phase: 'running' })
    advance(1600)
    actor.update({ activity: 'thinking', phase: 'running', animate: false })
    advance(16)
    expect(actor.capture().eyes[0].h).toBeCloseTo(60, 0)
    expect(actor.nextWake(now)).toBe(Infinity)
  })

  it('carries the travel accent clock across a fork and retires the accent at a stop', () => {
    const strokes: number[][] = []
    const capture = new Proxy({ getTransform: () => ({ a: 1, b: 0 }), globalAlpha: 1,
      createLinearGradient(...ends: number[]) { strokes.push(ends); return { addColorStop() {} } } }, {
      get: (target, key) => Reflect.get(target, key) ?? (() => undefined),
      set: (target, key, value) => Reflect.set(target, key, value)
    }) as unknown as OffscreenCanvasRenderingContext2D
    const description: CharacterDescription = { activity: 'idle', phase: 'idle', travelTrail: {
      key: 1, duration: 3000, style: 'streaks', points: [
        { at: 0, direction: 1, strength: 0 }, { at: 200, direction: 1, strength: 1 },
        { at: 2200, direction: -1, strength: 1 }, { at: 2400, direction: -1, strength: 0 }
      ] } }
    const actor = createCanvasCharacter(description)
    now = 700
    actor.paint(capture, now, 210, 210)
    const before = strokes.splice(0)
    expect(before).toHaveLength(2)
    expect(actor.nextWake(now)).toBe(now)
    actor.fork().paint(capture, now, 210, 210)
    expect(strokes.splice(0)).toEqual(before)
    now = 2500
    actor.paint(capture, now, 210, 210)
    expect(strokes).toHaveLength(0)
    actor.update({ ...description, animate: false })
    actor.paint(capture, now, 210, 210)
    expect(strokes).toHaveLength(0)
    expect(actor.nextWake(now)).toBe(Infinity)
  })

  it('plays the delayed answer token and retires it without a Host continuation', () => {
    const ink: string[] = []
    const capture = new Proxy({ getTransform: () => ({ a: 1, b: 0 }), fillStyle: '',
      fill() { ink.push(this.fillStyle) } }, {
      get: (target, key) => Reflect.get(target, key) ?? (() => undefined),
      set: (target, key, value) => Reflect.set(target, key, value)
    }) as unknown as OffscreenCanvasRenderingContext2D
    const actor = createCanvasCharacter({ activity: 'idle', phase: 'idle', intervention: 'answer' })
    actor.paint(capture, 300, 210, 210)
    expect(ink).not.toContain('#6f5bdd')
    ink.length = 0
    actor.paint(capture, 900, 210, 210)
    expect(ink).toContain('#6f5bdd')
    ink.length = 0
    actor.paint(capture, 1700, 210, 210)
    expect(ink).not.toContain('#6f5bdd')
  })
})
