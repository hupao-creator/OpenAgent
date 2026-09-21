import type { PreparedMotionCard } from './card-assets'
import type { GenerationPreview } from './generation-scene'
import { compileGenerationProgram, withGenerationCharacter } from './generation-program'
import { sampleMatrix, samplePose } from './program'
import type { CharacterDescription, MotionMatrixFrame, MotionProgram } from './worker-types'
import { createWritingPath } from './writing-path'
import { softenWritingReveal } from './writing-reveal'
import { sampleWritingGesture, writingDrive, writingTrailStyle, smooth, type WritingGesture } from './writing-gestures'

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value))
const ease = (value: number): number => value ** 3 * (10 - 15 * value + 6 * value ** 2)
const stamp = (value: number): number => Math.round(value * 10000) / 10000
interface Beat { old: number; arrival: number; departure: number; wrap: boolean }

export interface WritingOptions {
  speed?: number
  softReveal?: boolean
  gesture?: WritingGesture
  punctuationPauses?: boolean
}

/** Locked Lab baseline, also used by ordinary production callers. */
export const WRITING_DEFAULTS = { speed: 1, softReveal: true, gesture: 'spring', punctuationPauses: false } as const

function writingClock(card: PreparedMotionCard, start: number, speed: number, punctuationPauses: boolean): Beat[] {
  const times = [...new Set([0, card.duration, ...card.caret.map(point => point.at),
    ...(card.beats ?? []).map(beat => beat.at)].map(stamp))].sort((a, b) => a - b)
  const cues = new Map<number, NonNullable<PreparedMotionCard['beats']>[number][]>()
  for (const cue of card.beats ?? []) cues.set(stamp(cue.at), [...(cues.get(stamp(cue.at)) ?? []), cue])
  const characters = (card.beats ?? []).filter(cue => cue.kind === 'character')
  const decimals = new Set(characters.filter((cue, index) => cue.text === '.' &&
    /\d/u.test(characters[index - 1]?.text ?? '') && /\d/u.test(characters[index + 1]?.text ?? '')).map(cue => stamp(cue.at)))
  let elapsed = 0, phrase = 0
  const clock = times.map((at, index): Beat => {
    const events = cues.get(at) ?? []
    const text = events.find(event => event.kind === 'character')?.text
    const wrap = events.some(event => event.kind === 'wrap')
    const block = at > 0 && events.some(event => event.kind === 'block')
    const punctuation = text !== undefined && !decimals.has(at) && /[，。；：、,.!?！？；…]/u.test(text)
    // A phrase gently gathers pace then releases. Punctuation is drawn first;
    // its reading pause follows, rather than stretching the glyph itself.
    const rhythm = 1.04 + .2 * Math.cos(Math.min(phrase, 12) / 12 * Math.PI * 2)
    const delta = at - (times[index - 1] ?? 0)
    elapsed += block ? Math.max(210, delta) : punctuation ? Math.min(65, delta * 1.6) : delta * 1.65 * rhythm
    const arrival = elapsed
    let hold = punctuation && punctuationPauses ? /[。.!?！？…]/u.test(text!) ? 260 : 160 : 0
    if (block) hold = Math.max(hold, 85)
    if (wrap) hold = Math.max(hold, 270)
    if (index === times.length - 1) hold = Math.max(hold, 180)
    elapsed += hold
    if (punctuation || block) phrase = 0
    else if (text) phrase++
    return { old: start + at, arrival, departure: elapsed, wrap }
  })
  // Reserve 750ms for arrival/morph and 520ms for return, keeping a single
  // visible card within eight seconds without typing its clipped tail.
  const target = clamp(elapsed / clamp(speed, .65, 1.4), 3600, 6730)
  const scale = target / Math.max(1, elapsed)
  return clock.map(beat => ({ ...beat, arrival: start + beat.arrival * scale, departure: start + beat.departure * scale }))
}

