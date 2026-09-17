import { planStraightMoves } from './overview-layout-movement'
import { layoutHoles } from './overview-layout-occupancy'
import { originDistanceLowerBound, unitAssignmentRepairs } from './overview-layout-search'

/** Pure, history-aware Overview packing. No DOM, camera, Harness or motion state. */
export interface LayoutMember {
  readonly id: string
  readonly cols: number
  readonly rows: number
}

export interface LayoutPlacement extends LayoutMember {
  readonly col: number
  readonly row: number
}

export interface LayoutGeometry {
  readonly columnWidth: number
  readonly rowHeight: number
  readonly gap: number
}

export interface LayoutResult {
  readonly placements: readonly LayoutPlacement[]
  readonly bounds: { readonly col: number; readonly row: number; readonly cols: number; readonly rows: number; readonly width: number; readonly height: number }
  /** Completion of the full search using floating-point costs, not a real-number proof. */
  readonly searchComplete: boolean
  /** Only a zero-travel result has a mathematical distance certificate today. */
  readonly distanceOptimal: boolean
  readonly work: { readonly steps: number; readonly candidateSteps: number; readonly firstFeasibleStep: number | null; readonly bestStep: number | null }
  readonly moveOrder: readonly string[]
  readonly shiftedIds: readonly string[]
  readonly totalShiftDistance: number
  readonly aspect: number | null
}

export class LayoutSearchLimitError extends Error {
  constructor() { super('Layout search budget exceeded; full search did not complete'); this.name = 'LayoutSearchLimitError' }
}

const compareId = (a: LayoutMember, b: LayoutMember): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const intersects = (a: LayoutPlacement, b: LayoutPlacement): boolean =>
  a.col < b.col + b.cols && b.col < a.col + a.cols && a.row < b.row + b.rows && b.row < a.row + a.rows

function summarize(placements: readonly LayoutPlacement[], previous: readonly LayoutPlacement[], geometry: LayoutGeometry, moveOrder: readonly string[] = []): LayoutResult {
  if (placements.some(p => !Number.isSafeInteger(p.col) || p.col < 0 || !Number.isSafeInteger(p.row) || p.row < 0 ||
    !Number.isSafeInteger(p.col + p.cols) || !Number.isSafeInteger(p.row + p.rows)))
    throw new Error('Layout coordinate extent cannot be represented')
  const col = placements.length ? Math.min(...placements.map(p => p.col)) : 0
  const row = placements.length ? Math.min(...placements.map(p => p.row)) : 0
  const cols = placements.length ? Math.max(...placements.map(p => p.col + p.cols)) - col : 0
  const rows = placements.length ? Math.max(...placements.map(p => p.row + p.rows)) - row : 0
  const width = cols ? cols * geometry.columnWidth + (cols - 1) * geometry.gap : 0
  const height = rows ? rows * geometry.rowHeight + (rows - 1) * geometry.gap : 0
  const aspect = placements.length ? Math.max(width, height) / Math.min(width, height) : null
  if (!Number.isFinite(width) || !Number.isFinite(height) || (placements.length && (!(width > 0) || !(height > 0) || !Number.isFinite(aspect))))
    throw new Error('Layout pixel bounds or aspect cannot be represented')
  const old = new Map(previous.map(p => [p.id, p]))
  const totalShiftDistance = [...placements].sort(compareId).reduce((sum, p) => sum + shiftDistance(old.get(p.id), p, geometry), 0)
  if (!Number.isFinite(totalShiftDistance)) throw new Error('Layout total shift distance overflow')
  return { searchComplete: false, distanceOptimal: !placements.some(p => { const before = old.get(p.id); return before && (before.col !== p.col || before.row !== p.row) }),
    work: { steps: 0, candidateSteps: 0, firstFeasibleStep: null, bestStep: null }, moveOrder, placements: [...placements].sort(compareId), bounds: { col, row, cols, rows, width, height },
    shiftedIds: placements.filter(p => { const before = old.get(p.id); return before && (before.col !== p.col || before.row !== p.row) }).sort(compareId).map(p => p.id),
    totalShiftDistance,
    aspect }
}

