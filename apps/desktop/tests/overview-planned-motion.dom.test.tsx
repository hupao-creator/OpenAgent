// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { plannedOverviewMotionBeats } from '../src/renderer/src/overview-motion/planned-layout-motion'
import { stageOverviewLayoutMotion } from '../src/renderer/src/overview-motion'
import { ConversationOverview } from '../src/renderer/src/components/ConversationOverview'
import { deriveOverviewItems, overviewLayoutSnapshot } from '../src/renderer/src/conversation-overview-layout'
import type { BartGenerationWork } from '../src/renderer/src/components/BartThreadGeneration'
import { OverviewCameraCockpit } from '../src/renderer/src/overview-motion/camera'
import type { OverviewCameraMemory } from '../src/renderer/src/overview-motion/camera'
import { getOverviewMotionCoordinator } from '../src/renderer/src/overview-motion/coordinator'
import { layoutOverview, LayoutSearchLimitError } from '../src/renderer/src/overview-layout'
import type { OverviewLayoutPlanningState } from '../src/renderer/src/overview-layout-planner'
import type { OverviewLayoutRequest, OverviewLayoutResponse } from '../src/renderer/src/overview-layout-worker'
import type { RendererReport } from '../src/shared/renderer-state-contracts'
import { createOverviewOrchestrationStore } from '../src/renderer/src/overview-orchestration-store'
import { fitOverviewCanvasTransform } from '../src/shared/thread-overview-canvas'

afterEach(() => { cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('plans queued revisions against the preceding presented layout and cancels a pending scene', async () => {
  const workers: DelayedWorker[] = []
  class DelayedWorker {
    onmessage?: ((event: MessageEvent<OverviewLayoutResponse>) => void) | null
    onerror?: ((event: { message: string }) => void) | null
    request!: OverviewLayoutRequest
    terminate = vi.fn()
    constructor() { workers.push(this) }
    postMessage(value: OverviewLayoutRequest) { this.request = value }
    finish() {
      const { previous, next, geometry } = this.request
      const plan = layoutOverview(previous, next, geometry)
      this.onmessage?.({ data: { plan } } as MessageEvent<OverviewLayoutResponse>)
      return plan
    }
  }
  vi.stubGlobal('Worker', DelayedWorker)
  const reports = makeReports(4)
  const common = { threads: [], motionSceneKey: 'all', transitionId: null,
    interrupt: async () => {}, respond: async () => {}, onSelect: () => {} }
  const view = render(<ConversationOverview {...common} reports={reports.slice(0, 1)} />)
  view.rerender(<ConversationOverview {...common} reports={reports.slice(0, 2)} />)
  await waitFor(() => expect(workers).toHaveLength(1))
  view.rerender(<ConversationOverview {...common} reports={reports.slice(0, 3)} />)
  expect(workers).toHaveLength(1)
  expect(document.querySelectorAll('[data-overview-card-id]')).toHaveLength(1)
  let firstPlan!: ReturnType<typeof layoutOverview>
  await act(async () => { firstPlan = workers[0]!.finish() })
  await waitFor(() => expect(workers).toHaveLength(2))
  expect(workers[1]!.request.previous).toEqual(firstPlan.placements)
  expect(document.querySelectorAll('[data-overview-card-id]')).toHaveLength(2)
  await act(async () => { workers[1]!.finish() })
  await waitFor(() => expect(document.querySelectorAll('[data-overview-card-id]')).toHaveLength(3))
  await waitFor(() => expect(getOverviewMotionCoordinator().stageBusy).toBe(false))
  view.rerender(<ConversationOverview {...common} reports={reports} />)
  await waitFor(() => expect(workers).toHaveLength(3))
  const staleResponse = workers[2]!.onmessage!
  view.rerender(<ConversationOverview {...common} motionSceneKey="filtered" reports={reports.slice(0, 1)} />)
  expect(workers[2]!.terminate).toHaveBeenCalledTimes(1)
  await act(async () => { staleResponse({ data: { error: 'late result from old scene' } } as MessageEvent<OverviewLayoutResponse>) })
  expect(document.querySelectorAll('[data-overview-card-id]')).toHaveLength(1)
  expect(view.queryByRole('alert')).toBeNull()
  await waitFor(() => expect(getOverviewMotionCoordinator().stageBusy).toBe(false))
})

it('binds the camera when the first card arrives and when filtering replaces its plane', async () => {
  for (const [property, size] of [['clientWidth', 1000], ['clientHeight', 800], ['offsetWidth', 360], ['offsetHeight', 200]] as const) {
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains(property.startsWith('client') ? 'thread-overview-scroll' : 'thread-overview-grid') ||
        (!property.startsWith('client') && this.hasAttribute('data-overview-card-id')) ? size : 0
    })
  }
  const common = { threads: [], transitionId: null, interrupt: async () => {}, respond: async () => {}, onSelect: () => {} }
  const reports = makeReports(1)
  const view = render(<StrictMode><ConversationOverview {...common} reports={[]} /></StrictMode>)
  expect(document.querySelector('.thread-overview-plane')).toBeNull()
  view.rerender(<StrictMode><ConversationOverview {...common} reports={reports} /></StrictMode>)
  await waitFor(() => expect(document.querySelector<HTMLElement>('.thread-overview-plane')?.style.transform).toBe('translate(320px, 244.8px) scale(1)'))
  const first = document.querySelector('.thread-overview-plane')
  const tagged = reports.map(report => ({ ...report, tags: ['work'] }))
  view.rerender(<StrictMode><ConversationOverview {...common} reports={tagged} selectedTag="work" /></StrictMode>)
  await waitFor(() => {
    const plane = document.querySelector<HTMLElement>('.thread-overview-plane')
    expect(plane).not.toBe(first)
    expect(plane?.style.transform).toBe('translate(320px, 244.8px) scale(1)')
  })
  fireEvent.wheel(document.querySelector('.thread-overview-scroll')!, { clientX: 500, clientY: 400, deltaY: 300 })
  expect(document.querySelector<HTMLElement>('.thread-overview-plane')?.style.transform).not.toBe('translate(320px, 244.8px) scale(1)')
})