export function compileWritingGenerationProgram(cards: readonly PreparedMotionCard[],
  dock: { x: number; y: number; radius: number }, native: Omit<MotionMatrixFrame, 'at'>,
  destination: string, description: CharacterDescription, viewport?: MotionProgram['viewport'], options: WritingOptions = {}): MotionProgram {
  const { speed, punctuationPauses } = { ...WRITING_DEFAULTS, ...options }
  let elapsed = 0, detailed = 0
  for (const card of cards) {
    const duration = card.caret.length ? writingClock(card, 0, speed, punctuationPauses).at(-1)!.departure : card.duration
    const reserve = 520 + (detailed + 1 < cards.length ? 240 : 0)
    if (elapsed + 750 + duration + reserve > 15000) break
    elapsed += 750 + duration
    detailed++
  }
  const base = withGenerationCharacter(compileGenerationProgram(cards, dock, viewport, detailed), dock, native, destination, description)
  return createWritingProgram(options)(base, cards)
}

export function createWritingProgram(options: WritingOptions = {}): GenerationPreview {
  const settings = { ...WRITING_DEFAULTS, ...options }
  return (program, cards) => {
    // Work backwards so each card's original phase boundary stays available.
    for (let index = cards.length - 1; index >= 0; index--) {
      if (cards[index].caret.length && program.character && program.phases.some(phase => phase.name === `reveal:${index}`)) {
        program = writeCard(program, cards[index], index, settings)
      }
    }
    return program
  }
}

