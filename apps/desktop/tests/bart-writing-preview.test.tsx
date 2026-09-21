import { describe, expect, it } from 'vitest'
import { createWritingProgram, compileWritingGenerationProgram } from '../src/renderer/src/bart-motion/writing-program'
import { compileGenerationProgram, withGenerationCharacter } from '../src/renderer/src/bart-motion/generation-program'
import { sampleMatrix, sampleReveal, sampleTextureOpacity } from '../src/renderer/src/bart-motion/program'
import { sampleCamera } from '../src/renderer/src/overview-motion/camera-track'
import { validateMotionProgram } from '../src/renderer/src/bart-motion/runtime-limits'
import type { PreparedMotionCard } from '../src/renderer/src/bart-motion/card-assets'
import { typesetBlock } from '../src/renderer/src/card-generation/typeset'
import { createWritingPath } from '../src/renderer/src/bart-motion/writing-path'
import { softenWritingReveal } from '../src/renderer/src/bart-motion/writing-reveal'
import { writingGestures } from '../labs/bart/src/writing-gestures'

const dock = { x: 500, y: 600, radius: 22 }
const native = { a: .1, b: 0, c: 0, d: .1, e: 468, f: 568 }
function fixture(text = '写字，停顿。换行之后继续。'): PreparedMotionCard {
  const rect = { x: 50, y: 100, width: 360, height: 200 }
  const characters = [...text].map((char, index) => ({ left: index % 6 * 20,
    right: (index % 6 + 1) * 20, top: Math.floor(index / 6) * 24,
    bottom: Math.floor(index / 6) * 24 + 16, lineHeight: 24,
    weight: /[，。]/.test(char) ? 2.15 : 1, text: char }))
  const duration = characters.reduce((sum, char) => sum + char.weight / 38 * 1000, 0)
  const typed = typesetBlock(characters, { width: 300, height: 180 }, duration)
  let at = 0
  const beats: NonNullable<PreparedMotionCard['beats']>[number][] = characters.map(char => {
    at += char.weight / 38 * 1000
    return { at, kind: 'character', text: char.text }
  })
  for (let index = 1; index < typed.caret.length; index++) {
    const previous = typed.caret[index - 1], point = typed.caret[index]
    if (previous.at === point.at && previous.y !== point.y) beats.push({ at: point.at, kind: 'wrap' })
  }
  return { rect, assets: [], duration: duration + 34, beats,
    caret: typed.caret.map(point => ({ ...point, x: rect.x + point.x + 10, y: rect.y + point.y })),
    textures: [{ id: 'text', from: 0, rect, reveal: typed.frames.map(frame => {
      const polygon = String(frame.clipPath).match(/-?\d+(?:\.\d+)?/g)!.map(Number)
      return { at: Number(frame.offset) * duration, x: polygon[6], top: polygon[5], bottom: polygon[9] }
    }) }] }
}
function prepare(card: PreparedMotionCard) {
  return withGenerationCharacter(compileGenerationProgram([card], dock), dock, native, 'dock', { activity: 'idle', phase: 'idle' })
}

