import { memo, useEffect, useId, useRef } from 'react'
import type { BartVisualOperation } from '../bart-visual-operation'
import {
  primaryOperation, motionKeyFor, interactionDescriptor, seatDescriptor, createMotionState,
  eyeTargetOf, layoutSvgMessage, applyDescriptor, snapMotionToTargets, renderMotionFrame,
  pointsToPath, eyeAttributes, BODY_COLOR, EYE_COLOR,
  type BartLogoActivity, type BartLogoPhase, type BartLogoLayout, type BartInterventionVisualState,
  type BartLogoEye, type BartMotionState, type BartElements
} from '../bart-motion/character-model'
export type { BartLogoActivity, BartLogoPhase, BartLogoLayout, BartInterventionVisualState,
  BartLogoPose, BartLogoEye, BartLogoExpression, BartLogoShape } from '../bart-motion/character-model'
import './BartLogo.css'
import { CharacterCanvas } from '../bart-motion/CharacterCanvas'
import { RUNNING_DOT_RADIUS, sampleRunningStory } from '../bart-motion/running-story'
const STILL_RUNNING_DOTS = sampleRunningStory(0, true).dots

interface BartLogoProps {
  size?: number
  width?: number
  height?: number
  className?: string
  operation?: BartVisualOperation
  operations?: readonly BartVisualOperation[]
  running?: boolean
  /**
   * Body ownership already resolved by the Dock, which alone sees both the Core
   * route and the harness foreground. Direct mounters — the Lab and the
   * Overview — leave these out and derive from their own operations. Kept as
   * two primitives so `memo` keeps holding.
   */
  resolvedActivity?: BartLogoActivity
  resolvedPhase?: BartLogoPhase
  message?: string
  messagePulse?: 'a' | 'b'
  layout?: BartLogoLayout
  interventionState?: BartInterventionVisualState
  interventionKey?: string
  /** Semantic state identity, shared with the resident Worker character. */
  resolvedKey?: string
  /** Role appearance; spatial transforms belong to the containing scene. */
  roleKind?: string
  /** Covered resident surfaces retain their static appearance without repainting. */
  motionActive?: boolean
}

