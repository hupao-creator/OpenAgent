// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationOverview, type ConversationOverviewProps } from '../src/renderer/src/components/ConversationOverview'
import { getOverviewMotionCoordinator } from '../src/renderer/src/overview-motion'
import type { RendererReport } from '../src/shared/renderer-state-contracts'

interface Motion {
  element: HTMLElement
  frames: Keyframe[]
  options: KeyframeAnimationOptions
  finish: () => void
  cancel: ReturnType<typeof vi.fn>
}

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
let motions: Motion[]
let screenScale: number
const reports: RendererReport[] = [
  { id: 'one', title: 'One', tags: ['front', 'test'], createdAt: 1, updatedAt: 1, archived: false, previewText: '', relatedExecutions: [] },
  { id: 'two', title: 'Two', tags: ['back', 'test'], createdAt: 2, updatedAt: 2, archived: false, previewText: '', relatedExecutions: [] },
  { id: 'three', title: 'Three', tags: ['front'], createdAt: 3, updatedAt: 3, archived: false, previewText: '', relatedExecutions: [] }
]
const common: ConversationOverviewProps = {
  threads: [], reports, transitionId: null, interrupt: async () => {}, respond: async () => {}, onSelect: () => {},
  tagFilters: ['front', 'back', 'test', 'empty'].map(tag => ({ tag, count: reports.filter(report => report.tags.includes(tag)).length, isCwdTag: false }))
}

beforeEach(() => {
  vi.useFakeTimers()
  screenScale = .6
  motions = []
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(360)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-overview-card-id')) {
      return new DOMRect(screenScale * 100, screenScale * 120, screenScale * 360, screenScale * 200)
    }
    return new DOMRect(0, 0, 1000, this.classList.contains('thread-overview-header') ? 58 : 800)
  })
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
    let finish!: () => void
    let reject!: (error: Error) => void
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail })
    const cancel = vi.fn(() => reject(new DOMException('cancelled', 'AbortError')))
    // Only hold filter-motion animations. Production camera and unrelated layout
    // work can settle, leaving the real shared coordinator available to this test.
    if (this.closest('[data-overview-filter-motion]')) motions.push({ element: this, frames, options, finish, cancel })
    else finish()
    return { finished, cancel }
  } })
})

afterEach(async () => {
  cleanup()
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
})

async function settle() {
  await act(async () => { for (const motion of motions) motion.finish(); await vi.advanceTimersByTimeAsync(40) })
}

async function mount() {
  const view = render(<StrictMode><ConversationOverview {...common} /></StrictMode>)
  await act(async () => { await vi.advanceTimersByTimeAsync(40) })
  return {
    ...view,
    async select(selectedTag: string, extra: Partial<ConversationOverviewProps> = {}) {
      view.rerender(<StrictMode><ConversationOverview {...common} selectedTag={selectedTag} {...extra} /></StrictMode>)
      await act(async () => { await vi.advanceTimersByTimeAsync(40) })
    }
  }
}

const liveCards = () => [...document.querySelectorAll<HTMLElement>('[data-overview-card-id]')]

it('animates the live survivors, keeps exits inert, and owns the shared stage until completion', async () => {
  const view = await mount()
  const coordinator = getOverviewMotionCoordinator()
  await view.select('front')
  expect(liveCards().map(card => card.dataset.overviewCardId)).toEqual(['one', 'three'])
  expect(motions.filter(motion => liveCards().includes(motion.element))).toHaveLength(2)
  expect(document.querySelector<HTMLElement>('.overview-filter-exits')?.inert).toBe(true)
  expect(document.querySelector('.overview-filter-exits [data-overview-card-id]')).toBeNull()
  expect(document.querySelectorAll('.overview-filter-exits .report-overview-item')).toHaveLength(1)
  expect(document.querySelector<HTMLElement>('.thread-overview-scroll-content:not(.overview-filter-exits)')?.inert).toBe(true)
  expect(coordinator.stageBusy).toBe(true)
  let nextAcquired = false
  const next = coordinator.acquireStage('test:after-filter').then(lease => { nextAcquired = true; lease.release() })
  await Promise.resolve()
  expect(nextAcquired).toBe(false)
  await settle(); await next
  expect(document.querySelector('.overview-filter-exits')).toBeNull()
  expect(document.querySelector('[data-overview-filter-motion]')).toBeNull()
  expect(document.querySelector<HTMLElement>('.thread-overview-scroll-content')?.inert).toBe(false)
  expect(coordinator.stageBusy).toBe(false)
})

it('captures pre-mutation screen geometry and compensates for the new camera scale', async () => {
  const view = await mount()
  // The outgoing DOM is sampled at 0.6×; change the measurement after React's
  // commit but before the transition reads the incoming frame at 1×.
  view.rerender(<StrictMode><ConversationOverview {...common} selectedTag="front" /></StrictMode>)
  screenScale = 1
  await act(async () => { await vi.advanceTimersByTimeAsync(40) })
  const survivor = motions.find(motion => motion.element.dataset.overviewCardId === 'one')!
  expect(survivor.frames[0]!.transform).toBe('translate(-40px, -48px) scale(0.6, 0.6)')
  expect(survivor.frames.at(-1)!.transform).toBe('translate(0, 0) scale(1)')
  await settle()
})

