import { paintResident } from '../../../src/renderer/src/bart-motion/resident-painter'
import { graphemes } from '../../../src/renderer/src/bart-motion/resident-text'
import { arcSpan, reasoningText, type Pose } from './transition-model'

export function paintStudy(canvas: HTMLCanvasElement, pose: Pose, time: number, still: boolean): void {
  const ctx = canvas.getContext('2d')!
  const bounds = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1
  const width = Math.round(bounds.width * ratio), height = Math.round(bounds.height * ratio)
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
  ctx.resetTransform(); ctx.clearRect(0, 0, width, height)
  const scale = Math.min(width / 400, height / 310)
  ctx.translate((width - 400 * scale) / 2, (height - 310 * scale) / 2); ctx.scale(scale, scale)
  ctx.translate(88, 55); ctx.scale(.35, .35)
  const blinkAt = (time % 4200) - 3400
  const blink = still || blinkAt < 0 || blinkAt > 320 ? 1 : 1 - Math.sin(blinkAt / 320 * Math.PI) * .91
  const glyphs = graphemes(reasoningText).map((value, index, all) => ({ value, position: (index + .5) / all.length,
    opacity: Math.min(1, (index + 1) / 3, (all.length - index) / 3) }))
  paintResident(ctx, pose, { glyphs, toolName: 'read_file', span: arcSpan, center: -110 }, blink)
}
