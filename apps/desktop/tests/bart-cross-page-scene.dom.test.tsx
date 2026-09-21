// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BartCrossPageFlight, type BartFlightDirection } from '../src/renderer/src/components/BartCrossPageFlight'
import { getOverviewMotionCoordinator } from '../src/renderer/src/overview-motion'
import type { MotionProgram } from '../src/renderer/src/bart-motion/worker-types'
import type { MotionRun } from '../src/renderer/src/bart-motion/worker-client'

const mocks = vi.hoisted(() => ({ surface: vi.fn() }))
vi.mock('../src/renderer/src/bart-motion/worker-client', () => ({ createMotionSurface: mocks.surface }))
vi.mock('../src/renderer/src/bart-motion/CharacterCanvas', () => ({
  residentCharacter: (element: Element) => ({
    id: element.closest('.bart-dock') ? 'dock' : 'seat', ready: async () => {},
    description: () => ({ activity: 'idle', phase: 'idle', layout: 'mark' })
  })
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const offscreen = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'transferControlToOffscreen')
const nativeAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
const nativeTimeline = Object.getOwnPropertyDescriptor(document, 'timeline')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const startedAt = Date.now()
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - startedAt)
  vi.stubGlobal('Worker', class {})
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', { configurable: true, value: vi.fn() })
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => ({ startTime: 0, cancel: vi.fn() }) })
  // jsdom supplies neither a compositor nor its timeline. Keep both clocks
  // on the same fake epoch when exercising the real redirect compiler.
  Object.defineProperty(document, 'timeline', { configurable: true, value: { get currentTime() { return performance.now() } } })
  performance.clearMarks()
})
afterEach(async () => {
  cleanup()
  document.body.replaceChildren()
  await act(async () => {})
  for (const [prototype, key, descriptor] of [
    [HTMLCanvasElement.prototype, 'transferControlToOffscreen', offscreen],
    [Element.prototype, 'getAnimations', nativeAnimations],
    [Element.prototype, 'animate', nativeAnimate],
    [document, 'timeline', nativeTimeline]
  ] as const) {
    if (descriptor) Object.defineProperty(prototype, key, descriptor)
    else Reflect.deleteProperty(prototype, key)
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetAllMocks(); vi.useRealTimers()
})
async function advance(milliseconds = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}

function fixture() {
  const root = document.createElement('main')
  root.className = 'app-shell'
  root.innerHTML = '<div class="bart-dock" data-layout="mark"><div class="bart-dock-logo-motion"><svg class="bart-logo"></svg></div></div>' +
    '<div class="bart-host-body"><div class="bart-host-character"><svg class="bart-logo"></svg></div></div><div class="flight-host"></div>'
  document.body.append(root)
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 800))
  root.querySelectorAll('svg').forEach((svg, index) => {
    const matrix = { a: .2, b: 0, c: 0, d: .2, e: index ? 150 : 600, f: index ? 80 : 600 }
    Object.assign(svg, { getScreenCTM: () => matrix })
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(matrix.e, matrix.f, 128, 128))
  })
  const hooks: { land?: () => Promise<void> } = {}
  const runs: { handle: MotionRun; done: ReturnType<typeof deferred<void>>; release: ReturnType<typeof vi.fn>; land: ReturnType<typeof vi.fn> }[] = []
  const makeRun = (): MotionRun => {
    const done = deferred<void>(), release = vi.fn(), land = vi.fn(async () => { await hooks.land?.() })
    const handle: MotionRun = { started: Promise.resolve(performance.timeOrigin + performance.now()),
      performed: done.promise, release, landCharacter: land, redirect: () => makeRun() }
    runs.push({ handle, done, release, land })
    return handle
  }
  const surface = {
    ready: Promise.resolve(), resize: vi.fn(), dispose: vi.fn(), resetPreparation: vi.fn(),
    load: vi.fn(async () => {}), borrowCharacter: vi.fn(async () => {}), play: vi.fn((_program: MotionProgram) => makeRun())
  }
  mocks.surface.mockReturnValue(surface)
  const onActiveChange = vi.fn()
  return { root, runs, hooks, surface, onActiveChange,
    host: root.querySelector<HTMLElement>('.flight-host')!,
    canvas: () => root.querySelector<HTMLCanvasElement>('canvas')!,
    element: (direction: BartFlightDirection, readyToLand = true) =>
      <BartCrossPageFlight direction={direction} readyToLand={readyToLand} onActiveChange={onActiveChange} /> }
}

