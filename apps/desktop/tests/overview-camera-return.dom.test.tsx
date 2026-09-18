// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { OverviewCameraCockpit } from '../src/renderer/src/overview-motion/camera'
import { getOverviewMotionCoordinator } from '../src/renderer/src/overview-motion/coordinator'
import { fitOverviewCanvasTransform } from '../src/shared/thread-overview-canvas'

const viewport = { width: 1000, height: 800, toolbarBottom: 58 }
const card = { left: 0, top: 0, width: 360, height: 200 }
const cameras: OverviewCameraCockpit[] = []
function createCamera(): OverviewCameraCockpit {
  const camera = new OverviewCameraCockpit()
  const plane = document.createElement('div')
  plane.animate = vi.fn((_frames, options) => {
    const duration = Number((options as KeyframeAnimationOptions).duration)
    let resolve!: () => void, reject!: () => void
    const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    const timer = setTimeout(resolve, duration)
    return { finished, startTime: null, cancel: () => { clearTimeout(timer); reject() } } as unknown as Animation
  })
  camera.bindPlane(plane)
  return camera
}
afterEach(() => { cameras.forEach(camera => camera.dispose()); cameras.length = 0; vi.restoreAllMocks(); vi.useRealTimers() })

it('返回观察和已知取景一次提交，期间的新布局在落定后补取景', async () => {
  vi.useFakeTimers()
  const camera = createCamera()
  cameras.push(camera)
  const saved = { manual: false, transform: { scale: 1, x: 320, y: 279.6 } }
  camera.restore(saved, card, viewport)
  expect(camera.live).toEqual(saved)
  await vi.advanceTimersByTimeAsync(16)
  const changed = { ...card, width: 736, height: 416 }
  camera.reconcileBounds(changed, viewport)
  camera.requestRefit(changed, viewport)
  await camera.reveal({ ...card, top: 2000 }, changed, viewport)
  await vi.advanceTimersByTimeAsync(580)
  expect(camera.live).toEqual(saved)
  await vi.advanceTimersByTimeAsync(1100)
  expect(camera.live?.manual).toBe(false)
  expect(camera.live?.transform.x).toBe(132)
  expect(camera.live?.transform.y).toBeCloseTo(193.2)
})

it('转场预挂载期间不计时，真正可见后才开始返回停留', async () => {
  vi.useFakeTimers()
  const camera = createCamera()
  cameras.push(camera)
  camera.setVisible(false)
  const saved = { manual: false, transform: { scale: 0.7, x: -200, y: 30 } }
  camera.restore(saved, card, viewport)
  await vi.advanceTimersByTimeAsync(2000)
  expect(camera.live).toEqual(saved)
  camera.setVisible(true)
  await vi.advanceTimersByTimeAsync(600)
  expect(camera.live).toEqual(saved)
  await vi.advanceTimersByTimeAsync(420)
  expect(camera.live?.transform).toEqual({ scale: 1, x: 320, y: 279.6 })
})

it('返回动画期间窗口和工具栏变化，结束后继续跟随最新取景', async () => {
  vi.useFakeTimers()
  const camera = createCamera()
  cameras.push(camera)
  const content = { ...card, width: 736, height: 416 }
  camera.restore({ manual: false, transform: { scale: 0.7, x: -200, y: 30 } }, content, viewport)
  await vi.advanceTimersByTimeAsync(740)
  const narrow = { width: 500, height: 600, toolbarBottom: 110 }
  camera.requestRefit(content, narrow)
  await vi.advanceTimersByTimeAsync(1300)
  expect(camera.live?.transform).toEqual(fitOverviewCanvasTransform(content, narrow))
})

it.each(['manual', 'scene', 'dispose'] as const)('返回等待可由 %s 取消，旧计时不会移动新视角', async (action) => {
  vi.useFakeTimers()
  const camera = createCamera()
  cameras.push(camera)
  camera.restore({ manual: false, transform: { scale: 0.7, x: -200, y: 30 } }, card, viewport)
  await vi.advanceTimersByTimeAsync(200)
  if (action === 'manual') camera.setManualTransform({ scale: 0.8, x: 2000, y: -800 })
  else if (action === 'scene') camera.cutTo({ ...card, width: 736 }, viewport)
  else camera.dispose()
  const expected = camera.live
  await vi.advanceTimersByTimeAsync(2000)
  expect(camera.live).toEqual(expected)
})

it('返回手动视角持续保持，普通取景和 reveal 不接管', async () => {
  vi.useFakeTimers()
  const camera = createCamera()
  cameras.push(camera)
  const saved = { manual: true, transform: { scale: 0.6, x: 3000, y: -80 } }
  camera.restore(saved, card, viewport)
  camera.requestRefit({ ...card, width: 2000 }, viewport)
  await camera.reveal(card, card, viewport)
  await vi.advanceTimersByTimeAsync(2000)
  expect(camera.live).toEqual(saved)
})

it('到期后仍等待既有舞台节拍，取得舞台才读取最新目标', async () => {
  vi.useFakeTimers()
  const camera = createCamera()
  cameras.push(camera)
  const lease = await getOverviewMotionCoordinator().acquireStage('bart:test-return')
  const saved = { manual: false, transform: { scale: 0.7, x: -200, y: 30 } }
  try {
    camera.restore(saved, card, viewport)
    await vi.advanceTimersByTimeAsync(800)
    expect(camera.live).toEqual(saved)
    camera.requestRefit({ ...card, width: 736, height: 416 }, viewport)
    lease.release()
    await vi.advanceTimersByTimeAsync(400)
    expect(camera.live?.transform.x).toBe(132)
    expect(camera.live?.transform.y).toBeCloseTo(193.2)
  } finally { lease.release() }
})
