import type { LayoutGeometry, LayoutPlacement } from './overview-layout'

interface Rect { x: number; y: number; width: number; height: number }
export type StraightMovePlan = { readonly moveOrder: readonly string[]; readonly conflictIds?: never; readonly blockedBy?: never }
  | { readonly conflictIds: readonly string[]; readonly moveOrder?: never; readonly blockedBy?: { readonly moving: string; readonly stationary: string } }

// Intersect the open time intervals of overlap on both axes. This tests the
// entire swept rectangle, including collisions between sampled frames.
function crosses(from: Rect, to: Rect, obstacle: Rect): boolean {
  let enter = 0; let leave = 1
  for (const [start, end, min, max] of [
    [from.x, to.x, obstacle.x - from.width, obstacle.x + obstacle.width],
    [from.y, to.y, obstacle.y - from.height, obstacle.y + obstacle.height]
  ]) {
    const velocity = end! - start!
    if (!velocity) { if (start! <= min! || start! >= max!) return false }
    else {
      const a = (min! - start!) / velocity; const b = (max! - start!) / velocity
      enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b))
    }
  }
  return enter < leave
}

/**
 * Pure reachability certificate. Remove exits and shrink each decreasing axis
 * first, move survivors once in this order, grow increasing axes, then insert.
 * Other members stay still during each straight move. No detours, temporary
 * parking, fading or camera transforms can make a blocked candidate legal.
 */
export function planStraightMoves(previous: readonly LayoutPlacement[], next: readonly LayoutPlacement[], geometry: LayoutGeometry,
  tick: () => void = () => {}): StraightMovePlan {
  const old = new Map(previous.map(p => [p.id, p]))
  const rect = (p: LayoutPlacement, cols: number, rows: number): Rect => ({
    x: p.col * (geometry.columnWidth + geometry.gap), y: p.row * (geometry.rowHeight + geometry.gap),
    width: cols * geometry.columnWidth + (cols - 1) * geometry.gap,
    height: rows * geometry.rowHeight + (rows - 1) * geometry.gap
  })
  const survivors = next.filter(p => old.has(p.id)).map(p => {
    const before = old.get(p.id)!
    const cols = Math.min(before.cols, p.cols); const rows = Math.min(before.rows, p.rows)
    return { id: p.id, from: rect(before, cols, rows), to: rect(p, cols, rows), moved: before.col !== p.col || before.row !== p.row }
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const edges = new Map(survivors.filter(p => p.moved).map(p => [p.id, new Set<string>()]))
  for (const a of survivors) if (a.moved) for (const b of survivors) if (a !== b) {
    tick()
    if (crosses(a.from, a.to, b.from)) {
      if (!b.moved) return { conflictIds: [a.id, b.id], blockedBy: { moving: a.id, stationary: b.id } }
      edges.get(b.id)!.add(a.id) // b must vacate its source before a starts.
    }
    if (b.moved && crosses(a.from, a.to, b.to)) edges.get(a.id)!.add(b.id) // a must finish before b settles.
  }
  const visited = new Set<string>(); const stack: string[] = []
  const visit = (id: string): readonly string[] | undefined => {
    const start = stack.indexOf(id)
    if (start >= 0) return stack.slice(start)
    if (visited.has(id)) return
    visited.add(id); stack.push(id)
    for (const after of edges.get(id)!) { const cycle = visit(after); if (cycle) return cycle }
    stack.pop()
  }
  for (const id of edges.keys()) { const cycle = visit(id); if (cycle) return { conflictIds: cycle } }
  const moveOrder: string[] = []
  while (edges.size) {
    tick()
    const ready = [...edges.keys()].find(id => [...edges.values()].every(after => !after.has(id)))!
    moveOrder.push(ready); edges.delete(ready)
  }
  return { moveOrder }
}
