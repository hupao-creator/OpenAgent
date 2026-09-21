/** Shared by the Worker and Lab, in the character's 640-unit viewBox. */
export const RUNNING_BEAT_MS = 2800
export const RUNNING_DOT_RADIUS = 3.5 * 640 / 210
const UNIT = 640 / 210
const CENTER = { x: 320, y: 300 }
const BASE_Y = 464 + 16.5 * UNIT
const RADIUS = 78 * UNIT
const TAU = Math.PI * 2
const PALETTE = [[231, 128, 134], [217, 170, 90], [128, 184, 139],
  [105, 185, 191], [127, 159, 225], [184, 138, 206]]
const smooth = (value: number): number => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}
const mix = (from: number, to: number, t: number): number => from + (to - from) * t

function color(phase: number): string {
  const p = ((phase % 1) + 1) % 1 * PALETTE.length
  const index = Math.floor(p), next = (index + 1) % PALETTE.length
  return `rgb(${PALETTE[index].map((value, channel) => Math.round(mix(value, PALETTE[next][channel], p - index))).join(' ')})`
}

export interface RunningStory {
  stage: string
  eyes: { x: number; y: number; scaleX: number; scaleY: number }
  dots: { x: number; y: number; opacity: number; color: string }[]
}

/** One loop: three beats, launch, exactly one revolution, land, recover. */
export function sampleRunningStory(time: number, still = false): RunningStory {
  const t = still ? 0 : ((time % 3) + 3) % 3
  const orbit = smooth((t - 1.22) / 1.33)
  const angle = Math.PI / 2 + TAU * orbit
  const departure = smooth((t - 1) / .22)
  const arrival = smooth((t - 2.55) / .23)
  const recover = smooth((t - 2.78) / .22)
  const orbitWeight = departure * (1 - arrival)
  let eyes = { x: 0, y: 0, scaleX: 1, scaleY: 1 }
  if (!still) {
    const lead = angle + .17
    const anticipate = 26 * smooth((t - .8) / .2)
    const x = 34 * Math.cos(lead), y = 16 + 38 * Math.sin(lead)
    eyes = {
      x: x * orbitWeight,
      y: mix(anticipate, y, departure) * (1 - arrival) + 26 * arrival * (1 - recover),
      scaleX: 1,
      scaleY: 1 + .055 * Math.sin(Math.PI * orbit) * orbitWeight
        - (t > 2.78 ? .78 * Math.sin(Math.PI * recover) ** 8 : 0)
    }
  }
  const dots = [0, 1, 2].map(index => {
    const baseX = CENTER.x + (index - 1) * 13 * UNIT
    const beat = t * 3 - index
    const pulse = !still && t < 1 && beat >= 0 && beat < 1 ? Math.sin(Math.PI * beat) ** 2 : 0
    const dotAngle = angle + (1 - index) * .17
    const orbitX = CENTER.x + RADIUS * Math.cos(dotAngle)
    const orbitY = CENTER.y + RADIUS * Math.sin(dotAngle)
    return {
      x: mix(baseX, orbitX, orbitWeight),
      y: mix(BASE_Y - 3 * UNIT * pulse, orbitY, orbitWeight),
      opacity: still ? .9 : mix(.65 + .35 * pulse, 1, orbitWeight),
      color: color(t / 3 + index / 3)
    }
  })
  return { stage: still ? '静态预览' : t < 1 ? '三拍接力' : t < 1.22 ? '准备起飞'
    : t < 2.55 ? '环绕一圈' : t < 2.78 ? '回到底部' : '恢复自然', eyes, dots }
}
