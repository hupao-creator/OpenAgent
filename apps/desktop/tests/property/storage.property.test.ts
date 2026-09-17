import fc from 'fast-check'
import type { Worker } from 'node:worker_threads'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ThreadStateStore } from '../../src/main/services/thread-state-store'
import { SqliteStatePersistence, type SqliteStatePersistenceOptions } from '../../src/main/services/sqlite-state-persistence'
import { createOpenAgentState, type OpenAgentState } from '../../src/shared/openagent-state'
import { createDefaultOpenAgentSettings } from '../../src/shared/openagent-settings'
import { checkAsync, sequenceLength } from './check'

type Status = 'running' | 'completed' | 'failed' | 'interrupted'
const status = fc.constantFrom<Status>('running', 'completed', 'failed', 'interrupted')
const value = fc.integer({ min: -1000, max: 1000 })
const command = fc.record({ threadId: fc.constantFrom('bart', 'agent'), value, status,
  action: fc.constantFrom('update', 'stale', 'flush') })
const storageEvents = 'generated command/release order in counterexample; see storage-property-testing.md'
const storageBudget = { normal: 10, explore: 100 }

function initialState(): OpenAgentState {
  const state = createOpenAgentState({ bartThreadId: 'bart', hostHarnessId: 'codex', bartThreadSettings: {},
    bartCwd: '/workspace/.bart', createdAt: 1, selectedThreadId: 'bart', settings: createDefaultOpenAgentSettings() })
  return { ...state, threads: [...state.threads, { id: 'agent', harnessId: 'codex', archived: false,
    revision: 0, title: 'Agent', emoji: '🧪', tags: [], cwd: '/workspace', settings: {}, sessionState: null,
    observation: { latestExecution: null, backgroundWork: null }, createdAt: 1, updatedAt: 1 }] }
}

function mutation(threadId: string, expectedRevision: number, value: number, status: Status) {
  return { type: 'replace-thread-session-state' as const, threadId, expectedRevision, sessionState: { value },
    observation: { latestExecution: { executionId: `execution-${expectedRevision + 1}`, startedAt: 1,
      summary: String(value), ...(status === 'running' ? { status } : { status, finishedAt: 2 }) }, backgroundWork: null },
    updatedAt: expectedRevision + 2 }
}

function pair(state: OpenAgentState, value: number, revision: number): OpenAgentState {
  return { ...state, threads: state.threads.map(thread => ({ ...thread, revision,
    sessionState: { value }, observation: mutation(thread.id, revision - 1, value, 'completed').observation,
    updatedAt: revision + 1 })) }
}

// Wall deadline detects a broken progress guarantee; it does not schedule I/O.
async function progress<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Storage progress deadline exceeded')), 5_000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

// Every sample owns real SQLite workers/files. Readers use the public load seam
// and close before returning; no test reads an owner's private values/versions.
async function sample(run: (directory: string, own: <T extends { close(): Promise<void> }>(owner: T) => T) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-storage-property-'))
  const owners: Array<{ close(): Promise<void> }> = []
  try { await run(directory, owner => { owners.push(owner); return owner }) }
  finally {
    await Promise.allSettled(owners.map(owner => owner.close()))
    await rm(directory, { recursive: true, force: true })
  }
}
// Resource diagnostics only: never inspect private state or version maps.
function workers(owner: SqliteStatePersistence | ThreadStateStore): Worker[] {
  const persistence = owner instanceof ThreadStateStore ? Reflect.get(owner, 'persistence') : owner
  const slots = Reflect.get(persistence, 'preparation') as Array<{ client?: { worker: Worker } }>
  const writer = Reflect.get(persistence, 'writer') as { worker: Worker } | undefined
  return [...slots.flatMap(slot => slot.client ? [slot.client.worker] : []), ...(writer ? [writer.worker] : [])]
}
async function disk(directory: string) {
  const reader = new SqliteStatePersistence(directory)
  try { return await reader.load() } finally { await reader.close() }
}

