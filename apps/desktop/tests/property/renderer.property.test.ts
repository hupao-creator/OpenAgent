import fc from 'fast-check'
import { expect, it } from 'vitest'
import type { AgentThreadRecord } from '@openagent/contracts'
import { createInitialRendererState } from '../../src/shared/renderer-state'
import type { RendererAppState } from '../../src/shared/renderer-state-contracts'
import { applyRendererStatePatch as apply, createRendererStateMutation as diff, mergeRendererStateMutations as merge, RendererStateGapError } from '../../src/shared/renderer-state-patch'
import { createRendererStateStore, rendererAppState } from '../../src/shared/renderer-store'
import { synchronizeRendererState } from '../../src/shared/renderer-state-sync'
import { check, checkAsync } from './check'

const change = fc.record({
  ids: fc.uniqueArray(fc.integer({ min: 0, max: 5 }), { maxLength: 6 }),
  reports: fc.uniqueArray(fc.integer({ min: 0, max: 5 }), { maxLength: 6 }),
  title: fc.string({ maxLength: 12 }), cwd: fc.string({ maxLength: 12 }), archived: fc.boolean(), appearance: fc.constantFrom('system' as const, 'light' as const, 'dark' as const)
})
// Each generated commit increments every included entity revision, including reinserted IDs.
// Opaque payloads are carried as values, never interpreted by the reference model.
function state(value: { ids: number[]; reports: number[]; title: string; cwd: string; archived: boolean; appearance: 'system' | 'light' | 'dark' }, revision = 1): RendererAppState {
  const initial = createInitialRendererState(value.cwd)
  return { ...initial, revision, settings: { ...initial.settings, appearance: value.appearance },
    threads: value.ids.map(id => ({ id: `t${id}`, revision, title: value.title, tags: [],
      harnessId: 'codex', cwd: value.cwd, settings: {}, sessionState: { opaque: value.title },
      observation: { latestExecution: null, backgroundWork: null }, archived: value.archived,
      createdAt: 1, updatedAt: revision } satisfies AgentThreadRecord)),
    reports: value.reports.map(id => ({ id: `r${id}`, title: value.title, tags: [],
      relatedExecutions: [], archived: value.archived, createdAt: 1, updatedAt: revision, previewText: value.title })),
    selectedThreadId: value.ids.length ? `t${value.ids[0]}` : null }
}
const states = fc.tuple(change, change, change, fc.integer({ min: 1, max: 1000 })).map(([a, b, c, revision]) =>
  [state(a, revision), state(b, revision + 1), state(c, revision + 2)] as const)
const effect = { type: 'bart-generation', target: { kind: 'report', id: 'r0' } } as const

it('renderer patches round-trip and compose legal revisions', () => {
  check('renderer patches round-trip', fc.property(states, ([a, b, c]) => {
    const ab = diff(a, b)
    const bc = diff(b, c)
    expect(apply(a, ab)).toEqual(b)
    expect(apply(b, bc)).toEqual(c)
    expect(apply(a, merge(ab, bc))).toEqual(c)
    expect(apply(apply(a, ab), bc)).toEqual(c)
    expect(apply(c, ab)).toBe(c)
    expect(apply(c, bc)).toBe(c)
    expect(() => apply(a, bc)).toThrow(RendererStateGapError)
    expect(() => merge({ ...ab, effect }, bc)).toThrow(RendererStateGapError)
    expect(() => merge(ab, { ...bc, baseRevision: bc.baseRevision + 1 })).toThrow(RendererStateGapError)
    // A successor effect is allowed but remains a single cue on the final mutation.
    const combined = merge(ab, { ...bc, effect })
    expect(combined.effect).toEqual(effect)
    expect(apply(a, combined)).toEqual(c)
    if (c.threads.length) {
      const stale = { ...c.threads[0], revision: c.threads[0].revision - 1, title: 'stale' }
      const patched = apply(c, { type: 'state-patched', baseRevision: c.revision, revision: c.revision + 1,
        threads: { upserts: [stale], removedIds: [] } })
      expect(patched.threads).toEqual(c.threads)
    }
  }))
}, 130_000)

it('renderer gap recovery hydrates without replaying stale effects', async () => {
  await checkAsync('renderer gap recovery', fc.asyncProperty(states, async ([a, b, c]) => {
    const store = createRendererStateStore('')
    let listener!: (mutation: ReturnType<typeof diff>) => void
    let snapshot = a
    let loads = 0
    let effects = 0
    let unsubscribed = false
    const failures: unknown[] = []
    let hydrated!: () => void
    let ready = new Promise<void>(resolve => { hydrated = resolve })
    const stop = synchronizeRendererState({ store,
      load: async () => { loads++; return snapshot },
      subscribe: next => { listener = next; return () => { unsubscribed = true } },
      beforeCommit: () => { effects++ }, failed: error => failures.push(error), hydrated: () => hydrated() })
    try {
      await ready
      snapshot = c
      ready = new Promise<void>(resolve => { hydrated = resolve })
      listener(diff(b, c, effect)) // Missing A → B forces one snapshot recovery.
      await ready
      expect(rendererAppState(store.getState())).toEqual(c)
      expect(loads).toBe(2)
      expect(effects).toBe(0)
      expect(failures).toEqual([])
    } finally { stop() }
    expect(unsubscribed).toBe(true)
  }))
}, 130_000)
