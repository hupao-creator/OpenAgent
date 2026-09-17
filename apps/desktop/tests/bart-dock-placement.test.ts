import { describe, expect, it } from 'vitest'
import {
  clipRect,
  createDockAvoidanceGate,
  dockAutoTransitionDuration,
  dockBodyOcclusionRatio,
  dockBodyIsFree,
  dockTargetsAreOscillating,
  DOCK_AUTO_MOVE_COOLDOWN_MS,
  DOCK_ESCAPE_DWELL_MS,
  DOCK_RETURN_DWELL_MS,
  nudgeDockPlacement,
  resolveDockAvoidanceGate,
  resolveDockOcclusion,
  resolveDockPlacement,
  type DockPlacementInput,
  type DockRect
} from '../src/renderer/src/components/bart-dock-placement'

const body = {
  offset: { x: 0, y: 0 },
  size: { width: 40, height: 30 }
}

function input(overrides: Partial<DockPlacementInput> = {}): DockPlacementInput {
  return {
    bounds: { x: 0, y: 0, width: 260, height: 170 },
    body,
    obstacles: [],
    home: { x: 210, y: 130 },
    current: { x: 12, y: 12 },
    clearance: 12,
    ...overrides
  }
}

describe('resolveDockPlacement', () => {
  it('returns home when the persisted home is free', () => {
    expect(resolveDockPlacement(input())).toEqual({
      position: { x: 210, y: 130 },
      kind: 'home'
    })
  })

  it('keeps the current position when home is blocked', () => {
    const result = resolveDockPlacement(input({
      obstacles: [{ x: 190, y: 110, width: 70, height: 60 }]
    }))
    expect(result).toEqual({ position: { x: 12, y: 12 }, kind: 'stay' })
  })

  it('chooses a displaced candidate when both home and current are blocked', () => {
    const obstacles = [
      { x: 190, y: 110, width: 70, height: 60 },
      { x: 0, y: 0, width: 70, height: 60 }
    ]
    const result = resolveDockPlacement(input({ obstacles }))
    expect(result.kind).toBe('displaced')
    expect(dockBodyIsFree(result.position, input({ obstacles }))).toBe(true)
  })

  it('falls back to home when every legal position is occupied', () => {
    const obstacles = [{ x: -20, y: -20, width: 320, height: 230 }]
    const result = resolveDockPlacement(input({ obstacles }))
    expect(result).toEqual({ position: { x: 210, y: 130 }, kind: 'fallback' })
  })

  it('keeps edge bounds and allows exact clearance tangency', () => {
    const constrained = input({
      bounds: { x: 8, y: 8, width: 100, height: 80 },
      home: { x: 8, y: 8 },
      current: { x: 8, y: 8 },
      obstacles: [{ x: 60, y: 8, width: 20, height: 20 }]
    })
    expect(dockBodyIsFree({ x: 8, y: 8 }, constrained)).toBe(true)
    expect(dockBodyIsFree({ x: 20, y: 8 }, constrained)).toBe(false)
    expect(dockBodyIsFree({ x: 8, y: 8 }, input({
      obstacles: [{ x: 60, y: 8, width: 20, height: 20 }],
      clearance: 12
    }))).toBe(true)
  })

  it('uses home distance, current distance, then lower/right tie breaks', () => {
    const obstacles = [
      { x: 180, y: 120, width: 80, height: 50 },
      { x: 0, y: 0, width: 70, height: 50 }
    ]
    const first = resolveDockPlacement(input({
      obstacles,
      home: { x: 200, y: 100 },
      current: { x: 10, y: 10 }
    }))
    const second = resolveDockPlacement(input({
      obstacles,
      home: { x: 200, y: 100 },
      current: { x: 10, y: 10 }
    }))
    expect(first).toEqual(second)
    expect(first.kind).toBe('displaced')
    expect(first.position).toEqual({ x: 200, y: 78 })
  })

  it('clips to the positive-area viewport and rejects touching-only intersections', () => {
    const viewport: DockRect = { x: 10, y: 20, width: 100, height: 80 }
    expect(clipRect({ x: 0, y: 0, width: 30, height: 40 }, viewport)).toEqual({
      x: 10,
      y: 20,
      width: 20,
      height: 20
    })
    expect(clipRect({ x: 110, y: 20, width: 10, height: 20 }, viewport)).toBeNull()
    expect(clipRect({ x: 110, y: 100, width: 10, height: 20 }, viewport)).toBeNull()
  })

  it('is idempotent and finds a free candidate in stable small random layouts', () => {
    let seed = 0x51f15e
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x1_0000_0000
    }
    for (let round = 0; round < 24; round += 1) {
      const obstacles: DockRect[] = []
      for (let index = 0; index < 4; index += 1) {
        obstacles.push({
          x: Math.floor(random() * 210),
          y: Math.floor(random() * 120),
          width: 18 + Math.floor(random() * 42),
          height: 16 + Math.floor(random() * 36)
        })
      }
      const candidateInput = input({
        obstacles,
        home: { x: 210, y: 130 },
        current: { x: 12, y: 12 }
      })
      const result = resolveDockPlacement(candidateInput)
      expect(resolveDockPlacement(candidateInput)).toEqual(result)
      let freePointExists = false
      for (let x = 0; x <= 260 && !freePointExists; x += 5) {
        for (let y = 0; y <= 170; y += 5) {
          if (dockBodyIsFree({ x, y }, candidateInput)) {
            freePointExists = true
            break
          }
        }
      }
      if (freePointExists) expect(result.kind).not.toBe('fallback')
      expect(result.kind === 'fallback' || dockBodyIsFree(result.position, candidateInput)).toBe(true)
    }
  })
})

