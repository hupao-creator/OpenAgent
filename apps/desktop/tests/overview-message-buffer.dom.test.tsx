// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ThreadCardExcerpt } from '../../../packages/openagent-plugin-kit/src/renderer/harness-card/excerpt'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const text = (): string => document.querySelector('.thread-overview-excerpt > .thread-card-excerpt-text')?.textContent ?? ''
const tick = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

it('does not measure or clone the DOM while filling the same text batch', () => {
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  const clone = vi.spyOn(Node.prototype, 'cloneNode')
  const view = render(<ThreadCardExcerpt content="first" messageId="message" messageText="first" />)
  for (let index = 1; index <= 50; index++) {
    view.rerender(<ThreadCardExcerpt content="bounded" messageId="message" messageText={`first${'x'.repeat(index)}`} />)
  }
  expect(text()).toBe(`first${'x'.repeat(50)}`)
  expect(measure).not.toHaveBeenCalled()
  expect(clone).not.toHaveBeenCalled()
})

it('keeps initial historical snapshots static and does not replay their backlog', async () => {
  render(<ThreadCardExcerpt content="saved bounded excerpt" messageId="old" messageText={'a'.repeat(2000)} />)
  await tick(8000)
  expect(text()).toBe('saved bounded excerpt')
})

it('batches simultaneous card reveals into one animation checkpoint and cancels uncommitted work', async () => {
  const checkpoint = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
  const cancel = vi.fn()
  const finished = new Promise<void>(() => {})
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [{ finished, cancel }] })
  const cards = (messageId: string) => <>{Array.from({ length: 8 }, (_, index) =>
    <ThreadCardExcerpt key={index} content={messageId} messageId={messageId} messageText={messageId} />)}</>
  try {
    const view = render(cards('previous'))
    view.rerender(cards('next'))
    await tick(0)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    view.rerender(cards('cancel before microtask'))
    view.unmount()
    await tick(0)
    expect(document.querySelector('.thread-card-text-reveal')).toBeNull()
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalled()
  } finally { Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations') }
})

it('fills 600 Unicode characters, waits 800ms, and retains the final partial batch', async () => {
  const view = render(<ThreadCardExcerpt content="previous" messageId="old" messageText="previous" />)
  view.rerender(<ThreadCardExcerpt content="bounded" messageId="new" messageText={'😀'.repeat(599)} />)
  await tick(2000)
  expect(Array.from(text())).toHaveLength(599)
  view.rerender(<ThreadCardExcerpt content="bounded" messageId="new" messageText={'😀'.repeat(600) + 'tail'} />)
  await tick(799)
  expect(text()).toBe('😀'.repeat(600))
  await tick(1)
  expect(text()).toBe('tail')
  await tick(8000)
  expect(text()).toBe('tail')
})

it('advances immediately when more text arrives after an already completed hold', async () => {
  const view = render(<ThreadCardExcerpt content="" messageId="old" messageText="" />)
  view.rerender(<ThreadCardExcerpt content="" messageId="new" messageText={'a'.repeat(600)} />)
  await tick(1200)
  view.rerender(<ThreadCardExcerpt content="" messageId="new" messageText={'a'.repeat(600) + 'next'} />)
  await tick(0)
  expect(text()).toBe('next')
})

it('preempts queued batches on a new message and resets offsets after a same-id rewrite', async () => {
  const view = render(<ThreadCardExcerpt content="" messageId="old" messageText="" />)
  view.rerender(<ThreadCardExcerpt content="" messageId="a" messageText={'a'.repeat(1200) + 'obsolete'} />)
  await tick(800)
  expect(text()).toBe('a'.repeat(600))
  view.rerender(<ThreadCardExcerpt content="" messageId="a" messageText="authoritative replacement" />)
  expect(text()).toBe('authoritative replacement')
  view.rerender(<ThreadCardExcerpt content="" messageId="b" messageText="new message" />)
  await tick(4000)
  expect(text()).toBe('new message')
})

it('starts the hold only after the reveal settles and cleans up on interruption/unmount', async () => {
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  const cancel = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [{ finished, cancel }] })
  try {
    const view = render(<ThreadCardExcerpt content="old" messageId="old" messageText="old" />)
    view.rerender(<ThreadCardExcerpt content="" messageId="a" messageText={'a'.repeat(600) + 'last'} />)
    await tick(3000)
    expect(text()).toBe('a'.repeat(600))
    await act(async () => { finish(); await finished })
    await tick(799)
    expect(text()).toBe('a'.repeat(600))
    await tick(1)
    expect(text()).toBe('last')
    view.rerender(<ThreadCardExcerpt content="" messageId="b" messageText="interrupt" />)
    expect(text()).toBe('interrupt')
    view.unmount()
    expect(document.querySelector('.thread-card-text-reveal')).toBeNull()
    expect(cancel).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally { Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations') }
})

it('skips animated layers for reduced motion while retaining the dwell', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  const view = render(<ThreadCardExcerpt content="" messageId="old" messageText="" />)
  view.rerender(<ThreadCardExcerpt content="" messageId="new" messageText={'a'.repeat(600) + 'tail'} />)
  expect(document.querySelector('.thread-card-text-reveal')).toBeNull()
  await tick(799)
  expect(text()).toHaveLength(600)
  await tick(1)
  expect(text()).toBe('tail')
})

it('retains its absolute cursor and hold through capped rolling-window deltas', async () => {
  const content = Array.from({ length: 2600 }, (_, index) => String.fromCharCode(0x4e00 + index)).join('')
  const view = render(<ThreadCardExcerpt content={content.slice(-600)} messageId="a" messageText={content} />)
  view.rerender(<ThreadCardExcerpt content="bounded" messageId="a" messageText={content.slice(100) + 'b'.repeat(100)} />)
  expect(text()).toBe(content.slice(-600))
  await tick(400)
  view.rerender(<ThreadCardExcerpt content="bounded" messageId="a" messageText={content.slice(200) + 'b'.repeat(200)} />)
  expect(text()).toBe(content.slice(-600))
  await tick(399)
  expect(text()).toBe(content.slice(-600))
  await tick(1)
  expect(text()).toBe('b'.repeat(200))
})

it('catches up when a capped stream drops unread text without restarting every delta', async () => {
  const content = Array.from({ length: 2600 }, (_, index) => String.fromCharCode(0x4e00 + index)).join('')
  const view = render(<ThreadCardExcerpt content="" messageId="old" messageText="" />)
  view.rerender(<ThreadCardExcerpt content="bounded" messageId="a" messageText={content} />)
  expect(text()).toBe(content.slice(0, 600))
  view.rerender(<ThreadCardExcerpt content="bounded" messageId="a" messageText={content.slice(100) + 'b'.repeat(100)} />)
  const caughtUp = content.slice(-500) + 'b'.repeat(100)
  expect(text()).toBe(caughtUp)
  await tick(400)
  view.rerender(<ThreadCardExcerpt content="bounded" messageId="a" messageText={content.slice(200) + 'b'.repeat(200)} />)
  expect(text()).toBe(caughtUp)
  await tick(400)
  expect(text()).toBe('b'.repeat(100))
})
