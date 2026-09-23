import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentThreadRecord, ThreadPublicObservation } from '@openagent/contracts'
import { ThreadStateStore, type ThreadStateStoreOptions } from '../src/main/services/thread-state-store'
import { ReportService } from '../src/main/use-cases/report-service'
import { createOpenAgentState, readAgentThread, type OpenAgentState } from '../src/shared/openagent-state'
import { createDefaultOpenAgentSettings } from '../src/shared/openagent-settings'
import type { ReportThreadRecord } from '../src/shared/report-thread'

const stores: ThreadStateStore[] = []
const directories: string[] = []
const signal = new AbortController().signal
afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map(store => store.close()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Report archive atomic persistence and command ordering', () => {
  it('archives only matching public latest IDs and keeps opaque content, links and timestamps after restart', async () => {
    const fixture = await setup()
    const original = fixture.store.read()
    await fixture.reports.setArchived('report', true, signal)
    expect(fixture.store.read()).toEqual(archivedState(original))
    const archived = fixture.store.read()
    await fixture.reports.setArchived('report', true, signal)
    expect(fixture.store.read()).toBe(archived)
    expect(await reopen(fixture.directory)).toEqual(archived)
    await fixture.reports.setArchived('report', false, signal)
    expect(fixture.store.read().threads).toEqual(archived.threads)
    expect(fixture.store.read().reports).toEqual(original.reports)
  })

  it.each(['prepare-agent', 'prepare-report', 'admission', 'statement'] as const)(
    'preserves the entire committed aggregate on %s failure and retries successfully', async boundary => {
      let failing = false
      const fixture = await setup({
        beforePrepare: async key => {
          if (failing && key === (boundary === 'prepare-agent' ? 'thread:b' : boundary === 'prepare-report' ? 'report:report' : '')) {
            throw new Error('archive preparation failed')
          }
        },
        beforeCommit: async () => {
          if (failing && boundary === 'admission') throw new Error('archive admission failed')
        },
        transactionFault: () => failing && boundary === 'statement' ? 'statement' : undefined
      })
      const original = fixture.store.read()
      failing = true
      await expect(fixture.reports.setArchived('report', true, signal)).rejects.toThrow()
      expect(fixture.store.read()).toBe(original)
      expect(await reopen(fixture.directory)).toEqual(original)
      failing = false
      await fixture.reports.setArchived('report', true, signal)
      expect(await reopen(fixture.directory)).toEqual(archivedState(original))
    }
  )

  it.each(['before-commit', 'after-commit'] as const)('recovers the complete archive after worker exit %s', async boundary => {
    let failing = false
    const fixture = await setup({ transactionFault: () => failing ? boundary : undefined })
    const original = fixture.store.read()
    failing = true
    await expect(fixture.reports.setArchived('report', true, signal)).rejects.toThrow(/worker exited/)
    expect(fixture.store.read()).toBe(original)
    // A failed acknowledgement cannot be retried against an uncertain live owner.
    await expect(fixture.reports.setArchived('report', true, signal)).rejects.toThrow(/worker exited/)
    await fixture.store.close().catch(() => undefined)
    expect(await reopen(fixture.directory)).toEqual(boundary === 'before-commit' ? original : archivedState(original))
  })

  it('checks latest under the Thread scope when a newer Execution commits ahead of archive', async () => {
    let blocking = false
    const gate = barrier()
    const fixture = await setup({ beforePrepare: async key => {
      if (blocking && key === 'thread:a') await gate.enter()
    } })
    const newer = { latestExecution: { executionId: 'E2', status: 'completed' as const, startedAt: 3, finishedAt: 4 }, backgroundWork: null }
    blocking = true
    const observation = fixture.store.commit({ type: 'replace-thread-session-state', threadId: 'a', expectedRevision: 0,
      observation: newer, sessionState: { privateNewContent: 'preserve me' }, updatedAt: 4 })
    await gate.started
    const archive = fixture.reports.setArchived('report', true, signal)
    try {
      expect(fixture.store.read().reports[0].archived).toBe(false)
    } finally { gate.release() }
    await observation
    await archive
    expect(readAgentThread(fixture.store.read(), 'a')).toMatchObject({ archived: false, revision: 1,
      observation: newer, sessionState: { privateNewContent: 'preserve me' } })
    expect(readAgentThread(fixture.store.read(), 'b').archived).toBe(true)
    expect(fixture.store.read().reports[0].archived).toBe(true)
    expect(await reopen(fixture.directory)).toEqual(fixture.store.read())
  })

  it('keeps archive atomic during preparation, permits unrelated writes and fences stale Session revisions', async () => {
    let blocking = false
    const gate = barrier()
    const fixture = await setup({ beforePrepare: async key => {
      if (blocking && key === 'report:report') await gate.enter()
    } })
    const original = fixture.store.read()
    blocking = true
    const archive = fixture.reports.setArchived('report', true, signal)
    await gate.started
    const staleObservation = fixture.store.commit({ type: 'replace-thread-session-state', threadId: 'a', expectedRevision: 0,
      observation: completed(), sessionState: { stale: true }, updatedAt: 3 })
    const rejected = expect(staleObservation).rejects.toThrow(/revision 已变化/)
    const metadata = fixture.store.commit({ type: 'update-agent-thread-metadata', threadId: 'b',
      title: 'new title', emoji: '📦', tags: ['updated'], updatedAt: 3 })
    try {
      await fixture.store.commit({ type: 'set-agent-thread-archived', threadId: 'unrelated', archived: true })
      expect(fixture.store.read().reports).toEqual(original.reports)
      expect(readAgentThread(fixture.store.read(), 'a')).toEqual(readAgentThread(original, 'a'))
      expect(readAgentThread(fixture.store.read(), 'b')).toEqual(readAgentThread(original, 'b'))
      const disk = await reopen(fixture.directory)
      expect(disk?.reports).toEqual(original.reports)
      expect(readAgentThread(disk!, 'a').archived).toBe(false)
      expect(readAgentThread(disk!, 'b').archived).toBe(false)
    } finally { gate.release() }
    await archive
    await rejected
    await metadata
    await fixture.store.commit({ type: 'replace-thread-session-state', threadId: 'a',
      expectedRevision: readAgentThread(fixture.store.read(), 'a').revision,
      observation: completed(), sessionState: { acceptedContinuation: true }, updatedAt: 3 })
    expect(readAgentThread(fixture.store.read(), 'a')).toMatchObject({ archived: true, sessionState: { acceptedContinuation: true } })
    expect(readAgentThread(fixture.store.read(), 'b')).toMatchObject({ archived: true, tags: ['updated'] })
    expect(await reopen(fixture.directory)).toEqual(fixture.store.read())
  })

  it.each(['archive', 'delete'] as const)('serializes Thread deletion when %s reaches persistence first', async first => {
    let blocking = false
    const gate = barrier()
    const fixture = await setup({ beforePrepare: async (key, value) => {
      if (blocking && (first === 'archive' ? key === 'report:report' : key === 'thread:a' && value === undefined)) await gate.enter()
    } })
    const refs = fixture.store.read().reports[0].relatedExecutions
    blocking = true
    const archive = () => fixture.reports.setArchived('report', true, signal)
    const deletion = () => fixture.store.commit({ type: 'delete-agent-thread', threadId: 'a' })
    const pendingFirst = first === 'archive' ? archive() : deletion()
    await gate.started
    const pendingSecond = first === 'archive' ? deletion() : archive()
    gate.release()
    await Promise.all([pendingFirst, pendingSecond])
    expect(fixture.store.read().threads.some(thread => thread.id === 'a')).toBe(false)
    expect(readAgentThread(fixture.store.read(), 'b').archived).toBe(true)
    expect(fixture.store.read().reports[0]).toMatchObject({ archived: true, relatedExecutions: refs })
    expect(await reopen(fixture.directory)).toEqual(fixture.store.read())
  })

  it('serializes Report relation edits and repeated archive without resurrecting stale snapshots', async () => {
    let blocking = false
    const gate = barrier()
    const fixture = await setup({ beforePrepare: async key => {
      if (blocking && key === 'report:report') await gate.enter()
    } })
    blocking = true
    const archive = fixture.reports.setArchived('report', true, signal)
    await gate.started
    const update = fixture.reports.update('report', { title: 'Edited', relatedExecutions: [
      { threadId: 'unrelated', executionId: 'E1' }
    ] }, signal)
    const repeat = fixture.reports.setArchived('report', true, signal)
    gate.release()
    await Promise.all([archive, update, repeat])
    expect(fixture.store.read().reports[0]).toMatchObject({ title: 'Edited', archived: true })
    for (const id of ['a', 'b', 'unrelated']) expect(readAgentThread(fixture.store.read(), id).archived).toBe(true)
    expect(await reopen(fixture.directory)).toEqual(fixture.store.read())
  })

  it('rejects stale reference scopes before changing any archive flag', async () => {
    const fixture = await setup()
    const relatedThreadIds = fixture.store.read().reports[0].relatedExecutions.map(reference => reference.threadId)
    await fixture.reports.update('report', { relatedExecutions: [{ threadId: 'unrelated', executionId: 'E1' }] }, signal)
    const before = fixture.store.read()
    await expect(fixture.store.commit({ type: 'archive-report', reportId: 'report', relatedThreadIds })).rejects.toThrow(/关联已变化/)
    expect(fixture.store.read()).toBe(before)
    expect(await reopen(fixture.directory)).toEqual(before)
    await fixture.reports.setArchived('report', true, signal)
    expect(readAgentThread(fixture.store.read(), 'unrelated').archived).toBe(true)
    expect(readAgentThread(fixture.store.read(), 'a').archived).toBe(false)
  })

  it('keeps earlier eligible Agents unmodified when a later Agent fails revision validation', async () => {
    const fixture = await setup()
    await fixture.store.save({ ...fixture.store.read(), threads: fixture.store.read().threads.map(thread =>
      thread.id === 'b' ? { ...thread, revision: Number.MAX_SAFE_INTEGER } : thread) })
    const before = fixture.store.read()
    await expect(fixture.reports.setArchived('report', true, signal)).rejects.toThrow(/revision 已达到/)
    expect(fixture.store.read()).toBe(before)
    expect(await reopen(fixture.directory)).toEqual(before)
  })

  it('holds the Report history-reset barrier until the complete archive has settled', async () => {
    let blocking = false
    const gate = barrier()
    const fixture = await setup({ beforePrepare: async key => {
      if (blocking && key === 'report:report') await gate.enter()
    } })
    blocking = true
    const archive = fixture.reports.setArchived('report', true, signal)
    await gate.started
    let resetStarted = false
    const reset = fixture.reports.withHistoryReset(async () => {
      resetStarted = true
      expect(readAgentThread(fixture.store.read(), 'a').archived).toBe(true)
      await fixture.store.save({ ...fixture.store.read(), reports: [], threads: fixture.store.read().threads.filter(thread => thread.id === 'bart') })
    })
    expect(resetStarted).toBe(false)
    gate.release()
    await Promise.all([archive, reset])
    expect(fixture.store.read().reports).toEqual([])
    expect(fixture.store.read().threads.map(thread => thread.id)).toEqual(['bart'])
    expect(await reopen(fixture.directory)).toEqual(fixture.store.read())
  })
})

