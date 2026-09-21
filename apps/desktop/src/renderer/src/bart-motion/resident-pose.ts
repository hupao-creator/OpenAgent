/** Shared resident geometry for the production Worker and the Lab. */
import { CENTER, EXPRESSIONS, createMotionState, seatDescriptor, pointsToPath, poseOf, rotatePoint } from './character-model'
import { RUNNING_BEAT_MS, sampleRunningStory } from './running-story'
import { readingGaze } from './reasoning-gaze'
import { readingBody } from './reasoning-body'

export type Role = 'idle' | 'running' | 'reasoning' | 'tool' | 'reply'
export const arcSpan = 192
export const arcSeeds = [-110 - arcSpan / 3, -110, -110 + arcSpan / 3].map(angle => ({
  x: 320 + Math.cos(angle * Math.PI / 180) * 90 / .35,
  y: 300 + Math.sin(angle * Math.PI / 180) * 90 / .35
}))
export const bodyPath = pointsToPath(poseOf(createMotionState('resident-transition', seatDescriptor('idle', 'idle'), 'mark')).body, .82)
export function readingTrack(span = 196, center = -110, enabled = true) {
  const gaze = readingGaze(progress => {
    const angle = (center - span / 2 + progress * span) * Math.PI / 180
    return enabled ? { x: Math.cos(angle) * 78, y: 30 + Math.sin(angle) * 70 } : { x: 0, y: 0 }
  }, 0)
  const body = readingBody(gaze, 0).bodyFrames.map(frame => {
    const values = String(frame.transform).match(/-?\d+(?:\.\d+)?/g)!.map(Number)
    return { at: Number(frame.offset) * gaze.duration, x: values[0], y: values[1], angle: values[2], sx: values[3], sy: values[4] }
  })
  return { gaze, body }
}
const defaultReading = readingTrack()
const at = <T extends { at: number }>(points: readonly T[], time: number): T => {
  let index = 0
  while (index + 1 < points.length && points[index + 1].at <= time) index++
  const left = points[index], right = points[index + 1] ?? left
  const p = left === right ? 0 : (time - left.at) / (right.at - left.at)
  return Object.fromEntries(Object.keys(left).map(key => [key,
    Number(left[key as keyof T]) + (Number(right[key as keyof T]) - Number(left[key as keyof T])) * p])) as T
}

interface EyePlacement { lx: number; ly: number; lw: number; lh: number; la: number; rx: number; ry: number; rw: number; rh: number; ra: number }
/** Limit the pair's common gaze, preserving eye spacing, shape and direction. */
export function fitEyes<T extends EyePlacement>(pose: T): T {
  const cx = (pose.lx + pose.rx) / 2, cy = (pose.ly + pose.ry) / 2
  const dx = cx - 320, dy = cy - 250, a = dx * dx + dy * dy
  if (a < .00001) return pose
  let amount = 1
  for (const side of ['l', 'r'] as const) {
    const angle = pose[`${side}a`] * Math.PI / 180
    for (const x of [-pose[`${side}w`] / 2, pose[`${side}w`] / 2]) {
      for (const y of [-pose[`${side}h`] / 2, pose[`${side}h`] / 2]) {
        const bx = pose[`${side}x`] - cx + x * Math.cos(angle) - y * Math.sin(angle)
        const by = pose[`${side}y`] - cy - 50 + x * Math.sin(angle) + y * Math.cos(angle)
        const b = 2 * (bx * dx + by * dy), c = bx * bx + by * by - 154 ** 2
        amount = Math.min(amount, Math.max(0, (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a)))
      }
    }
  }
  return { ...pose, lx: pose.lx + dx * (amount - 1), rx: pose.rx + dx * (amount - 1),
    ly: pose.ly + dy * (amount - 1), ry: pose.ry + dy * (amount - 1) }
}

/** Numeric appearance channels, including decorations, share a single clock. */
export function targetPose(role: Role, time: number, enteredAt: number, reading = defaultReading, readingAt = enteredAt) {
  const { gaze, body } = reading
  const elapsed = Math.max(0, time - enteredAt)
  const running = sampleRunningStory(elapsed / RUNNING_BEAT_MS)
  const colors = running.dots.map(dot => dot.color.match(/\d+/g)!.map(Number))
  const readingElapsed = Math.max(0, time - readingAt) % gaze.duration
  const read = at(gaze.samples, readingElapsed)
  const follow = at(body, readingElapsed)
  const thinking = role === 'reasoning'
  const tool = role === 'tool'
  const reply = role === 'reply'
  const eye = (side: 'left' | 'right') => {
    const original = EXPRESSIONS.idle[side]
    if (thinking) {
      const x = side === 'left' ? 283.5 : 355.5
      const y = side === 'left' ? 280.5 : 277.5
      const point = rotatePoint(x - 8 - 320, y - 21 - 320, -4 * Math.PI / 180)
      return [320 + point.x + read.x, 320 + point.y + read.y, 29.7, 69.3, -11]
    }
    const x = CENTER.x + original.x, y = CENTER.y + original.y
    if (tool) return [x + 22, 240 + (y - 240) * .62 + 28, original.w, original.h * .62, 0]
    return [x + (role === 'running' ? running.eyes.x : 0),
      y + (role === 'running' ? running.eyes.y : 0), original.w,
      original.h * (role === 'running' ? running.eyes.scaleY : 1), original.rotation]
  }
  const left = eye('left'), right = eye('right')
  return fitEyes({
    x: thinking ? follow.x / .35 : 0, y: thinking ? follow.y / .35 : 0,
    angle: thinking ? follow.angle : 0, sx: thinking ? follow.sx : 1, sy: thinking ? follow.sy : 1,
    lx: left[0], ly: left[1], lw: left[2], lh: left[3], la: left[4],
    rx: right[0], ry: right[1], rw: right[2], rh: right[3], ra: right[4],
    lid: 1,
    dotAlpha: thinking || tool || reply ? 1 : 0,
    dotRed: reply ? 255 : tool ? 52 : 36, dotGreen: reply ? 59 : tool ? 199 : 156, dotBlue: reply ? 48 : tool ? 89 : 255,
    dotX: reply ? (248 - 88) / .35 : 477, dotY: reply ? 180 : 178,
    dotRadius: reply ? 13 / .35 : 22, dotStroke: reply ? 0 : 8,
    arcAlpha: thinking ? 1 : 0, arcOffset: thinking ? 0 : 5,
    arcReveal: thinking ? 1 : 0, arcGather: thinking ? 0 : 1, arcCenter: -110, arcSpan, arcGroupSpan: 1, arcRadius: 90,
    toolAlpha: tool ? 1 : 0, toolOffset: tool ? 0 : -1.5, toolReveal: tool ? 1 : 0, toolX: 271,
    replyAlpha: reply ? 1 : 0,
    d0x: running.dots[0].x, d0y: running.dots[0].y, d0a: role === 'running' ? running.dots[0].opacity : 0,
    d0s: 1,
    d0r: colors[0][0], d0g: colors[0][1], d0b: colors[0][2],
    d1x: running.dots[1].x, d1y: running.dots[1].y, d1a: role === 'running' ? running.dots[1].opacity : 0,
    d1s: 1,
    d1r: colors[1][0], d1g: colors[1][1], d1b: colors[1][2],
    d2x: running.dots[2].x, d2y: running.dots[2].y, d2a: role === 'running' ? running.dots[2].opacity : 0,
    d2s: 1,
    d2r: colors[2][0], d2g: colors[2][1], d2b: colors[2][2]
  })
}
export type Pose = ReturnType<typeof targetPose>
