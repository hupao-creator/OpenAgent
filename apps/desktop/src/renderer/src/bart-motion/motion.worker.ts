/// <reference lib="webworker" />
import { createBartWebGLRenderer, type BartWebGLRenderer, type BartWebGLTexture } from './webgl-renderer'
import { forwardTimeline, sampleTimeline, type MotionTimeline } from './motion-timeline'
import { sampleMatrix, samplePose, sampleReveal } from './program'
import { sampleCamera } from '../overview-motion/camera-track'
import { createCanvasCharacter } from './character-canvas'
import { createCameraPainter } from '../bart-thread-transition/camera-canvas'
import { createCanvasDispatch } from './dispatch-canvas'
import { MOTION_LIMITS, validateMotionProgram } from './runtime-limits'
import type { MotionProgram, MotionWorkerRequest, MotionWorkerResponse } from './worker-types'

const scope = self as unknown as DedicatedWorkerGlobalScope
type Surface = {
  canvas: OffscreenCanvas
  context?: OffscreenCanvasRenderingContext2D
  renderer?: BartWebGLRenderer
  width: number
  height: number
  ratio: number
  kind: 'scene' | 'raster-scene' | 'character'
  bitmaps: Map<string, ImageBitmap>
  cameraPainter?: ReturnType<typeof createCameraPainter>
  assets: Map<string, number>
  lastRun: number
  visible: boolean
  nextPaint: number
  character?: ReturnType<typeof createCanvasCharacter>
  heldBy?: Surface
  borrowed?: { character: ReturnType<typeof createCanvasCharacter>; raster: OffscreenCanvas;
    context: OffscreenCanvasRenderingContext2D; aimed: boolean }
  dispatch?: ReturnType<typeof createCanvasDispatch>
  playback?: { run: number; program: MotionProgram; started: number; timeline: MotionTimeline; phase: number; performed: boolean }
}
const surfaces = new Map<string, Surface>()
let frame = 0
let wake = 0
let draws = 0
const send = (message: MotionWorkerResponse): void => scope.postMessage(message)
const totalAssetBytes = (): number => [...surfaces.values()].reduce((total, surface) => total + [...surface.assets.values()].reduce((sum, bytes) => sum + bytes, 0), 0)
const totalPixels = (): number => [...surfaces.values()].reduce((sum, surface) => sum + surface.canvas.width * surface.canvas.height +
  (surface.borrowed ? surface.borrowed.raster.width * surface.borrowed.raster.height : 0), 0)

function paint(surface: Surface, elapsed: number): void {
  const playback = surface.playback
  if (!playback) return
  if (surface.cameraPainter) { surface.cameraPainter(elapsed / playback.program.duration); draws++; return }
  const layers: BartWebGLTexture[] = []
  const camera = sampleCamera(playback.program.camera ?? [], elapsed)
  for (const texture of playback.program.textures) {
    if (elapsed < texture.from || (texture.until !== undefined && elapsed > texture.until)) continue
    const clip = texture.reveal ? sampleReveal(texture.reveal, elapsed) : undefined
    if (clip === null) continue
    layers.push({ id: texture.id,
      x: camera.x + texture.rect.x * camera.scale, y: camera.y + texture.rect.y * camera.scale,
      width: texture.rect.width * camera.scale, height: texture.rect.height * camera.scale,
      viewport: playback.program.viewport,
      clip: clip ? { x: clip.x * camera.scale, top: clip.top * camera.scale, bottom: clip.bottom * camera.scale } : undefined })
  }
  const pose = samplePose(playback.program.poses, elapsed)
  const character = playback.program.character, borrowed = surface.borrowed
  if (character && borrowed) {
    if (!borrowed.aimed && elapsed >= character.aimAt) {
      borrowed.character.update(character.description)
      borrowed.aimed = true
    }
    const matrix = sampleMatrix(character.matrices, elapsed)
    borrowed.context.setTransform(.8, 0, 0, .8, 0, 0)
    borrowed.context.clearRect(0, 0, 640, 640)
    borrowed.character.paint(borrowed.context, performance.now(), 640, 640)
    if (surface.context) {
      // Keep blur rasterization at a fixed scale, then transform the image in
      // the same Canvas2D pipeline. No per-frame Canvas2D → WebGL texture copy.
      const context = surface.context, ratio = surface.ratio
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, surface.width, surface.height)
      context.save()
      context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f)
      context.globalAlpha = matrix.opacity ?? 1
      context.drawImage(borrowed.raster, 0, 0, 640, 640)
      context.restore()
      for (const layer of layers) {
        const bitmap = surface.bitmaps.get(layer.id)
        if (bitmap) context.drawImage(bitmap, layer.x, layer.y, layer.width, layer.height)
      }
      draws++
      return
    }
    surface.renderer!.updateTexture('bart-live-character', borrowed.raster)
    const layer = { id: 'bart-live-character', x: 0, y: 0, width: 640, height: 640,
      matrix, opacity: matrix.opacity }
    if (character.aboveTextures) layers.push(layer)
    else layers.unshift(layer)
  }
  surface.renderer!.draw(pose ? [pose] : [], layers)
  draws++
}

