interface GazePoint { x: number; y: number }

const mix = (from: number, to: number, amount: number): number => from + (to - from) * amount
const ease = (t: number): number => t * t * t * (t * (6 * t - 15) + 10)

/** Prepare one expressive reading phrase for the existing Worker eye track.
 * Dense samples keep each glance fluid; pauses belong to reading beats rather
 * than to every point on the arc. Replays repeat, successive phrases vary. */
export function readingGaze(pointAt: (progress: number) => GazePoint, cycle: number): {
  frames: Keyframe[]; duration: number; samples: readonly (GazePoint & { at: number })[]
} {
  const samples = [{ at: 0, x: 0, y: 0 }]
  let elapsed = 0
  let progress = 0
  const variation = Math.sin(cycle * 2.399963)
  const pace = 1 + variation * .12

  const move = (duration: number, sample: (amount: number) => GazePoint): void => {
    const count = Math.ceil(duration / 16)
    for (let i = 1; i <= count; i++) samples.push({ at: elapsed + duration * i / count, ...sample(ease(i / count)) })
    elapsed += duration
  }
  const hold = (duration: number): void => {
    elapsed += duration
    const last = samples.at(-1)!
    samples.push({ at: elapsed, x: last.x, y: last.y })
  }
  const glance = (to: number, travel: number, dwell: number): void => {
    const from = progress
    // A tiny overshoot and correction feels like finding a word, not tracking
    // a motor. Sample the same safe arc, never fling the eyes outside the face.
    const landing = Math.max(0, Math.min(1, to + Math.sign(to - from) * .009))
    move(travel * pace, amount => pointAt(mix(from, landing, amount)))
    if (landing !== to) move(95, amount => pointAt(mix(landing, to, amount)))
    progress = to
    hold(dwell * (1 + .16 * Math.sin(cycle * 1.37 + to * 5)))
  }

  // Begin and end facing forward, keeping consecutive Worker tracks continuous.
  // The quick inward return differs from the outward reading path.
  const first = pointAt(0)
  move(310 * pace, amount => ({ x: first.x * amount, y: first.y * amount }))
  hold(140 + 35 * variation)
  glance(.23 + .025 * variation, 620, 150)
  glance(.58 - .035 * variation, 820, 280)
  if (cycle % 3 !== 1) glance(.51 - .035 * variation, 190, 130)
  glance(.83 + .02 * variation, 680, 120)
  glance(1, 520, 470)
  const last = pointAt(1)
  move(430 * pace, amount => ({ x: last.x * (1 - amount), y: last.y * (1 - amount) }))
  hold(200 + 55 * variation)

  return {
    samples,
    duration: elapsed,
    frames: samples.map(({ at, x, y }) => ({
      offset: at / elapsed, transform: `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`
    }))
  }
}
