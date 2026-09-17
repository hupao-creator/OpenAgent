import { describe, expect, it } from 'vitest'
import {
  AIM_AT,
  ARC_HEIGHT,
  BANK_ANGLE,
  arcNormal,
  arcOffset,
  bankAngle,
  bankTrack,
  blendMatrix,
  dressingShare,
  carryBeat,
  composeMatrix,
  decomposeMatrix,
  eyeTrack,
  flightEase,
  inkBoxFromCorners,
  inkCenter,
  inverseMatrix,
  matrixCss,
  matrixOf,
  multiplyMatrix,
  settleOffset,
  torsoTrack,
  translationMatrix,
  type FlightTrack,
  type InkBox,
  type ScreenMatrix
} from '../src/renderer/src/components/bart-cross-page-flight'

/**
 * Both seats render the same 640x640 viewBox, so their drawn ink shares one
 * aspect ratio even though the element boxes are 400x210 and 72x72 (the
 * coordinator's seat is additionally scaled 1.7 by its anchor). A uniform scale
 * can only satisfy both dimensions at once because of that shared ratio.
 */
const ink = (x: number, y: number, width: number): InkBox => ({
  x, y, width, height: width * (474.8026123046875 / 477.270751953125)
})

const dockInk = ink(1072.7, 795.13, 156.6)
const seatInk = ink(700, 210, 91.28)

const expectBox = (actual: InkBox, expected: InkBox): void => {
  expect(actual.x).toBeCloseTo(expected.x, 6)
  expect(actual.y).toBeCloseTo(expected.y, 6)
  expect(actual.width).toBeCloseTo(expected.width, 6)
  expect(actual.height).toBeCloseTo(expected.height, 6)
}

const expectMatrix = (actual: ScreenMatrix, expected: ScreenMatrix, digits = 6): void => {
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    expect(actual[key]).toBeCloseTo(expected[key], digits)
  }
}

const IDENTITY: ScreenMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
/** A quarter turn, the one matrix whose effect is legible by hand. */
const QUARTER_TURN: ScreenMatrix = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 }
/** A seat that is not upright, which is the whole reason the route is a matrix. */
const leaned = (degrees: number): ScreenMatrix => {
  const angle = degrees * Math.PI / 180
  const cosine = Math.cos(angle) * 2
  const sine = Math.sin(angle) * 2
  return { a: cosine, b: sine, c: -sine, d: cosine, e: 0, f: 0 }
}

describe('flightEase', () => {
  it('spans the whole journey and never runs backwards', () => {
    expect(flightEase(0)).toBe(0)
    expect(flightEase(1)).toBe(1)
    const samples = Array.from({ length: 50 }, (_, index) => flightEase(index / 49))
    for (const [index, value] of samples.entries()) {
      if (index > 0) expect(value).toBeGreaterThanOrEqual(samples[index - 1]!)
    }
  })

  it('decelerates hard: most of the distance is covered early', () => {
    expect(flightEase(.5)).toBeGreaterThan(.9)
  })
})

describe('multiplyMatrix', () => {
  const move = translationMatrix(10, 20)

  it('leaves a matrix alone when it is the identity', () => {
    expect(multiplyMatrix(IDENTITY, move)).toEqual(move)
    expect(multiplyMatrix(move, IDENTITY)).toEqual(move)
  })

  it('applies the inner matrix first, the way ancestors compose', () => {
    // Turn-then-move only moves the turned origin; move-then-turn carries the
    // move onto the turned axis. The two differ in every number but `a` and `d`.
    expect(multiplyMatrix(move, QUARTER_TURN)).toEqual({ a: 0, b: 1, c: -1, d: 0, e: 10, f: 20 })
    expect(multiplyMatrix(QUARTER_TURN, move)).toEqual({ a: 0, b: 1, c: -1, d: 0, e: -20, f: 10 })
  })
})

describe('inverseMatrix', () => {
  it('undoes its own matrix, translation included', () => {
    const seats = [translationMatrix(12, -4), { a: 2, b: .4, c: -.3, d: 1.5, e: 7, f: 9 }, leaned(11)]
    for (const seat of seats) expectMatrix(multiplyMatrix(seat, inverseMatrix(seat)!), IDENTITY, 9)
  })

  it('has nothing to invert when a matrix has collapsed', () => {
    expect(inverseMatrix({ a: 0, b: 0, c: 0, d: 0, e: 1, f: 1 })).toBeNull()
    // A seat squashed flat sideways: the copy would have no size to take from it.
    expect(inverseMatrix({ a: 0, b: 1, c: 0, d: 0, e: 1, f: 1 })).toBeNull()
  })
})

