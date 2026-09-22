// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { OverviewMotionPlayground } from '../playgrounds/overview-motion/src/OverviewMotionPlayground'
import { applyMotionAction, createMotionFrame, motionScenarios } from '../playgrounds/overview-motion/src/scenarios'
import { fakeSnapshots } from '../playgrounds/single-thread/src/fake-snapshots'
import { AppI18nProvider } from '../src/renderer/src/i18n'
import { getOverviewMotionCoordinator } from '../src/renderer/src/overview-motion'

afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

function mount(scene = 'lifecycle') {
  history.replaceState(null, '', `/?scene=${scene}`)
  return render(<StrictMode><AppI18nProvider locale="zh-CN"><OverviewMotionPlayground /></AppI18nProvider></StrictMode>)
}
const cards = () => document.querySelectorAll('[data-overview-card-id]')

it('opens all linked scenarios with production cards and no host or network', async () => {
  const fetch = vi.fn(() => { throw new Error('Playground is offline') })
  vi.stubGlobal('fetch', fetch)
  for (const scene of motionScenarios) {
    mount(scene.id)
    await waitFor(() => expect(cards()).toHaveLength(scene.count))
    expect(document.querySelector('.thread-overview')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(scene.title), pressed: true })).toBeInTheDocument()
    cleanup()
  }
  expect(fetch).not.toHaveBeenCalled()
})

it('uses real 2×1 footprints in an uncapped compact box and keeps identities in place on reorder', async () => {
  mount('packing')
  expect(cards()).toHaveLength(24)
  expect(screen.getByLabelText('布局包围盒')).toHaveTextContent('6 × 8')
  const positions = () => Object.fromEntries([...cards()].map(card => [card.getAttribute('data-overview-card-id'),
    [(card as HTMLElement).style.gridColumnStart, (card as HTMLElement).style.gridRowStart]]))
  const initial = positions()
  for (const card of cards()) expect(card).toHaveAttribute('data-card-cols', '2')
  fireEvent.click(screen.getByRole('button', { name: '反转顺序' }))
  await waitFor(() => expect(cards()[0]).toHaveAttribute('data-overview-card-id', 'motion-thread-24'))
  expect(positions()).toEqual(initial)
  expect(screen.getByLabelText('布局移动距离')).toHaveTextContent('0.0 px')
})

it.each(motionScenarios)('plays every $id revision using real footprints without a planning failure', async scene => {
  mount(scene.id)
  for (const _action of scene.steps) {
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    await waitFor(() => expect(getOverviewMotionCoordinator().stageBusy).toBe(false))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(document.querySelector('[data-overview-motion-staged]')).not.toBeInTheDocument()
  }
})

it('plays entry, exit and reordering and resets to the original identities', async () => {
  const user = userEvent.setup()
  mount()
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await waitFor(() => expect(cards()).toHaveLength(4))
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await waitFor(() => expect(cards()).toHaveLength(5))
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await waitFor(() => expect(document.querySelector('[data-overview-card-id="motion-thread-1"]')).not.toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await waitFor(() => expect([...cards()].map(card => card.getAttribute('data-overview-card-id')))
    .toEqual(['motion-thread-5', 'motion-thread-4', 'motion-thread-3', 'motion-thread-2']))
  expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '重置场景' }))
  await waitFor(() => expect([...cards()].map(card => card.getAttribute('data-overview-card-id')))
    .toEqual(['motion-thread-1', 'motion-thread-2', 'motion-thread-3']))
})

it('records card interactions and never changes the source snapshots', async () => {
  const before = JSON.stringify(fakeSnapshots)
  const user = userEvent.setup()
  mount('resize')
  const card = document.querySelector('[data-overview-card-id="motion-thread-1"]') as HTMLElement
  await user.click(within(card).getByRole('button', { name: '发送消息' }))
  expect(screen.getByText('续写 motion-thread-1 · 仅记录预览请求')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '展开提问' }))
  await waitFor(() => expect(card).toHaveAttribute('data-thread-status', 'attention'))
  await user.click(within(card).getByRole('button', { name: '项目名称' }))
  await user.click(within(card).getByRole('button', { name: '提交回答' }))
  expect(screen.getByText('回应问题 · 仅记录预览请求')).toBeInTheDocument()
  expect(card).toHaveAttribute('data-thread-status', 'attention')
  expect(JSON.stringify(fakeSnapshots)).toBe(before)
})

it('keeps each burst revision in the production FIFO, then cancels it on a scene cut', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1300)
  const coordinator = getOverviewMotionCoordinator()
  const acquire = vi.spyOn(coordinator, 'acquireStage')
  const cut = vi.spyOn(coordinator, 'cutScene')
  mount('queue')
  // A held production lease makes the queued intermediate revisions observable.
  const lease = await coordinator.acquireStage('test:hold')
  acquire.mockClear()
  fireEvent.click(screen.getByRole('button', { name: '连续变化 ×4' }))
  const plans = acquire.mock.calls.filter(([owner]) => owner.startsWith('overview-layout:plan:'))
  expect(plans).toHaveLength(4)
  expect(plans[0]![0]).not.toBe(plans[1]![0])
  expect(plans[0]![0]).toBe(plans[2]![0])
  expect(plans[1]![0]).toBe(plans[3]![0])
  fireEvent.click(screen.getByRole('button', { name: '立即切幕' }))
  await waitFor(() => expect(cards()).toHaveLength(2))
  expect(cut).toHaveBeenCalledOnce()
  await act(async () => { lease.release() })
  expect(cards()).toHaveLength(2)
  expect(coordinator.stageBusy).toBe(false)
  expect(document.querySelector('[data-overview-motion-recomposing]')).not.toBeInTheDocument()
})

it('consolidates completed tasks into a production Report and restores them when it is removed', async () => {
  const user = userEvent.setup()
  mount('report')
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await waitFor(() => expect(cards()).toHaveLength(1))
  expect(document.querySelector('[data-report-id="motion-report"]')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await waitFor(() => expect(cards()).toHaveLength(4))
  expect(document.querySelector('[data-report-id]')).not.toBeInTheDocument()
})

it('pauses future triggers, cancels timers when resetting, and unmounts without a pending stage', async () => {
  vi.useFakeTimers()
  const view = mount()
  fireEvent.click(screen.getByRole('button', { name: '开始演示' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
  expect(cards()).toHaveLength(4)
  fireEvent.click(screen.getByRole('button', { name: '暂停触发' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(cards()).toHaveLength(4)
  fireEvent.click(screen.getByRole('button', { name: '开始演示' }))
  fireEvent.click(screen.getByRole('button', { name: '重置场景' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(cards()).toHaveLength(3)
  view.unmount()
  await act(async () => { await vi.runOnlyPendingTimersAsync() })
  expect(getOverviewMotionCoordinator().stageBusy).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps free actions valid after emptying the stage and filling it again', () => {
  let frame = createMotionFrame(1)
  frame = applyMotionAction(frame, 'remove')[0]!
  expect(frame.threads).toHaveLength(0)
  frame = applyMotionAction(frame, 'question')[0]!
  frame = applyMotionAction(frame, 'fill')[0]!
  expect(frame.threads).toHaveLength(18)
  expect(new Set(frame.threads.map(source => source.thread.id)).size).toBe(18)
  expect(applyMotionAction(frame, 'compact')[0]!.threads).toHaveLength(1)
})
