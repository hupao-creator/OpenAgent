import { afterEach, expect, it, vi } from 'vitest'
import { connectBartDisplay } from '../src/renderer/src/bart-display/source'
import { BartDisplayQueue } from '../src/renderer/src/bart-display/queue'
import { harnessRendererPlugins } from '../src/renderer/src/harness-composition'
import { applyRendererStateStoreMutation, createRendererStateStore, hydrateRendererStateStore, rendererAppState } from '../src/shared/renderer-store'
import { createInitialRendererState } from '../src/shared/renderer-state'
import { createRendererStateMutation } from '../src/shared/renderer-state-patch'

afterEach(() => vi.restoreAllMocks())

it('skips unchanged Bart history while accepting activity-only events and authoritative recovery', () => {
  const store = createRendererStateStore('')
  const bart = { id: 'bart', bart: true as const, harnessId: 'pi' as const, revision: 1, title: 'Bart', tags: [], cwd: '/',
    settings: {}, sessionState: null, transcript: [], createdAt: 1, updatedAt: 1,
    observation: { latestExecution: { executionId: 'run', startedAt: 1, status: 'running' as const }, backgroundWork: null } }
  hydrateRendererStateStore(store, { ...createInitialRendererState(''), revision: 1, threads: [bart] })
  const project = vi.spyOn(harnessRendererPlugins.pi, 'projectBartDock').mockReturnValue(undefined)
  const queue = new BartDisplayQueue()
  const disconnect = connectBartDisplay(queue, store)
  try {
    expect(project).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 100; index++) {
      const previous = rendererAppState(store.getState())
      const agent = { ...bart, id: 'agent', bart: false as const, archived: false, revision: index + 1, sessionState: { text: `token ${index}` } }
      applyRendererStateStoreMutation(store, createRendererStateMutation(previous, { ...previous, revision: previous.revision + 1, threads: [bart, agent] }))
    }
    expect(project).toHaveBeenCalledTimes(1)
    const revision = store.getState().revision
    applyRendererStateStoreMutation(store, { type: 'state-patched', baseRevision: revision, revision: revision + 1,
      bartActivities: [{ threadId: 'bart', harnessId: 'pi', activity: { executionId: 'run', sequence: 1, kind: 'reasoning', text: 'Still delivered' } }] })
    expect(project).toHaveBeenCalledTimes(1)
    expect(queue.getSnapshot().item.role).toMatchObject({ kind: 'reasoning', text: 'Still delivered' })
    hydrateRendererStateStore(store, rendererAppState(store.getState()))
    expect(project).toHaveBeenCalledTimes(2)
    expect(queue.getSnapshot().item.role).toEqual({ kind: 'running' })
  } finally { disconnect(); queue.dispose() }
})
