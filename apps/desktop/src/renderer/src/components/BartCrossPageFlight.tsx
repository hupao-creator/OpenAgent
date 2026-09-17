import { useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { residentCharacter } from '../bart-motion/CharacterCanvas'
import { generationSurface } from '../bart-motion/generation-surface'
import { compileCrossPageProgram, localizeCrossPageProgram, redirectCrossPageKeyframes } from '../bart-motion/cross-page-program'
import { prepareWithinBudget, sealMotionScene } from '../bart-motion/scene-host'
import { getOverviewMotionCoordinator, type OverviewStageLease } from '../overview-motion'
import { forwardTimeline, redirectTimeline } from '../bart-motion/motion-timeline'
import type { MotionRun } from '../bart-motion/worker-client'
import { matrixOf } from './bart-cross-page-flight'
import './bart-cross-page-flight.css'

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

/** Retain one Worker character and compositor layer through repeated reversals. */
export function BartCrossPageFlight({ direction, readyToLand = true, onActiveChange }: {
  readonly direction: BartFlightDirection | null
  /** Keep the terminal actor until its native page has finished uncovering it. */
  readonly readyToLand?: boolean
  readonly onActiveChange: (active: boolean, direction: BartFlightDirection) => void
}): React.JSX.Element {
  const marker = useRef<HTMLSpanElement>(null)
  const session = useRef<{ redirect(direction: BartFlightDirection): boolean; land(): void; dispose(): void } | undefined>(undefined)
  const landingReady = useRef(readyToLand)
  landingReady.current = readyToLand
  const notify = useRef(onActiveChange)
  notify.current = onActiveChange
  useLayoutEffect(() => {
    const root = marker.current?.closest<HTMLElement>('.app-shell')
    if (root && typeof Worker !== 'undefined' && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function' &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) generationSurface(root, 'raster-scene').prewarm()
  }, [])
  useLayoutEffect(() => () => { session.current?.dispose(); session.current = undefined }, [])
  useLayoutEffect(() => {
    // Page phase callbacks run in layout effects. Commit the matching native
    // page outside that effect stack while the terminal covering frame stays up.
    queueMicrotask(() => session.current?.land())
  }, [readyToLand])
  useLayoutEffect(() => {
    if (!direction) return
    if (session.current?.redirect(direction)) return
    session.current?.dispose()
    const root = marker.current?.closest<HTMLElement>('.app-shell')
    let current = true, active = false, disposed = false
    let targetDirection = direction
    let travel: Animation | undefined
    let redirectFlight: ((next: BartFlightDirection) => void) | undefined
    const controller = new AbortController(), signal = controller.signal
    const coordinator = getOverviewMotionCoordinator(), token = Symbol('cross-page-flight')
    const pool = root ? generationSurface(root, 'raster-scene') : undefined
    let seal: ReturnType<typeof sealMotionScene> | undefined
    let lease: OverviewStageLease | undefined
    let run: MotionRun | undefined
    let performed: MotionRun | undefined
    let landing: MotionRun | undefined
    let engineBitmap: ImageBitmap | undefined
    let preparing = 'residents'
    const cleanups: (() => void)[] = []
    const abort = (): void => {
      controller.abort(new DOMException('Bart page flight cancelled', 'AbortError'))
      if (seal?.presented && !disposed) finish()
    }
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      abort()
      travel?.cancel()
      cleanups.splice(0).forEach(cleanup => cleanup())
      seal?.release()
      run?.release()
      engineBitmap?.close()
      pool?.release(token)
      lease?.release()
    }
    const finish = (): void => {
      if (!current || disposed) return
      // The callback restores the actual destination and its interaction facts;
      // the covering frame survives until those React writes commit together.
      flushSync(() => notify.current(false, targetDirection))
      dispose()
      if (session.current === ownedSession) session.current = undefined
    }
    const ownedSession = {
      land(): void {
        const playing = run
        if (!landingReady.current || !playing || performed !== playing || landing === playing) return
        landing = playing
        void playing.landCharacter().then(() => {
          if (current && run === playing) finish()
        }).catch(() => { if (current && run === playing) finish() })
      },
      redirect(next: BartFlightDirection): boolean {
        if (!current || disposed || !redirectFlight) return false
        try { if (next !== targetDirection) redirectFlight(next) }
        catch { targetDirection = next; finish() }
        return true
      },
      dispose(): void {
        current = false
        dispose()
        if (active) notify.current(false, targetDirection)
      }
    }
    session.current = ownedSession
    const watch = (playing: MotionRun): void => {
      void playing.performed.then(() => {
        if (!current || run !== playing) return
        performed = playing
        ownedSession.land()
      }).catch(() => { if (current && run === playing) finish() })
    }
    cleanups.push(coordinator.onSceneCut((_epoch, source) => { if (source !== 'bart-cross-page') abort() }))
    void (async () => {
      if (!root || !pool || typeof Worker === 'undefined' ||
        !HTMLCanvasElement.prototype.transferControlToOffscreen ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ||
        document.querySelector<HTMLElement>('.bart-dock')?.dataset.layout !== 'mark') { queueMicrotask(finish); return }
      const requestedAt = performance.now()
      const admit = <T,>(prepare: (warmSignal: AbortSignal) => Promise<T>): Promise<T> =>
        prepareWithinBudget(prepare, signal, Math.max(1, ADMISSION_MS - (performance.now() - requestedAt)))
      // Reserve the destination before the first async boundary. Its current
      // roster stays fixed while preparation and flight own the presentation.
      active = true
      notify.current(true, direction)
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
          const context = raster.getContext('2d')
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
      if (!current) return
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
        notify.current(true, next)
        performance.clearMarks('bart-cross-page-redirect')
        performance.mark('bart-cross-page-redirect', { detail: { ...timeline, direction: next } })
        watch(nextRun)
      }
      performance.clearMarks('bart-cross-page-ready')
      performance.mark('bart-cross-page-ready', { detail: { origin: epoch, direction, duration: program.duration,
        preparationMs: performance.now() - requestedAt, sealingMs: performance.now() - sealingStarted } })
      const media = window.matchMedia('(prefers-reduced-motion: reduce)')
      media.addEventListener('change', abort)
      window.addEventListener('resize', abort)
      cleanups.push(() => media.removeEventListener('change', abort), () => window.removeEventListener('resize', abort))
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
      cleanups.push(() => observer.disconnect())
      const resize = new ResizeObserver(validate)
      resize.observe(root)
      resize.observe(source)
      resize.observe(destination)
      cleanups.push(() => resize.disconnect())
      watch(run)
    })().catch(error => {
      if (current) {
        performance.clearMarks('bart-cross-page-skipped')
        performance.mark('bart-cross-page-skipped', { detail: { reason: String(error), preparing } })
      }
      finish()
    })
  }, [direction])
  return <span hidden aria-hidden="true" ref={marker} />
}
