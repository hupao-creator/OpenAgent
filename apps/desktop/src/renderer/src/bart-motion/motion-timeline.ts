/** Program time is separate from wall time. Reversing retains the prepared
 * route and its resources, including the velocity of a previous reversal. */
export interface MotionTimeline {
  origin: number
  duration: number
  from: number
  to: number
  velocity: number
  limit: number
  linear?: boolean
}

export function forwardTimeline(origin: number, duration: number): MotionTimeline {
  return { origin, duration, from: 0, to: duration, velocity: 1, limit: duration, linear: true }
}

export function sampleTimeline(track: MotionTimeline, now: number): { position: number; velocity: number } {
  if (now >= track.origin + track.duration) return { position: track.to, velocity: 0 }
  const t = Math.max(0, Math.min(1, (now - track.origin) / track.duration))
  if (t >= 1) return { position: track.to, velocity: 0 }
  const distance = track.to - track.from, tangent = track.velocity * track.duration
  const position = track.linear ? track.from + distance * t :
    track.from + distance * (3 * t * t - 2 * t * t * t) + tangent * (t * t * t - 2 * t * t + t)
  const velocity = track.linear ? distance / track.duration :
    (distance * (6 * t - 6 * t * t) + tangent * (3 * t * t - 4 * t + 1)) / track.duration
  // Prepared pages have no geometry beyond their endpoints. Their own easing
  // reaches zero spatial velocity there; holding an endpoint is continuous.
  return { position: Math.max(0, Math.min(track.limit, position)),
    velocity: position < 0 || position > track.limit ? 0 : velocity }
}

export function redirectTimeline(track: MotionTimeline, to: number, origin: number): MotionTimeline {
  const current = sampleTimeline(track, origin)
  return { origin, from: current.position, to, velocity: current.velocity, limit: track.limit,
    duration: Math.max(180, Math.min(900, track.limit * Math.sqrt(Math.abs(to - current.position) / track.limit))) }
}