it('storage scoped commands pair revisions and durable outcomes', async () => {
  await checkAsync('storage scoped commands', fc.asyncProperty(
    fc.array(command, { minLength: 1, maxLength: sequenceLength(12) }), async commands => sample(async (directory, own) => {
      let transactions = 0
      const store = own(new ThreadStateStore(directory, { persistenceDebounceMs: 60_000,
        persistenceMaxWaitMs: 60_000, onTransaction: () => { transactions++ } }))
      await store.save(initialState())
      const expected = new Map(initialState().threads.map(thread => [thread.id, { revision: 0, value: null as number | null, status: null as Status | null }]))
      const events: unknown[] = []
      const apply = async (entry: typeof commands[number]) => {
        const model = expected.get(entry.threadId)!
        events.push({ ...entry, revision: model.revision })
        if (entry.action === 'flush') {
          await store.flushThread(entry.threadId)
        } else if (entry.action === 'stale') {
          // Old revision once a Thread has advanced; future mismatch for a fresh Thread.
          await expect(store.commit(mutation(entry.threadId, model.revision > 0 ? model.revision - 1 : 1, entry.value, entry.status))).rejects.toThrow('revision 已变化')
        } else {
          const before = transactions
          await store.commit(mutation(entry.threadId, model.revision, entry.value, entry.status))
          model.revision++
          model.value = entry.value
          model.status = entry.status
          if (entry.status === 'running') expect(transactions, JSON.stringify(events)).toBe(before)
        }
        const observed = store.read().threads.find(thread => thread.id === entry.threadId)!
        expect(observed.revision, JSON.stringify(events)).toBe(model.revision)
        expect(observed.sessionState).toEqual(model.value === null ? null : { value: model.value })
        expect(observed.observation.latestExecution?.summary ?? null).toBe(model.value === null ? null : String(model.value))
        expect(observed.observation.latestExecution?.status ?? null).toBe(model.status)
        if (entry.action === 'flush' || (entry.action === 'update' && entry.status !== 'running')) {
          expect((await disk(directory))!.threads.find(thread => thread.id === entry.threadId)).toEqual(observed)
        }
      }
      // Every sample exercises coalescing followed by a required durable terminal.
      await apply({ ...commands[0]!, action: 'update', status: 'running' })
      await apply({ ...commands[0]!, action: 'update', status: 'completed' })
      await apply({ ...commands[0]!, action: 'stale' })
      for (const entry of commands) await apply(entry)
      const accepted = store.commit(mutation('agent', expected.get('agent')!.revision, 42, 'running'))
      const ownedWorkers = workers(store)
      const closing = store.close()
      expect(store.close()).toBe(closing)
      await expect(store.commit(mutation('bart', 0, 0, 'running'))).rejects.toThrow('已关闭')
      await accepted
      await closing
      expect(ownedWorkers.length).toBe(3)
      expect(ownedWorkers.every(worker => worker.threadId === -1)).toBe(true)
      expect(store.read().threads[1]).toMatchObject({ revision: expected.get('agent')!.revision + 1, sessionState: { value: 42 }, observation: { latestExecution: { summary: '42', status: 'running' } } })
      expect(await disk(directory)).toEqual(store.read())
    })), storageEvents, undefined, storageBudget)
}, 130_000)