describe('matrixCss', () => {
  it('writes the six numbers the style property takes', () => {
    expect(matrixCss({ a: 1, b: 0, c: 0, d: 1, e: 12.5, f: -3 }))
      .toBe('matrix(1, 0, 0, 1, 12.5, -3)')
  })
})

describe('matrixOf', () => {
  it('copies the numbers out of the mapping it was handed', () => {
    const live = { ...leaned(11), e: 5, f: 6 }
    const copy = matrixOf(live)
    expect(copy).toEqual(live)
    expect(copy).not.toBe(live)
  })
})

describe('decomposeMatrix and composeMatrix', () => {
  it('put back exactly what they took apart', () => {
    const seats = [IDENTITY, translationMatrix(-40, 300), { a: 2, b: .4, c: -.3, d: 1.5, e: 7, f: 9 }, leaned(11)]
    for (const seat of seats) {
      expectMatrix(composeMatrix(decomposeMatrix(seat), seat.e, seat.f), seat, 9)
    }
  })

  it('reads a turned, scaled seat as the turn and the scale it was built from', () => {
    const turn = 30 * Math.PI / 180
    const decomposed = decomposeMatrix(leaned(30))
    expect(decomposed.angle).toBeCloseTo(turn, 9)
    expect(decomposed.scaleX).toBeCloseTo(2, 9)
    expect(decomposed.scaleY).toBeCloseTo(2, 9)
    expect(decomposed.skew).toBeCloseTo(0, 9)
  })
})

describe('blendMatrix', () => {
  const dock: ScreenMatrix = { a: 1, b: 0, c: 0, d: 1, e: 1072.7, f: 795.13 }
  const seat: ScreenMatrix = { a: 2, b: 0, c: 0, d: 2, e: 700, f: 210 }

  it('is the seat it is leaving at the start and the one it joins at the end', () => {
    expectMatrix(blendMatrix(dock, seat, 0), dock, 9)
    expectMatrix(blendMatrix(dock, seat, 1), seat, 9)
  })

  it('moves every part of the mapping together, so the copy is never a size its seats are not', () => {
    const middle = blendMatrix(dock, seat, .5)
    expect(middle.a).toBeCloseTo(1.5, 9)
    expect(middle.d).toBeCloseTo(1.5, 9)
    expect(middle.e).toBeCloseTo((1072.7 + 700) / 2, 9)
    expect(middle.f).toBeCloseTo((795.13 + 210) / 2, 9)
  })

  it('turns the shortest way round rather than the long one', () => {
    const nearlyRound = composeMatrix({ scaleX: 1, scaleY: 1, angle: 359 * Math.PI / 180, skew: 0 }, 0, 0)
    const half = blendMatrix(IDENTITY, nearlyRound, .5)
    // Half of a one-degree turn, not half of a 359-degree one.
    expect(decomposeMatrix(half).angle).toBeCloseTo(-.5 * Math.PI / 180, 9)
  })

  it('carries a leaning seat through the route instead of straightening it', () => {
    // The whole point of interpolating the mapping: a copy that left a Bart
    // leaning at 11° must still be leaning by the same amount when it arrives.
    const target = { ...leaned(11), e: 700, f: 210 }
    expectMatrix(blendMatrix(dock, target, 1), target, 9)
    expect(decomposeMatrix(blendMatrix(dock, target, .5)).angle)
      .toBeCloseTo(decomposeMatrix(target).angle / 2, 9)
  })
})

describe('settleOffset', () => {
  const carried = { x: 12, y: -40 }

  it('keeps the arch it was found riding, and gives it up by the far end', () => {
    expect(settleOffset(carried, 0)).toEqual(carried)
    // `+ 0` because easing a negative offset to nothing leaves `-0`.
    const settled = settleOffset(carried, 1)
    expect({ x: settled.x + 0, y: settled.y + 0 }).toEqual({ x: 0, y: 0 })
  })

  it('never rises: a turn bends the arch away rather than raising a new one', () => {
    const heights = Array.from({ length: 21 }, (_, index) => settleOffset(carried, index / 20))
    for (const [index, point] of heights.entries()) {
      expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(Math.hypot(carried.x, carried.y) + 1e-9)
      if (index > 0) {
        expect(Math.hypot(point.x, point.y))
          .toBeLessThanOrEqual(Math.hypot(heights[index - 1]!.x, heights[index - 1]!.y) + 1e-9)
      }
    }
  })
})

