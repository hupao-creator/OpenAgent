/** Shared character geometry and clocks; sinks may be SVG attributes or Worker canvas parts. */
import type { BartVisualOperation } from '../bart-visual-operation'

export type BartLogoActivity = BartVisualOperation['kind'] | 'idle' | 'thinking' | 'tool'
export type BartLogoPhase = BartVisualOperation['phase'] | 'idle'
export type BartLogoLayout = 'mark' | 'message' | 'permission' | 'question'
export type BartInterventionVisualState = 'processing' | 'allow' | 'deny' | 'answer'

export type BartLogoExpression =
  | 'idle'
  | 'focus'
  | 'deliberating'
  | 'happy'
  | 'surprised'
  | 'sleepy'
  | 'curious'

export type BartLogoShape = 'circle' | 'drop' | 'hex' | 'triangle' | 'mark'
export type BartAction = 'none' | 'bounce' | 'nod'

export interface Point {
  x: number
  y: number
}

export interface AnimatedPoint extends Point {
  vx: number
  vy: number
}

export interface AnimatedValue {
  value: number
  velocity: number
}

export interface EyeSaccade {
  targetX: number
  targetY: number
  offsetX: AnimatedValue
  offsetY: AnimatedValue
  nextSweepAt: number
  returnAt: number
}

export interface BartLogoEye {
  x: number
  y: number
  w: number
  h: number
  radius: number
  rotation: number
  opacity: number
}

export type AnimatedEye = Record<keyof BartLogoEye, AnimatedValue>

export interface BartDescriptor {
  expression: BartLogoExpression
  shape: BartLogoShape
  action: BartAction
  thought: boolean
  orbit: boolean
  /** Whether this pose waits on the model, and so blinks on the faster clock. */
  eagerBlink?: boolean
}

export interface BartMotionState {
  /** Worker residents rest between scheduled gestures instead of drawing a perpetual idle float. */
  restBetweenGestures?: boolean
  key: string
  expression: BartLogoExpression
  shape: BartLogoShape
  layout: BartLogoLayout
  bodyPoints: AnimatedPoint[]
  bodyTargets: Point[]
  satellitePoints: AnimatedPoint[]
  satelliteTargets: Point[]
  satelliteOpacity: AnimatedValue
  orbitOpacity: AnimatedValue
  thoughtRadius: AnimatedValue
  orbitActive: boolean
  thoughtActive: boolean
  blinkStarted: number
  nextNaturalBlink: number
  eagerBlink: boolean
  bounceStarted: number
  nodStarted: number
  eyeSaccade: EyeSaccade
  eyeLeft: AnimatedEye
  eyeRight: AnimatedEye
  lastFrameAt: number
}

export interface BartElements {
  body: MotionPart | null
  satellite: MotionPart | null
  leftEye: MotionPart | null
  rightEye: MotionPart | null
  thoughtDot: MotionPart | null
  bot: MotionPart | null
  orbits: MotionPart | null
  orbitEllipses: Array<MotionPart | null>
}

/**
 * One frame of the character, in the logo's own user units, together with the
 * clocks that were driving it. Absolute timestamps ride along unchanged because
 * every renderer in the page shares one `performance.now()`: a blink caught
 * halfway carries on from where it was rather than restarting.
 *
 * This is what makes a handoff between two renderers invisible. The springs, the
 * blink, the gestures and the gaze are all state the next renderer cannot infer
 * from an element box, so the outgoing one hands its own frame over instead.
 */
export interface BartLogoPose {
  readonly expression: BartLogoExpression
  readonly shape: BartLogoShape
  readonly thought: boolean
  readonly orbit: boolean
  readonly body: ReadonlyArray<{ readonly x: number; readonly y: number }>
  readonly satellite: ReadonlyArray<{ readonly x: number; readonly y: number }>
  readonly satelliteOpacity: number
  readonly orbitOpacity: number
  readonly thoughtRadius: number
  readonly eyes: readonly [BartLogoEye, BartLogoEye]
  readonly blinkStarted: number
  readonly nextNaturalBlink: number
  readonly eagerBlink: boolean
  readonly bounceStarted: number
  readonly nodStarted: number
  readonly gaze: {
    readonly targetX: number
    readonly targetY: number
    readonly x: number
    readonly y: number
    readonly nextSweepAt: number
    readonly returnAt: number
  }
}

