import { describe, expect, it, vi } from 'vitest'
import { createInitialRendererState } from '../src/shared/renderer-state'
import type { RendererStateMutation } from '../src/shared/renderer-state-contracts'
import { createRendererStateMutation } from '../src/shared/renderer-state-patch'
import { synchronizeRendererState } from '../src/shared/renderer-state-sync'
import { createRendererStateStore } from '../src/shared/renderer-store'

describe('renderer state synchronization', () => {
  it('accepts later patches after a visual failure without rehydrating or showing a fatal error', async () => {
    const store = createRendererStateStore('')
    let snapshot = { ...createInitialRendererState('A'), revision: 1 }
    let listener!: (mutation: RendererStateMutation) => void
    const load = vi.fn(async () => snapshot)
    const failed = vi.fn()
    const transitionFailed = vi.fn()
    const capture = vi.fn(() => { throw new Error('visual failure') })
    const stop = synchronizeRendererState({
      store, load,
      subscribe: (next) => { listener = next; return () => undefined },
      beforeCommit: capture,
      transitionFailed,
      hydrated: () => undefined,
      failed
    })
    await vi.waitFor(() => expect(store.getState().revision).toBe(1))

    for (const defaultCwd of ['B', 'A']) {
      const next = { ...snapshot, revision: snapshot.revision + 1, defaultCwd }
      listener(createRendererStateMutation(snapshot, next))
      snapshot = next
    }

    expect(store.getState().revision).toBe(3)
    expect(store.getState().defaultCwd).toBe('A')
    expect(capture.mock.calls).toHaveLength(2)
    expect(transitionFailed).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenCalledOnce()
    expect(failed).not.toHaveBeenCalled()
    stop()
  })
})
