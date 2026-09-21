import { fitEyes, targetPose, type Pose, type Role, readingTrack } from './resident-pose'

type Channel = keyof Pose
const keys = Object.keys(targetPose('idle', 0, 0)) as Channel[]
const mix = (a: number, b: number, t: number): number => a + (b - a) * t
const smooth = (t: number): number => { const p = Math.min(1, Math.max(0, t)); return p * p * (3 - 2 * p) }
const phase = (p: number, from: number, to: number): number => smooth((p - from) / (to - from))
const pulse = (p: number, from: number, peak: number, to: number): number => phase(p, from, peak) * (1 - phase(p, peak, to))
const map = (fn: (key: Channel) => number): Pose => Object.fromEntries(keys.map(key => [key, fn(key)])) as Pose
type Point = { x: number; y: number }
const circle = (from: Point, to: Point, amount: number): Point => {
  const start = Math.atan2(from.y - 300, from.x - 320), end = Math.atan2(to.y - 300, to.x - 320)
  // Stay on the outer orbit: a chord would cut through Bart's face.
  const turn = Math.atan2(Math.sin(end - start), Math.cos(end - start))
  const angle = start + turn * amount
  const radius = mix(Math.hypot(from.x - 320, from.y - 300), Math.hypot(to.x - 320, to.y - 300), amount)
  return { x: 320 + Math.cos(angle) * radius, y: 300 + Math.sin(angle) * radius }
}

/** A short gaze cue precedes the widget handoff; the body follows and settles.
 * All channels remain values in one persistent pose, even half-unfolded text.
 * Redirects inherit that displayed pose and its velocity, not a role endpoint. */
export class ResidentTransition {
  role: Role = 'idle'
  enteredAt = 0
  private start = 0
  private duration = 0
  private from = targetPose('idle', 0, 0)
  private velocity = map(() => 0)

  private reading = readingTrack()
  private readingAt = 0
  private readingPrepared = false
  private arc = { span: 192, center: -110 }
  setArc(span: number, center: number): void { this.arc = { span, center } }