function writeCard(program: MotionProgram, card: PreparedMotionCard, index: number, options: Required<WritingOptions>): MotionProgram {
  const { speed, softReveal, gesture, punctuationPauses } = options
  const character = program.character!
  const start = program.phases.find(phase => phase.name === `reveal:${index}`)!.at
  const oldEnd = start + card.duration
  const clock = writingClock(card, start, speed, punctuationPauses)
  const end = clock.at(-1)!.departure, shift = end - oldEnd
  const eventAt = (at: number): Beat | undefined => clock.find(beat => Math.abs(beat.old - at) < .001)
  const time = (at: number, after = false): number => {
    if (at < start) return at
    if (at > oldEnd + .001) return at + shift
    const event = eventAt(at)
    if (event) return after ? event.departure : event.arrival
    let index = 0
    while (index + 1 < clock.length && clock[index + 1].old < at) index++
    const from = clock[index], to = clock[index + 1] ?? from
    const p = from === to ? 0 : (at - from.old) / (to.old - from.old)
    return from.departure + (to.arrival - from.departure) * p
  }
  const retime = <T extends { at: number }>(frames: readonly T[], travel = false): T[] => {
    const result: T[] = []
    for (let index = 0; index < frames.length;) {
      let last = index
      while (last + 1 < frames.length && Math.abs(frames[last + 1].at - frames[index].at) < .001) last++
      const group = frames.slice(index, last + 1), event = eventAt(group[0].at)
      const arrival = time(group[0].at), departure = time(group[0].at, true)
      if (event?.wrap && group.length > 1) {
        result.push({ ...group[0], at: arrival })
        // Text holds the completed old line. Only Bart crosses the whitespace.
        if (!travel) result.push({ ...group[0], at: departure })
        result.push(...group.slice(1).map(frame => ({ ...frame, at: departure })))
      } else {
        result.push(...group.map(frame => ({ ...frame, at: arrival })))
        if (departure > arrival) result.push({ ...group.at(-1)!, at: departure })
      }
      index = last + 1
    }
    return result
  }
  const poses = retime(program.poses, true)
  const matrices = retime(character.matrices, true)
  // Relay/return starts after the final reading hold, without interpolating
  // the next flight backwards through that hold.
  for (const frames of [poses, matrices]) {
    for (const frame of frames) {
      if (Math.abs(frame.at - time(oldEnd)) < .001 && frame.at > start) frame.at = time(oldEnd, true)
    }
    frames.sort((a, b) => a.at - b.at)
  }
  const turns = clock.filter(beat => beat.wrap && beat.departure > beat.arrival)
  const path = createWritingPath(poses, start, end)
  const position = (at: number) => {
    const turn = turns.find(beat => at >= beat.arrival && at <= beat.departure)
    if (!turn) return path(at)
    const from = path(turn.arrival), to = path(turn.departure)
    const p = (at - turn.arrival) / (turn.departure - turn.arrival), eased = ease(p)
    return { ...from, x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased - Math.sin(Math.PI * p) ** 2 * 7 }
  }
  const velocity = (at: number): number => {
    const before = position(clamp(at - 85, start, end)), after = position(clamp(at + 85, start, end))
    return (after.x - before.x) / 170
  }
  const writingFrames: MotionMatrixFrame[] = []
  const eyes: NonNullable<CharacterDescription['eyeMotion']>['points'][number][] = [{ at: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 }]
  const trail = [{ at: 0, direction: 1, strength: 0 }]
  const trailStyle = writingTrailStyle(gesture)
  for (let at = start; at <= end; at = Math.min(end, at + 8)) {
    const matrix = sampleMatrix(matrices, at), base = samplePose(poses, at)!, center = position(at)
    const drive = writingDrive(velocity, at)
    const gesturePose = sampleWritingGesture(gesture, { ...drive,
      envelope: smooth((at - start) / 160) * smooth((end - at) / 160) })
    const { angle, sx, sy } = gesturePose
    const a = Math.cos(angle) * sx, b = Math.sin(angle) * sx
    const c = -Math.sin(angle) * sy, d = Math.cos(angle) * sy
    const dx = matrix.e - base.x, dy = matrix.f - base.y
    writingFrames.push({ at,
      a: a * matrix.a + c * matrix.b, b: b * matrix.a + d * matrix.b,
      c: a * matrix.c + c * matrix.d, d: b * matrix.c + d * matrix.d,
      e: center.x + gesturePose.x + a * dx + c * dy, f: center.y + gesturePose.y + b * dx + d * dy,
      opacity: matrix.opacity })
    eyes.push({ at, x: gesturePose.eyeX, y: gesturePose.eyeY, scaleX: 1 / sx, scaleY: 1 / sy })
    trail.push({ at, direction: drive.direction, strength: gesturePose.trailStrength })
    if (at === end) break
  }
  const duration = program.duration + shift
  eyes.push({ at: duration, x: 0, y: 0, scaleX: 1, scaleY: 1 })
  trail.push({ at: duration, direction: 1, strength: 0 })
  const preserve = <T extends { at: number }>(previous: readonly T[] | undefined, current: readonly T[]): T[] => [
    ...(previous ?? []).filter(frame => frame.at < start || frame.at > oldEnd).map(frame => ({ ...frame, at: time(frame.at, true) })),
    ...current.filter(frame => !previous || frame.at >= start && frame.at <= end)
  ].sort((a, b) => a.at - b.at)
  const textIds = new Set(card.textures.map(texture => texture.id))
  const motionKey = Date.now()
  const result: MotionProgram = {
    ...program, duration, poses,
    phases: program.phases.map(phase => ({ ...phase, at: time(phase.at, phase.at >= oldEnd) })),
    camera: program.camera?.map(frame => ({ ...frame, at: time(frame.at, frame.at >= oldEnd) })),
    textures: program.textures.map(texture => ({ ...texture,
      from: time(texture.from, texture.from >= oldEnd), until: texture.until === undefined ? undefined : time(texture.until, true),
      reveal: texture.reveal && (softReveal && textIds.has(texture.id) ? softenWritingReveal(retime(texture.reveal), 18) : retime(texture.reveal)) })),
    character: { ...character, aimAt: 0,
      description: { ...character.description, resident: undefined,
        eyeMotion: { key: motionKey, duration, points: preserve(character.description.eyeMotion?.points, eyes) },
        travelTrail: trailStyle ? { key: motionKey, duration, style: trailStyle,
          points: preserve(character.description.travelTrail?.points, trail) } : undefined },
      matrices: [...matrices.filter(frame => frame.at < start || frame.at > end), ...writingFrames].sort((a, b) => a.at - b.at) }
  }
  return result
}
