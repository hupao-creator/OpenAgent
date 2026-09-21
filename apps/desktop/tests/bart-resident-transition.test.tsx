import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResidentTransition } from '../src/renderer/src/bart-motion/resident-transition'
import { ResidentText, graphemes } from '../src/renderer/src/bart-motion/resident-text'
import { createCanvasCharacter } from '../src/renderer/src/bart-motion/character-canvas'
import type { CharacterDescription } from '../src/renderer/src/bart-motion/worker-types'
import type { Role } from '../src/renderer/src/bart-motion/resident-pose'

const roles: Role[] = ['idle', 'running', 'reasoning', 'tool', 'reply']
const measure = (text: string): number => graphemes(text).length * 10
let now = 0
beforeEach(() => {
  now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('Path2D', class {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function context() {
  const text: string[] = []
  const ctx = new Proxy({ getTransform: () => ({ a: 1, b: 0 }), measureText: (value: string) => ({ width: measure(value) }),
    fillText: (value: string) => text.push(value) }, {
    get: (target, key) => Reflect.get(target, key) ?? (() => undefined),
    set: (target, key, value) => Reflect.set(target, key, value)
  }) as unknown as OffscreenCanvasRenderingContext2D
  return { ctx, text }
}
function description(role: Role, extra: Partial<CharacterDescription> = {}): CharacterDescription {
  return { activity: role === 'reasoning' ? 'thinking' : role === 'tool' ? 'tool' : 'idle',
    phase: role === 'idle' || role === 'reply' ? 'idle' : 'running', role: role === 'reply' ? 'idle' : role,
    resident: { scope: 'conversation-a', reply: role === 'reply', role: role === 'reasoning'
      ? { kind: role, text: '实际文本 mixed 👩‍💻', segmentKey: 'reasoning-1' }
      : role === 'tool' ? { kind: role, toolName: 'web_find' } : { kind: role === 'reply' ? 'idle' : role } }, ...extra }
}

describe('shared resident choreography', () => {
  it('retargets every role pair without a position or velocity jump, including interrupted handoffs', () => {
    for (const from of roles) for (const to of roles) for (const elapsed of [0, 80, 220, 470, 700]) {
      const motion = new ResidentTransition()
      motion.redirect(from, 0, 550)
      const before = motion.sample(elapsed), next = motion.sample(elapsed + .001)
      motion.redirect(to, elapsed, 550)
      const after = motion.sample(elapsed), later = motion.sample(elapsed + .001)
      for (const key of Object.keys(before) as (keyof typeof before)[]) {
        expect(after[key]).toBeCloseTo(before[key], 7)
        expect((later[key] - after[key]) / .001).toBeCloseTo((next[key] - before[key]) / .001, 1)
      }
    }
  })
  it('keeps the entire eye pair inside the silhouette across repeated redirects', () => {
    const motion = new ResidentTransition()
    for (let step = 0; step < 300; step++) {
      const time = step * 37
      motion.redirect(roles[step % roles.length], time, 550)
      const pose = motion.sample(time + 30)
      for (const side of ['l', 'r'] as const) {
        const angle = pose[`${side}a`] * Math.PI / 180
        for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
          const x = dx * pose[`${side}w`] / 2, y = dy * pose[`${side}h`] / 2
          const cornerX = pose[`${side}x`] + x * Math.cos(angle) - y * Math.sin(angle)
          const cornerY = pose[`${side}y`] + x * Math.sin(angle) + y * Math.cos(angle)
          expect(Math.hypot(cornerX - 320, cornerY - 300)).toBeLessThanOrEqual(154.000001)
        }
      }
    }
  })
  it('keeps a fork on the same pose and gives each copy independent future ownership', () => {
    const source = new ResidentTransition()
    source.redirect('reasoning', 0, 550)
    const fork = source.clone()
    expect(fork.sample(220)).toEqual(source.sample(220))
    fork.redirect('reply', 220, 550)
    expect(source.role).toBe('reasoning')
    expect(fork.sample(220)).toEqual(source.sample(220))
  })
})

describe('Worker text presentation', () => {
  it('shows every queued glyph from a burst, retaining graphemes and source order', () => {
    const stream = new ResidentText(), input = Array.from({ length: 150 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('') + '👩‍💻'
    stream.update({ text: Array.from(input).slice(-56).join(''), sourceText: input, segmentKey: 'a' }, 'glide', 452, 0, measure)
    const seen = new Set<string>()
    for (let t = 0; t < 24000; t += 16) {
      stream.advance(16, t, measure)
      stream.visible(t).forEach(glyph => seen.add(glyph.value))
    }
    expect([...seen]).toEqual(graphemes(input))
  })
  it('handles overlapping UTF-16 windows and split emoji without replay, then resets on a new segment', () => {
    const stream = new ResidentText()
    stream.update({ text: 'ab👩', sourceText: 'ab👩', sourceOffset: 0, segmentKey: 'a' }, 'glide', 452, 0, measure)
    stream.update({ text: 'b👩‍💻中', sourceText: 'b👩‍💻中', sourceOffset: 1, segmentKey: 'a' }, 'glide', 452, 20, measure)
    expect(stream.visible(20).map(g => g.value).join('')).toBe('ab👩‍💻中')
    const fork = stream.clone()
    stream.update({ text: '新', segmentKey: 'b' }, 'direct', 452, 30, measure)
    expect(stream.visible(30).map(g => g.value).join('')).toBe('新')
    expect(fork.visible(30).map(g => g.value).join('')).toBe('ab👩‍💻中')
  })
  it('resumes from the latest tail after reduced motion, without replaying hidden input', () => {
    const stream = new ResidentText()
    stream.update({ text: '旧', segmentKey: 'a' }, 'glide', 452, 0, measure)
    stream.update({ text: '最新', sourceText: '旧最新', segmentKey: 'a' }, 'direct', 452, 20, measure)
    stream.update({ text: '最新', sourceText: '旧最新', segmentKey: 'a' }, 'glide', 452, 30, measure)
    expect(stream.visible(30).map(g => g.value).join('')).toBe('最新')
  })
})

describe('production character lifecycle', () => {
  it('paints actual text and tool names, keeps outgoing text until its handoff ends, and transfers the visible pose to a fork', () => {
    const { ctx, text } = context(), character = createCanvasCharacter(description('reasoning'))
    character.paint(ctx, now, 640, 640)
    expect(text.join('')).toContain('实际文本 mixed 👩‍💻')
    character.update(description('tool'))
    now = 160; character.paint(ctx, now, 640, 640)
    expect(text.join('')).toContain('实际文本')
    const fork = character.fork()
    expect(fork.capture()).toEqual(character.capture())
    for (now = 176; now < 900; now += 16) character.paint(ctx, now, 640, 640)
    text.length = 0; character.paint(ctx, now, 640, 640)
    expect(text.join('')).not.toContain('实际文本')
    expect(text).toContain('web_find')
    character.update({ activity: 'tool', phase: 'running', layout: 'permission' })
    character.paint(ctx, now, 640, 640)
    expect(character.description().resident).toBeUndefined()
  })
  it('returns the circular face to dedicated writing even when semantic descriptors are unchanged', () => {
    const { ctx } = context(), value = description('idle'), character = createCanvasCharacter(value)
    character.paint(ctx, now, 640, 640)
    const before = character.capture()
    character.update({ ...value, resident: undefined, eyeMotion: { key: 1, duration: 1000, points: [{ at: 0, x: 0, y: 0 }] } })
    character.paint(ctx, now, 640, 640)
    expect(character.capture().body).toEqual(before.body)
    expect(character.capture().shape).toBe('circle')
    for (now = 16; now < 1000; now += 16) character.paint(ctx, now, 640, 640)
    expect(character.capture().satelliteOpacity).toBe(0)
    expect(character.capture().eyes.every(eye => eye.opacity > .99 && eye.h > 20)).toBe(true)
  })
  it('freezes while covered, resumes the same transition, and isolates conversations', () => {
    const { ctx, text } = context(), value = description('reasoning'), character = createCanvasCharacter(description('running'))
    character.paint(ctx, now, 640, 640)
    character.update(value)
    now = 120; character.paint(ctx, now, 640, 640)
    character.update({ ...value, animate: false })
    const paused = character.capture()
    now = 10000; character.paint(ctx, now, 640, 640)
    expect(character.capture().eyes).toEqual(paused.eyes)
    expect(character.capture().body).toEqual(paused.body)
    expect(character.nextWake(now)).toBe(Infinity)
    character.update(value); character.paint(ctx, now, 640, 640)
    expect(character.capture().eyes).toEqual(paused.eyes)
    expect(character.capture().body).toEqual(paused.body)
    const next = description('tool'); next.resident!.scope = 'conversation-b'
    character.update(next); text.length = 0; character.paint(ctx, now, 640, 640)
    expect(text.join('')).not.toContain('实际文本')
  })
  it('uses static endpoints for all reduced-motion states and continues the launch story after its intro', () => {
    const { ctx } = context()
    for (const role of roles) {
      const value = description(role, { animate: false }); value.resident!.reducedMotion = true
      const character = createCanvasCharacter(value)
      character.paint(ctx, 0, 640, 640)
      const pose = character.capture()
      character.paint(ctx, 8000, 640, 640)
      expect(character.capture().eyes).toEqual(pose.eyes)
      expect(character.capture().body).toEqual(pose.body)
      expect(character.nextWake(8000)).toBe(Infinity)
    }
    const value = description('running', { launch: { key: 1, speed: 1, startedAt: performance.timeOrigin,
      capsule: { x: 0, y: 0, width: 200, height: 100 }, bodyOffset: { x: 0, y: 0 }, radius: 20 } })
    const character = createCanvasCharacter(value)
    character.paint(ctx, 0, 640, 640)
    for (now = 16; now < 800; now += 16) character.paint(ctx, now, 640, 640)
    const afterIntro = character.capture()
    for (; now < 4000; now += 16) character.paint(ctx, now, 640, 640)
    expect(character.capture().eyes).not.toEqual(afterIntro.eyes)
  })
})
