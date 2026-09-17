import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentThreadRecord, ThreadPublicObservation } from '@openagent/contracts'
import { ThreadStateStore, type ThreadStateStoreOptions } from '../src/main/services/thread-state-store'
import {
  createOpenAgentState,
  readAgentThread,
  readBartThread,
  type OpenAgentState
} from '../src/shared/openagent-state'
import { createDefaultOpenAgentSettings } from '../src/shared/openagent-settings'

/**
 * Issue #139: a failed latest Execution archives its Agent Thread in the same
 * authoritative commit, and an explicit unarchive stays unarchived.
 */
const stores: ThreadStateStore[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map(store => store.close()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Failed Execution auto-archive', () => {
  it('archives in the failing commit and keeps the failure, content and links after restart', async () => {
    const fixture = await setup()
    await commit(fixture.store, running('E1', 3))
    expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(false)
    await commit(fixture.store, failed('E1', 3))
    const archived = readAgentThread(fixture.store.read(), 'agent')
    expect(archived).toMatchObject({
      archived: true,
      sessionState: { privateTurn: 'kept' },
      observation: { latestExecution: { executionId: 'E1', status: 'failed', error: 'native failed' } }
    })
    expect(await reopen(fixture.directory)).toEqual(fixture.store.read())
  })

  it('keeps admitted background work and private content when the failure auto-archives', async () => {
    const fixture = await setup()
    await commit(fixture.store, {
      latestExecution: { executionId: 'E1', status: 'failed', startedAt: 3, finishedAt: 4, error: 'native failed' },
      backgroundWork: { status: 'running' }
    })
    const archived = readAgentThread(fixture.store.read(), 'agent')
    expect(archived).toMatchObject({
      archived: true,
      tags: ['retained'],
      sessionState: { privateTurn: 'kept' },
      observation: { backgroundWork: { status: 'running' } }
    })
  })

  it('never re-archives the same failed Execution after an explicit unarchive', async () => {
    const fixture = await setup()
    await commit(fixture.store, running('E1', 3))
    await commit(fixture.store, failed('E1', 3))
    await fixture.store.commit({ type: 'set-agent-thread-archived', threadId: 'agent', archived: false })
    expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(false)

    await commit(fixture.store, failed('E1', 3), 4)
    expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(false)

    // Restart replays the same committed failure without archiving again.
    const restarted = trackedStore(fixture.directory)
    await restarted.load()
    await commit(restarted, failed('E1', 3), 5)
    expect(readAgentThread(restarted.read(), 'agent').archived).toBe(false)
    expect(await reopen(fixture.directory)).toEqual(restarted.read())
  })

  it('archives again when a later Execution fails', async () => {
    const fixture = await setup()
    await commit(fixture.store, running('E1', 3))
    await commit(fixture.store, failed('E1', 3))
    await fixture.store.commit({ type: 'set-agent-thread-archived', threadId: 'agent', archived: false })
    await commit(fixture.store, running('E2', 5), 4)
    expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(false)
    await commit(fixture.store, failed('E2', 5), 5)
    expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(true)
  })

  it('keeps an interrupted or waiting Execution in the unarchived Default', async () => {
    const fixture = await setup()
    await commit(fixture.store, running('E1', 3))
    await commit(fixture.store, {
      latestExecution: { executionId: 'E1', status: 'interrupted', startedAt: 3, finishedAt: 4 },
      backgroundWork: null
    }, 4)
    expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(false)
    await commit(fixture.store, waiting('E2', 5), 5)
    expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(false)
    await fixture.store.flush()
    expect(await reopen(fixture.directory)).toEqual(fixture.store.read())
  })

  it('ignores a late failure for a superseded Execution', async () => {
    const fixture = await setup()
    await commit(fixture.store, running('E1', 3))
    await commit(fixture.store, running('E2', 5), 4)
    await commit(fixture.store, failed('E1', 3), 5)
    expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(false)
    expect(await reopen(fixture.directory)).toEqual(fixture.store.read())
  })

  it('publishes no partial archive when the failing commit cannot persist', async () => {
    let failing = false
    const fixture = await setup({ transactionFault: () => failing ? 'statement' : undefined })
    await commit(fixture.store, running('E1', 3))
    // Running observations coalesce, so settle the debounced write before using
    // memory as the disk expectation.
    await fixture.store.flush()
    const before = fixture.store.read()
    failing = true
    await expect(commit(fixture.store, failed('E1', 3))).rejects.toThrow()
    expect(fixture.store.read()).toBe(before)
    expect(await reopen(fixture.directory)).toEqual(before)
    failing = false
    await commit(fixture.store, failed('E1', 3))
    expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(true)
    expect(await reopen(fixture.directory)).toEqual(fixture.store.read())
  })

  it('never archives a Report that links the failing Execution', async () => {
    const fixture = await setup()
    await commit(fixture.store, running('E1', 3))
    await fixture.store.commit({ type: 'replace-reports', reports: [{
      id: 'report', title: 'Report', html: '<p>Report</p>', tags: [], createdAt: 2, updatedAt: 2,
      archived: false, relatedExecutions: [{ threadId: 'agent', executionId: 'E1' }]
    }] })
    await commit(fixture.store, failed('E1', 3), 4)
    expect(readAgentThread(fixture.store.read(), 'agent').archived).toBe(true)
    expect(fixture.store.read().reports[0].archived).toBe(false)
    expect(await reopen(fixture.directory)).toEqual(fixture.store.read())
  })

  it('never archives Bart, whose failures are not Agent Thread failures', async () => {
    const fixture = await setup()
    const bart = readBartThread(fixture.store.read())
    await fixture.store.commit({ type: 'replace-thread-session-state', threadId: bart.id,
      expectedRevision: bart.revision, sessionState: { turn: 'failed' },
      observation: failed('E-bart', 3), updatedAt: 4 })
    expect(readBartThread(fixture.store.read()).observation.latestExecution)
      .toMatchObject({ executionId: 'E-bart', status: 'failed' })
    expect(readBartThread(fixture.store.read())).not.toHaveProperty('archived')
    expect(await reopen(fixture.directory)).toEqual(fixture.store.read())
  })

  it('serializes an unarchive racing the failing commit', async () => {
    let blocking = false
    const gate = barrier()
    const fixture = await setup({ beforePrepare: async key => {
      if (blocking && key === 'thread:agent') await gate.enter()
    } })
    await commit(fixture.store, running('E1', 3))
    blocking = true
    const failure = commit(fixture.store, failed('E1', 3))
    await gate.started
    const unarchive = fixture.store.commit({ type: 'set-agent-thread-archived', threadId: 'agent', archived: false })
    gate.release()
    await Promise.all([failure, unarchive])
    const settled = readAgentThread(fixture.store.read(), 'agent')
    expect(settled.archived).toBe(false)
    expect(settled.observation.latestExecution).toMatchObject({ executionId: 'E1', status: 'failed' })
    expect(await reopen(fixture.directory)).toEqual(fixture.store.read())
  })

  it('does not resurrect a deleted Agent when the failing commit lands', async () => {
    let blocking = false
    const gate = barrier()
    const fixture = await setup({ beforePrepare: async key => {
      if (blocking && key === 'thread:agent') await gate.enter()
    } })
    await commit(fixture.store, running('E1', 3))
    blocking = true
    const failure = commit(fixture.store, failed('E1', 3))
    await gate.started
    const deletion = fixture.store.commit({ type: 'delete-agent-thread', threadId: 'agent' })
    gate.release()
    await Promise.all([failure, deletion])
    expect(fixture.store.read().threads.some(thread => thread.id === 'agent')).toBe(false)
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

function running(executionId: string, startedAt: number): ThreadPublicObservation {
  return { latestExecution: { executionId, status: 'running', startedAt }, backgroundWork: null }
}

function failed(executionId: string, startedAt: number): ThreadPublicObservation {
  return {
    latestExecution: {
      executionId, status: 'failed', startedAt, finishedAt: startedAt + 1, error: 'native failed'
    },
    backgroundWork: null
  }
}

function waiting(executionId: string, startedAt: number): ThreadPublicObservation {
  return {
    latestExecution: {
      executionId, status: 'waiting-for-user', startedAt,
      interactions: [{
        id: 'interaction', kind: 'question', title: 'Continue?',
        actions: [{ id: 'submit', intent: 'submit', label: 'OK' }], questions: []
      }]
    },
    backgroundWork: null
  }
}

async function commit(
  store: ThreadStateStore,
  observation: ThreadPublicObservation,
  updatedAt = 3
): Promise<OpenAgentState> {
  const current = readAgentThread(store.read(), 'agent')
  return store.commit({
    type: 'replace-thread-session-state', threadId: current.id,
    expectedRevision: current.revision, sessionState: { privateTurn: 'kept' },
    observation, updatedAt
  })
}

function agent(): AgentThreadRecord {
  return {
    id: 'agent', harnessId: 'codex', archived: false, revision: 0, title: 'Agent', tags: ['retained'],
    cwd: '/workspace', settings: { model: 'fixture-model' },
    sessionState: { privateTurn: 'kept' },
    observation: { latestExecution: null, backgroundWork: null }, createdAt: 2, updatedAt: 2
  }
}

async function setup(options?: ThreadStateStoreOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-failed-archive-'))
  directories.push(directory)
  const store = trackedStore(directory, options)
  const initial = createOpenAgentState({
    bartThreadId: 'bart', hostHarnessId: 'codex', bartThreadSettings: {}, bartCwd: '/bart',
    createdAt: 1, selectedThreadId: null, settings: createDefaultOpenAgentSettings()
  })
  await store.save({ ...initial, threads: [...initial.threads, agent()] })
  return { directory, store }
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
