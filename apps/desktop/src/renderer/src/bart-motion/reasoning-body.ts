import type { readingGaze } from './reasoning-gaze'

/** Follow the accepted eye track without changing its timing or positions.
 * The body reacts a little later, with softer movement and a small breath. */
export function readingBody(gaze: ReturnType<typeof readingGaze>, cycle: number): {
  bodyFrames: Keyframe[]; circleFrames: Keyframe[]
} {
  const bodyFrames: Keyframe[] = [], circleFrames: Keyframe[] = []
  const steps = Math.ceil(gaze.duration / 32)
  const smoothing = 1 - Math.exp(-(gaze.duration / steps) / 150)
  let index = 0, followX = 0, followY = 0
  for (let i = 0; i <= steps; i++) {
    const offset = i / steps, at = offset * gaze.duration
    const lookAt = Math.max(0, at - 110)
    while (index + 1 < gaze.samples.length && gaze.samples[index + 1].at <= lookAt) index++
    const from = gaze.samples[index], to = gaze.samples[index + 1] ?? from
    const blend = from === to ? 0 : (lookAt - from.at) / (to.at - from.at)
    followX += (from.x + (to.x - from.x) * blend - followX) * smoothing
    followY += (from.y + (to.y - from.y) * blend - followY) * smoothing

    // Return to the same resting pose with zero velocity at each boundary.
    const envelope = Math.sin(Math.PI * offset) ** 2
    const breath = Math.sin(offset * Math.PI * 2.5 + cycle * .73) * envelope
    const x = followX / 78 * 3.6 * envelope
    const y = followY / 100 * 2.5 * envelope - breath * 1.8
    const angle = followX / 78 * 3.4 * envelope
    const sx = 1 + breath * .016
    const translation = `translate(${x.toFixed(3)}px, ${y.toFixed(3)}px)`
    bodyFrames.push({
      offset,
      // Pivot on the body center, not the SVG's padded viewport midpoint.
      transformOrigin: '50% 46.875%',
      transform: `${translation} rotate(${angle.toFixed(3)}deg) scale(${sx.toFixed(4)}, ${(1 / sx).toFixed(4)})`
    })
    // Keep the circular text centered on the drifting body. The text does not
    // inherit its tilt or squash, preserving the locked reading angle and radius.
    circleFrames.push({ offset, transform: translation })
  }
  return { bodyFrames, circleFrames }
}
