import { describe, expect, it } from 'vitest'
import {
  BART_CAPSULE_INSET,
  BART_CAPSULE_LINE_HEIGHT,
  BART_CAPSULE_MAX_LINES,
  bartCapsuleHeight,
  bartCapsulePlacement,
  bartCapsuleLines
} from '../src/renderer/src/bart-composer-geometry'

const measured = (lines: number): number => lines * BART_CAPSULE_LINE_HEIGHT + BART_CAPSULE_INSET * 2

describe('Bart input capsule geometry', () => {
  it('reads an empty or single-line field as one row', () => {
    expect(bartCapsuleLines(0)).toBe(1)
    expect(bartCapsuleLines(measured(1))).toBe(1)
    expect(bartCapsuleHeight(1)).toBe(measured(1))
  })

  it('reads wrapped content back as the rows it occupies', () => {
    for (let lines = 2; lines <= BART_CAPSULE_MAX_LINES; lines++) {
      expect(bartCapsuleLines(measured(lines))).toBe(lines)
      expect(bartCapsuleHeight(lines)).toBe(measured(lines))
    }
  })

  it('stops growing at the row cap instead of following the draft any further', () => {
    expect(bartCapsuleHeight(BART_CAPSULE_MAX_LINES + 1)).toBe(measured(BART_CAPSULE_MAX_LINES))
    expect(bartCapsuleHeight(40)).toBe(measured(BART_CAPSULE_MAX_LINES))
  })

  it('bounds a count that never came from a rendered field', () => {
    expect(bartCapsuleHeight(0)).toBe(measured(1))
    expect(bartCapsuleHeight(-3)).toBe(measured(1))
    expect(bartCapsuleHeight(2.7)).toBe(measured(2))
    expect(bartCapsuleHeight(Number.NaN)).toBe(measured(1))
    expect(bartCapsuleLines(Number.NaN)).toBe(1)
  })

  it('rounds content that lands between two rows to the nearer one', () => {
    expect(bartCapsuleLines(measured(1) + BART_CAPSULE_LINE_HEIGHT * 0.4)).toBe(1)
    expect(bartCapsuleLines(measured(1) + BART_CAPSULE_LINE_HEIGHT * 0.6)).toBe(2)
  })
})

describe('Bart input capsule placement', () => {
  const body = { top: 200, bottom: 300 }

  it('uses the space below Bart when a single row fits', () => {
    expect(bartCapsulePlacement(body, { top: 8, bottom: 500 }, 46))
      .toEqual({ side: 'below', anchor: 320, room: 180 })
  })

  it('uses the space above Bart near the bottom edge', () => {
    expect(bartCapsulePlacement(body, { top: 8, bottom: 350 }, 46))
      .toEqual({ side: 'above', anchor: 180, room: 172 })
  })

  it('reserves the attachment row before choosing a side', () => {
    const bounds = { top: 8, bottom: 380 }
    expect(bartCapsulePlacement(body, bounds, 46).side).toBe('below')
    expect(bartCapsulePlacement(body, bounds, 46 + 39).side).toBe('above')
  })

  it('keeps one editable row on the roomier side in a constrained viewport', () => {
    expect(bartCapsulePlacement(body, { top: 170, bottom: 350 }, 46))
      .toEqual({ side: 'below', anchor: 320, room: 46 })
  })
})
