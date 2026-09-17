import { afterEach, describe, expect, it, vi } from 'vitest'
import { forwardTimeline, redirectTimeline } from '../src/renderer/src/bart-motion/motion-timeline'
import { compileGenerationProgram, withGenerationCharacter } from '../src/renderer/src/bart-motion/generation-program'
import { sampleMatrix, samplePose, sampleReveal } from '../src/renderer/src/bart-motion/program'
import { validateMotionProgram } from '../src/renderer/src/bart-motion/runtime-limits'
import { createMotionSurface } from '../src/renderer/src/bart-motion/worker-client'
import type { PreparedMotionCard } from '../src/renderer/src/bart-motion/card-assets'
import type { MotionProgram, MotionWorkerRequest, MotionWorkerResponse } from '../src/renderer/src/bart-motion/worker-types'

const dock = { x: 500, y: 600, radius: 22 }
function card(id: string, x: number): PreparedMotionCard {
  const rect = { x, y: 100, width: 360, height: 200 }
  return { rect, duration: 1500, assets: [], textures: [{ id, rect, from: 0 }],
    caret: [{ at: 0, x: x + 20, y: 130 }, { at: 700, x: x + 300, y: 130 },
      { at: 700, x: x + 20, y: 150 }, { at: 1500, x: x + 300, y: 150 }] }
}