describe('carryBeat', () => {
  it('leaves a leg that started on a seat at the beats it was performing', () => {
    // A leg from a seat hands over `beats = 0`, and the route then drives the
    // performance with the plain progress along it.
    expect(carryBeat(0, 0)).toBe(0)
    expect(carryBeat(0, 1)).toBe(1)
    expect(carryBeat(0, .45)).toBeCloseTo(.45, 12)
  })

  it('picks a turn up mid-beat instead of restarting the performance', () => {
    // The copy turned a third of the way through its beats. The leg it starts must
    // not send them back to the top — that is the snap the turn would show — and
    // must not skip the rest: the remaining two thirds are stretched over this leg.
    expect(carryBeat(1 / 3, 0)).toBeCloseTo(1 / 3, 12)
    expect(carryBeat(1 / 3, 1)).toBeCloseTo(1, 12)
    expect(carryBeat(1 / 3, .5)).toBeCloseTo(2 / 3, 12)
  })

  it('reaches the end of the performance on the last frame from any point', () => {
    for (const beats of [0, .17, .5, .93, 1]) {
      expect(carryBeat(beats, 1)).toBeCloseTo(1, 12)
    }
  })

  it('never sends the beats backwards', () => {
    for (const beats of [0, .2, .8]) {
      let previous = carryBeat(beats, 0)
      for (let index = 1; index <= 20; index += 1) {
        const beat = carryBeat(beats, index / 20)
        expect(beat).toBeGreaterThanOrEqual(previous)
        previous = beat
      }
    }
  })
})

describe('dressingShare', () => {
  const undressed: ScreenMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  /** The generic tool role's dressing: a squash towards the eyes and a shift down. */
  const dressed: ScreenMatrix = { a: 1, b: 0, c: 0, d: .62, e: 22, f: 28 }

  it('wears none of the seat it is approaching as it leaves', () => {
    // The copy has just taken off a Bart that was drawing a face of its own. The
    // destination's dressing on that first frame would be a stranger's face under it.
    expect(dressingShare(0)).toBe(0)
    expectMatrix(blendMatrix(undressed, dressed, dressingShare(0)), undressed, 9)
  })

  it('has handed the whole dressing over by the mark the expression turns at', () => {
    expect(dressingShare(AIM_AT)).toBe(1)
    expectMatrix(blendMatrix(undressed, dressed, dressingShare(AIM_AT)), dressed, 9)
    // And it stays handed over: the tail of the route is the landing, not a second
    // change of face.
    expect(dressingShare(1)).toBe(1)
  })

  it('hands it over as the route runs, never in a single frame', () => {
    const shares = Array.from({ length: 21 }, (_, index) => dressingShare(index / 20))
    for (const [index, share] of shares.entries()) {
      expect(share).toBeGreaterThanOrEqual(0)
      expect(share).toBeLessThanOrEqual(1)
      if (index > 0) expect(share).toBeGreaterThanOrEqual(shares[index - 1]!)
    }
    // Halfway to the mark is halfway through the handover, so the two faces meet
    // gradually rather than one replacing the other on a frame.
    expect(dressingShare(AIM_AT / 2)).toBeCloseTo(.5, 12)
  })
})

describe('inkBoxFromCorners', () => {
  const square: InkBox = { x: 0, y: 0, width: 100, height: 100 }

  it('is the box itself when the matrix only moves it', () => {
    expect(inkBoxFromCorners(square, { a: 2, b: 0, c: 0, d: 3, e: 12, f: -4 }))
      .toEqual({ x: 12, y: -4, width: 200, height: 300 })
  })

  it('measures a turned box by all four corners, not by its diagonal', () => {
    // A quarter turn: the diagonal's two corners land on one vertical line, so a
    // two-corner reading would report this box as having no width at all.
    const half = Math.SQRT1_2
    const turned = inkBoxFromCorners(square, { a: half, b: half, c: -half, d: half, e: 0, f: 0 })
    expect(turned.width).toBeCloseTo(100 * Math.SQRT2, 6)
    expect(turned.height).toBeCloseTo(100 * Math.SQRT2, 6)
    expect(turned.x).toBeCloseTo(-100 * half, 6)
    expect(turned.y).toBeCloseTo(0, 6)
  })

  it('reports the full width of the handoff lean, not its diagonal', () => {
    // The coordinator's handoff turns an ancestor of the seat by up to 11°. Two
    // corners there span the rotated diagonal — 72px against the seat's 91 — and the
    // copy would visibly shrink and grow back as the gesture settled.
    const turn = 11 * Math.PI / 180
    const seat = ink(0, 0, 91)
    const leaned = inkBoxFromCorners(seat, {
      a: Math.cos(turn), b: Math.sin(turn), c: -Math.sin(turn), d: Math.cos(turn), e: 0, f: 0
    })
    expect(leaned.width).toBeCloseTo(seat.width * Math.cos(turn) + seat.height * Math.sin(turn), 6)
    expect(leaned.width).toBeGreaterThan(seat.width)
  })
})