it('storage preparation order fences old versions including ABA', async () => {
  await checkAsync('storage preparation order', fc.asyncProperty(value,
    fc.shuffledSubarray([0, 1, 2, 3], { minLength: 4, maxLength: 4 }), async (a, order) => sample(async (directory, own) => {
      const gates = Array.from({ length: 4 }, deferred)
      const entered = Array.from({ length: 4 }, deferred)
      let active = false
      const persistence = own(new SqliteStatePersistence(directory, { async beforePrepare(key, record) {
        if (!active || key !== 'thread:bart') return
        const index = (record as { revision: number }).revision - 1
        entered[index]!.resolve()
        await gates[index]!.promise
      } }))
      const initial = pair(initialState(), a, 0)
      await persistence.persist(initial, 1)
      active = true
      const states = [a + 1, a + 2, a + 3, a].map((v, i) => pair(initial, v, i + 1))
      const writes = states.map((state, index) => persistence.persistThread(state, index + 2, 'bart'))
      // Attach rejection handlers before awaiting gates so failures never leak.
      const settled = Promise.allSettled(writes)
      try {
        await progress(Promise.all(entered.map(gate => gate.promise)))
        let newest = -1
        for (const index of order) {
          gates[index]!.resolve()
          await writes[index]
          newest = Math.max(newest, index)
          expect((await disk(directory))!.threads[0], `release order ${order}, through ${index}`).toEqual(states[newest]!.threads[0])
        }
      } finally { gates.forEach(gate => gate.resolve()); await settled }
      await persistence.close()
      // Exact same-record A → delayed B → A is distinct from equal payload/new revision.
      active = false
      const gate = deferred()
      const started = deferred()
      const aba = own(new SqliteStatePersistence(directory, { async beforePrepare(key, record) {
        if (key === 'thread:bart' && (record as { revision: number }).revision === 5) { started.resolve(); await gate.promise }
      } }))
      // Reuse the exact loaded object: a fresh reader would defeat samePart's
      // identity optimization and fail to exercise the unchanged-content fence.
      const stateA = (await aba.load())!
      const slow = aba.persist(pair(stateA, a + 10, 5), 2)
      const outcome = Promise.allSettled([slow])
      try { await progress(started.promise); await progress(aba.persist(stateA, 3)) }
      finally { gate.resolve(); await outcome }
      await slow
      expect(await disk(directory)).toEqual(stateA)
    })), storageEvents, undefined, storageBudget)
}, 130_000)

it('storage unrelated scopes progress and close drains admitted preparation', async () => {
  await checkAsync('storage unrelated scopes', fc.asyncProperty(value, status, async (v, terminal) => sample(async (directory, own) => {
    const started = deferred()
    const gate = deferred()
    let active = false
    let commits = 0
    const store = own(new ThreadStateStore(directory, { persistenceDebounceMs: 60_000, persistenceMaxWaitMs: 60_000,
      async beforePrepare(key) { if (active && key === 'thread:bart') { started.resolve(); await gate.promise } },
      onTransaction: () => { commits++ } }))
    await store.save(initialState())
    active = true
    const slow = store.commit(mutation('bart', 0, v, 'completed'))
    const result = Promise.allSettled([slow])
    let closing: Promise<void> | undefined
    let independentThread: OpenAgentState['threads'][number] | undefined
    try {
      await progress(started.promise)
      await progress(store.commit(mutation('agent', 0, v + 1, terminal)))
      await progress(store.flushThread('agent'))
      independentThread = store.read().threads[1]
      expect((await disk(directory))!.threads[1]).toEqual(independentThread)
      expect(store.read().threads[0]!.revision).toBe(0)
      let closed = false
      closing = store.close().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
    } finally { gate.resolve(); await result; await closing }
    await slow
    await store.close()
    expect(store.read().threads[1]).toEqual(independentThread)
    expect(store.read().threads[0]).toMatchObject({ revision: 1, sessionState: { value: v }, observation: { latestExecution: { summary: String(v), status: 'completed' } } })
    expect(await disk(directory)).toEqual(store.read())
    const before = commits
    await expect(store.save(initialState())).rejects.toThrow('已关闭')
    expect(commits).toBe(before)
  })), storageEvents, undefined, storageBudget)
}, 130_000)

