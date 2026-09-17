/**
 * Bart 路线规划。
 *
 * - `overfly` 沿用锁定的贝塞尔几何（控制点、弧长均匀采样不变）；
 * - `avoid` 把可见卡片扩张为「卡片矩形 + Bart 最大碰撞半径 + 间距」，
 *   用矩形角点 visibility graph + 带转弯惩罚的最短路径求折线，平滑为
 *   Bézier 后再次采样检查碰撞；无可行路径或平滑失败时回退 `overfly`。
 */

import {
  createBartPath,
  type BartCubicSegment,
  type BartPath,
  type BartPoint
} from './geometry'
import type { BartRouteSpec } from './types'

/** 规划器不依赖 DOM 注册表：障碍以纯几何矩形输入。 */
interface BartObstacleRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BartObstacle {
  id: string
  kind: 'thread-card'
  rect: BartObstacleRect
}

interface PlannedRoute {
  readonly mode: 'overfly' | 'avoid'
  /** avoid 无法求解或平滑失败时以 overfly 代替，fallback=true。 */
  readonly fallback: boolean
  readonly path: BartPath
  /** 单段贝塞尔（overfly）的控制几何；avoid 平滑后为 null。 */
  readonly cubic: BartCubicSegment | null
}

interface PlanRouteOptions {
  from: BartPoint
  to: BartPoint
  spec?: BartRouteSpec
  obstacles?: readonly BartObstacle[]
  /** Bart 最大碰撞半径：障碍扩张量 = radius + clearance。 */
  bartRadius?: number
  /** 测试可注入确定性随机源。 */
  random?: () => number
}

const DEFAULT_CLEARANCE_PX = 12
/** 转弯惩罚：每 90° 约等于多飞 40px，抑制 visibility graph 的锯齿抖动。 */
const TURN_PENALTY_PER_RIGHT_ANGLE = 40
/** 角点恰好落在障碍边界上；边检测时内缩 0.5px 允许贴角通过。 */
const CORNER_GRAZE_INSET = 0.5
/** 平滑后碰撞复检的采样间距（px）。 */
const COLLISION_SAMPLE_STEP = 4

interface ExpandableRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 锁定的 overfly 控制几何。`arc: 'current'` 保持生产数值（随机侧向 ±，
 * 弧高随距离在 [30,86] 之间）；`arc: 'short'` 压低弧高，接近直达。
 */
function computeOverflySegment(
  from: BartPoint,
  to: BartPoint,
  options: {
    arc?: 'current' | 'short'
    direction?: 1 | -1
    /** 接力回程等变体：弧高区间与控制点缩放。 */
    arcRange?: { min: number; max: number; scale: number }
    controlBScale?: number
    random?: () => number
  } = {}
): BartCubicSegment {
  const random = options.random ?? Math.random
  const deltaX = to.x - from.x
  const deltaY = to.y - from.y
  const distance = Math.max(1, Math.hypot(deltaX, deltaY))
  const unitX = deltaX / distance
  const unitY = deltaY / distance
  const direction = options.direction ?? (random() > .5 ? 1 : -1)
  const normalX = -unitY
  const normalY = unitX
  const arcRange = options.arcRange
    ?? (options.arc === 'short'
      ? { min: 10, max: 40, scale: .04 }
      : { min: 30, max: 86, scale: .09 + random() * .035 })
  const arc = Math.min(arcRange.max, Math.max(arcRange.min, distance * arcRange.scale)) * direction
  const controlBScale = options.controlBScale ?? .52
  return {
    start: { ...from },
    controlA: {
      x: from.x + deltaX * .3 + normalX * arc,
      y: from.y + deltaY * .3 + normalY * arc
    },
    controlB: {
      x: from.x + deltaX * .72 + normalX * arc * controlBScale,
      y: from.y + deltaY * .72 + normalY * arc * controlBScale
    },
    end: { ...to }
  }
}

function expandRect(rect: ExpandableRect, by: number): ExpandableRect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + by * 2,
    height: rect.height + by * 2
  }
}

