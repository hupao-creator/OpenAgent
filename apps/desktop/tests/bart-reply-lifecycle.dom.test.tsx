// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  BART_REPLY_ANSWER, BART_REPLY_EXECUTION_ID, BART_REPLY_ITEM_ID, BART_REPLY_THREAD_ID,
  createBartReplyFixture
} from './fixtures/bart-reply'
import { bartReplyReadKey, isBartReplyRead, resetBartReplyReadState } from '../src/renderer/src/bart-reply-read-state'
import { getBartPresenceCoordinator } from '../src/renderer/src/bart-motion/presence'

const REPLY_ID = JSON.stringify([BART_REPLY_EXECUTION_ID, BART_REPLY_ITEM_ID])
const READ_KEY = bartReplyReadKey(BART_REPLY_THREAD_ID, 'codex', REPLY_ID)

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  resetBartReplyReadState()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})
afterEach(() => {
  getBartPresenceCoordinator().reset()
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (document as unknown as Record<string, unknown>).elementFromPoint
})

it('hides the unread reminder while Bart is away and restores it without reading it', () => {
  const f = fixture()
  expect(f.stage()).not.toBeNull()
  fireEvent.pointerEnter(f.target()!)
  f.advance(1_500)
  let release!: () => void
  act(() => { release = getBartPresenceCoordinator().hold(Symbol('test-scene')) })
  expect(f.stage()).toBeNull()
  f.advance(3_000)
  act(() => release())
  expect(f.stage()).not.toBeNull()
  expect(f.view.container.querySelector('.bart-reply-preview')).toBeNull()
  expect(isBartReplyRead(READ_KEY)).toBe(false)
})

function fixture() {
  const source = createBartReplyFixture()
  const view = render(source.element())
  return {
    source,
    view,
    stage: () => view.container.querySelector('.bart-reply-stage'),
    target: () => view.container.querySelector('.bart-reply-target') as HTMLElement | null,
    excerpt: () => view.container.querySelector('.bart-reply-excerpt')?.textContent,
    advance: (ms: number) => act(() => vi.advanceTimersByTime(ms)),
    render: (props: Parameters<typeof source.element>[0]) => act(() => view.rerender(source.element(props)))
  }
}

it('reminds with the numeral one and the bounded excerpt of the last successful answer', () => {
  const f = fixture()
  expect(f.stage()).not.toBeNull()
  expect(f.view.container.querySelector('.bart-reply-preview')).toBeNull()
  expect(f.view.container.querySelector('.bart-reply-count')?.textContent).toBe('1')
  expect(f.excerpt()).toBe(BART_REPLY_ANSWER)
  const describedBy = f.target()!.getAttribute('aria-describedby')
  expect(document.getElementById(describedBy!)?.textContent).toBe(BART_REPLY_ANSWER)
})

it.each(['badge', 'character'])('keeps the unread dot after hovering %s for longer than the former read threshold', (region) => {
  const f = fixture()
  const target = region === 'badge' ? f.target()! : f.view.container.querySelector('.bart-dock-drag-surface')!
  fireEvent.pointerOver(target)
  f.advance(5_000)
  expect(f.view.container.querySelector('.bart-reply-preview')).toBeNull()
  fireEvent.pointerOut(target)
  expect(f.stage()).not.toBeNull()
  expect(isBartReplyRead(READ_KEY)).toBe(false)
})

it('keeps keyboard focus available without previewing or consuming the answer', () => {
  const f = fixture()
  act(() => f.target()!.focus())
  expect(f.target()).toHaveFocus()
  expect(f.target()).toHaveAccessibleName('打开 Bart 的最新答复')
  expect(f.target()).toHaveAccessibleDescription(BART_REPLY_ANSWER)
  f.advance(5_000)
  act(() => f.target()!.blur())
  expect(f.view.container.querySelector('.bart-reply-preview')).toBeNull()
  expect(f.stage()).not.toBeNull()
  expect(isBartReplyRead(READ_KEY)).toBe(false)
})

it.each([
  ['the composer', { inputOpen: true }, { inputOpen: false }],
  ['settings over the Dock', { passiveVisible: false }, { passiveVisible: true }]
] as const)('restores the unread dot after %s hides it', (_what, away, back) => {
  const f = fixture()
  f.render(away)
  expect(f.stage()).toBeNull()
  f.advance(5_000)
  f.render(back)
  f.advance(1_000)
  expect(f.stage()).not.toBeNull()
  expect(isBartReplyRead(READ_KEY)).toBe(false)
})

it('keeps the read answer hidden, reminds again for a new identity, and survives a restart', () => {
  const f = fixture()
  f.render({ threadOpen: true })
  expect(f.stage()).toBeNull()
  expect(JSON.parse(localStorage.getItem('openagent.bart.reply-read')!)).toContain(READ_KEY)

  // A restart reloads the record from local storage instead of the memoized snapshot.
  resetBartReplyReadState()
  cleanup()
  const restarted = fixture()
  expect(restarted.stage()).toBeNull()

  // A successful later turn is a new identity, so the reminder returns on its own.
  act(() => restarted.source.startTurn('execution-2'))
  act(() => restarted.source.finishTurn('execution-2', 'A later final answer.'))
  expect(restarted.stage()).not.toBeNull()
  expect(restarted.excerpt()).toBe('A later final answer.')
  restarted.render({ threadOpen: true })
  expect(restarted.stage()).toBeNull()
})

