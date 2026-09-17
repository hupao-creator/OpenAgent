import type { BartInterventionVisualState } from './character-model'

type Frame = { at: number; x?: number; y?: number; sx?: number; sy?: number; rotation?: number; alpha?: number }
const neutral = { x: 0, y: 0, sx: 1, sy: 1, rotation: 0, alpha: 1 }
const requestTracks: Partial<Record<BartInterventionVisualState, readonly Frame[]>> = {
  allow: [{ at: 0, x: -24, sx: .78, alpha: 0 }, { at: 150, x: 25, sx: .81 },
    { at: 600, x: 174, sx: .9 }, { at: 900, x: 286, sx: .96 }, { at: 1250, x: 420, sx: .78, alpha: 0 }],
  deny: [{ at: 0, x: -20, sx: .82, alpha: 0 }, { at: 165, x: 29, sx: .85 },
    { at: 572, x: 150, sx: .94 }, { at: 726, x: 132, sx: .94, rotation: -8 },
    { at: 1100, x: -78, sx: .78, rotation: -14, alpha: 0 }],
  answer: [{ at: 0, x: -20, sx: .82, alpha: 0 }, { at: 130, x: 25, sx: .81 },
    { at: 518, x: 158, sx: .78 }, { at: 720, x: 190, sx: .28, alpha: 0 }]
}
const answerTrack: readonly Frame[] = [{ at: 520, x: -150, sx: .35, alpha: 0 },
  { at: 790, x: -116, sx: .82 }, { at: 1420, x: 62, sx: .96, alpha: 0 }]
const bodyTracks: Partial<Record<BartInterventionVisualState, readonly Frame[]>> = {
  allow: [{ at: 190 }, { at: 568, sx: 1.07, sy: .96 }, { at: 1090 }],
  deny: [{ at: 220 }, { at: 577, x: 10, sx: .96, sy: 1.03 }, { at: 747, x: -8, rotation: -1.5 }, { at: 1070 }],
  answer: [{ at: 180 }, { at: 537, sx: 1.035, sy: 1.035, x: 5 },
    { at: 810, sx: .96, sy: 1.04, x: -4 }, { at: 1230 }]
}
function sample(track: readonly Frame[], elapsed: number, uniform = false) {
  let index = 0
  while (index + 1 < track.length && track[index + 1].at <= elapsed) index++
  const a = { ...neutral, ...track[index] }, b = { ...neutral, ...(track[index + 1] ?? track[index]) }
  if (uniform) { a.sy = a.sx; b.sy = b.sx }
  const t = b.at === a.at ? 0 : Math.max(0, Math.min(1, (elapsed - a.at) / (b.at - a.at)))
  const p = t * t * (3 - 2 * t)
  return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p,
    sx: a.sx + (b.sx - a.sx) * p, sy: a.sy + (b.sy - a.sy) * p,
    rotation: a.rotation + (b.rotation - a.rotation) * p, alpha: a.alpha + (b.alpha - a.alpha) * p }
}
function place(ctx: OffscreenCanvasRenderingContext2D, pose: typeof neutral, x: number, y: number): void {
  ctx.translate(x + pose.x, y + pose.y)
  ctx.rotate(pose.rotation * Math.PI / 180); ctx.scale(pose.sx, pose.sy); ctx.translate(-x, -y)
  ctx.globalAlpha *= pose.alpha
}
let request: Path2D | undefined, answer: Path2D | undefined, lines: Path2D | undefined

/** The token and body tracks share the Worker clock, including delayed answers. */
export function paintInterventionTokens(ctx: OffscreenCanvasRenderingContext2D, state: BartInterventionVisualState | undefined, elapsed: number): void {
  const track = state ? requestTracks[state] : undefined
  if (!track && state !== 'processing') return
  const pulse = .5 - Math.cos(elapsed / 1150 * Math.PI * 2) / 2
  const pose = state === 'processing' ? { ...neutral, x: 12 * pulse, sx: .9 + .1 * pulse,
    sy: .9 + .1 * pulse, alpha: .72 + .28 * pulse } : sample(track!, elapsed, true)
  if (pose.alpha > 0) {
    request ??= new Path2D('M124 302H157M147 291L159 302L147 313')
    ctx.save(); place(ctx, pose, 142, 302)
    ctx.fillStyle = '#fbfaf6'; ctx.strokeStyle = '#747770'; ctx.lineWidth = 5
    ctx.beginPath(); ctx.roundRect(106, 276, 72, 52, 15); ctx.fill(); ctx.stroke()
    ctx.strokeStyle = '#30322e'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.stroke(request); ctx.restore()
  }
  if (state === 'answer' && elapsed >= 520 && elapsed < 1420) {
    answer ??= new Path2D('M466 274H532C544 274 554 284 554 296V319C554 331 544 341 532 341H502L486 354L489 341H466C454 341 444 331 444 319V296C444 284 454 274 466 274Z')
    lines ??= new Path2D('M468 296H530M468 310H518M468 324H506')
    ctx.save(); place(ctx, sample(answerTrack, elapsed, true), 499, 311)
    ctx.fillStyle = '#6f5bdd'; ctx.strokeStyle = '#4d3bb8'; ctx.lineWidth = 4; ctx.lineJoin = 'round'
    ctx.fill(answer); ctx.stroke(answer)
    ctx.strokeStyle = '#f7f5ee'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.stroke(lines); ctx.restore()
  }
}

export function transformInterventionBody(ctx: OffscreenCanvasRenderingContext2D, state: BartInterventionVisualState | undefined, elapsed: number): void {
  if (state === 'processing') {
    const pulse = .5 - Math.cos(elapsed / 1500 * Math.PI * 2) / 2
    place(ctx, { ...neutral, rotation: -1 + pulse * 2, y: -pulse * 4 }, 320, 300)
  } else if (state && bodyTracks[state]) place(ctx, sample(bodyTracks[state], elapsed), 320, 300)
}