function tick(now: number): void {
  frame = 0
  let active = false
  let nextWake = Infinity
  for (const [id, surface] of surfaces) {
    if (!surface.visible || surface.heldBy) continue
    try {
    if (surface.dispatch && surface.context && now >= surface.nextPaint) {
      surface.context.setTransform(surface.ratio, 0, 0, surface.ratio, 0, 0)
      surface.context.clearRect(0, 0, surface.width, surface.height)
      surface.dispatch.paint(surface.context, now)
      draws++
      surface.nextPaint = surface.dispatch.nextWake(now)
    }
    if (surface.character && surface.context && now >= surface.nextPaint) {
      surface.context.setTransform(surface.ratio, 0, 0, surface.ratio, 0, 0)
      surface.context.clearRect(0, 0, surface.width, surface.height)
      surface.character.paint(surface.context, now, surface.width, surface.height)
      draws++
      surface.nextPaint = surface.character.nextWake(now)
    }
    nextWake = Math.min(nextWake, surface.nextPaint)
    const playback = surface.playback
    if (!playback || playback.performed) continue
    const elapsed = sampleTimeline(playback.timeline, performance.timeOrigin + now).position
    paint(surface, elapsed)
    while (playback.phase < playback.program.phases.length && playback.program.phases[playback.phase].at <= elapsed) {
      send({ type: 'phase', surface: id, run: playback.run, elapsed,
        name: playback.program.phases[playback.phase++].name })
    }
    if (performance.timeOrigin + now >= playback.timeline.origin + playback.timeline.duration) {
      playback.performed = true
      send({ type: 'performed', surface: id, run: playback.run, elapsed })
    } else active = true
    } catch (error) { fail(id, error) }
  }
  if (active || nextWake <= now) frame = scope.requestAnimationFrame(tick)
  else if (Number.isFinite(nextWake)) wake = scope.setTimeout(schedule, Math.max(0, nextWake - now))
}

function schedule(): void {
  scope.clearTimeout(wake); wake = 0
  if (!frame) frame = scope.requestAnimationFrame(tick)
}

function dispose(surface: Surface): void {
  let releasedResident = false
  for (const resident of surfaces.values()) {
    if (resident.heldBy === surface) { resident.heldBy = undefined; resident.nextPaint = 0; releasedResident = true }
  }
  if (releasedResident) queueMicrotask(schedule)
  if (surface.borrowed) { surface.borrowed.raster.width = 0; surface.borrowed.raster.height = 0 }
  surface.borrowed = undefined
  surface.bitmaps.forEach(bitmap => bitmap.close())
  surface.bitmaps.clear()
  surface.cameraPainter = undefined
  surface.assets.clear()
  surface.playback = undefined
  surface.character = undefined
  surface.dispatch = undefined
  surface.nextPaint = Infinity
  surface.renderer?.releaseTextures()
  surface.renderer?.clear()
  surface.context?.clearRect(0, 0, surface.canvas.width, surface.canvas.height)
}

function fail(id: string, error: unknown): void {
  const surface = surfaces.get(id)
  if (surface) { dispose(surface); surface.renderer?.dispose(); surfaces.delete(id) }
  send({ type: 'failed', surface: id, message: error instanceof Error ? error.message : String(error) })
}

