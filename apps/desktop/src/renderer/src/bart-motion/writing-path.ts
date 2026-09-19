import type { MotionPoseFrame } from './worker-types'

/** Monotone cubic interpolation preserves stops and card bounds while sharing
 * the same velocity on both sides of each measured glyph boundary. */
export function createWritingPath(frames: readonly MotionPoseFrame[], start: number, end: number) {
  const points: { at: number; x: number; y: number }[] = []
  for (const { at, pose } of frames) {
    if (at < start || at > end) continue
    const point = { at, x: pose.x, y: pose.y }
    if (points.at(-1)?.at === at) points[points.length - 1] = point
    else points.push(point)
  }
  const tangents = (axis: 'x' | 'y'): number[] => points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return 0
    const previous = points[index - 1], next = points[index + 1]
    const leftTime = point.at - previous.at, rightTime = next.at - point.at
    const left = (point[axis] - previous[axis]) / leftTime
    const right = (next[axis] - point[axis]) / rightTime
    if (left * right <= 0) return 0
    const a = 2 * rightTime + leftTime, b = rightTime + 2 * leftTime
    return (a + b) / (a / left + b / right)
  })
  const vx = tangents('x'), vy = tangents('y')
  return (at: number): { x: number; y: number } => {
    let low = 0, high = points.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (points[middle].at <= at) low = middle
      else high = middle - 1
    }
    const index = low, from = points[index], to = points[index + 1]
    if (!to || at <= points[0].at) return { x: from.x, y: from.y }
    const duration = to.at - from.at, p = Math.max(0, Math.min(1, (at - from.at) / duration))
    const a = 2 * p ** 3 - 3 * p ** 2 + 1, b = p ** 3 - 2 * p ** 2 + p
    const c = -2 * p ** 3 + 3 * p ** 2, d = p ** 3 - p ** 2
    const sample = (axis: 'x' | 'y', velocity: number[]): number => {
      if (from[axis] === to[axis]) return from[axis]
      const value = a * from[axis] + b * duration * velocity[index] + c * to[axis] + d * duration * velocity[index + 1]
      return Math.max(Math.min(from[axis], to[axis]), Math.min(Math.max(from[axis], to[axis]), value))
    }
    return { x: sample('x', vx), y: sample('y', vy) }
  }
}
