import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  threadDirectoryTag,
  type AgentThreadRecord,
  type PublicExecution,
  type ThreadPublicObservation
} from '@openagent/contracts'
import { ThreadStateStore, type ThreadStateStoreOptions } from '../../src/main/services/thread-state-store'
import { ReportService } from '../../src/main/use-cases/report-service'
import {
  createOpenAgentState,
  readAgentThread,
  readBartThread,
  type OpenAgentState
} from '../../src/shared/openagent-state'
import { createDefaultOpenAgentSettings } from '../../src/shared/openagent-settings'
import type { ReportThreadRecord } from '../../src/shared/report-thread'
import { checkAsync } from './check'

const timeout = process.env.FC_EXPLORE ? 130_000 : 35_000
const budget = process.env.FC_EXPLORE ? 120_000 : 30_000
// Every sample owns a temporary directory and a real SQLite store, which makes a
// sample roughly forty times more expensive than the pure families' samples. Six
// is the smallest tier already used by the storage family's own fault boundaries;
// the archive's assertions are gate-driven rather than volume-driven.
const samples = { normal: 6, explore: 60 }

const stores: ThreadStateStore[] = []
const directories: string[] = []
const signal = new AbortController().signal

/**
 * Closes and removes every store and directory the finished sample created.
 * fast-check calls this after each predicate invocation, shrinking re-runs
 * included, so an exploration run does not hold sixty open SQLite databases —
 * each with its own workers — until the whole property ends. The Vitest
 * `afterEach` below stays as the fallback for a sample that never returns.
 */
async function releaseSample(): Promise<void> {
  await Promise.allSettled(stores.splice(0).map(store => store.close()))
  await Promise.allSettled(directories.splice(0).map(
    directory => rm(directory, { recursive: true, force: true })))
}

afterEach(releaseSample)

type Status = 'running' | 'waiting-for-user' | 'completed' | 'interrupted' | 'failed'
const statuses: readonly Status[] = ['running', 'waiting-for-user', 'completed', 'interrupted', 'failed']
const nonFailing = statuses.filter(status => status !== 'failed')

function execution(status: Status, executionId: string, startedAt: number): PublicExecution {
  if (status === 'running') return { executionId, status, startedAt }
  if (status === 'waiting-for-user') {
    return { executionId, status, startedAt, interactions: [{
      id: 'interaction', kind: 'question', title: 'Continue?',
      actions: [{ id: 'submit', intent: 'submit', label: 'OK' }], questions: []
    }] }
  }
  return status === 'failed'
    ? { executionId, status, startedAt, finishedAt: startedAt + 1, error: 'native failed' }
    : { executionId, status, startedAt, finishedAt: startedAt + 1 }
}

const observation = (status: Status, executionId: string, startedAt: number): ThreadPublicObservation =>
  ({ latestExecution: execution(status, executionId, startedAt), backgroundWork: null })

const absent: ThreadPublicObservation = { latestExecution: null, backgroundWork: null }

function agent(id: string, observation: ThreadPublicObservation, overrides: Partial<AgentThreadRecord> = {}): AgentThreadRecord {
  return {
    id, harnessId: 'codex', archived: false, revision: 0, title: id, tags: ['retained'], cwd: '/workspace',
    createdAt: 1, updatedAt: 2, settings: { model: 'fixture-model' },
    sessionState: { privateTurn: `kept-${id}` }, observation, ...overrides
  }
}

/**
 * The reported aggregate: the Report references `referenceId` for each Thread it
 * lists, and each Thread's current Execution is decided by its own role. A Thread
 * is covered only when *its own* current Execution is the referenced one, so one
 * world holds both covered and referenced-but-uncovered Agents.
 */
interface ArchiveWorld {
  readonly referenceId: string
  readonly roles: readonly ('matched' | 'covered' | 'diverged' | 'empty' | 'archived' | 'bart')[]
  readonly extraReferences: readonly ('missing' | 'bart')[]
}

const archiveWorld = fc.record({
  referenceId: fc.constantFrom('E1', 'E2'),
  roles: fc.uniqueArray(fc.constantFrom('matched' as const, 'covered' as const, 'diverged' as const,
    'empty' as const, 'archived' as const, 'bart' as const), { minLength: 1, maxLength: 6 }),
  extraReferences: fc.uniqueArray(fc.constantFrom('missing' as const, 'bart' as const), { maxLength: 2 })
})

