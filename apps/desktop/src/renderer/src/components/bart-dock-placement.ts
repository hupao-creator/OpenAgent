interface DockPoint {
  x: number
  y: number
}

/** A rectangle in the App Shell's local CSS-pixel coordinate system. */
export interface DockRect {
  x: number
  y: number
  width: number
  height: number
}

type DockObstacleKind = 'thread-card' | 'chrome'

export interface DockObstacle extends DockRect {
  kind?: DockObstacleKind
}

interface DockSize {
  width: number
  height: number
}

interface DockBody {
  /** The footprint's top-left offset from the Dock's top-left corner. */
  offset: DockPoint
  size: DockSize
}

/** Pure geometry input for choosing the Dock's outer top-left position. */
export interface DockPlacementInput {
  /** The legal range for the Dock's outer top-left position. */
  bounds: DockRect
  body: DockBody
  obstacles: readonly DockObstacle[]
  home: DockPoint
  current: DockPoint
  clearance: number
}

type DockPlacementKind = 'home' | 'stay' | 'displaced' | 'fallback'

interface DockPlacement {
  position: DockPoint
  kind: DockPlacementKind
}

interface DockOcclusion {
  active: boolean
  ratio: number
}

const DOCK_OCCLUSION_ENTER_RATIO = 0.08
const DOCK_OCCLUSION_EXIT_RATIO = 0.05
export const DOCK_ESCAPE_DWELL_MS = 750
export const DOCK_AUTO_MOVE_COOLDOWN_MS = 1_200
export const DOCK_RETURN_DWELL_MS = 2_000

type DockAvoidanceDecision = 'none' | 'escape' | 'return' | 'arm'

export interface DockAvoidanceGate {
  occlusionStartedAt: number | null
  homeClearStartedAt: number | null
  lastAutoMoveAt: number | null
  targetHistory: readonly DockPoint[]
  oscillationSilencedUntil: number
}

interface DockAvoidanceSample {
  occluded: boolean
  homeFree: boolean
  atHome: boolean
}

interface DockAvoidanceResolution {
  gate: DockAvoidanceGate
  decision: DockAvoidanceDecision
  wakeAt?: number
}

export function createDockAvoidanceGate(): DockAvoidanceGate {
  return {
    occlusionStartedAt: null,
    homeClearStartedAt: null,
    lastAutoMoveAt: null,
    targetHistory: [],
    oscillationSilencedUntil: 0
  }
}

/** Decide whether the next discrete Dock sample should arm, escape, or return. */
export function resolveDockAvoidanceGate(
  gate: DockAvoidanceGate,
  sample: DockAvoidanceSample,
  now: number
): DockAvoidanceResolution {
  const timestamp = Number.isFinite(now) ? now : 0
  const next: DockAvoidanceGate = {
    ...gate,
    targetHistory: [...gate.targetHistory]
  }
  if (sample.occluded) {
    next.homeClearStartedAt = null
    if (next.occlusionStartedAt === null) {
      next.occlusionStartedAt = timestamp
      return {
        gate: next,
        decision: 'arm',
        wakeAt: timestamp + DOCK_ESCAPE_DWELL_MS
      }
    }
    if (next.oscillationSilencedUntil > timestamp) {
      return {
        gate: next,
        decision: 'none',
        wakeAt: next.oscillationSilencedUntil
      }
    }
    const escapeAt = next.occlusionStartedAt + DOCK_ESCAPE_DWELL_MS
    if (escapeAt > timestamp) {
      return { gate: next, decision: 'arm', wakeAt: escapeAt }
    }
    const cooldownAt = next.lastAutoMoveAt === null
      ? timestamp
      : next.lastAutoMoveAt + DOCK_AUTO_MOVE_COOLDOWN_MS
    if (cooldownAt > timestamp) {
      return { gate: next, decision: 'none', wakeAt: cooldownAt }
    }
    return { gate: next, decision: 'escape' }
  }

  next.occlusionStartedAt = null
  if (sample.atHome || !sample.homeFree) {
    next.homeClearStartedAt = null
    return { gate: next, decision: 'none' }
  }
  if (next.homeClearStartedAt === null) {
    next.homeClearStartedAt = timestamp
    return {
      gate: next,
      decision: 'arm',
      wakeAt: timestamp + DOCK_RETURN_DWELL_MS
    }
  }
  const returnAt = next.homeClearStartedAt + DOCK_RETURN_DWELL_MS
  if (returnAt > timestamp) return { gate: next, decision: 'arm', wakeAt: returnAt }
  const cooldownAt = next.lastAutoMoveAt === null
    ? timestamp
    : next.lastAutoMoveAt + DOCK_AUTO_MOVE_COOLDOWN_MS
  if (cooldownAt > timestamp) return { gate: next, decision: 'none', wakeAt: cooldownAt }
  return { gate: next, decision: 'return' }
}

