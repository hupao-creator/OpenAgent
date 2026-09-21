import { RUNNING_BEAT_MS, RUNNING_DOT_RADIUS, sampleRunningStory } from './running-story'
import type { MotionRect } from './worker-types'

export const CAPSULE_DOT_AT = 400
export const LAUNCH_DURATION = 720
const smooth = (value: number): number => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

/** Submit handoff; at its last frame every light and eye matches beat zero. */
export function sampleLaunch(elapsed: number, reduced: boolean) {
  const running = elapsed >= LAUNCH_DURATION || reduced
  const story = sampleRunningStory(Math.max(0, elapsed - LAUNCH_DURATION) / RUNNING_BEAT_MS, reduced)
  if (running) return {
    ...story, running, body: { x: 1, y: 1, drop: 0 },
    dots: story.dots.map(dot => ({ ...dot, scale: 1 }))
  }
  const press = Math.sin(Math.PI * smooth(elapsed / 220))
  const release = Math.sin(Math.PI * smooth((elapsed - 220) / 260))
  return {
    running,
    stage: elapsed < CAPSULE_DOT_AT ? '输入框 → 中间光点' : '左右光点接上',
    body: { x: 1 + .045 * press - .018 * release, y: 1 - .045 * press + .022 * release,
      drop: 8 * press - 6 * release },
    eyes: { x: 0, y: 24 * smooth(elapsed / 120) * (1 - smooth((elapsed - 440) / 280)),
      scaleX: 1, scaleY: 1 - .1 * press },
    dots: story.dots.map((dot, index) => {
      if (index === 1) return { ...dot, opacity: elapsed < CAPSULE_DOT_AT ? 0 : dot.opacity, scale: 1 }
      const arrival = smooth((elapsed - (index === 0 ? 360 : 440)) / 200)
      return { ...dot, x: 320 + (dot.x - 320) * arrival, y: dot.y + 8 * (1 - arrival),
        opacity: dot.opacity * arrival, scale: arrival + .12 * Math.sin(Math.PI * arrival) }
    })
  }
}

/** Prepared once from the live composer; all coordinates are in Bart's viewBox. */
export interface CharacterLaunch {
  key: number
  startedAt: number
  speed: number
  capsule: MotionRect
  bodyOffset: { x: number; y: number }
  radius: number
}
const mix = (a: number, b: number, p: number): number => a + (b - a) * p
export function sampleLaunchCapsule(launch: CharacterLaunch, elapsed: number) {
  const shrink = 1 - (1 - Math.max(0, Math.min(1, elapsed / 360))) ** 3
  const travel = smooth(elapsed / CAPSULE_DOT_AT)
  const tint = smooth((elapsed - 160) / 220)
  const dot = sampleRunningStory(0).dots[1]
  const width = mix(launch.capsule.width, RUNNING_DOT_RADIUS * 2, shrink)
  const height = mix(launch.capsule.height, RUNNING_DOT_RADIUS * 2, shrink)
  return {
    x: mix(launch.capsule.x + launch.capsule.width / 2, dot.x, travel) - width / 2,
    y: mix(launch.capsule.y + launch.capsule.height / 2, dot.y, travel) - height / 2,
    width, height, radius: mix(launch.radius, RUNNING_DOT_RADIUS, shrink),
    opacity: mix(1, dot.opacity, tint), tint,
    color: `rgb(${dot.color.match(/\d+/g)!.map((value, i) => Math.round(mix([16, 17, 15][i], Number(value), tint))).join(' ')})`
  }
}
export function launchBodyOffset(launch: CharacterLaunch, elapsed: number) {
  const p = 1 - smooth(elapsed / 240)
  return { x: launch.bodyOffset.x * p, y: launch.bodyOffset.y * p }
}
