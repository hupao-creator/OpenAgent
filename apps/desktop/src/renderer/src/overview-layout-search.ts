import { planStraightMoves } from './overview-layout-movement'
import { layoutHoles } from './overview-layout-occupancy'
import type { LayoutGeometry, LayoutMember, LayoutPlacement } from './overview-layout'

export interface LayoutSearchBox { readonly col: number; readonly row: number; readonly cols: number; readonly rows: number }

/** Real-arithmetic lower bounds, evaluated with ordinary floating-point numbers.
 * These estimates guide search; they are not directed-rounding certificates. */
export function originDistanceLowerBound(previous: readonly LayoutPlacement[], members: readonly LayoutMember[], box: LayoutSearchBox, geometry: LayoutGeometry): number {
  const old = new Map(previous.map(p => [p.id, p]))
  const survivors = members.filter(m => old.has(m.id))
  const pitchX = geometry.columnWidth + geometry.gap; const pitchY = geometry.rowHeight + geometry.gap
  const projected = survivors.reduce((sum, m) => {
    const before = old.get(m.id)!
    const col = Math.max(box.col, Math.min(before.col, box.col + box.cols - m.cols))
    const row = Math.max(box.row, Math.min(before.row, box.row + box.rows - m.rows))
    return sum + Math.hypot((col - before.col) * pitchX, (row - before.row) * pitchY)
  }, 0)
  // Only a completely occupied unit box with no entrants fixes the sum of
  // target anchors. Holes, larger cards and new IDs invalidate this relaxation.
  if (survivors.length !== members.length || box.cols * box.rows !== members.length || members.some(m => m.cols !== 1 || m.rows !== 1)) return projected
  const oldX = survivors.reduce((sum, m) => sum + old.get(m.id)!.col, 0)
  const oldY = survivors.reduce((sum, m) => sum + old.get(m.id)!.row, 0)
  const nextX = members.length * box.col + box.rows * box.cols * (box.cols - 1) / 2
  const nextY = members.length * box.row + box.cols * box.rows * (box.rows - 1) / 2
  if (![oldX, oldY, nextX, nextY].every(Number.isSafeInteger)) return projected
  return Math.max(projected, Math.hypot((nextX - oldX) * pitchX, (nextY - oldY) * pitchY))
}

/** Cover all legal repairs of one complete unit assignment, keeping larger
 * rectangles fixed. Row-cell codes include dummy rows for vacant cells.
 * Null means already legal; [] means no unit-only repair exists in this branch.
 * Branches may overlap. No distance pruning or neighbourhood restriction occurs here. */
export function unitAssignmentRepairs(previous: readonly LayoutPlacement[], fixed: readonly LayoutPlacement[], assignment: readonly LayoutPlacement[],
  cells: readonly { readonly col: number; readonly row: number }[], rowCells: readonly number[], forbidden: ReadonlySet<number>,
  geometry: LayoutGeometry, tick: () => void = () => {}): readonly ReadonlySet<number>[] | null {
  const all = [...fixed, ...assignment]
  const branches: ReadonlySet<number>[] = []
  const holes = layoutHoles(all, tick)
  if (holes.length) {
    for (const hole of holes) {
      const cell = cells.findIndex(p => p.col === hole.col && p.row === hole.row)
      const branch = new Set(forbidden)
      for (let row = assignment.length; row < cells.length; row++) branch.add(row * cells.length + cell)
      branches.push(branch)
    }
    for (const [row, member] of assignment.entries()) if (holes.some(hole => Math.abs(hole.col - member.col) + Math.abs(hole.row - member.row) === 1))
      branches.push(new Set([...forbidden, row * cells.length + rowCells[row]!]))
    return branches
  }
  const plan = planStraightMoves(previous, all, geometry, tick)
  if (!plan.conflictIds) return null
  if (plan.blockedBy) {
    const a = assignment.find(p => p.id === plan.blockedBy!.moving)
    const b = assignment.find(p => p.id === plan.blockedBy!.stationary)
    if (a) {
      const obstacle = all.find(p => p.id === plan.blockedBy!.stationary)!
      const branch = new Set(forbidden)
      for (const [index, cell] of cells.entries()) {
        const pair = planStraightMoves(previous.filter(p => p.id === a.id || p.id === obstacle.id), [{ ...a, ...cell }, obstacle], geometry, tick)
        if (pair.conflictIds) branch.add(assignment.findIndex(p => p.id === a.id) * cells.length + index)
      }
      branches.push(branch)
    }
    if (b) {
      const index = cells.findIndex(cell => cell.col === b.col && cell.row === b.row)
      branches.push(new Set([...forbidden, assignment.findIndex(p => p.id === b.id) * cells.length + index]))
    }
    return branches
  }
  for (const id of plan.conflictIds) {
    const row = assignment.findIndex(p => p.id === id)
    if (row < 0) continue
    branches.push(new Set([...forbidden, row * cells.length + rowCells[row]!]))
  }
  return branches
}