const roleThreadId = (role: ArchiveWorld['roles'][number]): string =>
  role === 'archived' ? 'prearchived' : role

/** The completed Execution a `diverged` Thread observes: never the referenced one. */
const divergedExecutionId = (world: ArchiveWorld): string =>
  world.referenceId === 'E1' ? 'E2' : 'E1'

/**
 * The Report references every listed Thread with one shared Execution ID. The
 * `bart` role names the existing Bart Thread; references stay unique because a
 * repeated Thread would not match the reference scope the archive locks.
 */
function references(world: ArchiveWorld): Array<{ threadId: string; executionId: string }> {
  const ids = [...world.roles.map(roleThreadId), ...world.extraReferences]
  return [...new Set(ids)].map(threadId => ({ threadId, executionId: world.referenceId }))
}

function worldThreads(world: ArchiveWorld): AgentThreadRecord[] {
  return world.roles.filter(role => role !== 'bart').map(role => role === 'empty'
    ? agent('empty', absent)
    : role === 'archived'
      ? agent('prearchived', observation('completed', world.referenceId, 1), { archived: true })
      : agent(role, observation('completed',
        role === 'diverged' ? divergedExecutionId(world) : world.referenceId, 1)))
}

/**
 * The documented archive outcome: the Report becomes archived, and every
 * referenced Agent whose current Execution is the referenced one is archived,
 * except Bart, which has no archive state at all.
 */
function expectedArchive(state: OpenAgentState, reportId: string): OpenAgentState {
  const report = state.reports.find(candidate => candidate.id === reportId)!
  const referenced = new Map(report.relatedExecutions.map(reference =>
    [reference.threadId, reference.executionId]))
  return {
    ...state,
    reports: state.reports.map(candidate => candidate.id === reportId
      ? { ...candidate, archived: true } : candidate),
    threads: state.threads.map(thread => {
      if (!referenced.has(thread.id) || !('archived' in thread)) return thread
      if (thread.observation.latestExecution?.executionId !== referenced.get(thread.id)) return thread
      return thread.archived ? thread : { ...thread, archived: true, revision: thread.revision + 1 }
    })
  }
}

async function open(options?: ThreadStateStoreOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-report-archive-property-'))
  directories.push(directory)
  const store = new ThreadStateStore(directory, {
    persistenceDebounceMs: 60_000, persistenceMaxWaitMs: 60_000, ...options
  })
  stores.push(store)
  return { directory, store }
}

async function setup(world: ArchiveWorld, options?: ThreadStateStoreOptions) {
  const fixture = await open(options)
  const initial = createOpenAgentState({
    bartThreadId: 'bart', hostHarnessId: 'codex', bartThreadSettings: {}, bartCwd: '/bart',
    createdAt: 1, selectedThreadId: null, settings: createDefaultOpenAgentSettings()
  })
  const report: ReportThreadRecord = {
    id: 'report', title: 'Report', html: '<p>Retained HTML</p>', tags: ['retained'],
    createdAt: 1, updatedAt: 2, archived: false, relatedExecutions: references(world)
  }
  // `unrelated` is never referenced: no archive may reach it.
  await fixture.store.save({ ...initial, reports: [report],
    threads: [...initial.threads, ...worldThreads(world), agent('unrelated', observation('completed', 'E1', 1))] })
  const reports = new ReportService({
    readReports: () => fixture.store.read().reports,
    // Mirrors the production composition, which prepends the Thread's workspace
    // directory tag to its own tags before snapshotting them.
    readThreadTags: id => {
      const thread = readAgentThread(fixture.store.read(), id)
      return [threadDirectoryTag(thread), ...thread.tags]
    },
    // A Core-side stand-in, not the production Harness delegation: these worlds
    // carry opaque fixture session state, so an owning Harness could not resolve
    // it. The double resolves a reference only when it names the Thread's current
    // public Execution, which is stricter than the documented reference rule —
    // that one keeps an older completed Execution eligible. Worlds that need a
    // superseded reference seed the record instead of going through ReportService.
    resolveExecution: (id, executionId) => {
      const latest = readAgentThread(fixture.store.read(), id).observation.latestExecution
      return latest?.executionId === executionId ? latest : null
    },
    replaceReports: async reports => { await fixture.store.commit({ type: 'replace-reports', reports }) },
    archiveReport: async (reportId, relatedThreadIds) => {
      await fixture.store.commit({ type: 'archive-report', reportId, relatedThreadIds })
    }
  }, { timestamp: (...floors) => Math.max(3, ...floors) + 1, createId: () => 'new-report' })
  return { ...fixture, reports }
}

