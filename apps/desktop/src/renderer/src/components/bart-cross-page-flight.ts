/** Pure geometry for a prepared cross-page route. Both native seats use the
 * same 640-unit character space; their affine endpoints are sealed once before
 * flight. The Worker evaluates the compiled matrices without measuring DOM. */

export interface InkBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface InkPoint {
  readonly x: number
  readonly y: number
}

/** Strong deceleration: Bart covers most of the distance early and settles in. */
export const flightEase = (progress: number): number => 1 - (1 - progress) ** 4

export const inkCenter = (box: InkBox): InkPoint => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })

/** The 2D matrix `getScreenCTM` hands back, structurally — nothing here needs more. */
export interface ScreenMatrix {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
  readonly e: number
  readonly f: number
}

/** `{ a: 1, b: 0, c: 0, d: 1, e: x, f: y }` — the only matrix a route ever adds by hand. */
export function translationMatrix(x: number, y: number): ScreenMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y }
}

/** `inner` applied first, then `outer` — the order `getScreenCTM` composes ancestors in. */
export function multiplyMatrix(outer: ScreenMatrix, inner: ScreenMatrix): ScreenMatrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f
  }
}

export function inverseMatrix(matrix: ScreenMatrix): ScreenMatrix | null {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c
  if (!determinant) return null
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant
  }
}

export function matrixCss(matrix: ScreenMatrix): string {
  return `matrix(${matrix.a}, ${matrix.b}, ${matrix.c}, ${matrix.d}, ${matrix.e}, ${matrix.f})`
}

/** The four numbers a 2D matrix actually turns into, with the translation aside. */
interface DecomposedMatrix {
  readonly scaleX: number
  readonly scaleY: number
  readonly angle: number
  readonly skew: number
}

/**
 * Rotation, skew and scale recovered from the numbers, in the order
 * `rotate * skewX * scale` puts them back together. The translation is kept out
 * of it: a route runs in viewport pixels at scale 1, so both ends already agree
 * on what a pixel is and the offset needs no decomposition at all.
 *
 * Neither seat is mirrored, so the scale signs are left to the square roots —
 * a flipped matrix is the one shape this would not survive, and no ancestor of
 * a `BartLogo` flips.
 */
export function decomposeMatrix(matrix: ScreenMatrix): DecomposedMatrix {
  let a = matrix.a
  let b = matrix.b
  let c = matrix.c
  let d = matrix.d
  const scaleX = Math.hypot(a, b)
  if (scaleX) { a /= scaleX; b /= scaleX }
  let skew = a * c + b * d
  if (skew) { c -= a * skew; d -= b * skew }
  let scaleY = Math.hypot(c, d)
  if (scaleY) { c /= scaleY; d /= scaleY; skew /= scaleY }
  else scaleY = 0
  return { scaleX, scaleY, angle: Math.atan2(b, a), skew }
}

export function composeMatrix(
  decomposed: DecomposedMatrix,
  x: number,
  y: number
): ScreenMatrix {
  const cosine = Math.cos(decomposed.angle)
  const sine = Math.sin(decomposed.angle)
  return {
    a: cosine * decomposed.scaleX,
    b: sine * decomposed.scaleX,
    c: (cosine * decomposed.skew - sine) * decomposed.scaleY,
    d: (sine * decomposed.skew + cosine) * decomposed.scaleY,
    e: x,
    f: y
  }
}

/**
 * The seat turned a fraction of the way towards another seat: every part of the
 * mapping moves together, so a copy parked by this is the same size, lean and
 * place as the two ends it is between.
 */
export function blendMatrix(from: ScreenMatrix, to: ScreenMatrix, progress: number): ScreenMatrix {
  const start = decomposeMatrix(from)
  const end = decomposeMatrix(to)
  const at = (first: number, second: number): number => first + (second - first) * progress
  // Shortest way round. Both seats are within a few degrees of upright, so this
  // only matters for the flipped intermediate a rotate(359deg) seat would make.
  let turn = end.angle - start.angle
  if (turn > Math.PI) turn -= Math.PI * 2
  else if (turn < -Math.PI) turn += Math.PI * 2
  return composeMatrix({
    scaleX: at(start.scaleX, end.scaleX),
    scaleY: at(start.scaleY, end.scaleY),
    angle: start.angle + turn * progress,
    skew: at(start.skew, end.skew)
  }, at(from.e, to.e), at(from.f, to.f))
}