export const POINT_COUNT = 36
export const CENTER = { x: 320, y: 300 }
export const BODY_COLOR = '#10110f'
export const EYE_COLOR = '#f7f5ee'
export const EYE_SACCADE_INTERVAL_MIN_MS = 2200
export const EYE_SACCADE_INTERVAL_VARIATION_MS = 2600
export const EYE_SACCADE_DWELL_MS = 320
export const EYE_SACCADE_RETURN_DELAY_MS = 620
export const EYE_SACCADE_MAX_X = 4.5
export const EYE_SACCADE_MAX_Y = 3
export const EYE_SACCADE_SPEED = 0.095
export const FIRST_BLINK_MS = 3600
export const BLINK_INTERVAL_MIN_MS = 3400
export const BLINK_INTERVAL_VARIATION_MS = 2600
export const BLINK_INTERVAL_EAGER_MIN_MS = 1400
export const BLINK_INTERVAL_EAGER_VARIATION_MS = 1200
export const EXPRESSIONS: Record<BartLogoExpression, { left: BartLogoEye; right: BartLogoEye }> = {
  idle: {
    left: { x: -43, y: -70, w: 31, h: 78, radius: 16, rotation: -13, opacity: 1 },
    right: { x: 43, y: -78, w: 31, h: 78, radius: 16, rotation: -13, opacity: 1 }
  },
  focus: {
    left: { x: -36, y: -6, w: 31, h: 82, radius: 16, rotation: -5, opacity: 1 },
    right: { x: 36, y: 0, w: 31, h: 82, radius: 16, rotation: 6, opacity: 1 }
  },
  deliberating: {
    left: { x: -29, y: -5, w: 31, h: 78, radius: 16, rotation: -4, opacity: 1 },
    right: { x: 29, y: 1, w: 31, h: 78, radius: 16, rotation: 5, opacity: 1 }
  },
  happy: {
    left: { x: -43, y: 54, w: 45, h: 102, radius: 23, rotation: 14, opacity: 1 },
    right: { x: 45, y: 58, w: 38, h: 96, radius: 20, rotation: 14, opacity: 1 }
  },
  surprised: {
    left: { x: -52, y: 8, w: 62, h: 62, radius: 31, rotation: 0, opacity: 1 },
    right: { x: 48, y: -14, w: 76, h: 76, radius: 38, rotation: 0, opacity: 1 }
  },
  sleepy: {
    left: { x: -48, y: 10, w: 76, h: 19, radius: 10, rotation: 10, opacity: 1 },
    right: { x: 48, y: 19, w: 76, h: 19, radius: 10, rotation: 10, opacity: 1 }
  },
  curious: {
    left: { x: -53, y: 16, w: 60, h: 60, radius: 30, rotation: 0, opacity: 1 },
    right: { x: 48, y: -5, w: 78, h: 78, radius: 39, rotation: 0, opacity: 1 }
  }
}

export function primaryOperation(
  operations: readonly BartVisualOperation[] | undefined
): BartVisualOperation | undefined {
  return operations?.findLast((candidate) => candidate.phase === 'running') || operations?.at(-1)
}

export function interventionDescriptor(state: BartInterventionVisualState): BartDescriptor {
  if (state === 'processing') {
    return {
      expression: 'deliberating',
      shape: 'circle',
      action: 'none',
      thought: true,
      orbit: false
    }
  }
  if (state === 'allow') {
    return { expression: 'happy', shape: 'circle', action: 'bounce', thought: false, orbit: false }
  }
  if (state === 'deny') {
    return { expression: 'idle', shape: 'circle', action: 'none', thought: false, orbit: false }
  }
  return { expression: 'curious', shape: 'circle', action: 'bounce', thought: false, orbit: false }
}

export function interactionDescriptor(
  layout: Extract<BartLogoLayout, 'permission' | 'question'>
): BartDescriptor {
  return {
    expression: layout === 'permission' ? 'focus' : 'curious',
    shape: 'circle',
    action: 'none',
    thought: false,
    orbit: false
  }
}

/**
 * What a seat is showing, given what it is doing and anything it is waiting on
 * an answer for. The waiting outranks the doing: a seat answering a permission is
 * drawing the answer, not the operation underneath it. Both a seat and the copy
 * aimed at it come through here, so the rule lives in one place rather than being
 * spelled twice and drifting apart.
 */
export function seatDescriptor(
  activity: BartLogoActivity,
  phase: BartLogoPhase,
  interventionState?: BartInterventionVisualState
): BartDescriptor {
  if (interventionState) return interventionDescriptor(interventionState)
  const descriptor = descriptorFor(activity, phase)
  // Waiting on the model is the one pose where the wait is the whole of what Bart
  // is doing, and the clock it blinks on belongs to that pose rather than to the
  // activity that resolved it. An intervention answer outranks the activity it was
  // asked about, so a Bart drawing one over a `thinking` activity waits on nothing.
  return activity === 'thinking' ? { ...descriptor, eagerBlink: true } : descriptor
}

export function descriptorFor(activity: BartLogoActivity, phase: BartLogoPhase): BartDescriptor {
  if (phase === 'failed' || phase === 'cancelled') {
    return { expression: 'idle', shape: 'circle', action: 'none', thought: false, orbit: false }
  }
  // start 的完成反馈由随后紧邻的 Thread generation 承担。若这里也 bounce，连续
  // 创建时每个快速完成的 tool operation 都会重启 1.15s 弹跳，Bart 起飞前便
  // 在 Dock 原地抽动数次。running/completed 共用稳定的 focus pose。
  if (activity === 'start') {
    return { expression: 'focus', shape: 'circle', action: 'none', thought: false, orbit: false }
  }
  if (phase === 'completed') {
    return { expression: 'idle', shape: 'circle', action: 'none', thought: false, orbit: false }
  }
  if (activity === 'tool') {
    // The locked tool pose compacts the resident eyes in CSS and keeps their
    // native blinks and gaze. Only the dot is shared with the thinking state.
    return { expression: 'idle', shape: 'circle', action: 'none', thought: true, orbit: false }
  }
  if (activity === 'thinking') {
    return { expression: 'curious', shape: 'circle', action: 'none', thought: true, orbit: false }
  }
  if (activity === 'list') {
    return { expression: 'focus', shape: 'hex', action: 'none', thought: false, orbit: true }
  }
  if (activity === 'send') {
    return { expression: 'happy', shape: 'drop', action: 'bounce', thought: false, orbit: false }
  }
  if (activity === 'status') {
    return { expression: 'curious', shape: 'hex', action: 'none', thought: true, orbit: false }
  }
  if (activity === 'interrupt') {
    return { expression: 'idle', shape: 'mark', action: 'nod', thought: false, orbit: false }
  }
  if (activity === 'delete') {
    return { expression: 'sleepy', shape: 'drop', action: 'none', thought: false, orbit: false }
  }
  return { expression: 'idle', shape: 'circle', action: 'none', thought: false, orbit: false }
}

