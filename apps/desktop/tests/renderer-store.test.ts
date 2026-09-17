import { createRendererStateMutation } from '../src/shared/renderer-state-patch'
import { describe, expect, it, vi } from 'vitest'
import type { AgentThreadRecord } from '@openagent/contracts'
import { createInitialRendererState } from '../src/shared/renderer-state'
import {
  applyRendererStateStoreMutation,
  createRendererStateStore,
  hydrateRendererStateStore,
  rendererAppState
} from '../src/shared/renderer-store'

describe('renderer state store', () => {
  it('hydrates an authoritative revision-zero snapshot', () => {
    const store = createRendererStateStore('/initial')
    const initial = createInitialRendererState('/hydrated')
    const snapshot = {
      ...initial,
      defaultCwd: '/hydrated'
    }

    hydrateRendererStateStore(store, snapshot)

    expect(rendererAppState(store.getState())).toEqual(snapshot)
    expect(store.getState().defaultCwd).toBe('/hydrated')
  })

  it('publishes only newer committed patches', () => {
    const store = createRendererStateStore('')
    const beforeCommit = vi.fn()
    const listener = vi.fn()
    store.subscribe(listener)
    const revisionTwo = { ...rendererAppState(store.getState()), revision: 2 }

    expect(applyRendererStateStoreMutation(store, createRendererStateMutation(rendererAppState(store.getState()), revisionTwo), beforeCommit)).toBe(true)
    expect(beforeCommit).toHaveBeenCalledWith(expect.objectContaining({ revision: 0 }), revisionTwo)
    expect(listener).toHaveBeenCalledOnce()

    expect(applyRendererStateStoreMutation(store, createRendererStateMutation(rendererAppState(store.getState()), { ...revisionTwo, revision: 1 }), beforeCommit)).toBe(false)
    expect(store.getState().revision).toBe(2)
    expect(beforeCommit).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('commits authoritative state and reports a failed visual observer', () => {
    const store = createRendererStateStore('')
    const error = new Error('layout measurement failed')
    const failed = vi.fn((failure) => {
      expect(store.getState().revision).toBe(failure.nextRevision)
    })
    const current = rendererAppState(store.getState())
    const mutation = createRendererStateMutation(current, { ...current, revision: 1 })

    expect(applyRendererStateStoreMutation(store, mutation, () => { throw error }, failed)).toBe(true)
    expect(store.getState().revision).toBe(1)
    expect(failed).toHaveBeenCalledWith({ error, currentRevision: 0, nextRevision: 1 })
  })

  it('captures each A → B → A transition before publishing even after a failed capture', () => {
    const store = createRendererStateStore('A')
    const captures: string[] = []
    const published: string[] = []
    const failed = vi.fn()
    store.subscribe((state) => { published.push(state.defaultCwd) })
    const capture = (current: ReturnType<typeof rendererAppState>, next: ReturnType<typeof rendererAppState>) => {
      expect(store.getState().revision).toBe(current.revision)
      captures.push(`${current.defaultCwd} → ${next.defaultCwd}`)
      if (next.defaultCwd === 'B') throw new Error('visual failure')
    }
    for (const defaultCwd of ['B', 'A']) {
      const current = rendererAppState(store.getState())
      applyRendererStateStoreMutation(store, createRendererStateMutation(current, {
        ...current, revision: current.revision + 1, defaultCwd
      }), capture, failed)
    }
    expect(captures).toEqual(['A → B', 'B → A'])
    expect(published).toEqual(['B', 'A'])
    expect(failed).toHaveBeenCalledOnce()
    expect(store.getState().revision).toBe(2)
  })

  it('keeps Agent subscriptions stable during a Bart-only stream', () => {
    const store = createRendererStateStore('')
    const bart = { ...agentThread('bart', 1), bart: true as const, transcript: [] }
    hydrateRendererStateStore(store, {
      ...createInitialRendererState(''), revision: 1, threads: [bart, agentThread('agent', 1)]
    })
    const initial = store.getState()
    applyRendererStateStoreMutation(store, createRendererStateMutation(rendererAppState(initial), {
      ...rendererAppState(initial), revision: 2,
      threads: [{ ...bart, revision: 2, sessionState: { text: 'token' } }, ...initial.agentThreads]
    }))
    expect(store.getState().agentThreads).toBe(initial.agentThreads)
    expect(store.getState().agentThreadIds).toBe(initial.agentThreadIds)
    expect(store.getState().agentCatalogRevision).toBe(initial.agentCatalogRevision)
    expect(store.getState().agentContentRevision).toBe(initial.agentContentRevision)
  })

  it('invalidates catalog filters when observation changes task bucket', () => {
    const store = createRendererStateStore('')
    const first = agentThread('one', 1)
    hydrateRendererStateStore(store, { ...createInitialRendererState(''), revision: 1, threads: [first] })
    const initial = store.getState()
    applyRendererStateStoreMutation(store, createRendererStateMutation(rendererAppState(initial), {
      ...rendererAppState(initial), revision: 2, threads: [{ ...first, revision: 2,
        observation: { ...first.observation, backgroundWork: { status: 'running' } }
      }]
    }))
    expect(store.getState().agentCatalogRevision).toBe(initial.agentCatalogRevision + 1)
  })

  it('normalizes Threads and preserves unchanged record references', () => {
    const store = createRendererStateStore('')
    const first = agentThread('one', 1)
    const second = agentThread('two', 1)
    hydrateRendererStateStore(store, {
      ...createInitialRendererState(''),
      revision: 1,
      threads: [first, second]
    })
    const initial = store.getState()

    applyRendererStateStoreMutation(store, createRendererStateMutation(rendererAppState(store.getState()), {
        ...rendererAppState(initial),
        revision: 2,
        threads: [
          { ...first, revision: 2, sessionState: { streamed: true } },
          structuredClone(second)
        ]
      }))

    const next = store.getState()
    expect(next.threadIds).toBe(initial.threadIds)
    expect(next.agentThreadIds).toBe(initial.agentThreadIds)
    expect(next.threadsById.one).not.toBe(initial.threadsById.one)
    expect(next.threadsById.two).toBe(initial.threadsById.two)
    expect(next.agentContentRevision).toBe(initial.agentContentRevision + 1)
    expect(next.agentCatalogRevision).toBe(initial.agentCatalogRevision)
  })

  it('advances the catalog revision only for filter metadata changes', () => {
    const store = createRendererStateStore('')
    const first = agentThread('one', 1)
    hydrateRendererStateStore(store, {
      ...createInitialRendererState(''),
      revision: 1,
      threads: [first]
    })
    const initial = store.getState()

    applyRendererStateStoreMutation(store, createRendererStateMutation(rendererAppState(store.getState()), {
        ...rendererAppState(initial),
        revision: 2,
        threads: [{ ...first, revision: 2, title: 'Renamed' }]
      }))

    expect(store.getState().agentCatalogRevision).toBe(initial.agentCatalogRevision + 1)
  })

  it('refreshes the overview catalog when archived or execution identity changes without a status change', () => {
    const store = createRendererStateStore('')
    const first = { ...agentThread('one', 1), observation: {
      latestExecution: { executionId: 'e1', status: 'completed' as const, startedAt: 1, finishedAt: 2 }, backgroundWork: null
    } }
    hydrateRendererStateStore(store, { ...createInitialRendererState(''), revision: 1, threads: [first] })
    const startRevision = store.getState().agentCatalogRevision
    for (const [index, next] of [
      { ...first, archived: true },
      { ...first, archived: false },
      { ...first, observation: { ...first.observation, latestExecution: { ...first.observation.latestExecution, executionId: 'e2' } } }
    ].entries()) {
      const current = rendererAppState(store.getState())
      applyRendererStateStoreMutation(store, createRendererStateMutation(current, {
        ...current, revision: current.revision + 1, threads: [{ ...next, revision: index + 2 }]
      }))
      expect(store.getState().agentCatalogRevision).toBe(startRevision + index + 1)
    }
  })

  it('advances the catalog revision when the directory-tag worktree root changes', () => {
    const store = createRendererStateStore('')
    const first = {
      ...agentThread('one', 1),
      worktree: { baseCwd: '/workspace/first', native: true }
    }
    hydrateRendererStateStore(store, {
      ...createInitialRendererState(''),
      revision: 1,
      threads: [first]
    })
    const initial = store.getState()

    applyRendererStateStoreMutation(store, createRendererStateMutation(rendererAppState(store.getState()), {
        ...rendererAppState(initial),
        revision: 2,
        threads: [{
          ...first,
          revision: 2,
          worktree: { ...first.worktree, baseCwd: '/workspace/second' }
        }]
      }))

    expect(store.getState().agentCatalogRevision).toBe(initial.agentCatalogRevision + 1)
  })
})

function agentThread(id: string, revision: number): AgentThreadRecord {
  return {
    id,
    harnessId: 'codex',
    archived: false,
    revision,
    sessionState: null,
    observation: { latestExecution: null, backgroundWork: null },
    title: id,
    tags: [],
    cwd: '/workspace',
    settings: {},
    createdAt: 1,
    updatedAt: revision
  }
}
