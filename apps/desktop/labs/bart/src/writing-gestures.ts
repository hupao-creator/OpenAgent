import { smooth, writingDrive, type WritingGestureInput } from '../../../src/renderer/src/bart-motion/writing-gestures'
export { sampleWritingGesture, writingTrailStyle, type WritingGesture } from '../../../src/renderer/src/bart-motion/writing-gestures'

export const writingGestures = [
  { id: 'sprint', letter: 'A', name: '纯角色', summary: '用前倾和目光表达方向，轮廓保持克制。', character: '对照' },
  { id: 'spring', letter: 'B', name: '短速度线', summary: '两道轻短掠影随行，停下便消退。', character: '利落 · 推荐' },
  { id: 'glide', letter: 'C', name: '淡尾迹', summary: '肩后留一抹渐淡的弧形尾迹，更柔和。', character: '轻盈' }
] as const

export const gestureStudyDuration = 4800
export function gestureStudy(at: number, punctuationPauses = true): WritingGestureInput & { label: string } {
  const elapsed = at % gestureStudyDuration
  const velocity = (time: number): number => {
    const run = (from: number, to: number): number => smooth((time - from) / 280) * smooth((to - time) / 210)
    const forward = punctuationPauses ? .2 * run(0, 1540) + .21 * run(2080, 3060) : .2 * run(0, 3060)
    return forward - .22 * run(3140, 3600) + .2 * run(3650, 4460)
  }
  return { ...writingDrive(velocity, elapsed), envelope: smooth(elapsed / 180) * smooth((4600 - elapsed) / 180),
    label: elapsed < 300 ? '蓄力起步 →' : elapsed < 1400 ? '向右冲刺 →' : elapsed < 2170 && punctuationPauses ? '标点收势'
      : elapsed < 3070 ? '向右冲刺 →' : elapsed < 3650 ? '← 换行回冲' : elapsed < 4400 ? '向右冲刺 →' : '收势' }
}