/** A fresh reader connection, so every disk expectation is independent of memory. */
async function disk(directory: string): Promise<OpenAgentState | null> {
  const store = new ThreadStateStore(directory)
  try { return await store.load() } finally { await store.close() }
}

function barrier(count = 1) {
  let entries = 0
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => {
    entered = () => { if (++entries === count) resolve() }
  })
  const gate = new Promise<void>(resolve => { release = resolve })
  return { started, release, enter: async () => { entered(); await gate } }
}

/** Applies one observation to `agent`, at the next legal monotonic timestamp. */
async function observe(store: ThreadStateStore, next: ThreadPublicObservation): Promise<OpenAgentState> {
  const current = readAgentThread(store.read(), 'agent')
  return store.commit({
    type: 'replace-thread-session-state', threadId: current.id,
    expectedRevision: current.revision, sessionState: current.sessionState,
    observation: next, updatedAt: current.updatedAt + 1
  })
}

const steps = fc.array(fc.oneof(
  fc.record({
    kind: fc.constant('observe' as const),
    executionId: fc.constantFrom('E1', 'E2'),
    status: fc.constantFrom(...statuses),
    startedAt: fc.integer({ min: 1, max: 3 })
  }),
  fc.record({ kind: fc.constant('unarchive' as const) })
), { minLength: 1, maxLength: 6 })

/**
 * Applies one step and asserts the archive contract step by step, so a
 * transient re-archive cannot hide behind a later unarchive.
 */
async function replay(store: ThreadStateStore, sequence: readonly { readonly kind: string }[]): Promise<void> {
  for (const step of sequence) {
    const before = readAgentThread(store.read(), 'agent')
    if (step.kind === 'unarchive') {
      await store.commit({ type: 'set-agent-thread-archived', threadId: 'agent', archived: false })
      expect(readAgentThread(store.read(), 'agent').archived).toBe(false)
      continue
    }
    const observationStep = step as unknown as { executionId: string; status: Status; startedAt: number }
    const next = observation(observationStep.status, observationStep.executionId, observationStep.startedAt)
    await observe(store, next)
    const after = readAgentThread(store.read(), 'agent')
    const committed = before.observation.latestExecution
    // A non-failed observation archives nothing, and a failure the Thread has
    // already recorded as its latest Execution is not a new failure. A failure
    // for an Execution the Thread has not seen before is the archiving case, so
    // it carries no assertion here.
    const repeatsRecordedFailure = committed !== null &&
      committed.executionId === observationStep.executionId && committed.status === 'failed'
    if (observationStep.status !== 'failed' || repeatsRecordedFailure) {
      expect(after.archived).toBe(before.archived)
    }
  }
}

const archiveFlags = (state: OpenAgentState): boolean[] =>
  state.threads.filter(thread => 'archived' in thread).map(thread => Boolean(thread.archived))

it('A repeated observation never changes the archive flag', async () => {
  await checkAsync('A repeated observation never changes the archive flag', fc.asyncProperty(
    steps,
    async sequence => {
      const fixture = await setup({ referenceId: 'E2', roles: ['diverged'], extraReferences: [] })
      await fixture.store.save({ ...fixture.store.read(), threads: [...fixture.store.read().threads,
        agent('agent', absent)] })
      // The sequence runs twice so the second pass meets the state the first pass
      // committed - the already observed Execution, the dismissed failure and the
      // already archived Thread - and every step is asserted as it is applied.
      // The passes are deliberately not compared tail to tail: an `unarchive`
      // step clears the flag by design, so a later repeat of the same failure
      // legitimately has a different effect in each pass.
      await replay(fixture.store, sequence)
      await replay(fixture.store, sequence)
      // A repeated failure keeps its content and its deadline-safe observation.
      expect(readAgentThread(fixture.store.read(), 'agent').sessionState).toEqual({ privateTurn: 'kept-agent' })
    }
  ).afterEach(releaseSample), 'generated observation and unarchive steps applied twice in the same order with a fresh expectedRevision', budget, samples)
}, timeout)

