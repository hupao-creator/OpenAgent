import { afterEach, expect, it, vi } from 'vitest'
import { createCanvasCharacter } from '../src/renderer/src/bart-motion/character-canvas'
import { CAPSULE_DOT_AT, LAUNCH_DURATION, sampleLaunch, sampleLaunchCapsule, type CharacterLaunch } from '../src/renderer/src/bart-motion/launch-story'
import { RUNNING_DOT_RADIUS, sampleRunningStory } from '../src/renderer/src/bart-motion/running-story'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const launch = (): CharacterLaunch => ({ key: 1, startedAt: performance.timeOrigin, speed: 1,
  capsule: { x: -200, y: 500, width: 1040, height: 150 }, radius: 80, bodyOffset: { x: 0, y: -90 } })
it('joins the shrinking capsule to exactly one dot before handing all three to beat zero', () => {
  const landed = sampleLaunchCapsule(launch(), CAPSULE_DOT_AT)
  const middle = sampleLaunch(CAPSULE_DOT_AT, false).dots[1]
  expect(landed.x + landed.width / 2).toBeCloseTo(middle.x)
  expect(landed.y + landed.height / 2).toBeCloseTo(middle.y)
  expect(landed.radius).toBeCloseTo(RUNNING_DOT_RADIUS)
  expect(landed.color).toBe(middle.color)
  expect(landed.opacity).toBeCloseTo(middle.opacity)
  expect(sampleLaunch(CAPSULE_DOT_AT - 1, false).dots[1].opacity).toBe(0)
  expect(sampleLaunch(LAUNCH_DURATION, false).dots.map(({ x, y, opacity, color }) => ({ x, y, opacity, color }))).toEqual(sampleRunningStory(0).dots)
  expect(sampleLaunch(0, true)).toEqual(sampleLaunch(LAUNCH_DURATION, true))
})
it('the Worker finishes the capsule and begins the orbit without any further Host updates', () => {
  let now = 0
  vi.stubGlobal('Path2D', class {})
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const roundRect = vi.fn(), arc = vi.fn()
  const ctx = new Proxy({ getTransform: () => ({ a: 1, b: 0 }), roundRect, arc }, {
    get: (target, key) => Reflect.get(target, key) ?? (() => undefined),
    set: (target, key, value) => Reflect.set(target, key, value)
  }) as unknown as OffscreenCanvasRenderingContext2D
  const actor = createCanvasCharacter({ activity: 'idle', phase: 'running', role: 'running', launch: launch() })
  actor.paint(ctx, now, 640, 640)
  expect(roundRect.mock.calls.some(call => call[2] === 1040)).toBe(true)
  for (now = 16; now < 5600; now += 16) {
    roundRect.mockClear(); arc.mockClear()
    actor.paint(ctx, now, 640, 640)
  }
  expect(roundRect.mock.calls.every(call => call[2] < 100)).toBe(true) // only the eyes remain
  const dots = arc.mock.calls.filter(call => call[2] === RUNNING_DOT_RADIUS)
  expect(dots).toHaveLength(3)
  expect(dots.some(call => call[1] < 450)).toBe(true)
  expect(actor.nextWake(now)).toBe(now)
})

it('keeps the native character scale when a padded Dock actor is borrowed into a flight', () => {
  vi.stubGlobal('Path2D', class {})
  const scale = vi.fn()
  const ctx = new Proxy({ getTransform: () => ({ a: 1, b: 0 }), scale }, {
    get: (target, key) => Reflect.get(target, key) ?? (() => undefined),
    set: (target, key, value) => Reflect.set(target, key, value)
  }) as unknown as OffscreenCanvasRenderingContext2D
  const viewport = [-360, -600, 1360, 1400] as const
  const actor = createCanvasCharacter({ activity: 'idle', phase: 'idle', animate: false, viewport })
  actor.paint(ctx, 0, 1360, 1400, viewport)
  expect(scale.mock.calls[0]).toEqual([1, 1])
  scale.mockClear()
  // The flight uses its own native raster, even before the Host supplies a new pose.
  actor.fork().paint(ctx, 0, 640, 640)
  expect(scale.mock.calls[0]).toEqual([1, 1])
})
