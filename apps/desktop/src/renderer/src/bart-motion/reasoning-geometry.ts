import { CENTER } from './character-model'

export type ReasoningStreamStyle = 'direct' | 'glide' | 'soft'
export interface BartReasoningOptions {
  length: number
  tilt: number
  gaze: boolean
  stream: ReasoningStreamStyle
}

/** Accepted defaults. The Lab can override these for comparison. */
export const BART_REASONING_DEFAULTS: Readonly<BartReasoningOptions> = {
  length: 200, tilt: -20, gaze: true, stream: 'glide'
}
export const REASONING_RADIUS = 90
// Map the actual body center, excluding the SVG's bottom padding.
export const REASONING_CENTER = { x: 88 + CENTER.x * 224 / 640, y: 55 + CENTER.y * 224 / 640 }

export function reasoningGeometry(length: number, tilt: number): { path: string; mask: string } {
  const span = 144 * length / 100
  const start = -90 + tilt - span / 2
  const point = (degrees: number): string => {
    const radians = degrees * Math.PI / 180
    return `${REASONING_CENTER.x + REASONING_RADIUS * Math.cos(radians)} ${REASONING_CENTER.y + REASONING_RADIUS * Math.sin(radians)}`
  }
  return {
    path: `M${point(start)} A90 90 0 0 1 ${point(start + span / 2)} A90 90 0 0 1 ${point(start + span)}`,
    mask: `conic-gradient(from ${start + 90 - 8}deg at ${REASONING_CENTER.x / 400 * 100}% ${REASONING_CENTER.y / 310 * 100}%, transparent 0deg, #000 24deg, #000 ${span - 8}deg, transparent ${span + 16}deg, transparent 360deg)`
  }
}