describe('cross-page scene through its production React adapter', () => {
  it('holds the completed flight until the real page is ready to receive it', async () => {
    const f = fixture()
    const view = render(f.element('to-seat', false), { container: f.host })
    await advance()
    expect(f.surface.borrowCharacter).toHaveBeenCalledTimes(1)
    expect(f.canvas().hidden).toBe(false)
    f.runs[0]!.done.resolve(); await advance()
    expect(f.runs[0]!.land).not.toHaveBeenCalled()
    expect(f.canvas().hidden).toBe(false)
    view.rerender(f.element('to-seat', true)); await advance()
    expect(f.runs[0]!.land).toHaveBeenCalledTimes(1)
    expect(f.runs[0]!.release).toHaveBeenCalledTimes(1)
    expect(f.onActiveChange.mock.calls).toEqual([[true, 'to-seat'], [false, 'to-seat']])
    expect(f.canvas().hidden).toBe(true)
    expect(getOverviewMotionCoordinator().stageBusy).toBe(false)
  })

  it('reuses one surface across reversals and ignores superseded completions', async () => {
    const f = fixture(), view = render(f.element('to-seat'), { container: f.host })
    await advance()
    const canvas = f.canvas()
    view.rerender(f.element('to-dock')); await advance(20)
    view.rerender(f.element('to-seat')); await advance(20)
    expect(f.runs).toHaveLength(3)
    expect(f.canvas()).toBe(canvas)
    expect(f.surface.borrowCharacter).toHaveBeenCalledTimes(1)
    f.runs[0]!.done.resolve(); f.runs[1]!.done.resolve(); await advance()
    expect(f.runs[0]!.land).not.toHaveBeenCalled()
    expect(f.runs[1]!.land).not.toHaveBeenCalled()
    expect(canvas.hidden).toBe(false)
    f.runs[2]!.done.resolve(); await advance()
    expect(f.runs[2]!.land).toHaveBeenCalledTimes(1)
    expect(f.onActiveChange.mock.calls.filter(([active]) => !active)).toEqual([[false, 'to-seat']])
    expect(canvas.hidden).toBe(true)
  })

  it('does not hand off twice when unmounted during a delayed landing', async () => {
    const f = fixture(), landed = deferred<void>()
    f.hooks.land = () => landed.promise
    const view = render(f.element('to-seat'), { container: f.host })
    await advance()
    f.runs[0]!.done.resolve(); await advance()
    expect(f.runs[0]!.land).toHaveBeenCalledTimes(1)
    view.unmount()
    landed.resolve(); await advance()
    expect(f.runs[0]!.release).toHaveBeenCalledTimes(1)
    expect(f.onActiveChange.mock.calls.filter(([active]) => !active)).toEqual([[false, 'to-seat']])
    expect(getOverviewMotionCoordinator().stageBusy).toBe(false)
  })

  it('survives its own navigation cut but retires safely on another scene cut', async () => {
    const f = fixture()
    render(f.element('to-seat'), { container: f.host }); await advance()
    getOverviewMotionCoordinator().cutScene('bart-cross-page'); await advance()
    expect(f.canvas().hidden).toBe(false)
    getOverviewMotionCoordinator().cutScene(); await advance()
    expect(f.canvas().hidden).toBe(true)
    f.runs[0]!.done.resolve(); await advance()
    expect(f.runs[0]!.land).not.toHaveBeenCalled()
    expect(f.runs[0]!.release).toHaveBeenCalledTimes(1)
  })

  it('expires blocked preparation without replaying a late renderer readiness', async () => {
    const f = fixture(), ready = deferred<void>()
    f.surface.ready = ready.promise
    render(f.element('to-seat'), { container: f.host }); await advance(251)
    expect(f.onActiveChange.mock.calls.filter(([active]) => !active)).toEqual([[false, 'to-seat']])
    ready.resolve(); await advance()
    expect(f.surface.play).not.toHaveBeenCalled()
    expect(f.surface.borrowCharacter).not.toHaveBeenCalled()
    expect(getOverviewMotionCoordinator().stageBusy).toBe(false)
  })

  it('commits a parent-driven unmount once while the covering frame is still visible', async () => {
    const f = fixture(), callbacks: boolean[] = []
    function Owner() {
      const [visible, setVisible] = useState(true)
      return visible ? <BartCrossPageFlight direction="to-seat" onActiveChange={active => {
        callbacks.push(active)
        if (!active) { expect(f.canvas().hidden).toBe(false); setVisible(false) }
      }} /> : null
    }
    render(<Owner />, { container: f.host }); await advance()
    f.runs[0]!.done.resolve(); await advance()
    expect(callbacks).toEqual([true, false])
    expect(f.canvas().hidden).toBe(true)
    expect(f.runs[0]!.release).toHaveBeenCalledTimes(1)
  })

  it('restores native transitions before a landing commit measures its new roster', async () => {
    const f = fixture()
    const seat = f.root.querySelector<HTMLElement>('.bart-host-character')!
    seat.style.transition = 'transform 720ms ease'
    const handoff = vi.fn((active: boolean) => {
      if (active) return
      // Settings layout effects read the seat inside the synchronous handoff.
      // Restoring transition only after that commit makes a new roster snap.
      expect(seat.style.transition).toBe('transform 720ms ease')
      expect(seat.style.visibility).toBe('hidden')
      expect(seat.inert).toBe(true)
      expect(f.canvas().hidden).toBe(false)
      seat.style.transform = 'translateX(250px)'
      expect(getComputedStyle(seat).transform).toBe('translateX(250px)')
    })
    render(<BartCrossPageFlight direction="to-seat" onActiveChange={handoff} />, { container: f.host })
    await advance()
    expect(seat.style.transition).toBe('none')
    f.runs[0]!.done.resolve(); await advance()
    expect(handoff.mock.calls).toEqual([[true, 'to-seat'], [false, 'to-seat']])
    expect(seat.style.transform).toBe('translateX(250px)')
    expect(seat.style.transition).toBe('transform 720ms ease')
    expect(seat.style.visibility).toBe('')
    expect(f.canvas().hidden).toBe(true)
  })
})
