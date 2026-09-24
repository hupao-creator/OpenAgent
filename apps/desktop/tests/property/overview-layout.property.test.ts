import fc from 'fast-check'
import { expect, it } from 'vitest'
import { layoutOverview, type LayoutMember, type LayoutPlacement, type LayoutResult } from '../../src/renderer/src/overview-layout'
import { check, sequenceLength } from './check'
import { overviewLayoutCaseArbitrary } from './overview-layout-cases'
import { executesStraightOrder, hasStraightOrder, hasEnclosedVacancy } from './overview-layout-movement-oracle'

const geometry = { columnWidth: 360, rowHeight: 200, gap: 16 }

const overlaps = (a: LayoutPlacement, b: LayoutPlacement): boolean =>
  !(a.col + a.cols <= b.col || b.col + b.cols <= a.col || a.row + a.rows <= b.row || b.row + b.rows <= a.row)
const travel = (old: readonly LayoutPlacement[], placed: readonly LayoutPlacement[]): number =>
  [...placed].sort((a, b) => a.id.localeCompare(b.id)).reduce((sum, p) => {
    const before = old.find(a => a.id === p.id)
    return sum + (before ? Math.sqrt(((p.col - before.col) * 376) ** 2 + ((p.row - before.row) * 216) ** 2) : 0)
  }, 0)

function bounds(placed: readonly LayoutPlacement[]) {
  if (!placed.length) return { col: 0, row: 0, cols: 0, rows: 0, width: 0, height: 0 }
  const col = Math.min(...placed.map(p => p.col)); const row = Math.min(...placed.map(p => p.row))
  const cols = Math.max(...placed.map(p => p.col + p.cols)) - col
  const rows = Math.max(...placed.map(p => p.row + p.rows)) - row
  return { col, row, cols, rows, width: cols * 360 + (cols - 1) * 16, height: rows * 200 + (rows - 1) * 16 }
}

function assertLegal(old: readonly LayoutPlacement[], next: readonly LayoutMember[], result: LayoutResult): void {
  expect(result.placements.map(({ id, cols, rows }) => ({ id, cols, rows })).sort((a, b) => a.id.localeCompare(b.id)))
    .toEqual(next.map(({ id, cols, rows }) => ({ id, cols, rows })).sort((a, b) => a.id.localeCompare(b.id)))
  for (const [i, p] of result.placements.entries()) {
    expect(Number.isSafeInteger(p.col) && p.col >= 0 && Number.isSafeInteger(p.row) && p.row >= 0).toBe(true)
    for (const other of result.placements.slice(i + 1)) expect(overlaps(p, other)).toBe(false)
  }
  expect(hasEnclosedVacancy(result.placements)).toBe(false)
  expect(executesStraightOrder(old, result.placements, result.moveOrder)).toBe(true)
  expect(result.bounds).toEqual(bounds(result.placements))
  expect(result.shiftedIds).toEqual(old.filter(a => result.placements.some(b => a.id === b.id && (a.col !== b.col || a.row !== b.row))).map(p => p.id).sort())
  expect(result.totalShiftDistance).toBeCloseTo(travel(old, result.placements), 6)
  expect(result.aspect).toBe(next.length ? Math.max(result.bounds.width, result.bounds.height) / Math.min(result.bounds.width, result.bounds.height) : null)
}

// Tiny exact oracle enumerates absolute coordinates, not production box search,
// its candidate list, subset search, feasibility search or score helper.
function oracle(old: readonly LayoutPlacement[], next: readonly LayoutMember[]) {
  const maxCol = Math.max(0, ...old.map(p => p.col + p.cols)) + next.reduce((sum, m) => sum + m.cols, 0)
  const maxRow = Math.max(0, ...old.map(p => p.row + p.rows)) + next.reduce((sum, m) => sum + m.rows, 0)
  const frontier: Array<{ width: number; height: number; distance: number; witness: readonly LayoutPlacement[] }> = []
  const visit = (placed: LayoutPlacement[]): void => {
    if (placed.length === next.length) {
      if (hasEnclosedVacancy(placed)) return
      const box = bounds(placed)
      const distance = hasStraightOrder(old, placed) ? travel(old, placed) : Infinity
      if (frontier.some(p => p.width <= box.width && p.height <= box.height &&
        (p.width < box.width || p.height < box.height || p.distance <= distance))) return
      for (let i = frontier.length - 1; i >= 0; i--) if (box.width <= frontier[i]!.width && box.height <= frontier[i]!.height) frontier.splice(i, 1)
      frontier.push({ width: box.width, height: box.height, distance, witness: [...placed] })
      return
    }
    const member = next[placed.length]!
    for (let row = 0; row <= maxRow - member.rows; row++) for (let col = 0; col <= maxCol - member.cols; col++) {
      const p = { ...member, col, row }
      if (placed.some(other => overlaps(p, other))) continue
      visit([...placed, p])
    }
  }
  visit([])
  return frontier
}