/**
 * What a frame's state is called. The state only ever compares names — a change is
 * what restarts the action clocks and the saccade timer — so two renderers
 * describing the same thing have to spell it the same way. A seat spells its own
 * here and publishes it as `data-motion-key`; the flight hands that same string
 * straight back as `resolvedKey` to the copy imitating it. Which activity and
 * phase go in is each caller's business; how they are written down is not.
 */
export function motionKeyFor(
  layout: BartLogoLayout,
  activity: string,
  phase: string,
  extra = ''
): string {
  return `${layout}:${activity}:${phase}:${extra}`
}

/**
 * Whether this shape draws the orbiting satellite. Only the Dock's mark has one:
 * the same 640 box is drawn as a face in every other seat and layout, and the
 * satellite is what a mark uses instead of a face.
 */
export const showsSatellite = (shape: BartLogoShape, layout: BartLogoLayout): boolean =>
  shape === 'mark' && layout === 'mark'

/**
 * How long until the next natural blink. A pose that is waiting on the model is
 * the one place where the wait is the whole of what Bart is doing, and the same
 * 320ms blink comes around much more often there: a face that only moves once
 * every five seconds reads as stalled while Bart is thinking. The first blink of
 * a pose waits a beat longer than the ones after it, so mounting is not a blink.
 */
export function blinkDelay(eagerBlink: boolean, first = false): number {
  if (eagerBlink) {
    return BLINK_INTERVAL_EAGER_MIN_MS + Math.random() * BLINK_INTERVAL_EAGER_VARIATION_MS
  }
  return first
    ? FIRST_BLINK_MS
    : BLINK_INTERVAL_MIN_MS + Math.random() * BLINK_INTERVAL_VARIATION_MS
}

export function createMotionState(
  key: string,
  descriptor: BartDescriptor,
  layout: BartLogoLayout,
  pose?: BartLogoPose
): BartMotionState {
  const now = performance.now()
  const shape = descriptor.shape
  const eagerBlink = descriptor.eagerBlink === true
  const showSatellite = showsSatellite(shape, layout)
  const bodyTargets = buildShape(shape, layout)
  const satelliteTargets = buildSatellite(showSatellite)
  const initialEyes = eyesForLayout(EXPRESSIONS[descriptor.expression], layout)
  const state: BartMotionState = {
    key,
    expression: descriptor.expression,
    shape,
    layout,
    bodyPoints: makeAnimatedPoints(bodyTargets),
    bodyTargets,
    satellitePoints: makeAnimatedPoints(satelliteTargets),
    satelliteTargets,
    satelliteOpacity: createAnimatedValue(showSatellite ? 1 : 0),
    orbitOpacity: createAnimatedValue(descriptor.orbit ? 1 : 0),
    thoughtRadius: createAnimatedValue(descriptor.thought ? 19 : 0),
    orbitActive: descriptor.orbit,
    thoughtActive: descriptor.thought,
    blinkStarted: -Infinity,
    nextNaturalBlink: now + blinkDelay(eagerBlink, true),
    eagerBlink,
    bounceStarted: descriptor.action === 'bounce' ? now : -Infinity,
    nodStarted: descriptor.action === 'nod' ? now : -Infinity,
    eyeSaccade: {
      targetX: 0,
      targetY: 0,
      offsetX: createAnimatedValue(0),
      offsetY: createAnimatedValue(0),
      nextSweepAt: now + EYE_SACCADE_INTERVAL_MIN_MS + Math.random() * EYE_SACCADE_INTERVAL_VARIATION_MS,
      returnAt: 0
    },
    eyeLeft: createEye(initialEyes.left),
    eyeRight: createEye(initialEyes.right),
    lastFrameAt: now
  }
  // A state seeded from a frame aims at exactly what the frame it is taking over
  // was aiming at, and holds the springs it was caught in the middle of. Anything
  // else — the descriptor's own shape, or a fresh idle — would drift away from the
  // renderer still on screen and read as the character changing twice. There is
  // one way to take a frame over, and this is it.
  if (pose) adoptPose(state, pose, now)
  return state
}

/** The rendered geometry of one eye, as a target the springs can be handed. */
export function eyeTargetOf(eye: AnimatedEye): BartLogoEye {
  return {
    x: eye.x.value,
    y: eye.y.value,
    w: eye.w.value,
    h: eye.h.value,
    radius: eye.radius.value,
    rotation: eye.rotation.value,
    opacity: eye.opacity.value
  }
}

/**
 * A frame taken off a running renderer. The clocks come with it: they are
 * absolute on a clock every renderer shares, so a blink caught mid-way goes on
 * blinking and a bounce caught mid-way goes on bouncing.
 */