/** Detect an A-B-A-B target sequence before applying the next automatic move. */
export function dockTargetsAreOscillating(
  history: readonly DockPoint[],
  next: DockPoint
): boolean {
  if (history.length < 3) return false
  const a = history[history.length - 3]
  const b = history[history.length - 2]
  const c = history[history.length - 1]
  return sameDockPoint(a, c) && sameDockPoint(b, next) && !sameDockPoint(a, b)
}

/** Add a deterministic, bounded nudge only when the candidate remains legal. */
export function nudgeDockPlacement(
  position: DockPoint,
  input: DockPlacementInput,
  seed: number
): DockPoint {
  const offsets = [
    { x: 4, y: 0 },
    { x: -4, y: 0 },
    { x: 0, y: 4 },
    { x: 0, y: -4 },
    { x: 0, y: 0 }
  ]
  const start = Math.abs(Math.trunc(seed)) % offsets.length
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[(start + index) % offsets.length]
    const candidate = clampPoint(
      { x: position.x + offset.x, y: position.y + offset.y },
      placementBounds(input.bounds)
    )
    if (dockBodyIsFree(candidate, input)) return candidate
  }
  return position
}

/** Measure how much of the draggable Dock body is covered by thread cards. */
export function dockBodyOcclusionRatio(
  position: DockPoint,
  body: DockBody,
  obstacle: DockObstacle
): number {
  const bodyArea = body.size.width * body.size.height
  if (!(bodyArea > 0)) return 0
  const overlap = clipRect(bodyRect(position, body), obstacle)
  if (!overlap) return 0
  return (overlap.width * overlap.height) / bodyArea
}

/** Apply hysteresis to the thread-card overlap threshold used by the Dock. */
export function resolveDockOcclusion(
  input: Pick<DockPlacementInput, 'body' | 'current' | 'obstacles'>,
  wasActive: boolean
): DockOcclusion {
  const threshold = wasActive ? DOCK_OCCLUSION_EXIT_RATIO : DOCK_OCCLUSION_ENTER_RATIO
  let ratio = 0
  for (const obstacle of input.obstacles) {
    if (obstacle.kind !== 'thread-card') continue
    ratio = Math.max(ratio, dockBodyOcclusionRatio(input.current, input.body, obstacle))
  }
  return { active: ratio >= threshold, ratio }
}

/** Keep automatic Dock motion within the requested natural transition range. */
export function dockAutoTransitionDuration(distance: number): number {
  const finiteDistance = Number.isFinite(distance) ? Math.max(0, distance) : 0
  return Math.round(Math.min(420, Math.max(260, 260 + finiteDistance * 0.4)))
}

/** Return the positive-area intersection, or null when the rectangles do not overlap. */
export function clipRect(rect: DockRect, viewport: DockRect): DockRect | null {
  const left = Math.max(rect.x, viewport.x)
  const top = Math.max(rect.y, viewport.y)
  const right = Math.min(rect.x + rect.width, viewport.x + viewport.width)
  const bottom = Math.min(rect.y + rect.height, viewport.y + viewport.height)
  if (!(right > left && bottom > top)) return null
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  }
}

/** Test the actual Dock body, with clearance, against every obstacle and the legal bounds. */
export function dockBodyIsFree(position: DockPoint, input: DockPlacementInput): boolean {
  const bounds = placementBounds(input.bounds)
  if (
    position.x < bounds.minX ||
    position.x > bounds.maxX ||
    position.y < bounds.minY ||
    position.y > bounds.maxY
  ) {
    return false
  }

  const body = bodyRect(position, input.body)
  const clearance = finiteClearance(input.clearance)
  for (const obstacle of input.obstacles) {
    if (!positiveRect(obstacle)) continue
    const expanded = {
      x: obstacle.x - clearance,
      y: obstacle.y - clearance,
      width: obstacle.width + clearance * 2,
      height: obstacle.height + clearance * 2
    }
    // Strict interior overlap is blocked; touching an expanded edge is legal.
    if (
      body.x < expanded.x + expanded.width &&
      body.x + body.width > expanded.x &&
      body.y < expanded.y + expanded.height &&
      body.y + body.height > expanded.y
    ) {
      return false
    }
  }
  return true
}