it('Only a strictly later failed Execution re-archives after an unarchive', async () => {
  await checkAsync('Only a strictly later failed Execution re-archives after an unarchive', fc.asyncProperty(
    fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 }),
    async (firstStartedAt, secondStartedAt) => {
      const fixture = await setup({ referenceId: 'E2', roles: ['diverged'], extraReferences: [] })
      await fixture.store.save({ ...fixture.store.read(), threads: [...fixture.store.read().threads,
        agent('agent', absent)] })
      await observe(fixture.store, observation('running', 'E1', firstStartedAt))
      await observe(fixture.store, observation('failed', 'E1', firstStartedAt))
      expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(true)
      await fixture.store.commit({ type: 'set-agent-thread-archived', threadId: 'agent', archived: false })
      // The dismissed failure never archives again, however often it is seen.
      await observe(fixture.store, observation('failed', 'E1', firstStartedAt))
      expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(false)

      // A failure for an Execution that was never observed as running is a late
      // notification: it archives only when it started strictly later than the
      // committed latest, because an equal timestamp cannot be ordered.
      await observe(fixture.store, observation('failed', 'E2', secondStartedAt))
      expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(secondStartedAt > firstStartedAt)
      // The ordinary running-to-failed transition on the committed Execution
      // always archives, whatever the earlier start times were.
      await observe(fixture.store, observation('running', 'E3', 5))
      await observe(fixture.store, observation('failed', 'E3', 5))
      expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(true)
    }
  ).afterEach(releaseSample), 'a dismissed failure followed by a distinct failed Execution with a generated start time', budget, samples)
}, timeout)

it('A non-failed observation never archives a Thread', async () => {
  await checkAsync('A non-failed observation never archives a Thread', fc.asyncProperty(
    fc.constantFrom(...nonFailing), fc.constantFrom(...nonFailing), fc.boolean(),
    async (first, second, failFirst) => {
      const fixture = await setup({ referenceId: 'E2', roles: ['diverged'], extraReferences: [] })
      await fixture.store.save({ ...fixture.store.read(), threads: [...fixture.store.read().threads,
        agent('agent', absent)] })
      if (failFirst) {
        await observe(fixture.store, observation('failed', 'E1', 1))
        expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(true)
      }
      await observe(fixture.store, observation(first, 'E2', 2))
      const recovered = readAgentThread(fixture.store.read(), 'agent')
      // Recovery never unarchives, and it never archives a Thread on its own.
      expect(recovered.archived).toBe(failFirst)
      expect(recovered.observation).toEqual(observation(first, 'E2', 2))
      await observe(fixture.store, observation(second, 'E3', 3))
      expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(failFirst)
      // Non-terminal observations coalesce, so settle the debounced write first.
      await fixture.store.flush()
      expect(await disk(fixture.directory)).toEqual(fixture.store.read())
    }
  ).afterEach(releaseSample), 'generated non-failed statuses applied to a Thread that may already have failed', budget, samples)
}, timeout)

it('An observation commit changes only its own Thread', async () => {
  await checkAsync('An observation commit changes only its own Thread', fc.asyncProperty(
    fc.constantFrom(...statuses),
    async status => {
      const fixture = await setup({ referenceId: 'E1', roles: ['matched', 'diverged'], extraReferences: [] })
      await fixture.store.save({ ...fixture.store.read(), threads: [...fixture.store.read().threads,
        agent('agent', absent)] })
      const before = fixture.store.read()
      const target = readAgentThread(before, 'agent')
      const next = await observe(fixture.store, observation(status, 'E9', 5))
      const after = readAgentThread(next, 'agent')
      expect(after).toMatchObject({
        revision: target.revision + 1, sessionState: target.sessionState, title: target.title,
        tags: target.tags, cwd: target.cwd, createdAt: target.createdAt, updatedAt: target.updatedAt + 1
      })
      // The archive decision follows from this observation alone.
      expect(after.archived).toBe(status === 'failed')
      // Untouched collections and every other record keep their identity.
      expect(next.reports).toBe(before.reports)
      expect(next.tagPool).toBe(before.tagPool)
      expect(next.settings).toBe(before.settings)
      expect(next.selectedThreadId).toBe(before.selectedThreadId)
      for (const thread of before.threads) {
        if (thread.id === 'agent') continue
        expect(next.threads.find(candidate => candidate.id === thread.id)).toBe(thread)
      }
      expect(readBartThread(next)).toBe(readBartThread(before))
    }
  ).afterEach(releaseSample), 'one observation committed against a Thread whose siblings must stay identical', budget, samples)
}, timeout)

