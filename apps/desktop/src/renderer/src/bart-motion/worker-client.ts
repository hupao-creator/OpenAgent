import type { CharacterDescription, MotionProgram, MotionRuntimeStats, MotionWorkerRequest, MotionWorkerResponse } from './worker-types'
import type { DispatchDescription } from './dispatch-canvas'
import type { MotionTimeline } from './motion-timeline'
import { MOTION_LIMITS } from './runtime-limits'

interface Pending<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function pending<T>(): Pending<T> {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  // Teardown can precede the caller awaiting a later milestone.
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

export interface MotionRun {
  /** Absolute monotonic epoch shared with the native compositor timeline. */
  started: Promise<number>
  performed: Promise<void>
  /** Retain the live surface and character; only the time track changes. */
  redirect(timeline: MotionTimeline, destination?: { id: string; description: CharacterDescription }): MotionRun
  landCharacter(): Promise<void>
  /** Host has restored matching DOM and interaction ownership. */
  release(): void
}

let runtime: Worker | undefined
let sequence = 0
const listeners = new Map<string, (message: MotionWorkerResponse) => void>()

function worker(): Worker {
  if (runtime) return runtime
  runtime = new Worker(new URL('./motion.worker.ts', import.meta.url), { type: 'module', name: 'bart-motion' })
  runtime.onmessage = (event: MessageEvent<MotionWorkerResponse>): void => {
    listeners.get(event.data.surface)?.(event.data)
  }
  runtime.onerror = (event): void => {
    const failed = runtime
    runtime = undefined
    for (const [surface, listener] of listeners) listener({ type: 'failed', surface, message: event.message || 'Bart Worker failed' })
    failed?.terminate()
  }
  return runtime
}

/** Internal acceptance diagnostics; counts describe submitted work, never display FPS. */
export async function inspectMotionRuntime(): Promise<MotionRuntimeStats> {
  if (!runtime) return { surfaces: 0, gpuSurfaces: 0, pixels: 0, textureBytes: 0, textures: 0, draws: 0, scheduled: false, visible: 0 }
  const surface = `bart-inspection-${++sequence}`, result = pending<MotionRuntimeStats>()
  const timer = setTimeout(() => result.reject(new Error('Bart inspection timed out')), MOTION_LIMITS.preparationTimeout)
  listeners.set(surface, message => {
    if (message.type === 'inspected') result.resolve(message.stats)
    else if (message.type === 'failed') result.reject(new Error(message.message))
  })
  try {
    runtime.postMessage({ type: 'inspect', surface } satisfies MotionWorkerRequest)
    return await result.promise
  } finally {
    clearTimeout(timer); listeners.delete(surface)
    if (!listeners.size) { runtime?.terminate(); runtime = undefined }
  }
}

/** A DOM-local surface keeps its native scroll, clip and stacking ancestry. */
export function createMotionSurface(canvas: HTMLCanvasElement, width: number, height: number, kind: 'scene' | 'raster-scene' | 'character' = 'scene', onFailure?: (error: Error) => void) {
  const surface = `bart-surface-${++sequence}`
  const ready = pending<void>()
  const loads = new Map<number, Pending<void>>()
  const runs = new Map<number, { started: Pending<number>; performed: Pending<void> }>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  type Configuration = Extract<MotionWorkerRequest, { type: 'character' | 'dispatch' }>
  let sendingConfiguration: { message: Configuration; painted: Pending<void> } | undefined
  let queuedConfiguration: { message: Configuration; painted: Pending<void> } | undefined
  let loadingAssets = false
  let disposed = false
  let currentRun = 0
  let failure: Error | undefined
  const instance = worker()
  let resolution: MediaQueryList | undefined
  const resolutionChanged = (): void => {
    resolution?.removeEventListener?.('change', resolutionChanged)
    if (disposed || failure) return
    post({ type: 'resize', surface, width, height, pixelRatio: devicePixelRatio })
    watchResolution()
  }
  const watchResolution = (): void => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    resolution = window.matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
    resolution.addEventListener?.('change', resolutionChanged)
  }
  const post = (message: MotionWorkerRequest, transfer: Transferable[] = []): void => {
    if (disposed) throw new Error('Bart surface disposed')
    if (failure) throw failure
    instance.postMessage(message, transfer)
  }
  const rejectPending = (error: Error): void => {
    timers.forEach(clearTimeout); timers.clear()
    ready.reject(error)
    for (const load of loads.values()) load.reject(error)
    loads.clear()
    queuedConfiguration?.painted.reject(error)
    sendingConfiguration = undefined; queuedConfiguration = undefined
    for (const run of runs.values()) { run.started.reject(error); run.performed.reject(error) }
    runs.clear()
  }
  const fail = (error: Error): void => {
    if (failure || disposed) return
    failure = error
    resolution?.removeEventListener?.('change', resolutionChanged)
    rejectPending(error)
    instance.postMessage({ type: 'detach', surface } satisfies MotionWorkerRequest)
    onFailure?.(error)
  }
  const bounded = <T>(milestone: Pending<T>): void => {
    const timer = setTimeout(() => { timers.delete(timer); fail(new Error('Bart resource preparation timed out')) }, MOTION_LIMITS.preparationTimeout)
    timers.add(timer)
    void milestone.promise.then(() => { clearTimeout(timer); timers.delete(timer) }, () => { clearTimeout(timer); timers.delete(timer) })
  }
  const sendConfiguration = (configuration: { message: Configuration; painted: Pending<void> }): void => {
    sendingConfiguration = configuration
    loads.set(configuration.message.request, configuration.painted)
    bounded(configuration.painted)
    try { post(configuration.message) }
    catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
  }
  const configure = (description: CharacterDescription | DispatchDescription, type: 'character' | 'dispatch'): Promise<void> => {
    if (disposed || failure) return Promise.reject(failure ?? new Error('Bart surface disposed'))
    if (queuedConfiguration) {
      // Keep one not-yet-sent semantic state. Every caller awaiting this shared
      // acknowledgement observes the latest state, never an unbounded IPC tail.
      queuedConfiguration.message = { ...queuedConfiguration.message, type, description } as Configuration
      return queuedConfiguration.painted.promise
    }
    const configuration = { message: { type, description, surface, request: ++sequence } as Configuration, painted: pending<void>() }
    if (sendingConfiguration) queuedConfiguration = configuration
    else sendConfiguration(configuration)
    return configuration.painted.promise
  }
  const visibility = (): void => {
    if (!disposed && !failure) post({ type: 'visibility', surface, visible: typeof document === 'undefined' || !document.hidden })
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility)
  bounded(ready)
  listeners.set(surface, message => {
    if (message.type === 'attached') ready.resolve()
    else if (message.type === 'rejected') { loads.get(message.request)?.reject(new Error(message.message)); loads.delete(message.request) }
    else if (message.type === 'loaded') {
      loads.get(message.request)?.resolve(); loads.delete(message.request)
      if (sendingConfiguration?.message.request === message.request) {
        sendingConfiguration = undefined
        const next = queuedConfiguration
        queuedConfiguration = undefined
        if (next) sendConfiguration(next)
      }
    }
    else if (message.type === 'failed') {
      fail(new Error(message.message))
    } else if (message.type === 'started') runs.get(message.run)?.started.resolve(message.origin)
    else if (message.type === 'performed') runs.get(message.run)?.performed.resolve()
  })
  try {
    const offscreen = canvas.transferControlToOffscreen()
    post({ type: 'attach', surface, canvas: offscreen, width, height, pixelRatio: devicePixelRatio, kind }, [offscreen])
    visibility()
    watchResolution()
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)))
  }
  const handle = (run: number, started: Pending<number>, performed: Pending<void>): MotionRun => {
    return {
      started: started.promise, performed: performed.promise,
      redirect(timeline, destination): MotionRun {
        if (currentRun !== run) throw new Error('Bart redirect ownership expired')
        const next = ++sequence, nextStarted = pending<number>(), nextPerformed = pending<void>()
        bounded(nextStarted)
        runs.set(next, { started: nextStarted, performed: nextPerformed })
        try { post({ type: 'redirect', surface, previous: run, run: next, timeline, destination }) }
        catch (error) {
          const reason = error instanceof Error ? error : new Error(String(error))
          runs.delete(next); nextStarted.reject(reason); nextPerformed.reject(reason)
          throw error
        }
        currentRun = next
        runs.delete(run)
        const error = new Error('Bart run superseded')
        started.reject(error); performed.reject(error)
        return handle(next, nextStarted, nextPerformed)
      },
      landCharacter(): Promise<void> {
        if (currentRun !== run) return Promise.reject(new Error('Bart landing ownership expired'))
        const request = ++sequence, landed = pending<void>()
        loads.set(request, landed); bounded(landed)
        try { post({ type: 'land-character', surface, run, request }) }
        catch (error) { loads.delete(request); landed.reject(error instanceof Error ? error : new Error(String(error))) }
        return landed.promise
      },
      release(): void {
        if (currentRun !== run) return
        currentRun = 0
        runs.delete(run)
        const error = new Error('Bart run released')
        started.reject(error); performed.reject(error)
        if (!disposed && !failure) post({ type: 'release', surface, run })
      }
    }
  }
  return {
    id: surface,
    ready: ready.promise,
    async borrowCharacter(source: string): Promise<void> {
      await ready.promise
      if (currentRun) throw new Error('Bart surface already performing')
      const request = ++sequence, borrowed = pending<void>()
      loads.set(request, borrowed); bounded(borrowed)
      try { post({ type: 'borrow-character', surface, source, request }) }
      catch (error) { loads.delete(request); borrowed.reject(error instanceof Error ? error : new Error(String(error))) }
      return borrowed.promise
    },
    resetPreparation(): void {
      if (!currentRun && !disposed && !failure) post({ type: 'release', surface, run: 0 })
    },
    resize(nextWidth: number, nextHeight: number): void {
      width = nextWidth; height = nextHeight
      post({ type: 'resize', surface, width, height, pixelRatio: devicePixelRatio })
    },
    dispatch(description: DispatchDescription): Promise<void> { return configure(description, 'dispatch') },
    character(description: CharacterDescription): Promise<void> {
      return configure(description, 'character')
    },
    async load(assets: { id: string; bitmap: ImageBitmap }[]): Promise<void> {
      if (loadingAssets || assets.length > MOTION_LIMITS.texturesPerSurface ||
        assets.reduce((sum, asset) => sum + asset.bitmap.width * asset.bitmap.height * 4, 0) > MOTION_LIMITS.textureBytes) {
        assets.forEach(asset => asset.bitmap.close())
        throw new Error('Bart upload queue or texture budget exceeded')
      }
      loadingAssets = true
      try {
        await ready.promise
        const request = ++sequence, loaded = pending<void>()
        bounded(loaded)
        loads.set(request, loaded)
        try { post({ type: 'load', surface, request, assets }, assets.map(asset => asset.bitmap)) }
        catch (error) { loaded.reject(error instanceof Error ? error : new Error(String(error))); loads.delete(request); throw error }
        await loaded.promise
      } catch (error) { for (const asset of assets) asset.bitmap.close(); throw error }
      finally { loadingAssets = false }
    },
    play(program: MotionProgram): MotionRun {
      if (currentRun) throw new Error('Bart surface already owned')
      const run = ++sequence, started = pending<number>(), performed = pending<void>()
      bounded(started)
      runs.set(run, { started, performed })
      currentRun = run
      try { post({ type: 'play', surface, run, program }) }
      catch (error) {
        const reason = error instanceof Error ? error : new Error(String(error))
        started.reject(reason); performed.reject(reason); currentRun = 0; runs.delete(run); throw error
      }
      return handle(run, started, performed)
    },
    dispose(): void {
      if (disposed) return
      if (!failure) instance.postMessage({ type: 'detach', surface } satisfies MotionWorkerRequest)
      disposed = true
      resolution?.removeEventListener?.('change', resolutionChanged)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility)
      rejectPending(new Error('Bart surface disposed'))
      listeners.delete(surface)
      if (!listeners.size && runtime === instance) { instance.terminate(); runtime = undefined }
    }
  }
}
