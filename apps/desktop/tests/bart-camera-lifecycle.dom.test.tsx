// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureCameraAssets, createCameraScene, type CameraAssets } from '../src/renderer/src/bart-thread-transition/camera-scene'
import { useCameraTransition } from '../src/renderer/src/bart-thread-transition/use-camera-transition'
import { getOverviewMotionCoordinator } from '../src/renderer/src/overview-motion'

vi.mock('../src/renderer/src/bart-thread-transition/camera-scene', () => ({ captureCameraAssets: vi.fn(), createCameraScene: vi.fn() }))
let camera: ReturnType<typeof useCameraTransition>
let complete: () => void
const dispose = vi.fn(), play = vi.fn()
function assets(): CameraAssets { return { overview: document.createElement('canvas'), session: document.createElement('canvas'), dock: document.createElement('canvas') } as CameraAssets }
function Harness({ focusOverview = false }: { focusOverview?: boolean }) {
  camera = useCameraTransition()
  const filter = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => { if (focusOverview && !camera.open && !camera.busy) filter.current?.focus() }, [focusOverview, camera.open, camera.busy])
  return <div ref={camera.stageRef} data-active={camera.active} data-inside={camera.open}>
    <div data-bart-camera-overview tabIndex={-1}><button ref={filter}>Filter</button></div><button>Enter</button>
    <div data-bart-camera-session tabIndex={-1}><div className="composer"><textarea aria-label="Bart draft" /></div></div>
  </div>
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('requestAnimationFrame', vi.fn())
  vi.mocked(captureCameraAssets).mockResolvedValue(assets())
  play.mockImplementation(() => ({ started: Promise.resolve(performance.timeOrigin + performance.now()), performed: new Promise<void>(resolve => { complete = resolve }) }))
  vi.mocked(createCameraScene).mockReturnValue({ ready: Promise.resolve(), play, dispose })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
const enter = async (): Promise<void> => { await act(async () => { await camera.play(true) }) }
const land = async (): Promise<void> => { await act(async () => complete()) }

