import { createMotionState, seatDescriptor, interactionDescriptor, renderMotionFrame, applyDescriptor,
  snapMotionToTargets, poseOf, BODY_COLOR, EYE_COLOR, type BartElements, type MotionPart } from './character-model'
import type { CharacterDescription } from './worker-types'
import { paintInterventionTokens, transformInterventionBody } from './intervention-canvas'
import { paintTravelTrail } from './travel-trail'
import { RUNNING_BEAT_MS, RUNNING_DOT_RADIUS, sampleRunningStory } from './running-story'

interface CharacterSeed {
  state: ReturnType<typeof createMotionState>
  changedAt: number
  interventionAt: number
  eyeMotionAt: number
  travelTrailAt: number
  runningElapsed: number
  runningPaintAt: number
}
export interface CanvasCharacter {
  capture(): ReturnType<typeof poseOf>
  /** Worker-local continuity; no DOM pose capture or cross-thread clock copy. */
  fork(): CanvasCharacter
  description(): CharacterDescription
  update(value: CharacterDescription): void
  nextWake(now: number): number
  paint(ctx: OffscreenCanvasRenderingContext2D, now: number, width: number, height: number): void
}

class CanvasPart implements MotionPart {
  attributes = new Map<string, string>()
  style = { opacity: '1', strokeDashoffset: '0' }
  path: Path2D | undefined
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
    if (name === 'd') this.path = new Path2D(value)
  }
  number(name: string, fallback = 0): number { return Number(this.attributes.get(name) ?? fallback) }
}

function transform(ctx: OffscreenCanvasRenderingContext2D, value: string | null): void {
  if (!value) return
  for (const command of value.matchAll(/(translate|scale|rotate)\(([^)]+)\)/g)) {
    const values = command[2].trim().split(/[ ,]+/).map(Number)
    if (command[1] === 'translate') ctx.translate(values[0], values[1] ?? 0)
    if (command[1] === 'scale') ctx.scale(values[0], values[1] ?? values[0])
    if (command[1] === 'rotate') {
      ctx.translate(values[1] ?? 0, values[2] ?? 0)
      ctx.rotate(values[0] * Math.PI / 180)
      ctx.translate(-(values[1] ?? 0), -(values[2] ?? 0))
    }
  }
}

const descriptorFor = (value: CharacterDescription) => value.layout === 'permission' || value.layout === 'question'
  ? interactionDescriptor(value.layout) : seatDescriptor(value.activity, value.phase, value.intervention)
const keyOf = (value: CharacterDescription): string => value.key ?? `${value.activity}:${value.phase}`

/** Everything `descriptorFor` and `applyDescriptor` read. A change here is a new
 * semantic state — a change to the eye track is not. */
function samePose(left: CharacterDescription, right: CharacterDescription): boolean {
  return left.key === right.key && left.activity === right.activity && left.phase === right.phase
    && left.layout === right.layout && left.intervention === right.intervention
    && left.animate === right.animate && left.role === right.role
}