function barrier() {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  return { started, release, enter: async () => { entered(); await gate } }
}

function completed(executionId = 'E1'): ThreadPublicObservation {
  return { latestExecution: { executionId, status: 'completed', startedAt: 1, finishedAt: 2 }, backgroundWork: null }
}

function agent(id: string, overrides: Partial<AgentThreadRecord> = {}): AgentThreadRecord {
  return { id, harnessId: 'codex', archived: false, revision: 0, title: id, tags: ['retained'], cwd: '/workspace',
    createdAt: 1, updatedAt: 2, settings: {}, sessionState: { privateLatest: 'not-a-public-execution-id', content: id },
    observation: completed(), ...overrides }
}

async function setup(options?: ThreadStateStoreOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-report-archive-'))
  directories.push(directory)
  const store = trackedStore(directory, options)
  const initial = createOpenAgentState({ bartThreadId: 'bart', hostHarnessId: 'codex', bartThreadSettings: {},
    bartCwd: '/bart', createdAt: 1, selectedThreadId: null, settings: createDefaultOpenAgentSettings() })
  const report: ReportThreadRecord = { id: 'report', title: 'Report', html: '<p>Retained HTML</p>', tags: ['retained'],
    createdAt: 1, updatedAt: 2, archived: false, relatedExecutions: [
      ...['a', 'b', 'already', 'older', 'empty', 'missing', 'bart'].map(threadId => ({ threadId, executionId: 'E1' }))
    ] }
  await store.save({ ...initial, reports: [report], threads: [...initial.threads,
    agent('a'), agent('b'), agent('already', { archived: true }), agent('older', { observation: completed('E2') }),
    agent('empty', { observation: { latestExecution: null, backgroundWork: null } }), agent('unrelated')] })
  const reports = new ReportService({
    readReports: () => store.read().reports,
    readThreadTags: id => readAgentThread(store.read(), id).tags,
    resolveExecution: (id, executionId) => {
      const latest = readAgentThread(store.read(), id).observation.latestExecution
      return latest?.executionId === executionId ? latest : null
    },
    replaceReports: async reports => { await store.commit({ type: 'replace-reports', reports }) },
    archiveReport: async (reportId, relatedThreadIds) => { await store.commit({ type: 'archive-report', reportId, relatedThreadIds }) }
  }, { timestamp: (...floors) => Math.max(3, ...floors) + 1, createId: () => 'new-report' })
  return { directory, store, reports }
}

function archivedState(original: OpenAgentState): OpenAgentState {
  return { ...original, reports: original.reports.map(report => ({ ...report, archived: true })),
    threads: original.threads.map(thread => thread.id === 'a' || thread.id === 'b'
      ? { ...thread, archived: true, revision: 1 } : thread) }
}

function trackedStore(directory: string, options?: ThreadStateStoreOptions) {
  const store = new ThreadStateStore(directory, options)
  stores.push(store)
  return store
}

async function reopen(directory: string) {
  const store = trackedStore(directory)
  const result = await store.load()
  // Do not let a read-only evidence snapshot become a stale writer during cleanup.
  stores.splice(stores.indexOf(store), 1)
  await store.close()
  return result
}
