export const runningFaces = [
  { id: 'bottom', label: 'C · 底部三点（原版）', english: 'Original bottom dots',
    description: '保留 Bart 原来的双眼与眨眼，三个小点在身体下方接力。暂停仅冻结底部三点。' },
  { id: 'dots', label: 'C1 · 三点接力', english: 'Relay dots',
    description: '原版对照。三个圆点依次抬起、拉长，轻轻传递节奏。' },
  { id: 'capsules', label: 'C2 · 胶囊波浪', english: 'Capsule wave',
    description: '圆点依次拉成长眼睛，像一阵波浪从左到右经过。' },
  { id: 'blink', label: 'C3 · 依次眨点', english: 'Blink relay',
    description: '三个点轮流眨眼，短暂压扁后张开，始终留在原位。' },
  { id: 'gather', label: 'C4 · 聚散呼吸', english: 'Gather & breathe',
    description: '三个点一起靠拢、缩小，再舒展开，节奏更平缓。' },
  { id: 'eyes', label: 'C5 · 双眼化点', english: 'Eyes into dots',
    description: '双眼收成圆点，中间补出第三点，再缓缓展开回双眼。' }
] as const

export interface FacePoint {
  x: number
  y: number
  rx: number
  ry: number
  opacity: number
}

const smooth = (value: number): number => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

/** Coordinates use the production character's 640 × 640 view box. */
export function sampleRunningFace(variant: string, phase: number, reduced = false): FacePoint[] {
  const p = reduced ? .46 : phase
  return [0, 1, 2].map(index => {
    const position = ((p * 3 - index) % 3 + 3) % 3
    const pulse = position < 1 ? Math.sin(position * Math.PI) ** 2 : 0
    const x = 320 + (index - 1) * 53
    if (variant === 'capsules') {
      const wave = (1 + Math.sin(p * Math.PI * 2 - index * .95)) / 2
      return { x, y: 282 - 5 * wave, rx: 15 - 3 * wave, ry: 13 + 24 * wave, opacity: .9 + .1 * wave }
    }
    if (variant === 'blink') {
      const blink = reduced ? 0 : position < .6 ? Math.sin(position / .6 * Math.PI) ** 4 : 0
      return { x, y: 282, rx: 16 + 2 * blink, ry: 17 - 14 * blink, opacity: 1 }
    }
    if (variant === 'gather') {
      const breath = (1 - Math.cos(p * Math.PI * 2)) / 2
      return { x: 320 + (index - 1) * (42 + 22 * breath), y: 282,
        rx: 12 + 5 * breath, ry: 14 + 3 * breath, opacity: .78 + .22 * breath }
    }
    if (variant === 'eyes') {
      const morph = p < .5 ? smooth((p - .1) / .24) : 1 - smooth((p - .65) / .25)
      const spacing = 38 + 15 * morph
      return { x: 320 + (index - 1) * spacing, y: 282,
        rx: index === 1 ? 15 * morph : 13 + 2 * morph,
        ry: index === 1 ? 15 * morph : 34 - 19 * morph,
        opacity: index === 1 ? morph : 1 }
    }
    return { x, y: 282 - 7 * (reduced ? 0 : pulse), rx: 15,
      ry: 15 + 6 * (reduced ? 0 : pulse), opacity: reduced ? .85 : .58 + .42 * pulse }
  })
}
