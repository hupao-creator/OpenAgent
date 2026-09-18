import { getFontEmbedCSS } from 'html-to-image'
import type { Options } from 'html-to-image/lib/types'
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

/** 那帧还没画出来，只能隔一帧重拍；重拍次数是它的上界。 */
const OVERVIEW_CAPTURE_ATTEMPTS = 3

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
    snapshotOverview(overview, options, signal), snapshotSurface(session, options),
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

/**
 * 俯瞰视图的截图。那张图里含一块液体玻璃画布（`<canvas layoutsubtree>`），它的**元素图像**
 * 是浏览器现捕一帧得到的：返回俯瞰这块画布刚挂载，`@liquid-dom` 的渲染器还没异步就绪、
 * 一帧都没画过，此时读回的是整片单一颜色；html-to-image 把它当成 `<img>` 的源烤进位图，
 * 转场再把这块位图铺满整屏 —— 返回俯瞰时那一下闪就是这么来的。
 *
 * 画布画出帧之后读回就有结构了，所以拍到平色就隔一帧重拍。重拍用尽仍拍不到就退回背景色：
 * 平色只是少一帧内容，不会把整屏闪一下。
 */
async function snapshotOverview(source: HTMLElement, options: Options, signal?: AbortSignal): Promise<HTMLCanvasElement> {
  let canvas = await snapshotSurface(source, options)
  for (let attempt = 1; attempt < OVERVIEW_CAPTURE_ATTEMPTS && isFlat(canvas); attempt++) {
    signal?.throwIfAborted()
    await nextPaint(signal)
    canvas = await snapshotSurface(source, options)
  }
  if (!isFlat(canvas)) return canvas
  const context = canvas.getContext('2d')!
  context.fillStyle = opaqueBackground(source)
  context.fillRect(0, 0, canvas.width, canvas.height)
  return canvas
}

/** 画布上没有任何内容读得出来时铺什么色。`source` 自己的背景是透明的（那一层只看
    得到画布和下面的卡片），得往上找第一个不透明的祖先，都没有才退回白。 */
function opaqueBackground(source: HTMLElement): string {
  for (let element: HTMLElement | null = source; element; element = element.parentElement) {
    const background = getComputedStyle(element).backgroundColor
    if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') return background
  }
  return '#fff'
}

/** 一帧都没画出来的读回是整片单一颜色：8×8 缩略图里每个像素都一样。真正的俯瞰视图，
    哪怕是空状态，也有卡片和文字撑着，缩略图不会只有一个颜色。 */
function isFlat(canvas: HTMLCanvasElement): boolean {
  const probe = document.createElement('canvas')
  probe.width = 8
  probe.height = 8
  const context = probe.getContext('2d')!
  context.drawImage(canvas, 0, 0, 8, 8)
  const { data } = context.getImageData(0, 0, 8, 8)
  const [red, green, blue] = data
  for (let index = 4; index < data.length; index += 4) {
    if (data[index] !== red || data[index + 1] !== green || data[index + 2] !== blue) return false
  }
  return true
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
