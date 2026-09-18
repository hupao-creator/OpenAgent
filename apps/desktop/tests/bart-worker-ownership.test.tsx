import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forwardTimeline, redirectTimeline } from '../src/renderer/src/bart-motion/motion-timeline'
import type { MotionWorkerRequest, MotionWorkerResponse } from '../src/renderer/src/bart-motion/worker-types'

vi.mock('../src/renderer/src/bart-motion/webgl-renderer', () => ({
  createBartWebGLRenderer: () => ({ upload: vi.fn(), updateTexture: vi.fn(), draw: vi.fn(), releaseTextures: vi.fn(), clear: vi.fn(), resize: vi.fn(), dispose: vi.fn() })
}))
let now = 0, sequence = 0
let frames: Map<number, FrameRequestCallback>, messages: MotionWorkerResponse[]
let runtime: { onmessage?: (message: { data: MotionWorkerRequest }) => void }
class Canvas {
  static created: Canvas[] = []
  width: number; height: number
  paints = 0
  scales: number[][] = []
  images: unknown[] = []
  /** Every `fill()`'s colour, in order, so a test can tell a drawn body from a
   * suppressed one without reaching into the character. */
  fills: string[] = []
  listeners = new Map<string, () => void>()
  constructor(width = 1, height = 1) { this.width = width; this.height = height; Canvas.created.push(this) }
  getContext() {
    const target = { fillStyle: '', getTransform: () => ({ a: 1, b: 0 }),
      clearRect: () => { this.paints++; this.scales = [] },
      scale: (x: number, y: number) => this.scales.push([x, y]),
      drawImage: (image: unknown) => this.images.push(image),
      fill: () => { this.fills.push(String(target.fillStyle)) } }
    return new Proxy(target, {
      get: (target, key) => Reflect.get(target, key) ?? (() => undefined), set: (target, key, value) => Reflect.set(target, key, value)
    })
  }
  addEventListener(event: string, listener: () => void) { this.listeners.set(event, listener) }
}
const send = (data: MotionWorkerRequest): void => runtime.onmessage!({ data })
const attach = (surface: string, kind: 'character' | 'scene' | 'raster-scene') => {
  const canvas = new Canvas()
  send({ type: 'attach', surface, kind, canvas: canvas as unknown as OffscreenCanvas, width: 50, height: 50, pixelRatio: 1 })
  return canvas
}
const tick = (at: number): void => { now = at; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(at)) }
const inspect = () => { send({ type: 'inspect', surface: 'inspection' }); return messages.at(-1) as Extract<MotionWorkerResponse, { type: 'inspected' }> }
const description = { activity: 'thinking' as const, phase: 'running' as const, key: 'resident' }
const program = { duration: 1000, poses: [], textures: [], phases: [], character: { destination: 'destination', aimAt: 400, description,
  matrices: [{ at: 0, a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, { at: 1000, a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 }] } }

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); now = 0; sequence = 0; frames = new Map(); messages = []
  Canvas.created.length = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('Path2D', class { addPath() {} })
  vi.stubGlobal('OffscreenCanvas', Canvas)
  runtime = { postMessage: (message: MotionWorkerResponse) => messages.push(message),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence },
    cancelAnimationFrame: (id: number) => frames.delete(id), setTimeout, clearTimeout } as typeof runtime
  vi.stubGlobal('self', runtime)
  await import('../src/renderer/src/bart-motion/motion.worker')
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Worker surface and run ownership', () => {
  it('paints every supplied 120Hz flight frame without a lower internal rate cap', () => {
    attach('source', 'character'); attach('destination', 'character')
    const flight = attach('scene', 'raster-scene')
    send({ type: 'character', surface: 'source', request: 1, description })
    send({ type: 'character', surface: 'destination', request: 2, description })
    send({ type: 'borrow-character', surface: 'scene', source: 'source', request: 3 })
    send({ type: 'play', surface: 'scene', run: 10, program })
    const first = flight.paints
    for (let frame = 1; frame <= 120; frame++) {
      tick(frame * 1000 / 120)
      expect(flight.paints).toBe(first + frame)
    }
    expect(messages.filter(message => message.type === 'failed')).toEqual([])
  })
  it.each(['scene', 'raster-scene'] as const)('%s holds native characters during flight, rejects stale landing and ignores stale release/play', async kind => {
    const source = attach('source', 'character'), destination = attach('destination', 'character')
    attach('scene', kind)
    send({ type: 'character', surface: 'source', request: 1, description })
    send({ type: 'character', surface: 'destination', request: 2, description })
    send({ type: 'borrow-character', surface: 'scene', source: 'source', request: 3 })
    send({ type: 'play', surface: 'scene', run: 10, program })
    const held = [source.paints, destination.paints]
    tick(500)
    expect([source.paints, destination.paints]).toEqual(held)
    send({ type: 'release', surface: 'scene', run: 9 })
    send({ type: 'play', surface: 'scene', run: 9, program })
    send({ type: 'land-character', surface: 'scene', run: 9, request: 4 })
    expect(messages.at(-1)).toMatchObject({ type: 'rejected', request: 4 })
    expect(inspect().stats).toMatchObject({ surfaces: 3, textures: kind === 'scene' ? 1 : 0 })
    tick(1100)
    expect(messages).toContainEqual(expect.objectContaining({ type: 'performed', run: 10 }))
    send({ type: 'land-character', surface: 'scene', run: 10, request: 5 })
    expect(destination.paints).toBeGreaterThan(held[1])
    send({ type: 'release', surface: 'scene', run: 10 })
    await Promise.resolve(); tick(1116)
    expect(source.paints).toBeGreaterThan(held[0])
    expect(inspect().stats).toMatchObject({ surfaces: 3, textures: 0, textureBytes: 0 })
    expect(messages.filter(message => message.type === 'failed')).toEqual([])
  })
  it('flights a glass resident as a solid body and leaves the resident its glass', () => {
    const source = attach('source', 'character')
    attach('destination', 'character')
    attach('scene', 'raster-scene')
    // `animate: false` snaps the silhouette to its target, so the body decision
    // here turns on material alone rather than on a spring still settling.
    const glass = { ...description, animate: false, bodyMaterial: 'liquidGlass' as const, bodyColor: '#123456' }
    send({ type: 'character', surface: 'source', request: 1, description: glass })
    send({ type: 'character', surface: 'destination', request: 2, description: glass })
    send({ type: 'borrow-character', surface: 'scene', source: 'source', request: 3 })
    send({ type: 'play', surface: 'scene', run: 10, program })
    tick(100)
    // The flight scene has no glass stage behind it, so the actor it draws must
    // already carry its own body. `aimAt` is 400 of this 1000ms program, so the
    // borrowed copy is the only thing on screen here.
    const raster = Canvas.created.find(canvas => canvas.width === 512 && canvas.height === 512)!
    expect(raster.fills).toContain('#123456')
    // Handing the flight a copy must not downgrade the resident: it is still the
    // glass-acknowledged actor, so its own body stays suppressed.
    send({ type: 'release', surface: 'scene', run: 10 })
    return Promise.resolve().then(() => {
      tick(500)
      expect(source.fills).not.toContain('#123456')
      expect(messages.filter(message => message.type === 'failed')).toEqual([])
    })
  })
  it('retains the same borrowed actor through a reversal and rejects old completion ownership', () => {
    const source = attach('source', 'character'), destination = attach('destination', 'character')
    const flight = attach('scene', 'raster-scene')
    send({ type: 'character', surface: 'source', request: 1, description })
    send({ type: 'character', surface: 'destination', request: 2, description })
    send({ type: 'borrow-character', surface: 'scene', source: 'source', request: 3 })
    const engine = { width: 8, height: 8, close() {} } as ImageBitmap
    send({ type: 'load', surface: 'scene', request: 4, assets: [{ id: 'engine', bitmap: engine }] })
    send({ type: 'play', surface: 'scene', run: 10, program: { ...program,
      textures: [{ id: 'engine', from: 0, until: 0, rect: { x: 0, y: 0, width: 8, height: 8 } }] } })
    expect(flight.images.filter(image => image === engine)).toHaveLength(1)
    tick(300)
    const before = [flight.paints, source.paints, destination.paints]
    const timeline = redirectTimeline(forwardTimeline(performance.timeOrigin, 1000), 0, performance.timeOrigin + 300)
    send({ type: 'redirect', surface: 'scene', previous: 10, run: 11, timeline, destination: { id: 'source', description } })
    send({ type: 'release', surface: 'scene', run: 10 })
    send({ type: 'redirect', surface: 'scene', previous: 10, run: 12, timeline })
    expect([flight.paints, source.paints, destination.paints]).toEqual(before)
    tick(400)
    expect(flight.images.filter(image => image === engine)).toHaveLength(1)
    expect(flight.paints).toBeGreaterThan(before[0])
    expect([source.paints, destination.paints]).toEqual(before.slice(1))
    tick(300 + timeline.duration + 1)
    expect(flight.images.filter(image => image === engine)).toHaveLength(2)
    expect(messages.filter(message => message.type === 'performed')).toEqual([
      expect.objectContaining({ type: 'performed', run: 11, elapsed: 0 })
    ])
    send({ type: 'land-character', surface: 'scene', run: 10, request: 4 })
    expect(messages.at(-1)).toMatchObject({ type: 'rejected' })
    send({ type: 'land-character', surface: 'scene', run: 11, request: 5 })
    expect(source.paints).toBeGreaterThan(before[1])
    send({ type: 'release', surface: 'scene', run: 11 })
    expect(inspect().stats.textures).toBe(0)
    expect(messages.filter(message => message.type === 'failed')).toEqual([])
  })
  it('cancels scheduled work when every surface is hidden and wakes with the current semantic state', () => {
    attach('resident', 'character')
    send({ type: 'character', surface: 'resident', request: 1, description })
    expect(inspect().stats.scheduled).toBe(true)
    send({ type: 'visibility', surface: 'resident', visible: false })
    expect(inspect().stats).toMatchObject({ visible: 0, scheduled: false })
    send({ type: 'visibility', surface: 'resident', visible: true })
    tick(5000)
    expect(inspect().stats.visible).toBe(1)
  })
  it('does not share mutable resident state when a redirect races a landing acknowledgement', () => {
    const source = attach('source', 'character'), destination = attach('destination', 'character')
    attach('scene', 'raster-scene')
    send({ type: 'character', surface: 'source', request: 1, description })
    send({ type: 'character', surface: 'destination', request: 2, description })
    send({ type: 'borrow-character', surface: 'scene', source: 'source', request: 3 })
    send({ type: 'play', surface: 'scene', run: 10, program })
    tick(1000)
    send({ type: 'land-character', surface: 'scene', run: 10, request: 4 })
    const timeline = redirectTimeline(forwardTimeline(performance.timeOrigin, 1000), 0, performance.timeOrigin + now)
    send({ type: 'redirect', surface: 'scene', previous: 10, run: 11, timeline, destination: { id: 'source', description } })
    tick(1000 + timeline.duration + 1)
    send({ type: 'land-character', surface: 'scene', run: 11, request: 5 })
    send({ type: 'release', surface: 'scene', run: 11 })
    // The seat may expand into a message; the returned Dock must remain a mark.
    send({ type: 'character', surface: 'destination', request: 6, description: { ...description, layout: 'message' } })
    tick(now + 16)
    expect(source.scales[0]).toEqual([50 / 640, 50 / 640])
    expect(destination.scales[0]).toEqual([50 / 780, 50 / 780])
    expect(messages.filter(message => message.type === 'failed')).toEqual([])
  })
  it('reports loss of a resident raster context so Host can restore static DOM', () => {
    const canvas = attach('resident', 'character')
    canvas.listeners.get('contextlost')!()
    expect(messages.at(-1)).toMatchObject({ type: 'failed', surface: 'resident' })
    expect(inspect().stats.surfaces).toBe(0)
  })
  it('resizes resident raster density and safely ends a sealed scene on a display scale change', () => {
    const canvas = attach('resident', 'character')
    send({ type: 'character', surface: 'resident', request: 1, description })
    send({ type: 'resize', surface: 'resident', width: 50, height: 50, pixelRatio: 2 })
    expect([canvas.width, canvas.height]).toEqual([100, 100])
    attach('scene', 'scene')
    send({ type: 'play', surface: 'scene', run: 10, program: { duration: 1000, poses: [], textures: [], phases: [] } })
    send({ type: 'resize', surface: 'scene', width: 50, height: 50, pixelRatio: 2 })
    expect(messages.at(-1)).toMatchObject({ type: 'failed', surface: 'scene' })
    expect(inspect().stats).toMatchObject({ surfaces: 1, pixels: 10000 })
  })
})
