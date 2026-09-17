// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { OverviewCameraCockpit } from '../src/renderer/src/overview-motion/camera'
import {
  getOverviewMotionCoordinator,
  OverviewMotionCoordinator
} from '../src/renderer/src/overview-motion/coordinator'
import { fitOverviewCanvasTransform } from '../src/shared/thread-overview-canvas'

describe('overview motion invariants', () => {
  it('单卡片也由摄像机按工具栏下沿与固定留白取景', () => {
    const camera = new OverviewCameraCockpit()
    const viewport = { width: 1000, height: 800, toolbarBottom: 58 }
    camera.cutTo({ left: 0, top: 0, width: 360, height: 200 }, viewport)
    expect(camera.getSnapshot()?.transform).toEqual({ scale: 1, x: 320, y: 279.6 })
    camera.dispose()
  })

  it('当前队列项展开的节拍紧邻执行，不被已等待的其他来源插播', async () => {
    const coordinator = new OverviewMotionCoordinator()
    const planning = await coordinator.acquireStage('overview-layout:plan')
    const bart = coordinator.acquireStage('bart-generation:thread')
    const [reflow, entry] = coordinator.reserveStagesAfter(
      planning,
      ['overview-layout:reflow', 'overview-layout:entry']
    )

    planning.release()
    const reflowLease = await reflow
    expect(reflowLease.owner).toBe('overview-layout:reflow')
    reflowLease.release()
    const entryLease = await entry
    expect(entryLease.owner).toBe('overview-layout:entry')
    entryLease.release()
    const bartLease = await bart
    expect(bartLease.owner).toBe('bart-generation:thread')
    bartLease.release()
  })

  it('舞台租约严格 FIFO，等待者取消后不会阻塞后继', async () => {
    const coordinator = new OverviewMotionCoordinator()
    const first = await coordinator.acquireStage('first')
    const cancelled = new AbortController()
    const second = coordinator.acquireStage('second', cancelled.signal)
    const third = coordinator.acquireStage('third')
    cancelled.abort()
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    first.release()
    const acquiredThird = await third
    expect(acquiredThird.owner).toBe('third')
    acquiredThird.release()
  })

  it('当前租约释放到真正 idle 时发出通知', async () => {
    const coordinator = new OverviewMotionCoordinator()
    const onIdle = vi.fn()
    coordinator.subscribeStageIdle(onIdle)
    const lease = await coordinator.acquireStage('first')

    expect(coordinator.stageBusy).toBe(true)
    expect(onIdle).not.toHaveBeenCalled()
    lease.release()

    expect(coordinator.stageBusy).toBe(false)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('连续排队 lease 交接时不发布中间 idle', async () => {
    const coordinator = new OverviewMotionCoordinator()
    const onIdle = vi.fn()
    coordinator.subscribeStageIdle(onIdle)
    const first = await coordinator.acquireStage('first')
    const secondPromise = coordinator.acquireStage('second')
    const thirdPromise = coordinator.acquireStage('third')

    first.release()
    const second = await secondPromise
    expect(coordinator.stageBusy).toBe(true)
    expect(onIdle).not.toHaveBeenCalled()

    second.release()
    const third = await thirdPromise
    expect(coordinator.stageBusy).toBe(true)
    expect(onIdle).not.toHaveBeenCalled()

    third.release()
    expect(coordinator.stageBusy).toBe(false)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('scene cut 广播代次，平面映射支持可逆坐标换算', () => {
    const coordinator = new OverviewMotionCoordinator()
    const listener = vi.fn()
    coordinator.onSceneCut(listener)
    expect(coordinator.cutScene()).toBe(1)
    expect(listener).toHaveBeenCalledWith(1, undefined)
    expect(coordinator.cutScene('bart-cross-page')).toBe(2)
    expect(listener).toHaveBeenLastCalledWith(2, 'bart-cross-page')

    coordinator.setCameraView(true, { scale: 0.8, x: 120, y: 40 })
    const root = coordinator.planePointToRoot({ x: 50, y: 25 })
    expect(coordinator.rootPointToPlane(root)).toEqual({ x: 50, y: 25 })
  })

  it('舞台被占时进入 canvas 直接对齐 fit，不让取景排队', async () => {
    const coordinator = getOverviewMotionCoordinator()
    const camera = new OverviewCameraCockpit()
    const content = { left: 0, top: 0, width: 800, height: 700 }
    const viewport = { width: 800, height: 500 }
    // 入场取景若排在 Bart 飞行后面，用户会面对已接管滚动却仍未取景的裁切视图。
    const lease = await coordinator.acquireStage('bart-generation:departure')

    camera.reconcileBounds(content, viewport)

    expect(camera.getSnapshot()?.transform).toEqual(
      fitOverviewCanvasTransform(content, viewport)
    )
    lease.release()
    camera.dispose()
  })

  it('用户接管后小布局仍保留手动视角，显式回到自动才交还驾驶权', () => {
    const camera = new OverviewCameraCockpit()
    const viewport = { width: 800, height: 500 }
    camera.reconcileBounds({ left: 0, top: 0, width: 800, height: 700 }, viewport)
    camera.setManualTransform({ scale: 0.72, x: 18, y: -24 })

    camera.reconcileBounds({ left: 0, top: 0, width: 600, height: 300 }, viewport)
    expect(camera.getSnapshot()).toMatchObject({ manual: true, transform: { scale: 0.72, x: 18, y: -24 } })

    camera.returnToAuto({ left: 0, top: 0, width: 600, height: 300 }, viewport)
    expect(camera.getSnapshot()).toMatchObject({ manual: false })
    camera.dispose()
  })

  it('切场景自动取景，内容是否溢出不影响切换规则', () => {
    const camera = new OverviewCameraCockpit()
    const viewport = { width: 1000, height: 800, toolbarBottom: 58 }
    const compact = { left: 0, top: 0, width: 360, height: 200 }
    camera.cutTo(compact, viewport)
    camera.setManualTransform({ scale: 0.6, x: -900, y: 20 })
    camera.cutTo(compact, viewport)
    expect(camera.getSnapshot()).toMatchObject({ manual: false, transform: { scale: 1, x: 320, y: 279.6 } })
    camera.dispose()
  })
})