it('An archive covers exactly the referenced Threads whose latest Execution matches', async () => {
  await checkAsync('An archive covers exactly the referenced Threads whose latest Execution matches', fc.asyncProperty(
    archiveWorld,
    async world => {
      const fixture = await setup(world)
      const before = fixture.store.read()
      await fixture.reports.setArchived('report', true, signal)
      const after = fixture.store.read()
      expect(after).toEqual(expectedArchive(before, 'report'))
      for (const thread of after.threads) {
        if (!('archived' in thread)) continue
        const previous = readAgentThread(before, thread.id)
        const referenced = before.reports[0].relatedExecutions
          .find(reference => reference.threadId === thread.id)?.executionId
        const covered = referenced !== undefined &&
          previous.observation.latestExecution?.executionId === referenced
        // Coverage is per Thread: its own current Execution must be the referenced one.
        expect(thread.archived).toBe(previous.archived || covered)
        expect(thread.revision).toBe(previous.revision + (thread.archived && !previous.archived ? 1 : 0))
      }
      // An Agent the Report does not reference is outside the archive entirely.
      expect(readAgentThread(after, 'unrelated')).toBe(readAgentThread(before, 'unrelated'))
      // Repeating the archive is a no-op on the same aggregate.
      await fixture.reports.setArchived('report', true, signal)
      expect(fixture.store.read()).toBe(after)
      await fixture.store.flush()
      expect(await disk(fixture.directory)).toEqual(after)
    }
  ).afterEach(releaseSample), 'a Report referencing a generated set of Thread roles, each with its own current Execution', budget, samples)
}, timeout)

it('Unarchiving a Report never unarchives its Threads', async () => {
  await checkAsync('Unarchiving a Report never unarchives its Threads', fc.asyncProperty(
    archiveWorld,
    async world => {
      const fixture = await setup(world)
      await fixture.reports.setArchived('report', true, signal)
      const archived = fixture.store.read()
      await fixture.reports.setArchived('report', false, signal)
      const unarchived = fixture.store.read()
      // Unarchive changes the Report's own archive state and nothing else: the
      // whole record, minus that flag, is what it was while archived. A rewrite
      // that cleared the references, the tag snapshot, the HTML or a timestamp
      // would pass a flag-only check.
      expect(unarchived.reports[0]).toEqual({ ...archived.reports[0], archived: false })
      expect(archiveFlags(unarchived)).toEqual(archiveFlags(archived))
      expect(unarchived.threads).toEqual(archived.threads)
      await fixture.store.flush()
      expect(await disk(fixture.directory)).toEqual(unarchived)
    }
  ).afterEach(releaseSample), 'archive and unarchive of one Report over a generated Thread population', budget, samples)
}, timeout)