describe('prepared scene execution', () => {
  it('keeps the resident visible above typesetting and returns to its exact native matrix', () => {
    const native = { a: .1, b: .01, c: -.01, d: .1, e: 460, f: 570 }
    const program = withGenerationCharacter(compileGenerationProgram([card('a', 50)], dock), dock, native,
      'dock', { activity: 'idle', phase: 'idle' })
    validateMotionProgram(program, new Set(['a']))
    const frames = program.character!.matrices
    expect(sampleMatrix(frames, 0)).toMatchObject({ ...native, opacity: 1 })
    expect(sampleMatrix(frames, program.duration)).toMatchObject({ ...native, opacity: 1 })
    const reveal = program.phases.find(phase => phase.name === 'reveal:0')!.at
    expect(sampleMatrix(frames, reveal + 300).opacity).toBe(1)
    expect(samplePose(program.poses, reveal + 300)?.alpha).toBe(0)
    expect(program.character).toMatchObject({ destination: 'dock', aboveTextures: true })
  })
  it('arrives at full size, visibly expands and overshoots before cutting to the caret', () => {
    const native = { a: .1, b: 0, c: 0, d: .1, e: 468, f: 568 }
    const program = withGenerationCharacter(compileGenerationProgram([card('a', 50)], dock), dock, native,
      'dock', { activity: 'idle', phase: 'idle' })
    const morph = program.phases.find(phase => phase.name === 'morph:0')!.at
    const reveal = program.phases.find(phase => phase.name === 'reveal:0')!.at
    expect(samplePose(program.poses, morph)?.radius).toBe(dock.radius)
    const inflated = samplePose(program.poses, morph + 260 * .36)!
    const stretched = samplePose(program.poses, morph + 260 * .62)!
    const overshoot = samplePose(program.poses, morph + 260 * .82)!
    expect(inflated).toMatchObject({ width: 168, height: 126, alpha: 1, eyeAlpha: 1 })
    expect(stretched.width).toBeGreaterThan(inflated.width!)
    expect(stretched.alpha).toBe(1)
    expect(overshoot).toMatchObject({ width: 372, alpha: 1, surfaceMix: 1 })
    expect(samplePose(program.poses, reveal - .001)!.width).toBeCloseTo(360, 3)
    expect(sampleMatrix(program.character!.matrices, reveal - .001).opacity).toBe(0)
    expect(sampleMatrix(program.character!.matrices, reveal).opacity).toBe(1)
    expect(samplePose(program.poses, reveal)).toMatchObject({ x: 70, y: 130, radius: 9, alpha: 0 })
  })
  it('frames offscreen relay destinations and keeps completed textures on the same prepared camera', () => {
    const a = card('a', 50), b = card('b', 440)
    b.rect.y = 1500
    b.caret.forEach(point => { point.y += 1400 })
    const program = compileGenerationProgram([a, b], dock, { x: 0, y: 0, width: 900, height: 650 })
    validateMotionProgram(program, new Set(['a', 'b']))
    const end = program.camera!.at(-1)!
    expect(b.rect.y + end.y).toBeGreaterThanOrEqual(24)
    expect(b.rect.y + b.rect.height + end.y).toBeLessThanOrEqual(626)
    const second = program.phases.find(phase => phase.name === 'reveal:1')!.at
    expect(samplePose(program.poses, second + 700)?.y).toBe(1550 + end.y)
    expect(program.textures[0].rect).toEqual(a.rect)
    expect(samplePose(program.poses, program.duration)).toMatchObject(dock)
  })
  it('keeps a live actor at relay cuts and after a card with no revealable text', () => {
    const empty = { ...card('empty', 50), duration: 0, caret: [] }
    const native = { a: .1, b: 0, c: 0, d: .1, e: 468, f: 568 }
    const program = withGenerationCharacter(compileGenerationProgram([empty, card('b', 440)], dock), dock, native,
      'dock', { activity: 'idle', phase: 'idle' })
    validateMotionProgram(program, new Set(['empty', 'b']))
    for (const name of ['fly:1', 'reveal:1', 'return', 'waiting-host']) {
      const at = program.phases.find(phase => phase.name === name)!.at
      expect(sampleMatrix(program.character!.matrices, at).opacity).toBe(1)
      expect(samplePose(program.poses, at)?.alpha).toBe(0)
    }
  })
  it('contains both cards, all phase boundaries and return with no Host continuation', () => {
    const program = structuredClone(compileGenerationProgram([card('a', 50), card('b', 440)], dock))
    validateMotionProgram(program, new Set(['a', 'b']))
    expect(program.phases.map(phase => phase.name)).toEqual([
      'fly:0', 'morph:0', 'reveal:0', 'fly:1', 'morph:1', 'reveal:1', 'return', 'waiting-host'
    ])
    expect(samplePose(program.poses, program.duration)).toMatchObject(dock)
    const secondReveal = program.phases.find(phase => phase.name === 'reveal:1')!.at
    expect(samplePose(program.poses, secondReveal + 700)).toMatchObject({ x: 460, y: 150 })
    expect(program.textures.find(texture => texture.id === 'b')!.from).toBe(secondReveal)
  })

  it('cuts between lines and never draws a diagonal wedge of text', () => {
    const frames = [{ at: 0, x: 0, top: 0, bottom: 20 }, { at: 100, x: 200, top: 0, bottom: 20 },
      { at: 100, x: 0, top: 20, bottom: 40 }, { at: 200, x: 200, top: 20, bottom: 40 }]
    expect(sampleReveal(frames, 99)).toMatchObject({ top: 0, bottom: 20 })
    expect(sampleReveal(frames, 100)).toMatchObject({ x: 0, top: 20, bottom: 40 })
    expect(sampleReveal(frames, 150)).toMatchObject({ x: 100, top: 20, bottom: 40 })
  })

  it('rejects missing prepared resources, nonfinite geometry and runaway programs', () => {
    const program = compileGenerationProgram([card('a', 50)], dock)
    expect(() => validateMotionProgram(program, new Set())).toThrow('missing texture')
    expect(() => validateMotionProgram({ ...program, duration: Infinity }, new Set(['a']))).toThrow('duration')
    expect(() => validateMotionProgram({ ...program, poses: [{ at: 0, pose: { ...program.poses[0].pose, x: NaN } }] }, new Set(['a']))).toThrow('pose')
  })
})

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage?: (event: { data: MotionWorkerResponse }) => void
  onerror?: (event: { message: string }) => void
  messages: MotionWorkerRequest[] = []
  terminate = vi.fn()
  constructor() { FakeWorker.instances.push(this) }
  postMessage(message: MotionWorkerRequest): void { this.messages.push(message) }
  send(message: MotionWorkerResponse): void { this.onmessage?.({ data: message }) }
}

const surfaces: ReturnType<typeof createMotionSurface>[] = []
function surface() {
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('devicePixelRatio', 2)
  const result = createMotionSurface({ transferControlToOffscreen: () => ({}) } as HTMLCanvasElement, 400, 300)
  surfaces.push(result)
  const worker = FakeWorker.instances.at(-1)!
  const id = worker.messages.at(-1)!.surface
  worker.send({ type: 'attached', surface: id })
  return { result, worker, id }
}
afterEach(() => { surfaces.splice(0).forEach(surface => surface.dispose()); vi.useRealTimers(); vi.unstubAllGlobals() })
const emptyProgram: MotionProgram = { duration: 1000, poses: [], textures: [], phases: [] }