function shiftDistance(before: LayoutPlacement | undefined, next: { col: number; row: number }, geometry: LayoutGeometry): number {
  const distance = before ? Math.hypot((next.col - before.col) * (geometry.columnWidth + geometry.gap), (next.row - before.row) * (geometry.rowHeight + geometry.gap)) : 0
  if (!Number.isFinite(distance)) throw new Error('Layout shift distance overflow')
  return distance
}

function validate(previous: readonly LayoutPlacement[], next: readonly LayoutMember[], geometry: LayoutGeometry): void {
  for (const members of [previous, next]) {
    if (new Set(members.map(m => m.id)).size !== members.length) throw new Error('Layout member IDs must be unique')
    for (const m of members) if (!m.id || !Number.isSafeInteger(m.cols) || m.cols < 1 || !Number.isSafeInteger(m.rows) || m.rows < 1)
      throw new Error('Layout footprints must be positive integer grid spans')
  }
  for (const p of previous) if (!Number.isSafeInteger(p.col) || p.col < 0 || !Number.isSafeInteger(p.row) || p.row < 0)
    throw new Error('Layout positions must be non-negative integer grid coordinates')
  for (let a = 0; a < previous.length; a++) for (let b = a + 1; b < previous.length; b++)
    if (intersects(previous[a]!, previous[b]!)) throw new Error('Previous layout members must not overlap')
  if (!Number.isFinite(geometry.columnWidth) || geometry.columnWidth <= 0 || !Number.isFinite(geometry.rowHeight) || geometry.rowHeight <= 0 || !Number.isFinite(geometry.gap) || geometry.gap < 0)
    throw new Error('Invalid layout geometry')
  const pitchX = geometry.columnWidth + geometry.gap; const pitchY = geometry.rowHeight + geometry.gap
  if (!Number.isFinite(pitchX) || !Number.isFinite(pitchY) || !Number.isFinite(Math.max(geometry.columnWidth, geometry.rowHeight) / Math.min(geometry.columnWidth, geometry.rowHeight)))
    throw new Error('Layout geometry aspect or pitch cannot be represented')
  for (const members of [previous, next]) {
    for (const size of [members.reduce((sum, p) => sum + p.cols, 0), members.reduce((sum, p) => sum + p.rows, 0), members.reduce((sum, p) => sum + p.cols * p.rows, 0)])
      if (!Number.isSafeInteger(size)) throw new Error('Layout aggregate grid size exceeds safe integers')
  }
  for (const p of previous) if (!Number.isSafeInteger(p.col + p.cols) || !Number.isSafeInteger(p.row + p.rows) ||
    !Number.isFinite((p.col + p.cols) * pitchX) || !Number.isFinite((p.row + p.rows) * pitchY))
    throw new Error('Layout coordinate extent cannot be represented')
}

interface SearchBox { col: number; row: number; cols: number; rows: number }