it('A content update preserves the references and their tag snapshot, and a replacement re-evaluates them', async () => {
  await checkAsync('A content update preserves the references and their tag snapshot, and a replacement re-evaluates them',
    fc.asyncProperty(
      archiveWorld,
      fc.uniqueArray(fc.constantFrom('title' as const, 'html' as const), { maxLength: 2 }),
      async (world, drawn) => {
        const fields = drawn.length === 0 ? ['title' as const, 'html' as const] : drawn
        const fixture = await setup(world)
        // A Thread that a replacement may reference whatever roles the world drew.
        await fixture.store.save({ ...fixture.store.read(), threads: [...fixture.store.read().threads,
          agent('extra', observation('completed', 'E7', 1))] })
        const before = fixture.store.read()
        await fixture.reports.update('report', {
          ...(fields.includes('title') ? { title: 'Renamed report' } : {}),
          ...(fields.includes('html') ? { html: '<p>Replaced HTML</p>' } : {})
        }, signal)
        const updated = fixture.store.read()
        // The documented rule: content updates preserve the relations and their
        // derived tag snapshot, and touch nothing else on the record.
        expect(updated.reports[0]).toMatchObject({
          relatedExecutions: before.reports[0].relatedExecutions,
          tags: before.reports[0].tags,
          archived: false,
          createdAt: before.reports[0].createdAt,
          title: fields.includes('title') ? 'Renamed report' : before.reports[0].title,
          html: fields.includes('html') ? '<p>Replaced HTML</p>' : before.reports[0].html
        })
        expect(updated.reports[0].updatedAt).toBeGreaterThan(before.reports[0].updatedAt)
        // No Thread is archived or otherwise rewritten by a content update.
        for (const thread of before.threads) {
          expect(updated.threads.find(candidate => candidate.id === thread.id)).toBe(thread)
        }

        // Replacing the references re-evaluates the snapshot from the new set only:
        // the newly referenced Thread contributes its tags, the dropped ones stop
        // contributing, and the replacement archives nothing.
        await fixture.store.commit({ type: 'update-agent-thread-metadata', threadId: 'extra',
          title: 'Extra', emoji: '🧩', tags: ['fresh'], updatedAt: 9 })
        // The aggregate the reference rules act on, snapshotted immediately
        // before the replacement so the assertion below can compare all of it.
        const beforeReplacement = fixture.store.read()
        const reference = { threadId: 'extra', executionId: 'E7' }
        await fixture.reports.update('report', { relatedExecutions: [reference] }, signal)
        const replaced = fixture.store.read()
        // The whole record, not only the replaced fields: a replacement that also
        // cleared the HTML, moved `createdAt`, flipped `archived` or rewrote the
        // id would otherwise pass, and the refused update below could not expose
        // an id change either, since the original id is gone by then.
        expect(replaced.reports[0]).toEqual({
          ...updated.reports[0], relatedExecutions: [reference],
          tags: [threadDirectoryTag(readAgentThread(replaced, 'extra')), 'fresh'],
          updatedAt: replaced.reports[0].updatedAt
        })
        expect(replaced.reports[0].updatedAt).toBeGreaterThan(updated.reports[0].updatedAt)
        // Every Thread, not only the archive flags: a replacement that also
        // rewrote a referenced Thread's tags, session state, observation or
        // revision would otherwise pass, and the refused update below compares
        // against the already-rewritten state, so it could not expose the damage.
        expect(replaced.threads).toEqual(beforeReplacement.threads)
        expect(readAgentThread(replaced, 'extra').archived).toBe(false)

        // A refused replacement leaves the committed aggregate exactly as it was.
        await expect(fixture.reports.update('report',
          { relatedExecutions: [{ threadId: 'extra', executionId: 'E1' }] }, signal)).rejects.toThrow()
        expect(fixture.store.read()).toBe(replaced)
        await fixture.store.flush()
        expect(await disk(fixture.directory)).toEqual(replaced)
      }
    ).afterEach(releaseSample), 'title/HTML-only updates and one reference replacement over a generated Thread population', budget, samples)
}, timeout)

