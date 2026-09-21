// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BartDock } from '../src/renderer/src/components/BartDock'
import { getBartPresenceCoordinator } from '../src/renderer/src/bart-motion/presence'
import { CharacterCanvas } from '../src/renderer/src/bart-motion/CharacterCanvas'
import { generationSurface } from '../src/renderer/src/bart-motion/generation-surface'
import { createMotionSurface } from '../src/renderer/src/bart-motion/worker-client'

vi.mock('../src/renderer/src/bart-motion/worker-client', () => ({ createMotionSurface: vi.fn() }))
let disposed = false
const resize = vi.fn(() => { if (disposed) throw new Error('surface disposed') })
beforeEach(() => {
  disposed = false; vi.clearAllMocks()
  vi.mocked(createMotionSurface).mockReturnValue({ ready: Promise.resolve(), resize,
    character: vi.fn().mockResolvedValue(undefined), resetPreparation: vi.fn(),
    dispose: vi.fn(() => { disposed = true })
  } as unknown as ReturnType<typeof createMotionSurface>)
})
afterEach(() => { cleanup(); getBartPresenceCoordinator().reset(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('native motion surface lifetime and resolution', () => {
  it('releases a detached pool safely before a new root takes ownership', async () => {
    const root = document.createElement('main'); document.body.append(root)
    const pool = generationSurface(root), token = Symbol('scene')
    let release!: () => void
    const done = new Promise<void>(resolve => { release = resolve })
    let failure: unknown
    pool.acquire(token, () => queueMicrotask(() => {
      try { pool.release(token) } catch (error) { failure = error }
      release()
    }))
    pool.renderer(token)
    root.remove()
    await done
    expect(failure).toBeUndefined()
    expect(disposed).toBe(true)
    document.body.append(root)
    expect(generationSurface(root)).not.toBe(pool)
  })

  it('uses the rendered CSS dimensions and tracks later SVG resizing', async () => {
    vi.stubGlobal('Worker', class {})
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', { configurable: true, value: vi.fn() })
    let side = 34, changed!: ResizeObserverCallback
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: side, height: side }) as DOMRect)
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { changed = callback }
      observe() {} disconnect() {}
    })
    const view = render(<svg><CharacterCanvas width={14} height={14} description={{ activity: 'idle', phase: 'idle' }} /></svg>)
    await act(async () => undefined)
    expect(createMotionSurface).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 34, 34, 'character', expect.any(Function))
    side = 48
    await act(async () => changed([], {} as ResizeObserver))
    expect(resize).toHaveBeenLastCalledWith(48, 48)
    view.unmount()
    delete (HTMLCanvasElement.prototype as Partial<HTMLCanvasElement>).transferControlToOffscreen
  })
})


it('passes live reduced-motion preferences to the running Worker and removes the listener on unmount', async () => {
  vi.stubGlobal('Worker', class {})
  let reduced = false
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return reduced },
    addEventListener: (_: string, callback: () => void) => listeners.add(callback),
    removeEventListener: (_: string, callback: () => void) => listeners.delete(callback)
  }))
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', { configurable: true, value: vi.fn() })
  const view = render(<svg><CharacterCanvas width={210} height={210}
    description={{ activity: 'idle', phase: 'running', role: 'running' }} /></svg>)
  const renderer = vi.mocked(createMotionSurface).mock.results.at(-1)!.value
  await act(async () => undefined)
  expect(renderer.character).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'running', animate: true }))
  await act(async () => { reduced = true; listeners.forEach(listener => listener()) })
  expect(renderer.character).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'running', animate: false }))
  await act(async () => { reduced = false; listeners.forEach(listener => listener()) })
  expect(renderer.character).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'running', animate: true }))
  view.unmount()
  expect(listeners.size).toBe(0)
  delete (HTMLCanvasElement.prototype as Partial<HTMLCanvasElement>).transferControlToOffscreen
})


it('stops the running Worker when its Dock is covered, and resumes from current state when revealed', async () => {
  vi.stubGlobal('Worker', class {})
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', { configurable: true, value: vi.fn() })
  const noop = () => {}
  const element = (covered: boolean) => <BartDock
    activityContext={{ threadKey: 'bart', execution: { executionId: 'running', status: 'running' } }}
    threadOpen={false} inputOpen={false} inputValue="" bartAttachments={[]}
    running sessionIdle={false} presentationCovered={covered}
    onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
    onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop} />
  const view = render(element(false))
  const renderer = vi.mocked(createMotionSurface).mock.results.at(-1)!.value
  await act(async () => undefined)
  expect(renderer.character).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'running', animate: true }))
  await act(async () => view.rerender(element(true)))
  expect(renderer.character).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'running', animate: false }))
  await act(async () => view.rerender(element(false)))
  expect(renderer.character).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'running', animate: true }))
  view.unmount()
  expect(renderer.dispose).toHaveBeenCalledOnce()
  delete (HTMLCanvasElement.prototype as Partial<HTMLCanvasElement>).transferControlToOffscreen
})