export function poseOf(state: BartMotionState): BartLogoPose {
  return {
    expression: state.expression,
    shape: state.shape,
    thought: state.thoughtActive,
    orbit: state.orbitActive,
    body: state.bodyPoints.map(({ x, y }) => ({ x, y })),
    satellite: state.satellitePoints.map(({ x, y }) => ({ x, y })),
    satelliteOpacity: state.satelliteOpacity.value,
    orbitOpacity: state.orbitOpacity.value,
    thoughtRadius: state.thoughtRadius.value,
    eyes: [eyeTargetOf(state.eyeLeft), eyeTargetOf(state.eyeRight)],
    blinkStarted: state.blinkStarted,
    nextNaturalBlink: state.nextNaturalBlink,
    eagerBlink: state.eagerBlink,
    bounceStarted: state.bounceStarted,
    nodStarted: state.nodStarted,
    gaze: {
      targetX: state.eyeSaccade.targetX,
      targetY: state.eyeSaccade.targetY,
      x: state.eyeSaccade.offsetX.value,
      y: state.eyeSaccade.offsetY.value,
      nextSweepAt: state.eyeSaccade.nextSweepAt,
      returnAt: state.eyeSaccade.returnAt
    }
  }
}

/**
 * Take a frame over. Velocities are dropped rather than handed across: they are
 * the one part of the state that is an artefact of the outgoing renderer's frame
 * pacing, and re-entering them on a different clock would overshoot the pose the
 * eye has just been shown.
 */
export function adoptPose(state: BartMotionState, pose: BartLogoPose, now: number): void {
  state.expression = pose.expression
  state.shape = pose.shape
  state.orbitActive = pose.orbit
  state.thoughtActive = pose.thought
  state.bodyTargets = buildShape(pose.shape, state.layout)
  state.satelliteTargets = buildSatellite(showsSatellite(pose.shape, state.layout))
  state.bodyPoints = makeAnimatedPoints(pose.body)
  state.satellitePoints = makeAnimatedPoints(pose.satellite)
  state.satelliteOpacity = createAnimatedValue(pose.satelliteOpacity)
  state.orbitOpacity = createAnimatedValue(pose.orbitOpacity)
  state.thoughtRadius = createAnimatedValue(pose.thoughtRadius)
  state.eyeLeft = createEye(pose.eyes[0])
  state.eyeRight = createEye(pose.eyes[1])
  state.blinkStarted = pose.blinkStarted
  state.nextNaturalBlink = pose.nextNaturalBlink
  state.eagerBlink = pose.eagerBlink
  state.bounceStarted = pose.bounceStarted
  state.nodStarted = pose.nodStarted
  state.eyeSaccade = {
    targetX: pose.gaze.targetX,
    targetY: pose.gaze.targetY,
    offsetX: createAnimatedValue(pose.gaze.x),
    offsetY: createAnimatedValue(pose.gaze.y),
    nextSweepAt: pose.gaze.nextSweepAt,
    returnAt: pose.gaze.returnAt
  }
  state.lastFrameAt = now
}

export function applyDescriptor(
  state: BartMotionState,
  key: string,
  descriptor: BartDescriptor,
  layout: BartLogoLayout,
  now: number
): void {
  const eagerBlink = descriptor.eagerBlink === true
  state.expression = descriptor.expression
  state.shape = descriptor.shape
  state.layout = layout
  state.bodyTargets = buildShape(descriptor.shape, layout)
  state.satelliteTargets = buildSatellite(showsSatellite(descriptor.shape, layout))
  state.orbitActive = descriptor.orbit
  state.thoughtActive = descriptor.thought
  // The deadline is rescheduled whenever the clock changes under it: left alone,
  // a pose that has just started waiting would still wait out one slow interval,
  // and a pose that has stopped waiting would still blink once on the fast one.
  if (eagerBlink !== state.eagerBlink) {
    state.eagerBlink = eagerBlink
    state.nextNaturalBlink = now + blinkDelay(eagerBlink)
  }
  if (state.key === key) return
  state.key = key
  if (descriptor.action === 'bounce') state.bounceStarted = now
  if (descriptor.action === 'nod') state.nodStarted = now
  if (descriptor.expression !== 'idle') {
    state.eyeSaccade.targetX = 0
    state.eyeSaccade.targetY = 0
    state.eyeSaccade.returnAt = 0
    state.eyeSaccade.nextSweepAt = now + EYE_SACCADE_INTERVAL_MIN_MS + Math.random() * EYE_SACCADE_INTERVAL_VARIATION_MS
  }
}

export function snapMotionToTargets(state: BartMotionState): void {
  state.bodyPoints = makeAnimatedPoints(state.bodyTargets)
  state.satellitePoints = makeAnimatedPoints(state.satelliteTargets)
  state.satelliteOpacity.value = showsSatellite(state.shape, state.layout) ? 1 : 0
  state.orbitOpacity.value = state.orbitActive ? 1 : 0
  state.thoughtRadius.value = state.thoughtActive ? 19 : 0
}