describe('prepared writing generation', () => {
  it('lets the writing track take over a resident face and its widgets', () => {
    const card = fixture()
    const program = compileWritingGenerationProgram([card], dock, native, 'dock', {
      activity: 'idle', phase: 'idle', resident: { scope: 'bart', role: { kind: 'idle' }, reply: true }
    })
    expect(program.character?.description.resident).toBeUndefined()
    expect(program.character?.description.eyeMotion?.points.length).toBeGreaterThan(0)
  })
  it('uses the locked continuous-writing preset for ordinary production callers', () => {
    const card = fixture(), base = prepare(card)
    const actual = compileWritingGenerationProgram([card], dock, native, 'dock', { activity: 'idle', phase: 'idle' })
    const locked = createWritingProgram({ speed: 1, gesture: 'spring', softReveal: true, punctuationPauses: false })(base, [card])
    expect(actual.duration).toBe(locked.duration)
    expect(actual.textures).toEqual(locked.textures)
    expect(actual.character!.matrices).toEqual(locked.character!.matrices)
    expect(actual.character!.description.travelTrail?.style).toBe('streaks')
    const frames = actual.textures[0].reveal!
    const punctuation = frames.filter(frame => frame.x === 60 && frame.top === frames[1].top)
    expect(punctuation).toHaveLength(1)
  })

  it.each([1, 2, 4, 16])('finishes %i cards within budget without speeding up the detailed prefix', count => {
    const cards = Array.from({ length: count }, (_, index) => {
      const card = fixture(index % 2 ? '长文本，保持稳定书写。'.repeat(10) : '短句。')
      return { ...card, textures: card.textures.map(texture => ({ ...texture, id: `text-${index}` })) }
    })
    const program = structuredClone(compileWritingGenerationProgram(cards, dock, native, 'dock', { activity: 'idle', phase: 'idle' }))
    validateMotionProgram(program, new Set(cards.flatMap(card => card.textures.map(texture => texture.id))))
    expect(program.duration).toBeLessThanOrEqual(count === 1 ? 8000.001 : 15000.001)
    expect(program.textures).toHaveLength(count)
    expect(sampleMatrix(program.character!.matrices, program.duration)).toMatchObject({ ...native, opacity: 1 })
    for (const [index, card] of cards.entries()) {
      const texture = program.textures[index]
      const start = program.phases.find(phase => phase.name === `reveal:${index}`)?.at
      if (start !== undefined) {
        const solo = compileWritingGenerationProgram([card], dock, native, 'dock', { activity: 'idle', phase: 'idle' })
        const soloStart = solo.phases.find(phase => phase.name === 'reveal:0')!.at
        const relative = (frames: NonNullable<typeof texture.reveal>, origin: number) => frames.map(frame => ({
          ...frame, at: Math.round((frame.at - origin) * 1000) / 1000
        }))
        expect(relative(texture.reveal!, start)).toEqual(relative(solo.textures[0].reveal!, soloStart))
        const next = program.phases.find(phase => phase.at > start && /^(fly:|fade:|return)/.test(phase.name))!.at
        expect(program.character!.description.travelTrail!.points.some(point => point.at > start && point.at < next && point.strength > 0)).toBe(true)
      } else {
        expect(texture.reveal).toBeUndefined()
        expect(texture.from).toBe(program.phases.find(phase => phase.name === `fade:${index}`)!.at)
        expect(sampleTextureOpacity(texture, texture.from)).toBe(0)
        expect(sampleTextureOpacity(texture, texture.from + 120)).toBe(.5)
        expect(sampleTextureOpacity(texture, texture.from + 240)).toBe(1)
      }
    }
    if (count >= 4) expect(program.textures.some(texture => texture.fadeIn === 240)).toBe(true)
  })

  it('keeps the second writing path aligned with the prepared offscreen camera', () => {
    const first = fixture('短句。'), second = fixture('另一张。')
    second.rect.y += 1000
    second.caret = second.caret.map(point => ({ ...point, y: point.y + 1000 }))
    second.textures = second.textures.map(texture => ({ ...texture, id: 'second', rect: { ...texture.rect, y: texture.rect.y + 1000 } }))
    const program = compileWritingGenerationProgram([first, second], dock, native, 'dock', { activity: 'idle', phase: 'idle' },
      { x: 0, y: 0, width: 900, height: 650 })
    const start = program.phases.find(phase => phase.name === 'reveal:1')!.at
    const camera = sampleCamera(program.camera!, start), matrix = sampleMatrix(program.character!.matrices, start)
    expect(matrix.f + matrix.b * 320 + matrix.d * 320).toBeCloseTo(second.caret[0].y + camera.y)
    expect(second.rect.y + camera.y).toBeGreaterThanOrEqual(24)
    expect(second.rect.y + second.rect.height + camera.y).toBeLessThanOrEqual(626)
    validateMotionProgram(program, new Set(['text', 'second']))
  })

  it('adds a reading pause after punctuation with both the text and character at rest', () => {
    const card = fixture(), production = prepare(card), original = structuredClone(production)
    const preview = createWritingProgram({ punctuationPauses: true })(production, [card])
    const frames = preview.textures[0].reveal!
    const pause = frames.filter(frame => frame.x === 60 && frame.top === frames[1].top)
    expect(pause.length).toBeGreaterThanOrEqual(2)
    expect(pause.at(-1)!.at - pause[0].at).toBeGreaterThan(120)
    const middle = (pause[0].at + pause.at(-1)!.at) / 2
    expect(sampleReveal(frames, middle)).toMatchObject({ x: 60, top: pause[0].top, bottom: pause[0].bottom })
    const matrix = sampleMatrix(preview.character!.matrices, middle)
    expect(matrix.e + matrix.a * 320 + matrix.c * 320).toBeCloseTo(120, 3)
    expect(production).toEqual(original)
  })

  it('moves Bart through a wrap while holding the completed line without diagonal text reveal', () => {
    const card = fixture(), preview = createWritingProgram({ punctuationPauses: true })(prepare(card), [card])
    const frames = preview.textures[0].reveal!
    const nextIndex = frames.findIndex((frame, index) => index > 1 && frame.top > frames[index - 1].top)
    const next = frames[nextIndex], previous = frames[nextIndex - 1]
    const held = frames.slice(0, nextIndex).find(frame => frame.x === previous.x && frame.top === previous.top)!
    expect(next.at - held.at).toBeGreaterThan(150)
    const middle = (held.at + next.at) / 2
    expect(sampleReveal(frames, middle)).toMatchObject({ x: held.x, top: held.top, bottom: held.bottom })
    const before = sampleMatrix(preview.character!.matrices, held.at)
    const moving = sampleMatrix(preview.character!.matrices, middle)
    const after = sampleMatrix(preview.character!.matrices, next.at)
    const x = (matrix: typeof moving) => matrix.e + matrix.a * 320 + matrix.c * 320
    expect(x(moving)).toBeLessThan(x(before))
    expect(x(moving)).toBeGreaterThan(x(after))
  })

  it('fits long visible content into eight seconds, completes every texture and lands exactly', () => {
    for (const text of ['短句。', '较长的文本，读起来要有停顿。'.repeat(8)]) {
      const card = fixture(text), production = prepare(card)
      for (const speed of [.7, 1, 1.3]) for (const { id } of writingGestures) {
        const preview = structuredClone(createWritingProgram({ speed, gesture: id, punctuationPauses: true })(production, [card]))
        const comparison = createWritingProgram({ speed, punctuationPauses: true })(production, [card])
        validateMotionProgram(preview, new Set(['text']))
        expect(preview.duration).toBe(comparison.duration)
        expect(preview.textures).toEqual(comparison.textures)
        expect(preview.duration).toBeLessThanOrEqual(8000.001)
        expect(sampleMatrix(preview.character!.matrices, preview.duration)).toMatchObject({ ...native, opacity: 1 })
        const final = production.textures[0].reveal!.at(-1)!
        expect(sampleReveal(preview.textures[0].reveal!, preview.duration)).toMatchObject({ x: final.x, top: final.top, bottom: final.bottom })
      }
    }
  })

  it('eases through unequal glyph widths with continuous velocity and no overshoot at a reading stop', () => {
    const values = [[0, 0], [80, 10], [130, 24], [240, 42], [400, 42], [650, 0], [750, 12]]
    const frames = values.map(([at, x]) => ({ at, pose: { x, y: 100, radius: 9, directionX: 1, directionY: 0, stretch: 0, alpha: 1 } }))
    const path = createWritingPath(frames, 0, 750)
    for (const at of [80, 130, 240, 400, 650]) {
      const left = (path(at).x - path(at - .01).x) / .01
      const right = (path(at + .01).x - path(at).x) / .01
      expect(Math.abs(left - right)).toBeLessThan(.001)
    }
    for (let at = 0; at <= 750; at += 4) {
      expect(path(at).x).toBeGreaterThanOrEqual(0)
      expect(path(at).x).toBeLessThanOrEqual(42)
    }
    expect(path(320)).toEqual({ x: 42, y: 100 })
  })

  it('fades new ink in without fading settled pixels out, including after pauses and line wraps', () => {
    const card = fixture(), preview = createWritingProgram({ punctuationPauses: true })(prepare(card), [card])
    const frames = preview.textures[0].reveal!
    expect(frames.some(frame => (frame.feather ?? 0) > 0)).toBe(true)
    const opacity = (at: number, x: number, y: number): number => {
      const clip = sampleReveal(frames, at)
      if (!clip) return 0
      if (y < clip.top) return 1
      if (y > clip.bottom || x > clip.x) return 0
      const p = clip.feather ? Math.max(0, Math.min(1, (clip.x - x) / clip.feather)) : 1
      return p * p * (3 - 2 * p)
    }
    for (const y of [8, 32, 56]) for (const x of [5, 25, 55]) {
      let previous = 0
      for (let at = 0; at <= preview.duration; at += 8) {
        const current = opacity(at, x, y)
        expect(current).toBeGreaterThanOrEqual(previous - .00001)
        previous = current
      }
      expect(opacity(preview.duration, x, y)).toBe(1)
    }
    const hard = createWritingProgram({ softReveal: false, punctuationPauses: true })(prepare(card), [card])
    expect(hard.textures[0].reveal!.every(frame => frame.feather === undefined)).toBe(true)
  })

  it('settles the last glyph before a held full-block mask can replace it', () => {
    const frames = softenWritingReveal([
      { at: 0, x: 0, top: 0, bottom: 20 },
      { at: 100, x: 20, top: 0, bottom: 20 },
      { at: 100, x: 22, top: -2, bottom: 22 },
      { at: 300, x: 22, top: -2, bottom: 22 }
    ], 18)
    expect(sampleReveal(frames, 100)).toMatchObject({ x: 20, top: 0, bottom: 20, feather: 18 })
    expect(sampleReveal(frames, 220)).toMatchObject({ x: 20, feather: 0 })
    expect(sampleReveal(frames, 300)).toMatchObject({ x: 22, top: -2, bottom: 22, feather: 0 })
  })
})
