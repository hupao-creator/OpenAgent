export interface DispatchDescription {
  source: { x: number; y: number }
  targets: readonly { x: number; y: number }[]
  color: string
}

function easing(t: number, x1: number, x2: number): number {
  let low = 0, high = 1
  for (let index = 0; index < 14; index++) {
    const p = (low + high) / 2, x = 3 * (1 - p) ** 2 * p * x1 + 3 * (1 - p) * p * p * x2 + p ** 3
    if (x < t) low = p; else high = p
  }
  const p = (low + high) / 2
  return 3 * (1 - p) * p * p + p ** 3
}

/** DOM-local dashed connections. The selected slot and endpoint geometry are
 * known at configuration; relocation and flow never query the host again. */
export function createCanvasDispatch(initial: DispatchDescription) {
  let description = initial, from = initial.source, started = performance.now(), moving = false
  const position = (now: number) => {
    const elapsed = now - started
    const t = moving ? easing(Math.min(1, elapsed / 720), .4, .2) : 1
    const beat = easing(Math.min(1, elapsed / 1050), .42, .58)
    const points = [[0, 0], [.2, -6], [.44, -14], [.68, 2], [.84, -3], [1, 0]]
    const index = Math.max(1, points.findIndex(point => point[0] >= beat))
    const a = points[index - 1], b = points[index]
    const lift = moving ? (a[1] + (b[1] - a[1]) * (beat - a[0]) / (b[0] - a[0])) * 1.7 : 0
    return { x: from.x + (description.source.x - from.x) * t,
      y: from.y + (description.source.y - from.y) * t + lift }
  }
  return {
    update(next: DispatchDescription) {
      const shifted = next.source.x !== description.source.x || next.source.y !== description.source.y
      if (shifted) { from = description.targets.length ? position(performance.now()) : next.source; started = performance.now(); moving = description.targets.length > 0 }
      description = next
    },
    nextWake(now: number): number { return description.targets.length ? now : Infinity },
    paint(context: OffscreenCanvasRenderingContext2D, now: number) {
      const source = position(now)
      context.strokeStyle = description.color; context.lineWidth = 1.5; context.lineCap = 'round'; context.globalAlpha = .7
      context.setLineDash([5, 7]); context.lineDashOffset = -(now % 1100) / 1100 * 24
      for (const target of description.targets) {
        const bend = (target.y - source.y) * .55
        context.beginPath(); context.moveTo(source.x, source.y)
        context.bezierCurveTo(source.x, source.y + bend, target.x, target.y - bend, target.x, target.y)
        context.stroke()
      }
      context.globalAlpha = 1
    }
  }
}