export function renderMotionFrame(state: BartMotionState, elements: BartElements, now: number): void {
  // A write at the same instant as the last one is a repaint of the frame already
  // in hand, not a step past it — which is what a handoff needs, because the copy
  // is drawn by a write racing the loop that drew the frame it took over, and a
  // forced step there would paint a frame the seat never showed. The floor of one
  // millisecond used to make every such write jump.
  const delta = Math.min(34, Math.max(0, now - state.lastFrameAt))
  const frameScale = delta / (1000 / 60)
  state.lastFrameAt = now

  if (now >= state.nextNaturalBlink && state.shape !== 'mark') {
    state.blinkStarted = now
    state.nextNaturalBlink = now + blinkDelay(state.eagerBlink)
  }

  renderSpringPath(
    elements.body, state.bodyPoints, state.bodyTargets, frameScale,
    state.layout === 'permission' ? 0 : state.layout === 'mark' ? 0.82 : 1
  )
  renderSpringPath(elements.satellite, state.satellitePoints, state.satelliteTargets, frameScale, 0.72)

  const satelliteOpacity = springValue(
    state.satelliteOpacity,
    showsSatellite(state.shape, state.layout) ? 1 : 0,
    frameScale,
    0.18,
    0.76
  )
  setAttributeIfChanged(elements.satellite, 'opacity', clamp(satelliteOpacity, 0, 1).toFixed(3))

  const faceOpacity = showsSatellite(state.shape, state.layout) ? 0 : 1
  const blinkProgress = (now - state.blinkStarted) / 320
  const blinkScale =
    blinkProgress >= 0 && blinkProgress <= 1
      ? 1 - Math.sin(blinkProgress * Math.PI) * 0.91
      : 1
  const expression = eyesForLayout(EXPRESSIONS[state.expression], state.layout)
  if (
    state.expression === 'idle' &&
    now >= state.eyeSaccade.nextSweepAt &&
    state.eyeSaccade.returnAt <= now
  ) {
    state.eyeSaccade.targetX = (Math.random() * 2 - 1) * EYE_SACCADE_MAX_X
    state.eyeSaccade.targetY = (Math.random() * 2 - 1) * EYE_SACCADE_MAX_Y
    state.eyeSaccade.returnAt = now + EYE_SACCADE_DWELL_MS
    state.eyeSaccade.nextSweepAt = now + EYE_SACCADE_DWELL_MS + EYE_SACCADE_RETURN_DELAY_MS
  }

  if (
    state.expression === 'idle' &&
    state.eyeSaccade.returnAt > 0 &&
    now >= state.eyeSaccade.returnAt
  ) {
    state.eyeSaccade.targetX = 0
    state.eyeSaccade.targetY = 0
    state.eyeSaccade.returnAt = 0
    state.eyeSaccade.nextSweepAt = now + EYE_SACCADE_INTERVAL_MIN_MS + Math.random() * EYE_SACCADE_INTERVAL_VARIATION_MS
  }

  if (state.expression !== 'idle') {
    state.eyeSaccade.targetX = 0
    state.eyeSaccade.targetY = 0
    state.eyeSaccade.returnAt = 0
  }

  const saccadeX = springValue(
    state.eyeSaccade.offsetX,
    state.eyeSaccade.targetX,
    frameScale,
    EYE_SACCADE_SPEED,
    0.84
  )
  const saccadeY = springValue(
    state.eyeSaccade.offsetY,
    state.eyeSaccade.targetY,
    frameScale,
    EYE_SACCADE_SPEED,
    0.84
  )

  updateEye(
    elements.leftEye,
    state.eyeLeft,
    expression.left,
    blinkScale,
    faceOpacity,
    frameScale,
    saccadeX,
    saccadeY
  )
  updateEye(
    elements.rightEye,
    state.eyeRight,
    expression.right,
    blinkScale,
    faceOpacity,
    frameScale,
    saccadeX,
    saccadeY
  )

  const thoughtRadius = springValue(
    state.thoughtRadius,
    state.thoughtActive && state.shape !== 'mark' ? 19 : 0,
    frameScale,
    0.18,
    0.74
  )
  setAttributeIfChanged(elements.thoughtDot, 'r', Math.max(0, thoughtRadius).toFixed(2))

  const orbitOpacity = springValue(
    state.orbitOpacity,
    state.orbitActive ? 1 : 0,
    frameScale,
    0.1,
    0.82
  )
  if (elements.orbits) {
    elements.orbits.style.opacity = clamp(orbitOpacity, 0, 1).toFixed(3)
    if (orbitOpacity > 0.001) {
      elements.orbits.setAttribute('transform', `rotate(${((now / 29) % 360).toFixed(2)} 320 314)`)
    }
  }
  elements.orbitEllipses.forEach((ellipse, index) => {
    if (ellipse && orbitOpacity > 0.001) {
      ellipse.style.strokeDashoffset = String(
        -((now * (0.14 + index * 0.018) + index * 175) % 1190)
      )
    }
  })
  setAttributeIfChanged(elements.bot, 'transform', animationTransform(state, now))
}

/**
 * A settled spring re-formats to the very same string every frame, and handing
 * that value to `setAttribute` again costs an attribute change the renderer has
 * to invalidate for. Reading the stored value back — rather than remembering the
 * last write here — keeps React re-renders, remounts, and any other writer on the
 * element from ever being answered with a stale cache.
 */
export function setAttributeIfChanged(element: MotionPart | null, name: string, value: string): void {
  if (!element || element.getAttribute(name) === value) return
  element.setAttribute(name, value)
}

