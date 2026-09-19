import { getFontEmbedCSS } from 'html-to-image'
import type { CameraGeometry } from './transitions'
import type { CameraDive, CapturedEye } from './camera-model'
import { generationSurface } from '../bart-motion/generation-surface'
import { forwardTimeline, redirectTimeline, type MotionTimeline } from '../bart-motion/motion-timeline'
import type { MotionRun } from '../bart-motion/worker-client'
import { cameraSnapshotRatio } from './camera-snapshot-budget'
import { snapshotSurface } from '../bart-motion/dom-snapshot'

// Existing camera callers can continue importing their capture helpers here.
export { snapshotSurface, snapshotSurfaceVariants } from '../bart-motion/dom-snapshot'

export interface CameraAssets {
  ratio: number
  background: string
  sessionBackground: string
  overview: HTMLCanvasElement
  session: HTMLCanvasElement
  dock: HTMLCanvasElement
  dive: CameraDive
}

export interface CameraScene {
  ready: Promise<void>
  play: (inside: boolean, duration: number) => { started: Promise<number>; performed: Promise<void> }
  dispose: () => void
}

let fontCSS: Promise<string> | undefined
const DOCK_PADDING = 96

/** Capture at viewport resolution. Never scale or mutate the live page tree. */
export async function captureCameraAssets(stage: HTMLElement, signal?: AbortSignal, seal?: () => Promise<void>): Promise<CameraAssets> {
  const overview = stage.querySelector<HTMLElement>('[data-bart-camera-overview]')!
  const session = stage.querySelector<HTMLElement>('[data-bart-camera-session]')!
  if (!overview || !session || typeof Path2D === 'undefined') throw new Error('Camera surfaces unavailable')
  const width = stage.clientWidth
  const height = stage.clientHeight
  if (!width || !height) throw new Error('Camera viewport unavailable')
  await document.fonts.ready
  // Worker-backed Markdown may still be empty after the first layout. Honor
  // its public busy state, then allow scroll anchoring to settle before capture.
  do { await nextPaint(signal) } while ([overview, session].some(surface => surface.querySelector('[aria-busy="true"]')))
  await nextPaint(signal)
  fontCSS ??= getFontEmbedCSS(stage).catch((error: unknown) => { fontCSS = undefined; throw error })
  const fontEmbedCSS = await fontCSS
  // A remounted LiquidCanvas starts at 300×150 before WebGPU and its HTML
  // portal are ready. Wait while the page is interactive, before the short
  // sealing budget and revision snapshot begin. A DOM fallback needs no GPU.
  do { await nextPaint(signal) } while ([...overview.querySelectorAll('.overview-liquid-stage')].some(liquid =>
    !liquid.hasAttribute('data-liquid-fallback') && !liquid.querySelector('canvas[data-liquid-frame-ready="true"]')))
  signal?.throwIfAborted()
  await seal?.()
  signal?.throwIfAborted()
  const dive = captureCameraGeometry(stage)
  const ratio = cameraSnapshotRatio(width, height, dive.dock, window.devicePixelRatio)
  const options = {
    width, height, pixelRatio: ratio, fontEmbedCSS, fetchRequestInit: { signal },
    style: { opacity: '1', visibility: 'visible', transform: 'none', position: 'relative', inset: 'auto' }
  }
  const dock = stage.querySelector<HTMLElement>('[data-bart-camera-dock] .bart-dock')!
  const [overviewImage, sessionImage, dockImage] = await Promise.all([
    snapshotSurface(overview, options), snapshotSurface(session, options),
    snapshotSurface(dock, { ...options, width: dive.dock.width, height: dive.dock.height,
      style: { ...options.style, width: `${dock.offsetWidth}px`, height: `${dock.offsetHeight}px`,
        translate: 'none', transform: `translate(${DOCK_PADDING}px, ${DOCK_PADDING}px)` }
    }, clone => {
      // Capture only the character, with its Worker pixels and both native
      // filter layers. Transparent padding preserves shadows outside its box.
      const root = clone.querySelector('.bart-dock')!
      for (const child of [...root.children]) if (!child.classList.contains('bart-dock-logo-motion')) child.remove()
      // CSS filters on the live DOM use sRGB. SVG image serialization otherwise
      // quantizes Bart's near-black ink through the default linearRGB filters.
      clone.querySelectorAll<SVGElement | HTMLElement>('svg, filter, .bart-dock, .bart-logo').forEach(element => {
        element.style.colorInterpolationFilters = 'sRGB'
      })
    })
  ])
  signal?.throwIfAborted()
  return {
    ratio, overview: overviewImage, session: sessionImage, dock: dockImage, dive,
    background: getComputedStyle(overview).backgroundColor,
    sessionBackground: getComputedStyle(session).backgroundColor
  }
}

