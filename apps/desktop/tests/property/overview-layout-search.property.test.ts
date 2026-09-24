import fc from 'fast-check'
import { expect, it } from 'vitest'
import { layoutOverview, LayoutSearchLimitError, type LayoutPlacement } from '../../src/renderer/src/overview-layout'
import { originDistanceLowerBound, unitAssignmentRepairs } from '../../src/renderer/src/overview-layout-search'
import { executesStraightOrder, hasEnclosedVacancy, hasStraightOrder } from './overview-layout-movement-oracle'
import { check } from './check'

const geometry = { columnWidth: 360, rowHeight: 200, gap: 16 }
const unit = (id: string, col: number, row: number): LayoutPlacement => ({ id, col, row, cols: 1, rows: 1 })
function permutations(values: readonly number[]): number[][] {
  return values.length ? values.flatMap(n => permutations(values.filter(v => v !== n)).map(tail => [n, ...tail])) : [[]]
}
const assignments = permutations([0, 1, 2, 3])
const distance = (old: readonly LayoutPlacement[], next: readonly LayoutPlacement[], g = geometry): number => next.reduce((sum, p) => {
  const before = old.find(a => a.id === p.id)
  return sum + (before ? Math.sqrt(((p.col - before.col) * (g.columnWidth + g.gap)) ** 2 + ((p.row - before.row) * (g.rowHeight + g.gap)) ** 2) : 0)
}, 0)

it('overview layout search: origin bounds never exceed an independently enumerated endpoint optimum', () => {
  check('overview layout search: origin bounds never exceed an independently enumerated endpoint optimum', fc.property(fc.record({
    slots: fc.uniqueArray(fc.integer({ min: 0, max: 15 }), { minLength: 4, maxLength: 4 }),
    count: fc.integer({ min: 1, max: 4 }), entrant: fc.boolean(), col: fc.nat(4), row: fc.nat(4),
    width: fc.integer({ min: 1, max: 40 }), height: fc.integer({ min: 1, max: 40 }), gap: fc.nat(5)
  }), value => {
    const old = value.slots.map((slot, i) => unit(String(i), slot % 4, Math.floor(slot / 4)))
    const next = old.slice(0, value.count).map((p, i) => value.entrant && i === 0 ? { ...p, id: 'new' } : p)
    const box = { col: value.col, row: value.row, cols: 2, rows: 2 }
    const g = { columnWidth: value.width, rowHeight: value.height, gap: value.gap }
    const costs = assignments.map(cells => distance(old, next.map((p, i) => ({ ...p, col: box.col + cells[i]! % 2, row: box.row + Math.floor(cells[i]! / 2) })), g))
    const bound = originDistanceLowerBound(old, next, box, g)
    expect(bound).toBeGreaterThanOrEqual(0)
    expect(bound).toBeLessThanOrEqual(Math.min(...costs) + 1e-9)
  }))
})

it('overview layout search: conflict branches cover every legal finite-domain alternative', () => {
  check('overview layout search: conflict branches cover every legal finite-domain alternative', fc.property(fc.record({
    slots: fc.uniqueArray(fc.integer({ min: 0, max: 8 }), { minLength: 4, maxLength: 4 }),
    count: fc.integer({ min: 1, max: 4 }), current: fc.constantFrom(...assignments), banned: fc.nat(15)
  }), ({ slots, count, current, banned }) => {
    const old = slots.slice(0, count).map((slot, i) => unit(String(i), slot % 3, Math.floor(slot / 3)))
    const cells = [0, 1, 2, 3].map(i => ({ col: i % 2, row: Math.floor(i / 2) }))
    const place = (mapping: readonly number[]) => old.map((p, i) => ({ ...p, ...cells[mapping[i]!]! }))
    const allowed = (mapping: readonly number[], constraints: ReadonlySet<number>) => mapping.every((cell, row) => !constraints.has(row * cells.length + cell))
    const forbidden = new Set(current[Math.floor(banned / 4)] === banned % 4 ? [] : [banned])
    const candidate = place(current)
    const repairs = unitAssignmentRepairs(old, [], candidate, cells, current, forbidden, geometry)
    const legal = (next: readonly LayoutPlacement[]) => !hasEnclosedVacancy(next) && hasStraightOrder(old, next)
    if (legal(candidate)) { expect(repairs).toBeNull(); return }
    expect(repairs).not.toBeNull()
    for (const mapping of assignments) if (allowed(mapping, forbidden) && legal(place(mapping)))
      expect(repairs!.some(branch => allowed(mapping, branch)), JSON.stringify({ old, current, mapping })).toBe(true)
  }))
})

const legacy = (x = 0, y = 0) => Array.from({ length: 24 }, (_, i) => unit(String(i + 1).padStart(2, '0'), i % 3 + x, Math.floor(i / 3) + y))

it('overview layout search: the full domain can move farther than the candidate neighbourhood', () => {
  check('overview layout search: the full domain can move farther than the candidate neighbourhood', fc.property(fc.integer({ min: 4, max: 8 }), separation => {
    const previous = [unit('A', 0, 0), unit('B', separation, 0)]
    const result = layoutOverview(previous, previous, geometry, { requireSearchComplete: true })
    expect(result.searchComplete).toBe(true)
    expect(executesStraightOrder(previous, result.placements, result.moveOrder)).toBe(true)
    expect(result.bounds.cols).toBe(1)
    expect(result.bounds.rows).toBe(2)
    expect(result.placements.some(p => Math.abs(p.col - previous.find(a => a.id === p.id)!.col) > 1)).toBe(true)
  }))
})

const runBudget = (old: readonly LayoutPlacement[], budget: number) => {
  try { return layoutOverview(old, old, geometry, { maxSearchSteps: budget }) }
  catch (error) { if (!(error instanceof LayoutSearchLimitError)) throw error; return undefined }
}

it('overview layout search: extending a deterministic budget never worsens its incumbent', () => {
  check('overview layout search: extending a deterministic budget never worsens its incumbent', fc.property(fc.record({
    x: fc.nat(2), y: fc.nat(2), budget: fc.integer({ min: 1_000, max: 100_000 }), extra: fc.integer({ min: 1, max: 100_000 })
  }), ({ x, y, budget, extra }) => {
    const old = legacy(x, y)
    const before = runBudget(old, budget)
    const after = runBudget(old, budget + extra)
    if (before) {
      expect(after).toBeDefined()
      expect(after!.totalShiftDistance).toBeLessThanOrEqual(before.totalShiftDistance)
      const repeated = layoutOverview(before.placements, old, geometry, { maxSearchSteps: budget })
      expect(repeated.placements).toEqual(before.placements)
      expect(repeated.totalShiftDistance).toBe(0)
      expect(repeated.distanceOptimal).toBe(true)
    }
    if (after) {
      expect(after.work.steps).toBeLessThanOrEqual(budget + extra)
      expect(executesStraightOrder(old, after.placements, after.moveOrder)).toBe(true)
      expect(hasEnclosedVacancy(after.placements)).toBe(false)
    }
  }))
}, 130_000)
