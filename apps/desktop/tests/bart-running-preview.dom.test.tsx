// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RunningPreview } from '../labs/bart/src/running'
import { initialConfig } from '../labs/bart/src/scenarios'
import { createCanvasCharacter } from '../src/renderer/src/bart-motion/character-canvas'

vi.mock('../src/renderer/src/bart-motion/character-canvas', () => ({ createCanvasCharacter: vi.fn() }))
let frame: FrameRequestCallback | undefined, resize: ResizeObserverCallback
let preference: () => void, reduced = false, now = 1000
const paint = vi.fn(), update = vi.fn()
beforeEach(() => {
  frame = undefined; reduced = false; now = 1000; vi.clearAllMocks()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback }
    observe() {} disconnect() {}
  })
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced },
    addEventListener: (_: string, callback: () => void) => { preference = callback }, removeEventListener: vi.fn() }))
  vi.stubGlobal('OffscreenCanvas', class { getContext() { return { clearRect: vi.fn() } } })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn()
  } as unknown as CanvasRenderingContext2D)
  vi.mocked(createCanvasCharacter).mockReturnValue({ paint, update } as unknown as ReturnType<typeof createCanvasCharacter>)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps the paused native frame and lights unchanged on inspector and resize redraws, then resumes', () => {
  const config = { ...initialConfig, scene: 'running' as const, variant: 'bottom' }
  const view = render(<RunningPreview config={config} />)
  for (let i = 0; i < 300; i++) act(() => { now += 16; frame?.(now) })
  const lights = () => Array.from(view.container.querySelectorAll('.running-dots i'), dot => dot.getAttribute('style'))
  const orbit = lights(), painted = paint.mock.calls.length
  view.rerender(<RunningPreview config={{ ...config, runningPaused: true }} />)
  now += 60000
  act(() => resize([], {} as ResizeObserver))
  view.rerender(<RunningPreview config={{ ...config, runningPaused: true, guides: true, runningCycle: 4 }} />)
  expect(paint).toHaveBeenCalledTimes(painted)
  expect(lights()).toEqual(orbit)
  expect(frame).toBeUndefined()
  view.rerender(<RunningPreview config={config} />)
  expect(lights()).toEqual(orbit)
  act(() => { now += 16; frame?.(now) })
  expect(lights()).not.toEqual(orbit)
  expect(paint.mock.calls.length).toBeGreaterThan(painted)
})

it('renders one static character frame for reduced motion and reuses it across redraws', () => {
  const view = render(<RunningPreview config={initialConfig} />)
  act(() => { reduced = true; preference() })
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ animate: false }))
  const painted = paint.mock.calls.length
  now += 60000
  act(() => resize([], {} as ResizeObserver))
  view.rerender(<RunningPreview config={{ ...initialConfig, guides: true }} />)
  expect(paint).toHaveBeenCalledTimes(painted)
  expect(frame).toBeUndefined()
})
