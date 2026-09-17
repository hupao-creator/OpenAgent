import type { LayoutPlacement } from './overview-layout'

/** Empty grid cells enclosed by members, excluding normal inter-card gaps. */
export function layoutHoles(placements: readonly LayoutPlacement[], tick: () => void = () => {}): readonly { col: number; row: number }[] {
  if (!placements.length) return []
  const left = Math.min(...placements.map(p => p.col)); const top = Math.min(...placements.map(p => p.row))
  const right = Math.max(...placements.map(p => p.col + p.cols)); const bottom = Math.max(...placements.map(p => p.row + p.rows))
  const width = right - left; const height = bottom - top
  const occupied = new Set<number>(); const outside = new Set<number>(); const queue: number[] = []
  for (const p of placements) for (let row = p.row; row < p.row + p.rows; row++) for (let col = p.col; col < p.col + p.cols; col++) {
    tick(); occupied.add((row - top) * width + col - left)
  }
  const add = (col: number, row: number): void => {
    tick()
    if (col < 0 || col >= width || row < 0 || row >= height) return
    const cell = row * width + col
    if (!occupied.has(cell) && !outside.has(cell)) { outside.add(cell); queue.push(cell) }
  }
  for (let col = 0; col < width; col++) { add(col, 0); add(col, height - 1) }
  for (let row = 0; row < height; row++) { add(0, row); add(width - 1, row) }
  for (let i = 0; i < queue.length; i++) {
    const cell = queue[i]!; const col = cell % width; const row = Math.floor(cell / width)
    add(col - 1, row); add(col + 1, row); add(col, row - 1); add(col, row + 1)
  }
  const holes: Array<{ col: number; row: number }> = []
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    tick()
    if (!occupied.has(row * width + col) && !outside.has(row * width + col)) holes.push({ col: col + left, row: row + top })
  }
  return holes
}