/**
 * Resolve a deterministic Dock position.
 *
 * Candidate coordinates are obstacle edges expanded by clearance, plus the legal
 * bounds and the clamped home. The resulting finite grid is enough to find a
 * legal corner for axis-aligned rectangles without a continuous search.
 */
export function resolveDockPlacement(input: DockPlacementInput): DockPlacement {
  const bounds = placementBounds(input.bounds)
  const home = clampPoint(input.home, bounds)
  const current = clampPoint(input.current, bounds)

  if (dockBodyIsFree(home, input)) return { position: home, kind: 'home' }
  if (dockBodyIsFree(current, input)) return { position: current, kind: 'stay' }

  const clearance = finiteClearance(input.clearance)
  const xValues = [bounds.minX, bounds.maxX, home.x]
  const yValues = [bounds.minY, bounds.maxY, home.y]
  for (const obstacle of input.obstacles) {
    if (!positiveRect(obstacle)) continue
    xValues.push(
      obstacle.x + obstacle.width + clearance - input.body.offset.x,
      obstacle.x - clearance - input.body.size.width - input.body.offset.x
    )
    yValues.push(
      obstacle.y + obstacle.height + clearance - input.body.offset.y,
      obstacle.y - clearance - input.body.size.height - input.body.offset.y
    )
  }

  const xs = uniqueHalfPixelValues(xValues, bounds.minX, bounds.maxX)
  const ys = uniqueHalfPixelValues(yValues, bounds.minY, bounds.maxY)
  const candidates: DockPoint[] = []
  for (const x of xs) {
    for (const y of ys) {
      const candidate = { x, y }
      if (dockBodyIsFree(candidate, input)) candidates.push(candidate)
    }
  }

  candidates.sort((left, right) => {
    const homeDistance = distanceSquared(left, home) - distanceSquared(right, home)
    if (homeDistance !== 0) return homeDistance
    const currentDistance = distanceSquared(left, current) - distanceSquared(right, current)
    if (currentDistance !== 0) return currentDistance
    const lowerTieBreak = right.y - left.y
    if (lowerTieBreak !== 0) return lowerTieBreak
    return right.x - left.x
  })

  if (candidates.length) return { position: candidates[0], kind: 'displaced' }
  return { position: home, kind: 'fallback' }
}

interface PlacementBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

function placementBounds(bounds: DockRect): PlacementBounds {
  const x = finiteOrZero(bounds.x)
  const y = finiteOrZero(bounds.y)
  return {
    minX: x,
    maxX: x + Math.max(0, finiteOrZero(bounds.width)),
    minY: y,
    maxY: y + Math.max(0, finiteOrZero(bounds.height))
  }
}

function bodyRect(position: DockPoint, body: DockBody): DockRect {
  return {
    x: position.x + finiteOrZero(body.offset.x),
    y: position.y + finiteOrZero(body.offset.y),
    width: Math.max(0, finiteOrZero(body.size.width)),
    height: Math.max(0, finiteOrZero(body.size.height))
  }
}

function clampPoint(point: DockPoint, bounds: PlacementBounds): DockPoint {
  return {
    x: clamp(finiteOrZero(point.x), bounds.minX, bounds.maxX),
    y: clamp(finiteOrZero(point.y), bounds.minY, bounds.maxY)
  }
}

function uniqueHalfPixelValues(values: readonly number[], minimum: number, maximum: number): number[] {
  const unique = new Set<number>()
  for (const value of values) {
    const clamped = clamp(finiteOrZero(value), minimum, maximum)
    const snapped = clamp(Math.round(clamped * 2) / 2, minimum, maximum)
    unique.add(snapped)
  }
  return [...unique].sort((left, right) => left - right)
}

function positiveRect(rect: DockRect): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0
}

function finiteClearance(value: number): number {
  return Math.max(0, finiteOrZero(value))
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

function distanceSquared(left: DockPoint, right: DockPoint): number {
  const x = left.x - right.x
  const y = left.y - right.y
  return x * x + y * y
}

function sameDockPoint(left: DockPoint, right: DockPoint): boolean {
  return Math.abs(left.x - right.x) <= 0.5 && Math.abs(left.y - right.y) <= 0.5
}
