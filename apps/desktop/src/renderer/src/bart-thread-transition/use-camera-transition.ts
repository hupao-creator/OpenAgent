import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { captureCameraAssets, createCameraScene, type CameraScene } from './camera-scene'
import { DEFAULT_DURATION } from './transitions'
import { generationSurface } from '../bart-motion/generation-surface'
import { prepareWithinBudget, sealMotionScene } from '../bart-motion/scene-host'
import { getOverviewMotionCoordinator, type OverviewStageLease } from '../overview-motion'

/** Both native pages mount during preparation. One prepared Worker shot reaches
 * its terminal frame before the Host commits the destination and retires it. */
export function useCameraTransition({ duration = DEFAULT_DURATION, slow = false }: {
  duration?: number; slow?: boolean
} = {}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<CameraScene | null>(null)
  const captureRef = useRef<AbortController | null>(null)
  const cleanupRef = useRef<((nativeCommit?: boolean) => void) | undefined>(undefined)
  const commandRef = useRef(0)
  const targetRef = useRef(false)
  const openRef = useRef(false)
  const presentedRef = useRef(false)
  const focusRef = useRef<HTMLElement | null>(null)
  const configRef = useRef({ duration, slow })
  configRef.current = { duration, slow }
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')
  const getTarget = useCallback(() => targetRef.current, [])

  const retire = useCallback((nativeCommit = false) => {
    captureRef.current?.abort()
    captureRef.current = null
    cleanupRef.current?.(nativeCommit)
    cleanupRef.current = undefined
    sceneRef.current?.dispose()
    sceneRef.current = null
    presentedRef.current = false
  }, [])
  const finish = useCallback((inside: boolean) => {
    commandRef.current++
    targetRef.current = inside
    openRef.current = inside
    // Restore current native DOM in the same Host task, while the Worker still
    // owns the terminal pixels. Stale completion cannot undo a newer command.
    flushSync(() => { setOpen(inside); setActive(false); setPreparing(false) })
    retire(true)
    if (focusRef.current) {
      const original = focusRef.current
      const destination = stageRef.current?.querySelector<HTMLElement>(inside ? '[data-bart-camera-session]' : '[data-bart-camera-overview]')
      if (!destination?.contains(document.activeElement)) {
        const composer = inside ? destination?.querySelector<HTMLTextAreaElement>('.composer textarea:not(:disabled)') : null
        const target = composer ?? (!inside && original.isConnected && !original.closest('[inert]') ? original : destination)
        target?.focus({ preventScroll: true })
      }
      if (!inside) focusRef.current = null
    }
  }, [retire])

  const play = useCallback(async (inside: boolean) => {
    const command = ++commandRef.current
    targetRef.current = inside
    if (sceneRef.current && presentedRef.current) {
      // A new destination takes over the same snapshots, locks and live clock.
      // Older completion callbacks retain their command and cannot hand off.
      try {
        const run = sceneRef.current.play(inside, configRef.current.duration * (configRef.current.slow ? 3 : 1))
        void run.performed.then(() => {
          if (command === commandRef.current) finish(inside)
        }, cause => {
          if (command === commandRef.current) { setError(String(cause)); finish(inside) }
        })
      } catch (cause) {
        if (command === commandRef.current) { setError(String(cause)); finish(inside) }
      }
      return
    }
    retire()
    if (!focusRef.current && document.activeElement instanceof HTMLElement) focusRef.current = document.activeElement
    if (openRef.current === inside) { finish(inside); return }
    const stage = stageRef.current
    if (!stage) { finish(inside); return }
    const controller = new AbortController(), signal = controller.signal
    captureRef.current = controller
    const coordinator = getOverviewMotionCoordinator()
    coordinator.cutScene()
    let seal: ReturnType<typeof sealMotionScene> | undefined, lease: OverviewStageLease | undefined
    let observer: MutationObserver | undefined, sealedAt = 0, version = ''
    const surfaces = (): HTMLElement[] => [...stage.querySelectorAll<HTMLElement>('[data-bart-camera-session], [data-bart-camera-overview]')]
    const revision = (): string => JSON.stringify(surfaces().map(element => {
      // Elapsed-time digits are a visual clock, not a new page revision. They
      // may tick while snapshots decode; actual content and geometry still win.
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), text: string[] = []
      while (walker.nextNode()) {
        if (!walker.currentNode.parentElement?.closest('.thread-card-rolling-number')) text.push(walker.currentNode.textContent ?? '')
      }
      const style = getComputedStyle(element)
      return [text, element.clientWidth, element.clientHeight, style.color, style.backgroundColor,
        ...[...element.querySelectorAll('img')].map(image => image.currentSrc || image.src)]
    }))
    const cut = coordinator.onSceneCut(() => { if (captureRef.current === controller) finish(targetRef.current) })
    cleanupRef.current = nativeCommit => { cut(); observer?.disconnect(); seal?.release({ restoreInteraction: !nativeCommit }); lease?.release() }
    flushSync(() => { setActive(false); setPreparing(true); setError('') })
    for (const phase of ['sealed', 'captured', 'uploaded']) performance.clearMarks(`bart-camera-${phase}`)
    try {
      // Fonts and Markdown settle with the original page still interactive.
      const assets = await prepareWithinBudget(warmSignal => captureCameraAssets(stage, warmSignal, async () => {
        lease = await coordinator.acquireStage('bart-eye-dive', warmSignal)
        warmSignal.throwIfAborted()
        const pool = generationSurface(stage, 'raster-scene')
        if (!pool.canvas.isConnected) stage.append(pool.canvas)
        const covered = [...surfaces(), ...stage.querySelectorAll<HTMLElement>('[data-bart-camera-dock]')]
        const scroll = covered.flatMap(element => [element, ...element.querySelectorAll<HTMLElement>('*')])
          .filter(element => /auto|scroll/.test(getComputedStyle(element).overflowY))
        const transforms = [...stage.querySelectorAll<HTMLElement>('.bart-dock, .bart-dock-logo-motion, .thread-overview-plane')]
        seal = sealMotionScene({ root: stage, canvas: pool.canvas, covered, scroll, freezeTransforms: transforms,
          onExpire: () => controller.abort(new Error('Bart camera sealing exceeded its budget')) })
        sealedAt = performance.now()
        performance.mark('bart-camera-sealed')
        version = revision()
      }), signal)
      performance.mark('bart-camera-captured')
      if (command !== commandRef.current || signal.aborted) { assets.overview.width = 0; assets.session.width = 0; assets.dock.width = 0; return }
      sceneRef.current = createCameraScene(stage, assets)
      const scene = sceneRef.current
      const sealBudget = (): number => sealedAt ? Math.max(1, 2000 - (performance.now() - sealedAt)) : 2000
      await prepareWithinBudget(() => scene.ready, signal, sealBudget())
      performance.mark('bart-camera-uploaded')
      if (sealedAt && version !== revision()) throw new Error('Bart camera content changed during preparation')
      const shotDuration = configRef.current.duration * (configRef.current.slow ? 3 : 1)
      const run = scene.play(inside, shotDuration)
      const origin = await prepareWithinBudget(() => run.started, signal, sealBudget())
      if (command !== commandRef.current || signal.aborted) return
      if (seal && !seal.show()) throw new Error('Bart camera seal expired')
      presentedRef.current = true
      flushSync(() => { setActive(true); setPreparing(false) })
      performance.clearMarks('bart-camera-ready')
      performance.mark('bart-camera-ready', { detail: { origin, duration: shotDuration, inside, ratio: assets.ratio,
        sealedMs: sealedAt ? performance.now() - sealedAt : 0 } })
      observer = new MutationObserver(() => {
        if (sceneRef.current === scene && version && version !== revision()) finish(targetRef.current)
      })
      surfaces().forEach(element => observer!.observe(element, { subtree: true, childList: true, characterData: true }))
      observer.observe(document.documentElement, { attributes: true })
      // This callback only hands off after the complete autonomous shot. No
      // Renderer continuation produces the next segment, mask or terminal frame.
      void run.performed.then(() => {
        if (command === commandRef.current) {
          performance.mark('bart-camera-handoff', { detail: { inside, lockMs: performance.now() - sealedAt } })
          finish(inside)
        }
      }, cause => {
        if (command === commandRef.current) { setError(String(cause)); finish(inside) }
      })
    } catch (cause) {
      if (command !== commandRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
      finish(inside)
    }
  }, [finish, retire])
  const reset = useCallback(() => { void play(false) }, [play])
  const toggle = useCallback(() => { void play(!targetRef.current) }, [play])
  useEffect(() => {
    const settle = (): void => { if (sceneRef.current || captureRef.current) finish(targetRef.current) }
    const hidden = (): void => { if (document.hidden) settle() }
    const scheme = window.matchMedia?.('(prefers-color-scheme: dark)')
    window.addEventListener('resize', settle)
    document.addEventListener('visibilitychange', hidden)
    scheme?.addEventListener?.('change', settle)
    return () => {
      commandRef.current++
      retire()
      window.removeEventListener('resize', settle)
      document.removeEventListener('visibilitychange', hidden)
      scheme?.removeEventListener?.('change', settle)
    }
  }, [finish, retire])
  return { stageRef, open, active, preparing, busy: active || preparing, error, play, finish, getTarget, reset, toggle }
}
