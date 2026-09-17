import { describe, expect, it } from 'vitest'
import { compileCrossPageProgram, localizeCrossPageProgram } from '../src/renderer/src/bart-motion/cross-page-program'
import { validateMotionProgram } from '../src/renderer/src/bart-motion/runtime-limits'
import { inkBoxFromCorners, multiplyMatrix, type ScreenMatrix } from '../src/renderer/src/components/bart-cross-page-flight'

const readMatrix = (text: string): ScreenMatrix => {
  const [a, b, c, d, e, f] = text.slice(7, -1).split(',').map(Number)
  return { a, b, c, d, e, f }
}

describe('compositor flight', () => {
  it.each([0, 760])('preserves the complete world route and engine landing at %s in a small actor layer', at => {
    const program = compileCrossPageProgram(
      { a: .4, b: 0, c: 0, d: .4, e: 900, f: 420 },
      { a: .2, b: 0, c: 0, d: .2, e: 500, f: 100 }, 760, 'seat',
      { activity: 'idle', phase: 'idle' })
    program.textures = [{ id: 'engine', from: at, until: at === 0 ? 0 : undefined, rect: { x: 600, y: 112, width: 20, height: 20 } }]
    const { workerProgram, keyframes } = localizeCrossPageProgram(program, 256)
    expect(() => validateMotionProgram(workerProgram, new Set(['engine']))).not.toThrow()
    expect(workerProgram.duration).toBe(program.duration)
    expect(workerProgram.character?.aimAt).toBe(program.character?.aimAt)
    expect(workerProgram.phases).toEqual(program.phases)
    const local = workerProgram.character!.matrices[0]
    for (const [index, frame] of keyframes.entries()) {
      expect(frame.offset).toBe(program.character!.matrices[index].at / program.duration)
      const world = multiplyMatrix(readMatrix(String(frame.transform)), local)
      for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
        expect(world[key]).toBeCloseTo(program.character!.matrices[index][key], 10)
      }
    }
    const engine = inkBoxFromCorners(workerProgram.textures[0].rect, readMatrix(String(keyframes.at(at === 0 ? 0 : -1)!.transform)))
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(engine[key]).toBeCloseTo(program.textures[0].rect[key], 10)
  })
})