export function updateEye(
  element: MotionPart | null,
  animatedEye: AnimatedEye,
  source: BartLogoEye,
  blinkScale: number,
  faceOpacity: number,
  frameScale: number,
  saccadeX = 0,
  saccadeY = 0
): void {
  if (!element) return
  const values = {} as Record<keyof BartLogoEye, number>
  for (const key of Object.keys(source) as Array<keyof BartLogoEye>) {
    let target = source[key]
    if (key === 'h') target *= blinkScale
    if (key === 'opacity') target *= faceOpacity
    if (key === 'x') target += saccadeX
    if (key === 'y') target += saccadeY
    values[key] = springValue(animatedEye[key], target, frameScale, 0.12, 0.82)
  }
  const x = CENTER.x + values.x
  const y = CENTER.y + values.y
  const width = Math.max(0.2, values.w)
  const height = Math.max(0.2, values.h)
  const radius = Math.min(values.radius, width / 2, height / 2)
  setAttributeIfChanged(element, 'x', (x - width / 2).toFixed(2))
  setAttributeIfChanged(element, 'y', (y - height / 2).toFixed(2))
  setAttributeIfChanged(element, 'width', width.toFixed(2))
  setAttributeIfChanged(element, 'height', height.toFixed(2))
  setAttributeIfChanged(element, 'rx', Math.max(0, radius).toFixed(2))
  setAttributeIfChanged(element, 'opacity', clamp(values.opacity, 0, 1).toFixed(3))
  setAttributeIfChanged(
    element,
    'transform',
    `rotate(${values.rotation.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)})`
  )
}

export function animationTransform(state: BartMotionState, now: number): string {
  const bounceProgress = clamp((now - state.bounceStarted) / 1150, 0, 1)
  const nodProgress = clamp((now - state.nodStarted) / 1050, 0, 1)
  const bounceEnvelope = bounceProgress < 1 ? 1 - bounceProgress : 0
  const bounceWave = bounceProgress < 1 ? Math.abs(Math.sin(bounceProgress * Math.PI * 2.35)) : 0
  const bounceY = -72 * bounceWave * bounceEnvelope
  const bounceSquash = 0.08 * Math.sin(bounceProgress * Math.PI * 4.7) * bounceEnvelope
  const nodRotation =
    nodProgress < 1 ? Math.sin(nodProgress * Math.PI * 4) * 10 * (1 - nodProgress) : 0
  const idleFloat = state.restBetweenGestures ? 0 : Math.sin(now * 0.00135) * 4
  const idleRotation = state.restBetweenGestures ? 0 : Math.sin(now * 0.00092) * 1.1
  const orbitRotation = state.orbitActive ? (now / 20) % 360 : 0

  const rotation = nodRotation + idleRotation + orbitRotation
  const scaleX = 1 + bounceSquash
  const scaleY = 1 - bounceSquash
  const translateY = bounceY + idleFloat
  const pivot = state.layout === 'mark'
    ? CENTER
    : state.layout === 'permission' || state.layout === 'question'
      ? { x: 400, y: 300 }
      : { x: 405, y: 310 }
  return `translate(${pivot.x} ${pivot.y}) translate(0 ${translateY.toFixed(2)}) rotate(${rotation.toFixed(2)}) scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)}) translate(${-pivot.x} ${-pivot.y})`
}

export function buildShape(kind: BartLogoShape, layout: BartLogoLayout = 'mark'): Point[] {
  if (layout !== 'mark') return buildExpandedShape(kind, layout)
  const points: Point[] = []
  for (let index = 0; index < POINT_COUNT; index += 1) {
    const theta = -Math.PI / 2 + (index / POINT_COUNT) * Math.PI * 2
    let x: number
    let y: number
    if (kind === 'drop') {
      const vertical = Math.sin(theta)
      const width = 154 * (0.78 - vertical * 0.25)
      x = Math.cos(theta) * width
      y = vertical * 174
      if (vertical > 0.64) x *= 1 - (vertical - 0.64) * 2.35
      y -= 7
    } else if (kind === 'hex') {
      const radius = 155 * (1 + 0.065 * Math.cos(6 * theta))
      x = Math.cos(theta) * radius
      y = Math.sin(theta) * radius
    } else if (kind === 'triangle') {
      const radius = 160 * (1 + 0.18 * Math.cos(3 * (theta + Math.PI / 2)))
      x = Math.cos(theta) * radius * 1.04
      y = Math.sin(theta) * radius * 1.03 + 14
    } else if (kind === 'mark') {
      const cosine = Math.cos(theta)
      const sine = Math.sin(theta)
      const exponent = 0.54
      const rotated = rotatePoint(
        Math.sign(cosine) * Math.pow(Math.abs(cosine), exponent) * 34,
        Math.sign(sine) * Math.pow(Math.abs(sine), exponent) * 134 - 34,
        0.14
      )
      x = rotated.x
      y = rotated.y
    } else {
      x = Math.cos(theta) * 164
      y = Math.sin(theta) * 164
    }
    points.push({ x: CENTER.x + x, y: CENTER.y + y })
  }
  return points
}

export function buildExpandedShape(
  _kind: BartLogoShape,
  layout: Exclude<BartLogoLayout, 'mark'>
): Point[] {
  if (layout === 'permission') return buildPermissionShape()
  if (layout === 'question') return buildInteractionShape(375, 225)
  return MESSAGE_TRACE.map((point) => ({ ...point }))
}

export function buildPermissionShape(): Point[] {
  const center = { x: 400, y: 300 }
  const halfWidth = 368
  const halfHeight = 176
  const cornerRadius = 42
  return Array.from({ length: POINT_COUNT }, (_, index) => {
    const theta = -Math.PI / 2 + (index / POINT_COUNT) * Math.PI * 2
    const cosine = Math.cos(theta)
    const sine = Math.sin(theta)
    const horizontalSign = Math.abs(cosine) < 1e-8 ? 0 : Math.sign(cosine)
    const verticalSign = Math.abs(sine) < 1e-8 ? 0 : Math.sign(sine)
    return {
      x: center.x + horizontalSign * (halfWidth - cornerRadius) + cosine * cornerRadius,
      y: center.y + verticalSign * (halfHeight - cornerRadius) + sine * cornerRadius
    }
  })
}