/** Bart's character. Bart Lab mounts this production implementation directly. */
export const BartLogo = memo(function BartLogo({
  size = 14,
  width,
  height,
  className = '',
  operation,
  operations,
  running = false,
  resolvedActivity,
  resolvedPhase,
  message,
  messagePulse,
  layout = typeof message === 'string' ? 'message' : 'mark',
  interventionState,
  interventionKey,
  resolvedKey,
  roleKind,
  motionActive = true
}: BartLogoProps): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null)
  const bodyRef = useRef<SVGPathElement>(null)
  const satelliteRef = useRef<SVGPathElement>(null)
  const leftEyeRef = useRef<SVGRectElement>(null)
  const rightEyeRef = useRef<SVGRectElement>(null)
  const thoughtDotRef = useRef<SVGCircleElement>(null)
  const botRef = useRef<SVGGElement>(null)
  const orbitsRef = useRef<SVGGElement>(null)
  const orbitEllipseRefs = useRef<Array<SVGEllipseElement | null>>([])
  // A resolved activity says which activity to draw, not which run is drawing it:
  // it must not also hide the operation that carries the run's identity. A seat
  // given both — the Dock is one — still draws the activity it was handed and goes
  // on naming the run it is drawing, which is what makes two runs of one activity
  // two states rather than one.
  const visibleOperation = operation || primaryOperation(operations)
  const activity: BartLogoActivity =
    resolvedActivity ?? visibleOperation?.kind ?? (running ? 'thinking' : 'idle')
  const phase: BartLogoPhase =
    resolvedPhase ?? visibleOperation?.phase ?? (running ? 'running' : 'idle')
  const expanded = layout !== 'mark'
  const renderWidth = width ?? size
  const renderHeight = height ?? size
  const motionKey = resolvedKey ?? motionKeyFor(
    layout,
    visibleOperation?.id || activity,
    phase,
    interventionKey || interventionState || ''
  )
  const descriptor = layout === 'permission' || layout === 'question'
    ? interactionDescriptor(layout)
    : seatDescriptor(activity, phase, interventionState)
  const motionRef = useRef<BartMotionState | null>(null)
  motionRef.current ||= createMotionState(motionKey, descriptor, layout)
  const motion = motionRef.current
  const shouldAnimate = motionActive && (Math.max(renderWidth, renderHeight) >= 24 || phase === 'running')
  const filterToken = `bart-${useId().replace(/:/g, '')}`
  const softShadowId = `${filterToken}-shadow`
  const trailGlowId = `${filterToken}-trail`
  // Static SVG fallback and layout geometry. All moving pixels belong to the
  // associated Worker canvas, including state transferred between seats.
  const openingRef = useRef<{
    eyes: { left: BartLogoEye; right: BartLogoEye }
    satelliteOpacity: number
    orbitOpacity: number
    thoughtRadius: number
  } | null>(null)
  openingRef.current ||= {
    eyes: { left: eyeTargetOf(motion.eyeLeft), right: eyeTargetOf(motion.eyeRight) },
    satelliteOpacity: motion.satelliteOpacity.value,
    orbitOpacity: motion.orbitOpacity.value,
    thoughtRadius: motion.thoughtRadius.value
  }
  const opening = openingRef.current
  const messageLines = layout === 'message' ? layoutSvgMessage(message || '', 15.5, 4) : []

  const elements = (): BartElements => ({
    body: bodyRef.current,
    satellite: satelliteRef.current,
    leftEye: leftEyeRef.current,
    rightEye: rightEyeRef.current,
    thoughtDot: thoughtDotRef.current,
    bot: botRef.current,
    orbits: orbitsRef.current,
    orbitEllipses: orbitEllipseRefs.current
  })

  useEffect(() => {
    applyDescriptor(motion, motionKey, descriptor, layout, performance.now())
    snapMotionToTargets(motion)
    renderMotionFrame(motion, elements(), performance.now())
  }, [descriptor, layout, motion, motionKey, shouldAnimate])

  return (
    <svg
      ref={svgRef}
      className={`bart-logo ${className}`.trim()}
      width={renderWidth}
      height={renderHeight}
      viewBox={
        layout === 'permission'
          ? '20 110 760 380'
          : layout === 'question'
            ? '20 50 760 500'
            : expanded
              ? '20 100 780 400'
              : '0 0 640 640'
      }
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-activity={activity}
      data-phase={phase}
      data-ambient={Math.max(renderWidth, renderHeight) >= 16 ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
      data-layout={layout}
      data-message-pulse={messagePulse}
      data-intervention-state={interventionState}
      data-motion-key={motionKey}
      data-role={roleKind}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <filter id={softShadowId} x="-35%" y="-35%" width="170%" height="190%">
          <feDropShadow
            dx="0"
            dy="28"
            stdDeviation="22"
            floodColor="#20232c"
            floodOpacity="0.18"
          />
        </filter>
        <filter id={trailGlowId} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="1.8" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g
        ref={orbitsRef}
        className="bart-orbits"
        style={{ opacity: opening.orbitOpacity.toFixed(3) }}
        filter={`url(#${trailGlowId})`}
      >
        {Array.from({ length: 5 }, (_, index) => (
          <ellipse
            key={index}
            ref={(element) => {
              orbitEllipseRefs.current[index] = element
            }}
            cx="320"
            cy="314"
            rx="224"
            ry="88"
          />
        ))}
      </g>

      <g className="bart-intervention-transit" aria-hidden="true">
        <g className="bart-intervention-request-token">
          <rect x="106" y="276" width="72" height="52" rx="15" />
          <path d="M124 302H157M147 291L159 302L147 313" />
        </g>
        <g className="bart-intervention-answer-token">
          <path d="M466 274H532C544 274 554 284 554 296V319C554 331 544 341 532 341H502L486 354L489 341H466C454 341 444 331 444 319V296C444 284 454 274 466 274Z" />
          <path d="M468 296H530M468 310H518M468 324H506" />
        </g>
      </g>

      {roleKind === 'running' && phase === 'running' && layout === 'mark' && !interventionState ? (
        <g className="bart-running-fallback">
          {STILL_RUNNING_DOTS.map((dot, index) => <circle key={index} cx={dot.x} cy={dot.y}
            r={RUNNING_DOT_RADIUS} fill={dot.color} opacity={dot.opacity} />)}
        </g>
      ) : null}
      <g className="bart-body-motion">
        <CharacterCanvas width={renderWidth} height={renderHeight} description={{
          activity, phase, key: motionKey, layout, intervention: interventionState, role: roleKind, animate: shouldAnimate
        }} />
        <g
          ref={botRef}
          className="bart-bot"
          filter={`url(#${softShadowId})`}
        >
          <path
            ref={bodyRef}
            d={pointsToPath(motion.bodyPoints, layout === 'permission' ? 0 : expanded ? 1 : 0.82)}
            fill={BODY_COLOR}
          />
          <path
            ref={satelliteRef}
            d={pointsToPath(motion.satellitePoints, 0.72)}
            fill={BODY_COLOR}
            opacity={opening.satelliteOpacity.toFixed(3)}
          />
          {layout === 'message' ? (
            <foreignObject x="265" y="275" width="515" height="126">
              <div className="bart-message">
                {messageLines.map((line, index) => <div key={`${index}:${line}`} className="bart-message-text">{line}</div>)}
              </div>
            </foreignObject>
          ) : null}
          {/* The face has a frame of its own so the page can put something on it
              that is not the expression: the role dressing does, and so does the
              coordinator's idle gaze. The expression keeps the face proper, and
              the two can then meet without either overwriting the other. Inert
              for a seat, which is only ever given one of them. */}
          <g className="bart-face-frame">
            <g className="bart-face">
              <rect
                ref={leftEyeRef}
                {...eyeAttributes(opening.eyes.left)}
                fill={EYE_COLOR}
              />
              <rect
                ref={rightEyeRef}
                {...eyeAttributes(opening.eyes.right)}
                fill={EYE_COLOR}
              />
            </g>
          </g>
          <circle
            ref={thoughtDotRef}
            className="bart-status-dot"
            cx="477"
            cy="178"
            r={opening.thoughtRadius.toFixed(2)}
            fill="#249cff"
            stroke={EYE_COLOR}
            strokeWidth="8"
          />
        </g>
      </g>
    </svg>
  )
})
