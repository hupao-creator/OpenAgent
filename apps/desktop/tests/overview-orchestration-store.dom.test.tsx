import { describe, expect, it } from 'vitest'
import { createOverviewOrchestrationStore } from '../src/renderer/src/overview-orchestration-store'
import type { BartGenerationWork } from '../src/renderer/src/components/BartThreadGeneration'

function work(key: number): BartGenerationWork {
  return { key, targets: [{ id: String(key), kind: 'report', title: 'Report', createdAt: key,
    bodyText: '', metaText: '', cwdText: '' }],
    controller: new AbortController() }
}
describe('Overview orchestration facts', () => {
  it('caps queued scenes and leaves overflow cards visible in their current business state', () => {
    const store = createOverviewOrchestrationStore()
    const entries = Array.from({ length: 20 }, (_, index) => work(index))
    entries.forEach(store.enqueue)
    expect(store.getState().works).toHaveLength(8)
    expect(store.getState().hiddenIds).toHaveLength(8)
    expect(entries.slice(8).every(entry => entry.controller.signal.aborted)).toBe(true)
    store.reset()
    expect(entries.every(entry => entry.controller.signal.aborted)).toBe(true)
  })
  it('keeps FIFO order, removes only consumed work and scopes release/reveal to live work', () => {
    const store = createOverviewOrchestrationStore()
    const first = work(1), second = work(2)
    store.enqueue(first)
    store.enqueue(second)
    store.enqueue(first)
    expect(store.getState().works.map(item => item.key)).toEqual([1, 2])
    expect(store.getState().hiddenIds).toEqual(['1', '2'])
    store.releaseCard('1')
    store.requestReveal('1')
    expect(store.getState().hiddenIds).toEqual(['2'])
    store.consumeWork(1)
    expect(store.getState()).toMatchObject({ works: [second], hiddenIds: ['2'], reveal: null, releasedIds: [] })
    store.consumeWork(2)
    store.enqueue(work(1))
    expect(store.getState().hiddenIds).toEqual(['1'])
    // A fact store must not abort or acquire the executor's reservation.
    expect(first.controller.signal.aborted).toBe(false)
  })
  it('does not share facts between App/Lab instances', () => {
    const first = createOverviewOrchestrationStore(), second = createOverviewOrchestrationStore()
    first.enqueue(work(1))
    first.requestReveal('1')
    first.setDeletedIndexes({ removed: 2 })
    expect(second.getState()).toMatchObject({ works: [], hiddenIds: [], reveal: null, deletedIndexes: {} })
    first.reset()
    expect(first.getState()).toMatchObject({ works: [], hiddenIds: [], reveal: null, deletedIndexes: {} })
  })
})