  clone(): ResidentTransition {
    return Object.assign(new ResidentTransition(), structuredClone({ ...this }))
  }
  setReading(span: number, center: number, enabled: boolean, time: number): void {
    if (this.readingPrepared && time < this.readingAt + this.reading.gaze.duration) return
    this.readingPrepared = true
    this.readingAt = Math.max(time, this.enteredAt)
    this.reading = readingTrack(span, center, enabled)
  }
  settle(role: Role, time: number, elapsed = 0): void {
    this.role = role; this.start = time; this.duration = 0; this.enteredAt = time - elapsed; this.readingAt = this.enteredAt; this.readingPrepared = false
  }
  private planned(time: number): Pose {
    const target = { ...targetPose(this.role, time, this.enteredAt, this.reading, this.readingAt), arcSpan: this.arc.span, arcCenter: this.arc.center }
    if (!this.duration || time >= this.enteredAt) return target
    const p = Math.max(0, (time - this.start) / this.duration), from = this.from
    const result = map(key => mix(from[key], target[key], smooth(p)))
    const channel = (key: Channel, until: number, begin = 0, destination = target[key]): void => {
      result[key] = mix(from[key], destination, phase(p, begin, until))
    }
    const hadArc = from.arcAlpha > .08, hadDots = from.d0a + from.d1a + from.d2a > .12
    const hasToken = from.dotAlpha > .08
    const arc = this.role === 'reasoning' ? target : from
    const arcSeeds = [-1, 0, 1].map(index => {
      const angle = (arc.arcCenter + index * arc.arcSpan / 3) * Math.PI / 180
      return { x: 320 + Math.cos(angle) * arc.arcRadius / .35, y: 300 + Math.sin(angle) * arc.arcRadius / .35 }
    })
    let look: Point = { x: 320, y: 250 }

    for (const side of ['l', 'r'] as const) {
      for (const part of ['x', 'y', 'w', 'h', 'a'] as const) channel(`${side}${part}`, .82)
    }
    channel('dotAlpha', .73, .22)
    channel('dotRed', .8, .32); channel('dotGreen', .8, .32); channel('dotBlue', .8, .32)
    channel('dotRadius', .86, .3); channel('dotStroke', .85, .3)
    channel('replyAlpha', .95, .64)

    if (this.role === 'reasoning') {
      // Three light seeds occupy the same three arc sections as the new text.
      channel('arcAlpha', .83, .33); channel('arcReveal', .94, .36)
      channel('arcGather', .96, .28); channel('arcOffset', .9, .25)
      channel('arcGroupSpan', .6); channel('arcCenter', .6)
      channel('arcRadius', .85, .2)
      if (hasToken && !hadDots && !hadArc) {
        // A tool name folds into its token; this very anchor emits the arc.
        // Stage the invisible text there before revealing any of its glyphs.
        const anchor = Math.atan2(from.dotY - 300, from.dotX - 320) * 180 / Math.PI
        const radius = Math.hypot(from.dotX - 320, from.dotY - 300) * .35
        result.arcCenter = mix(from.arcCenter, anchor, phase(p, 0, .22)) + (target.arcCenter - anchor) * phase(p, .32, .9)
        result.arcRadius = mix(from.arcRadius, radius, phase(p, 0, .22)) + (90 - radius) * phase(p, .32, .9)
        result.arcGroupSpan = mix(from.arcGroupSpan, 0, phase(p, 0, .22)) + phase(p, .36, .92)
      }
      for (const index of [0, 1, 2] as const) {
        const point = circle({ x: from[`d${index}x`], y: from[`d${index}y`] }, arcSeeds[index], phase(p, .08 + index * .025, .57 + index * .025))
        if (hadDots) {
          result[`d${index}x`] = point.x; result[`d${index}y`] = point.y
          result[`d${index}a`] = from[`d${index}a`] * (1 - phase(p, .58, .9))
          result[`d${index}s`] = mix(from[`d${index}s`], .12, phase(p, .48, .92))
        }
      }
      channel('toolAlpha', .4); channel('toolReveal', .38); channel('toolX', .45, 0, 258)
      look = hadDots ? { x: result.d0x, y: result.d0y } : arcSeeds[0]
    } else {
      // Letters gather along their own arc before the next widget takes over.
      channel('arcGather', .5)
      channel('arcAlpha', .63, .22); channel('arcReveal', .62, .16)
      channel('arcOffset', .62)
      if (this.role === 'tool' || this.role === 'reply') {
        channel('arcGroupSpan', .56, 0, 0)
        channel('arcCenter', .56, 0, Math.atan2(target.dotY - 300, target.dotX - 320) * 180 / Math.PI)
        channel('arcRadius', .56, 0, Math.hypot(target.dotX - 320, target.dotY - 300) * .35)
      }
    }

    if (this.role === 'running') {
      const token = { x: from.dotX, y: from.dotY }
      for (const index of [0, 1, 2] as const) {
        const original = { x: from[`d${index}x`], y: from[`d${index}y`] }
        const landing = { x: target[`d${index}x`], y: target[`d${index}y`] }
        const seed = hadArc ? arcSeeds[index] : hasToken ? token : { x: 320, y: landing.y + 14 }
        const staged = circle(original, seed, phase(p, 0, .22))
        const point = circle(staged, landing, phase(p, .46 + index * .025, .88 + index * .045))
        result[`d${index}x`] = point.x; result[`d${index}y`] = point.y
        channel(`d${index}a`, .6 + index * .06, .2 + index * .035)
        result[`d${index}s`] = mix(from[`d${index}s`], 1, smooth(p)) - .45 * pulse(p, 0, .22, .75)
      }
      if (hasToken && !hadArc) {
        const point = circle(token, { x: 320, y: target.d1y }, phase(p, .34, .86))
        result.dotX = point.x; result.dotY = point.y
        channel('dotAlpha', .66, .24, 0)
        channel('dotRadius', .68, .2, 10)
      }
      channel('toolAlpha', .45); channel('toolReveal', .4); channel('toolX', .45, 0, 258)
      look = { x: result.d1x, y: result.d1y }
    } else if (this.role !== 'reasoning' && hadDots) {
      // Points return around the silhouette and merge into the status token.
      const destination = this.role === 'idle' ? { x: 320, y: 518 } : { x: target.dotX, y: target.dotY }
      for (const index of [0, 1, 2] as const) {
        const point = circle({ x: from[`d${index}x`], y: from[`d${index}y`] }, destination, phase(p, .05 + index * .035, .65 + index * .035))
        result[`d${index}x`] = point.x; result[`d${index}y`] = point.y
        channel(`d${index}a`, .76 + index * .035, .38)
        result[`d${index}s`] = mix(from[`d${index}s`], .12, phase(p, .35, .8))
      }
    }

    if (this.role === 'tool') {
      channel('toolAlpha', .78, .42); channel('toolReveal', .95, .47); channel('toolOffset', .9, .4)
      // The parentheses open at the token, then the name is revealed between.
      result.toolX = mix(from.toolX, 258, phase(p, 0, .35)) + (271 - 258) * phase(p, .42, .95)
      look = { x: 545, y: 194 }
    } else if (this.role !== 'running' && this.role !== 'reasoning') {
      channel('toolAlpha', .45); channel('toolReveal', .42); channel('toolX', .45, 0, 258)
    }
    if (this.role === 'reply') look = { x: result.dotX, y: result.dotY }

    // A saccade toward the handoff leads the body by roughly 60ms. A soft lid
    // dip masks the eye-shape change; it is never a fade of the whole character.
    const attention = pulse(p, 0, .27, .9)
    const glanceX = Math.max(-54, Math.min(54, (look.x - 320) * .24))
    const glanceY = Math.max(-38, Math.min(48, (look.y - 255) * .2))
    for (const side of ['l', 'r'] as const) {
      result[`${side}x`] += glanceX * attention
      result[`${side}y`] += glanceY * attention
      result[`${side}w`] += 1.2 * attention
    }
    const blinkStrength = this.role === 'reply' || this.role === 'idle' ? .7 : .42
    result.lid = mix(from.lid, 1, phase(p, 0, .5)) - blinkStrength * pulse(p, .03, .17, .35)
    const follow = pulse(p, .1, .45, 1)
    result.angle += glanceX / 54 * 2.4 * follow
    result.x += glanceX / 54 * 3.5 * follow
    result.y += (this.role === 'running' ? 5 : -3) * follow
    result.sx -= .014 * follow; result.sy += .014 * follow
    result.dotRadius += 1.5 * pulse(p, .5, .76, 1)
    // Hidden channels also reach their canonical endpoint before the ambient
    // loop resumes, so another redirect never resurrects stale widget geometry.
    return map(key => mix(result[key], target[key], phase(p, .88, 1)))
  }