function pointInRect(point: BartPoint, rect: ExpandableRect, inset = 0): boolean {
  return point.x > rect.x + inset
    && point.x < rect.x + rect.width - inset
    && point.y > rect.y + inset
    && point.y < rect.y + rect.height - inset
}

function segmentsCross(a1: BartPoint, a2: BartPoint, b1: BartPoint, b2: BartPoint): boolean {
  const cross = (o: BartPoint, p: BartPoint, q: BartPoint): number =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x)
  const d1 = cross(b1, b2, a1)
  const d2 = cross(b1, b2, a2)
  const d3 = cross(a1, a2, b1)
  const d4 = cross(a1, a2, b2)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/** 线段是否穿过矩形内部（端点贴边/贴角不算穿越）。 */
function segmentBlocked(from: BartPoint, to: BartPoint, rect: ExpandableRect): boolean {
  if (pointInRect(from, rect, CORNER_GRAZE_INSET) || pointInRect(to, rect, CORNER_GRAZE_INSET)) {
    return true
  }
  const corners = [
    { x: rect.x + CORNER_GRAZE_INSET, y: rect.y + CORNER_GRAZE_INSET },
    { x: rect.x + rect.width - CORNER_GRAZE_INSET, y: rect.y + CORNER_GRAZE_INSET },
    { x: rect.x + rect.width - CORNER_GRAZE_INSET, y: rect.y + rect.height - CORNER_GRAZE_INSET },
    { x: rect.x + CORNER_GRAZE_INSET, y: rect.y + rect.height - CORNER_GRAZE_INSET }
  ]
  for (let index = 0; index < 4; index += 1) {
    if (segmentsCross(from, to, corners[index], corners[(index + 1) % 4])) return true
  }
  return false
}

/** Catmull-Rom 折线平滑为逐段三次贝塞尔（经过全部路径点）。 */
function smoothPolyline(points: readonly BartPoint[]): BartCubicSegment[] {
  const segments: BartCubicSegment[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)]
    const p1 = points[index]
    const p2 = points[index + 1]
    const p3 = points[Math.min(points.length - 1, index + 2)]
    segments.push({
      start: { ...p1 },
      controlA: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      controlB: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      end: { ...p2 }
    })
  }
  return segments
}

/**
 * 矩形角点 visibility graph 上的最短路径。代价 = 欧氏距离 + 转弯惩罚，
 * 在（上一节点 → 当前节点）的有向边状态上跑 Dijkstra。
 */
