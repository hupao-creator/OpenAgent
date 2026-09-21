import { BODY_COLOR, EYE_COLOR } from './character-model'
import { REASONING_CENTER } from './reasoning-geometry'
import { RUNNING_DOT_RADIUS } from './running-story'
import { bodyPath, type Pose } from './resident-pose'
import { graphemes, type ResidentGlyph } from './resident-text'

const clamp = (n: number): number => Math.min(1, Math.max(0, n))
let silhouette: Path2D | undefined
export interface ResidentContent { glyphs: readonly ResidentGlyph[]; toolName: string; center: number; span: number }

/** Production and Lab share every painted pixel; geometry is authored on the
 * original 400×310 study stage and mapped back into Bart's 640-unit surface. */
export function paintResident(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  pose: Pose, content: ResidentContent, blink = 1): void {
  const shadowScale = Math.hypot(ctx.getTransform().a, ctx.getTransform().b)
  ctx.save(); ctx.scale(1 / .35, 1 / .35); ctx.translate(-88, -55)
  silhouette ??= new Path2D(bodyPath)
  ctx.save()
  ctx.translate(88, 55); ctx.scale(.35, .35)
  ctx.translate(pose.x, pose.y)
  ctx.translate(320, 300); ctx.rotate(pose.angle * Math.PI / 180); ctx.scale(pose.sx, pose.sy); ctx.translate(-320, -300)
  ctx.fillStyle = BODY_COLOR
  ctx.shadowColor = 'rgba(32,35,44,.16)'; ctx.shadowBlur = 22 * shadowScale; ctx.shadowOffsetY = 28 * shadowScale
  ctx.fill(silhouette)
  ctx.shadowColor = 'transparent'
  ctx.fillStyle = EYE_COLOR
  for (const side of ['l', 'r'] as const) {
    ctx.save(); ctx.translate(pose[`${side}x`], pose[`${side}y`]); ctx.rotate(pose[`${side}a`] * Math.PI / 180)
    const w = Math.max(1, pose[`${side}w`]), h = Math.max(2, pose[`${side}h`] * blink * clamp(pose.lid))
    ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) / 2); ctx.fill(); ctx.restore()
  }
  ctx.restore()
  // Shared external anchor: the text arc, status token and label meet here.
  if (pose.dotAlpha > .001) {
    ctx.save(); ctx.translate(88, 55); ctx.scale(.35, .35); ctx.translate(pose.x, pose.y)
    ctx.globalAlpha = clamp(pose.dotAlpha)
    ctx.beginPath(); ctx.arc(pose.dotX, pose.dotY, Math.max(1, pose.dotRadius) * (.8 + clamp(pose.dotAlpha) * .2), 0, Math.PI * 2)
    ctx.fillStyle = `rgb(${pose.dotRed} ${pose.dotGreen} ${pose.dotBlue})`; ctx.fill()
    if (pose.dotStroke > .1) { ctx.strokeStyle = EYE_COLOR; ctx.lineWidth = pose.dotStroke; ctx.stroke() }
    if (pose.replyAlpha > .001) {
      ctx.globalAlpha *= clamp(pose.replyAlpha)
      ctx.fillStyle = '#fff'; ctx.font = '48.57px -apple-system, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('1', pose.dotX - 1.43, pose.dotY - 2.86)
    }
    ctx.restore()
  }

  ctx.save(); ctx.translate(88, 55); ctx.scale(.35, .35)
  ctx.translate(pose.x, pose.y)
  for (const index of [0, 1, 2] as const) {
    if (pose[`d${index}a`] <= .001) continue
    ctx.globalAlpha = clamp(pose[`d${index}a`])
    ctx.fillStyle = `rgb(${pose[`d${index}r`]} ${pose[`d${index}g`]} ${pose[`d${index}b`]})`
    ctx.beginPath(); ctx.arc(pose[`d${index}x`], pose[`d${index}y`], RUNNING_DOT_RADIUS * Math.max(.05, pose[`d${index}s`]), 0, Math.PI * 2); ctx.fill()
  }
  ctx.restore()

  if (pose.arcAlpha > .001) {
    ctx.save(); ctx.globalAlpha = clamp(pose.arcAlpha) * .7
    ctx.translate(pose.x * .35, pose.y * .35 + pose.arcOffset)
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif'; ctx.fillStyle = '#718269'
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
    content.glyphs.forEach(({ value: char, position, opacity }) => {
      const group = Math.min(2, Math.floor(position * 3))
      const seed = pose.arcCenter + (group - 1) * content.span / 3 * pose.arcGroupSpan
      const unfolded = content.center + (position - .5) * content.span
      const angle = (unfolded + (seed - unfolded) * clamp(pose.arcGather)) * Math.PI / 180
      // Each group opens from the same point occupied by its loading seed.
      const distance = Math.abs(position * 3 - group - .5) * 2
      const reveal = clamp((pose.arcReveal * 1.25 - distance) / .25)
      const seedIndex = group as 0 | 1 | 2
      const gather = clamp(pose.arcGather), grouped = clamp(pose.arcGroupSpan)
      const ink = [113, 130, 105].map((base, channel) => {
        const key = (['r', 'g', 'b'] as const)[channel]
        const token = [pose.dotRed, pose.dotGreen, pose.dotBlue][channel]
        const seed = token + (pose[`d${seedIndex}${key}`] - token) * grouped
        return base + (seed - base) * gather * .8
      })
      ctx.save(); ctx.translate(REASONING_CENTER.x + Math.cos(angle) * pose.arcRadius,
        REASONING_CENTER.y + Math.sin(angle) * pose.arcRadius)
      ctx.rotate(angle + Math.PI / 2)
      ctx.globalAlpha *= reveal * (1 - clamp(pose.arcGather) * .6) * opacity
      ctx.fillStyle = `rgb(${ink.join(' ')})`
      ctx.fillText(char, 0, 0); ctx.restore()
    })
    ctx.restore()

  }
  if (pose.toolAlpha > .001) {
    ctx.save(); ctx.globalAlpha = clamp(pose.toolAlpha); ctx.translate(pose.x * .35, pose.y * .35 + pose.toolOffset)
    ctx.font = '10px ui-monospace, SFMono-Regular, monospace'
    let name = content.toolName
    if (ctx.measureText(name).width > 108) {
      const chars = graphemes(name)
      while (chars.length && ctx.measureText(chars.join('') + '…').width > 108) chars.pop()
      name = chars.join('') + '…'
    }
    const span = ctx.measureText(name).width + 5, opened = clamp(pose.toolReveal)
    ctx.fillStyle = '#9ba393'; ctx.fillText('(', pose.toolX - 5, 121)
    ctx.fillText(')', pose.toolX + span * opened, 121)
    ctx.save(); ctx.beginPath(); ctx.rect(pose.toolX, 108, span * opened, 18); ctx.clip()
    ctx.fillStyle = '#788173'; ctx.fillText(name, pose.toolX, 121); ctx.restore(); ctx.restore()
  }
  ctx.restore()
}
