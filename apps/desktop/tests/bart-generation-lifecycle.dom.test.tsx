// @vitest-environment jsdom
import { StrictMode } from 'react'
import { useStore } from 'zustand'
import { createOverviewOrchestrationStore } from '../src/renderer/src/overview-orchestration-store'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BartThreadGenerations,
  type BartGenerationWork
} from '../src/renderer/src/components/BartThreadGeneration'
import { getBartSpatialRegistry } from '../src/renderer/src/bart-motion'

const targetId = 'generation-target-mounts-after-timeout'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16)
  )
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle))
})

afterEach(() => {
  cleanup()
  getBartSpatialRegistry().registerThreadCard(targetId, null)
  getBartSpatialRegistry().setThreadGenerationHidden(targetId, false)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Bart generation visibility lifecycle', () => {
  it.each([true, false])('publishes production visibility and clears fallback/teardown facts (WebGL %s)', async (available) => {
    vi.stubGlobal('Worker', available ? class {} : undefined)
    if (available) HTMLCanvasElement.prototype.transferControlToOffscreen = vi.fn()
    const store = createOverviewOrchestrationStore()
    const work: BartGenerationWork = {
      key: 1, targets: [{ id: targetId, kind: 'report', createdAt: 1, title: 'report',
        metaText: '', cwdText: '', bodyText: '' }],
      controller: new AbortController()
    }
    store.enqueue(work)
    const legacyHidden = vi.fn(), legacyReveal = vi.fn()
    function Surface() {
      const works = useStore(store, state => state.works)
      return <BartThreadGenerations overviewOpen threads={[]} works={works} orchestration={store}
        onWorkConsumed={store.consumeWork} onHiddenIdsChange={legacyHidden} onReveal={legacyReveal} />
    }
    const mounted = render(<div className="app-shell"><Surface /></div>)
    if (available) expect(store.getState().hiddenIds).toEqual([targetId])
    await act(async () => vi.advanceTimersByTimeAsync(available ? 10001 : 0))
    expect(store.getState()).toMatchObject({ works: [], hiddenIds: [], reveal: null })
    expect(work.controller.signal.aborted).toBe(true)
    expect(legacyHidden).not.toHaveBeenCalled()
    expect(legacyReveal).not.toHaveBeenCalled()
    const next = { ...work, key: 2,
      controller: new AbortController() }
    act(() => { store.enqueue(next); store.requestReveal(targetId) })
    mounted.unmount()
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(next.controller.signal.aborted).toBe(true)
    expect(store.getState()).toMatchObject({ works: [], hiddenIds: [], reveal: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps an immediately completed standalone fallback visible', async () => {
    vi.stubGlobal('Worker', undefined)
    const onWorkConsumed = vi.fn(), onHiddenIdsChange = vi.fn(), onReveal = vi.fn()
    const work: BartGenerationWork = {
      key: 1, targets: [{ id: targetId, kind: 'report', createdAt: 1, title: 'report',
        metaText: '', cwdText: '', bodyText: '' }],
      controller: new AbortController()
    }
    render(<div className="app-shell"><BartThreadGenerations overviewOpen threads={[]} works={[work]}
      onWorkConsumed={onWorkConsumed} onHiddenIdsChange={onHiddenIdsChange} onReveal={onReveal} /></div>)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(onWorkConsumed).toHaveBeenCalledExactlyOnceWith(1)
    expect(onHiddenIdsChange).toHaveBeenLastCalledWith([])
    expect(onReveal).toHaveBeenLastCalledWith(null)
  })

  it('releases an absent target after the preparation budget so its later card is visible', async () => {
    vi.stubGlobal('Worker', class {})
    HTMLCanvasElement.prototype.transferControlToOffscreen = vi.fn()
    const onWorkConsumed = vi.fn()
    const onHiddenIdsChange = vi.fn()
    const controller = new AbortController()
    const work: BartGenerationWork = {
      key: 1,
      targets: [{
        id: targetId,
        kind: 'report',
        createdAt: 1,
        title: 'A report that has not mounted',
        metaText: 'Report',
        cwdText: '',
        bodyText: 'Its card will arrive after generation gives up.'
      }],
      controller
    }
    const { container, unmount } = render(<div className="app-shell">
      <BartThreadGenerations
        overviewOpen
        threads={[]}
        works={[work]}
        onWorkConsumed={onWorkConsumed}
        onHiddenIdsChange={onHiddenIdsChange}
      />
    </div>)
    expect(onHiddenIdsChange).toHaveBeenLastCalledWith([targetId])

    await act(async () => vi.advanceTimersByTimeAsync(9999))
    expect(onWorkConsumed).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(2))
    expect(onWorkConsumed).toHaveBeenCalledExactlyOnceWith(work.key)
    expect(controller.signal.aborted).toBe(true)
    expect(onHiddenIdsChange).toHaveBeenLastCalledWith([])

    // Registering later must not replay the expired generation's hidden state.
    const card = document.createElement('article')
    container.querySelector('.app-shell')!.append(card)
    const setHidden = vi.fn()
    getBartSpatialRegistry().registerThreadCard(targetId, card, setHidden)
    expect(setHidden).toHaveBeenCalledExactlyOnceWith(false)
    unmount()
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(vi.getTimerCount()).toBe(0)
  })
  it('StrictMode cleanup does not cancel the next setup, but real teardown releases pending work', async () => {
    vi.stubGlobal('Worker', class {})
    HTMLCanvasElement.prototype.transferControlToOffscreen = vi.fn()
    const controller = new AbortController()
    const work: BartGenerationWork = { key: 1, controller, targets: [{ id: targetId, kind: 'report', createdAt: 1,
      title: '', metaText: '', cwdText: '', bodyText: '' }] }
    const store = createOverviewOrchestrationStore()
    store.enqueue(work)
    const { unmount } = render(<StrictMode><div className="app-shell"><BartThreadGenerations overviewOpen threads={[]}
      works={[work]} orchestration={store} onWorkConsumed={store.consumeWork} /></div></StrictMode>)
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(controller.signal.aborted).toBe(false)
    expect(store.getState().hiddenIds).toEqual([targetId])
    unmount()
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(controller.signal.aborted).toBe(true)
    expect(store.getState().hiddenIds).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

})
