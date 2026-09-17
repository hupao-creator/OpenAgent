export const DEFAULT_DURATION = 1100

export function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** One smooth timeline can be played, reversed or scrubbed. */
export function ramp(from: number, to: number, progress: number): number {
  const t = clamp((progress - from) / (to - from))
  return t * t * (3 - 2 * t)
}

export interface CameraGeometry {
  readonly width: number
  readonly height: number
  readonly x: number
  readonly y: number
  readonly radius: number
}

/** Bart and Overview share this matrix: the whole world moves with the camera. */
export function cameraFrame(geometry: CameraGeometry, progress: number) {
  const { width, height, x, y, radius } = geometry
  const approach = ramp(0, 0.8, progress)
  const center = ramp(0, 0.54, progress)
  const scale = Math.exp(Math.log(Math.max(1, Math.hypot(width, height) / Math.max(radius, 1))) * approach)
  const screenX = x + (width / 2 - x) * center
  const screenY = y + (height / 2 - y) * center
  return { scale, x: screenX - x * scale, y: screenY - y * scale, screenX, screenY }
}