describe('Bart camera autonomous shot and native handoff', () => {
  it('submits the entire shot once without scheduling a Renderer frame', async () => {
    render(<Harness />); await enter()
    expect(play).toHaveBeenCalledExactlyOnceWith(true, 1100)
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(camera.active).toBe(true)
    await land(); expect(camera.open).toBe(true); expect(camera.active).toBe(false)
  })
  it.each([false, true])('distinguishes elapsed digits from new page content during sealing (business change: %s)', async businessChange => {
    const view = render(<Harness />)
    const overview = view.container.querySelector('[data-bart-camera-overview]')!
    const label = document.createElement('span')
    label.className = 'thread-card-rolling-number'; label.textContent = '10'
    overview.append(label)
    vi.mocked(captureCameraAssets).mockImplementation(async (_stage, _signal, seal) => {
      await seal?.()
      label.textContent = '11'
      if (businessChange) overview.querySelector('button')!.textContent = 'New business content'
      return assets()
    })
    await enter()
    if (businessChange) {
      expect(play).not.toHaveBeenCalled(); expect(camera.open).toBe(true); expect(camera.busy).toBe(false)
    } else {
      expect(play).toHaveBeenCalledOnce(); expect(camera.active).toBe(true)
      await land()
    }
  })
  it('focuses the live composer after the Worker reaches its terminal state', async () => {
    const view = render(<Harness />)
    act(() => view.getByText('Enter').focus()); await enter(); await land()
    expect(document.activeElement).toBe(view.getByLabelText('Bart draft'))
  })
  it('preserves focus explicitly requested by the destination', async () => {
    const view = render(<Harness />)
    act(() => view.getByText('Enter').focus()); await enter(); await land()
    view.rerender(<Harness focusOverview />)
    await act(async () => { await camera.play(false) }); await land()
    expect(document.activeElement).toBe(view.getByText('Filter'))
  })
  it('bounds prewarming and ignores assets arriving after static fallback', async () => {
    vi.useFakeTimers(); let resolve!: (value: CameraAssets) => void
    vi.mocked(captureCameraAssets).mockReturnValue(new Promise(yes => { resolve = yes }))
    render(<Harness />)
    let playing!: Promise<void>; act(() => { playing = camera.play(true) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10001); await playing })
    expect(camera.open).toBe(true); expect(camera.busy).toBe(false)
    await act(async () => resolve(assets()))
    expect(createCameraScene).not.toHaveBeenCalled()
  })
  it('retires a stalled post-seal capture and releases the stage at two seconds', async () => {
    vi.useFakeTimers()
    vi.mocked(captureCameraAssets).mockImplementation(async (_stage, _signal, seal) => {
      await seal?.()
      return new Promise(() => undefined)
    })
    render(<Harness />)
    let playing!: Promise<void>
    await act(async () => { playing = camera.play(true) })
    expect(camera.preparing).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(2001); await playing })
    expect(camera.open).toBe(true); expect(camera.busy).toBe(false)
    expect(createCameraScene).not.toHaveBeenCalled()
    const next = await getOverviewMotionCoordinator().acquireStage('after-expired-camera')
    next.release()
  })
  it('restores the requested destination on a viewport change', async () => {
    render(<Harness />); await enter(); act(() => window.dispatchEvent(new Event('resize')))
    expect(camera.open).toBe(true); expect(camera.busy).toBe(false); expect(dispose).toHaveBeenCalledOnce()
  })
  it('opens real business content when graphics preparation fails', async () => {
    vi.mocked(captureCameraAssets).mockRejectedValue(new Error('image decode failed'))
    render(<Harness />); await enter()
    expect(camera.open).toBe(true); expect(camera.busy).toBe(false)
  })
  it('commits the live destination before retiring the covering canvas', async () => {
    const { container } = render(<Harness />)
    const handoffs: unknown[] = []
    dispose.mockImplementation(() => handoffs.push({ ...((container.firstChild as HTMLElement).dataset) }))
    await enter(); await land()
    expect(handoffs).toEqual([{ active: 'false', inside: 'true' }])
  })
  it('ignores capture completed after a newer navigation', async () => {
    let resolve!: (value: CameraAssets) => void
    vi.mocked(captureCameraAssets).mockReturnValue(new Promise(yes => { resolve = yes }))
    render(<Harness />)
    let playing!: Promise<void>; act(() => { playing = camera.play(true) })
    expect(camera.preparing).toBe(true)
    act(() => camera.reset())
    await act(async () => { resolve(assets()); await playing })
    expect(createCameraScene).not.toHaveBeenCalled(); expect(camera.busy).toBe(false)
  })
  it('does not let an old Worker completion overwrite a newer destination', async () => {
    render(<Harness />); await enter()
    const oldComplete = complete
    await act(async () => { await camera.play(false) })
    await act(async () => oldComplete())
    expect(camera.open).toBe(false); expect(camera.busy).toBe(true)
    expect(captureCameraAssets).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
    const returnComplete = complete
    await enter()
    await act(async () => returnComplete())
    expect(camera.active).toBe(true)
    expect(play).toHaveBeenCalledTimes(3)
    await land()
    expect(camera.open).toBe(true); expect(camera.busy).toBe(false)
    expect(dispose).toHaveBeenCalledOnce()
  })
  it('still retires invalid content after reversing a shot', async () => {
    const view = render(<Harness />)
    vi.mocked(captureCameraAssets).mockImplementation(async (_stage, _signal, seal) => { await seal?.(); return assets() })
    await enter()
    await act(async () => { await camera.play(false) })
    await act(async () => { view.getByText('Filter').textContent = 'Updated content' })
    expect(camera.open).toBe(false); expect(camera.busy).toBe(false)
    expect(dispose).toHaveBeenCalledOnce()
  })
  it('releases a scene on unmount and ignores its late completion', async () => {
    const view = render(<Harness />); await enter()
    view.unmount(); await land()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