const change = fc.record({ keep: fc.boolean(), cols: fc.integer({ min: 1, max: 2 }), rows: fc.integer({ min: 1, max: 2 }) })
const tiny = fc.record({
  slots: fc.uniqueArray(fc.integer({ min: 0, max: 5 }), { maxLength: 2 }),
  changes: fc.tuple(change, change),
  added: fc.array(fc.record({ cols: fc.integer({ min: 1, max: 2 }), rows: fc.integer({ min: 1, max: 2 }) }), { maxLength: 1 })
}).map(({ slots, changes, added }) => ({
  previous: slots.map((slot, i) => ({ id: `old-${i}`, cols: 1, rows: 1, col: slot % 3, row: Math.floor(slot / 3) })),
  next: [...slots.flatMap((_, i) => changes[i]!.keep ? [{ id: `old-${i}`, cols: changes[i]!.cols, rows: changes[i]!.rows }] : []),
    ...added.map((m, i) => ({ id: `new-${i}`, ...m }))]
}))

it('overview layout: exact compact aspect first, then minimum total distance', () => {
  check('overview layout: exact compact aspect first, then minimum total distance', fc.property(tiny, ({ previous, next }) => {
    const original = structuredClone({ previous, next })
    const result = layoutOverview(previous, next, geometry, { requireSearchComplete: true })
    assertLegal(previous, next, result)
    const expected = oracle(previous, next)
    if (next.length) {
      const box = result.bounds
      const dominanceWitness = expected.find(p => p.width <= box.width && p.height <= box.height && (p.width < box.width || p.height < box.height))
      expect(dominanceWitness, JSON.stringify({ result, dominanceWitness })).toBeUndefined()
      const best = Math.min(...expected.map(p => Math.max(p.width, p.height) / Math.min(p.width, p.height)))
      expect(result.aspect, JSON.stringify({ result, alternatives: expected })).toBe(best)
      const minimum = Math.min(...expected.filter(p => Math.max(p.width, p.height) / Math.min(p.width, p.height) === best).map(p => p.distance))
      expect(result.totalShiftDistance, JSON.stringify({ result, alternatives: expected })).toBeCloseTo(minimum, 6)
    }
    expect({ previous, next }).toEqual(original)
    expect(layoutOverview([...previous].reverse(), [...next].reverse(), geometry)).toEqual(result)
    expect(layoutOverview(result.placements, next, geometry).placements).toEqual(result.placements)
  }))
}, 130_000)

it('overview layout: generated transitions conserve geometry and minimize travel at equal shape', () => {
  check('overview layout: generated transitions conserve geometry and minimize travel at equal shape', fc.property(
    overviewLayoutCaseArbitrary(sequenceLength(15)), testCase => {
      let previous = testCase.previous
      for (const { members: next } of testCase.steps) {
        const result = layoutOverview(previous, next, geometry, { requireSearchComplete: true })
        assertLegal(previous, next, result)
        expect(layoutOverview(previous, next, geometry)).toEqual(result)
        expect(layoutOverview(result.placements, next, geometry).placements).toEqual(result.placements)
        // Swap equal-sized members: identical geometry is a certified legal,
        // equally compact/equally square competitor, independent of packing.
        for (let a = 0; a < result.placements.length; a++) for (let b = a + 1; b < result.placements.length; b++) {
          const A = result.placements[a]!; const B = result.placements[b]!
          if (A.cols !== B.cols || A.rows !== B.rows) continue
          const swapped = result.placements.map((p, i) => i === a ? { ...p, col: B.col, row: B.row } : i === b ? { ...p, col: A.col, row: A.row } : p)
          if (hasStraightOrder(previous, swapped)) expect(result.totalShiftDistance).toBeLessThanOrEqual(travel(previous, swapped) + 1e-6)
        }
        previous = result.placements
      }
    }))
}, 130_000)
