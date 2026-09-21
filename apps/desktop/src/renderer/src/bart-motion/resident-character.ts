import type { BartDockRole } from '../bart-role'
import { BART_REASONING_DEFAULTS, type BartReasoningOptions } from './reasoning-geometry'
import { paintResident, type ResidentContent } from './resident-painter'
import { ResidentTransition } from './resident-transition'
import { ResidentText } from './resident-text'
import { type Pose, type Role } from './resident-pose'
import { createMotionState, seatDescriptor, poseOf, rotatePoint, type BartLogoPose } from './character-model'

export interface ResidentDescription {
  /** A new conversation must never inherit the previous conversation's text. */
  scope: string
  role: BartDockRole
  reply: boolean
  options?: BartReasoningOptions
  reducedMotion?: boolean
}
const body = poseOf(createMotionState('resident-body', seatDescriptor('idle', 'idle'), 'mark')).body
const roleOf = (value: ResidentDescription): Role => value.role.kind === 'idle' && value.reply ? 'reply' : value.role.kind
const TEXT_FONT = '10px -apple-system, BlinkMacSystemFont, sans-serif'

/** One logical clock owns face, stream and widgets. Visibility pauses that
 * clock; semantic changes redirect the current pose without an animation queue. */
export class ResidentCharacter {
  private transition = new ResidentTransition()
  private text = new ResidentText()
  private content: ResidentContent = { glyphs: [], toolName: '', center: -110, span: 288 }
  private clock = 0
  private lastWall: number
  private nextBlink = 3400
  private blinkAt = -Infinity
  private value: ResidentDescription
  private pose: Pose
  private launch = false
  constructor(value: ResidentDescription, now: number) {
    this.value = value; this.lastWall = now
    this.transition.settle(roleOf(value), 0)
    this.pose = this.transition.sample(0)
  }
  clone(): ResidentCharacter {
    const result = Object.assign(new ResidentCharacter(this.value, this.lastWall), structuredClone({ ...this }))
    result.transition = this.transition.clone(); result.text = this.text.clone()
    return result
  }
  update(value: ResidentDescription, now: number, active: boolean): void {
    // Updating a suspended surface is not elapsed animation time.
    if (!active) this.lastWall = now
    if (value.scope !== this.value.scope) {
      this.text = new ResidentText(); this.content = { glyphs: [], toolName: '', center: -110, span: 288 }
      this.transition.settle(roleOf(value), this.clock)
    }
    const role = roleOf(value)
    if (value.reducedMotion) this.transition.settle(role, this.clock)
    else if (role !== this.transition.role) this.transition.redirect(role, this.clock, 550)
    this.value = value
  }
  launchFrame(now: number, elapsed: number, finished: boolean): void {
    if (!finished) { this.lastWall = now; this.launch = true; return }
    if (this.launch) { this.lastWall = now; this.transition.settle('running', this.clock, elapsed); this.launch = false }
  }
  nextWake(now: number): number {
    if (this.value.reducedMotion) return Infinity
    if (this.transition.progress(this.clock) < 1 || this.transition.role === 'running' || this.transition.role === 'reasoning' || this.clock - this.blinkAt < 320) return now
    return now + Math.max(0, this.nextBlink - this.clock)
  }
  capture(base: BartLogoPose): BartLogoPose {
    const p = this.pose
    const point = (x: number, y: number) => {
      const turned = rotatePoint((x - 320) * p.sx, (y - 300) * p.sy, p.angle * Math.PI / 180)
      return { x: turned.x + 320 + p.x, y: turned.y + 300 + p.y }
    }
    const eye = (side: 'l' | 'r') => {
      const center = point(p[`${side}x`], p[`${side}y`])
      return { x: center.x - 320, y: center.y - 300, w: p[`${side}w`] * p.sx,
        h: p[`${side}h`] * p.sy * p.lid, radius: Math.min(p[`${side}w`], p[`${side}h`]) / 2, opacity: 1, rotation: p[`${side}a`] + p.angle }
    }
    return { ...base, blinkStarted: this.lastWall + this.blinkAt - this.clock, nextNaturalBlink: this.lastWall + this.nextBlink - this.clock,
      gaze: { ...base.gaze, x: 0, y: 0, targetX: 0, targetY: 0, returnAt: 0 }, shape: 'circle', orbit: false, orbitOpacity: 0, satelliteOpacity: 0,
      body: body.map(({ x, y }) => point(x, y)), thoughtRadius: p.dotRadius * p.dotAlpha,
      eyes: [eye('l'), eye('r')] }
  }
  paint(ctx: OffscreenCanvasRenderingContext2D, now: number, active: boolean): void {
    const quiet = this.transition.progress(this.clock) === 1 && (this.transition.role === 'idle' || this.transition.role === 'tool' || this.transition.role === 'reply')
    const dt = active && !this.value.reducedMotion ? Math.max(0, Math.min(quiet ? 4200 : 64, now - this.lastWall)) : 0
    this.lastWall = now; this.clock += dt
    const options = this.value.options ?? BART_REASONING_DEFAULTS
    if (this.value.role.kind === 'reasoning') {
      ctx.save(); ctx.font = TEXT_FONT
      const measure = (text: string): number => ctx.measureText(text).width
      const span = 144 * options.length / 100, center = -90 + options.tilt
      this.text.update(this.value.role, this.value.reducedMotion ? 'direct' : options.stream, span * Math.PI / 180 * 90, this.clock, measure)
      this.text.advance(dt, this.clock, measure)
      this.content = { ...this.content, glyphs: this.text.visible(this.clock), span, center }
      this.transition.setArc(span, center)
      // Changes in stream length affect the next reading phrase, never tear
      // the gaze out of its current phrase midway through a word.
      this.transition.setReading(this.text.span(), center, options.gaze, this.clock)
      ctx.restore()
    } else if (this.value.role.kind === 'tool') this.content.toolName = this.value.role.toolName
    if (this.clock >= this.nextBlink) {
      this.blinkAt = this.clock
      this.nextBlink = this.clock + (this.value.role.kind === 'reasoning' ? 2200 : 4200)
    }
    const time = this.value.reducedMotion ? this.transition.enteredAt : this.clock
    this.pose = this.transition.sample(time)
    const progress = (this.clock - this.blinkAt) / 320
    const blink = this.value.reducedMotion || progress < 0 || progress > 1 ? 1 : 1 - Math.sin(progress * Math.PI) * .91
    paintResident(ctx, this.pose, this.content, blink)
    if (this.pose.arcAlpha < .001 && this.value.role.kind !== 'reasoning') {
      this.content.glyphs = []; this.text = new ResidentText()
    }
    if (this.pose.toolAlpha < .001 && this.value.role.kind !== 'tool') this.content.toolName = ''
  }
}
