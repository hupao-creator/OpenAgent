import { AIM_AT, arcNormal, arcOffset, bankAngle, blendMatrix, flightEase, inkCenter,
  inkBoxFromCorners, inverseMatrix, matrixCss, multiplyMatrix, translationMatrix, type ScreenMatrix } from '../components/bart-cross-page-flight'
import { sampleMatrix } from './program'
import { sampleTimeline, type MotionTimeline } from './motion-timeline'
import type { CharacterDescription, MotionMatrixFrame, MotionProgram } from './worker-types'

/** One immutable route. Its endpoints are sealed layout facts, never callbacks. */
export function compileCrossPageProgram(from: ScreenMatrix, to: ScreenMatrix, duration: number,
  destination: string, description: CharacterDescription): MotionProgram {
  const box = { x: 0, y: 0, width: 640, height: 640 }
  const start = inkCenter(inkBoxFromCorners(box, from)), end = inkCenter(inkBoxFromCorners(box, to))
  const normal = arcNormal(start, end), travel = Math.sign(end.x - start.x) || 1
  const matrices: MotionMatrixFrame[] = []
  for (let index = 0; index <= 128; index++) {
    const t = index / 128, p = flightEase(t), lift = arcOffset(normal, p)
    const bank = bankAngle(travel, p) * Math.PI / 180
    const rotation = { a: Math.cos(bank), b: Math.sin(bank), c: -Math.sin(bank), d: Math.cos(bank), e: 0, f: 0 }
    const aboutBody = multiplyMatrix(translationMatrix(320, 320), multiplyMatrix(rotation, translationMatrix(-320, -320)))
    const matrix = multiplyMatrix(translationMatrix(lift.x, lift.y), multiplyMatrix(blendMatrix(from, to, p), aboutBody))
    matrices.push({ ...matrix, at: duration * t })
  }
  return { duration, poses: [], textures: [], phases: [{ at: 0, name: 'depart' },
    { at: duration * AIM_AT, name: 'aim' }, { at: duration, name: 'waiting-host' }],
    character: { destination, aimAt: duration * AIM_AT, description, matrices } }
}

/** Keep the actor's raster fixed while Chromium moves its composited layer.
 * Both timelines use the same immutable route and Worker start epoch. */
export function localizeCrossPageProgram(program: MotionProgram, size: number): {
  workerProgram: MotionProgram; keyframes: Keyframe[]
} {
  const character = program.character!
  const scale = size / 640
  const local = { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 }
  const keyframes = compositorKeyframes(character.matrices, program.duration, size)
  return { keyframes, workerProgram: { ...program,
    character: { ...character, matrices: [{ at: 0, ...local }, { at: program.duration, ...local }] },
    textures: program.textures.map(texture => {
      const inverse = inverseMatrix(sampleMatrix(character.matrices, texture.from))
      if (!inverse) throw new Error('Bart decoration endpoint matrix is singular')
      return { ...texture, rect: inkBoxFromCorners(texture.rect, multiplyMatrix(local, inverse)) }
    })
  } }
}

function compositorKeyframes(matrices: readonly MotionMatrixFrame[], duration: number, size: number): Keyframe[] {
  const expand = { a: 640 / size, b: 0, c: 0, d: 640 / size, e: 0, f: 0 }
  return matrices.map(matrix => ({ offset: Math.max(0, Math.min(1, matrix.at / duration)),
    transform: matrixCss(multiplyMatrix(matrix, expand)), opacity: matrix.opacity ?? 1 }))
}

/** Compile one compositor submission per input, including exact endpoint keys. */
export function redirectCrossPageKeyframes(program: MotionProgram, timeline: MotionTimeline, size: number): Keyframe[] {
  const count = Math.ceil(timeline.duration / 4)
  const matrices = Array.from({ length: count + 1 }, (_, index) => {
    const at = timeline.duration * (index / count)
    return { ...sampleMatrix(program.character!.matrices, sampleTimeline(timeline, timeline.origin + at).position), at }
  })
  return compositorKeyframes(matrices, timeline.duration, size)
}
