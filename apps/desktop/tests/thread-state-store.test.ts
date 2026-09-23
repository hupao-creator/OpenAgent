import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadStateStore, type ThreadStateStoreOptions } from '../src/main/services/thread-state-store'
import type { AgentThreadRecord } from '@openagent/contracts'
import {
  createOpenAgentState,
  readAgentThread,
  readBartThread,
  threadSettingsSourceFingerprint
} from '../src/shared/openagent-state'
import { createDefaultOpenAgentSettings } from '../src/shared/openagent-settings'

const directories: string[] = []
const stores: ThreadStateStore[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.allSettled(stores.splice(0).map(store => store.close()))
  const { rm } = await import('node:fs/promises')
  await Promise.all(directories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('ThreadStateStore', () => {
  it('persists v6 SQLite and leaves every legacy namespace untouched', async () => {
    const directory = await temporaryDirectory()
    const legacy = join(directory, 'openagent-state-v5')
    await mkdir(legacy)
    const legacyPath = join(legacy, 'manifest.json')
    await writeFile(legacyPath, '{legacy bytes must not be parsed or rewritten')
    const legacyBefore = await stat(legacyPath)
    await expect(trackedStore(directory).load()).resolves.toBeNull()
    expect(await readdir(directory)).toEqual(['openagent-state-v5'])
    const store = trackedStore(directory)
    const initial = stateWithAgent()
    await store.save(initial)
    expect(store.statePath).toBe(join(directory, 'openagent-state-v6', 'state.sqlite'))
    const database = new DatabaseSync(store.statePath, { readOnly: true })
    try {
      expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 6 })
    } finally { database.close() }
    await expect(trackedStore(directory).load()).resolves.toEqual(initial)
    expect(await readFile(legacyPath, 'utf8')).toBe('{legacy bytes must not be parsed or rewritten')
    const legacyAfter = await stat(legacyPath)
    expect(legacyAfter.mtimeMs).toBe(legacyBefore.mtimeMs)
    expect(await readdir(legacy)).toEqual(['manifest.json'])
  })

  it('preserves the Unicode Report limit while validating large HTML without a character array', async () => {
    const directory = await temporaryDirectory()
    const store = trackedStore(directory)
    const html = '🧪'.repeat(1_000_000)
    await store.save({ ...stateWithAgent(), reports: [report('unicode', html)] })
    const before = store.read()
    await expect(store.commit({ type: 'replace-reports', reports: [report('unicode', html + 'x')] }))
      .rejects.toThrow()
    expect(store.read()).toBe(before)
    const restored = await trackedStore(directory).load()
    expect(restored?.reports[0].html).toBe(html)
  })

  it('evaluates synchronous commit preconditions against the state inside the acquired scope', async () => {
    const directory = await temporaryDirectory()
    const store = trackedStore(directory)
    await store.save(stateWithAgent())
    const source = readAgentThread(store.read(), 'thread-1')
    const privateUpdate = store.commit(sessionStateMutation(0, 1, 3))
    let checkedRevision: number | undefined
    const settingsUpdate = store.commit({
      type: 'update-agent-thread-settings', threadId: source.id,
      expectedSource: threadSettingsSourceFingerprint(source),
      settings: { model: 'must-not-publish' }, updatedAt: 4
    }, state => {
      checkedRevision = readAgentThread(state, source.id).revision
      throw new Error('caller-owned source changed')
    })

    await privateUpdate
    await expect(settingsUpdate).rejects.toThrow('caller-owned source changed')
    expect(checkedRevision).toBe(1)
    expect(readAgentThread(store.read(), source.id).settings).toEqual(source.settings)
    await store.flush()
    const loaded = await trackedStore(directory).load()
    expect(readAgentThread(loaded!, source.id)).toMatchObject({
      revision: 1, settings: source.settings, sessionState: { value: 1 },
      observation: { latestExecution: { status: 'running', summary: 'Value 1' } }
    })
  })

  it('serializes guarded mutations and leaves a rejected stale commit unapplied', async () => {
    const directory = await temporaryDirectory()
    const store = trackedStore(directory)
    let initial = createOpenAgentState({
      bartThreadId: 'bart-thread-1',
      hostHarnessId: 'codex',
      bartThreadSettings: { model: 'gpt-5' },
      bartCwd: '/workspace/.bart',
      createdAt: 1,
      selectedThreadId: 'bart-thread-1',
      settings: createDefaultOpenAgentSettings()
    })
    initial = {
      ...initial,
      threads: [...initial.threads, agentThread()]
    }
    await store.save(initial)

    const first = store.commit({
      type: 'replace-thread-session-state',
      threadId: 'thread-1',
      expectedRevision: 0,
      sessionState: { value: 1 },
      observation: runningObservation(1),
      updatedAt: 3
    })
    const stale = store.commit({
      type: 'replace-thread-session-state',
      threadId: 'thread-1',
      expectedRevision: 0,
      sessionState: { value: 2 },
      observation: runningObservation(2),
      updatedAt: 4
    })

    await expect(first).resolves.toBeDefined()
    await expect(stale).rejects.toThrow('revision 已变化')
    expect(readAgentThread(store.read(), 'thread-1')).toMatchObject({
      revision: 1,
      emoji: '👩🏽‍💻',
      sessionState: { value: 1 },
      observation: { latestExecution: { status: 'running', summary: 'Value 1' } }
    })
    await store.flush()
    const loaded = await trackedStore(directory).load()
    expect(readAgentThread(loaded!, 'thread-1')).toMatchObject({
      revision: 1,
      emoji: '👩🏽‍💻',
      sessionState: { value: 1 },
      observation: { latestExecution: { status: 'running', summary: 'Value 1' } }
    })
  })

  // A missing slice for a registered Harness is not a defect: with dynamic
  // registration a state file may predate a Plugin, and the service layer
  // fills defaults via normalizeHarnessSettings.
  it.each(['unregistered Harness', 'invalid settings', 'unknown state field', 'missing Bart'])('rejects non-current state without rewriting: %s', async defect => {
    const directory = await temporaryDirectory()
    const store = trackedStore(directory)
    await store.save(stateWithAgent())
    await store.close()
    const database = new DatabaseSync(store.statePath)
    try {
      if (defect === 'missing Bart') {
        database.exec("DELETE FROM records WHERE key = 'thread:bart-thread-1'; DELETE FROM entity_order WHERE kind = 'thread' AND id = 'bart-thread-1'")
      } else {
        const key = defect === 'unknown state field' ? 'ui' : 'settings'
        const row = database.prepare('SELECT body FROM records WHERE key = ?').get(key)!
        const candidate = JSON.parse(Buffer.from(row.body as Uint8Array).toString('utf8'))
        if (defect === 'unregistered Harness') candidate.harnesses.kimi = {}
        if (defect === 'invalid settings') candidate.harnesses.codex = null
        if (defect === 'unknown state field') candidate.unexpected = true
        database.prepare('UPDATE records SET body = ? WHERE key = ?').run(Buffer.from(JSON.stringify(candidate)), key)
      }
    } finally { database.close() }
    const bytes = await readFile(store.statePath)
    await expect(trackedStore(directory).load()).rejects.toThrow('OpenAgent 状态不符合当前格式')
    expect(await readFile(store.statePath)).toEqual(bytes)
  })

  it('durably adds and selects a forked Thread as one mutation', async () => {
    const directory = await temporaryDirectory()
    const writes: string[][] = []
    const store = trackedStore(directory, {
      beforeCommit: async keys => {
        writes.push([...keys])
      }
    })
    const initial = createOpenAgentState({
      bartThreadId: 'bart-thread-1',
      hostHarnessId: 'codex',
      bartThreadSettings: { model: 'gpt-5' },
      bartCwd: '/workspace/.bart',
      createdAt: 1,
      selectedThreadId: 'bart-thread-1',
      settings: createDefaultOpenAgentSettings()
    })
    await store.save({ ...initial, threads: [...initial.threads, agentThread()] })
    writes.length = 0

    const target = { ...agentThread(), id: 'forked-thread' }
    const committed = await store.commit({
      type: 'add-and-select-agent-thread',
      sourceThreadId: 'thread-1',
      expectedSourceRevision: 0,
      thread: target
    })

    expect(committed.selectedThreadId).toBe('forked-thread')
    expect(writes).toHaveLength(1)
    const persisted = await trackedStore(directory).load()
    expect(persisted?.selectedThreadId).toBe('forked-thread')
    expect(readAgentThread(persisted!, 'forked-thread')).toEqual(target)
  })

  it('rejects corrupt current-format state instead of restoring or falling back', async () => {
    const directory = await temporaryDirectory()
    const store = trackedStore(directory)
    const initial = createOpenAgentState({
      bartThreadId: 'bart-thread-1',
      hostHarnessId: 'codex',
      bartThreadSettings: { model: 'gpt-5' },
      bartCwd: '/workspace/.bart',
      createdAt: 1,
      selectedThreadId: 'bart-thread-1',
      settings: createDefaultOpenAgentSettings()
    })
    await store.save(initial)
    await store.close()
    await writeFile(store.statePath, JSON.stringify({
      ...initial,
      threads: []
    }), 'utf8')

    await expect(trackedStore(directory).load()).rejects.toThrow('当前格式')
  })

  it('coalesces high-frequency commits into one trailing durable snapshot', async () => {
    vi.useFakeTimers()
    const directory = await temporaryDirectory()
    const writes: string[][] = []
    const store = trackedStore(directory, {
      beforeCommit: async keys => {
        writes.push([...keys])
      }
    })
    await store.save(stateWithAgent())
    writes.length = 0

    const commits = Array.from({ length: 100 }, (_, index) => store.commit({
      type: 'replace-thread-session-state',
      threadId: 'thread-1',
      expectedRevision: index,
      sessionState: { value: index + 1 },
      observation: runningObservation(index + 1),
      updatedAt: index + 3
    }))
    await Promise.all(commits)

    expect(writes).toHaveLength(0)
    expect(readAgentThread(store.read(), 'thread-1')).toMatchObject({
      revision: 100,
      sessionState: { value: 100 },
      observation: { latestExecution: { status: 'running', summary: 'Value 100' } }
    })
    await vi.advanceTimersByTimeAsync(749)
    expect(writes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await store.flush()

    expect(writes).toHaveLength(1)
    const loaded = await trackedStore(directory).load()
    expect(readAgentThread(loaded!, 'thread-1')).toMatchObject({
      revision: 100,
      sessionState: { value: 100 },
      observation: { latestExecution: { status: 'running', summary: 'Value 100' } }
    })
  })

  it('persists at the maximum wait while commits keep resetting the trailing timer', async () => {
    vi.useFakeTimers()
    const directory = await temporaryDirectory()
    const writes: string[][] = []
    const store = trackedStore(directory, {
      persistenceDebounceMs: 750,
      persistenceMaxWaitMs: 2_000,
      beforeCommit: async keys => {
        writes.push([...keys])
      }
    })
    await store.save(stateWithAgent())
    writes.length = 0

    await store.commit(sessionStateMutation(0, 1, 3))
    await vi.advanceTimersByTimeAsync(700)
    await store.commit(sessionStateMutation(1, 2, 4))
    await vi.advanceTimersByTimeAsync(700)
    await store.commit(sessionStateMutation(2, 3, 5))
    await vi.advanceTimersByTimeAsync(599)
    expect(writes).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    await store.flush()
    expect(writes).toHaveLength(1)
    const persisted = await trackedStore(directory).load()
    expect(readAgentThread(persisted!, 'thread-1')).toMatchObject({
      revision: 3, sessionState: { value: 3 },
      observation: { latestExecution: { status: 'running', summary: 'Value 3' } }
    })
  })

  it('flushes a pending snapshot immediately and retries a timer-driven write failure', async () => {
    vi.useFakeTimers()
    const directory = await temporaryDirectory()
    const backgroundErrors: unknown[] = []
    let rejectNextWrite = false
    let writes = 0
    const store = trackedStore(directory, {
      onBackgroundPersistenceError: error => backgroundErrors.push(error),
      beforeCommit: async () => {
        writes += 1
        if (rejectNextWrite) {
          rejectNextWrite = false
          throw new Error('temporary write failure')
        }
      }
    })
    await store.save(stateWithAgent())
    writes = 0
    rejectNextWrite = true

    await store.commit(sessionStateMutation(0, 1, 3))
    await vi.advanceTimersByTimeAsync(750)
    await vi.waitFor(() => expect(backgroundErrors).toHaveLength(1))
    expect(writes).toBe(1)

    await store.flush()
    expect(writes).toBe(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes).toBe(2)
    const loaded = await trackedStore(directory).load()
    expect(readAgentThread(loaded!, 'thread-1')).toMatchObject({
      revision: 1,
      sessionState: { value: 1 },
      observation: { latestExecution: { status: 'running', summary: 'Value 1' } }
    })
  })

  it.each(['completed', 'failed', 'interrupted'] as const)('durably publishes a %s session pair before commit resolves', async status => {
    vi.useFakeTimers()
    const directory = await temporaryDirectory()
    const writes: string[][] = []
    let blockPublication = false
    let started!: () => void
    let release!: () => void
    const staged = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const store = trackedStore(directory, {
      beforeCommit: async keys => {
        writes.push([...keys])
        if (blockPublication) {
          started()
          await gate
        }
      }
    })
    await store.save(stateWithAgent())
    writes.length = 0
    await store.commit(sessionStateMutation(0, 1, 3))
    blockPublication = true
    let resolved = false
    const committing = store.commit(terminalSessionStateMutation(1, status)).then(state => {
      resolved = true
      return state
    })

    await staged
    try {
      expect(resolved).toBe(false)
      expect(readAgentThread(store.read(), 'thread-1')).toMatchObject({
        revision: 1, sessionState: { value: 1 },
        observation: { latestExecution: { status: 'running', summary: 'Value 1' } }
      })
      const beforePublication = await trackedStore(directory).load()
      expect(readAgentThread(beforePublication!, 'thread-1')).toMatchObject({
        revision: 0, sessionState: null,
        observation: { latestExecution: null, backgroundWork: null }
      })
    } finally {
      release()
    }
    const committed = await committing
    expect(readAgentThread(committed, 'thread-1')).toMatchObject({
      revision: 2, sessionState: { value: 2 },
      observation: { latestExecution: { status, summary: 'Value 2' } }
    })
    const durable = await trackedStore(directory).load()
    expect(readAgentThread(durable!, 'thread-1')).toEqual(readAgentThread(committed, 'thread-1'))
    expect(writes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes).toHaveLength(1)
  })

  it('makes user transcript and settings commands durable before commit resolves', async () => {
    const directory = await temporaryDirectory()
    const writes: string[][] = []
    let blockWrite = false
    let releaseWrite!: () => void
    let writeGate = Promise.resolve()
    const store = trackedStore(directory, {
      beforeCommit: async keys => {
        writes.push([...keys])
        if (blockWrite) await writeGate
      }
    })
    await store.save(stateWithAgent())
    writes.length = 0

    writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
    blockWrite = true
    let transcriptCommitResolved = false
    const transcriptCommit = store.commit({
      type: 'append-bart-transcript-item',
      threadId: 'bart-thread-1',
      item: {
        type: 'message',
        id: 'user-message-1',
        role: 'user',
        content: 'Keep this instruction durable.',
        createdAt: 3,
        status: 'complete'
      },
      updatedAt: 3
    }).then(state => {
      transcriptCommitResolved = true
      return state
    })

    await vi.waitFor(() => expect(writes).toHaveLength(1))
    expect(transcriptCommitResolved).toBe(false)
    releaseWrite()
    await transcriptCommit
    blockWrite = false
    const afterTranscript = (await trackedStore(directory).load())!
    expect(readBartThread(afterTranscript).transcript).toEqual([
      expect.objectContaining({ id: 'user-message-1', content: 'Keep this instruction durable.' })
    ])

    const settings = store.read().settings
    await store.commit({
      type: 'replace-settings',
      settings: { ...settings, locale: 'en-US' }
    })
    expect(writes).toHaveLength(2)
    const afterSettings = (await trackedStore(directory).load())!
    expect(afterSettings.settings.locale).toBe('en-US')
  })

  it('rejects a failed terminal write without advancing state and permits retry', async () => {
    vi.useFakeTimers()
    const directory = await temporaryDirectory()
    let rejectNextWrite = false
    const store = trackedStore(directory, {
      beforeCommit: async () => {
        if (rejectNextWrite) {
          rejectNextWrite = false
          throw new Error('terminal write failed')
        }
      }
    })
    await store.save(stateWithAgent())
    await store.commit(sessionStateMutation(0, 1, 3))
    rejectNextWrite = true
    const terminalMutation = terminalSessionStateMutation(1)

    await expect(store.commit(terminalMutation)).rejects.toThrow('terminal write failed')
    expect(readAgentThread(store.read(), 'thread-1')).toMatchObject({
      revision: 1,
      sessionState: { value: 1 },
      observation: { latestExecution: { status: 'running', summary: 'Value 1' } }
    })
    const afterFailure = await trackedStore(directory).load()
    expect(readAgentThread(afterFailure!, 'thread-1')).toMatchObject({
      revision: 0,
      sessionState: null,
      observation: { latestExecution: null }
    })

    // The failed durable mutation cleared the old trailing timer while it was
    // attempted; the store must restore persistence of the older session pair.
    await vi.advanceTimersByTimeAsync(750)
    await vi.waitFor(async () => {
      const restored = await trackedStore(directory).load()
      expect(readAgentThread(restored!, 'thread-1')).toMatchObject({ revision: 1 })
    })
    const afterRestoredTimer = await trackedStore(directory).load()
    expect(readAgentThread(afterRestoredTimer!, 'thread-1')).toMatchObject({
      revision: 1,
      sessionState: { value: 1 },
      observation: { latestExecution: { status: 'running', summary: 'Value 1' } }
    })
    await store.flush()

    await expect(store.commit(terminalMutation)).resolves.toBeDefined()
    expect(readAgentThread(store.read(), 'thread-1')).toMatchObject({
      revision: 2,
      sessionState: { value: 2 },
      observation: { latestExecution: { status: 'completed', summary: 'Value 2' } }
    })
    expect(await trackedStore(directory).load()).toEqual(store.read())
  })

  it('lets flush retry once when it joined a failing timer write', async () => {
    const directory = await temporaryDirectory()
    const backgroundErrors: unknown[] = []
    let streamingWrite = false
    let streamingAttempts = 0
    let reportFirstStarted!: () => void
    let rejectFirst!: () => void
    const firstStarted = new Promise<void>(resolve => { reportFirstStarted = resolve })
    const firstGate = new Promise<void>(resolve => { rejectFirst = resolve })
    const store = trackedStore(directory, {
      persistenceDebounceMs: 0,
      onBackgroundPersistenceError: error => backgroundErrors.push(error),
      beforeCommit: async () => {
        if (streamingWrite) {
          streamingAttempts += 1
          if (streamingAttempts === 1) {
            reportFirstStarted()
            await firstGate
            throw new Error('first timer write failed')
          }
        }
      }
    })
    await store.save(stateWithAgent())
    streamingWrite = true

    await store.commit(sessionStateMutation(0, 1, 3))
    await firstStarted
    const flushing = store.flush()
    rejectFirst()
    await expect(flushing).resolves.toBeUndefined()

    expect(streamingAttempts).toBe(2)
    expect(backgroundErrors).toHaveLength(1)
    const loaded = await trackedStore(directory).load()
    expect(readAgentThread(loaded!, 'thread-1')).toMatchObject({
      revision: 1,
      sessionState: { value: 1 }
    })
  })

  it('restores persistence of dirty authoritative state after save replacement fails', async () => {
    vi.useFakeTimers()
    const directory = await temporaryDirectory()
    let rejectNextWrite = false
    let writes = 0
    const store = trackedStore(directory, {
      beforeCommit: async () => {
        writes += 1
        if (rejectNextWrite) {
          rejectNextWrite = false
          throw new Error('replacement write failed')
        }
      }
    })
    await store.save(stateWithAgent())
    writes = 0
    await store.commit(sessionStateMutation(0, 1, 3))
    rejectNextWrite = true

    await expect(store.save(stateWithAgent())).rejects.toThrow('replacement write failed')
    expect(writes).toBe(1)
    expect(readAgentThread(store.read(), 'thread-1')).toMatchObject({
      revision: 1,
      sessionState: { value: 1 }
    })

    await vi.advanceTimersByTimeAsync(750)
    await vi.waitFor(() => expect(writes).toBe(2))
    await vi.waitFor(async () => {
      const restored = await trackedStore(directory).load()
      expect(readAgentThread(restored!, 'thread-1')).toMatchObject({ revision: 1 })
    })
    const loaded = await trackedStore(directory).load()
    expect(readAgentThread(loaded!, 'thread-1')).toMatchObject({
      revision: 1,
      sessionState: { value: 1 }
    })
    await store.flush()
    expect(writes).toBe(2)
  })

  it('isolates thread, report content, settings, and UI writes', async () => {
    const directory = await temporaryDirectory()
    const files: string[] = []
    const store = trackedStore(directory, {
      beforePrepare: async key => {
        files.push(key)
      }
    })
    await store.save({ ...stateWithAgent(), reports: [report('one'), report('two')] })
    files.length = 0
    await store.commit(sessionStateMutation(0, 1, 3))
    await store.flushThread('thread-1')
    expect(files).toHaveLength(1)
    expect(files[0]).toBe('thread:thread-1')

    files.length = 0
    await store.commit({ type: 'replace-settings', settings: { ...store.read().settings, locale: 'en-US' } })
    expect(files).toHaveLength(1)
    expect(files[0]).toBe('settings')

    files.length = 0
    await store.commit({ type: 'select-thread', threadId: 'thread-1' })
    expect(files).toHaveLength(1)
    expect(files[0]).toBe('ui')

    files.length = 0
    await store.commit({
      type: 'replace-reports',
      reports: store.read().reports.map(value => value.id === 'one'
        ? { ...value, html: '<html>Updated content</html>', updatedAt: 4 }
        : structuredClone(value))
    })
    expect(files).toEqual(['report:one'])
    expect(await trackedStore(directory).load()).toEqual(store.read())
    await store.flush()
  })

  it('does not impose a shared 50 MiB budget on report history and threads', async () => {
    const directory = await temporaryDirectory()
    const store = trackedStore(directory)
    const html = 'x'.repeat(900_000)
    const reports = Array.from({ length: 60 }, (_, index) => report(`report-${index}`, html))
    expect(html.length * reports.length).toBeGreaterThan(50 * 1024 * 1024)
    await store.save({ ...stateWithAgent(), reports })
    await store.commit(sessionStateMutation(0, 1, 3))
    await store.flushThread('thread-1')
    const loaded = await trackedStore(directory).load()
    expect(loaded?.reports).toHaveLength(60)
    expect(readAgentThread(loaded!, 'thread-1').sessionState).toEqual({ value: 1 })
    await store.flush()
  })

  it('commits and flushes new thread state without waiting for an unrelated report content write', async () => {
    const directory = await temporaryDirectory()
    let blockReports = false
    let reportStarted!: () => void
    let releaseReport!: () => void
    const started = new Promise<void>(resolve => { reportStarted = resolve })
    const gate = new Promise<void>(resolve => { releaseReport = resolve })
    const store = trackedStore(directory, {
      persistenceDebounceMs: 60_000,
      persistenceMaxWaitMs: 60_000,
      beforePrepare: async key => {
        if (blockReports && key.startsWith('report:')) {
          reportStarted()
          await gate
        }
      }
    })
    await store.save(stateWithAgent())
    blockReports = true
    let reportFinished = false
    const savingReport = store.commit({ type: 'replace-reports', reports: [report('one')] })
      .then(() => { reportFinished = true })
    await started
    try {
      let observed = false
      const observing = store.commit({
        type: 'replace-thread-session-state', threadId: 'thread-1', expectedRevision: 0,
        sessionState: { value: 0 },
        observation: { latestExecution: { executionId: 'running-during-report', status: 'running', startedAt: 3 }, backgroundWork: null },
        updatedAt: 3
      }).then(() => { observed = true })
      await vi.waitFor(() => expect(observed).toBe(true))
      await observing
      await store.commit(sessionStateMutation(1, 1, 4))
      expect(reportFinished).toBe(false)
      let flushed = false
      const flushing = store.flushThread('thread-1').then(() => { flushed = true })
      await vi.waitFor(() => expect(flushed).toBe(true))
      expect(reportFinished).toBe(false)
      await flushing
      const loaded = await trackedStore(directory).load()
      expect(loaded?.reports).toEqual([])
      expect(readAgentThread(loaded!, 'thread-1')).toMatchObject({
        revision: 2, sessionState: { value: 1 },
        observation: { latestExecution: { status: 'running', summary: 'Value 1' } }
      })
    } finally {
      releaseReport()
      await savingReport
      await store.flush()
    }
    const loaded = await trackedStore(directory).load()
    expect(loaded?.reports.map(value => value.id)).toEqual(['one'])
    expect(readAgentThread(loaded!, 'thread-1').sessionState).toEqual({ value: 1 })
  })

  it('commits Bart reset, selection, and settings in one atomic transaction', async () => {
    const directory = await temporaryDirectory()
    let failCommit = false
    const store = trackedStore(directory, {
      beforeCommit: async () => {
        if (failCommit) throw new Error('transaction publication failed')
      }
    })
    await store.save(stateWithAgent())
    const initial = store.read()
    const reset = {
      type: 'replace-bart-thread' as const,
      expectedThreadId: 'bart-thread-1', threadId: 'bart-replacement', hostHarnessId: 'codex' as const,
      settings: { ...initial.settings, locale: 'en-US' as const },
      threadSettings: { model: 'gpt-5' }, cwd: '/workspace/.bart-new', createdAt: 10
    }
    failCommit = true
    await expect(store.commit(reset)).rejects.toThrow('transaction publication failed')
    expect(store.read()).toBe(initial)
    expect(await trackedStore(directory).load()).toEqual(initial)
    failCommit = false
    await store.commit(reset)
    const loaded = await trackedStore(directory).load()
    expect(readBartThread(loaded!).id).toBe('bart-replacement')
    expect(loaded?.selectedThreadId).toBe('bart-replacement')
    expect(loaded?.settings.locale).toBe('en-US')
  })

  it('keeps same-thread revision guards ordered while a durable write is staged', async () => {
    const directory = await temporaryDirectory()
    let blockTerminal = false
    let started!: () => void
    let release!: () => void
    const staged = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const store = trackedStore(directory, {
      beforePrepare: async (key, value) => {
        if (blockTerminal && key.startsWith('thread:') &&
            (value as AgentThreadRecord).observation?.latestExecution?.status === 'completed') {
          started()
          await gate
        }
      }
    })
    await store.save(stateWithAgent())
    blockTerminal = true
    const terminal = store.commit(terminalSessionStateMutation(0))
    await staged
    let advanced = false
    const followup = store.commit(sessionStateMutation(1, 1, 5)).then(() => { advanced = true })
    expect(advanced).toBe(false)
    expect(readAgentThread(store.read(), 'thread-1').revision).toBe(0)
    release()
    await Promise.all([terminal, followup])
    expect(readAgentThread(store.read(), 'thread-1')).toMatchObject({
      revision: 2, sessionState: { value: 1 },
      observation: { latestExecution: { status: 'running', summary: 'Value 1' } }
    })
    await store.flush()
    expect(await trackedStore(directory).load()).toEqual(store.read())
  })

  it('closes only after admitted work and dirty thread state are durable, and rejects later writes', async () => {
    const directory = await temporaryDirectory()
    let blockReport = false
    let started!: () => void
    let release!: () => void
    const preparing = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const store = trackedStore(directory, {
      persistenceDebounceMs: 60_000,
      persistenceMaxWaitMs: 60_000,
      async beforePrepare(key) {
        if (blockReport && key === 'report:pending') {
          started()
          await gate
        }
      }
    })
    await store.save(stateWithAgent())
    await store.commit(sessionStateMutation(0, 1, 3))
    blockReport = true
    const reportCommit = store.commit({ type: 'replace-reports', reports: [report('pending')] })
    await preparing
    let closed = false
    const closing = store.close()
    void closing.then(() => { closed = true })
    try {
      expect(store.close()).toBe(closing)
      await expect(store.commit(sessionStateMutation(1, 2, 4))).rejects.toThrow('已关闭')
      await expect(store.save(stateWithAgent())).rejects.toThrow('已关闭')
      expect(closed).toBe(false)
    } finally {
      release()
      await reportCommit
      await closing
    }
    const reopened = await trackedStore(directory).load()
    expect(reopened?.reports.map(value => value.id)).toEqual(['pending'])
    expect(readAgentThread(reopened!, 'thread-1')).toMatchObject({
      revision: 1, sessionState: { value: 1 },
      observation: { latestExecution: { status: 'running', summary: 'Value 1' } }
    })
  })

  it('rejects oversized coalescible state without poisoning later commits', async () => {
    const directory = await temporaryDirectory()
    const store = trackedStore(directory)
    await store.save(stateWithAgent())

    await expect(store.commit({
      type: 'replace-thread-session-state',
      threadId: 'thread-1',
      expectedRevision: 0,
      sessionState: { payload: 'x'.repeat(50 * 1024 * 1024) },
      observation: runningObservation(999),
      updatedAt: 3
    })).rejects.toThrow('超过 50 MB')
    expect(readAgentThread(store.read(), 'thread-1')).toMatchObject({
      revision: 0,
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null }
    })

    await expect(store.commit(sessionStateMutation(0, 1, 3))).resolves.toBeDefined()
    expect(readAgentThread(store.read(), 'thread-1')).toMatchObject({
      revision: 1,
      sessionState: { value: 1 }
    })
    await store.flush()
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-thread-state-'))
  directories.push(directory)
  return directory
}

function agentThread(): AgentThreadRecord<'codex', { model: string }> {
  return {
    id: 'thread-1',
    harnessId: 'codex',
    archived: false,
    revision: 0,
    title: 'Thread',
    emoji: '👩🏽‍💻',
    tags: [],
    cwd: '/workspace',
    settings: { model: 'gpt-5' },
    sessionState: null,
    observation: { latestExecution: null, backgroundWork: null },
    createdAt: 2,
    updatedAt: 2
  }
}

function stateWithAgent() {
  const initial = createOpenAgentState({
    bartThreadId: 'bart-thread-1',
    hostHarnessId: 'codex',
    bartThreadSettings: { model: 'gpt-5' },
    bartCwd: '/workspace/.bart',
    createdAt: 1,
    selectedThreadId: 'bart-thread-1',
    settings: createDefaultOpenAgentSettings()
  })
  return { ...initial, threads: [...initial.threads, agentThread()] }
}

function sessionStateMutation(expectedRevision: number, value: number, updatedAt: number) {
  return {
    type: 'replace-thread-session-state' as const,
    threadId: 'thread-1',
    expectedRevision,
    sessionState: { value },
    observation: runningObservation(value),
    updatedAt
  }
}

function runningObservation(value: number) {
  return {
    latestExecution: {
      executionId: 'execution-1', status: 'running' as const, startedAt: 3,
      summary: `Value ${value}`
    },
    backgroundWork: null
  }
}

function terminalSessionStateMutation(
  expectedRevision: number,
  status: 'completed' | 'failed' | 'interrupted' = 'completed'
) {
  return {
    type: 'replace-thread-session-state' as const,
    threadId: 'thread-1',
    expectedRevision,
    sessionState: { value: 2 },
    observation: {
      latestExecution: {
        executionId: 'execution-1',
        status,
        startedAt: 3,
        finishedAt: 4,
        summary: 'Value 2'
      },
      backgroundWork: null
    },
    updatedAt: 4
  }
}

function report(id: string, html = '<html>Report content</html>') {
  return { id, title: 'Report', html, tags: [], relatedExecutions: [], createdAt: 2, updatedAt: 2, archived: false }
}

function trackedStore(directory: string, options?: ThreadStateStoreOptions): ThreadStateStore {
  const store = new ThreadStateStore(directory, options)
  stores.push(store)
  return store
}
