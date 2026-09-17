import fc from 'fast-check'
import { expect, it } from 'vitest'
import { layoutOverview, LayoutSearchLimitError, type LayoutMember, type LayoutPlacement, type LayoutResult } from '../../src/renderer/src/overview-layout'
import { check, sequenceLength } from './check'
import { overviewLayoutCaseArbitrary } from './overview-layout-cases'
import { executesStraightOrder, hasStraightOrder, hasEnclosedVacancy } from './overview-layout-movement-oracle'

const geometry = { columnWidth: 360, rowHeight: 200, gap: 16 }

it('overview layout: plans real-card-sized groups through expansion and contraction within the default budget', () => {
  let previous: readonly LayoutPlacement[] = []
  const members = Array.from({ length: 24 }, (_, index) => ({ id: String(index + 1).padStart(2, '0'), cols: 2, rows: 1 }))
  for (const size of [{ cols: 2, rows: 1 }, { cols: 2, rows: 2 }, { cols: 1, rows: 1 }]) {
    const next = members.map((member, index) => index === 0 ? { ...member, ...size } : member)
    let result!: LayoutResult
    expect(() => { result = layoutOverview(previous, next, geometry) }, `target footprint ${size.cols}x${size.rows}`).not.toThrow()
    assertLegal(previous, next, result)
    expect(result.work.steps).toBeLessThanOrEqual(2_000_000)
    previous = result.placements
  }
})

it('overview layout: rejects unrepresentable geometry instead of escaping its budget', () => {
  const member = { id: 'A', cols: 1, rows: 1 }
  expect(() => layoutOverview([], [member], { columnWidth: Number.MIN_VALUE, rowHeight: 1, gap: 0 }, { maxSearchSteps: 20 })).toThrow(/geometry|aspect/i)
  expect(() => layoutOverview([], [{ ...member, cols: Number.MAX_SAFE_INTEGER }, { ...member, id: 'B' }], geometry)).toThrow(/aggregate/)
})

it('overview layout: completed floating search is distinct from a distance proof', () => {
  const previous = ['A', 'B'].map((id, col) => ({ id, col, row: 0, cols: 1, rows: 1 }))
  const result = layoutOverview(previous, previous, geometry)
  expect(result.searchComplete).toBe(true)
  expect(result.distanceOptimal).toBe(false)
  const stable = layoutOverview(result.placements, previous, geometry)
  expect(stable.searchComplete).toBe(true)
  expect(stable.distanceOptimal).toBe(true)
  expect(stable.totalShiftDistance).toBe(0)
})

it('overview layout: local candidates reach the known short reflow within the default budget', () => {
  const previous = Array.from({ length: 24 }, (_, i) => ({ id: String(i + 1).padStart(2, '0'), col: i % 3, row: Math.floor(i / 3), cols: 1, rows: 1 }))
  // Independent witness supplied with the algorithm review. This is a legal
  // competitor, not a claim that this particular placement is globally optimal.
  const rows = [[1, 4, 2, 3], [7, 5, 8, 6], [10, 11, 9, 12], [13, 14, 18, 15], [16, 20, 17, 21], [22, 19, 23, 24]]
  const witness = rows.flatMap((ids, row) => ids.map((id, col) => ({ id: String(id).padStart(2, '0'), col, row: row + 1, cols: 1, rows: 1 })))
  const order = [15, 18, 21, 24, 17, 20, 23, 19, 22, 12, 9, 6, 8, 5, 3, 2, 4, 1].map(id => String(id).padStart(2, '0'))
  expect(executesStraightOrder(previous, witness, order)).toBe(true)
  const result = layoutOverview(previous, previous, geometry)
  assertLegal(previous, previous, result)
  expect(result.totalShiftDistance).toBeLessThanOrEqual(travel(previous, witness) + 1e-6)
  expect(result.work.steps).toBeLessThanOrEqual(2_000_000)
  expect(result.work.candidateSteps).toBeGreaterThan(0)
})

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