it.each(['prepare-agent', 'prepare-report', 'admission', 'statement', 'before-commit', 'after-commit'] as const)(
  'An archive recovers the complete aggregate across the %s fault', async boundary => {
    const fatal = boundary === 'before-commit' || boundary === 'after-commit'
    await checkAsync(`An archive recovers the complete aggregate across the ${boundary} fault`, fc.asyncProperty(
      fc.record({
        roles: fc.uniqueArray(fc.constantFrom('diverged' as const, 'empty' as const, 'archived' as const), { maxLength: 3 }),
        missingReference: fc.boolean()
      }),
      async shape => {
        // The archive must change a Thread and the Report at this boundary, so
        // one matched Agent is always present and always covered.
        const world: ArchiveWorld = {
          referenceId: 'E1', roles: ['matched', ...shape.roles],
          extraReferences: [...(shape.missingReference ? ['missing' as const] : []), 'bart']
        }
        let failing = false
        const fixture = await setup(world, {
          beforePrepare: async key => {
            const gated = boundary === 'prepare-agent'
              ? key === 'thread:matched'
              : boundary === 'prepare-report' ? key === 'report:report' : false
            if (failing && gated) throw new Error('injected archive preparation rejection')
          },
          beforeCommit: async () => {
            if (failing && boundary === 'admission') throw new Error('injected archive admission rejection')
          },
          transactionFault: () => failing && boundary !== 'prepare-agent' && boundary !== 'prepare-report' &&
            boundary !== 'admission' ? boundary : undefined
        })
        await fixture.store.flush()
        const original = fixture.store.read()
        const intended = expectedArchive(original, 'report')
        failing = true
        await expect(fixture.reports.setArchived('report', true, signal)).rejects.toThrow()
        expect(fixture.store.read()).toBe(original)
        if (fatal) await fixture.store.close().catch(() => undefined)
        // Every boundary recovers a complete aggregate: the old one, or the whole new one.
        expect(await disk(fixture.directory)).toEqual(boundary === 'after-commit' ? intended : original)
        if (fatal) return
        failing = false
        await fixture.reports.setArchived('report', true, signal)
        expect(fixture.store.read()).toEqual(intended)
        expect(await disk(fixture.directory)).toEqual(intended)
      }
    ).afterEach(releaseSample), `inject one ${boundary} fault into the archive commit, then read the aggregate back from disk`, budget, samples)
  }, timeout)