function packBox(fixed: readonly LayoutPlacement[], free: readonly LayoutMember[], box: SearchBox, tick: () => void): readonly LayoutPlacement[] | undefined {
  tick()
  const counts = new Map<string, number>()
  for (const member of free) {
    tick()
    const key = `${member.cols}x${member.rows}`
    const count = (counts.get(key) ?? 0) + 1
    if (count > Math.floor(box.cols / member.cols) * Math.floor(box.rows / member.rows)) return
    counts.set(key, count)
  }
  // Geometry-only feasibility: equal, non-rotating rectangles occupy at most
  // floor(W/w) × floor(H/h) slots. Row-major filling attains that bound and has
  // no enclosed vacancy. Avoid enumerating identity permutations here; movement
  // assignment below still distinguishes every survivor.
  const first = free[0]
  if (!fixed.length && first && free.every(member => member.cols === first.cols && member.rows === first.rows)) {
    const columns = Math.floor(box.cols / first.cols)
    if (!columns || free.length > columns * Math.floor(box.rows / first.rows)) return
    return free.map((member, index) => {
      tick()
      return { ...member, col: box.col + index % columns * member.cols,
        row: box.row + Math.floor(index / columns) * member.rows }
    })
  }
  const placed: LayoutPlacement[] = [...fixed]
  // With a shared width (height), anchors can be snapped left (up) into
  // equal-width (height) bands: members in one band already cannot overlap on
  // the other axis. This restriction is valid only for geometry feasibility.
  const columnStep = !fixed.length && first && free.every(member => member.cols === first.cols) ? first.cols : 1
  const rowStep = !fixed.length && first && free.every(member => member.rows === first.rows) ? first.rows : 1
  if (free.reduce((sum, member) => sum + member.cols * member.rows, 0) >
    Math.floor(box.cols / columnStep) * columnStep * Math.floor(box.rows / rowStep) * rowStep) return
  const place = (index: number): boolean => {
    tick()
    if (index === free.length) return !layoutHoles(placed, tick).length
    // Unit cells are interchangeable once all larger rectangles have been placed.
    if (free[index]!.cols === 1 && free[index]!.rows === 1) {
      const start = placed.length
      let n = index
      for (let row = box.row; row < box.row + box.rows && n < free.length; row++) for (let col = box.col; col < box.col + box.cols && n < free.length; col++) {
        tick()
        const candidate = { ...free[n]!, col, row }
        if (!placed.some(p => intersects(p, candidate))) { placed.push(candidate); n++ }
      }
      if (n === free.length && !layoutHoles(placed, tick).length) return true
      placed.length = start
      // A different selection of free unit cells may fill an enclosed vacancy.
      // Fall through to exact placement search if the greedy fill left holes.
    }
    const member = free[index]!
    for (let row = box.row; row <= box.row + box.rows - member.rows; row += rowStep) for (let col = box.col; col <= box.col + box.cols - member.cols; col += columnStep) {
      tick()
      const candidate = { ...member, col, row }
      if (placed.some(p => intersects(p, candidate))) continue
      placed.push(candidate)
      if (place(index + 1)) return true
      placed.pop()
    }
    return false
  }
  return place(0) ? placed : undefined
}

// Minimum-cost assignment to interchangeable slots (unit cells in the exact
// search, or equal-footprint slots in a geometry-only candidate).
function assignSlots(members: readonly LayoutMember[], cells: readonly { col: number; row: number }[], old: ReadonlyMap<string, LayoutPlacement>, geometry: LayoutGeometry, tick: () => void, forbidden: ReadonlySet<number> = new Set()): { placements: readonly LayoutPlacement[]; rowCells: readonly number[] } | undefined {
  if (cells.length < members.length) return
  const n = cells.length; const m = cells.length
  // Dummy rows represent empty cells; constraints can require a hole to be filled.
  const costs = Array.from({ length: n }, (_, row) => cells.map((cell, col) => {
    tick()
    return forbidden.has(row * m + col) ? Infinity : row < members.length ? shiftDistance(old.get(members[row]!.id), cell, geometry) : 0
  }))
  const costScale = costs.reduce((max, row) => row.reduce((bound, cost) => Number.isFinite(cost) ? Math.max(bound, cost) : bound, max), 1)
  const u = Array<number>(n + 1).fill(0); const v = Array<number>(m + 1).fill(0)
  const u2 = Array<number>(n + 1).fill(0); const v2 = Array<number>(m + 1).fill(0)
  const match = Array<number>(m + 1).fill(0); const way = Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    match[0] = i
    let column = 0
    const minimum = Array<number>(m + 1).fill(Infinity)
    const minimum2 = Array<number>(m + 1).fill(Infinity)
    const used = Array<boolean>(m + 1).fill(false)
    do {
      used[column] = true
      const row = match[column]!
      let delta = Infinity; let delta2 = Infinity; let nextColumn = 0
      for (let j = 1; j <= m; j++) if (!used[j]) {
        tick()
        const cost = costs[row - 1]![j - 1]!
        const reduced = cost - u[row]! - v[j]!
        // Equal total-distance assignments prefer shorter individual moves.
        // This is an exact lexicographic tie break, never an epsilon weight.
        const reduced2 = (cost / costScale) ** 2 - u2[row]! - v2[j]!
        if (reduced < minimum[j]! || (reduced === minimum[j] && reduced2 < minimum2[j]!)) {
          minimum[j] = reduced; minimum2[j] = reduced2; way[j] = column
        }
        if (minimum[j]! < delta || (minimum[j] === delta && minimum2[j]! < delta2)) {
          delta = minimum[j]!; delta2 = minimum2[j]!; nextColumn = j
        }
      }
      if (!Number.isFinite(delta)) return
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[match[j]!]! += delta; v[j]! -= delta; u2[match[j]!]! += delta2; v2[j]! -= delta2 }
        else { minimum[j]! -= delta; minimum2[j]! -= delta2 }
      }
      column = nextColumn
    } while (match[column] !== 0)
    do { const before = way[column]!; match[column] = match[before]!; column = before } while (column !== 0)
  }
  const rowCells = Array<number>(n)
  for (let column = 1; column <= m; column++) rowCells[match[column]! - 1] = column - 1
  return { placements: members.map((member, row) => ({ ...member, ...cells[rowCells[row]!]! })), rowCells }
}