it('overview layout: an unbounded number of columns remains available', () => {
  check('overview layout: an unbounded number of columns remains available', fc.property(fc.integer({ min: 24, max: 80 }), count => {
    const next = Array.from({ length: count }, (_, i) => ({ id: `card-${i}`, cols: 1, rows: 1 }))
    const result = layoutOverview([], next, geometry)
    assertLegal([], next, result)
    // Complete independent frontier for identical unit cells, not a fixed seed
    // or an assertion that every arbitrary large input must use >3 columns.
    const boxes = Array.from({ length: count }, (_, i) => ({ c: i + 1, r: Math.ceil(count / (i + 1)) }))
    const compact = boxes.filter(a => !boxes.some(b => b.c <= a.c && b.r <= a.r && (b.c < a.c || b.r < a.r)))
    const best = Math.min(...compact.map(({ c, r }) => { const w = c * 376 - 16; const h = r * 216 - 16; return Math.max(w, h) / Math.min(w, h) }))
    expect(result.aspect).toBe(best)
  }))
}, 130_000)

it('overview layout: 24 cards choose four by six and deletion never recenters survivors', () => {
  const next = Array.from({ length: 24 }, (_, i) => ({ id: `card-${i}`, cols: 1, rows: 1 }))
  const result = layoutOverview([], next, geometry)
  expect(result.bounds).toMatchObject({ cols: 4, rows: 6, width: 1488, height: 1280 })
  const kept = result.placements.filter(p => p.col > 0)
  const removed = layoutOverview(result.placements, kept, geometry)
  expect(removed.shiftedIds).toEqual([])
  expect(removed.placements).toEqual(kept)
  expect(removed.bounds.col).toBe(1)
})

it('overview layout: a squarer compact shape takes priority over zero shifts', () => {
  const previous = Array.from({ length: 24 }, (_, i) => ({ id: `card-${i}`, col: i % 3, row: Math.floor(i / 3), cols: 1, rows: 1 }))
  const result = layoutOverview(previous, previous, geometry)
  expect(result.bounds).toMatchObject({ cols: 4, rows: 6, width: 1488, height: 1280 })
  expect(result.totalShiftDistance).toBeGreaterThan(0)
  expect(result.aspect).toBeLessThan(1712 / 1112)
})

it('overview layout: aspect takes priority over keeping every old coordinate', () => {
  check('overview layout: aspect takes priority over keeping every old coordinate', fc.property(fc.integer({ min: 24, max: 60 }), count => {
    const previous = Array.from({ length: count }, (_, i) => ({ id: `old-${i}`, col: i % 3, row: Math.floor(i / 3), cols: 1, rows: 1 }))
    const result = layoutOverview(previous, previous, geometry, { maxSearchSteps: 200_000 })
    assertLegal(previous, previous, result)
    const allBoxes = Array.from({ length: count }, (_, i) => ({ c: i + 1, r: Math.ceil(count / (i + 1)) }))
    const boxes = allBoxes.filter(a => !allBoxes.some(b => b.c <= a.c && b.r <= a.r && (b.c < a.c || b.r < a.r)))
    const aspect = (p: { c: number; r: number }) => Math.max(p.c * 376 - 16, p.r * 216 - 16) / Math.min(p.c * 376 - 16, p.r * 216 - 16)
    const bestAspect = Math.min(...boxes.map(aspect))
    expect(result.aspect).toBe(bestAspect)
  }), 120_000)
}, 130_000)

it('overview layout: moving the growing member beats shifting two neighbours', () => {
  const previous = ['A', 'B', 'C'].map((id, col) => ({ id, col, row: 0, cols: 1, rows: 1 }))
  const result = layoutOverview(previous, previous.map(p => ({ ...p, cols: p.id === 'A' ? 3 : 1 })), geometry)
  expect(result.shiftedIds).toEqual(['A'])
  assertLegal(previous, previous.map(p => ({ ...p, cols: p.id === 'A' ? 3 : 1 })), result)
})

it('overview layout: no artificial spacing and no silent success after search exhaustion', () => {
  const next = ['A', 'B'].map(id => ({ id, cols: 1, rows: 1 }))
  const result = layoutOverview([{ ...next[0]!, col: 0, row: 0 }], next, geometry)
  expect(result.bounds).toMatchObject({ width: 360, height: 416 })
  expect(() => layoutOverview([], next, geometry, { maxSearchSteps: 1 })).toThrow(LayoutSearchLimitError)
})

