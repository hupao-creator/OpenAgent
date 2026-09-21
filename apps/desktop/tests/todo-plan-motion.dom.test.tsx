// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CardPlanLadder } from '../../../packages/openagent-plugin-kit/src/renderer/harness-card/plan-ladder'
import type { ThreadCardPlanStep } from '@openagent/plugin-kit/renderer'

const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
afterEach(() => {
  cleanup()
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(Element.prototype, 'animate')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function plan(current: number): ThreadCardPlanStep[] {
  return Array.from({ length: 7 }, (_, index) => ({ step: `Task ${index + 1}`,
    status: index < current ? 'completed' : index === current ? 'inProgress' : 'pending' }))
}

function motionEnvironment(reduced = false) {
  const preference = { matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('matchMedia', () => preference)
  const records: { target: Element; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn>; finish: () => void }[] = []
  const animate = vi.fn(function (this: Element, _frames: Keyframe[], options: KeyframeAnimationOptions) {
    let finish!: () => void
    let reject!: () => void
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = () => fail(new Error('cancelled')) })
    const cancel = vi.fn(reject)
    records.push({ target: this, options, cancel, finish })
    return { finished, cancel }
  })
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const row = this.closest<HTMLElement>('[data-plan-index]')
    const rows = Array.from(row?.parentElement?.querySelectorAll('[data-plan-index]') ?? [])
    const top = row ? rows.indexOf(row) * 38 + 100 : 100
    return new DOMRect(3, top + (this.tagName === 'I' ? 11 : 0), this.tagName === 'I' ? 16 : 150, this.tagName === 'I' ? 16 : 38)
  })
  return { records, animate, preference }
}

it('renders snapshots without entrance motion, then relays a real adjacent progression without remounting rows', async () => {
  const { records, animate } = motionEnvironment()
  const { container, rerender } = render(<CardPlanLadder steps={plan(1)} variant="compact" />)
  const active = container.querySelector('[data-plan-index="1"]')
  expect(animate).not.toHaveBeenCalled()
  rerender(<CardPlanLadder steps={plan(2)} variant="compact" />)
  expect(container.querySelector('[data-plan-index="1"]')).toBe(active)
  expect(active).toHaveClass('completed')
  expect(container.querySelector('[data-plan-index="2"]')).toHaveClass('inProgress')
  expect(container.querySelector('.thread-card-plan-relay')).toHaveAttribute('aria-hidden', 'true')
  const count = records.length
  // An unrelated provider tick must not cancel or replay an in-flight handoff.
  rerender(<CardPlanLadder steps={plan(2)} variant="compact" />)
  expect(records).toHaveLength(count)
  expect(records.every(record => record.cancel.mock.calls.length === 0)).toBe(true)
  await act(async () => { records.forEach(record => record.finish()) })
  expect(container.querySelector('.thread-card-plan-relay')).not.toBeInTheDocument()
})

it('cancels superseded visuals and always commits the newest task state', () => {
  const { records } = motionEnvironment()
  const { container, rerender, unmount } = render(<CardPlanLadder steps={plan(1)} variant="compact" />)
  rerender(<CardPlanLadder steps={plan(2)} variant="compact" />)
  const count = records.length
  rerender(<CardPlanLadder steps={plan(3)} variant="compact" />)
  expect(records).toHaveLength(count)
  expect(records.every(record => record.cancel.mock.calls.length === 1)).toBe(true)
  expect(container.querySelector('.thread-card-plan-relay')).not.toBeInTheDocument()
  expect(container.querySelector('.inProgress b')).toHaveTextContent('Task 4')
  rerender(<CardPlanLadder steps={plan(4)} variant="compact" />)
  expect(container.querySelector('.thread-card-plan-relay')).toBeInTheDocument()
  unmount()
  expect(records.every(record => record.cancel.mock.calls.length === 1)).toBe(true)
})

it('respects reduced motion and cancels a flight if the preference changes while mounted', () => {
  const { animate, preference, records } = motionEnvironment(true)
  const { container, rerender } = render(<CardPlanLadder steps={plan(1)} variant="compact" />)
  rerender(<CardPlanLadder steps={plan(2)} variant="compact" />)
  expect(animate).not.toHaveBeenCalled()
  expect(container.querySelector('.inProgress b')).toHaveTextContent('Task 3')
  preference.matches = false
  rerender(<CardPlanLadder steps={plan(3)} variant="compact" />)
  expect(container.querySelector('.thread-card-plan-relay')).toBeInTheDocument()
  preference.matches = true
  act(() => preference.addEventListener.mock.calls[0]![1]())
  expect(container.querySelector('.thread-card-plan-relay')).not.toBeInTheDocument()
  expect(records.every(record => record.cancel.mock.calls.length === 1)).toBe(true)
})

it('does not invent a relay for replacements, skipped tasks, resizing, or final completion', async () => {
  const { records, animate } = motionEnvironment()
  const { container, rerender } = render(<CardPlanLadder steps={plan(1)} variant="compact" />)
  rerender(<CardPlanLadder steps={plan(1)} variant="tall" />)
  expect(animate).not.toHaveBeenCalled()
  rerender(<CardPlanLadder steps={plan(4)} variant="tall" />)
  expect(container.querySelector('.thread-card-plan-relay')).not.toBeInTheDocument()
  await act(async () => { records.forEach(record => record.finish()) })
  rerender(<CardPlanLadder steps={plan(7)} variant="tall" />)
  expect(container.querySelector('.thread-card-plan-relay')).not.toBeInTheDocument()
  expect(container.querySelector('.inProgress')).not.toBeInTheDocument()
  await act(async () => { records.forEach(record => record.finish()) })
  const count = animate.mock.calls.length
  rerender(<CardPlanLadder steps={plan(1).map(step => ({ ...step, step: 'New '+step.step }))} variant="tall" />)
  expect(animate).toHaveBeenCalledTimes(count)
  rerender(<CardPlanLadder steps={[]} variant="tall" />)
  expect(container).toBeEmptyDOMElement()
  rerender(<CardPlanLadder steps={plan(1)} variant="tall" />)
  expect(animate).toHaveBeenCalledTimes(count)
})