export function buildInteractionShape(radiusX: number, radiusY: number): Point[] {
  const center = { x: 400, y: 300 }
  const exponent = 0.52
  return Array.from({ length: POINT_COUNT }, (_, index) => {
    const theta = -Math.PI / 2 + (index / POINT_COUNT) * Math.PI * 2
    const cosine = Math.cos(theta)
    const sine = Math.sin(theta)
    return {
      x: center.x + Math.sign(cosine) * Math.pow(Math.abs(cosine), exponent) * radiusX,
      y: center.y + Math.sign(sine) * Math.pow(Math.abs(sine), exponent) * radiusY
    }
  })
}

// Traced from the selected generated concept: message B.
export const MESSAGE_TRACE: readonly Point[] = [
  { x: 130.0, y: 258.8 },
  { x: 138.0, y: 218.0 },
  { x: 155.8, y: 180.6 },
  { x: 182.6, y: 149.3 },
  { x: 215.7, y: 128.5 },
  { x: 252.7, y: 117.2 },
  { x: 292.9, y: 116.1 },
  { x: 332.3, y: 121.7 },
  { x: 368.9, y: 133.9 },
  { x: 404.8, y: 147.9 },
  { x: 442.5, y: 157.4 },
  { x: 481.8, y: 162.9 },
  { x: 520.7, y: 169.6 },
  { x: 558.2, y: 179.8 },
  { x: 593.5, y: 195.1 },
  { x: 626.2, y: 216.6 },
  { x: 653.0, y: 248.0 },
  { x: 668.5, y: 286.4 },
  { x: 670.6, y: 327.9 },
  { x: 660.6, y: 367.9 },
  { x: 638.4, y: 402.5 },
  { x: 607.0, y: 427.2 },
  { x: 572.0, y: 443.3 },
  { x: 534.7, y: 453.8 },
  { x: 495.4, y: 459.4 },
  { x: 455.1, y: 462.8 },
  { x: 414.3, y: 465.0 },
  { x: 373.1, y: 463.9 },
  { x: 332.4, y: 461.7 },
  { x: 293.1, y: 456.1 },
  { x: 255.6, y: 446.1 },
  { x: 220.4, y: 430.4 },
  { x: 187.9, y: 408.1 },
  { x: 160.4, y: 377.3 },
  { x: 141.3, y: 340.6 },
  { x: 131.2, y: 300.4 }
]

export function eyesForLayout(
  expression: { left: BartLogoEye; right: BartLogoEye },
  layout: BartLogoLayout
): { left: BartLogoEye; right: BartLogoEye } {
  if (layout === 'mark') return expression
  const transform = layout === 'permission' || layout === 'question'
    ? interactionEye
    : messageEye
  return {
    left: transform(expression.left),
    right: transform(expression.right)
  }
}

export function messageEye(source: BartLogoEye): BartLogoEye {
  return {
    ...source,
    x: source.x * 0.713 - 47.5,
    y: source.y * 0.07 - 89.5,
    w: source.w * 0.683,
    h: source.h * 0.872,
    radius: source.radius * 0.683,
    rotation: source.rotation * 0.08
  }
}

export function interactionEye(source: BartLogoEye): BartLogoEye {
  return {
    ...source,
    x: source.x * 0.55 - 190,
    y: source.y * 0.05 - 108,
    w: source.w * 0.58,
    h: source.h * 0.56,
    radius: source.radius * 0.58,
    rotation: source.rotation * 0.06
  }
}

export function layoutSvgMessage(message: string, lineWidth = 22.3, lineCount = 3): string[] {
  const glyphs = Array.from(message.replace(/\s+/g, ' ').trim())
  const lines: string[] = []
  let cursor = 0

  while (cursor < glyphs.length && lines.length < lineCount) {
    while (glyphs[cursor] === ' ') cursor += 1
    const start = cursor
    let width = 0
    let lastSpace = -1
    let lastSpaceWidth = 0

    while (cursor < glyphs.length) {
      const glyph = glyphs[cursor]
      const nextWidth = width + svgGlyphWidth(glyph)
      if (nextWidth > lineWidth && cursor > start) break
      width = nextWidth
      if (glyph === ' ') {
        lastSpace = cursor
        lastSpaceWidth = width
      }
      cursor += 1
    }

    let end = cursor
    if (
      cursor < glyphs.length &&
      lastSpace > start &&
      lastSpaceWidth >= lineWidth * 0.65
    ) {
      end = lastSpace
      cursor = lastSpace + 1
    }
    lines.push(glyphs.slice(start, end).join('').trimEnd())
  }

  if (cursor < glyphs.length && lines.length) {
    const lastIndex = lines.length - 1
    let finalLine = lines[lastIndex].trimEnd()
    while (finalLine && svgTextWidth(`${finalLine}…`) > lineWidth) {
      finalLine = Array.from(finalLine).slice(0, -1).join('').trimEnd()
    }
    lines[lastIndex] = `${finalLine}…`
  }
  return lines.length ? lines : ['']
}

export function svgTextWidth(value: string): number {
  return Array.from(value).reduce((width, glyph) => width + svgGlyphWidth(glyph), 0)
}