/**
 * A DOM matrix copied into the plain shape everything here works in. `getScreenCTM`
 * hands back a live object, so the numbers are taken out of it rather than the
 * object itself being carried around.
 */
export function matrixOf(matrix: ScreenMatrix): ScreenMatrix {
  return {
    a: matrix.a,
    b: matrix.b,
    c: matrix.c,
    d: matrix.d,
    e: matrix.e,
    f: matrix.f
  }
}

/**
 * The viewport-aligned box a local box covers once `matrix` has been applied.
 *
 * All four corners, not the diagonal's two. The seats are measured while they are
 * moving, and the coordinator's handoff gesture turns an ancestor of its logo by up
 * to 11°: under a rotation the two opposite corners of a box span *less* than the box
 * does — at 11° a 91px square reads 72px, a third short — so a two-corner reading
 * would show the copy shrinking to two thirds and growing back as the gesture settled.
 * For the unturned matrices this is exactly the box it started as.
 */
export function inkBoxFromCorners(box: InkBox, matrix: ScreenMatrix): InkBox {
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height]
  ] as const) {
    xs.push(matrix.a * x + matrix.c * y + matrix.e)
    ys.push(matrix.b * x + matrix.d * y + matrix.f)
  }
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
}

/** How far the route bows off the straight line at its highest, in viewport pixels. */
export const ARC_HEIGHT = 64
/** Degrees of roll into the direction of travel while cruising. */
export const BANK_ANGLE = 6
/**
 * How far into the route the copy starts wearing the seat it is going to land on:
 * before this point it is still the Bart that took off, and the seat's own
 * expression would be a stranger's face under it. From here on the two meet, and
 * the rest of the route is the time the meeting takes. The face dressing turns
 * over at the same mark, so the expression and the dressing it belongs to arrive
 * together rather than as two changes the eye can tell apart.
 */
export const AIM_AT = .45

/**
 * The share of the destination's face dressing the copy is wearing at this point
 * of the route: none of it at takeoff, all of it from the mark on. A dressing is
 * a transform on the face layer and not part of any seat's pose — a Dock role
 * puts one there and so does the coordinator's idle gaze — so the copy carries
 * what the seat it left was wearing and hands over to what the seat it is
 * approaching is wearing, which is what makes both ends of the flight land on a
 * frame the seat beside it is already drawing.
 *
 * Only transforms travel this way. A role that hides the face instead of moving
 * it is the Dock's own decoration standing in for it, and a decoration stays
 * where it belongs rather than becoming cargo.
 */
export function dressingShare(progress: number): number {
  return Math.min(1, progress / AIM_AT)
}

/**
 * One hump across the journey: `1` halfway through, never negative, and exactly
 * zero at both ends. Exactly zero is the point — the ends are where the copy has
 * to sit on the ink box it was aimed at, and `sin(Math.PI)` is not zero.
 */
const hump = (progress: number): number =>
  progress <= 0 || progress >= 1 ? 0 : Math.sin(Math.PI * progress)

/**
 * Which way the route bows: perpendicular to the line between the two seats and
 * always taken towards the top of the screen, so the two directions arch the same
 * way round rather than one of them diving under the other.
 *
 * Read once, as the flight leaves, rather than per frame. The destination slides
 * and a live normal follows it, so the moment the seat crosses the Dock's own
 * column the normal flips to the other side and the copy jumps the width of the
 * arch in a single frame. Pinning the side costs nothing while the route is
 * short and buys continuity while the seat is still moving.
 */
export function arcNormal(from: InkPoint, to: InkPoint): InkPoint {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (!length) return { x: 0, y: 0 }
  const x = dx < 0 ? -dy : dy
  const y = dx < 0 ? dx : -dx
  return { x: x / length, y: y / length }
}

/** How far along that bow the route is, in viewport pixels. */
export function arcOffset(normal: InkPoint, progress: number): InkPoint {
  const bow = hump(progress)
  if (!bow) return { x: 0, y: 0 }
  return { x: normal.x * bow * ARC_HEIGHT, y: normal.y * bow * ARC_HEIGHT }
}

