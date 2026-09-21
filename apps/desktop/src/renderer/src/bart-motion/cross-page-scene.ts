import { residentCharacter } from './CharacterCanvas'
import { generationSurface } from './generation-surface'
import { compileCrossPageProgram, localizeCrossPageProgram, redirectCrossPageKeyframes } from './cross-page-program'
import { prepareWithinBudget, sealMotionScene } from './scene-host'
import { getOverviewMotionCoordinator, type OverviewStageLease } from '../overview-motion'
import { forwardTimeline, redirectTimeline } from './motion-timeline'
import type { MotionRun } from './worker-client'
import { matrixOf } from '../components/bart-cross-page-flight'
import { createSceneLifetime } from './scene-lifetime'

export type BartFlightDirection = 'to-seat' | 'to-dock'
const ENDPOINTS = {
  'to-seat': ['.bart-dock .bart-logo', '.bart-host-body .bart-logo'],
  'to-dock': ['.bart-host-body .bart-logo', '.bart-dock .bart-logo']
} as const
// A page transition may be skipped, but must never replay after the page opens.
const ADMISSION_MS = 250
const ACTOR_SIZE = 256

function pausePreparation(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 8)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** UI integration supplies synchronous handoff, never a frame callback. */
interface CrossPageHost {
  readyToLand(): boolean
  onActiveChange(active: boolean, direction: BartFlightDirection): void
  handoff(direction: BartFlightDirection): void
}

export interface CrossPageScene {
  readonly settled: Promise<void>
  redirect(direction: BartFlightDirection): boolean
  land(): void
  dispose(): void
}

export function prewarmCrossPageScene(root: HTMLElement | null | undefined): void {
  if (root && typeof Worker !== 'undefined' && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function') {
    generationSurface(root, 'raster-scene').prewarm()
  }
}

