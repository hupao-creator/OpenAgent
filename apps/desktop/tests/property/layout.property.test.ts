import fc from 'fast-check'
import { expect, it } from 'vitest'
import { resolveDockPlacement, type DockPlacementInput } from '../../src/renderer/src/components/bart-dock-placement'
import { check } from './check'

const coordinate = fc.integer({ min: -400, max: 1200 }).map(n => n / 2)
const size = fc.integer({ min: 1, max: 600 }).map(n => n / 2)
const point = fc.record({ x: coordinate, y: coordinate })
const rect = fc.record({ x: coordinate, y: coordinate, width: size, height: size })
const input: fc.Arbitrary<DockPlacementInput> = fc.record({
  bounds: rect, body: fc.record({ offset: point, size: fc.record({ width: size, height: size }) }),
  home: point, current: point, clearance: fc.integer({ min: 0, max: 30 }),
  obstacles: fc.array(rect, { maxLength: 12 })
})

it('layout is deterministic and non-fallback placements obey geometry', () => {
  check('layout is deterministic', fc.property(input, value => {
    const before = structuredClone(value)
    const result = resolveDockPlacement(value)
    expect(resolveDockPlacement(structuredClone(value))).toEqual(result)
    expect(value).toEqual(before)
    const { x, y } = result.position
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
    expect(x).toBeGreaterThanOrEqual(value.bounds.x)
    expect(x).toBeLessThanOrEqual(value.bounds.x + value.bounds.width)
    expect(y).toBeGreaterThanOrEqual(value.bounds.y)
    expect(y).toBeLessThanOrEqual(value.bounds.y + value.bounds.height)
    if (result.kind === 'fallback') return
    // Independent separating-axis assertion; do not call the production free-space predicate.
    const left = x + value.body.offset.x
    const top = y + value.body.offset.y
    for (const obstacle of value.obstacles) {
      expect(left + value.body.size.width <= obstacle.x - value.clearance ||
        left >= obstacle.x + obstacle.width + value.clearance ||
        top + value.body.size.height <= obstacle.y - value.clearance ||
        top >= obstacle.y + obstacle.height + value.clearance).toBe(true)
    }
  }))
}, 130_000)