it('hides an unread reminder for a running turn and restores the same answer when it fails', () => {
  const f = fixture()
  act(() => f.source.startTurn('execution-2'))
  f.render({ running: true })
  expect(f.stage()).toBeNull()
  expect(isBartReplyRead(READ_KEY)).toBe(false)

  act(() => f.source.failTurn('execution-2', 'Temporary failure'))
  f.render({ running: false })
  expect(f.stage()).not.toBeNull()
  expect(f.excerpt()).toBe(BART_REPLY_ANSWER)
})

it('consumes the reminder on entering the session, even while the Dock is not passively visible', () => {
  const f = fixture()
  // Entering the session is exactly when the overview stops rendering, so a
  // reminder that needed `passiveVisible` would never be consumed at all.
  f.render({ threadOpen: true, passiveVisible: false })
  expect(isBartReplyRead(READ_KEY)).toBe(true)
})

it('does not consume the reminder on entering a hidden window, and consumes it once the window is back', () => {
  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  const f = fixture()
  f.render({ threadOpen: true })
  expect(isBartReplyRead(READ_KEY)).toBe(false)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(isBartReplyRead(READ_KEY)).toBe(true)
  if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
})

it('bounds a long answer to its opening instead of a mid-sentence slice', () => {
  const f = fixture()
  const long = `INTRO ${'很长的一句话，'.repeat(80)}EXACT END`
  act(() => f.source.startTurn('execution-2'))
  act(() => f.source.finishTurn('execution-2', long))
  const excerpt = f.excerpt()!
  expect(Array.from(excerpt).length).toBe(141)
  expect(excerpt.startsWith('INTRO ')).toBe(true)
  expect(excerpt.endsWith('…')).toBe(true)
  expect(excerpt).not.toContain('EXACT END')
})

it('opens the session at the carried answer when the badge is activated', () => {
  const onReplyOpen = vi.fn()
  const f = fixture()
  f.render({ onReplyOpen })
  fireEvent.click(f.target()!)
  expect(onReplyOpen).toHaveBeenCalledOnce()
  expect(onReplyOpen.mock.calls[0]![0]).toEqual({
    id: REPLY_ID,
    readKey: READ_KEY,
    excerpt: BART_REPLY_ANSWER,
    executionId: BART_REPLY_EXECUTION_ID,
    target: { executionId: BART_REPLY_EXECUTION_ID, itemId: BART_REPLY_ITEM_ID }
  })
})

it('falls back to opening the session without a navigation target when none is available', () => {
  const onThreadOpenChange = vi.fn()
  const f = fixture()
  f.render({ onThreadOpenChange })
  fireEvent.click(f.target()!)
  expect(onThreadOpenChange).toHaveBeenCalledWith(true)
})


it('follows the real turn lifecycle while pacing native activity, then shows the final answer immediately', () => {
  const f = fixture()
  act(() => f.source.startTurn('execution-2'))
  expect(f.stage()).toBeNull()
  act(() => f.source.acceptEvent('execution-2', { type: 'reasoning-delta', delta: '检查输入' }))
  expect(f.view.container.querySelector('.bart-dock')).toHaveAttribute('data-role', 'reasoning')
  f.advance(100)
  act(() => f.source.acceptEvent('execution-2', {
    type: 'activity-start', activity: { id: 'call-1', kind: 'tool', label: 'Read', status: 'running', toolName: 'read_file' }
  }))
  expect(f.view.container.querySelector('.bart-dock')).toHaveAttribute('data-role', 'reasoning')
  act(() => f.source.recordOperation({
    type: 'tool-operation', id: 'old-read', executionId: 'execution-2', callId: 'read',
    name: 'openagent_thread_read', arguments: {}, createdAt: 1, completedAt: 2
  }))
  act(() => f.source.finishTurn('execution-2', 'Latest completed answer.'))
  expect(f.stage()).not.toBeNull()
  expect(f.excerpt()).toBe('Latest completed answer.')
  expect(f.view.container.querySelector('.bart-logo')).toHaveAttribute('data-activity', 'idle')
  f.advance(2_000)
  expect(f.view.container.querySelector('.bart-dock')).toHaveAttribute('data-role', 'idle')
  expect(f.excerpt()).toBe('Latest completed answer.')

  act(() => f.source.startTurn('execution-3'))
  act(() => f.source.acceptEvent('execution-3', { type: 'reasoning-delta', delta: '下一轮' }))
  expect(f.stage()).toBeNull()
  f.advance(50)
  act(() => f.source.failTurn('execution-3', 'Stopped'))
  expect(f.stage()).not.toBeNull()
  expect(f.excerpt()).toBe('Latest completed answer.')
})


it('does not carry an old dedicated result into a new turn before its first activity arrives', () => {
  const f = fixture()
  act(() => f.source.recordOperation({
    type: 'tool-operation', id: 'old-read', executionId: BART_REPLY_EXECUTION_ID, callId: 'read',
    name: 'openagent_thread_read', arguments: {}, createdAt: 1, completedAt: 2
  }))
  act(() => f.source.startTurn('execution-2'))
  expect(f.view.container.querySelector('.bart-logo')).toHaveAttribute('data-activity', 'idle')
})
