import { describe, expect, it } from 'vitest'
import { planRoute, type BartObstacle } from '../src/renderer/src/bart-motion/planner'

const obstacle = (id: string, x: number, y: number, width: number, height: number): BartObstacle => ({
  id,
  kind: 'thread-card',
  rect: { x, y, width, height }
})

const AVOID = { mode: 'avoid', fallback: 'overfly' } as const

function expectClears(
  route: ReturnType<typeof planRoute>,
  obstacles: readonly BartObstacle[],
  clearance: number
): void {
  const blocked = obstacles
    .map(item => ({
      x: item.rect.x - clearance,
      y: item.rect.y - clearance,
      width: item.rect.width + clearance * 2,
      height: item.rect.height + clearance * 2
    }))
  const samples = Math.max(64, Math.ceil(route.path.length / 2))
  for (let index = 0; index <= samples; index += 1) {
    const point = route.path.pointAt(index / samples)
    for (const rect of blocked) {
      const inside =
        point.x > rect.x && point.x < rect.x + rect.width &&
        point.y > rect.y && point.y < rect.y + rect.height
      expect(inside, `采样点 (${point.x.toFixed(1)}, ${point.y.toFixed(1)}) 穿入扩张障碍 ${JSON.stringify(rect)}`).toBe(false)
    }
  }
}

describe('bart-motion planRoute', () => {
  it('默认 overfly：单段贝塞尔，端点吻合，弧长均匀采样', () => {
    const route = planRoute({ from: { x: 0, y: 0 }, to: { x: 400, y: 120 }, random: () => 0.9 })
    expect(route.mode).toBe('overfly')
    expect(route.fallback).toBe(false)
    expect(route.cubic).not.toBeNull()
    expect(route.path.start).toEqual({ x: 0, y: 0 })
    expect(route.path.end).toEqual({ x: 400, y: 120 })
    expect(route.path.length).toBeGreaterThan(Math.hypot(400, 120))
    const straight = Math.hypot(400, 120)
    // 弧长均匀：相邻采样弧长近似相等（路径近似直线时可直接比较欧氏距离）。
    const samples = 24
    let previous = route.path.pointAt(0)
    const steps: number[] = []
    for (let index = 1; index <= samples; index += 1) {
      const point = route.path.pointAt(index / samples)
      steps.push(Math.hypot(point.x - previous.x, point.y - previous.y))
      previous = point
    }
    const average = straight / samples
    for (const step of steps) {
      expect(Math.abs(step - average) / average).toBeLessThan(0.12)
    }
  })

  it('avoid 直达：无障碍时路径为直线且不回退', () => {
    const route = planRoute({
      from: { x: 0, y: 0 },
      to: { x: 400, y: 0 },
      spec: AVOID,
      obstacles: []
    })
    expect(route.mode).toBe('avoid')
    expect(route.fallback).toBe(false)
    expect(route.path.end).toEqual({ x: 400, y: 0 })
    expect(route.path.length).toBeCloseTo(400, 0)
  })

  it('avoid 单卡绕行：轨迹不穿过扩张后的障碍', () => {
    const cards = [obstacle('a', 150, -50, 100, 100)]
    const route = planRoute({
      from: { x: 0, y: 0 },
      to: { x: 400, y: 0 },
      spec: AVOID,
      obstacles: cards,
      bartRadius: 0
    })
    expect(route.mode).toBe('avoid')
    expect(route.fallback).toBe(false)
    expectClears(route, cards, 12)
  })

  it('avoid 多卡绕行：连续绕过两张卡片', () => {
    const cards = [
      obstacle('a', 120, -60, 90, 120),
      obstacle('b', 260, 20, 90, 120)
    ]
    const route = planRoute({
      from: { x: 0, y: 0 },
      to: { x: 460, y: 0 },
      spec: AVOID,
      obstacles: cards,
      bartRadius: 20
    })
    expect(route.mode).toBe('avoid')
    expect(route.fallback).toBe(false)
    expectClears(route, cards, 32)
  })

  it('avoid 排除源和目标：包含端点的卡片不作为障碍', () => {
    const cards = [obstacle('self', -20, -20, 60, 60)]
    const route = planRoute({
      from: { x: 10, y: 10 },
      to: { x: 300, y: 10 },
      spec: AVOID,
      obstacles: cards
    })
    expect(route.mode).toBe('avoid')
    expect(route.fallback).toBe(false)
    expect(route.path.length).toBeCloseTo(290, 0)
  })

  it('avoid 无路回退：四面墙封闭源点时回退 overfly 并标记 fallback', () => {
    const walls = [
      obstacle('top', -100, 30, 200, 20),
      obstacle('bottom', -100, -50, 200, 20),
      obstacle('left', -130, -100, 20, 200),
      obstacle('right', 110, -100, 20, 200)
    ]
    const route = planRoute({
      from: { x: 0, y: 0 },
      to: { x: 300, y: 0 },
      spec: AVOID,
      obstacles: walls,
      bartRadius: 0,
      random: () => 0.9
    })
    expect(route.mode).toBe('overfly')
    expect(route.fallback).toBe(true)
    expect(route.path.start).toEqual({ x: 0, y: 0 })
    expect(route.path.end).toEqual({ x: 300, y: 0 })
  })
})