function visibilityPolyline(
  from: BartPoint,
  to: BartPoint,
  rects: readonly ExpandableRect[]
): BartPoint[] | null {
  const nodes: BartPoint[] = [{ ...from }, { ...to }]
  for (const rect of rects) {
    nodes.push(
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height },
      { x: rect.x, y: rect.y + rect.height }
    )
  }
  const count = nodes.length
  const visible: boolean[][] = Array.from({ length: count }, () => Array.from({ length: count }, () => false))
  const distances: number[][] = Array.from({ length: count }, () => Array.from({ length: count }, () => 0))
  for (let a = 0; a < count; a += 1) {
    for (let b = a + 1; b < count; b += 1) {
      const blocked = rects.some(rect => segmentBlocked(nodes[a], nodes[b], rect))
      visible[a][b] = visible[b][a] = !blocked
      distances[a][b] = distances[b][a] = Math.hypot(nodes[b].x - nodes[a].x, nodes[b].y - nodes[a].y)
    }
  }

  interface EdgeState {
    prev: number
    /** -1 表示从起点出发的首条边（无入射方向，不惩罚）。 */
    curr: number
  }
  const key = (state: EdgeState): string => `${state.prev}:${state.curr}`
  const best = new Map<string, number>()
  const cameFrom = new Map<string, EdgeState>()
  const open: Array<{ state: EdgeState; cost: number }> = []
  const push = (state: EdgeState, cost: number): void => {
    open.push({ state, cost })
    // 节点数 ≤ 4N+2（可见卡片有限），线性取最小足够快，免去堆结构。
    open.sort((left, right) => right.cost - left.cost)
  }
  for (let next = 0; next < count; next += 1) {
    if (next !== 0 && visible[0][next]) {
      const state: EdgeState = { prev: 0, curr: next }
      best.set(key(state), distances[0][next])
      cameFrom.set(key(state), { prev: -1, curr: 0 })
      push(state, distances[0][next])
    }
  }
  let reached: EdgeState | null = null
  while (open.length) {
    const entry = open.pop()!
    const { state, cost } = entry
    if (cost > (best.get(key(state)) ?? Infinity)) continue
    if (state.curr === 1) {
      reached = state
      break
    }
    for (let next = 0; next < count; next += 1) {
      if (next === state.curr || next === state.prev || !visible[state.curr][next]) continue
      const incoming = Math.atan2(nodes[state.curr].y - nodes[state.prev].y, nodes[state.curr].x - nodes[state.prev].x)
      const outgoing = Math.atan2(nodes[next].y - nodes[state.curr].y, nodes[next].x - nodes[state.curr].x)
      let turn = Math.abs(outgoing - incoming) % (Math.PI * 2)
      if (turn > Math.PI) turn = Math.PI * 2 - turn
      const penalty = TURN_PENALTY_PER_RIGHT_ANGLE * (turn / (Math.PI / 2))
      const nextCost = cost + distances[state.curr][next] + penalty
      const nextState: EdgeState = { prev: state.curr, curr: next }
      if (nextCost < (best.get(key(nextState)) ?? Infinity)) {
        best.set(key(nextState), nextCost)
        cameFrom.set(key(nextState), state)
        push(nextState, nextCost)
      }
    }
  }
  if (!reached) return null
  const indices: number[] = []
  let cursor: EdgeState | undefined = reached
  while (cursor) {
    indices.unshift(cursor.curr)
    cursor = cursor.prev === -1 ? undefined : cameFrom.get(key(cursor))
  }
  return indices.map(index => nodes[index])
}

/** 平滑后的轨迹采样复检：任何采样点进入扩张障碍内部即判定失败。 */
function pathCollides(path: BartPath, rects: readonly ExpandableRect[]): boolean {
  const samples = Math.max(8, Math.ceil(path.length / COLLISION_SAMPLE_STEP))
  for (let index = 0; index <= samples; index += 1) {
    const point = path.pointAt(index / samples)
    if (rects.some(rect => pointInRect(point, rect))) return true
  }
  return false
}

export function planRoute(options: PlanRouteOptions): PlannedRoute {
  const spec = options.spec ?? { mode: 'overfly' as const }
  if (spec.mode === 'avoid') {
    const clearance = (options.bartRadius ?? 0) + (spec.clearancePx ?? DEFAULT_CLEARANCE_PX)
    const rects = (options.obstacles ?? [])
      .filter(obstacle => !spec.obstacleKinds || spec.obstacleKinds.includes(obstacle.kind))
      // 排除源和目标：包含线段端点的卡片（源卡片/目标卡位）不是障碍。
      .filter(obstacle => !pointInRect(options.from, obstacle.rect) && !pointInRect(options.to, obstacle.rect))
      .map(obstacle => expandRect(obstacle.rect, clearance))
    const polyline = visibilityPolyline(options.from, options.to, rects)
    if (polyline) {
      const segments = smoothPolyline(polyline)
      const path = createBartPath(segments)
      if (!pathCollides(path, rects)) {
        return { mode: 'avoid', fallback: false, path, cubic: null }
      }
    }
    // 无可行路径或平滑切角失败：按契约回退 overfly。
    const fallback = computeOverflySegment(options.from, options.to, { random: options.random })
    return {
      mode: 'overfly',
      fallback: true,
      path: createBartPath([fallback]),
      cubic: fallback
    }
  }
  const cubic = computeOverflySegment(options.from, options.to, {
    arc: spec.arc,
    random: options.random
  })
  return { mode: 'overfly', fallback: false, path: createBartPath([cubic]), cubic }
}
