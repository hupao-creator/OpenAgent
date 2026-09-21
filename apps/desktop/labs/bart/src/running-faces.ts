export const runningFaces = [
  { id: 'bottom', label: '原版 · 彩虹三点', english: 'Original eyes · Rainbow dots',
    description: '原来的双眼与自然眨眼。底部三点放大，彩虹色缓缓流转，保留轻轻接力的节奏。' },
  { id: 'gaze', label: 'E1 · 追点目光', english: 'Follow the dots',
    description: '目光稍稍向下，跟随亮点从左到右移动，再柔和地回到左侧。' },
  { id: 'focus', label: 'E2 · 轻眯跟拍', english: 'Soft focus',
    description: '双眼保持轻眯，每个点抬起时再收紧一点，随后舒展。' },
  { id: 'blink-beat', label: 'E3 · 三拍眨眼', english: 'Third-beat blink',
    description: '前两拍保持专注，第三个点亮起时轻眨一次，回应完整的一轮。' }
] as const

export interface RunningEyePose {
  x: number
  y: number
  scaleX: number
  scaleY: number
}

/** CSS ease-in-out, matching the original bottom dots' timing curve. */
function ease(value: number): number {
  const t = Math.max(0, Math.min(1, value))
  let low = 0, high = 1
  for (let index = 0; index < 16; index++) {
    const p = (low + high) / 2
    const x = 3 * (1 - p) ** 2 * p * .42 + 3 * (1 - p) * p ** 2 * .58 + p ** 3
    if (x < t) low = p
    else high = p
  }
  const p = (low + high) / 2
  return 3 * (1 - p) * p ** 2 + p ** 3
}

/** Same duration, stagger and keyframes as the original CSS dot relay. */
export function sampleBottomDots(phase: number): number[] {
  return [0, .43 / .65, .22 / .65].map(offset => {
    const p = (phase + offset) % 1
    return p < .25 ? ease(p / .25) : p < .7 ? 1 - ease((p - .25) / .45) : 0
  })
}

export function sampleRunningEyes(variant: string, dots: readonly number[]): RunningEyePose {
  const strength = Math.max(...dots)
  const gaze = (dots[2] - dots[0]) / Math.max(.01, dots[0] + dots[1] + dots[2])
  const scaleY = variant === 'focus' ? .7 - .2 * strength
    : variant === 'blink-beat' ? .94 - .86 * dots[2] ** 6 : .94
  const x = gaze * (variant === 'gaze' ? 25 : variant === 'focus' ? 7 : 4)
  const centerY = variant === 'gaze' ? 286 + 4 * strength : 280 + 2 * strength
  // The production focus eyes sit around y=297. Keep their centre stable
  // while scaling around the renderer's eye-track origin at y=250.
  return { x, y: centerY - (250 + 47 * scaleY), scaleX: 1, scaleY }
}
