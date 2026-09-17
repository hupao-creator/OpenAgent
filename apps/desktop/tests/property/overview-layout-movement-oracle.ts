import type { LayoutGeometry, LayoutPlacement } from '../../src/renderer/src/overview-layout'

const standard = { columnWidth: 360, rowHeight: 200, gap: 16 }

// Union empty cells with their right/bottom neighbour and an outside sentinel.
// Every empty component must reach the sentinel; no production flood fill used.
export function hasEnclosedVacancy(placed: readonly LayoutPlacement[]): boolean {
  if (!placed.length) return false
  const left = Math.min(...placed.map(p => p.col)); const top = Math.min(...placed.map(p => p.row))
  const width = Math.max(...placed.map(p => p.col + p.cols)) - left
  const height = Math.max(...placed.map(p => p.row + p.rows)) - top
  const outside = width * height
  const parent = Array.from({ length: outside + 1 }, (_, i) => i)
  const find = (n: number): number => parent[n] === n ? n : parent[n] = find(parent[n]!)
  const union = (a: number, b: number): void => { parent[find(a)] = find(b) }
  const empty = Array.from({ length: outside }, (_, i) => !placed.some(p =>
    left + i % width >= p.col && left + i % width < p.col + p.cols &&
    top + Math.floor(i / width) >= p.row && top + Math.floor(i / width) < p.row + p.rows))
  for (let i = 0; i < outside; i++) if (empty[i]) {
    const col = i % width; const row = Math.floor(i / width)
    if (!col || !row || col === width - 1 || row === height - 1) union(i, outside)
    if (col + 1 < width && empty[i + 1]) union(i, i + 1)
    if (row + 1 < height && empty[i + width]) union(i, i + width)
  }
  return empty.some((isEmpty, i) => isEmpty && find(i) !== find(outside))
}

// Independent geometric oracle: separating-axis theorem on the convex hull of
// both endpoint rectangles, not the production time-interval intersection.
function sweptOverlap(from: LayoutPlacement, to: LayoutPlacement, obstacle: LayoutPlacement, geometry: LayoutGeometry): boolean {
  const corners = (p: LayoutPlacement): Array<[number, number]> => {
    const x = p.col * (geometry.columnWidth + geometry.gap); const y = p.row * (geometry.rowHeight + geometry.gap)
    const w = p.cols * geometry.columnWidth + (p.cols - 1) * geometry.gap
    const h = p.rows * geometry.rowHeight + (p.rows - 1) * geometry.gap
    return [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]
  }
  const sweep = [...corners(from), ...corners(to)]
  const fixed = corners(obstacle)
  const dx = (to.col - from.col) * (geometry.columnWidth + geometry.gap)
  const dy = (to.row - from.row) * (geometry.rowHeight + geometry.gap)
  return [[1, 0], [0, 1], [-dy, dx]].filter(([x, y]) => x || y).every(([x, y]) => {
    const a = sweep.map(([px, py]) => px * x! + py * y!)
    const b = fixed.map(([px, py]) => px * x! + py * y!)
    return Math.min(Math.max(...a), Math.max(...b)) > Math.max(Math.min(...a), Math.min(...b)) + 1e-8
  })
}

function initial(previous: readonly LayoutPlacement[], next: readonly LayoutPlacement[]) {
  return previous.flatMap(p => {
    const target = next.find(n => n.id === p.id)
    return target ? [{ ...p, cols: Math.min(p.cols, target.cols), rows: Math.min(p.rows, target.rows) }] : []
  })
}

export function executesStraightOrder(previous: readonly LayoutPlacement[], next: readonly LayoutPlacement[], order: readonly string[], geometry = standard): boolean {
  const positions = initial(previous, next)
  const moved = positions.filter(p => { const to = next.find(n => n.id === p.id)!; return p.col !== to.col || p.row !== to.row }).map(p => p.id).sort()
  if (JSON.stringify([...order].sort()) !== JSON.stringify(moved)) return false
  for (const id of order) {
    const from = positions.find(p => p.id === id)!
    const target = next.find(p => p.id === id)!
    const to = { ...from, col: target.col, row: target.row }
    if (positions.some(p => p.id !== id && sweptOverlap(from, to, p, geometry))) return false
    Object.assign(from, to)
  }
  return true
}

// Enumerate executable permutations in the tiny oracle domain. This does not
// derive a dependency graph, perform cycle detection, or call the solver.
export function hasStraightOrder(previous: readonly LayoutPlacement[], next: readonly LayoutPlacement[], geometry = standard): boolean {
  const positions = initial(previous, next)
  const remaining = positions.filter(p => { const to = next.find(n => n.id === p.id)!; return p.col !== to.col || p.row !== to.row }).map(p => p.id)
  const visit = (state: readonly LayoutPlacement[], pending: readonly string[]): boolean => {
    if (!pending.length) return true
    return pending.some(id => {
      const from = state.find(p => p.id === id)!; const target = next.find(p => p.id === id)!
      const to = { ...from, col: target.col, row: target.row }
      return !state.some(p => p.id !== id && sweptOverlap(from, to, p, geometry)) &&
        visit(state.map(p => p.id === id ? to : p), pending.filter(p => p !== id))
    })
  }
  return visit(positions, remaining)
}
