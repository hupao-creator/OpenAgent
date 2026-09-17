/**
 * Bart 运动几何：三次贝塞尔、弧长均匀采样与路径抽象。
 *
 * 数值与采样方式移植自锁定的生产/Playground 实现（见
 * docs/bart-thread-overview-interaction-spec.md 与
 * docs/bart-webgl-playground-handoff.md）：t-均匀采样在贝塞尔中段天然加速、
 * 端点减速，按弧长重参数化保证去程/回程速度连续。
 */

export interface BartPoint {
  x: number
  y: number
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function smoothStep(value: number): number {
  const t = clamp01(value)
  return t * t * (3 - 2 * t)
}

function cubicPoint(start: number, controlA: number, controlB: number, end: number, progress: number): number {
  const remaining = 1 - progress
  return remaining ** 3 * start + 3 * remaining ** 2 * progress * controlA + 3 * remaining * progress ** 2 * controlB + progress ** 3 * end
}

function cubicTangent(start: number, controlA: number, controlB: number, end: number, progress: number): number {
  const remaining = 1 - progress
  return 3 * remaining ** 2 * (controlA - start)
    + 6 * remaining * progress * (controlB - controlA)
    + 3 * progress ** 2 * (end - controlB)
}

export interface BartCubicSegment {
  start: BartPoint
  controlA: BartPoint
  controlB: BartPoint
  end: BartPoint
}

interface ArcTable {
  ts: number[]
  lengths: number[]
  total: number
}

function buildArcTable(segment: BartCubicSegment, samples = 240): ArcTable {
  const ts = [0]
  const lengths = [0]
  let total = 0
  let previousX = segment.start.x
  let previousY = segment.start.y
  for (let index = 1; index <= samples; index += 1) {
    const t = index / samples
    const x = cubicPoint(segment.start.x, segment.controlA.x, segment.controlB.x, segment.end.x, t)
    const y = cubicPoint(segment.start.y, segment.controlA.y, segment.controlB.y, segment.end.y, t)
    total += Math.hypot(x - previousX, y - previousY)
    ts.push(t)
    lengths.push(total)
    previousX = x
    previousY = y
  }
  return { ts, lengths, total }
}

/** 按弧长比例 [0,1] 反查贝塞尔参数 t。 */
function arcT(table: ArcTable, fraction: number): number {
  const target = clamp01(fraction) * table.total
  let low = 0
  let high = table.lengths.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (table.lengths[middle] < target) low = middle + 1
    else high = middle
  }
  const upper = Math.max(1, low)
  const lower = upper - 1
  const span = table.lengths[upper] - table.lengths[lower]
  const ratio = span > 0 ? (target - table.lengths[lower]) / span : 0
  return table.ts[lower] + (table.ts[upper] - table.ts[lower]) * ratio
}

/**
 * 弧长均匀的路径采样器。运动帧只读取 fraction ∈ [0,1] 的位置与方向，
 * 不关心路径是单段贝塞尔还是多段复合。
 */
export interface BartPath {
  readonly length: number
  readonly start: BartPoint
  readonly end: BartPoint
  pointAt(fraction: number): BartPoint
  /** 归一化切线；零长度方向回退为 (1,0)，与 shader 的防御一致。 */
  tangentAt(fraction: number): BartPoint
}

function normalize(x: number, y: number): BartPoint {
  const length = Math.hypot(x, y)
  if (length < 0.0001) return { x: 1, y: 0 }
  return { x: x / length, y: y / length }
}

class CubicPath implements BartPath {
  readonly length: number
  readonly start: BartPoint
  readonly end: BartPoint
  private readonly segment: BartCubicSegment
  private readonly table: ArcTable

  constructor(segment: BartCubicSegment) {
    this.segment = segment
    this.start = segment.start
    this.end = segment.end
    this.table = buildArcTable(segment)
    this.length = this.table.total
  }

  pointAt(fraction: number): BartPoint {
    const t = arcT(this.table, fraction)
    const { start, controlA, controlB, end } = this.segment
    return {
      x: cubicPoint(start.x, controlA.x, controlB.x, end.x, t),
      y: cubicPoint(start.y, controlA.y, controlB.y, end.y, t)
    }
  }

  tangentAt(fraction: number): BartPoint {
    const t = arcT(this.table, fraction)
    const { start, controlA, controlB, end } = this.segment
    return normalize(
      cubicTangent(start.x, controlA.x, controlB.x, end.x, t),
      cubicTangent(start.y, controlA.y, controlB.y, end.y, t)
    )
  }
}

class CompositePath implements BartPath {
  readonly length: number
  readonly start: BartPoint
  readonly end: BartPoint
  private readonly spans: CubicPath[]

  constructor(segments: readonly BartCubicSegment[]) {
    this.spans = segments.map(segment => new CubicPath(segment))
    this.length = this.spans.reduce((total, span) => total + span.length, 0)
    this.start = this.spans[0]?.start ?? { x: 0, y: 0 }
    this.end = this.spans[this.spans.length - 1]?.end ?? this.start
  }

  private spanAt(fraction: number): { span: CubicPath; local: number } {
    const target = clamp01(fraction) * this.length
    let elapsed = 0
    for (const span of this.spans) {
      if (target <= elapsed + span.length || span === this.spans[this.spans.length - 1]) {
        return { span, local: span.length > 0 ? (target - elapsed) / span.length : 0 }
      }
      elapsed += span.length
    }
    const last = this.spans[this.spans.length - 1]
    return { span: last, local: 1 }
  }

  pointAt(fraction: number): BartPoint {
    const { span, local } = this.spanAt(fraction)
    return span.pointAt(local)
  }

  tangentAt(fraction: number): BartPoint {
    const { span, local } = this.spanAt(fraction)
    return span.tangentAt(local)
  }
}

export function createBartPath(segments: readonly BartCubicSegment[]): BartPath {
  if (segments.length === 1) return new CubicPath(segments[0])
  return new CompositePath(segments)
}