describe('the route', () => {
  // What the layer actually builds: the route, corrected by the inverse of the
  // copy's own measured mapping, so that what the copy draws lands on the seat.
  const dockSeat: ScreenMatrix = { a: .33, b: 0, c: 0, d: .33, e: 1024, f: 790 }
  const seatSeat: ScreenMatrix = { ...leaned(11), e: 700, f: 210 }
  const copyBox = ink(0, 0, 100)
  const copyLocal: ScreenMatrix = { a: 2, b: 0, c: 0, d: 2, e: 40, f: 30 }
  const copyInverse = inverseMatrix(copyLocal)!

  const drawnInk = (progress: number): InkBox => inkBoxFromCorners(
    copyBox,
    multiplyMatrix(multiplyMatrix(blendMatrix(dockSeat, seatSeat, progress), copyInverse), copyLocal)
  )

  it('stands the copy exactly where the seat it is leaving stands it', () => {
    expectBox(drawnInk(0), inkBoxFromCorners(copyBox, dockSeat))
  })

  it('lands it on the destination, leaning by as much as the destination leans', () => {
    expectBox(drawnInk(1), inkBoxFromCorners(copyBox, seatSeat))
  })

  it('never inflates: the copy is always between the two seats it joins', () => {
    const widths = Array.from({ length: 21 }, (_, index) => drawnInk(index / 20).width)
    const ends = [drawnInk(0).width, drawnInk(1).width]
    expect(Math.max(...widths)).toBeLessThanOrEqual(Math.max(...ends) + 1e-6)
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(Math.min(...ends) - 1e-6)
  })
})

const from = inkCenter(dockInk)
const seat = inkCenter(seatInk)

describe('arcNormal', () => {
  it('arches towards the top of the screen whichever way the journey goes', () => {
    const rightwards = arcNormal({ x: 0, y: 0 }, { x: 500, y: 40 })
    const leftwards = arcNormal({ x: 500, y: 40 }, { x: 0, y: 0 })
    expect(rightwards.y).toBeLessThan(0)
    expect(leftwards.y).toBeLessThan(0)
    // Perpendicular to the route, not merely sideways: leaning on the x axis
    // would drag the copy down a sloped route instead of over it.
    expect(rightwards.x * 500 + rightwards.y * 40).toBeCloseTo(0, 6)
  })

  it('gives the same normal either way round, so both directions arch the same way', () => {
    const there = arcNormal(from, seat)
    const back = arcNormal(seat, from)
    expect(back.x).toBeCloseTo(there.x, 6)
    expect(back.y).toBeCloseTo(there.y, 6)
  })

  it('has nothing to say about two seats in the same place', () => {
    expect(arcNormal(from, from)).toEqual({ x: 0, y: 0 })
  })
})

describe('arcOffset', () => {
  const normal = arcNormal(from, seat)

  it('leaves both seats exactly where they are', () => {
    expect(arcOffset(normal, 0)).toEqual({ x: 0, y: 0 })
    expect(arcOffset(normal, 1)).toEqual({ x: 0, y: 0 })
  })

  it('bows the middle of the route off the straight line', () => {
    const middle = arcOffset(normal, .5)
    expect(Math.hypot(middle.x, middle.y)).toBeCloseTo(ARC_HEIGHT, 6)
  })

  it('has nothing to say when the route has no side to bow towards', () => {
    expect(arcOffset({ x: 0, y: 0 }, .5)).toEqual({ x: 0, y: 0 })
  })
})

