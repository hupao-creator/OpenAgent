// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FilterTransitionPreview, type FilterTransition } from '../playgrounds/overview-motion/src/filter-transitions'

const animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
let pending: { finish: () => void; cancel: ReturnType<typeof vi.fn> }[]

beforeEach(() => {
  vi.useFakeTimers()
  pending = []
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(360)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 30, 360, 200))
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn(() => {
    let finish!: () => void
    let reject!: (reason: Error) => void
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail })
    const cancel = vi.fn(() => reject(new DOMException('cancelled', 'AbortError')))
    pending.push({ finish, cancel })
    return { finished, cancel }
  }) })
})

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
  if (animateDescriptor) Object.defineProperty(HTMLElement.prototype, 'animate', animateDescriptor)
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
})

function fixture() {
  const stage = document.createElement('div')
  stage.innerHTML = '<div class="thread-overview-scroll"><div class="thread-overview-scroll-content"><div class="thread-overview-plane"><div class="thread-overview-grid"><article id="real-card" data-overview-card-id="one"><button>Open task</button></article></div></div></div></div>'
  document.body.append(stage)
  const content = stage.querySelector<HTMLElement>('.thread-overview-scroll-content')!
  const busy = vi.fn()
  const preview = new FilterTransitionPreview(busy)
  return { stage, content, preview, busy }
}

it.each<FilterTransition>(['depth', 'stagger', 'push'])('%s restores the live view after its visual snapshots finish', async mode => {
  const { stage, content, preview, busy } = fixture()
  preview.capture(stage, mode, 1, 1)
  content.querySelector('article')!.dataset.overviewCardId = 'two'
  preview.play()
  await vi.advanceTimersByTimeAsync(40)
  expect(stage.querySelectorAll('[data-overview-card-id]')).toHaveLength(1)
  expect(stage.querySelectorAll('#real-card')).toHaveLength(1)
  const overlay = stage.querySelector<HTMLElement>('.motion-filter-overlay')!
  expect(overlay.inert).toBe(true)
  expect(overlay.getAttribute('aria-hidden')).toBe('true')
  expect(pending.length).toBeGreaterThan(0)
  for (const animation of pending) animation.finish()
  await vi.advanceTimersByTimeAsync(0)
  expect(stage.querySelector('.motion-filter-overlay')).toBeNull()
  expect(stage.dataset.filterTransitionActive).toBeUndefined()
  expect(stage.querySelector('[data-overview-card-id="two"]')).not.toBeNull()
  expect(busy).toHaveBeenLastCalledWith(false)
})

it('an interrupted animation cannot clean up the newer filter transition', async () => {
  const { stage, content, preview } = fixture()
  preview.capture(stage, 'depth', .35, 1)
  preview.play()
  await vi.advanceTimersByTimeAsync(40)
  const first = [...pending]
  content.querySelector('article')!.dataset.overviewCardId = 'new-filter'
  preview.capture(stage, 'push', 1, -1)
  preview.play()
  await vi.advanceTimersByTimeAsync(40)
  expect(first.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true)
  expect(stage.querySelectorAll('.motion-filter-overlay')).toHaveLength(1)
  expect(stage.dataset.filterTransitionActive).toBe('push')
  preview.cancel()
  await vi.advanceTimersByTimeAsync(0)
  expect(stage.querySelector('.motion-filter-overlay')).toBeNull()
  expect(stage.querySelector('[data-overview-card-id="new-filter"]')).not.toBeNull()
})

it('cancels pending frames when leaving and handles transitions into an empty result', async () => {
  const { stage, content, preview } = fixture()
  preview.capture(stage, 'stagger', 1, 1)
  preview.play()
  preview.cancel()
  await vi.advanceTimersByTimeAsync(40)
  expect(pending).toHaveLength(0)
  preview.capture(stage, 'stagger', 1, 1)
  content.innerHTML = '<div class="thread-overview-empty">No results</div>'
  preview.play()
  await vi.advanceTimersByTimeAsync(40)
  for (const animation of pending) animation.finish()
  await vi.advanceTimersByTimeAsync(0)
  expect(stage.querySelector('.motion-filter-overlay')).toBeNull()
  expect(content.textContent).toBe('No results')
})

it('leaves the original transition and reduced-motion views untouched', () => {
  const { stage, preview, busy } = fixture()
  preview.capture(stage, 'original', 1, 1)
  expect(busy).not.toHaveBeenCalled()
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  preview.capture(stage, 'stagger', 1, 1)
  expect(stage.querySelector('.motion-filter-overlay')).toBeNull()
  expect(busy).not.toHaveBeenCalled()
})