/** Own one flight, including preparation, repeated redirects and final handoff. */
export function createCrossPageScene(root: HTMLElement | null | undefined, direction: BartFlightDirection, host: CrossPageHost): CrossPageScene {
  let active = false
  let targetDirection = direction
  let travel: Animation | undefined
  let redirectFlight: ((next: BartFlightDirection) => void) | undefined
  const lifetime = createSceneLifetime('Bart page flight cancelled'), signal = lifetime.signal
  const coordinator = getOverviewMotionCoordinator(), token = Symbol('cross-page-flight')
  const pool = root ? generationSurface(root, 'raster-scene') : undefined
  let seal: ReturnType<typeof sealMotionScene> | undefined
  let lease: OverviewStageLease | undefined
  let run: MotionRun | undefined
  let performed: MotionRun | undefined
  let landing: MotionRun | undefined
  let engineBitmap: ImageBitmap | undefined
  let preparing = 'residents'
  const abort = (): void => {
    lifetime.abort()
    if (seal?.presented && lifetime.active) finish()
  }
  lifetime.release(
    () => travel?.cancel(),
    () => seal?.release(),
    () => run?.release(),
    () => engineBitmap?.close(),
    () => pool?.release(token),
    () => lease?.release()
  )
  const finish = (): void => lifetime.handoff(() => {
    // A first installation probe can change the held roster at this commit.
    // Its layout effects measure the new seat immediately: leaving transition
    // disabled until release would commit a jump before native motion resumes.
    seal?.resumeTransitions()
    host.handoff(targetDirection)
  })
  const ownedSession: CrossPageScene = {
    settled: lifetime.settled,
    land(): void {
      const playing = run
      if (!lifetime.active || !host.readyToLand() || !playing || performed !== playing || landing === playing) return
      landing = playing
      void playing.landCharacter().then(() => {
        if (lifetime.active && run === playing) finish()
      }).catch(() => { if (lifetime.active && run === playing) finish() })
    },
    redirect(next: BartFlightDirection): boolean {
      if (!lifetime.active || signal.aborted || !redirectFlight) return false
      try { if (next !== targetDirection) redirectFlight(next) }
      catch { targetDirection = next; finish() }
      return true
    },
    dispose(): void {
      if (!lifetime.active) return
      try { lifetime.dispose() }
      finally { if (active) host.onActiveChange(false, targetDirection) }
    }
  }
  const watch = (playing: MotionRun): void => {
    void playing.performed.then(() => {
      if (!lifetime.active || run !== playing) return
      performed = playing
      ownedSession.land()
    }).catch(() => { if (lifetime.active && run === playing) finish() })
  }
  lifetime.observe(coordinator.onSceneCut((_epoch, source) => { if (source !== 'bart-cross-page') abort() }))
  void (async () => {
    if (!root || !pool || typeof Worker === 'undefined' ||
      !HTMLCanvasElement.prototype.transferControlToOffscreen ||
      document.querySelector<HTMLElement>('.bart-dock')?.dataset.layout !== 'mark') { queueMicrotask(finish); return }
    const requestedAt = performance.now()
    const admit = <T,>(prepare: (warmSignal: AbortSignal) => Promise<T>): Promise<T> =>
      prepareWithinBudget(prepare, signal, Math.max(1, ADMISSION_MS - (performance.now() - requestedAt)))
    // Reserve the destination before the first async boundary. Its current
    // roster stays fixed while preparation and flight own the presentation.
    active = true
    host.onActiveChange(true, direction)
    const [sourceSelector, destinationSelector] = ENDPOINTS[direction]
    const prepared = await admit(async warmSignal => {
      while (true) {
        warmSignal.throwIfAborted()
        const source = root.querySelector<SVGSVGElement>(sourceSelector), destination = root.querySelector<SVGSVGElement>(destinationSelector)
        const outgoing = source && residentCharacter(source), incoming = destination && residentCharacter(destination)
        if (source && destination && outgoing && incoming && source.getBoundingClientRect().width && destination.getBoundingClientRect().width) {
          await Promise.all([outgoing.ready(), incoming.ready()])
          warmSignal.throwIfAborted()
          return { source, destination, outgoing, incoming }
        }
        await pausePreparation(warmSignal)
      }
    })
    signal.throwIfAborted()
    pool.acquire(token, abort)
    preparing = 'surface'
    const canvas = pool.canvas
    canvas.className = 'bart-cross-page-flight-canvas'
    canvas.setAttribute('data-bart-cross-page-flight', '')
    const surface = pool.renderer(token, { width: ACTOR_SIZE, height: ACTOR_SIZE })
    await admit(() => surface.ready)
    const { source, destination, outgoing, incoming } = prepared
    const seat = direction === 'to-seat' ? destination : source
    const engine = seat.closest('.bart-host-character')?.querySelector<HTMLImageElement>('.bart-host-engine-mark img')
    const engineSource = engine?.src
    if (engine) {
      preparing = 'engine'
      engineBitmap = await admit(async warmSignal => {
        await engine.decode()
        warmSignal.throwIfAborted()
        const raster = document.createElement('canvas')
        raster.width = 48; raster.height = 48
        // This tiny, one-shot image is read back immediately by createImageBitmap.
        // Avoid a cold GPU command buffer and synchronous GPU readback on open.
        const context = raster.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Bart engine image preparation unavailable')
        context.drawImage(engine, 0, 0, 48, 48)
        const bitmap = await createImageBitmap(raster, { premultiplyAlpha: 'none' })
        if (warmSignal.aborted) { bitmap.close(); warmSignal.throwIfAborted() }
        return bitmap
      })
      await admit(() => surface.load([{ id: 'bart-flight-engine', bitmap: engineBitmap! }]))
    }
    signal.throwIfAborted()
    preparing = 'stage'
    lease = await admit(warmSignal => coordinator.acquireStage('bart-cross-page', warmSignal))
    signal.throwIfAborted()
    const sealingStarted = performance.now()
    const origin = root.getBoundingClientRect()
    if (!source.isConnected || !destination.isConnected) throw new Error('Bart flight endpoint disappeared')
    // Borrow the current character state before the overlay takes ownership.
    // Velocities and all clocks remain entirely inside the same Worker.
    preparing = 'borrow'
    await admit(() => surface.borrowCharacter(outgoing.id))
    signal.throwIfAborted()
    if (!lifetime.active) return
    const covered = [...new Set([source, destination].map(svg => svg.closest<HTMLElement>('.bart-host-character, .bart-dock-logo-motion')!))]
    const ancestors = [...new Set([source, destination].flatMap(svg => {
      const values: HTMLElement[] = []
      for (let element = svg.parentElement; element && element !== root; element = element.parentElement) values.push(element)
      return values
    }))]
    // A hidden seat adopts its final layout at sealing. The page's circular
    // reveal continues independently; no flight chases its scale or a sliding
    // provisional coordinator with a Renderer frame loop.
    for (const element of ancestors) {
      for (const animation of element.getAnimations()) {
        const timing = animation.effect?.getComputedTiming()
        const frames = (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? []
        if (timing && Number.isFinite(Number(timing.endTime)) && frames.some(frame => 'transform' in frame || 'translate' in frame)) animation.finish()
      }
    }
    const scroll = ancestors.filter(element => /auto|scroll/.test(getComputedStyle(element).overflowY))
    const interactions = ancestors.filter(element => element.matches('.bart-dock, .settings-page-body, .harness-dispatch-map'))
    seal = sealMotionScene({ root, canvas, covered, interactions: [...new Set([...covered, ...scroll, ...interactions])], scroll, freezeTransforms: ancestors })
    const targetMatrix = destination.getScreenCTM(), sourceMatrix = source.getScreenCTM()
    if (!targetMatrix || !sourceMatrix) throw new Error('Bart destination has no sealed layout')
    const from = { ...matrixOf(sourceMatrix), e: sourceMatrix.e - origin.left, f: sourceMatrix.f - origin.top }
    const to = { ...matrixOf(targetMatrix), e: targetMatrix.e - origin.left, f: targetMatrix.f - origin.top }
    const description = { ...incoming.description(), eyeMotion: undefined }
    const program = compileCrossPageProgram(from, to, direction === 'to-seat' ? 760 : 560, incoming.id, description)
    if (engine && engineBitmap) {
      const liveEngine = seat.closest('.bart-host-character')?.querySelector<HTMLImageElement>('.bart-host-engine-mark img')
      if (!liveEngine || liveEngine.src !== engineSource) throw new Error('Bart destination engine changed during sealing')
      const rect = liveEngine.getBoundingClientRect()
      program.textures = [{ id: 'bart-flight-engine', from: direction === 'to-seat' ? program.duration : 0,
        until: direction === 'to-seat' ? undefined : 0,
        rect: { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height } }]
    }
    const { workerProgram, keyframes } = localizeCrossPageProgram(program, ACTOR_SIZE)
    run = surface.play(workerProgram)
    preparing = 'start'
    const epoch = await admit(() => run!.started)
    signal.throwIfAborted()
    if (performance.now() - requestedAt > ADMISSION_MS) throw new Error('Bart cross-page admission expired')
    if (!seal.show()) throw new Error('Bart cross-page seal expired')
    travel = canvas.animate(keyframes, { duration: program.duration, easing: 'linear', fill: 'both' })
    travel.startTime = epoch - performance.timeOrigin
    let timeline = forwardTimeline(epoch, program.duration)
    redirectFlight = next => {
      // document.timeline and Worker performance share this absolute epoch.
      // Rebuild only the compositor time mapping, never the raster or assets.
      const now = performance.timeOrigin + (document.timeline.currentTime as number ?? performance.now())
      timeline = redirectTimeline(timeline, next === direction ? program.duration : 0, now)
      const keyframes = redirectCrossPageKeyframes(program, timeline, ACTOR_SIZE)
      const target = next === direction ? incoming : outgoing
      const nextRun = run!.redirect(timeline, { id: target.id, description: { ...target.description(), eyeMotion: undefined } })
      run = nextRun
      targetDirection = next
      const oldTravel = travel!
      travel = canvas.animate(keyframes, { duration: timeline.duration, easing: 'linear', fill: 'both' })
      travel.startTime = now - performance.timeOrigin
      oldTravel.cancel()
      host.onActiveChange(true, next)
      performance.clearMarks('bart-cross-page-redirect')
      performance.mark('bart-cross-page-redirect', { detail: { ...timeline, direction: next } })
      watch(nextRun)
    }
    performance.clearMarks('bart-cross-page-ready')
    performance.mark('bart-cross-page-ready', { detail: { origin: epoch, direction, duration: program.duration,
      preparationMs: performance.now() - requestedAt, sealingMs: performance.now() - sealingStarted } })
    window.addEventListener('resize', abort)
    lifetime.observe(() => window.removeEventListener('resize', abort))
    const identity = (): string => [source, destination].map(svg => ['data-motion-key', 'data-role', 'data-layout']
      .map(attribute => svg.getAttribute(attribute)).join(':')).join('|')
    const version = identity()
    const endpoints = [{ element: source, matrix: sourceMatrix }, { element: destination, matrix: targetMatrix }]
    const validate = (): void => {
      const moved = endpoints.some(({ element, matrix: sealed }) => {
        const matrix = element.getScreenCTM()
        return !element.isConnected || !matrix || ['a', 'b', 'c', 'd', 'e', 'f'].some(key => {
          const axis = key as keyof typeof from
          return Math.abs(matrix[axis] - sealed[axis]) > (key === 'e' || key === 'f' ? .5 : .001)
        })
      })
      if (moved || identity() !== version || document.querySelector<HTMLElement>('.bart-dock')?.dataset.layout !== 'mark' ||
        seat.closest('.bart-host-character')?.querySelector<HTMLImageElement>('.bart-host-engine-mark img')?.src !== engineSource) abort()
    }
    const observer = new MutationObserver(validate)
    observer.observe(root, { childList: true, subtree: true, attributes: true })
    lifetime.observe(() => observer.disconnect())
    const resize = new ResizeObserver(validate)
    resize.observe(root)
    resize.observe(source)
    resize.observe(destination)
    lifetime.observe(() => resize.disconnect())
    watch(run)
  })().catch(error => {
    if (lifetime.active) {
      performance.clearMarks('bart-cross-page-skipped')
      performance.mark('bart-cross-page-skipped', { detail: { reason: String(error), preparing } })
    }
    finish()
  })
  return ownedSession
}