describe('surface ownership and failure settlement', () => {
  it('coalesces a burst of semantic updates into one in-flight and one latest configuration', async () => {
    const { result, worker, id } = surface()
    const first = result.character({ activity: 'list', phase: 'running', key: 'first' })
    const queued = Array.from({ length: 200 }, (_, index) => result.character({ activity: 'list', phase: 'running', key: String(index) }))
    const sent = worker.messages.filter(message => message.type === 'character')
    expect(sent).toHaveLength(1)
    expect(new Set(queued).size).toBe(1)
    worker.send({ type: 'loaded', surface: id, request: sent[0].request })
    const latest = worker.messages.at(-1)! as Extract<MotionWorkerRequest, { type: 'character' }>
    expect(latest.description.key).toBe('199')
    worker.send({ type: 'loaded', surface: id, request: latest.request })
    await Promise.all([first, ...queued])
    expect(worker.messages.filter(message => message.type === 'character')).toHaveLength(2)
  })
  it('ignores an old release after another run has acquired the surface', async () => {
    const { result, worker, id } = surface()
    const old = result.play(emptyProgram)
    const oldId = (worker.messages.at(-1)! as Extract<MotionWorkerRequest, { type: 'play' }>).run
    old.release()
    const current = result.play(emptyProgram)
    const newId = (worker.messages.at(-1)! as Extract<MotionWorkerRequest, { type: 'play' }>).run
    const count = worker.messages.length
    old.release()
    worker.send({ type: 'performed', surface: id, run: oldId, elapsed: 1000 })
    let done = false
    void current.performed.then(() => { done = true }, () => undefined)
    await Promise.resolve()
    expect(done).toBe(false)
    expect(worker.messages.length).toBe(count)
    worker.send({ type: 'started', surface: id, run: newId, elapsed: 0, origin: 0 })
    worker.send({ type: 'performed', surface: id, run: newId, elapsed: 1000 })
    await current.performed
    current.release()
  })

  it('replaces a live run without releasing assets and ignores its delayed completion', async () => {
    const { result, worker, id } = surface()
    const old = result.play(emptyProgram)
    const oldId = (worker.messages.at(-1)! as Extract<MotionWorkerRequest, { type: 'play' }>).run
    const next = old.redirect(redirectTimeline(forwardTimeline(0, 1000), 0, 300))
    const command = worker.messages.at(-1)! as Extract<MotionWorkerRequest, { type: 'redirect' }>
    expect(command).toMatchObject({ type: 'redirect', previous: oldId })
    await expect(old.performed).rejects.toThrow('superseded')
    old.release()
    expect(worker.messages.some(message => message.type === 'release')).toBe(false)
    let done = false
    void next.performed.then(() => { done = true })
    worker.send({ type: 'performed', surface: id, run: oldId, elapsed: 1000 })
    await Promise.resolve()
    expect(done).toBe(false)
    worker.send({ type: 'started', surface: id, run: command.run, elapsed: 300, origin: 300 })
    worker.send({ type: 'performed', surface: id, run: command.run, elapsed: 0 })
    await next.performed
    next.release()
  })
  it('rejects all unsettled milestones when the dedicated Worker fails', async () => {
    const { result, worker } = surface()
    const run = result.play(emptyProgram)
    worker.onerror?.({ message: 'GPU process unavailable' })
    await expect(run.started).rejects.toThrow('GPU process unavailable')
    await expect(run.performed).rejects.toThrow('GPU process unavailable')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('holds performed pixels until Host release without a completion timeout', async () => {
    vi.useFakeTimers()
    const { result, worker, id } = surface()
    const run = result.play(emptyProgram)
    const runId = (worker.messages.at(-1)! as Extract<MotionWorkerRequest, { type: 'play' }>).run
    worker.send({ type: 'started', surface: id, run: runId, elapsed: 0, origin: 0 })
    worker.send({ type: 'performed', surface: id, run: runId, elapsed: 1000 })
    await run.performed
    await vi.advanceTimersByTimeAsync(60000)
    expect(worker.messages.some(message => message.type === 'release')).toBe(false)
    run.release()
    expect(worker.messages.at(-1)).toEqual({ type: 'release', surface: id, run: runId })
  })
})