export function svgGlyphWidth(glyph: string): number {
  if (/\s/u.test(glyph)) return 0.38
  if (/[\u2e80-\u9fff\uf900-\ufaff]/u.test(glyph)) return 1
  if (/[A-Z]/u.test(glyph)) return 0.62
  if (/[a-z0-9]/u.test(glyph)) return 0.52
  if (/[.,'"`·，。、“”‘’：；！？!?()[\]{}]/u.test(glyph)) return 0.42
  return 0.72
}

export function buildSatellite(visible: boolean): Point[] {
  return Array.from({ length: POINT_COUNT }, (_, index) => {
    const theta = -Math.PI / 2 + (index / POINT_COUNT) * Math.PI * 2
    const cosine = Math.cos(theta)
    const sine = Math.sin(theta)
    const rotated = rotatePoint(
      Math.sign(cosine) * Math.pow(Math.abs(cosine), 0.65) * (visible ? 23 : 1),
      Math.sign(sine) * Math.pow(Math.abs(sine), 0.65) * (visible ? 25 : 1),
      -0.2
    )
    return { x: CENTER.x + rotated.x + 21, y: CENTER.y + rotated.y + 176 }
  })
}

export function pointsToPath(points: ReadonlyArray<Point>, tension = 0.82): string {
  if (!points.length) return ''
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length]
    const current = points[index]
    const next = points[(index + 1) % points.length]
    const afterNext = points[(index + 2) % points.length]
    const controlOne = {
      x: current.x + ((next.x - previous.x) / 6) * tension,
      y: current.y + ((next.y - previous.y) / 6) * tension
    }
    const controlTwo = {
      x: next.x - ((afterNext.x - current.x) / 6) * tension,
      y: next.y - ((afterNext.y - current.y) / 6) * tension
    }
    path += ` C ${controlOne.x.toFixed(2)} ${controlOne.y.toFixed(2)}, ${controlTwo.x.toFixed(2)} ${controlTwo.y.toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`
  }
  return `${path} Z`
}

export function makeAnimatedPoints(points: ReadonlyArray<Point>): AnimatedPoint[] {
  return points.map((point) => ({ ...point, vx: 0, vy: 0 }))
}

export function createAnimatedValue(value: number): AnimatedValue {
  return { value, velocity: 0 }
}

export function createEye(source: BartLogoEye): AnimatedEye {
  return {
    x: createAnimatedValue(source.x),
    y: createAnimatedValue(source.y),
    w: createAnimatedValue(source.w),
    h: createAnimatedValue(source.h),
    radius: createAnimatedValue(source.radius),
    rotation: createAnimatedValue(source.rotation),
    opacity: createAnimatedValue(source.opacity)
  }
}

export function springValue(
  animated: AnimatedValue,
  target: number,
  frameScale: number,
  stiffness: number,
  damping: number
): number {
  animated.velocity +=
    (target - animated.value) * stiffness * frameScale
  animated.velocity *= Math.pow(damping, frameScale)
  animated.value += animated.velocity * frameScale
  return animated.value
}

// A settled silhouette does not need 36 Bezier segments rebuilt on every frame.
export const renderedPaths = new WeakMap<MotionPart, { points: AnimatedPoint[]; smoothing: number }>()

export function renderSpringPath(
  element: MotionPart | null,
  points: AnimatedPoint[],
  targets: Point[],
  frameScale: number,
  smoothing: number
): void {
  const changed = springPoints(points, targets, frameScale)
  if (!element) return
  const previous = renderedPaths.get(element)
  if (!changed && previous?.points === points && previous.smoothing === smoothing) return
  element.setAttribute('d', pointsToPath(points, smoothing))
  renderedPaths.set(element, { points, smoothing })
}

export function springPoints(points: AnimatedPoint[], targets: Point[], frameScale: number): boolean {
  let changed = false
  const damping = Math.pow(0.82, frameScale)
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    const target = targets[index]
    const previousX = point.x
    const previousY = point.y
    if (Math.abs(target.x - point.x) < 0.001 && Math.abs(target.y - point.y) < 0.001 &&
      Math.abs(point.vx) < 0.001 && Math.abs(point.vy) < 0.001) {
      // Below the path's two-decimal precision: settle exactly and stop work.
      point.x = target.x
      point.y = target.y
      point.vx = 0
      point.vy = 0
      changed ||= point.x !== previousX || point.y !== previousY
      continue
    }
    point.vx += (target.x - point.x) * 0.12 * frameScale
    point.vy += (target.y - point.y) * 0.12 * frameScale
    point.vx *= damping
    point.vy *= damping
    point.x += point.vx * frameScale
    point.y += point.vy * frameScale
    changed ||= point.x !== previousX || point.y !== previousY
  }
  return changed
}

export function eyeAttributes(target: BartLogoEye): {
  x: number
  y: number
  width: number
  height: number
  rx: number
  opacity: number
  transform: string
} {
  const x = CENTER.x + target.x
  const y = CENTER.y + target.y
  return {
    x: x - target.w / 2,
    y: y - target.h / 2,
    width: target.w,
    height: target.h,
    rx: target.radius,
    opacity: target.opacity,
    transform: `rotate(${target.rotation} ${x} ${y})`
  }
}

export function rotatePoint(x: number, y: number, angle: number): Point {
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return { x: x * cosine - y * sine, y: x * sine + y * cosine }
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export interface MotionPart {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  style: { opacity: string; strokeDashoffset: string }
}
