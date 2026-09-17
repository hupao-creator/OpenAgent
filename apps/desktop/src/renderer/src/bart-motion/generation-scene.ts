import { getOverviewCameraCockpit, getOverviewMotionCoordinator, type OverviewStageLease } from '../overview-motion'
import { getBartSpatialRegistry } from './registry'
import { createMotionSurface, type MotionRun } from './worker-client'
import { captureMotionCard, prewarmMotionCards, type CapturedMotionCard, type PreparedMotionCard } from './card-assets'
import { compileGenerationProgram, withGenerationCharacter } from './generation-program'
import { residentCharacter } from './CharacterCanvas'
import { prepareWithinBudget, sealGeometry, sealMotionScene } from './scene-host'
import { MOTION_LIMITS, validateMotionProgram } from './runtime-limits'
import { generationSurface } from './generation-surface'

function preparationPause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 40)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** One production batch, including camera, all reveals and return. */
export function createGenerationScene(root: HTMLElement, ids: readonly string[], parentSignal: AbortSignal) {
  const registry = getBartSpatialRegistry(), coordinator = getOverviewMotionCoordinator()
  const controller = new AbortController(), signal = controller.signal
  const pool = generationSurface(root), token = Symbol('generation-surface'), canvas = pool.canvas
  let disposed = false
  const preparedAt = performance.now()
  let surface: ReturnType<typeof createMotionSurface> | undefined
  let seal: ReturnType<typeof sealMotionScene> | undefined
  let camera: { release(): void } | undefined
  let lease: OverviewStageLease | undefined
  let run: MotionRun | undefined
  const cards: PreparedMotionCard[] = []
  const releaseCards = (): void => {
    cards.splice(0).forEach(card => card.assets.forEach(asset => asset.bitmap.close()))
  }
  const cleanups: (() => void)[] = []
  const abort = (): void => controller.abort(new DOMException('Bart generation scene ended', 'AbortError'))
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    abort()
    cleanups.splice(0).forEach(cleanup => cleanup())
    camera?.release()
    seal?.release()
    run?.release()
    releaseCards()
    pool.release(token)
    lease?.release()
    if (seal?.presented) {
      performance.clearMarks('bart-generation-handoff')
      performance.mark('bart-generation-handoff', { detail: { lockMs: performance.now() - seal.sealedAt } })
    }
  }
  parentSignal.addEventListener('abort', abort, { once: true })
  cleanups.push(() => parentSignal.removeEventListener('abort', abort))
  if (parentSignal.aborted) abort()
  cleanups.push(coordinator.onSceneCut(abort), registry.onThreadCardUnregister(id => { if (ids.includes(id)) abort() }))

  const performed = (async (): Promise<void> => {
    pool.acquire(token, abort)
    canvas.className = 'bart-generation-scene'
    canvas.dataset.generationState = 'preparing'
    canvas.hidden = true
    if (!ids.length || ids.length > MOTION_LIMITS.sceneCards ||
      typeof Worker === 'undefined' || !canvas.transferControlToOffscreen ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    // Only prepared resources enter the global execution FIFO. Fonts, lazy
    // Markdown and shaders never hold a character or the user's scroll region.
    const prepared = await prepareWithinBudget(async warmSignal => {
      let elements: HTMLElement[] = []
      while (true) {
        warmSignal.throwIfAborted()
        elements = ids.flatMap(id => registry.threadCardElement(id) ?? [])
        if (elements.length === ids.length && elements.every(element => !element.querySelector('[aria-busy="true"]'))) break
        await preparationPause(warmSignal)
      }
      const fonts = await prewarmMotionCards(elements[0], warmSignal)
      warmSignal.throwIfAborted()
      surface = pool.renderer(token)
      await surface.ready
      const logo = registry.dockElement()?.querySelector<SVGSVGElement>('.bart-logo')
      const actor = logo && residentCharacter(logo)
      if (!logo || !actor || (actor.description().layout ?? 'mark') !== 'mark') throw new Error('Bart generation resident unavailable')
      await actor.ready()
      warmSignal.throwIfAborted()
      return { elements, fonts, logo, actor }
    }, signal)
    signal.throwIfAborted()
    lease = await coordinator.acquireStage('bart-generation:prepared-batch', signal)
    signal.throwIfAborted()
    const { elements, fonts, logo, actor } = prepared
    const dock = registry.dockElement()
    if (!dock || !root.isConnected || !elements.every(element => element.isConnected)) throw new Error('Bart scene geometry unavailable')
    const dockContainer = dock.closest<HTMLElement>('.bart-dock') ?? dock
    const scroll = registry.scrollContainer()
    const plane = elements[0].closest<HTMLElement>('.thread-overview-plane')
    // Environment invalidation is distinct from ordinary business updates, and
    // applies during preparation as well as playback.
    for (const query of ['(prefers-reduced-motion: reduce)', '(prefers-color-scheme: dark)']) {
      const media = window.matchMedia?.(query)
      media?.addEventListener('change', abort)
      cleanups.push(() => media?.removeEventListener('change', abort))
    }
    seal = sealMotionScene({ root, canvas, covered: [...elements, dockContainer],
      interactions: [scroll ?? plane ?? elements[0], ...elements, dockContainer],
      resources: plane ? [plane] : [], scroll: scroll ? [scroll] : [], freezeTransforms: [dockContainer] })
    // A sampled batch may be older than live business state. Retry only invalid
    // scene geometry, retaining the original deadline and pending work.
    const beforeDeadline = <T>(prepare: (sealSignal: AbortSignal) => Promise<T>): Promise<T> => {
      const remaining = MOTION_LIMITS.sealTimeout - (performance.now() - seal!.sealedAt)
      if (remaining <= 0) throw new Error('Bart scene sealing exceeded its budget')
      return prepareWithinBudget(prepare, signal, remaining)
    }
    const preparePlayback = async (sealSignal: AbortSignal) => {
      while (elements.some(element => element.querySelector('[aria-busy="true"]'))) await preparationPause(sealSignal)
      sealSignal.throwIfAborted()
      if (!root.isConnected || !dock.isConnected || !elements.every(element => element.isConnected)) {
        throw new Error('Bart scene geometry unavailable')
      }
      const rootRect = root.getBoundingClientRect()
      surface!.resize(rootRect.width, rootRect.height)
      const toolbarElement = (): HTMLElement | null | undefined => scroll?.parentElement?.querySelector<HTMLElement>('.thread-overview-header')
      const toolbar = toolbarElement()
      const geometryValid = sealGeometry([root, dockContainer, ...elements, ...(scroll ? [scroll] : []), ...(toolbar ? [toolbar] : [])], () => '')
      const valid = (): boolean => toolbarElement() === toolbar && geometryValid()
      const initialCamera = getOverviewCameraCockpit().live?.transform
      // The resident SVG reserves room for orbits and a caption. Its stable body
      // outline supplies geometry; the Worker owns the live pose, never this DOM.
      const dockRect = (dock.querySelector<SVGGraphicsElement>('.bart-bot > path') ?? dock).getBoundingClientRect()
      const dockPose = { x: dockRect.left - rootRect.left + dockRect.width / 2,
        y: dockRect.top - rootRect.top + dockRect.height / 2, radius: Math.min(dockRect.width, dockRect.height) / 2 }
      const matrix = logo.getScreenCTM()
      if (!matrix || residentCharacter(logo) !== actor) throw new Error('Bart generation resident changed')
      const viewport = registry.viewportRootRect() ?? { x: 0, y: 0, width: rootRect.width, height: rootRect.height }
      if (toolbar) {
        const top = Math.max(viewport.y, toolbar.getBoundingClientRect().bottom - rootRect.top)
        viewport.height -= top - viewport.y; viewport.y = top
      }
      const snapshots: CapturedMotionCard[] = []
      const releaseSnapshots = (): void => snapshots.forEach(snapshot => snapshot.dispose())
      sealSignal.addEventListener('abort', releaseSnapshots, { once: true })
      try {
        // Sample the entire batch in one Host task before any asynchronous
        // encoding. Later cards cannot accidentally sample a later stream turn.
        for (const element of elements) snapshots.push(captureMotionCard(element, { x: rootRect.left, y: rootRect.top }))
        for (const snapshot of snapshots) {
          sealSignal.throwIfAborted()
          const card = await snapshot.prepare(sealSignal, fonts)
          if (sealSignal.aborted) { card.assets.forEach(asset => asset.bitmap.close()); sealSignal.throwIfAborted() }
          cards.push(card)
        }
      } finally {
        sealSignal.removeEventListener('abort', releaseSnapshots)
        releaseSnapshots()
      }
      if (!valid()) return undefined
      await surface!.load(cards.flatMap(card => card.assets))
      sealSignal.throwIfAborted()
      if (!valid()) return undefined
      await surface!.borrowCharacter(actor.id)
      sealSignal.throwIfAborted()
      if (!valid()) return undefined
      const program = withGenerationCharacter(compileGenerationProgram(cards, dockPose, plane && initialCamera ? viewport : undefined),
        dockPose, { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e - rootRect.left, f: matrix.f - rootRect.top },
        actor.id, actor.description())
      validateMotionProgram(program, new Set(cards.flatMap(card => card.assets.map(asset => asset.id))))
      run = surface!.play(program)
      const origin = await run.started
      sealSignal.throwIfAborted()
      return { valid, initialCamera, rootRect, viewport, program, origin }
    }
    let playback: Awaited<ReturnType<typeof preparePlayback>>
    while (true) {
      playback = await beforeDeadline(preparePlayback)
      signal.throwIfAborted()
      if (!seal.owns()) throw new Error('Bart seal no longer valid')
      if (playback?.valid()) break
      run?.release()
      run = undefined
      surface!.resetPreparation()
      releaseCards()
      await beforeDeadline(preparationPause)
    }
    signal.throwIfAborted()
    const { initialCamera, rootRect, viewport, program, origin } = playback
    if (plane && initialCamera && program.camera) {
      camera = getOverviewCameraCockpit().playPrepared(program.camera.map(frame => ({
        at: frame.at, x: initialCamera.x + frame.x, y: initialCamera.y + frame.y, scale: initialCamera.scale
      })), program.duration, origin)
    }
    if (!seal.show()) throw new Error('Bart scene ownership expired')
    canvas.dataset.generationState = 'playing'
    performance.clearMarks('bart-generation-ready')
    performance.mark('bart-generation-ready', { detail: { origin, duration: program.duration,
      phases: program.phases, camera: program.camera, viewport, cards: cards.map(card => card.rect),
      preparedMs: performance.now() - preparedAt, sealedMs: performance.now() - seal.sealedAt } })
    // Once visible, finish this prepared reveal and return before handing off
    // to the live cards. Streamed text and metadata keep updating beneath the
    // cover; they must not truncate playback or restart the batch.
    const onResize = (): void => {
      const current = root.getBoundingClientRect()
      if (Math.abs(current.width - rootRect.width) > .5 || Math.abs(current.height - rootRect.height) > .5) abort()
    }
    const resize = new ResizeObserver(onResize)
    resize.observe(root)
    cleanups.push(() => resize.disconnect())
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      void run!.performed.then(() => {
        signal.removeEventListener('abort', onAbort)
        canvas.dataset.generationState = 'waiting-host'
        resolve()
      }, error => { signal.removeEventListener('abort', onAbort); reject(error) })
    })
    signal.throwIfAborted()
    await run!.landCharacter()
  })().catch((error: unknown) => {
    performance.clearMarks('bart-generation-skipped')
    performance.mark('bart-generation-skipped', { detail: { reason: error instanceof Error ? error.message : String(error) } })
    throw error
  })
  // The caller restores pending React facts synchronously before disposing the
  // held canvas. Rejection has the same safe handoff to current business DOM.
  return { performed, dispose }
}