it('retains detached survivor cards while waiting for the stage without cloning their subtrees', async () => {
  const view = await mount()
  const originals = new Map(liveCards().map(card => [card.dataset.overviewCardId, card]))
  const cloneOne = vi.spyOn(originals.get('one')!, 'cloneNode')
  const cloneThree = vi.spyOn(originals.get('three')!, 'cloneNode')
  const lease = await getOverviewMotionCoordinator().acquireStage('test:hold-filter')
  try {
    await view.select('front')
    const exits = document.querySelector<HTMLElement>('.overview-filter-exits')!
    expect(document.querySelector('[data-overview-filter-motion]')?.getAttribute('data-overview-filter-motion')).toBe('pending')
    expect(exits.querySelectorAll('.report-overview-item')).toHaveLength(3)
    expect(exits.contains(originals.get('one')!)).toBe(true)
    expect(exits.contains(originals.get('three')!)).toBe(true)
    expect(exits.querySelector('[data-overview-card-id], [data-report-id], [id]')).toBeNull()
    expect(exits.inert).toBe(true)
    expect(cloneOne).not.toHaveBeenCalled()
    expect(cloneThree).not.toHaveBeenCalled()
    expect(liveCards().map(card => card.dataset.overviewCardId)).toEqual(['one', 'three'])
    lease.release()
    await act(async () => { await vi.advanceTimersByTimeAsync(40) })
    expect(exits.querySelectorAll('.report-overview-item')).toHaveLength(1)
    expect(originals.get('one')!.isConnected).toBe(false)
    await settle()
  } finally { lease.release() }
})

it('replaces interrupted work without letting old completions reveal or delete the latest view', async () => {
  const view = await mount()
  await view.select('front')
  const first = [...motions]
  await view.select('test')
  expect(first.every(motion => motion.cancel.mock.calls.length === 1)).toBe(true)
  for (const motion of first) motion.finish()
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(liveCards().map(card => card.dataset.overviewCardId)).toEqual(['one', 'two'])
  expect(document.querySelectorAll('.overview-filter-exits')).toHaveLength(1)
  expect(getOverviewMotionCoordinator().stageBusy).toBe(true)
  view.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(getOverviewMotionCoordinator().stageBusy).toBe(false)
  expect(document.querySelector('.overview-filter-exits')).toBeNull()
})

it('handles empty filters and new entries, and cancels when the view becomes hidden', async () => {
  const view = await mount()
  await view.select('empty')
  expect(liveCards()).toHaveLength(0)
  await settle()
  expect(document.querySelector('.thread-overview-empty')).not.toBeNull()
  motions = []
  await view.select('back')
  expect(liveCards().map(card => card.dataset.overviewCardId)).toEqual(['two'])
  expect(motions.find(motion => motion.element.dataset.overviewCardId === 'two')?.frames[0]!.opacity).toBe(0)
  await view.select('back', { cameraVisible: false })
  expect(document.querySelector('[data-overview-filter-motion]')).toBeNull()
  expect(getOverviewMotionCoordinator().stageBusy).toBe(false)
})

it.each(['capture', 'playback'])('skips motion when the document is already hidden at %s', async phase => {
  const view = await mount()
  const hidden = vi.spyOn(document, 'hidden', 'get')
  if (phase === 'capture') hidden.mockReturnValue(true)
  view.rerender(<StrictMode><ConversationOverview {...common} selectedTag="front" /></StrictMode>)
  if (phase === 'playback') hidden.mockReturnValue(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(40) })
  expect(liveCards().map(card => card.dataset.overviewCardId)).toEqual(['one', 'three'])
  expect(motions).toHaveLength(0)
  expect(document.querySelector('[data-overview-filter-motion]')).toBeNull()
  expect(document.querySelector('.overview-filter-exits')).toBeNull()
  expect(getOverviewMotionCoordinator().stageBusy).toBe(false)
})

it('retains the visible empty-state frame when its entry is interrupted', async () => {
  const view = await mount()
  await view.select('empty')
  const emptyContent = document.querySelector<HTMLElement>('.thread-overview-scroll-content:not(.overview-filter-exits)')!
  const computedStyle = window.getComputedStyle.bind(window)
  // WAAPI is mocked in jsdom: expose the intermediate computed frame that a
  // browser returns, without placing those values in the cloned inline styles.
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
    const style = computedStyle(element)
    if (element !== emptyContent) return style
    return new Proxy(style, { get(target, key) {
      if (key === 'opacity') return '0.4'
      if (key === 'transform') return 'matrix(1, 0, 0, 1, 0, 6)'
      return Reflect.get(target, key, target)
    } })
  })
  await view.select('front')
  const exits = document.querySelector<HTMLElement>('.overview-filter-exits')!
  expect(exits.style.opacity).toBe('0.4')
  expect(exits.style.transform).toBe('matrix(1, 0, 0, 1, 0, 6)')
  expect(motions.find(motion => motion.element === exits)?.frames[0]!.opacity).toBe('0.4')
  await settle()
})

it('does not animate aliases selecting the same members or reduced-motion tag changes', async () => {
  const view = await mount()
  const tagFilters = [{ tag: 'front', aliases: ['frontend'], selectionKey: 'front-members', count: 2, isCwdTag: false }]
  await view.select('front', { tagFilters })
  await settle()
  motions = []
  await view.select('frontend', { tagFilters })
  expect(motions).toHaveLength(0)
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  await view.select('back')
  expect(document.querySelector('[data-overview-filter-motion]')).toBeNull()
  expect(motions).toHaveLength(0)
})
