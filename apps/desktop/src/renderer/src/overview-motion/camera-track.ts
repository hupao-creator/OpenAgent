import type { OverviewCanvasTransform } from '../../../shared/thread-overview-canvas'

export interface CameraFrame extends OverviewCanvasTransform { at: number }

export function sampleCamera(frames: readonly CameraFrame[], at: number): OverviewCanvasTransform {
  let index = 0
  while (index + 1 < frames.length && frames[index + 1].at <= at) index++
  const from = frames[index], to = frames[index + 1] ?? from
  if (!from) return { x: 0, y: 0, scale: 1 }
  const progress = from === to ? 0 : Math.max(0, Math.min(1, (at - from.at) / (to.at - from.at)))
  return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress,
    scale: from.scale + (to.scale - from.scale) * progress }
}

export function cameraTransformCss(transform: OverviewCanvasTransform): string {
  return `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`
}

/** Sample the easing once. Playback is a single compositor-owned effect. */
export function cameraMove(from: OverviewCanvasTransform, to: OverviewCanvasTransform, duration: number, delay = 0): CameraFrame[] {
  const frames: CameraFrame[] = [{ ...from, at: 0 }]
  for (let index = 0; index <= 48; index++) {
    const t = index / 48, p = 1 - (1 - t) ** 5
    frames.push({ at: delay + t * duration, x: from.x + (to.x - from.x) * p,
      y: from.y + (to.y - from.y) * p, scale: from.scale + (to.scale - from.scale) * p })
  }
  return frames
}