it.each(['prepare', 'preparation-exit', 'admission', 'statement', 'before-commit', 'after-commit'] as const)(
  'storage recovery at %s preserves a complete aggregate', async boundary => {
    await checkAsync(`storage recovery at ${boundary}`, fc.asyncProperty(value,
      fc.uniqueArray(fc.integer({ min: 0, max: 20 }), { maxLength: 4 }), async (v, tags) => sample(async (directory, own) => {
        let active = false
        let attempts = 0
        let preparationRequests = 0
        const fault: SqliteStatePersistenceOptions = {
          async beforePrepare() { if (active && boundary === 'prepare') throw new Error('injected preparation rejection') },
          async beforeCommit() { attempts++; if (active && boundary === 'admission') throw new Error('injected admission rejection') },
          preparationFault: () => {
            if (!active || boundary !== 'preparation-exit') return undefined
            preparationRequests++
            return 'exit'
          },
          transactionFault: () => active && boundary !== 'prepare' && boundary !== 'preparation-exit' && boundary !== 'admission' ? boundary : undefined
        }
        const persistence = own(new SqliteStatePersistence(directory, fault))
        const initial = initialState()
        await persistence.persist(initial, 1)
        const changed = { ...pair(initial, v, 1), tagPool: tags.map(tag => ({ name: `tag-${tag}`, description: `Tag ${tag}` })),
          selectedThreadId: 'agent', settings: { ...initial.settings, locale: 'en-US' as const },
          threads: pair(initial, v, 1).threads.toReversed(),
          reports: [{ id: 'report', title: String(v), html: `<p>${v}</p>`, tags: [], relatedExecutions: [],
            archived: false, createdAt: 1, updatedAt: 2 }] }
        active = true
        const ownedWorkers = workers(persistence)
        const writing = persistence.persist(changed, 2)
        if (boundary === 'preparation-exit') {
          // The real worker exits only after receiving an admitted request;
          // this cannot pass by poisoning the owner before persist starts.
          await expect(writing).rejects.toThrow('SQLite worker exited (93)')
          expect(preparationRequests).toBeGreaterThan(0)
        } else await expect(writing).rejects.toThrow()
        const fatal = boundary === 'preparation-exit' || boundary === 'before-commit' || boundary === 'after-commit'
        // A rejected reply is NOT proof of rollback. These deterministic crash
        // seams know which side of COMMIT ran; arbitrary exits only promise old/new.
        expect(await disk(directory)).toEqual(boundary === 'after-commit' ? changed : initial)
        active = false
        if (fatal) {
          const before = attempts
          await expect(persistence.persist(changed, 3)).rejects.toThrow('reopen required')
          await expect(persistence.drain()).rejects.toThrow('reopen required')
          expect(attempts).toBe(before)
          await expect(persistence.close()).rejects.toThrow()
        } else {
          await persistence.persist(changed, 3)
          expect(await disk(directory)).toEqual(changed)
          await persistence.close()
        }
        expect(ownedWorkers.length).toBe(3)
        expect(ownedWorkers.every(worker => worker.threadId === -1)).toBe(true)
        const reopened = own(new SqliteStatePersistence(directory))
        await reopened.load()
        await reopened.persist(changed, 4)
        await reopened.close()
        expect(await disk(directory)).toEqual(changed)
      })), storageEvents, undefined, { normal: 6, explore: 40 })
  }, 130_000)

// The Report archive boundary: an archive is a whole-aggregate commit, so its Report
// and every covered Agent must already be durable when the commit promise resolves,
// while a coalescible running observation still waits for its debounce. The scoped
// commands family only proves a running observation opens no transaction — it never
// reads disk — so the negative half is asserted here, against the archive it must not
// be dragged along by, rather than as a second property repeating the same setup.
const reportId = 'report'
const deferredId = 'deferred'
const historicalId = 'historical'
const coveredId = (index: number): string => `covered-${index}`
const archiveExecutionId = (execution: number): string => `execution-${execution}`
type ArchiveShape = {
  readonly covered: readonly { readonly execution: number; readonly revision: number }[]
  readonly historical: number
  readonly payload: number
}
const archiveGraph: fc.Arbitrary<ArchiveShape> = fc.record({
  covered: fc.uniqueArray(fc.record({ execution: fc.integer({ min: 1, max: 999 }), revision: fc.nat({ max: 4 }) }),
    { selector: entry => entry.execution, minLength: 1, maxLength: 3 }),
  historical: fc.integer({ min: 1, max: 999 }),
  payload: value
})

