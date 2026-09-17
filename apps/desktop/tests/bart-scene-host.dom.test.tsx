// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBartPresenceCoordinator } from '../src/renderer/src/bart-motion/presence'
import { prepareWithinBudget, sealGeometry, sealMotionScene } from '../src/renderer/src/bart-motion/scene-host'

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers() })
function fixture() {
  const root = document.createElement('main'), scroll = document.createElement('section')
  const card = document.createElement('article'), button = document.createElement('button'), canvas = document.createElement('canvas')
  button.textContent = 'Open current thread'; card.append(button); scroll.append(card); root.append(scroll, canvas); document.body.append(root)
  scroll.style.setProperty('overflow', 'auto', 'important')
  return { root, scroll, card, button, canvas }
}

describe('scene sealing and native ownership', () => {
  it('locks only the related region and restores its original styles and focus', () => {
    const f = fixture(), other = document.createElement('button')
    document.body.append(other); f.button.focus()
    const seal = sealMotionScene({ root: f.root, canvas: f.canvas, covered: [f.card], scroll: [f.scroll] })
    expect(f.card.inert).toBe(true)
    expect(other.inert).not.toBe(true)
    expect(f.scroll.style.overflow).toBe('hidden')
    expect(document.activeElement).not.toBe(f.button)
    expect(f.canvas.hidden).toBe(true)
    expect(seal.show()).toBe(true)
    expect(f.card.style.visibility).toBe('hidden')
    expect(f.canvas.hidden).toBe(false)
    expect(seal.release()).toBe(true)
    expect(f.canvas.hidden).toBe(true)
    expect(f.card.style.visibility).toBe('')
    expect(f.scroll.style.overflow).toBe('auto')
    expect(f.scroll.style.getPropertyPriority('overflow')).toBe('important')
    expect(document.activeElement).toBe(f.button)
  })

  it('refuses conflicting masks and ignores old release after a new scene owns them', () => {
    const f = fixture(), options = { root: f.root, canvas: f.canvas, covered: [f.card], resources: [f.scroll] }
    const first = sealMotionScene(options)
    expect(() => sealMotionScene(options)).toThrow('already owned')
    first.show(); first.release()
    const next = sealMotionScene(options)
    next.show()
    expect(first.release()).toBe(false)
    expect(next.owns()).toBe(true)
    expect(f.card.inert).toBe(true)
    expect(f.root.dataset.bartScene).toBe(next.id)
    next.release()
  })

  it('preserves focus moved outside the scene and restores preexisting inert ownership', () => {
    const f = fixture(), other = document.createElement('button')
    document.body.append(other); f.button.focus(); f.card.inert = true
    const seal = sealMotionScene({ root: f.root, canvas: f.canvas, covered: [f.card] })
    other.focus(); seal.release()
    expect(document.activeElement).toBe(other)
    expect(f.card.inert).toBe(true)
  })

  it('invalidates resource geometry, content and detached targets before handoff', () => {
    const f = fixture()
    const valid = sealGeometry([f.card])
    expect(valid()).toBe(true)
    f.button.textContent = 'A newer business revision'
    expect(valid()).toBe(false)
    const stillMounted = sealGeometry([f.card])
    f.card.remove()
    expect(stillMounted()).toBe(false)
  })

  it('preserves new business styles and explicitly transferred interaction ownership', () => {
    const f = fixture()
    f.card.style.transform = 'translateX(5px)'
    const seal = sealMotionScene({ root: f.root, canvas: f.canvas, covered: [f.card], freezeTransforms: [f.card] })
    seal.show()
    f.card.style.transform = 'translateX(100px)'
    f.card.inert = false
    seal.release({ restoreInteraction: false })
    expect(f.card.style.transform).toBe('translateX(100px)')
    expect(f.card.inert).toBe(false)
  })

  it('keeps Dock read receipts concealed until every covering owner has released', () => {
    const presence = getBartPresenceCoordinator()
    const first = presence.hold(Symbol('first')), second = presence.hold(Symbol('second'))
    first(); first()
    expect(presence.isDockHidden).toBe(true)
    second()
    expect(presence.isDockHidden).toBe(false)
  })

  it('bounds preparation while allowing its late decoder to observe cancellation', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const preparation = prepareWithinBudget(value => { signal = value; return new Promise(() => {}) }, undefined, 100)
    const rejected = expect(preparation).rejects.toThrow('budget')
    await vi.advanceTimersByTimeAsync(101)
    await rejected
    expect(signal?.aborted).toBe(true)
  })

  it('rejects late sealed starts but holds an already submitted scene for a late Host', () => {
    vi.useFakeTimers()
    const f = fixture(), seal = sealMotionScene({ root: f.root, canvas: f.canvas, covered: [f.card] })
    vi.advanceTimersByTime(2001)
    expect(() => seal.show()).toThrow('budget')
    seal.release()
    const active = sealMotionScene({ root: f.root, canvas: f.canvas, covered: [f.card] })
    active.show(); vi.advanceTimersByTime(60_000)
    expect(active.owns()).toBe(true)
    expect(f.canvas.hidden).toBe(false)
    expect(f.card.inert).toBe(true)
    active.release()
  })
})