it('单卡片在真实 Overview 入口避让工具栏，并允许拖出视野后找回', async () => {
  for (const [property, size] of [['clientWidth', 1000], ['clientHeight', 800], ['offsetWidth', 360], ['offsetHeight', 200]] as const) {
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains(property.startsWith('client') ? 'thread-overview-scroll' : 'thread-overview-grid') ||
        (!property.startsWith('client') && this.hasAttribute('data-overview-card-id')) ? size : 0
    })
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { left: 0, top: 0, bottom: this.classList.contains('thread-overview-header') ? 58 : 800,
      right: 1000, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}) }
  })
  const view = render(<ConversationOverview threads={[]} reports={makeReports(1)} transitionId={null}
    interrupt={async () => {}} respond={async () => {}} onSelect={() => {}} />)
  const plane = document.querySelector<HTMLElement>('.thread-overview-plane')!
  await waitFor(() => expect(plane.style.transform).toBe('translate(320px, 279.6px) scale(1)'))
  const scroll = document.querySelector<HTMLElement>('.thread-overview-scroll')!
  scroll.setPointerCapture = () => {}
  scroll.hasPointerCapture = () => false
  scroll.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 500 }))
  await act(async () => {
    scroll.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 2100, clientY: 500 }))
    scroll.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
  })
  expect(plane.style.transform).toBe('translate(2320px, 279.6px) scale(1)')
  fireEvent.click(view.getByRole('button', { name: '回到自动视图' }))
  await waitFor(() => expect(plane.style.transform).toBe('translate(320px, 279.6px) scale(1)'))
})