// Mirrors initialState's Agent Thread; sessionState stays opaque fixture data, so a
// Report reference can only ever be matched through the public latest Execution.
function archiveAgent(id: string, revision: number, executionId: string | null): OpenAgentState['threads'][number] {
  return { id, harnessId: 'codex', archived: false, revision, title: id, emoji: '🧪', tags: [],
    cwd: '/workspace', settings: {}, sessionState: null, createdAt: 1, updatedAt: 1,
    observation: { latestExecution: executionId === null ? null
      : { executionId, status: 'completed', startedAt: 1, finishedAt: 2 }, backgroundWork: null } }
}

function archiveSeed(shape: ArchiveShape): OpenAgentState {
  const seeded = initialState()
  const covered = shape.covered.map((entry, index) =>
    archiveAgent(coveredId(index), entry.revision, archiveExecutionId(entry.execution)))
  return { ...seeded,
    reports: [{ id: reportId, title: 'Report', html: '<p>Archived by the Report Thread</p>', tags: [],
      createdAt: 1, updatedAt: 2, archived: false,
      // The historical reference keeps a superseded Execution while its Thread has
      // moved on, so the whole-aggregate comparison below also proves that holding a
      // reference is never on its own enough to archive that Thread.
      relatedExecutions: [
        ...shape.covered.map((entry, index) => ({ threadId: coveredId(index),
          executionId: archiveExecutionId(entry.execution) })),
        { threadId: historicalId, executionId: archiveExecutionId(shape.historical) }
      ] }],
    threads: [...seeded.threads, ...covered,
      archiveAgent(historicalId, 0, `${archiveExecutionId(shape.historical)}-superseded`),
      archiveAgent(deferredId, 0, null)] }
}

// Derived from the seed, never from the reducer under test.
function archiveExpected(seed: OpenAgentState, shape: ArchiveShape): OpenAgentState {
  const covered = new Set(shape.covered.map((_entry, index) => coveredId(index)))
  return { ...seed,
    reports: seed.reports.map(report => report.id === reportId ? { ...report, archived: true } : report),
    threads: seed.threads.map(thread => covered.has(thread.id)
      ? { ...thread, archived: true, revision: thread.revision + 1 } : thread) }
}

it('Report archive commits survive flush and close', async () => {
  await checkAsync('Report archive commits survive flush and close', fc.asyncProperty(archiveGraph,
    async shape => sample(async (directory, own) => {
      const store = own(new ThreadStateStore(directory, { persistenceDebounceMs: 60_000,
        persistenceMaxWaitMs: 60_000 }))
      const seed = archiveSeed(shape)
      await store.save(seed)
      expect(await disk(directory)).toEqual(seed)

      // Negative half: a running observation is coalescible, so its commit publishes
      // in memory and deliberately leaves the durable aggregate untouched.
      const running = mutation(deferredId, 0, shape.payload, 'running')
      await store.commit(running)
      expect(store.read().threads.find(thread => thread.id === deferredId)!.observation).toEqual(running.observation)
      expect(await disk(directory)).toEqual(seed)

      // Positive half: the archive carries its whole aggregate — the Report and every
      // covered Agent — to disk before commit resolves, and still does not drag the
      // unrelated running observation along with it.
      await store.commit({ type: 'archive-report', reportId,
        relatedThreadIds: seed.reports[0]!.relatedExecutions.map(reference => reference.threadId) })
      const sealed = archiveExpected(seed, shape)
      expect(await disk(directory)).toEqual(sealed)
      const committed = { ...sealed, threads: sealed.threads.map(thread => thread.id === deferredId
        ? { ...thread, revision: running.expectedRevision + 1, sessionState: running.sessionState,
            observation: running.observation, updatedAt: running.updatedAt } : thread) }
      expect(store.read()).toEqual(committed)

      await store.flush()
      expect(await disk(directory)).toEqual(committed)

      const closing = store.close()
      expect(store.close()).toBe(closing)
      await closing
      expect(await disk(directory)).toEqual(committed)
    })), storageEvents, undefined, storageBudget)
}, 130_000)
