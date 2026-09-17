import { cameraFrame, ramp, type CameraGeometry } from './transitions'
import { eyeDivePose } from './eye-dive'
import type { CameraDive, CapturedEye } from './camera-model'

function roundedRectPath(x: number, y: number, w: number, h: number, radius: number): Path2D {
  const r = Math.min(radius, w / 2, h / 2)
  return new Path2D(`M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`)
}

function performEye(source: CapturedEye, pose: ReturnType<typeof eyeDivePose>, body: CameraGeometry, bodyMatrix: DOMMatrix) {
  const mix = (from: number, to: number): number => from + (to - from) * pose.attention
  const matrix = new DOMMatrix(source.matrix), { target } = source
  const x = mix(source.x, body.x + body.radius * (target ? pose.eyeX : pose.otherEyeX))
  const y = mix(source.y, body.y + body.radius * (target ? pose.eyeY : pose.otherEyeY))
  const width = mix(source.width, body.radius * (target ? pose.eyeWidth : pose.otherEyeWidth) / Math.hypot(matrix.a, matrix.b))
  const height = mix(source.height, body.radius * (target ? pose.eyeHeight : pose.otherEyeHeight) / Math.hypot(matrix.c, matrix.d)) * pose.blink
  const radius = mix(source.radius, Math.min(width, height) / 2)
  const angle = Math.atan2(matrix.b, matrix.a) * 180 / Math.PI
  const transform = bodyMatrix.translate(x, y).rotate(-angle * pose.attention).multiply(matrix)
  const path = new Path2D()
  path.addPath(roundedRectPath(-width / 2, -height / 2, width, height, radius), transform)
  return { path, center: bodyMatrix.transformPoint(new DOMPoint(x, y)) }
}

/** One bounded associated Canvas2D surface, painted only by the shared Worker. */
export function createCameraPainter(context: OffscreenCanvasRenderingContext2D, dive: CameraDive,
  overview: ImageBitmap, session: ImageBitmap, dock: ImageBitmap, ratio: number) {
  const bodyGeometry = dive.body, geometry = dive.eye, { width, height } = geometry
  const shapes = dive.shapes.map(shape => {
    const path = new Path2D()
    if (!shape.eye) path.addPath(new Path2D(shape.path), new DOMMatrix(shape.matrix))
    return { ...shape, path }
  })
  const paint = (progress: number): void => {
    const pose = eyeDivePose(progress)
    const bodyMatrix = new DOMMatrix()
      .translate(bodyGeometry.x + pose.bodyX * bodyGeometry.radius, bodyGeometry.y + pose.bodyY * bodyGeometry.radius)
      .rotate(pose.bodyRotation).scale(pose.bodyScaleX, pose.bodyScaleY)
      .translate(-bodyGeometry.x, -bodyGeometry.y)
    const performed = shapes.map((shape) => ({
      shape,
      eye: shape.eye ? performEye(shape.eye, pose, bodyGeometry, bodyMatrix) : undefined
    }))
    const entrance = performed.find(({ shape }) => shape.eye?.target)!.eye!
    const frame = cameraFrame(geometry, pose.cameraProgress)
    frame.x -= (entrance.center.x - geometry.x) * frame.scale * pose.focusLock
    frame.y -= (entrance.center.y - geometry.y) * frame.scale * pose.focusLock
    // Clear every pixel in one bounded surface on every frame, including endpoints.
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.globalAlpha = 1
    context.clearRect(0, 0, width, height)
    context.fillStyle = dive.background
    context.fillRect(0, 0, width, height)
    context.save()
    context.translate(frame.x, frame.y)
    context.scale(frame.scale, frame.scale)
    context.globalAlpha = 1 - ramp(3, 8, frame.scale)
    if (context.globalAlpha > 0) context.drawImage(overview, 0, 0, width, height)
    // The native endpoint includes internal shadow, theme rim and the Dock's
    // outer shadow. Keep these exact pixels through handoff, in either direction.
    // Blend into the acting shapes before the eye opens; no Host frame work.
    const appearance = 1 - ramp(0.06, 0.18, progress)
    if (appearance > 0) {
      context.save()
      context.transform(bodyMatrix.a, bodyMatrix.b, bodyMatrix.c, bodyMatrix.d, bodyMatrix.e, bodyMatrix.f)
      context.globalAlpha = appearance
      context.drawImage(dock, dive.dock.x, dive.dock.y, dive.dock.width, dive.dock.height)
      context.restore()
    }
    for (const { shape, eye: performedEye } of performed) {
      const opacity = shape.eye ? shape.opacity + (1 - shape.opacity) * pose.attention : shape.opacity
      context.globalAlpha = opacity * ramp(0, 0.06, progress) * (1 - ramp(0.84, 0.96, progress))
      context.fillStyle = shape.fill
      context.save()
      if (!shape.eye) context.transform(bodyMatrix.a, bodyMatrix.b, bodyMatrix.c, bodyMatrix.d, bodyMatrix.e, bodyMatrix.f)
      context.fill(performedEye?.path ?? shape.path)
      context.restore()
    }
    context.restore()

    const reveal = ramp(0.4, 0.58, progress)
    if (reveal === 0) return
    context.save()
    const mask = new Path2D()
    // The entrance is the very same animated eye we just drew, including its
    // gaze, opening and body lean. Never reveal through a frozen eye cutout.
    mask.addPath(entrance.path, new DOMMatrix([frame.scale, 0, 0, frame.scale, frame.x, frame.y]))
    context.clip(mask)
    context.globalAlpha = reveal
    context.fillStyle = dive.sessionBackground
    context.fillRect(0, 0, width, height)
    // The session stays in its final layout; only the entrance reveals it.
    context.drawImage(session, 0, 0, width, height)
    context.restore()
  }
  return (fraction: number): void => paint(dive.inside ? fraction : 1 - fraction)
}