it('空白处单击交还自动视角，拖拽平移保留手动视角', async () => {
  for (const [property, size] of [['clientWidth', 1000], ['clientHeight', 800], ['offsetWidth', 360], ['offsetHeight', 200]] as const) {
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains(property.startsWith('client') ? 'thread-overview-scroll' : 'thread-overview-grid') ||
        (!property.startsWith('client') && this.hasAttribute('data-overview-card-id')) ? size : 0
    })
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { left: 0, top: 0, bottom: this.classList.contains('thread-overview-header') ? 58 : 800,
      right: 1000, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}) }
  })
  const view = render(<ConversationOverview threads={[]} reports={makeReports(1)} transitionId={null}
    interrupt={async () => {}} respond={async () => {}} onSelect={() => {}} />)
  const plane = document.querySelector<HTMLElement>('.thread-overview-plane')!
  const auto = 'translate(320px, 279.6px) scale(1)'
  await waitFor(() => expect(plane.style.transform).toBe(auto))
  const scroll = document.querySelector<HTMLElement>('.thread-overview-scroll')!
  scroll.setPointerCapture = () => {}
  scroll.hasPointerCapture = () => false
  const pointer = (type: string, clientX: number, clientY: number, pointerId: number): MouseEvent => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY })
    Object.defineProperty(event, 'pointerId', { value: pointerId })
    return event
  }
  const send = async (type: string, clientX: number, clientY: number, pointerId = 1): Promise<void> => {
    await act(async () => { scroll.dispatchEvent(pointer(type, clientX, clientY, pointerId)) })
  }
  const gesture = async (points: readonly (readonly [number, number])[], pointerId = 1): Promise<void> => {
    const [first, ...rest] = points
    await send('pointerdown', first[0], first[1], pointerId)
    for (const [clientX, clientY] of rest) await send('pointermove', clientX, clientY, pointerId)
    await send('pointerup', 0, 0, pointerId)
  }
  // 自动视角下的空白单击不是切换动作。
  await gesture([[100, 500]])
  expect(plane.style.transform).toBe(auto)
  // 拖拽空白进入手动视角；抬指不回落自动。
  await gesture([[100, 500], [2100, 500]])
  expect(plane.style.transform).toBe('translate(2320px, 279.6px) scale(1)')
  expect(view.getByRole('button', { name: '回到自动视图' })).toBeTruthy()
  // 第二根手指不是这份手势的主人，它自己的抬指不能冒充空白单击。
  await send('pointerdown', 100, 500)
  await send('pointerdown', 400, 300, 2)
  await send('pointerup', 400, 300, 2)
  expect(plane.style.transform).toBe('translate(2320px, 279.6px) scale(1)')
  expect(view.getByRole('button', { name: '回到自动视图' })).toBeTruthy()
  // 只按不拖：交还自动视角。
  await send('pointerdown', 100, 500)
  await send('pointerup', 100, 500)
  await waitFor(() => expect(plane.style.transform).toBe(auto))
  expect(view.queryByRole('button', { name: '回到自动视图' })).toBeNull()
})

it('Overview 卸载再挂载首帧恢复手动视角，切集合时重新取景', async () => {
  for (const [property, size] of [['clientWidth', 1000], ['clientHeight', 800], ['offsetWidth', 360], ['offsetHeight', 200]] as const) {
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains(property.startsWith('client') ? 'thread-overview-scroll' : 'thread-overview-grid') ||
        (!property.startsWith('client') && this.hasAttribute('data-overview-card-id')) ? size : 0
    })
  }
  const memory: OverviewCameraMemory = { current: null }
  const common = { threads: [], reports: makeReports(1), cameraMemory: memory, motionSceneKey: 'all',
    transitionId: null, interrupt: async () => {}, respond: async () => {}, onSelect: () => {} }
  const first = render(<ConversationOverview {...common} />)
  fireEvent.wheel(document.querySelector('.thread-overview-scroll')!, { clientX: 500, clientY: 400, deltaY: 300 })
  const saved = document.querySelector<HTMLElement>('.thread-overview-plane')!.style.transform
  expect(first.getByRole('button', { name: '回到自动视图' })).toBeTruthy()
  first.unmount()
  const second = render(<ConversationOverview {...common} />)
  expect(document.querySelector<HTMLElement>('.thread-overview-plane')!.style.transform).toBe(saved)
  expect(second.getByRole('button', { name: '回到自动视图' })).toBeTruthy()
  second.rerender(<ConversationOverview {...common} motionSceneKey="new-collection" />)
  await waitFor(() => expect(second.queryByRole('button', { name: '回到自动视图' })).toBeNull())
  expect(document.querySelector<HTMLElement>('.thread-overview-plane')!.style.transform).toBe('translate(320px, 244.8px) scale(1)')
})