describe('bankAngle', () => {
  it('is upright at both ends, whatever the ease did to the route', () => {
    for (const progress of [0, 1]) {
      expect(bankAngle(1, progress)).toBe(0)
      expect(bankAngle(-1, progress)).toBe(0)
    }
  })

  it('leans into the direction of travel, so the two journeys lean opposite ways', () => {
    expect(bankAngle(1, .5)).toBe(BANK_ANGLE)
    expect(bankAngle(-1, .5)).toBe(-BANK_ANGLE)
  })

  it('resolves the roll without passing through it twice', () => {
    const samples = Array.from({ length: 101 }, (_, index) => bankAngle(1, index / 100))
    expect(Math.max(...samples)).toBeLessThanOrEqual(BANK_ANGLE + 1e-9)
    // One rise and one fall: a second hump would read as a wobble on the way in.
    const steps = samples.slice(1).map((value, index) => value - samples[index]!)
    const turns = steps.slice(1).filter((value, index) => Math.sign(value) !== Math.sign(steps[index]!))
    expect(turns).toHaveLength(1)
  })
})

describe('the performance tracks', () => {
  const read = (track: readonly FlightTrack[], component: 'x' | 'y'): number[] =>
    track.map((step) => {
      const values = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(step.transform)
      return Number(component === 'x' ? values?.[1] ?? 0 : values?.[2] ?? 0)
    })

  it('starts and ends at rest, so nothing is left leaning on the seat', () => {
    for (const track of [torsoTrack(1), torsoTrack(-1), eyeTrack(1), eyeTrack(-1)]) {
      expect(track[0]!.transform).toContain('translate(0px, 0px)')
      expect(track.at(-1)!.offset).toBe(1)
    }
    expect(torsoTrack(1)[0]!.transform).toMatch(/scale\(1, 1\)$/)
    expect(torsoTrack(1).at(-1)!.transform).toMatch(/scale\(1, 1\)$/)
  })

  it('covers the whole flight once, in order', () => {
    for (const track of [torsoTrack(1), eyeTrack(1), bankTrack(1)]) {
      const offsets = track.map((step) => step.offset)
      expect(offsets[0]).toBe(0)
      expect([...offsets].sort((a, b) => a - b)).toEqual(offsets)
      expect(new Set(offsets).size).toBe(offsets.length)
    }
  })

  it('mirrors the torso and the eyes for the other direction, and only sideways', () => {
    // `+ 0` because negating a resting zero gives `-0`, which is not the same
    // number as `0` to a deep equality check.
    expect(read(torsoTrack(-1), 'x')).toEqual(read(torsoTrack(1), 'x').map((value) => -value + 0))
    expect(read(eyeTrack(-1), 'x')).toEqual(read(eyeTrack(1), 'x').map((value) => -value + 0))
    // Crouch, climb and settle are the same beats both ways round.
    expect(read(torsoTrack(-1), 'y')).toEqual(read(torsoTrack(1), 'y'))
    expect(read(eyeTrack(-1), 'y')).toEqual(read(eyeTrack(1), 'y'))
  })

  it('crouches before it climbs, and looks at the destination on the way out', () => {
    const [, crouch, climb] = read(torsoTrack(1), 'y')
    expect(crouch).toBeGreaterThan(0)
    expect(climb).toBeLessThan(0)
    // The eyes commit to the destination early, then face front for the cruise.
    expect(read(eyeTrack(1), 'x')[1]).toBeGreaterThan(10)
    expect(read(eyeTrack(1), 'x')[2]).toBe(0)
  })

  it('stretches along the direction of travel while cruising', () => {
    const scales = torsoTrack(1).map((step) => /scale\(([-\d.]+), ([-\d.]+)\)/.exec(step.transform))
    const cruise = scales.find((match) => Number(match?.[2]) > 1)
    expect(cruise).toBeDefined()
    expect(Number(cruise?.[1])).toBeLessThan(1)
  })

  it('rolls as a track of its own, upright at both ends and peaking mid-route', () => {
    const roll = (track: readonly FlightTrack[]): number[] =>
      track.map((step) => Number(/rotate\(([-\d.]+)deg\)/.exec(step.transform)?.[1]))
    const there = roll(bankTrack(1))
    const back = roll(bankTrack(-1))
    expect(there[0]).toBe(0)
    expect(there.at(-1)).toBe(0)
    expect(there).toEqual(back.map((value) => -value + 0))
    // The hump rides the clock, so the roll is at its widest halfway through.
    expect(there[there.length >> 1]).toBe(BANK_ANGLE)
    expect(Math.max(...there)).toBeLessThanOrEqual(BANK_ANGLE)
  })
})
