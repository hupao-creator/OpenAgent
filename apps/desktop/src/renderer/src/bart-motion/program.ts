import type { BartWebGLPose } from './webgl-renderer'
import type { MotionMatrixFrame, MotionPoseFrame, MotionRevealFrame } from './worker-types'

export function sampleMatrix(frames: readonly MotionMatrixFrame[], at: number): MotionMatrixFrame {
  let index = 0
  while (index + 1 < frames.length && frames[index + 1].at <= at) index++
  const from = frames[index], to = frames[index + 1] ?? from
  const p = from === to ? 0 : Math.max(0, Math.min(1, (at - from.at) / (to.at - from.at)))
  return { at, a: from.a + (to.a - from.a) * p, b: from.b + (to.b - from.b) * p,
    c: from.c + (to.c - from.c) * p, d: from.d + (to.d - from.d) * p,
    e: from.e + (to.e - from.e) * p, f: from.f + (to.f - from.f) * p,
    opacity: (from.opacity ?? 1) + ((to.opacity ?? 1) - (from.opacity ?? 1)) * p }
}

const DEFAULT_POSE: BartWebGLPose = {
  x: 0, y: 0, radius: 16, directionX: 1, directionY: 0, stretch: 0, alpha: 1,
  shapeMix: 0, surfaceMix: 0, eyeAlpha: 1, borderAlpha: 0, shadowAlpha: 0
}

export function samplePose(frames: readonly MotionPoseFrame[], at: number): BartWebGLPose | null {
  if (!frames.length) return null
  let index = 0
  while (index + 1 < frames.length && frames[index + 1].at <= at) index++
  const a = frames[index], b = frames[index + 1] ?? a
  const progress = a === b ? 0 : Math.max(0, Math.min(1, (at - a.at) / (b.at - a.at)))
  const from = { ...DEFAULT_POSE, ...a.pose, width: a.pose.width ?? a.pose.radius * 2,
    height: a.pose.height ?? a.pose.radius * 2, cornerRadius: a.pose.cornerRadius ?? a.pose.radius }
  const to = { ...DEFAULT_POSE, ...b.pose, width: b.pose.width ?? b.pose.radius * 2,
    height: b.pose.height ?? b.pose.radius * 2, cornerRadius: b.pose.cornerRadius ?? b.pose.radius }
  const pose = { ...from }
  for (const key of Object.keys(from) as (keyof typeof from)[]) {
    pose[key] = from[key]! + (to[key]! - from[key]!) * progress
  }
  return pose
}

export function sampleReveal(frames: readonly MotionRevealFrame[], at: number): MotionRevealFrame | null {
  if (!frames.length || at < frames[0].at) return null
  let index = 0
  // Equal timestamps are cuts between text lines, not diagonal reveal sweeps.
  while (index + 1 < frames.length && frames[index + 1].at <= at) index++
  const from = frames[index], to = frames[index + 1] ?? from
  const t = from === to ? 0 : Math.max(0, Math.min(1, (at - from.at) / (to.at - from.at)))
  return { at, x: from.x + (to.x - from.x) * t,
    top: from.top + (to.top - from.top) * t, bottom: from.bottom + (to.bottom - from.bottom) * t }
}