function nextPaint(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const abort = (): void => { cancelAnimationFrame(frame); reject(signal?.reason) }
    const frame = requestAnimationFrame(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    })
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function captureEye(eye: SVGRectElement, target: boolean, stage: DOMRect): CapturedEye {
  const ctm = eye.getScreenCTM()!
  const center = new DOMMatrix([ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f]).transformPoint(new DOMPoint(
    eye.x.baseVal.value + eye.width.baseVal.value / 2, eye.y.baseVal.value + eye.height.baseVal.value / 2))
  return { x: center.x - stage.left, y: center.y - stage.top, width: eye.width.baseVal.value,
    height: eye.height.baseVal.value, radius: eye.rx.baseVal.value, matrix: [ctm.a, ctm.b, ctm.c, ctm.d, 0, 0], target }
}

/** Snapshot geometry once, in the same local coordinate space as the assets. */
function captureCameraGeometry(stage: HTMLElement): CameraDive {
  const body = stage.querySelector<SVGPathElement>('[data-bart-camera-dock] .bart-bot > path')
  const eye = stage.querySelector<SVGRectElement>('[data-bart-camera-dock] .bart-face rect:last-child')
  if (!body || !eye) throw new Error('Bart eye unavailable')
  const bounds = stage.getBoundingClientRect(), bodyBounds = body.getBoundingClientRect(), target = eye.getBoundingClientRect()
  if (!bodyBounds.width || !bodyBounds.height) throw new Error('Bart has no visible geometry')
  const geometry = (rect: DOMRect, radius: number): CameraGeometry => ({ width: stage.clientWidth, height: stage.clientHeight,
    x: rect.left + rect.width / 2 - bounds.left, y: rect.top + rect.height / 2 - bounds.top, radius })
  const bodyGeometry = geometry(bodyBounds, Math.min(bodyBounds.width, bodyBounds.height) / 2)
  const dock = stage.querySelector<HTMLElement>('[data-bart-camera-dock] .bart-dock')!.getBoundingClientRect()
  return { body: bodyGeometry, eye: geometry(target, Math.max(Math.min(target.width, target.height) / 2, bodyGeometry.radius * .1)),
    dock: { x: dock.left - bounds.left - DOCK_PADDING, y: dock.top - bounds.top - DOCK_PADDING,
      width: dock.width + DOCK_PADDING * 2, height: dock.height + DOCK_PADDING * 2 },
    background: '', sessionBackground: '', inside: true,
    shapes: [...stage.querySelectorAll<SVGGraphicsElement>('[data-bart-camera-dock] .bart-bot > path, [data-bart-camera-dock] .bart-face rect')].map(element => {
      const matrix = element.getScreenCTM()!, style = getComputedStyle(element)
      return { path: element.getAttribute('d') ?? '', matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - bounds.left, matrix.f - bounds.top],
        fill: style.fill, opacity: Number(style.opacity),
        eye: element instanceof SVGRectElement ? captureEye(element, element === eye, bounds) : undefined }
    }) }
}

/** The associated canvas persists; only this run's textures and locks retire. */
export function createCameraScene(stage: HTMLElement, assets: CameraAssets): CameraScene {
  const pool = generationSurface(stage, 'raster-scene'), token = Symbol('eye-dive')
  let run: MotionRun | undefined, disposed = false
  let timeline: MotionTimeline | undefined, initialInside = false
  pool.acquire(token, () => undefined)
  pool.canvas.className = stage.classList.contains('pg-stage') ? 'pg-camera-canvas' : 'bart-camera-canvas'
  const surface = pool.renderer(token)
  const ready = (async () => {
    await surface.ready
    const bitmaps = await Promise.all([assets.overview, assets.session, assets.dock].map(canvas => createImageBitmap(canvas)))
    if (disposed) { bitmaps.forEach(bitmap => bitmap.close()); throw new Error('Bart camera preparation expired') }
    await surface.load(bitmaps.map((bitmap, index) => ({ id: ['camera-overview', 'camera-session', 'camera-dock'][index]!, bitmap })))
  })()
  void ready.catch(() => undefined)
  return {
    ready,
    play(inside, duration) {
      if (run && timeline) {
        timeline = redirectTimeline(timeline, inside === initialInside ? timeline.limit : 0, performance.timeOrigin + performance.now())
        run = run.redirect(timeline)
        performance.clearMarks('bart-camera-redirect')
        performance.mark('bart-camera-redirect', { detail: { ...timeline, inside } })
        return run
      }
      initialInside = inside
      run = surface.play({ duration, poses: [], textures: [], phases: [{ at: 0, name: 'eye-dive' }, { at: duration, name: 'waiting-host' }],
        cameraDive: { ...assets.dive, background: assets.background, sessionBackground: assets.sessionBackground, inside } })
      const playing = run
      void playing.started.then(origin => { if (run === playing) timeline = forwardTimeline(origin, duration) }).catch(() => undefined)
      pool.canvas.hidden = false
      return run
    },
    dispose() {
      if (disposed) return
      disposed = true
      pool.canvas.hidden = true
      run?.release()
      pool.release(token)
      assets.overview.width = 0; assets.session.width = 0; assets.dock.width = 0
    }
  }
}
