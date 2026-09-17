import { getOverviewCameraCockpit, getOverviewMotionCoordinator, type OverviewStageLease } from '../overview-motion'
import { getBartSpatialRegistry } from './registry'
import { createMotionSurface, type MotionRun } from './worker-client'
import { motionCardRevision, prewarmMotionCards, prepareMotionCard, type PreparedMotionCard } from './card-assets'
import { compileGenerationProgram, withGenerationCharacter } from './generation-program'
import { residentCharacter } from './CharacterCanvas'
import { prepareWithinBudget, sealGeometry, sealMotionScene } from './scene-host'
import { MOTION_LIMITS, validateMotionProgram } from './runtime-limits'
import { generationSurface } from './generation-surface'
import { diag } from './verify-diag'

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
  const cleanups: (() => void)[] = []
  const abort = (): void => controller.abort(new DOMException('Bart generation scene ended', 'AbortError'))
  const dispose = (): void => {
    diag('scene-dispose', { disposed })
    if (disposed) return
    disposed = true
    abort()
    cleanups.splice(0).forEach(cleanup => cleanup())
    camera?.release()
    seal?.release()
    run?.release()
    cards.forEach(card => card.assets.forEach(asset => asset.bitmap.close()))
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
    diag('scene-enter', { ids: ids.length, limit: MOTION_LIMITS.sceneCards, worker: typeof Worker !== 'undefined',
      offscreen: Boolean(canvas.transferControlToOffscreen),
      reduced: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true })
    if (!ids.length || ids.length > MOTION_LIMITS.sceneCards ||
      typeof Worker === 'undefined' || !canvas.transferControlToOffscreen ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return diag('scene-skip-early')
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
    diag('scene-prepared')
    signal.throwIfAborted()
    lease = await coordinator.acquireStage('bart-generation:prepared-batch', signal)
    diag('scene-stage-acquired')
    signal.throwIfAborted()
    const { elements, fonts, logo, actor } = prepared
    const dock = registry.dockElement()
    if (!dock || !root.isConnected || !elements.every(element => element.isConnected)) throw new Error('Bart scene geometry unavailable')
    const dockContainer = dock.closest<HTMLElement>('.bart-dock') ?? dock
    const scroll = registry.scrollContainer()
    const plane = elements[0].closest<HTMLElement>('.thread-overview-plane')
    const rootRect = root.getBoundingClientRect()
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    reduced?.addEventListener('change', abort)
    cleanups.push(() => reduced?.removeEventListener('change', abort))
    seal = sealMotionScene({ root, canvas, covered: [...elements, dockContainer],
      interactions: [scroll ?? plane ?? elements[0], ...elements, dockContainer],
      resources: plane ? [plane] : [], scroll: scroll ? [scroll] : [], freezeTransforms: [dockContainer] })
    const revision = (): string => elements.map(motionCardRevision).join('\0')
    const valid = sealGeometry([root, dockContainer, ...elements], revision)
    const initialRevision = revision()
    const initialCamera = getOverviewCameraCockpit().live?.transform
    // The resident SVG reserves room for orbits and a caption. Its stable body
    // outline supplies geometry; the Worker owns the live pose, never this DOM.
    const dockRect = (dock.querySelector<SVGGraphicsElement>('.bart-bot > path') ?? dock).getBoundingClientRect()
    const dockPose = { x: dockRect.left - rootRect.left + dockRect.width / 2,
      y: dockRect.top - rootRect.top + dockRect.height / 2, radius: Math.min(dockRect.width, dockRect.height) / 2 }
    const matrix = logo.getScreenCTM()
    if (!matrix || residentCharacter(logo) !== actor) throw new Error('Bart generation resident changed')
    const viewport = registry.viewportRootRect() ?? { x: 0, y: 0, width: rootRect.width, height: rootRect.height }
    // Native toolbar remains above the moving plane. The prepared textures use
    // exactly this same clipped viewport, including on a relay offscreen.
    const toolbar = scroll?.parentElement?.querySelector<HTMLElement>('.thread-overview-header')?.getBoundingClientRect()
    if (toolbar) {
      const top = Math.max(viewport.y, toolbar.bottom - rootRect.top)
      viewport.height -= top - viewport.y; viewport.y = top
    }
    await prepareWithinBudget(async sealSignal => {
      for (const element of elements) {
        const card = await prepareMotionCard(element, { x: rootRect.left, y: rootRect.top }, sealSignal, fonts)
        if (sealSignal.aborted) { card.assets.forEach(asset => asset.bitmap.close()); sealSignal.throwIfAborted() }
        cards.push(card)
      }
      if (!valid()) throw new Error('Bart prepared content changed before playback')
      await surface!.load(cards.flatMap(card => card.assets))
      sealSignal.throwIfAborted()
      await surface!.borrowCharacter(actor.id)
      sealSignal.throwIfAborted()
    }, signal, MOTION_LIMITS.sealTimeout)
    signal.throwIfAborted()
    if (!valid() || !seal.owns()) throw new Error('Bart seal no longer valid')
    const program = withGenerationCharacter(compileGenerationProgram(cards, dockPose, plane && initialCamera ? viewport : undefined),
      dockPose, { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e - rootRect.left, f: matrix.f - rootRect.top },
      actor.id, actor.description())
    validateMotionProgram(program, new Set(cards.flatMap(card => card.assets.map(asset => asset.id))))
    run = surface!.play(program)
    const origin = await prepareWithinBudget(() => run!.started, signal,
      Math.max(1, MOTION_LIMITS.sealTimeout - (performance.now() - seal.sealedAt)))
    signal.throwIfAborted()
    if (!valid()) throw new Error('Bart seal changed before first presentation')
    if (plane && initialCamera && program.camera) {
      camera = getOverviewCameraCockpit().playPrepared(program.camera.map(frame => ({
        at: frame.at, x: initialCamera.x + frame.x, y: initialCamera.y + frame.y, scale: initialCamera.scale
      })), program.duration, origin)
    }
    if (!seal.show()) throw new Error('Bart scene ownership expired')
    diag('scene-ready', { origin, duration: program.duration })
    canvas.dataset.generationState = 'playing'
    performance.clearMarks('bart-generation-ready')
    performance.mark('bart-generation-ready', { detail: { origin, duration: program.duration,
      phases: program.phases, camera: program.camera, viewport, cards: cards.map(card => card.rect),
      preparedMs: performance.now() - preparedAt, sealedMs: performance.now() - seal.sealedAt } })
    // New business facts end the old snapshot promptly. None of these observers
    // supplies animation frames; while Host is blocked the sealed scene runs.
    const observer = new MutationObserver(() => { if (revision() !== initialRevision) abort() })
    elements.forEach(element => observer.observe(element, { subtree: true, characterData: true, childList: true, attributes: true }))
    observer.observe(document.documentElement, { attributes: true })
    cleanups.push(() => observer.disconnect())
    const onResize = (): void => {
      const current = root.getBoundingClientRect()
      if (Math.abs(current.width - rootRect.width) > .5 || Math.abs(current.height - rootRect.height) > .5) abort()
    }
    const resize = new ResizeObserver(onResize)
    resize.observe(root)
    cleanups.push(() => resize.disconnect())
    const colorScheme = window.matchMedia?.('(prefers-color-scheme: dark)')
    colorScheme?.addEventListener('change', abort)
    cleanups.push(() => colorScheme?.removeEventListener('change', abort))
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
    await run.landCharacter()
  })().catch((error: unknown) => {
    diag('scene-aborted', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    performance.clearMarks('bart-generation-skipped')
    performance.mark('bart-generation-skipped', { detail: { reason: error instanceof Error ? error.message : String(error) } })
    throw error
  })
  // The caller restores pending React facts synchronously before disposing the
  // held canvas. Rejection has the same safe handoff to current business DOM.
  return { performed, dispose }
}