function compareAspect(a: LayoutResult, b: LayoutResult): number {
  // Ratios avoid overflow/underflow from cross-multiplying physical dimensions.
  return a.aspect! - b.aspect!
}

/**
 * Compact bounds are a geometry constraint, independent of movement. Among
 * non-dominated packings, minimize PHYSICAL aspect first, then total Euclidean survivor travel in unscaled pixels.
 * Results certify hole-free geometry and a collision-free straight move order.
 * Budget-limited search is explicit; completion with floating costs is not an exact distance proof.
 * The fixed non-negative origin is not re-centered after deletion.
 */
export function layoutOverview(previous: readonly LayoutPlacement[], next: readonly LayoutMember[], geometry: LayoutGeometry,
  options: { readonly maxSearchSteps?: number; readonly requireSearchComplete?: boolean } = {}): LayoutResult {
  validate(previous, next, geometry)
  const budget = options.maxSearchSteps ?? 2_000_000
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('Invalid layout search budget')
  const work = { steps: 0, candidateSteps: 0, firstFeasibleStep: null as number | null, bestStep: null as number | null }
  const tick = (): void => { if (work.steps >= budget) throw new LayoutSearchLimitError(); work.steps++ }
  // Fixed logical quota: increasing the total budget continues the same prefix.
  class CandidateBudgetExhausted extends Error {}
  const candidateTick = (): void => {
    if (work.candidateSteps >= 1_000_000) throw new CandidateBudgetExhausted()
    tick(); work.candidateSteps++
  }
  const finish = (result: LayoutResult, searchComplete = true): LayoutResult => ({ ...result, searchComplete, work: { ...work } })
  let best: LayoutResult | undefined
  try {
    const members = [...next].sort(compareId)
    if (!members.length) return finish(summarize([], previous, geometry))
    const packingOrder = (items: readonly LayoutMember[]) => [...items].sort((a, b) => b.cols * b.rows - a.cols * a.rows || compareId(a, b))
    const free = packingOrder(members)
    const minCols = Math.max(...members.map(m => m.cols))
    const minRows = Math.max(...members.map(m => m.rows))
    // A single horizontal row dominates any box wider than the summed widths;
    // a vertical column similarly bounds height. Both packings are hole-free.
    // These input-derived limits cover the whole frontier, with no product cap.
    const maxCols = members.reduce((sum, m) => sum + m.cols, 0)
    const maxRows = members.reduce((sum, m) => sum + m.rows, 0)
    const area = members.reduce((sum, m) => sum + m.cols * m.rows, 0)
    const frontier: LayoutResult[] = []
    let lastHeight = maxRows + 1
    const fit = (cols: number, rows: number) => cols * rows < area ? undefined : packBox([], free, { col: 0, row: 0, cols, rows }, tick)
    for (let cols = minCols; cols <= maxCols; cols++) {
      tick()
      let low = Math.max(minRows, Math.ceil(area / cols))
      let high = Math.min(maxRows, lastHeight - 1)
      if (low > high) continue
      let placement = fit(cols, high)
      if (!placement) continue
      while (low < high) {
        const mid = Math.floor((low + high) / 2)
        const candidate = fit(cols, mid)
        if (candidate) { high = mid; placement = candidate } else low = mid + 1
      }
      lastHeight = high
      frontier.push(summarize(placement, previous, geometry))
    }
    frontier.sort((a, b) => compareAspect(a, b) || a.bounds.width - b.bounds.width)
    if (!frontier[0]) throw new Error('No legal layout found')
    // Retain every equally square frontier box; choosing one now would wrongly
    // make its orientation/dimensions more important than preserving survivors.
    const optimalBoxes = frontier.filter(p => compareAspect(p, frontier[0]!) === 0)
    const old = new Map(previous.map(p => [p.id, p]))
    const survivors = members.filter(m => old.has(m.id))
    const accept = (placed: readonly LayoutPlacement[], count = tick): void => {
      if (layoutHoles(placed, count).length) return
      const plan = planStraightMoves(previous, placed, geometry, count)
      if (plan.conflictIds) return
      const result = summarize(placed, previous, geometry, plan.moveOrder)
      if (work.firstFeasibleStep === null) work.firstFeasibleStep = work.steps
      if (!best || result.totalShiftDistance < best.totalShiftDistance) { best = result; work.bestStep = work.steps }
    }
    if (!optimalBoxes.length) throw new Error('No representable optimal layout aspect')
    // Check old anchors before spending any movement-search quota. This also
    // makes budget-truncated layouts idempotent without preserving legacy shapes.
    if (survivors.length === members.length) {
      const preserved = members.map(m => ({ ...m, col: old.get(m.id)!.col, row: old.get(m.id)!.row }))
      const summary = summarize(preserved, previous, geometry)
      if (optimalBoxes.some(shape => shape.bounds.cols === summary.bounds.cols && shape.bounds.rows === summary.bounds.rows) &&
        !preserved.some((p, i) => preserved.slice(i + 1).some(other => intersects(p, other)))) accept(preserved)
    }
    if (best?.distanceOptimal) return finish(best)
    for (const shape of optimalBoxes) accept(shape.placements)
    if (best?.totalShiftDistance === 0) return finish(best)
    const maxLeft = Math.max(0, ...survivors.map(p => old.get(p.id)!.col))
    const maxTop = Math.max(0, ...survivors.map(p => old.get(p.id)!.row))

    const searchBox = (box: SearchBox, tick: () => void, local: boolean): void => {
      if (!Number.isSafeInteger(box.col + box.cols) || !Number.isSafeInteger(box.row + box.rows)) return
      const placed: LayoutPlacement[] = []
      const search = (index: number, distance: number): void => {
        tick()
        if (best && distance >= best.totalShiftDistance) return
        if (index === free.length) { accept(placed, tick); return }
        if (free[index]!.cols === 1 && free[index]!.rows === 1) {
          const cells: Array<{ col: number; row: number }> = []
          for (let row = box.row; row < box.row + box.rows; row++) for (let col = box.col; col < box.col + box.cols; col++) {
            tick()
            if (!placed.some(p => intersects(p, { id: '', col, row, cols: 1, rows: 1 }))) cells.push({ col, row })
          }
          const units = free.slice(index)
          const localForbidden = new Set<number>()
          if (local) for (const [row, member] of units.entries()) {
            const before = old.get(member.id)
            if (before) for (const [col, cell] of cells.entries()) if (Math.abs(before.col - cell.col) > 1 || Math.abs(before.row - cell.row) > 1)
              localForbidden.add(row * cells.length + col)
          }
          // Each assignment is a distance lower bound until its entire straight
          // move order is certified. A blocked member pair or dependency cycle
          // forces at least one of those members to choose a different cell.
          const queue: Array<{ forbidden: ReadonlySet<number>; assignment: readonly LayoutPlacement[]; rowCells: readonly number[]; distance: number }> = []
          const seen = new Set<string>()
          const enqueue = (forbidden: ReadonlySet<number>): void => {
            if (local) forbidden = new Set([...forbidden, ...localForbidden])
            const key = JSON.stringify([...forbidden].sort((a, b) => a - b))
            if (seen.has(key)) return
            seen.add(key)
            const assignment = assignSlots(units, cells, old, geometry, tick, forbidden)
            if (!assignment) return
            const cost = summarize([...placed, ...assignment.placements], previous, geometry).totalShiftDistance
            if (!best || cost < best.totalShiftDistance) queue.push({ forbidden, assignment: assignment.placements, rowCells: assignment.rowCells, distance: cost })
          }
          const axisOnly = new Set<number>()
          for (const [memberIndex, member] of units.entries()) {
            const before = old.get(member.id)
            if (before) for (const [i, cell] of cells.entries()) if (before.col !== cell.col && before.row !== cell.row) axisOnly.add(memberIndex * cells.length + i)
          }
          for (let row = units.length; row < cells.length; row++) for (const [i, cell] of cells.entries()) {
            if (cell.col > box.col && cell.col < box.col + box.cols - 1 && cell.row > box.row && cell.row < box.row + box.rows - 1) axisOnly.add(row * cells.length + i)
          }
          const seed = assignSlots(units, cells, old, geometry, tick, new Set([...axisOnly, ...localForbidden]))
          if (seed) accept([...placed, ...seed.placements], tick)
          enqueue(new Set())
          while (queue.length) {
            tick()
            queue.sort((a, b) => b.distance - a.distance)
            const candidate = queue.pop()!
            if (best && candidate.distance >= best.totalShiftDistance) break
            const repairs = unitAssignmentRepairs(previous, placed, candidate.assignment, cells, candidate.rowCells, candidate.forbidden, geometry, tick)
            if (!repairs) { accept([...placed, ...candidate.assignment], tick); break }
            for (const forbidden of repairs) enqueue(forbidden)
          }
          return
        }
        const member = free[index]!
        const candidates: Array<{ placement: LayoutPlacement; cost: number }> = []
        for (let row = box.row; row <= box.row + box.rows - member.rows; row++) for (let col = box.col; col <= box.col + box.cols - member.cols; col++) {
          tick()
          const before = old.get(member.id)
          if (local && before && (Math.abs(before.col - col) > 1 || Math.abs(before.row - row) > 1)) continue
          const placement = { ...member, col, row }
          const cost = shiftDistance(old.get(member.id), placement, geometry)
          if ((!best || distance + cost < best.totalShiftDistance) && !placed.some(p => intersects(p, placement))) candidates.push({ placement, cost })
        }
        candidates.sort((a, b) => a.cost - b.cost || a.placement.row - b.placement.row || a.placement.col - b.placement.col)
        for (const { placement, cost } of candidates) {
          placed.push(placement)
          search(index + 1, distance + cost)
          placed.pop()
          if (best?.totalShiftDistance === 0) return
        }
      }
      search(0, 0)
    }
    const proposals: Array<SearchBox & { lowerBound: number }> = []
    for (const shape of optimalBoxes) {
      const { cols, rows } = shape.bounds
      const centerCol = survivors.reduce((sum, m) => sum + old.get(m.id)!.col + m.cols / 2, 0) / Math.max(1, survivors.length) - cols / 2
      const centerRow = survivors.reduce((sum, m) => sum + old.get(m.id)!.row + m.rows / 2, 0) / Math.max(1, survivors.length) - rows / 2
      const seen = new Set<string>()
      for (const row of [Math.floor(centerRow), Math.ceil(centerRow), 0]) for (const col of [Math.floor(centerCol), Math.ceil(centerCol), 0]) {
        const box = { col: Math.max(0, col), row: Math.max(0, row), cols, rows }
        const key = `${box.col},${box.row}`
        if (seen.has(key)) continue
        seen.add(key)
        proposals.push({ ...box, lowerBound: originDistanceLowerBound(previous, members, box, geometry) })
      }
    }
    proposals.sort((a, b) => a.lowerBound - b.lowerBound || a.row - b.row || a.col - b.col || a.cols - b.cols)
    try {
      // Real Overview cards often share a non-unit footprint. Before identity
      // backtracking, rematch those equal-sized slots in each frontier packing
      // (and its reflections). These are only candidates: the same continuous
      // path/hole checks must accept them, and full search stays unrestricted.
      if (members.some(member => member.cols !== 1 || member.rows !== 1)) {
        const groups = new Map<string, LayoutMember[]>()
        for (const member of members) {
          const key = `${member.cols}x${member.rows}`
          const group = groups.get(key) ?? []; group.push(member); groups.set(key, group)
        }
        for (const box of proposals) {
          const shape = optimalBoxes.find(shape => shape.bounds.cols === box.cols && shape.bounds.rows === box.rows)!
          const candidates: LayoutPlacement[][] = []
          for (const flipX of [false, true]) for (const flipY of [false, true]) candidates.push(shape.placements.map(p => ({ ...p,
            col: box.col + (flipX ? box.cols - p.col - p.cols : p.col),
            row: box.row + (flipY ? box.rows - p.row - p.rows : p.row) })))
          // A changed card may be the only member of its footprint class. Give
          // its old anchor a candidate too, so the surrounding repeated cards
          // can close a gap without forcing that singleton across the whole box.
          const anchors = [...groups.values()].filter(group => group.length === 1).flatMap(([member]) => {
            const before = old.get(member!.id)
            return before && before.col >= box.col && before.row >= box.row &&
              before.col + member!.cols <= box.col + box.cols && before.row + member!.rows <= box.row + box.rows
              ? [{ ...member!, col: before.col, row: before.row }] : []
          })
          if (anchors.length && !anchors.some((a, i) => anchors.slice(i + 1).some(b => intersects(a, b)))) {
            const anchored = packBox(anchors, free.filter(member => !anchors.some(p => p.id === member.id)), box, candidateTick)
            if (anchored) candidates.push([...anchored])
          }
          for (const slots of candidates) for (const axisOnly of [false, true]) {
            const candidate: LayoutPlacement[] = []
            for (const group of groups.values()) {
              const cells = slots.filter(slot => slot.cols === group[0]!.cols && slot.rows === group[0]!.rows)
              const forbidden = new Set<number>()
              if (axisOnly) for (const [row, member] of group.entries()) {
                const before = old.get(member.id)
                if (before) for (const [col, cell] of cells.entries())
                  if (before.col !== cell.col && before.row !== cell.row) forbidden.add(row * cells.length + col)
              }
              const assignment = assignSlots(group, cells, old, geometry, candidateTick, forbidden)
              if (!assignment) break
              candidate.push(...assignment.placements)
            }
            if (candidate.length === members.length) accept(candidate, candidateTick)
            if (best?.distanceOptimal) return finish(best)
          }
        }
      }
      for (const box of proposals) {
        if (!best || box.lowerBound < best.totalShiftDistance) searchBox(box, candidateTick, true)
        if (best?.distanceOptimal) return finish(best)
      }
    } catch (error) { if (!(error instanceof CandidateBudgetExhausted)) throw error }

    // A collision can require an origin beyond every old anchor. Expand until a
    // feasible distance bound certifies that no outside origin can improve it.
    // No unproved translation-invariance assumption or fixed origin cap is used.
    for (let radius = 0; ; radius++) {
      tick()
      const origins: Array<{ col: number; row: number; cols: number; rows: number; lowerBound: number }> = []
      for (const shape of optimalBoxes) {
        const { cols, rows } = shape.bounds
        for (let row = 0; row <= maxTop + radius; row++) for (let col = 0; col <= maxLeft + radius; col++) {
          if (radius && row < maxTop + radius && col < maxLeft + radius) continue
          tick()
          const lowerBound = originDistanceLowerBound(previous, members, { col, row, cols, rows }, geometry)
          if (!best || lowerBound < best.totalShiftDistance) origins.push({ col, row, cols, rows, lowerBound })
        }
      }
      origins.sort((a, b) => a.lowerBound - b.lowerBound || a.row - b.row || a.col - b.col || a.cols - b.cols)
      for (const box of origins) {
        if (best && box.lowerBound >= best.totalShiftDistance) continue
        searchBox(box, tick, false)
        if (best?.totalShiftDistance === 0) return finish(best)
      }
      if (best) {
        const outsideX = survivors.reduce((sum, member) => sum + Math.max(0, maxLeft + radius + 1 - old.get(member.id)!.col) * (geometry.columnWidth + geometry.gap), 0)
        const outsideY = survivors.reduce((sum, member) => sum + Math.max(0, maxTop + radius + 1 - old.get(member.id)!.row) * (geometry.rowHeight + geometry.gap), 0)
        if (outsideX >= best.totalShiftDistance && outsideY >= best.totalShiftDistance) return finish(best)
      }
    }
  } catch (error) {
    if (error instanceof LayoutSearchLimitError && best && !options.requireSearchComplete) return finish(best, false)
    throw error
  }
}
