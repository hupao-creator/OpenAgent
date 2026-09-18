import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCanvasCharacter } from '../src/renderer/src/bart-motion/character-canvas'
import { BODY_COLOR, EYE_COLOR } from '../src/renderer/src/bart-motion/character-model'
import type { CharacterDescription } from '../src/renderer/src/bart-motion/worker-types'

class TestPath { constructor(readonly path: string) {} }
function recorder() {
  const fills: { path: unknown; color: unknown }[] = []
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '', strokeStyle: '' }
  const context = new Proxy(state, {
    get: (target, key) => {
      if (key === 'fill') return (path?: unknown) => fills.push({ path, color: target.fillStyle })
      if (key === 'getTransform') return () => ({ a: 1, b: 0 })
      return key in target ? target[String(key)] : () => undefined
    }
  }) as unknown as OffscreenCanvasRenderingContext2D
  return { context, fills }
}
const idle: CharacterDescription = { activity: 'idle', phase: 'idle', key: 'resident', layout: 'mark', animate: false }
afterEach(() => vi.unstubAllGlobals())

describe('Worker character appearance', () => {
  it('retains solid default colours and suppresses only the acknowledged glass body', () => {
    vi.stubGlobal('Path2D', TestPath)
    const solid = recorder()
    createCanvasCharacter(idle).paint(solid.context, performance.now(), 640, 640)
    expect(solid.fills.some(fill => fill.path instanceof TestPath && fill.color === BODY_COLOR)).toBe(true)
    expect(solid.fills.filter(fill => fill.color === EYE_COLOR)).toHaveLength(2)
    const glass = recorder()
    createCanvasCharacter({ ...idle, bodyMaterial: 'liquidGlass', bodyColor: '#123456', eyeColor: '#000000' })
      .paint(glass.context, performance.now(), 640, 640)
    expect(glass.fills.some(fill => fill.path instanceof TestPath)).toBe(false)
    expect(glass.fills.filter(fill => fill.color === '#000000')).toHaveLength(2)
  })
  it('keeps expanded shapes solid even if a caller incorrectly requests glass', () => {
    vi.stubGlobal('Path2D', TestPath)
    const result = recorder()
    createCanvasCharacter({ ...idle, layout: 'permission', bodyMaterial: 'liquidGlass', bodyColor: '#123456' })
      .paint(result.context, performance.now(), 640, 640)
    expect(result.fills.some(fill => fill.path instanceof TestPath && fill.color === '#123456')).toBe(true)
  })
  it('colour-only updates preserve pose/clocks, and flights retain a solid body', () => {
    const character = createCanvasCharacter({ ...idle, bodyMaterial: 'liquidGlass', animate: true })
    const before = character.capture()
    character.update({ ...character.description(), bodyColor: '#123456', eyeColor: '#000000' })
    expect(character.capture()).toEqual(before)
    const flight = character.fork()
    expect(flight.capture()).toEqual(before)
    expect(flight.description()).toMatchObject({ bodyMaterial: 'solid', bodyColor: '#123456', eyeColor: '#000000' })
    expect(character.description().bodyMaterial).toBe('liquidGlass')
  })
})
