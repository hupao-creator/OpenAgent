import type { CharacterDescription } from './worker-types'

/** Optional prepared accent. Kept above the rear shoulder so it does not ink
 * over the letters immediately behind the typesetting character. */
export function paintTravelTrail(ctx: OffscreenCanvasRenderingContext2D,
  trail: NonNullable<CharacterDescription['travelTrail']>, elapsed: number): void {
  if (!trail.points.length || elapsed < 0 || elapsed >= trail.duration) return
  let index = 0
  while (index + 1 < trail.points.length && trail.points[index + 1].at <= elapsed) index++
  const from = trail.points[index], to = trail.points[index + 1] ?? from
  const p = from === to ? 0 : Math.max(0, Math.min(1, (elapsed - from.at) / (to.at - from.at)))
  const eased = p * p * (3 - 2 * p)
  const strength = from.strength + (to.strength - from.strength) * eased
  const direction = from.direction + (to.direction - from.direction) * eased
  if (strength < .015 || Math.abs(direction) < .05) return
  ctx.save()
  ctx.translate(320, 300); ctx.scale(direction, 1)
  ctx.globalAlpha *= strength
  ctx.setLineDash([])
  if (trail.style === 'streaks') {
    ctx.lineCap = 'round'
    for (const [length, end, y, offset] of [[88, -120, -176, 0], [54, -145, -143, .5]]) {
      const phase = (elapsed / 440 + offset) % 1
      const shift = phase * 22, opacity = Math.sin(Math.PI * phase) ** 2
      const gradient = ctx.createLinearGradient(end - length - shift, 0, end - shift, 0)
      gradient.addColorStop(0, 'rgba(16,17,15,0)')
      gradient.addColorStop(1, `rgba(16,17,15,${.22 + .38 * opacity})`)
      ctx.strokeStyle = gradient; ctx.lineWidth = 14
      ctx.beginPath(); ctx.moveTo(end - length - shift, y); ctx.lineTo(end - shift, y); ctx.stroke()
    }
  } else {
    const gradient = ctx.createLinearGradient(-254, 0, -92, 0)
    gradient.addColorStop(0, 'rgba(16,17,15,0)')
    gradient.addColorStop(1, 'rgba(16,17,15,.34)')
    ctx.fillStyle = gradient
    ctx.beginPath(); ctx.moveTo(-254, -140)
    ctx.bezierCurveTo(-204, -177, -157, -187, -82, -154)
    ctx.bezierCurveTo(-157, -166, -185, -137, -254, -140)
    ctx.fill()
  }
  ctx.restore()
}