it('自动返回等待期间可点击回到自动，立即开始取景', async () => {
  vi.useFakeTimers()
  for (const [property, size] of [['clientWidth', 1000], ['clientHeight', 800], ['offsetWidth', 360], ['offsetHeight', 200]] as const) {
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains(property.startsWith('client') ? 'thread-overview-scroll' : 'thread-overview-grid') ||
        (!property.startsWith('client') && this.hasAttribute('data-overview-card-id')) ? size : 0
    })
  }
  const memory: OverviewCameraMemory = { current: { sceneKey: 'all',
    view: { manual: false, transform: { scale: 0.8, x: -200, y: 30 } } } }
  const view = render(<ConversationOverview threads={[]} reports={makeReports(1)} cameraMemory={memory}
    motionSceneKey="all" transitionId={null} interrupt={async () => {}} respond={async () => {}} onSelect={() => {}} />)
  const plane = document.querySelector<HTMLElement>('.thread-overview-plane')!
  expect(plane.style.transform).toBe('translate(-200px, 30px) scale(0.8)')
  fireEvent.click(view.getByRole('button', { name: '回到自动视图' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  expect(plane.style.transform).toBe('translate(320px, 244.8px) scale(1)')
  expect(view.queryByRole('button', { name: '回到自动视图' })).toBeNull()
})

it('keeps the last planned geometry on search failure and releases the FIFO for a later revision', async () => {
  const reports = makeReports(5)
  let fail = true
  const onState = vi.fn<(state: OverviewLayoutPlanningState) => void>()
  const plan = vi.fn<typeof layoutOverview>((previous, next, geometry) => {
    if (fail && next.length === 5) throw new LayoutSearchLimitError()
    return layoutOverview(previous, next, geometry)
  })
  const planner = { context: { availableCols: Number.MAX_SAFE_INTEGER }, plan }
  const common = { layoutPlanner: planner, onLayoutPlanningState: onState,
    transitionId: null, interrupt: async () => {}, respond: async () => {}, onSelect: () => {} }
  const view = render(<ConversationOverview {...common} threads={[]} reports={reports.slice(0, 4)} />)
  const before = [...document.querySelectorAll<HTMLElement>('[data-overview-card-id]')].map(card => card.style.cssText)
  view.rerender(<ConversationOverview {...common} threads={[]} reports={reports} />)
  await waitFor(() => expect(onState.mock.lastCall?.[0]).toHaveProperty('error'))
  expect([...document.querySelectorAll<HTMLElement>('[data-overview-card-id]')].map(card => card.style.cssText)).toEqual(before)
  expect(getOverviewMotionCoordinator().stageBusy).toBe(false)
  expect(view.getByRole('alert').textContent).toContain('布局暂未更新')
  fail = false
  fireEvent.click(view.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(document.querySelectorAll('[data-overview-card-id]')).toHaveLength(5))
  expect(plan.mock.lastCall?.[0]).toHaveLength(4)
  expect(view.queryByRole('alert')).toBeNull()
  await waitFor(() => expect(getOverviewMotionCoordinator().stageBusy).toBe(false))
  view.rerender(<ConversationOverview {...common} threads={[]} reports={reports.slice(0, 3)} />)
  await waitFor(() => expect(document.querySelectorAll('[data-overview-card-id]')).toHaveLength(3))
  expect(plan.mock.lastCall?.[0]).toHaveLength(5)
  await waitFor(() => expect(getOverviewMotionCoordinator().stageBusy).toBe(false))
})

it('re-registers the desired layout when StrictMode replays the mount after a failed first plan', async () => {
  const reports = makeReports(3)
  let calls = 0
  const plan = vi.fn<typeof layoutOverview>((previous, next, geometry) => {
    calls += 1
    if (calls === 1) throw new LayoutSearchLimitError()
    return layoutOverview(previous, next, geometry)
  })
  const planner = { context: { availableCols: Number.MAX_SAFE_INTEGER }, plan }
  const common = { layoutPlanner: planner, transitionId: null,
    interrupt: async () => {}, respond: async () => {}, onSelect: () => {} }
  const view = render(
    <StrictMode><ConversationOverview {...common} threads={[]} reports={reports} /></StrictMode>
  )
  // 重放前的 cleanup 会作废首次登记。撤销签名占位后重放必须重新登记，
  // 否则首屏停在空布局，且既没有错误提示也没有重试入口。
  await waitFor(() => expect(document.querySelectorAll('[data-overview-card-id]')).toHaveLength(3))
  expect(view.queryByRole('alert')).toBeNull()
  await waitFor(() => expect(getOverviewMotionCoordinator().stageBusy).toBe(false))
})

it('replays a failed request with its generation targets so the generated card still queues', async () => {
  const reports = makeReports(4)
  let fail = true
  const queuedIds: string[] = []
  const plan = vi.fn<typeof layoutOverview>((previous, next, geometry) => {
    if (fail && next.length === 4) throw new LayoutSearchLimitError()
    return layoutOverview(previous, next, geometry)
  })
  const planner = { context: { availableCols: Number.MAX_SAFE_INTEGER }, plan }
  // 生产里 App 拥有这道预约并在生成动画结束后释放舞台；这里就地释放，避免全局 FIFO 被占住。
  const onQueued = vi.fn((work: BartGenerationWork) => {
    for (const target of work.targets) queuedIds.push(target.id)
    work.controller.abort()
  })
  const common = { layoutPlanner: planner, motionSceneKey: 'all', transitionId: null,
    interrupt: async () => {}, respond: async () => {}, onSelect: () => {},
    onGenerationMotionQueued: onQueued, onLayoutRevisionsConsumed: () => {} }
  const view = render(<ConversationOverview {...common} threads={[]} reports={reports.slice(0, 3)} />)
  const revision = { revision: 1, sceneKey: 'all',
    snapshot: overviewLayoutSnapshot(deriveOverviewItems({
      threads: [], reports, transitionId: null,
      layoutContext: { availableCols: Number.MAX_SAFE_INTEGER }
    })),
    generationTargets: [{ kind: 'report' as const, id: 'report-03', createdAt: 3, title: 'Report 3',
      metaText: '', cwdText: '', bodyText: '' }] }
  view.rerender(<ConversationOverview {...common} threads={[]} reports={reports}
    layoutRevisions={[revision]} />)
  await waitFor(() => expect(view.queryByRole('alert')).not.toBeNull())
  fail = false
  fireEvent.click(view.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(document.querySelectorAll('[data-overview-card-id]')).toHaveLength(4))
  // 失败请求已从消费队列移除，重试必须带着它的生成工作一起重投，否则卡片入场后不再有生成动画。
  await waitFor(() => expect(queuedIds).toEqual(['report-03']))
  await waitFor(() => expect(getOverviewMotionCoordinator().stageBusy).toBe(false))
})

it('carries a failed revision’s generation targets into the next successful layout', async () => {
  const reports = makeReports(5)
  const queuedIds: string[] = []
  const plan = vi.fn<typeof layoutOverview>((previous, next, geometry) => {
    if (next.length === 4) throw new LayoutSearchLimitError()
    return layoutOverview(previous, next, geometry)
  })
  const planner = { context: { availableCols: Number.MAX_SAFE_INTEGER }, plan }
  const onQueued = vi.fn((work: BartGenerationWork) => {
    for (const target of work.targets) queuedIds.push(target.id)
    work.controller.abort()
  })
  const common = { layoutPlanner: planner, motionSceneKey: 'all', transitionId: null,
    interrupt: async () => {}, respond: async () => {}, onSelect: () => {},
    onGenerationMotionQueued: onQueued, onLayoutRevisionsConsumed: () => {} }
  const snapshotFor = (count: number) => overviewLayoutSnapshot(deriveOverviewItems({
    threads: [], reports: reports.slice(0, count), transitionId: null,
    layoutContext: { availableCols: Number.MAX_SAFE_INTEGER }
  }))
  const revision = (value: number, count: number, withTarget: boolean) => ({
    revision: value, sceneKey: 'all', snapshot: snapshotFor(count),
    ...(withTarget ? { generationTargets: [{ kind: 'report' as const, id: 'report-03', createdAt: 3,
      title: 'Report 3', metaText: '', cwdText: '', bodyText: '' }] } : {})
  })
  const view = render(<ConversationOverview {...common} threads={[]} reports={reports.slice(0, 3)} />)
  view.rerender(<ConversationOverview {...common} threads={[]} reports={reports.slice(0, 4)}
    layoutRevisions={[revision(1, 4, true)]} />)
  await waitFor(() => expect(view.queryByRole('alert')).not.toBeNull())
  // 不点重试：下一次成功呈现必须接手这批目标。规划成功曾在这里清掉唯一一份记录，
  // 于是生成动画静默退化回通用入场，没有任何提示。
  view.rerender(<ConversationOverview {...common} threads={[]} reports={reports}
    layoutRevisions={[revision(1, 4, true), revision(2, 5, false)]} />)
  await waitFor(() => expect(document.querySelectorAll('[data-overview-card-id]')).toHaveLength(5))
  await waitFor(() => expect(queuedIds).toEqual(['report-03']))
  await waitFor(() => expect(getOverviewMotionCoordinator().stageBusy).toBe(false))
})

it('drops a failed scene’s generation targets when the scene cuts before they are staged', async () => {
  const reports = makeReports(5)
  const queuedIds: string[] = []
  const plan = vi.fn<typeof layoutOverview>((previous, next, geometry) => {
    if (next.length === 4) throw new LayoutSearchLimitError()
    return layoutOverview(previous, next, geometry)
  })
  const planner = { context: { availableCols: Number.MAX_SAFE_INTEGER }, plan }
  const onQueued = vi.fn((work: BartGenerationWork) => {
    for (const target of work.targets) queuedIds.push(target.id)
    work.controller.abort()
  })
  const common = { layoutPlanner: planner, transitionId: null,
    interrupt: async () => {}, respond: async () => {}, onSelect: () => {},
    onGenerationMotionQueued: onQueued, onLayoutRevisionsConsumed: () => {} }
  const snapshot = (count: number) => overviewLayoutSnapshot(deriveOverviewItems({
    threads: [], reports: reports.slice(0, count), transitionId: null,
    layoutContext: { availableCols: Number.MAX_SAFE_INTEGER }
  }))
  const target = { kind: 'report' as const, id: 'report-03', createdAt: 3, title: 'Report 3',
    metaText: '', cwdText: '', bodyText: '' }
  // 场景 A：带生成目标的 revision 规划失败，目标暂存进 failedLayoutRef。
  const view = render(<ConversationOverview {...common} motionSceneKey="a" threads={[]} reports={reports.slice(0, 3)} />)
  view.rerender(<ConversationOverview {...common} motionSceneKey="a" threads={[]} reports={reports.slice(0, 4)}
    layoutRevisions={[{ revision: 1, sceneKey: 'a', snapshot: snapshot(4), generationTargets: [target] }]} />)
  await waitFor(() => expect(view.queryByRole('alert')).not.toBeNull())
  // 切场景是硬切断：旧场景的布局与生成队列全部作废，暂存目标也必须一起作废。
  view.rerender(<ConversationOverview {...common} motionSceneKey="b" threads={[]} reports={reports.slice(0, 3)} />)
  await waitFor(() => expect(getOverviewMotionCoordinator().stageBusy).toBe(false))
  // 新场景里同一张卡再次出现并规划成功：不得给早已生成的卡补播一次生成动画。
  view.rerender(<ConversationOverview {...common} motionSceneKey="b" threads={[]} reports={reports}
    layoutRevisions={[{ revision: 2, sceneKey: 'b', snapshot: snapshot(5) }]} />)
  await waitFor(() => expect(document.querySelectorAll('[data-overview-card-id]')).toHaveLength(5))
  // 生成批次有 350ms 静默窗；等它走完再断言，否则会在目标真正入队之前就宣布"没有入队"。
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(queuedIds).toEqual([])
  await waitFor(() => expect(getOverviewMotionCoordinator().stageBusy).toBe(false))
})

it('retargets automatic entry when the viewport narrows before the fit completes', async () => {
  vi.useFakeTimers()
  const camera = new OverviewCameraCockpit()
  camera.setScaleFloor(0.05)
  const content = { left: 0, top: 0, width: 2240, height: 1858 }
  const wide = { width: 1140, height: 868 }
  const narrow = { width: 560, height: 868 }
  try {
    camera.reconcileBounds(content, wide)
    await act(async () => { await vi.advanceTimersByTimeAsync(80) })
    camera.requestRefit(content, narrow)
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    const fit = fitOverviewCanvasTransform(content, narrow, 0.05)
    for (const axis of ['scale', 'x', 'y'] as const) expect(camera.getSnapshot()?.transform[axis]).toBeCloseTo(fit[axis], 8)
    expect(getOverviewMotionCoordinator().stageBusy).toBe(false)
  } finally { camera.dispose() }
})

it('shrinks each contracting axis, follows the supplied straight order, then grows at the destination', () => {
  const grid = document.createElement('div')
  grid.innerHTML = '<article data-overview-card-id="A"></article><article data-overview-card-id="B"></article>'
  document.body.append(grid)
  const from = new Map([
    ['A', { left: 0, top: 0, width: 736, height: 200 }],
    ['B', { left: 752, top: 0, width: 360, height: 200 }]
  ])
  const to = new Map([
    ['A', { left: 376, top: 216, width: 360, height: 416 }],
    ['B', { left: 752, top: 216, width: 360, height: 200 }]
  ])
  const cards = stageOverviewLayoutMotion(grid, from, to, new Set(['A']))
  const frames: Keyframe[][] = []
  for (const card of cards) card.element.animate = vi.fn((keyframes) => {
    frames.push(keyframes as Keyframe[])
    return { cancel() {}, finished: Promise.resolve() } as unknown as Animation
  })
  const beats = plannedOverviewMotionBeats(cards, ['B', 'A'], new Map())
  expect(beats.map(beat => beat.owner)).toEqual([
    'overview-layout:shrink:A', 'overview-layout:reflow:B', 'overview-layout:reflow:A', 'overview-layout:grow:A'
  ])
  for (const beat of beats) { beat.start(); beat.settle() }
  expect(frames).toEqual([
    [{ width: '736px', height: '200px', transform: 'translate(-376px, -216px) scale(1)' },
      { width: '360px', height: '200px', transform: 'translate(-376px, -216px) scale(1)' }],
    [{ transform: 'translate(0px, -216px) scale(1)' }, { transform: 'translate(0px, 0px) scale(1)' }],
    [{ transform: 'translate(-376px, -216px) scale(1)' }, { transform: 'translate(0px, 0px) scale(1)' }],
    [{ width: '360px', height: '200px', transform: 'translate(0px, 0px) scale(1)' },
      { width: '360px', height: '416px', transform: 'translate(0px, 0px) scale(1)' }]
  ])
  expect(cards[0]!.element.style.width).toBe('360px')
  expect(cards[0]!.element.style.height).toBe('416px')
  expect(cards[0]!.element.style.transform).toBe('translate(0px, 0px) scale(1)')
})

function makeReports(count: number): RendererReport[] {
  return Array.from({ length: count }, (_, index) => ({ id: `report-${String(index).padStart(2, '0')}`,
    title: `Report ${index}`, tags: [], createdAt: index, updatedAt: index, archived: false,
    previewText: '', relatedExecutions: [] }))
}

it('uses compact placement by default and restores same-scene positions after leaving Overview', () => {
  const reports = makeReports(24)
  const store = createOverviewOrchestrationStore()
  const common = { threads: [], reports, motionSceneKey: 'all', transitionId: null,
    interrupt: async () => {}, respond: async () => {}, onSelect: () => {}, onLayoutPresented: store.setPlacements }
  const view = render(<ConversationOverview {...common} />)
  const cards = [...document.querySelectorAll<HTMLElement>('[data-overview-card-id]')]
  expect(cards).toHaveLength(24)
  expect(Math.max(...cards.map(card => Number(card.style.gridColumnStart)))).toBe(4)
  expect(Math.max(...cards.map(card => Number(card.style.gridRowStart)))).toBe(6)
  const positions = store.getState().placement!.placements.map(p => ({ ...p, col: p.col + 2, row: p.row + 3 }))
  view.unmount()
  store.setPlacements('all', positions)
  store.reset()
  expect(store.getState().placement?.placements).toEqual(positions)
  const restored = render(<ConversationOverview {...common} initialPlacements={store.getState().placement!.placements} />)
  expect(store.getState().placement?.placements).toEqual(positions)
  // Content/order updates do not repack the stable membership, nor does a scene reuse old anchors.
  restored.rerender(<ConversationOverview {...common} reports={[...reports].reverse()} initialPlacements={positions} />)
  expect(store.getState().placement?.placements).toEqual(positions)
  restored.rerender(<ConversationOverview {...common} motionSceneKey="filtered" reports={reports.slice(0, 1)} />)
  expect(store.getState().placement).toMatchObject({ sceneKey: 'filtered', placements: [{ id: 'report-00', col: 0, row: 0 }] })
})