/**
 * The bow of a leg that starts with the copy already in the air: the offset it
 * was carrying, eased away instead of raised again from nothing. Restarting
 * `arcOffset` would drop the copy by however much of the arch it was riding at
 * the moment it turned, which is tens of pixels at the top.
 */
export function settleOffset(carried: InkPoint, progress: number): InkPoint {
  const remaining = 1 - progress
  return { x: carried.x * remaining, y: carried.y * remaining }
}

/**
 * Where the performance has got to on a leg that joined one already running. The
 * layers are driven by this fraction of the whole flight, so a leg starting from
 * neutral would snap the torso upright and the eyes forward on its first frame —
 * the copy would arrive at the turn, flash the pose of a copy that never flew,
 * and then perform the beats a second time. Carrying the fraction forward
 * instead makes the two legs one performance: the beats continue from where the
 * first was cut off, and the remaining ones are stretched over what is left of
 * the route rather than restarted.
 */
export function carryBeat(beats: number, along: number): number {
  return beats + (1 - beats) * along
}

/**
 * The roll of the body along its own tangent: the journey is a sideways move in
 * both directions, so the sign is the direction of travel and the two routes lean
 * opposite ways; the hump resolves the roll at both ends, so it never snaps
 * upright on touchdown.
 */
export function bankAngle(travel: number, progress: number): number {
  const lean = hump(progress)
  if (!lean) return 0
  return (Math.sign(travel) || 1) * BANK_ANGLE * lean
}

/**
 * One layer of the performance: a transform track the browser can run on its own.
 * A type alias rather than an interface because `Keyframe` is indexed by CSS
 * property name, and only object-literal types get the implicit index signature
 * that lets these flow straight into `Element.animate`.
 */
export type FlightTrack = {
  transform: string
  offset: number
  easing?: string
}

/**
 * The torso's three beats, in user units of the logo's own 640 box: crouch and
 * push off, carry forward along the route, then compress past neutral and settle.
 * The overshoot is a single pass — a second one would read as a bounce and fight
 * the host mark's own landing animation, which starts on the same frame.
 */
export function torsoTrack(travel: number): readonly FlightTrack[] {
  return [
    { offset: 0, transform: 'translate(0px, 0px) scale(1, 1)' },
    { offset: .08, transform: `translate(${travel * -3}px, 17px) scale(1.07, .91)`, easing: 'ease-out' },
    { offset: .15, transform: 'translate(0px, -14px) scale(.95, 1.07)', easing: 'ease-in' },
    { offset: .45, transform: `translate(${travel * 18}px, -10px) scale(.94, 1.08)` },
    { offset: .75, transform: `translate(${travel * 14}px, -7px) scale(.96, 1.05)`, easing: 'ease-out' },
    { offset: .88, transform: `translate(${travel * 8}px, 9px) scale(1.05, .95)` },
    { offset: 1, transform: 'translate(0px, 0px) scale(1, 1)', easing: 'ease-out' }
  ]
}

/**
 * The eyes, on their own track: they find the destination as the push-off starts,
 * come back to the front for the cruise, and drop to the seat on the way in.
 */
export function eyeTrack(travel: number): readonly FlightTrack[] {
  return [
    { offset: 0, transform: 'translate(0px, 0px)' },
    { offset: .15, transform: `translate(${travel * 26}px, 6px)`, easing: 'ease-out' },
    { offset: .5, transform: 'translate(0px, 0px)', easing: 'ease-in-out' },
    { offset: .85, transform: 'translate(0px, 3px)', easing: 'ease-out' },
    { offset: 1, transform: 'translate(0px, 0px)' }
  ]
}

/** Enough samples that the straight lines between them are the hump. */
const BANK_STEPS = 12

/**
 * The roll as a track like the other two, so all three layers of the performance
 * are animated the same way and none of them is written by hand each frame.
 */
export function bankTrack(travel: number): readonly FlightTrack[] {
  return Array.from({ length: BANK_STEPS + 1 }, (_, index) => {
    const at = index / BANK_STEPS
    return { offset: at, transform: `rotate(${bankAngle(travel, at).toFixed(3)}deg)` }
  })
}
