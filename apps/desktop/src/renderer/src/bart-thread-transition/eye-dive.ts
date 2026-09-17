import { ramp } from './transitions'

export const BART_REACTION = {
  id: 'curious',
  label: '好奇迎接',
  passage: '察觉你靠近，轻轻一缩；随后好奇地探身、睁大右眼，放松后让你进入。'
} as const

/** A performance driven by distance along the shot, never by a second clock.
 * Sizes and offsets are relative to Bart's radius, so a captured blink cannot
 * leave the entrance closed and dragging the Dock doesn't change the acting. */
export function eyeDivePose(progress: number) {
  const attention = ramp(0, 0.18, progress)
  const flinch = ramp(0.015, 0.075, progress) * (1 - ramp(0.075, 0.18, progress))
  const recoil = ramp(0, 0.1, progress) * (1 - ramp(0.1, 0.28, progress))
  const open = ramp(0.14, 0.34, progress)
  const settle = ramp(0.34, 0.52, progress)
  const lean = open * (1 - settle)
  return {
    attention,
    blink: 1 - 0.52 * flinch,
    bodyX: 0.045 * lean,
    bodyY: 0.055 * recoil - 0.055 * lean,
    bodyScaleX: 1 + 0.065 * recoil - 0.025 * lean,
    bodyScaleY: 1 - 0.065 * recoil + 0.035 * lean,
    bodyRotation: 3.5 * recoil - 3 * lean,
    eyeWidth: 0.24 + 0.39 * open - 0.07 * settle,
    eyeHeight: 0.47 + 0.23 * open - 0.045 * settle,
    otherEyeWidth: 0.24 + 0.07 * open - 0.04 * settle,
    otherEyeHeight: 0.47 - 0.07 * open + 0.02 * settle,
    eyeX: 0.33,
    eyeY: -0.32,
    otherEyeX: -0.3,
    otherEyeY: -0.28,
    // Give the recognition beat room before accelerating through the eye.
    cameraProgress: progress - 0.07 * Math.sin(Math.PI * Math.min(1, progress / 0.82)),
    focusLock: ramp(0.1, 0.42, progress)
  }

}