describe('Dock avoidance gate', () => {
  it('uses the real body overlap for enter/exit hysteresis without clearance inflation', () => {
    const candidate = input({
      body: { offset: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
      current: { x: 0, y: 0 },
      obstacles: [{ kind: 'thread-card', x: 92, y: 0, width: 8, height: 100 }]
    })
    expect(dockBodyOcclusionRatio(candidate.current, candidate.body, candidate.obstacles[0])).toBeCloseTo(0.08)
    expect(resolveDockOcclusion(candidate, false).active).toBe(true)

    const belowEnter = { ...candidate, obstacles: [{ kind: 'thread-card' as const, x: 94, y: 0, width: 6, height: 100 }] }
    expect(resolveDockOcclusion(belowEnter, false).active).toBe(false)
    expect(resolveDockOcclusion(belowEnter, true).active).toBe(true)
  })

  it('arms dwell, then enforces cooldown and home return dwell', () => {
    let gate = createDockAvoidanceGate()
    const occluded = { occluded: true, homeFree: false, atHome: true }
    let result = resolveDockAvoidanceGate(gate, occluded, 0)
    expect(result.decision).toBe('arm')
    expect(result.wakeAt).toBe(DOCK_ESCAPE_DWELL_MS)
    gate = result.gate

    result = resolveDockAvoidanceGate(gate, occluded, DOCK_ESCAPE_DWELL_MS - 1)
    expect(result.decision).toBe('arm')
    result = resolveDockAvoidanceGate(result.gate, occluded, DOCK_ESCAPE_DWELL_MS)
    expect(result.decision).toBe('escape')
    gate = { ...result.gate, lastAutoMoveAt: DOCK_ESCAPE_DWELL_MS }

    result = resolveDockAvoidanceGate(gate, occluded, DOCK_ESCAPE_DWELL_MS + 1)
    expect(result.decision).toBe('none')
    expect(result.wakeAt).toBe(DOCK_ESCAPE_DWELL_MS + DOCK_AUTO_MOVE_COOLDOWN_MS)

    result = resolveDockAvoidanceGate(result.gate, {
      occluded: false,
      homeFree: true,
      atHome: false
    }, 2_000)
    expect(result.decision).toBe('arm')
    expect(result.wakeAt).toBe(2_000 + DOCK_RETURN_DWELL_MS)
    result = resolveDockAvoidanceGate(result.gate, {
      occluded: false,
      homeFree: true,
      atHome: false
    }, 2_000 + DOCK_RETURN_DWELL_MS)
    expect(result.decision).toBe('return')
  })

  it('keeps nudge and transition duration deterministic and legal', () => {
    const candidate = input({
      body: { offset: { x: 0, y: 0 }, size: { width: 40, height: 30 } },
      obstacles: [{ x: 190, y: 110, width: 70, height: 60 }]
    })
    const placement = resolveDockPlacement(candidate)
    const nudged = nudgeDockPlacement(placement.position, candidate, 1)
    expect(nudged).toEqual(nudgeDockPlacement(placement.position, candidate, 1))
    expect(dockBodyIsFree(nudged, candidate)).toBe(true)
    expect(dockAutoTransitionDuration(0)).toBe(260)
    expect(dockAutoTransitionDuration(400)).toBe(420)
    expect(dockTargetsAreOscillating(
      [{ x: 10, y: 10 }, { x: 120, y: 10 }, { x: 10, y: 10 }],
      { x: 120, y: 10 }
    )).toBe(true)
  })
})
