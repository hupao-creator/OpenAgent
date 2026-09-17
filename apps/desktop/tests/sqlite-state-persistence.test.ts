import type { Worker } from 'node:worker_threads'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteStatePersistence } from '../src/main/services/sqlite-state-persistence'
import { createOpenAgentState, readBartThread } from '../src/shared/openagent-state'
import { createDefaultOpenAgentSettings } from '../src/shared/openagent-settings'

const directories: string[] = []
const owners: SqliteStatePersistence[] = []
afterEach(async () => {
  await Promise.allSettled(owners.splice(0).map(owner => owner.close()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('SqliteStatePersistence ordering and failure boundaries', () => {
  it.each(['created-file', 'interrupted-schema'] as const)(
    'initializes empty state after first-write termination at %s', async boundary => {
      const directory = await temporaryDirectory()
      const persistence = ownedPersistence(directory)
      await mkdir(join(directory, 'openagent-state-v6'))
      const child = spawnSync(process.execPath, ['-e', `
        const { DatabaseSync } = require('node:sqlite')
        const db = new DatabaseSync(process.argv[1])
        if (process.argv[2] === 'interrupted-schema') {
          db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE records (key TEXT); PRAGMA user_version=6')
        }
        process.exit(91)
      `, persistence.statePath, boundary], { encoding: 'utf8' })
      expect(child.status, child.stderr).toBe(91)
      const beforeLoad = await readFile(persistence.statePath)
      expect(await persistence.load()).toBeNull()
      expect(await readFile(persistence.statePath)).toEqual(beforeLoad)
      const initial = initialState()
      await persistence.persist(initial, 1)
      await persistence.close()
      expect(await ownedPersistence(directory).load()).toEqual(initial)
    }
  )

  it.each(['CREATE TABLE foreign_data (value TEXT)', 'CREATE VIEW foreign_data AS SELECT 1'])(
    'rejects version-zero databases with existing schema: %s', async schema => {
      const directory = await temporaryDirectory()
      const persistence = ownedPersistence(directory)
      await mkdir(join(directory, 'openagent-state-v6'))
      const db = new DatabaseSync(persistence.statePath)
      db.exec(schema)
      db.close()
      await expect(persistence.load()).rejects.toThrow('OpenAgent 状态不符合当前格式')
      await expect(persistence.persist(initialState(), 1)).rejects.toThrow('OpenAgent 状态不符合当前格式')
      const inspection = new DatabaseSync(persistence.statePath, { readOnly: true })
      try {
        expect(inspection.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 0 })
        expect(inspection.prepare('SELECT name FROM sqlite_master').all()).toEqual([{ name: 'foreign_data' }])
      } finally { inspection.close() }
    }
  )

  it('uses 8 KiB pages for new databases and preserves an existing 4 KiB v6 database', async () => {
    const directory = await temporaryDirectory()
    const persistence = ownedPersistence(directory)
    const initial = initialState()
    await persistence.persist(initial, 1)
    await persistence.close()
    const db = new DatabaseSync(persistence.statePath)
    try {
      expect(db.prepare('PRAGMA page_size').get()).toMatchObject({ page_size: 8192 })
      // Produce a real existing v6 file with SQLite's previous default layout.
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA page_size=4096; VACUUM; PRAGMA journal_mode=WAL')
    } finally { db.close() }
    const reopened = ownedPersistence(directory)
    expect(await reopened.load()).toEqual(initial)
    const changed = changedAggregate()
    await reopened.persist(changed, 2)
    await reopened.close()
    expect(await ownedPersistence(directory).load()).toEqual(changed)
    const inspection = new DatabaseSync(persistence.statePath, { readOnly: true })
    try {
      expect(inspection.prepare('PRAGMA page_size').get()).toMatchObject({ page_size: 4096 })
    } finally { inspection.close() }
  })

  it('poisons the owner after a preparation worker exits and recovers through close and reopen', async () => {
    const directory = await temporaryDirectory()
    const persistence = ownedPersistence(directory)
    const initial = initialState()
    await persistence.persist(initial, 1)
    // Inject an actual private worker exit without adding a production API.
    const slots = Reflect.get(persistence, 'preparation') as Array<{ client: { worker: Worker } }>
    const writer = Reflect.get(persistence, 'writer') as { worker: Worker }
    const workers = [...slots.map(slot => slot.client.worker), writer.worker]
    await workers[0]!.terminate()
    await expect(persistence.persist(initial, 2)).rejects.toThrow('worker exited')
    await expect(persistence.persist(changedAggregate(), 3)).rejects.toThrow('worker exited')
    await expect(persistence.drain()).rejects.toThrow('worker exited')
    await expect(persistence.close()).rejects.toThrow('worker exited')
    expect(workers.every(worker => worker.threadId === -1)).toBe(true)
    const reopened = ownedPersistence(directory)
    expect(await reopened.load()).toEqual(initial)
    const changed = changedAggregate()
    await reopened.persist(changed, 2)
    expect(await ownedPersistence(directory).load()).toEqual(changed)
  })

  it('round trips valid entity IDs ending in -order as payloads rather than catalog keys', async () => {
    const directory = await temporaryDirectory()
    const initial = withSessionPair('opaque')
    const state = { ...initial, selectedThreadId: 'bart-order',
      threads: initial.threads.map(thread => ({ ...thread, id: 'bart-order' })),
      reports: [{ id: 'report-order', title: 'Report', html: '<p>Keep content</p>', tags: [],
        relatedExecutions: [{ threadId: 'bart-order', executionId: 'execution-1' }], archived: false, createdAt: 1, updatedAt: 1 }] }
    const persistence = ownedPersistence(directory)
    await persistence.persist(state, 1)
    expect(await new SqliteStatePersistence(directory).load()).toEqual(state)
  })

  it('fences slow B when a newer capture returns to already-persisted A', async () => {
    const directory = await temporaryDirectory()
    let started!: () => void
    let release!: () => void
    const staged = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const persistence = ownedPersistence(directory, {
      async beforePrepare(key, value) {
        if (key.startsWith('thread:') && (value as { sessionState?: { value: string } }).sessionState?.value === 'B') {
          started()
          await gate
        }
      }
    })
    const stateA = withSessionPair('A')
    await persistence.persist(stateA, 1)
    const slow = persistence.persist(withSessionPair('B'), 2)
    await staged
    try {
      expect(await new SqliteStatePersistence(directory).load()).toEqual(stateA)
      await persistence.persist(stateA, 3)
    } finally {
      release()
      await slow
    }
    expect(await new SqliteStatePersistence(directory).load()).toEqual(stateA)
  })

  it('keeps session state and observation paired across failed transaction admission and retry', async () => {
    const directory = await temporaryDirectory()
    let failCommit = false
    const persistence = ownedPersistence(directory, {
      async beforeCommit() {
        if (failCommit) throw new Error('transaction admission failed')
      }
    })
    const initial = withSessionPair('A')
    await persistence.persist(initial, 1)
    const completed = withSessionPair('B', 'completed')
    failCommit = true
    await expect(persistence.persist(completed, 2)).rejects.toThrow('transaction admission failed')
    expect(await new SqliteStatePersistence(directory).load()).toEqual(initial)
    failCommit = false
    await persistence.persist(completed, 2)
    const restored = await new SqliteStatePersistence(directory).load()
    expect(readBartThread(restored!)).toMatchObject({
      sessionState: { value: 'B' },
      observation: { latestExecution: { status: 'completed', summary: 'B' } }
    })
    expect(restored).toEqual(completed)
  })

  it('rolls back every changed record and order when a SQL statement fails, then permits retry', async () => {
    const directory = await temporaryDirectory()
    let fault: 'statement' | undefined
    const persistence = ownedPersistence(directory, { transactionFault: () => fault })
    const initial = withSessionPair('A')
    await persistence.persist(initial, 1)
    const changed = changedAggregate()
    fault = 'statement'
    await expect(persistence.persist(changed, 2)).rejects.toThrow('NOT NULL constraint failed: records.body')
    expect(await new SqliteStatePersistence(directory).load()).toEqual(initial)
    fault = undefined
    await persistence.persist(changed, 2)
    expect(await new SqliteStatePersistence(directory).load()).toEqual(changed)
  })

  it.each(['before-commit', 'after-commit'] as const)(
    'recovers one complete aggregate after the worker exits %s', async boundary => {
      const directory = await temporaryDirectory()
      let fault: typeof boundary | undefined
      const persistence = ownedPersistence(directory, { transactionFault: () => fault })
      const initial = withSessionPair('A')
      await persistence.persist(initial, 1)
      const changed = changedAggregate()
      fault = boundary
      await expect(persistence.persist(changed, 2)).rejects.toThrow()
      await persistence.close().catch(() => undefined)
      const restarted = ownedPersistence(directory)
      expect(await restarted.load()).toEqual(boundary === 'before-commit' ? initial : changed)
      await restarted.persist(changed, 3)
      expect(await new SqliteStatePersistence(directory).load()).toEqual(changed)
    }
  )

  it('settles concurrent preparation before rejecting and can retry the complete report', async () => {
    const directory = await temporaryDirectory()
    let failPreparation = false
    let started!: () => void
    let release!: () => void
    const staged = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const persistence = ownedPersistence(directory, {
      async beforePrepare(key) {
        if (!failPreparation) return
        if (key === 'settings') throw new Error('settings preparation failed')
        if (key === 'report:report') {
          started()
          await gate
        }
      }
    })
    const initial = initialState()
    await persistence.persist(initial, 1)
    failPreparation = true
    let finished = false
    const changed = changedAggregate()
    const writing = persistence.persist(changed, 2).then(
      () => { finished = true; return null }, error => { finished = true; return error }
    )
    await staged
    expect(finished).toBe(false)
    release()
    expect(await writing).toMatchObject({ message: 'settings preparation failed' })
    expect(await new SqliteStatePersistence(directory).load()).toEqual(initial)
    failPreparation = false
    await persistence.persist(changed, 2)
    expect(await new SqliteStatePersistence(directory).load()).toEqual(changed)
  })

  it('never reads, migrates, or cleans the v5 namespace on load, write, and reopen', async () => {
    const directory = await temporaryDirectory()
    const legacy = join(directory, 'openagent-state-v5')
    await mkdir(join(legacy, 'threads'), { recursive: true })
    const files = [join(legacy, 'manifest.json'), join(legacy, 'threads', 'orphan.json')]
    for (const file of files) await writeFile(file, '{intentionally invalid v5')
    const before = await Promise.all(files.map(async file => ({ bytes: await readFile(file), info: await stat(file) })))
    expect(await new SqliteStatePersistence(directory).load()).toBeNull()
    expect(await readdir(directory)).toEqual(['openagent-state-v5'])
    const persistence = ownedPersistence(directory)
    const initial = initialState()
    await persistence.persist(initial, 1)
    await persistence.close()
    expect(await new SqliteStatePersistence(directory).load()).toEqual(initial)
    for (let index = 0; index < files.length; index += 1) {
      expect(await readFile(files[index]!)).toEqual(before[index]!.bytes)
      expect((await stat(files[index]!)).mtimeMs).toBe(before[index]!.info.mtimeMs)
    }
    expect(await readdir(legacy)).toEqual(['manifest.json', 'threads'])
    expect(await readdir(join(legacy, 'threads'))).toEqual(['orphan.json'])
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-sqlite-state-'))
  directories.push(directory)
  return directory
}

function ownedPersistence(directory: string, options?: ConstructorParameters<typeof SqliteStatePersistence>[1]): SqliteStatePersistence {
  const persistence = new SqliteStatePersistence(directory, options)
  owners.push(persistence)
  return persistence
}

function changedAggregate() {
  const changed = withSessionPair('B', 'completed')
  return {
    ...changed,
    settings: { ...changed.settings, locale: 'en-US' as const },
    reports: [{ id: 'report', title: 'Report', html: '<html>Complete content</html>', tags: [],
      relatedExecutions: [{ threadId: 'bart', executionId: 'execution-1' }], archived: false, createdAt: 1, updatedAt: 2 }]
  }
}

function initialState() {
  return createOpenAgentState({ bartThreadId: 'bart', hostHarnessId: 'codex', bartThreadSettings: {},
    bartCwd: '/workspace/.bart', createdAt: 1, selectedThreadId: 'bart', settings: createDefaultOpenAgentSettings() })
}

function withSessionPair(value: string, status: 'running' | 'completed' = 'running') {
  const state = initialState()
  return {
    ...state,
    threads: state.threads.map(thread => ({
      ...thread,
      sessionState: { value },
      observation: {
        latestExecution: {
          executionId: 'execution-1', startedAt: 1, summary: value,
          ...(status === 'completed'
            ? { status, finishedAt: 2 }
            : { status })
        },
        backgroundWork: null
      }
    }))
  }
}
