import { afterEach, expect, it, vi } from 'vitest'
import { BartDisplayQueue, IDLE_DISPLAY_ITEM, type BartDisplayInput, type BartDisplayItem } from '../src/renderer/src/bart-display/queue'
import { DEFAULT_BART_DISPLAY_TIMING } from '../src/renderer/src/bart-display/state-rules'
const thought = (sequence: number, text: string): BartDisplayItem => ({ sequence, role: {
  kind: 'reasoning', text, sourceText: text, segmentKey: `run:${sequence}`
} })
const tool = (sequence: number, toolName: string): BartDisplayItem => ({ sequence, role: { kind: 'tool', toolName } })
const queues: BartDisplayQueue[] = []
afterEach(() => { for (const q of queues.splice(0)) q.dispose(); vi.useRealTimers() })
function fixture() {
  vi.useFakeTimers()
  const queue = new BartDisplayQueue()
  queues.push(queue)
  queue.setPresenting(true)
  return {
    queue,
    receive(items: BartDisplayItem[], overrides: Partial<BartDisplayInput> = {}) {
      queue.receive({ scope: 'run', status: 'running', items, latest: items.at(-1) ?? IDLE_DISPLAY_ITEM, ...overrides })
    },
    show() { queue.presented(queue.getSnapshot().token) },
    item: () => queue.getSnapshot().item,
    advance: (ms: number) => vi.advanceTimersByTime(ms)
  }
}

it('starts the minimum interval only after the consumer acknowledges actual presentation', () => {
  const f = fixture()
  f.receive([thought(1, 'first'), tool(2, 'read'), thought(3, 'last')])
  f.advance(10000)
  expect(f.item()).toEqual(thought(1, 'first'))
  f.show()
  f.advance(799)
  expect(f.item()).toEqual(thought(1, 'first'))
  f.advance(1)
  expect(f.item()).toEqual(tool(2, 'read'))
  // An old/unpainted lease cannot acknowledge the new item, even after a stall.
  f.queue.presented(f.queue.getSnapshot().token - 1)
  f.advance(10000)
  expect(f.item()).toEqual(tool(2, 'read'))
  f.show()
  f.advance(800)
  expect(f.item()).toEqual(thought(3, 'last'))
})

it('never lets a delayed snapshot truncate an already accepted reasoning source', () => {
  const f = fixture()
  f.receive([thought(1, 'complete source')], { latest: thought(1, 'complete') })
  expect(f.item()).toEqual(thought(1, 'complete source'))
  f.show()
  f.advance(700)
  f.receive([thought(1, 'complete source extended'), tool(2, 'next')])
  f.advance(100)
  expect(f.item()).toEqual(tool(2, 'next'))
})

it.each(['failed', 'interrupted', 'waiting-for-user'] as const)('preempts on %s and ignores discarded work after a resume', status => {
  const f = fixture()
  f.receive([thought(1, 'old'), tool(2, 'old')])
  f.show()
  f.advance(50)
  f.receive([], { status })
  expect(f.item()).toEqual(IDLE_DISPLAY_ITEM)
  f.receive([tool(2, 'old')])
  f.advance(20000)
  expect(f.item().role.kind).not.toBe('tool')
})

it('recovers only the latest snapshot and cancels timers on replacement and disposal', () => {
  const f = fixture()
  f.receive([thought(1, 'old'), tool(2, 'old')])
  f.show()
  f.receive([thought(1, 'new')], { scope: 'new-run' })
  f.show()
  f.receive([tool(2, 'new')], { scope: 'new-run' })
  f.queue.setPresenting(false)
  f.queue.setPresenting(true)
  expect(f.item()).toEqual(tool(2, 'new'))
  f.receive([], { scope: 'new-run', reset: true, status: 'completed' })
  expect(f.item()).toEqual(IDLE_DISPLAY_ITEM)
  f.queue.dispose()
  f.receive([thought(1, 'late')], { scope: 'late' })
  f.advance(10000)
  expect(f.item()).toEqual(IDLE_DISPLAY_ITEM)
})

it.each([-1, Infinity, NaN])('rejects invalid durations (%s) before changing active rules', minimumDisplayMs => {
  const f = fixture()
  expect(() => f.queue.setTiming({ ...DEFAULT_BART_DISPLAY_TIMING, tool: { minimumDisplayMs } })).toThrow('Invalid Bart tool')
})

it('applies running timing to assistant-text items without demanding new source events', () => {
  const f = fixture()
  f.queue.setTiming({ ...DEFAULT_BART_DISPLAY_TIMING, running: { minimumDisplayMs: 250 } })
  const running: BartDisplayItem = { sequence: 1, role: { kind: 'running' } }
  f.receive([running, tool(2, 'read')])
  f.show()
  f.advance(249)
  expect(f.item()).toEqual(running)
  f.advance(1)
  expect(f.item()).toEqual(tool(2, 'read'))
})