scope.onmessage = ({ data }: MessageEvent<MotionWorkerRequest>): void => {
  try {
    if (data.type === 'inspect') {
      const values = [...surfaces.values()]
      send({ type: 'inspected', surface: data.surface, stats: { surfaces: values.length,
        gpuSurfaces: values.filter(surface => surface.kind !== 'character').length,
        pixels: totalPixels(),
        textureBytes: totalAssetBytes(), textures: values.reduce((sum, surface) => sum + surface.assets.size, 0),
        visible: values.filter(surface => surface.visible).length, draws, scheduled: Boolean(frame || wake) } })
      return
    }
    if (data.type === 'attach') {
      if (surfaces.size >= MOTION_LIMITS.surfaces || surfaces.has(data.surface)) throw new Error('Bart surface limit or duplicate')
      if (![data.width, data.height, data.pixelRatio].every(value => Number.isFinite(value) && value > 0)) throw new Error('Bart surface size invalid')
      const ratio = Math.min(2, Math.max(1, data.pixelRatio))
      const pixels = totalPixels()
      if (pixels + Math.ceil(data.width * ratio) * Math.ceil(data.height * ratio) > MOTION_LIMITS.surfacePixels) throw new Error('Bart surface pixel budget exceeded')
      if (data.kind !== 'character' && [...surfaces.values()].filter(surface => surface.kind !== 'character').length >= MOTION_LIMITS.gpuSurfaces) throw new Error('Bart GPU surface budget exceeded')
      data.canvas.width = Math.ceil(data.width * ratio)
      data.canvas.height = Math.ceil(data.height * ratio)
      // Tiny marks are cheaper to rasterize in software than to flush a GPU
      // command buffer for every icon. Their associated canvases still publish
      // directly from this Worker; larger characters keep accelerated raster.
      const context = data.kind !== 'scene' ? data.canvas.getContext('2d', {
        alpha: true, willReadFrequently: data.kind === 'character' && data.canvas.width * data.canvas.height <= MOTION_LIMITS.softwareRasterPixels
      }) ?? undefined : undefined
      const renderer = data.kind === 'scene' ? createBartWebGLRenderer(data.canvas, data.width, data.height, {
        pixelRatio: ratio, onContextLost: () => fail(data.surface, new Error('Bart GPU context lost'))
      }) ?? undefined : undefined
      if (!context && !renderer) throw new Error('Bart surface unavailable')
      if (context) data.canvas.addEventListener('contextlost', () => fail(data.surface, new Error('Bart raster context lost')), { once: true })
      surfaces.set(data.surface, { canvas: data.canvas, context, renderer, width: data.width,
        height: data.height, ratio, kind: data.kind, bitmaps: new Map(), assets: new Map(), lastRun: 0, visible: true, nextPaint: Infinity })
      send({ type: 'attached', surface: data.surface })
      return
    }
    const surface = surfaces.get(data.surface)
    if (!surface) {
      if (data.type === 'load') for (const asset of data.assets) asset.bitmap.close()
      return
    }
    if (data.type === 'resize') {
      if (![data.width, data.height, data.pixelRatio ?? surface.ratio].every(value => Number.isFinite(value) && value > 0)) throw new Error('Bart surface size invalid')
      const ratio = Math.min(2, Math.max(1, data.pixelRatio ?? surface.ratio))
      const pixels = totalPixels() - surface.canvas.width * surface.canvas.height
      const width = Math.ceil(data.width * ratio), height = Math.ceil(data.height * ratio)
      if (pixels + width * height > MOTION_LIMITS.surfacePixels) throw new Error('Bart surface pixel budget exceeded')
      if (surface.width !== data.width || surface.height !== data.height || surface.ratio !== ratio) {
        if (surface.playback) throw new Error('Bart scene geometry changed during playback')
        surface.width = data.width; surface.height = data.height; surface.ratio = ratio
        if (surface.renderer) surface.renderer.resize(data.width, data.height, ratio)
        else { surface.canvas.width = width; surface.canvas.height = height }
        surface.nextPaint = surface.character || surface.dispatch ? 0 : Infinity
        schedule()
      }
    } else if (data.type === 'visibility') {
      surface.visible = data.visible
      if (data.visible) { surface.nextPaint = surface.character || surface.dispatch ? 0 : Infinity; schedule() }
      else if (![...surfaces.values()].some(value => value.visible)) {
        if (frame) scope.cancelAnimationFrame(frame)
        scope.clearTimeout(wake)
        frame = 0; wake = 0
      }
    } else if (data.type === 'dispatch') {
      if (!surface.context || surface.character || data.description.targets.length > 32 ||
        ![data.description.source, ...data.description.targets].every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) throw new Error('Bart dispatch geometry unavailable')
      if (surface.dispatch) surface.dispatch.update(data.description)
      else surface.dispatch = createCanvasDispatch(data.description)
      surface.context.setTransform(surface.ratio, 0, 0, surface.ratio, 0, 0)
      surface.context.clearRect(0, 0, surface.width, surface.height)
      surface.dispatch.paint(surface.context, performance.now())
      draws++
      surface.nextPaint = surface.dispatch.nextWake(performance.now())
      send({ type: 'loaded', surface: data.surface, request: data.request })
      schedule()
    } else if (data.type === 'character') {
      if (!surface.context || surface.dispatch) throw new Error('Bart character requires an unowned local surface')
      if (surface.character) surface.character.update(data.description)
      else surface.character = createCanvasCharacter(data.description)
      if (!surface.heldBy) {
        surface.context.setTransform(surface.ratio, 0, 0, surface.ratio, 0, 0)
        surface.context.clearRect(0, 0, surface.width, surface.height)
        surface.character.paint(surface.context, performance.now(), surface.width, surface.height)
        draws++
      }
      surface.nextPaint = surface.character.nextWake(performance.now())
      send({ type: 'loaded', surface: data.surface, request: data.request })
      schedule()
    } else if (data.type === 'borrow-character') {
      const source = surfaces.get(data.source)
      if (surface.kind === 'character' || surface.playback || surface.borrowed || !source?.character || source.heldBy) throw new Error('Bart character already owned or unavailable')
      const bytes = 512 * 512 * 4
      if (totalAssetBytes() + bytes > MOTION_LIMITS.textureBytes) throw new Error('Bart character texture budget exceeded')
      if (totalPixels() + 512 * 512 > MOTION_LIMITS.surfacePixels) throw new Error('Bart character raster budget exceeded')
      const raster = new OffscreenCanvas(512, 512), context = raster.getContext('2d')
      if (!context) throw new Error('Bart character raster unavailable')
      context.setTransform(.8, 0, 0, .8, 0, 0)
      source.character.paint(context, performance.now(), 640, 640)
      if (surface.renderer) {
        surface.renderer.upload('bart-live-character', raster)
        surface.assets.set('bart-live-character', bytes)
      } else context.getImageData(0, 0, 1, 1) // Flush cold blur work before starting the flight clock.
      surface.borrowed = { character: source.character, raster, context, aimed: false }
      source.character = source.character.fork()
      source.heldBy = surface
      send({ type: 'loaded', surface: data.surface, request: data.request })
    } else if (data.type === 'land-character') {
      const playback = surface.playback, borrowed = surface.borrowed
      if (playback?.run !== data.run) {
        send({ type: 'rejected', surface: data.surface, request: data.request, message: 'Bart character landing ownership expired' })
        return
      }
      if (!playback || playback.run !== data.run || !playback.performed || !playback.program.character || !borrowed) throw new Error('Bart character landing is stale')
      const destination = surfaces.get(playback.program.character.destination)
      if (destination?.character && destination.context && destination.heldBy === surface) {
        const description = destination.character.description(), planned = playback.program.character.description
        const identity = (value: typeof description): string => JSON.stringify([value.key, value.activity, value.phase, value.layout, value.intervention, value.role])
        if (identity(description) === identity(planned)) {
          // A Host redirect can race the landing acknowledgement. Preserve the
          // exact pose/clocks without sharing mutable state with the live actor.
          destination.character = borrowed.character.fork()
          destination.character.update(description)
        }
        destination.context.setTransform(destination.ratio, 0, 0, destination.ratio, 0, 0)
        destination.context.clearRect(0, 0, destination.width, destination.height)
        destination.character.paint(destination.context, performance.now(), destination.width, destination.height)
        draws++
      }
      send({ type: 'loaded', surface: data.surface, request: data.request })
    } else if (data.type === 'load') {
      if (surface.kind === 'character' || surface.playback) throw new Error('Bart textures can only be loaded before scene playback')
      const next = new Map(surface.assets)
      for (const asset of data.assets) {
        if (!asset.bitmap.width || !asset.bitmap.height || Math.max(asset.bitmap.width, asset.bitmap.height) > MOTION_LIMITS.textureSide) throw new Error('Bart texture size outside budget')
        next.set(asset.id, asset.bitmap.width * asset.bitmap.height * 4)
      }
      const before = [...surface.assets.values()].reduce((sum, bytes) => sum + bytes, 0)
      if (next.size > MOTION_LIMITS.texturesPerSurface || totalAssetBytes() - before + [...next.values()].reduce((sum, bytes) => sum + bytes, 0) > MOTION_LIMITS.textureBytes) throw new Error('Bart texture memory budget exceeded')
      for (const asset of data.assets) {
        if (surface.renderer) surface.renderer.upload(asset.id, asset.bitmap)
        else { surface.bitmaps.get(asset.id)?.close(); surface.bitmaps.set(asset.id, asset.bitmap) }
        surface.assets.set(asset.id, asset.bitmap.width * asset.bitmap.height * 4)
        if (surface.renderer) asset.bitmap.close()
      }
      send({ type: 'loaded', surface: data.surface, request: data.request })
    } else if (data.type === 'play') {
      if (data.run <= surface.lastRun) return
      if (surface.kind === 'character' || surface.playback) throw new Error('Bart scene surface already owned or unavailable')
      validateMotionProgram(data.program, new Set(surface.assets.keys()))
      if (data.program.character) {
        const destination = surfaces.get(data.program.character.destination)
        if (!surface.borrowed || !destination?.character || (destination.heldBy && destination.heldBy !== surface)) throw new Error('Bart prepared character destination unavailable')
        destination.heldBy = surface
      }
      if (data.program.cameraDive) {
        if (surface.kind !== 'raster-scene' || !surface.context) throw new Error('Bart camera surface unavailable')
        surface.cameraPainter = createCameraPainter(surface.context, data.program.cameraDive,
          surface.bitmaps.get('camera-overview')!, surface.bitmaps.get('camera-session')!, surface.bitmaps.get('camera-dock')!, surface.ratio)
        // Exercise the large mask, both page textures and endpoint before the
        // autonomous clock starts. A single preparation readback flushes cold
        // raster work; playback never reads pixels back or waits on the Host.
        for (const fraction of [0, .35, .55, 1, 0]) surface.cameraPainter(fraction)
        surface.context.getImageData(0, 0, 1, 1)
      } else if (surface.kind === 'raster-scene' && (!data.program.character || data.program.poses.length ||
        data.program.textures.some(texture => texture.reveal) || data.program.camera || data.program.viewport)) {
        throw new Error('Bart raster scene requires a simple character flight')
      }
      surface.lastRun = data.run
      surface.playback = { run: data.run, program: data.program, started: performance.now(), timeline: forwardTimeline(performance.timeOrigin + performance.now(), data.program.duration), phase: 0, performed: false }
      paint(surface, 0)
      if (surface.kind === 'raster-scene' && data.program.character) {
        // Publish readiness only after the first full-size raster has completed.
        // Starting its clock before this cold work loses the beginning of a
        // 120Hz flight even though the Worker itself has almost no JS work.
        surface.context!.getImageData(0, 0, 1, 1)
        surface.playback.started = performance.now()
      }
      surface.playback.timeline = forwardTimeline(performance.timeOrigin + surface.playback.started, data.program.duration)
      send({ type: 'started', surface: data.surface, run: data.run, elapsed: 0,
        origin: performance.timeOrigin + surface.playback.started })
      schedule()
    } else if (data.type === 'redirect') {
      const previous = surface.playback
      if (previous?.run !== data.previous || data.run <= surface.lastRun) return
      const track = data.timeline
      if (![track.origin, track.duration, track.from, track.to, track.velocity, track.limit].every(Number.isFinite) ||
        track.duration <= 0 || track.duration > MOTION_LIMITS.programDuration || track.limit !== previous.program.duration ||
        track.from < 0 || track.from > track.limit || (track.to !== 0 && track.to !== track.limit)) throw new Error('Bart redirect timeline invalid')
      if (data.destination && previous.program.character) {
        const destination = surfaces.get(data.destination.id)
        if (!destination?.character || (destination.heldBy && destination.heldBy !== surface)) throw new Error('Bart redirect destination unavailable')
        destination.heldBy = surface
        previous.program = { ...previous.program, character: { ...previous.program.character,
          destination: data.destination.id, description: data.destination.description } }
        surface.borrowed?.character.update(data.destination.description)
        if (surface.borrowed) surface.borrowed.aimed = true
      }
      surface.lastRun = data.run
      surface.playback = { ...previous, run: data.run, timeline: track, phase: previous.program.phases.length, performed: false }
      // No clear, resize, raster warmup or re-borrow at this boundary.
      send({ type: 'started', surface: data.surface, run: data.run, elapsed: track.from, origin: track.origin })
      schedule()
    } else if (data.type === 'release') {
      if (surface.playback?.run === data.run || (data.run === 0 && !surface.playback)) { dispose(surface); schedule() }
    } else if (data.type === 'detach') {
      dispose(surface)
      surface.renderer?.dispose()
      surfaces.delete(data.surface)
    }
  } catch (error) {
    if (data.type === 'load') for (const asset of data.assets) asset.bitmap.close()
    fail(data.surface, error)
  }
}