  sample(time: number): Pose {
    const result = this.planned(time)
    if (!this.duration || time >= this.enteredAt) return fitEyes(result)
    // Residual velocity fades early, leaving the authored handoff in control.
    const length = this.duration * .36
    const p = Math.min(1, Math.max(0, (time - this.start) / length))
    const tangent = p ** 3 - 2 * p ** 2 + p
    return fitEyes(map(key => result[key] + tangent * length * this.velocity[key]))
  }

  redirect(role: Role, time: number, duration: number): void {
    const before = this.sample(time), next = this.sample(time + .01)
    this.from = before; this.role = role; this.start = time; this.duration = duration; this.enteredAt = time + duration; this.readingAt = this.enteredAt; this.readingPrepared = false
    const first = this.planned(time), later = this.planned(time + .01)
    this.velocity = map(key => ((next[key] - before[key]) - (later[key] - first[key])) / .01)
  }

  progress(time: number): number {
    return this.duration ? Math.min(1, Math.max(0, (time - this.start) / this.duration)) : 1
  }

  timeAt(progress: number): number { return this.start + this.duration * Math.max(0, Math.min(1, progress)) }

  beat(time: number): string {
    const p = this.progress(time)
    return p < .25 ? '目光先行' : p < .72 ? '部件交接' : p < 1 ? '轻轻落定' : '已衔接'
  }
}