it('An archive racing a new Execution, a deletion and an unrelated update keeps the affected set exact', async () => {
  await checkAsync('An archive racing a new Execution, a deletion and an unrelated update keeps the affected set exact', fc.asyncProperty(
    // Pinned to the full set: every run races all three commands, in a random
    // order, so the criterion's three legs are exercised together rather than
    // left to a sample drawing.
    fc.uniqueArray(fc.constantFrom('execution' as const, 'deletion' as const, 'metadata' as const),
      { minLength: 3, maxLength: 3 }),
    fc.constantFrom<Status>('completed', 'interrupted', 'failed'),
    async (racers, racedStatus) => {
      // The deletion takes a Thread the archive covers (`matched`), not the
      // referenced-but-uncovered `diverged` one: deleting a Thread the archive
      // would skip anyway has no observable outcome, so a missing lock or a
      // stale pre-deletion snapshot could pass unnoticed. Because the deletion
      // always runs, `matched` never survives this world, so a third covered
      // Agent the racers do not touch (`spare`) is seeded below to keep the
      // archive's own coverage observable.
      const racerKey = (racer: string): string =>
        racer === 'execution' ? 'thread:covered' : racer === 'deletion' ? 'thread:matched' : 'thread:unrelated'
      const keys = new Set(racers.map(racerKey))
      const gate = barrier(keys.size)
      let blocking = false
      const fixture = await setup({ referenceId: 'E1', roles: ['matched', 'covered', 'diverged'], extraReferences: [] }, {
        beforePrepare: async key => { if (blocking && keys.has(key)) await gate.enter() }
      })
      // A referenced Agent the archive covers and no racer touches: with the
      // deletion always taking `matched` and the execution racer moving
      // `covered` off the reference, this is the only covered Agent whose
      // archive outcome this world can observe.
      const seeded = fixture.store.read()
      await fixture.store.save({ ...seeded,
        threads: [...seeded.threads, agent('spare', observation('completed', 'E1', 1))],
        reports: seeded.reports.map(report => ({ ...report,
          relatedExecutions: [...report.relatedExecutions, { threadId: 'spare', executionId: 'E1' }] })) })
      const before = fixture.store.read()
      blocking = true
      // Each racer is admitted first and holds its own Thread scope, so the
      // archive must re-check the locked references against what they publish.
      const pending = racers.map(async racer => {
        if (racer === 'execution') {
          const current = readAgentThread(fixture.store.read(), 'covered')
          await fixture.store.commit({ type: 'replace-thread-session-state', threadId: 'covered',
            expectedRevision: current.revision, sessionState: { privateTurn: 'raced' },
            observation: observation(racedStatus, 'E9', 9), updatedAt: current.updatedAt + 1 })
        } else if (racer === 'deletion') {
          await fixture.store.commit({ type: 'delete-agent-thread', threadId: 'matched' })
        } else {
          // The unreferenced Agent: the archive locks references, not the whole
          // Thread population, so this racer must not become part of its outcome.
          await fixture.store.commit({ type: 'update-agent-thread-metadata', threadId: 'unrelated',
            title: 'updated title', emoji: '📦', tags: ['updated'], updatedAt: 9 })
        }
      })
      await gate.started
      const archive = fixture.reports.setArchived('report', true, signal)
      try {
        // Nothing published yet: the racers are mid-persistence and the archive
        // is queued behind their Thread scopes.
        expect(fixture.store.read().reports[0].archived).toBe(false)
        expect(readAgentThread(fixture.store.read(), 'covered').revision).toBe(
          readAgentThread(before, 'covered').revision)
      } finally { gate.release() }
      await Promise.all([archive, ...pending])
      const after = fixture.store.read()
      expect(after.reports[0].archived).toBe(true)
      expect(after.reports[0].relatedExecutions).toEqual(before.reports[0].relatedExecutions)

      // The raced Thread moved on, so the locked reference no longer covers it:
      // only the new Execution's own outcome decides its archive flag.
      const covered = readAgentThread(after, 'covered')
      expect(covered.observation).toEqual(observation(racedStatus, 'E9', 9))
      expect(covered.archived).toBe(racedStatus === 'failed')
      expect(covered.revision).toBe(readAgentThread(before, 'covered').revision + 1)
      expect(covered.sessionState).toEqual({ privateTurn: 'raced' })

      // The covered Thread the deletion races is never resurrected: an archive
      // acting on its prepared snapshot rather than the committed state would
      // write the deleted Agent back here.
      expect(after.threads.some(thread => thread.id === 'matched')).toBe(false)
      // A referenced but uncovered Agent is outside the archive's scope and no
      // racer touches it, so its record keeps its identity.
      expect(readAgentThread(after, 'diverged')).toBe(readAgentThread(before, 'diverged'))
      // The referenced Agent the archive covers — the one no racer touches —
      // moves exactly one revision, keeps its own tags and session state, and
      // is the only Thread the archive itself archives here.
      const spare = readAgentThread(after, 'spare')
      expect(spare.archived).toBe(true)
      expect(spare.tags).toEqual(['retained'])
      expect(spare.revision).toBe(readAgentThread(before, 'spare').revision + 1)
      expect(spare.sessionState).toEqual({ privateTurn: 'kept-spare' })
      // The unreferenced Agent the update races carries its own change and nothing
      // else: still unarchived, its Execution untouched, one revision from the update.
      const unrelated = readAgentThread(after, 'unrelated')
      const unrelatedBefore = readAgentThread(before, 'unrelated')
      // The raced record is compared in full, not field by field: the update
      // keeps the Thread unarchived and rewrites exactly the metadata the racer
      // sent — tags, the emoji the Thread did not carry, and one revision. A
      // replay that dropped part of the update would fail here. The Thread was
      // not pending a generated title, so the update keeps its title; its
      // Execution and session state are untouched.
      expect(unrelated).toEqual({
        ...unrelatedBefore, emoji: '📦', tags: ['updated'],
        revision: unrelatedBefore.revision + 1, updatedAt: 9
      })
      // The archived population is asserted as a whole: the archive reaches
      // exactly the Threads it covers — `spare` — plus the Thread whose own
      // failed observation archived it, and no other Thread becomes archived:
      // neither the unrelated Agent the update races nor a deleted one.
      const archivedIds = [
        'spare',
        ...(racedStatus === 'failed' ? ['covered'] : [])
      ].sort()
      expect(after.threads.filter(thread => 'archived' in thread && thread.archived)
        .map(thread => thread.id).sort())
        .toEqual(archivedIds)
      await fixture.store.flush()
      expect(await disk(fixture.directory)).toEqual(after)
    }
  ).afterEach(releaseSample), 'racers admitted first, each blocked in its own Thread scope, then one archive queued behind them', budget, samples)
}, timeout)