it('overview layout: total distance beats the number of shifted members', () => {
  check('overview layout: total distance beats the number of shifted members', fc.property(fc.record({ x: fc.integer({ min: 0, max: 2 }), y: fc.integer({ min: 0, max: 2 }) }), offset => {
    const previous = [[4, 0], [5, 1], [2, 2], [3, 3]].map(([col, row], i) => ({ id: String(i), col: col! + offset.x, row: row! + offset.y, cols: 1, rows: 1 }))
    const result = layoutOverview(previous, previous, geometry)
    let minimum = Infinity; let threeMoved = Infinity
    // Four unit cards' optimal physical shape is 2×2. Enumerate all 4! identity
    // assignments at every useful origin, independently of Hungarian matching.
    for (let row = 0; row <= offset.y + 3; row++) for (let col = 0; col <= offset.x + 5; col++) {
      const cells = [0, 1, 2, 3].map(i => ({ col: col + i % 2, row: row + Math.floor(i / 2) }))
      const assign = (placed: LayoutPlacement[], remaining: readonly number[]): void => {
        if (placed.length === 4) {
          if (!hasStraightOrder(previous, placed)) return
          const distance = travel(previous, placed)
          minimum = Math.min(minimum, distance)
          const shifts = placed.filter(p => previous.some(a => a.id === p.id && (a.col !== p.col || a.row !== p.row))).length
          if (shifts === 3) threeMoved = Math.min(threeMoved, distance)
          return
        }
        for (const index of remaining) assign([...placed, { ...previous[placed.length]!, ...cells[index]! }], remaining.filter(n => n !== index))
      }
      assign([], [0, 1, 2, 3])
    }
    expect(result.bounds).toMatchObject({ cols: 2, rows: 2 })
    expect(result.totalShiftDistance).toBeCloseTo(minimum, 6)
    expect(Number.isFinite(threeMoved)).toBe(true)
    expect(result.totalShiftDistance).toBeLessThan(threeMoved)
    expect(result.shiftedIds).toHaveLength(4)
  }), 120_000)
}, 130_000)


it('overview layout: removal fills an enclosed vacancy with a legal straight move', () => {
  const previous = Array.from({ length: 24 }, (_, i) => ({ id: String(i + 1).padStart(2, '0'), col: i % 4, row: Math.floor(i / 4), cols: 1, rows: 1 }))
  const next = previous.filter(p => p.id !== '10')
  expect(hasEnclosedVacancy(next)).toBe(true)
  const result = layoutOverview(previous, next, geometry, { requireSearchComplete: true })
  assertLegal(previous, next, result)
  expect(result.bounds).toMatchObject({ cols: 4, rows: 6 })
  expect(result.totalShiftDistance).toBe(376)
  expect(result.placements.find(p => p.id === '09')).toMatchObject({ col: 1, row: 2 })
})

it('overview layout: a blocked shortest endpoint yields to an executable alternative', () => {
  const previous = ['A', 'B'].map((id, col) => ({ id, col, row: 0, cols: 1, rows: 1 }))
  const illegal = [{ ...previous[0]!, col: 1, row: 1 }, previous[1]!]
  expect(hasStraightOrder(previous, illegal)).toBe(false)
  const result = layoutOverview(previous, previous, geometry, { requireSearchComplete: true })
  assertLegal(previous, previous, result)
  expect(result.totalShiftDistance).toBe(592)
  expect(result.moveOrder).toHaveLength(2)
})


it('overview layout: every generated interior deletion closes its hole', () => {
  check('overview layout: every generated interior deletion closes its hole', fc.property(fc.record({ col: fc.integer({ min: 1, max: 2 }), row: fc.integer({ min: 1, max: 4 }) }), removed => {
    const previous = Array.from({ length: 24 }, (_, i) => ({ id: String(i), col: i % 4, row: Math.floor(i / 4), cols: 1, rows: 1 }))
    const next = previous.filter(p => p.col !== removed.col || p.row !== removed.row)
    const result = layoutOverview(previous, next, geometry)
    assertLegal(previous, next, result)
    expect(result.totalShiftDistance).toBeGreaterThan(0)
  }))
}, 130_000)

it('overview layout: generated blocked diagonals require two clear straight moves', () => {
  check('overview layout: generated blocked diagonals require two clear straight moves', fc.property(fc.record({ col: fc.integer({ min: 0, max: 4 }), row: fc.integer({ min: 0, max: 4 }) }), offset => {
    const previous = ['A', 'B'].map((id, col) => ({ id, col: col + offset.col, row: offset.row, cols: 1, rows: 1 }))
    const result = layoutOverview(previous, previous, geometry, { requireSearchComplete: true })
    assertLegal(previous, previous, result)
    expect(result.moveOrder).toHaveLength(2)
    expect(result.totalShiftDistance).toBe(592)
  }))
}, 130_000)