/** Draws the production 36-point silhouette, spring eyes, gestures and orbit. */
export function createCanvasCharacter(initial: CharacterDescription, seed?: CharacterSeed): CanvasCharacter {
  let description = initial
  let state = seed?.state ?? createMotionState(keyOf(initial), descriptorFor(initial), initial.layout ?? 'mark')
  state.restBetweenGestures = true
  let changedAt = seed?.changedAt ?? performance.now()
  let interventionAt = seed?.interventionAt ?? changedAt
  let eyeMotionAt = seed?.eyeMotionAt ?? changedAt
  let travelTrailAt = seed?.travelTrailAt ?? changedAt
  let runningElapsed = seed?.runningElapsed ?? 0
  let runningPaintAt = seed?.runningPaintAt ?? changedAt
  const running = (): boolean => description.role === 'running' && description.phase === 'running'
    && (description.layout ?? 'mark') === 'mark' && !description.intervention
  const parts = { body: new CanvasPart(), satellite: new CanvasPart(), leftEye: new CanvasPart(),
    rightEye: new CanvasPart(), thoughtDot: new CanvasPart(), bot: new CanvasPart(),
    orbits: new CanvasPart(), orbitEllipses: Array.from({ length: 5 }, () => new CanvasPart()) } satisfies BartElements
  return {
    capture: () => poseOf(state),
    fork: () => createCanvasCharacter(description, { state: structuredClone(state), changedAt, interventionAt, eyeMotionAt, travelTrailAt, runningElapsed, runningPaintAt }),
    description: () => description,
    update(value: CharacterDescription): void {
      if (description.eyeMotion?.key !== value.eyeMotion?.key) eyeMotionAt = performance.now()
      if (description.travelTrail?.key !== value.travelTrail?.key) travelTrailAt = performance.now()
      if (description.intervention !== value.intervention || description.key !== value.key) interventionAt = performance.now()
      // An eye-track update is not a new semantic state: restamping the clock
      // would re-arm nextWake's follow window and repaint at frame rate for it.
      const poseUnchanged = samePose(description, value)
      // Suspension changes paint cadence, not the identity of this light story.
      const sameRunningStory = running() && samePose({ ...description, animate: value.animate }, value)
      description = value
      if (poseUnchanged) return
      changedAt = performance.now()
      if (!sameRunningStory) runningElapsed = 0
      runningPaintAt = changedAt
      if (value.animate === false) {
        state = createMotionState(keyOf(value), descriptorFor(value), value.layout ?? 'mark')
        state.restBetweenGestures = true
      }
      applyDescriptor(state, keyOf(value), descriptorFor(value), value.layout ?? 'mark', changedAt)
    },
    nextWake(now: number): number {
      if (description.animate === false) return Infinity
      if (running()) return now
      if ((description.layout ?? 'mark') === 'mark' && description.intervention === 'processing') return now
      if (description.eyeMotion && now - eyeMotionAt < description.eyeMotion.duration) return now
      if (description.travelTrail && now - travelTrailAt < description.travelTrail.duration) return now
      if (state.orbitActive || now - changedAt < 1800 || now - state.blinkStarted < 1400 ||
        now - state.bounceStarted < 1200 || now - state.nodStarted < 1100 || state.eyeSaccade.returnAt > 0) return now
      const eyeMotion = [...Object.values(state.eyeLeft), ...Object.values(state.eyeRight), state.eyeSaccade.offsetX, state.eyeSaccade.offsetY]
      if (eyeMotion.some(value => Math.abs(value.velocity) > .005) ||
        state.bodyPoints.some(point => Math.abs(point.vx) + Math.abs(point.vy) > .002)) return now
      return Math.min(state.shape === 'mark' ? Infinity : state.nextNaturalBlink,
        state.expression === 'idle' ? state.eyeSaccade.nextSweepAt : Infinity)
    },
    paint(ctx: OffscreenCanvasRenderingContext2D, now: number, width: number, height: number): void {
      if (description.animate === false) snapMotionToTargets(state)
      // Resize and density redraws must not advance a suspended face's natural
      // blink, gaze or gesture clocks. Repaint the same model instant instead.
      renderMotionFrame(state, parts, description.animate === false ? state.lastFrameAt : now)
      // A suspended/hidden surface resumes without skipping the light story.
      if (running() && description.animate !== false) runningElapsed += Math.max(0, Math.min(64, now - runningPaintAt))
      runningPaintAt = now
      const story = running() ? sampleRunningStory(runningElapsed / RUNNING_BEAT_MS, description.animate === false) : undefined
      ctx.save()
      const view = state.layout === 'permission' ? [20, 110, 760, 380] : state.layout === 'question' ? [20, 50, 760, 500]
        : state.layout !== 'mark' ? [20, 100, 780, 400] : [0, 0, 640, 640]
      const scale = Math.min(width / view[2], height / view[3])
      ctx.translate((width - scale * view[2]) / 2, (height - scale * view[3]) / 2)
      ctx.scale(scale, scale)
      ctx.translate(-view[0], -view[1])
      ctx.save()
      ctx.globalAlpha *= Number(parts.orbits.style.opacity)
      transform(ctx, parts.orbits.getAttribute('transform'))
      ctx.lineWidth = 10
      ctx.lineCap = 'round'
      ctx.setLineDash([190, 1000])
      for (let index = 0; index < parts.orbitEllipses.length; index++) {
        ctx.save()
        ctx.translate(320, 314)
        ctx.rotate([8, 54, 102, 146, 194][index] * Math.PI / 180)
        ctx.strokeStyle = ['#ee787e', '#69cdb6', '#74aef5', '#bd7ce4', '#d9c957'][index]
        ctx.lineDashOffset = Number(parts.orbitEllipses[index].style.strokeDashoffset)
        ctx.beginPath(); ctx.ellipse(0, 0, 224, 88, 0, 0, Math.PI * 2); ctx.stroke()
        ctx.restore()
      }
      ctx.restore()
      if (state.layout === 'mark') {
        const elapsed = description.animate === false ? (description.intervention === 'processing' ? 0 : 2000) : now - interventionAt
        paintInterventionTokens(ctx, description.intervention, elapsed)
        if (description.animate !== false) transformInterventionBody(ctx, description.intervention, elapsed)
      }
      transform(ctx, parts.bot.getAttribute('transform'))
      if (description.animate !== false && description.travelTrail && state.layout === 'mark') {
        paintTravelTrail(ctx, description.travelTrail, now - travelTrailAt)
      }
      ctx.fillStyle = BODY_COLOR
      ctx.shadowColor = state.layout === 'mark' ? 'rgba(32,35,44,0.18)' : 'transparent'
      const shadowScale = Math.hypot(ctx.getTransform().a, ctx.getTransform().b)
      ctx.shadowBlur = 22 * shadowScale
      ctx.shadowOffsetY = 28 * shadowScale
      if (parts.body.path) ctx.fill(parts.body.path)
      ctx.save(); ctx.globalAlpha *= parts.satellite.number('opacity')
      if (parts.satellite.path) ctx.fill(parts.satellite.path)
      ctx.restore()
      ctx.shadowColor = 'transparent'
      ctx.fillStyle = EYE_COLOR
      ctx.save()
      if (story) {
        ctx.translate(story.eyes.x, story.eyes.y)
        ctx.translate(320, 250); ctx.scale(story.eyes.scaleX, story.eyes.scaleY); ctx.translate(-320, -250)
      } else if (description.animate !== false && description.eyeMotion?.points.length) {
        const points = description.eyeMotion.points, elapsed = now - eyeMotionAt
        let index = 0
        while (index + 1 < points.length && points[index + 1].at <= elapsed) index++
        const from = points[index], to = points[index + 1] ?? from
        const p = from === to ? 0 : Math.max(0, Math.min(1, (elapsed - from.at) / (to.at - from.at)))
        const eased = p * p * (3 - 2 * p)
        ctx.translate(from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased)
        if (from.scaleX !== undefined || to.scaleX !== undefined || from.scaleY !== undefined || to.scaleY !== undefined) {
          const sx = (from.scaleX ?? 1) + ((to.scaleX ?? 1) - (from.scaleX ?? 1)) * eased
          const sy = (from.scaleY ?? 1) + ((to.scaleY ?? 1) - (from.scaleY ?? 1)) * eased
          // Compensate body stretch around the face, retaining the eye shapes.
          ctx.translate(320, 250); ctx.scale(sx, sy); ctx.translate(-320, -250)
        }
      }
      if (description.role === 'tool') {
        ctx.translate(22, 28); ctx.translate(320, 240); ctx.scale(1, .62); ctx.translate(-320, -240)
      }
      for (const eye of description.role === 'reasoning' ? [] : [parts.leftEye, parts.rightEye]) {
        ctx.save(); ctx.globalAlpha *= eye.number('opacity', 1)
        if (description.role !== 'tool') transform(ctx, eye.getAttribute('transform'))
        ctx.beginPath(); ctx.roundRect(eye.number('x'), eye.number('y'), eye.number('width'), eye.number('height'), eye.number('rx'))
        ctx.fill(); ctx.restore()
      }
      if (description.role === 'reasoning') {
        // The attentive role uses the production locked eye geometry, on the
        // same Worker blink clock as the character it dresses.
        const blinkAt = (now - state.blinkStarted) / 320
        const blink = description.animate === false || blinkAt < 0 || blinkAt > 1 ? 1 : 1 - Math.sin(blinkAt * Math.PI) * .91
        ctx.save(); ctx.translate(320, 320); ctx.rotate(-4 * Math.PI / 180); ctx.translate(-320, -320)
        ctx.translate(-8, -21); ctx.translate(320, 282); ctx.scale(1, blink); ctx.translate(-320, -282)
        for (const [x, y] of [[270, 249], [342, 246]]) {
          ctx.save(); ctx.translate(x + 13.5, y + 31.5); ctx.rotate(-7 * Math.PI / 180)
          ctx.beginPath(); ctx.roundRect(-14.85, -34.65, 29.7, 69.3, 14.85); ctx.fill(); ctx.restore()
        }
        ctx.restore()
      }
      ctx.restore()
      for (const dot of story?.dots ?? []) {
        ctx.save(); ctx.globalAlpha *= dot.opacity; ctx.fillStyle = dot.color
        ctx.beginPath(); ctx.arc(dot.x, dot.y, RUNNING_DOT_RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.restore()
      }
      ctx.beginPath(); ctx.arc(477, 178, Math.max(0, parts.thoughtDot.number('r')), 0, Math.PI * 2)
      ctx.fillStyle = description.role === 'tool' ? '#34c759' : '#249cff'; ctx.fill()
      if (parts.thoughtDot.number('r') > 0.1) { ctx.strokeStyle = EYE_COLOR; ctx.lineWidth = 8; ctx.stroke() }
      ctx.restore()
    }
  }
}
