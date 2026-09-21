import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HarnessThreadInstance,
  HarnessThreadOpeningCleanupError,
  type HarnessThreadCommitted
} from '../src/main/harness-thread-runtime'
import {
  ThreadStateStore,
  type ThreadStateStoreOptions
} from '../src/main/services/thread-state-store'
import {
  MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS,
  MAX_PUBLIC_INTERACTION_PROMPT_CHARACTERS,
  isThreadPublicObservation,
  type AgentThreadRecord,
  type HarnessThreadHandle,
  type HarnessSessionStateAdapter,
  type JsonValue,
  type PublicExecution,
  type HarnessThreadOpenContext,
  type PublicInteraction,
  type ThreadPublicObservation
} from '@openagent/contracts'
import {
  createOpenAgentState,
  readAgentThread,
  readHarnessThread,
  reduceOpenAgentState
} from '../src/shared/openagent-state'
import { createDefaultOpenAgentSettings } from '../src/shared/openagent-settings'
import { commitTestObservation, testSessionState, testSessionStateWithObservation } from '@openagent/test-kit'

const directories: string[] = []
const stores: ThreadStateStore[] = []

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map(store => store.close()))
  await Promise.all(directories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('HarnessThreadInstance', () => {
  it('publishes transient display without a state commit, fences executions and isolates observer failures', async () => {
    const store = await stateStore(true)
    let context!: HarnessThreadOpenContext
    const publish = vi.fn()
    const instance = await HarnessThreadInstance.open({
      store, threadId: 'agent-thread-1', harnessId: 'codex', sessionStateAdapter: versionedSessionState,
      openThread: async value => { context = value; return handle() },
      createExecutionId: () => 'display', now: () => 20, signal: new AbortController().signal,
      committed: () => {}, publishBartActivity: publish
    })
    const claim = context.executionClaims.claim()
    await context.sessionState.commit({ version: 'start', executions: [
      { executionId: claim.executionId, status: 'running', startedAt: 10 }
    ], tasks: [] })
    const before = readHarnessThread(store.read(), context.thread.id)
    expect(() => context.bartDisplay!.publish(null as never)).not.toThrow()
    context.bartDisplay!.publish({ executionId: 'foreign', kind: 'assistant-text', sequence: 1 })
    expect(publish).not.toHaveBeenCalled()
    context.bartDisplay!.publish({ executionId: claim.executionId, kind: 'reasoning', text: 'first', sequence: 1 })
    context.bartDisplay!.publish({ executionId: claim.executionId, kind: 'assistant-text', sequence: 2 })
    expect(publish.mock.calls.map(([event]) => event.kind)).toEqual(['reasoning', 'assistant-text'])
    expect(readHarnessThread(store.read(), context.thread.id)).toEqual(before)
    publish.mockImplementation(() => { throw new Error('display observer failed') })
    expect(() => context.bartDisplay!.publish({ executionId: claim.executionId, kind: 'assistant-text', sequence: 3 })).not.toThrow()
    await context.sessionState.commit({ version: 'end', executions: [
      { executionId: claim.executionId, status: 'completed', startedAt: 10, finishedAt: 20 }
    ], tasks: [] })
    publish.mockClear()
    context.bartDisplay!.publish({ executionId: claim.executionId, kind: 'assistant-text', sequence: 4 })
    expect(publish).not.toHaveBeenCalled()
    await instance.dispose()
  })

  it('publishes and persists the projected invocation snapshot as one Thread revision', async () => {
    const durableThreads: AgentThreadRecord[] = []
    const store = await stateStore(true, {
      persistenceDebounceMs: 60_000,
      persistenceMaxWaitMs: 60_000,
      beforePrepare: async (key, value) => {
        if (key.startsWith('thread:')) durableThreads.push(structuredClone(value) as AgentThreadRecord)
      }
    })
    durableThreads.length = 0
    const committed: HarnessThreadCommitted[] = []
    let context!: HarnessThreadOpenContext
    const project = vi.fn(versionedSessionState.project)
    const instance = await HarnessThreadInstance.open({
      store,
      threadId: 'agent-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: { ...versionedSessionState, project },
      openThread: async value => { context = value; return handle() },
      createExecutionId: () => 'snapshot-execution',
      now: () => 20,
      signal: new AbortController().signal,
      committed: change => committed.push(change)
    })
    project.mockClear()
    const claim = context.executionClaims.claim()
    const supplied = {
      version: 'snapshot-1',
      executions: [{ executionId: claim.executionId, status: 'running' as const, startedAt: 10 }],
      tasks: [{ executionId: claim.executionId, status: 'running' as const }]
    }
    const expectedState = structuredClone(supplied)
    const before = readHarnessThread(store.read(), context.thread.id)
    const pending = context.sessionState.commit(supplied)
    supplied.version = 'mutated-after-commit'
    supplied.executions[0].startedAt = 999
    await pending

    const record = readHarnessThread(store.read(), context.thread.id)
    expect(record.revision).toBe(before.revision + 1)
    expect(record.sessionState).toEqual(expectedState)
    expect(record.observation).toEqual({
      latestExecution: {
        executionId: 'snapshot-execution', status: 'running', startedAt: 10, summary: 'snapshot-1'
      },
      backgroundWork: { status: 'running' }
    })
    expect(project).toHaveBeenCalledOnce()
    expect(project).toHaveBeenCalledWith(expectedState)
    expect(committed).toHaveLength(1)
    expect(committed[0]).toMatchObject({
      record,
      observation: record.observation,
      observationChanged: true,
      executionChanged: true
    })
    await store.flushThread(context.thread.id)
    expect(durableThreads).toHaveLength(1)
    expect(durableThreads[0]).toEqual(record)
    expect(versionedSessionState.project(durableThreads[0].sessionState)).toEqual(record.observation)
    await instance.dispose()
  })

  it.each(['projection', 'validation', 'admission'] as const)(
    'leaves state, observation, revision and notifications unchanged after %s rejects a commit',
    async rejection => {
      const store = await stateStore(false)
      const committed = vi.fn()
      let context!: HarnessThreadOpenContext
      const projectionError = new Error('fixture projection rejected')
      const adapter: HarnessSessionStateAdapter = {
        ...versionedSessionState,
        project(state) {
          const version = (state as unknown as VersionedSessionFixture | null)?.version
          if (version === 'projection') throw projectionError
          if (version === 'validation') {
            return { latestExecution: { status: 'invalid' }, backgroundWork: null } as never
          }
          return versionedSessionState.project(state)
        }
      }
      const instance = await HarnessThreadInstance.open({
        store,
        threadId: 'bart-thread-1',
        harnessId: 'codex',
        sessionStateAdapter: adapter,
        openThread: async value => { context = value; return handle() },
        createExecutionId: () => 'unused',
        now: () => 20,
        signal: new AbortController().signal,
        committed
      })
      await context.sessionState.commit({ version: 'accepted', executions: [], tasks: [] })
      await store.flush()
      const before = structuredClone(readHarnessThread(store.read(), context.thread.id))
      committed.mockClear()
      await expect(context.sessionState.commit({
        version: rejection,
        executions: [{ executionId: 'unclaimed-execution', status: 'running', startedAt: 10 }],
        tasks: []
      })).rejects.toThrow()

      expect(readHarnessThread(store.read(), context.thread.id)).toEqual(before)
      expect(context.sessionState.read()).toEqual(before.sessionState)
      expect(instance.observation).toEqual(before.observation)
      expect(instance.execution).toBeNull()
      expect(committed).not.toHaveBeenCalled()
      await instance.dispose()
    }
  )

  it('keeps queued streaming snapshots paired through callbacks and coalesced persistence', async () => {
    const persisted: AgentThreadRecord[] = []
    const store = await stateStore(true, {
      persistenceDebounceMs: 60_000,
      persistenceMaxWaitMs: 60_000,
      beforePrepare: async (key, value) => {
        if (key.startsWith('thread:')) persisted.push(structuredClone(value) as AgentThreadRecord)
      }
    })
    let context!: HarnessThreadOpenContext
    const committed: HarnessThreadCommitted[] = []
    const instance = await HarnessThreadInstance.open({
      store,
      threadId: 'agent-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: versionedSessionState,
      openThread: async value => { context = value; return handle() },
      createExecutionId: () => 'stream-execution',
      now: () => 20,
      signal: new AbortController().signal,
      committed: change => committed.push(change)
    })
    const claim = context.executionClaims.claim()
    const initial = {
      version: 'stream-1',
      executions: [{ executionId: claim.executionId, status: 'running' as const, startedAt: 10 }],
      tasks: []
    }
    await context.sessionState.commit(initial)
    await store.flushThread(context.thread.id)
    persisted.length = 0
    committed.length = 0
    const before = readHarnessThread(store.read(), context.thread.id)
    const originalCommit = store.commit.bind(store)
    let release!: () => void
    let blocked = false
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(store, 'commit').mockImplementation(async (mutation, assertCurrent) => {
      if (!blocked && mutation.type === 'replace-thread-session-state') {
        blocked = true
        await gate
      }
      return originalCommit(mutation, assertCurrent)
    })
    const second = { ...structuredClone(initial), version: 'stream-2' }
    const secondCommit = context.sessionState.commit(second)
    await vi.waitFor(() => expect(blocked).toBe(true))
    const third = { ...structuredClone(initial), version: 'stream-3' }
    const thirdCommit = context.sessionState.commit(third)
    second.version = 'mutated-second'
    third.version = 'mutated-third'
    expect(readHarnessThread(store.read(), context.thread.id)).toEqual(before)
    expect(committed).toHaveLength(0)
    release()
    await Promise.all([secondCommit, thirdCommit])

    expect(committed.map(change => change.record.revision)).toEqual([
      before.revision + 1, before.revision + 2
    ])
    expect(committed.map(change => change.observation.latestExecution?.summary))
      .toEqual(['stream-2', 'stream-3'])
    for (const change of committed) {
      expect(versionedSessionState.project(change.record.sessionState)).toEqual(change.observation)
      expect(change.record.observation).toEqual(change.observation)
    }
    await store.flushThread(context.thread.id)
    expect(persisted).toHaveLength(1)
    expect(persisted[0].sessionState).toMatchObject({ version: 'stream-3' })
    expect(persisted[0].observation.latestExecution).toMatchObject({ summary: 'stream-3' })
    await instance.dispose()
  })

  it.each(['interrupt', 'dispose', 'send-failure'] as const)(
    'asks Plugin settlement to update opaque state before the atomic %s fallback commit',
    async operation => {
      const store = await stateStore(false)
      const outcome = operation === 'send-failure' ? 'failed' : 'interrupted'
      const order: string[] = []
      const sendFailure = new Error('fixture native send failed')
      let runningState!: JsonValue
      const settle = vi.fn<HarnessSessionStateAdapter['settle']>(input => {
        order.push('plugin-settle')
        const state = testSessionState.settle(input)
        return { ...state as object, fixtureSettlement: input.outcome } as JsonValue
      })
      const instance = await HarnessThreadInstance.open({
        store,
        threadId: 'bart-thread-1',
        harnessId: 'codex',
        sessionStateAdapter: { ...testSessionState, settle },
        openThread: async context => handle(async request => {
          runningState = testSessionStateWithObservation({ nativeFacts: { retained: true } }, {
            latestExecution: {
              executionId: request.executionId, status: 'running', startedAt: 10
            },
            backgroundWork: { status: 'running' }
          })
          await context.sessionState.commit(runningState)
          if (operation === 'send-failure') throw sendFailure
        }),
        createExecutionId: () => 'settled-execution',
        now: () => 77,
        signal: new AbortController().signal,
        committed: change => {
          if (change.observation.latestExecution?.status === outcome) {
            order.push('committed')
            expect(testSessionState.project(change.record.sessionState)).toEqual(change.observation)
          }
        }
      })
      const send = instance.send({ parts: [{ kind: 'text', text: 'Run' }] }, new AbortController().signal)
      if (operation === 'send-failure') await expect(send).rejects.toBe(sendFailure)
      else {
        await send
        if (operation === 'interrupt') await instance.interrupt('settled-execution')
        else await instance.dispose()
      }

      expect(settle).toHaveBeenCalledOnce()
      expect(settle).toHaveBeenCalledWith({
        sessionState: runningState, executionId: 'settled-execution', outcome, finishedAt: 77
      })
      expect(order).toEqual(['plugin-settle', 'committed'])
      const record = readHarnessThread(store.read(), 'bart-thread-1')
      expect(record.revision).toBe(2)
      expect(record.sessionState).toMatchObject({
        nativeFacts: { retained: true }, fixtureSettlement: outcome
      })
      expect(record.observation).toEqual({
        latestExecution: {
          executionId: 'settled-execution', status: outcome, startedAt: 10, finishedAt: 77
        },
        backgroundWork: { status: 'running' }
      })
      await instance.dispose()
    }
  )

  it('commits older Execution background facts while retaining the latest Execution', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext
    const ids = ['older-execution', 'latest-execution']
    const committed: HarnessThreadCommitted[] = []
    const instance = await HarnessThreadInstance.open({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: versionedSessionState,
      openThread: async value => {
        context = value
        return handle(async request => {
          const oldState = context.sessionState.read() as unknown as VersionedSessionFixture | null
          const executions = [...oldState?.executions ?? [], {
            executionId: request.executionId, status: 'running' as const, startedAt: 10
          }]
          await context.sessionState.commit({
            version: 'foreground', executions, tasks: oldState?.tasks ?? []
          } as unknown as JsonValue)
          if (request.executionId === 'older-execution') {
            await context.sessionState.commit({
              version: 'foreground',
              executions: [{
                executionId: request.executionId, status: 'completed', startedAt: 10, finishedAt: 11
              }],
              tasks: [{ executionId: request.executionId, status: 'running' }]
            })
          }
        })
      },
      createExecutionId: () => ids.shift()!,
      now: () => 20,
      signal: new AbortController().signal,
      committed: change => committed.push(change)
    })
    await instance.send({ parts: [{ kind: 'text', text: 'First' }] }, new AbortController().signal)
    await instance.send({ parts: [{ kind: 'text', text: 'Second' }] }, new AbortController().signal)
    const before = readHarnessThread(store.read(), context.thread.id)
    expect(before.observation.latestExecution?.executionId).toBe('latest-execution')
    expect(before.observation.backgroundWork).toEqual({ status: 'running' })
    const changed = structuredClone(before.sessionState) as unknown as VersionedSessionFixture
    changed.tasks[0].status = 'completed'
    await context.sessionState.commit(changed as unknown as JsonValue)

    const after = readHarnessThread(store.read(), context.thread.id)
    expect(after.observation.latestExecution).toEqual(before.observation.latestExecution)
    expect(after.observation.backgroundWork).toBeNull()
    expect(after.revision).toBe(before.revision + 1)
    expect(instance.execution?.executionId).toBe('latest-execution')
    expect(committed.at(-1)).toMatchObject({ observationChanged: true, executionChanged: false })
    expect(versionedSessionState.project(after.sessionState)).toEqual(after.observation)
    expect(after.sessionState).toMatchObject({
      executions: [
        { executionId: 'older-execution', status: 'completed', finishedAt: 11 },
        { executionId: 'latest-execution', status: 'running' }
      ],
      tasks: [{ executionId: 'older-execution', status: 'completed' }]
    })
    await instance.dispose()
  })

  it('rejects a send queued inside Runtime after archive without allocating a new Execution', async () => {
    const store = await stateStore(true)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let accepted = false
    const createExecutionId = vi.fn(() => 'first-execution')
    const nativeSend = vi.fn()
    const instance = await HarnessThreadInstance.open({
      store, threadId: 'agent-thread-1', harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async context => handle(async request => {
        nativeSend(request)
        await commitTestObservation(context, { latestExecution: {
          executionId: request.executionId, status: 'running', startedAt: 10
        }, backgroundWork: null })
        accepted = true
        await gate
        await commitTestObservation(context, { latestExecution: {
          executionId: request.executionId, status: 'completed', startedAt: 10, finishedAt: 11
        }, backgroundWork: null })
      }),
      createExecutionId, now: () => 10, signal: new AbortController().signal, committed: () => undefined
    })
    const first = instance.send({ parts: [{ kind: 'text', text: 'existing work' }] }, new AbortController().signal)
    await vi.waitFor(() => expect(accepted).toBe(true))
    const second = instance.send({ parts: [{ kind: 'text', text: 'queued append' }] }, new AbortController().signal)
    const rejected = expect(second).rejects.toThrow(/已归档/)
    await store.commit({ type: 'set-agent-thread-archived', threadId: 'agent-thread-1', archived: true })
    release()
    await first
    await rejected
    expect(nativeSend).toHaveBeenCalledTimes(1)
    expect(createExecutionId).toHaveBeenCalledTimes(1)
    expect(readHarnessThread(store.read(), 'agent-thread-1').observation.latestExecution)
      .toMatchObject({ executionId: 'first-execution', status: 'completed' })
    await instance.dispose()
  })

  it('uses one lifecycle for Agent and Bart Threads', async () => {
    const store = await stateStore(true)
    const opened: string[] = []
    const committed: HarnessThreadCommitted[] = []

    const open = async (
      context: HarnessThreadOpenContext<'codex', { model: string }>
    ): Promise<HarnessThreadHandle> => {
      opened.push(context.thread.id)
      return handle(async request => {
        await context.sessionState.commit(testSessionStateWithObservation(
          { threadId: context.thread.id },
          {
            latestExecution: {
              executionId: request.executionId,
              status: 'running',
              startedAt: 10
            },
            backgroundWork: null
          }
        ))
        await commitTestObservation(context, {
          latestExecution: {
            executionId: request.executionId,
            status: 'completed',
            startedAt: 10,
            finishedAt: 11
          },
          backgroundWork: null
        })
      })
    }

    const agent = await HarnessThreadInstance.open({
      store,
      threadId: 'agent-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: open,
      createExecutionId: () => 'execution-agent',
      now: () => 10,
      signal: new AbortController().signal,
      committed: change => committed.push(change)
    })
    const bart = await HarnessThreadInstance.open({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: open,
      createExecutionId: () => 'execution-bart',
      now: () => 10,
      signal: new AbortController().signal,
      committed: change => committed.push(change)
    })

    await agent.send({ parts: [{ kind: 'text', text: 'agent' }] }, new AbortController().signal)
    await bart.send({ parts: [{ kind: 'text', text: 'bart' }] }, new AbortController().signal)

    expect(opened).toEqual(['agent-thread-1', 'bart-thread-1'])
    expect(readHarnessThread(store.read(), 'agent-thread-1').sessionState)
      .toMatchObject({ threadId: 'agent-thread-1' })
    expect(readHarnessThread(store.read(), 'bart-thread-1').sessionState)
      .toMatchObject({ threadId: 'bart-thread-1' })
    expect(committed.some(change => change.record.id === 'bart-thread-1'))
      .toBe(true)

    await Promise.all([agent.dispose(), bart.dispose()])
  })

  it('passes Bart run context through the standard Handle send contract', async () => {
    const store = await stateStore(false)
    const send = vi.fn()
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle(async request => {
          send(request)
          await commitTestObservation(context, {
            latestExecution: {
              executionId: request.executionId,
              status: 'running',
              startedAt: 1
            },
            backgroundWork: null
          })
          await commitTestObservation(context, {
            latestExecution: {
              executionId: request.executionId,
              status: 'completed',
              startedAt: 1,
              finishedAt: 2
            },
            backgroundWork: null
          })
        })
      },
      createExecutionId: () => 'execution-1',
      now: () => 1,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    await instance.send(
      { parts: [{ kind: 'text', text: 'hello' }] },
      new AbortController().signal,
      [{ id: 'workspace', content: 'workspace context' }]
    )
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      contextEntries: [{ id: 'workspace', content: 'workspace context' }]
    }))
    await instance.dispose()
  })

  it('awaits new-Execution admission at the running commit before Handle send continues', async () => {
    const store = await stateStore(false)
    const order: string[] = []
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle(async request => {
          await commitTestObservation(context, {
            latestExecution: {
              executionId: request.executionId,
              status: 'running',
              startedAt: 1
            },
            backgroundWork: null
          })
          order.push('handle-after-running')
        })
      },
      createExecutionId: () => 'admission-order-execution',
      now: () => 1,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    await instance.send(
      { parts: [{ kind: 'text', text: 'admit' }] },
      new AbortController().signal,
      [],
      async result => {
        order.push(`admitted:${result.startedNewExecution}`)
        await Promise.resolve()
        order.push('admission-persisted')
      }
    )

    expect(order).toEqual([
      'admitted:true',
      'admission-persisted',
      'handle-after-running'
    ])
    await instance.dispose()
  })

  it('does not admit a native send rejected before its running commit', async () => {
    const store = await stateStore(false)
    const rejection = new Error('native admission rejected')
    const admitted = vi.fn()
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async () => handle(async () => { throw rejection }),
      createExecutionId: () => 'rejected-admission-execution',
      now: () => 1,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    await expect(instance.send(
      { parts: [{ kind: 'text', text: 'reject' }] },
      new AbortController().signal,
      [],
      admitted
    )).rejects.toBe(rejection)
    expect(admitted).not.toHaveBeenCalled()
    expect(instance.execution).toBeNull()
    await instance.dispose()
  })

  it('requires and consumes one Core execution claim for each native wake', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const executionIds = ['native-claimed', 'native-abandoned', 'native-successor']
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle()
      },
      createExecutionId: () => executionIds.shift()!,
      now: () => 1,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    await expect(commitTestObservation(context, {
      latestExecution: {
        executionId: 'plugin-native-id',
        status: 'running',
        startedAt: 1
      },
      backgroundWork: null
    })).rejects.toThrow('新 Execution running 状态无效')

    const claim = context.executionClaims.claim()
    expect(claim.executionId).toBe('native-claimed')
    expect(() => context.executionClaims.claim()).toThrow('active 或 pending')
    await commitTestObservation(context, {
      latestExecution: {
        executionId: claim.executionId,
        status: 'running',
        startedAt: 1
      },
      backgroundWork: null
    })
    claim.abandon()
    expect(instance.execution).toMatchObject({ executionId: 'native-claimed' })
    expect(() => context.executionClaims.claim()).toThrow('active 或 pending')
    await commitTestObservation(context, {
      latestExecution: {
        executionId: claim.executionId,
        status: 'completed',
        startedAt: 1,
        finishedAt: 2
      },
      backgroundWork: null
    })

    const abandoned = context.executionClaims.claim()
    expect(abandoned.executionId).toBe('native-abandoned')
    abandoned.abandon()
    abandoned.abandon()
    await expect(commitTestObservation(context, {
      latestExecution: {
        executionId: abandoned.executionId,
        status: 'running',
        startedAt: 3
      },
      backgroundWork: null
    })).rejects.toThrow('新 Execution running 状态无效')

    const successor = context.executionClaims.claim()
    expect(successor.executionId).toBe('native-successor')
    await commitTestObservation(context, {
      latestExecution: {
        executionId: successor.executionId,
        status: 'running',
        startedAt: 3
      },
      backgroundWork: null
    })
    expect(instance.execution).toMatchObject({ executionId: 'native-successor' })
    await instance.dispose()
  })

  it('admits claimed native work only after private and running state are durably flushed', async () => {
    let gateAdmissionSnapshot = false
    let reportSnapshotStarted!: () => void
    let releaseSnapshot!: () => void
    const snapshotStarted = new Promise<void>(resolve => { reportSnapshotStarted = resolve })
    const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve })
    const durableSnapshots: unknown[] = []
    const durableThreads: unknown[] = []
    const beforeCommit = vi.fn(async (keys: readonly string[]) => {
      if (!gateAdmissionSnapshot) return
      durableSnapshots.push([...keys])
      reportSnapshotStarted()
      await snapshotGate
    })
    const store = await stateStore(false, {
      persistenceDebounceMs: 60_000,
      persistenceMaxWaitMs: 60_000,
      beforePrepare: async (key, value) => {
        if (gateAdmissionSnapshot && key.startsWith('thread:')) durableThreads.push(structuredClone(value) as AgentThreadRecord)
      },
      beforeCommit
    })
    gateAdmissionSnapshot = true
    beforeCommit.mockClear()
    const order: string[] = []
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const authorize = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false)
      const thread = readHarnessThread(store.read(), 'bart-thread-1')
      expect(thread.sessionState).toMatchObject({ wake: 'durable-input' })
      expect(thread.observation.latestExecution).toMatchObject({
        executionId: 'durable-native-execution',
        status: 'running'
      })
      order.push('core-authorized')
    })
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle()
      },
      createExecutionId: () => 'durable-native-execution',
      now: () => 1,
      signal: new AbortController().signal,
      admitNativeExecution: authorize,
      committed: () => undefined
    })

    const claim = context.executionClaims.claim()
    const runningCommit = context.sessionState.commit(testSessionStateWithObservation({
      wake: 'durable-input'
    }, {
      latestExecution: {
        executionId: claim.executionId,
        status: 'running',
        startedAt: 1
      },
      backgroundWork: null
    }))
    const firstAdmission = context.executionAdmission.admit(claim.executionId)
    const concurrentAdmission = context.executionAdmission.admit(claim.executionId)
    expect(concurrentAdmission).toBe(firstAdmission)
    let admitted = false
    void firstAdmission.then(() => { admitted = true })

    await runningCommit
    await snapshotStarted
    order.push('snapshot-started')
    expect(admitted).toBe(false)
    expect(order).toEqual(['core-authorized', 'snapshot-started'])
    expect(durableSnapshots[0]).toContain('thread:bart-thread-1')
    const durableThread = durableThreads[0]
    expect(durableThread).toMatchObject({
      sessionState: { wake: 'durable-input' },
      observation: {
        latestExecution: {
          executionId: 'durable-native-execution',
          status: 'running'
        }
      }
    })

    releaseSnapshot()
    await expect(Promise.all([firstAdmission, concurrentAdmission]))
      .resolves.toEqual([undefined, undefined])
    await expect(context.executionAdmission.admit(claim.executionId))
      .resolves.toBeUndefined()
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(beforeCommit).toHaveBeenCalledTimes(1)
    await instance.dispose()
  })

  it('fails native admission closed for foreign, abandoned, non-running, terminal, and closed claims', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const executionIds = [
      'not-running-native',
      'abandoned-native',
      'terminal-native',
      'closed-native'
    ]
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle()
      },
      createExecutionId: () => executionIds.shift()!,
      now: () => 4,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    const notRunning = context.executionClaims.claim()
    await expect(context.executionAdmission.admit('foreign-native'))
      .rejects.toThrow('claim 不存在或已失效')
    await expect(context.executionAdmission.admit(notRunning.executionId))
      .rejects.toThrow('尚未发布 running')
    await commitTestObservation(context, {
      latestExecution: {
        executionId: notRunning.executionId,
        status: 'running',
        startedAt: 1
      },
      backgroundWork: null
    })
    await expect(context.executionAdmission.admit(notRunning.executionId))
      .resolves.toBeUndefined()
    await commitTestObservation(context, {
      latestExecution: {
        executionId: notRunning.executionId,
        status: 'completed',
        startedAt: 1,
        finishedAt: 2
      },
      backgroundWork: null
    })

    const abandoned = context.executionClaims.claim()
    abandoned.abandon()
    await expect(context.executionAdmission.admit(abandoned.executionId))
      .rejects.toThrow('claim 不存在或已失效')

    const terminal = context.executionClaims.claim()
    await commitTestObservation(context, {
      latestExecution: {
        executionId: terminal.executionId,
        status: 'running',
        startedAt: 3
      },
      backgroundWork: null
    })
    await commitTestObservation(context, {
      latestExecution: {
        executionId: terminal.executionId,
        status: 'completed',
        startedAt: 3,
        finishedAt: 4
      },
      backgroundWork: null
    })
    await expect(context.executionAdmission.admit(terminal.executionId))
      .rejects.toThrow('claim 不存在或已失效')

    const closed = context.executionClaims.claim()
    await commitTestObservation(context, {
      latestExecution: {
        executionId: closed.executionId,
        status: 'running',
        startedAt: 4
      },
      backgroundWork: null
    })
    await instance.dispose()
    await expect(context.executionAdmission.admit(closed.executionId))
      .rejects.toThrow('已关闭')
  })

  it('allows an exact running native admission to retry a transient Core failure', async () => {
    const store = await stateStore(false)
    const transientFailure = new Error('workspace grant temporarily unavailable')
    let attempts = 0
    const authorize = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw transientFailure
    })
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle()
      },
      createExecutionId: () => 'retryable-native-admission',
      now: () => 1,
      signal: new AbortController().signal,
      admitNativeExecution: authorize,
      committed: () => undefined
    })
    const claim = context.executionClaims.claim()
    await commitTestObservation(context, {
      latestExecution: {
        executionId: claim.executionId,
        status: 'running',
        startedAt: 1
      },
      backgroundWork: null
    })

    await expect(context.executionAdmission.admit(claim.executionId))
      .rejects.toBe(transientFailure)
    await expect(context.executionAdmission.admit(claim.executionId))
      .resolves.toBeUndefined()
    expect(authorize).toHaveBeenCalledTimes(2)
    await instance.dispose()
  })

  it('makes a fork reservation mutually exclusive with native claims and send admission', async () => {
    const store = await stateStore(true)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const executionIds = ['pending-before-fork', 'claim-after-fork']
    const nativeSend = vi.fn(async () => undefined)
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'agent-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle(nativeSend)
      },
      createExecutionId: () => executionIds.shift()!,
      now: () => 1,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    const pending = context.executionClaims.claim()
    expect(() => instance.reserveFork()).toThrow('pending Execution')
    pending.abandon()

    const reservation = instance.reserveFork()
    expect(() => context.executionClaims.claim()).toThrow('fork 进行期间')
    await expect(instance.send(
      { parts: [{ kind: 'text', text: 'must not enter native transport' }] },
      new AbortController().signal
    )).rejects.toThrow('fork 进行期间')
    expect(nativeSend).not.toHaveBeenCalled()

    reservation.release()
    reservation.release()
    const afterFork = context.executionClaims.claim()
    expect(afterFork.executionId).toBe('claim-after-fork')
    afterFork.abandon()
    await instance.dispose()
  })

  it('releases a native execution claim when its running commit fails', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const executionIds = ['failed-native-claim', 'replacement-native-claim']
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle()
      },
      createExecutionId: () => executionIds.shift()!,
      now: () => 1,
      signal: new AbortController().signal,
      committed: () => undefined
    })
    const persistenceFailure = new Error('native claim persistence failed')
    const originalCommit = store.commit.bind(store)
    let rejectRunning = true
    vi.spyOn(store, 'commit').mockImplementation(mutation => {
      if (rejectRunning && mutation.type === 'replace-thread-session-state' &&
          mutation.observation.latestExecution?.status === 'running') {
        rejectRunning = false
        return Promise.reject(persistenceFailure)
      }
      return originalCommit(mutation)
    })

    const failed = context.executionClaims.claim()
    await expect(commitTestObservation(context, {
      latestExecution: {
        executionId: failed.executionId,
        status: 'running',
        startedAt: 1
      },
      backgroundWork: null
    })).rejects.toBe(persistenceFailure)
    expect(instance.execution).toBeNull()
    const replacement = context.executionClaims.claim()
    expect(replacement.executionId).toBe('replacement-native-claim')
    await commitTestObservation(context, {
      latestExecution: {
        executionId: replacement.executionId,
        status: 'running',
        startedAt: 2
      },
      backgroundWork: null
    })
    await instance.dispose()
  })

  it('disposes a Handle that resolves after its parent opening authority aborts', async () => {
    const store = await stateStore(false)
    const parent = new AbortController()
    const dispose = vi.fn(async () => undefined)
    let releaseOpen!: () => void
    const openGate = new Promise<void>(resolve => { releaseOpen = resolve })
    const opening = HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async () => {
        await openGate
        return { ...handle(), dispose }
      },
      createExecutionId: () => 'never-used',
      now: () => 1,
      signal: parent.signal,
      committed: () => undefined
    })
    const ownershipLoss = new Error('opening ownership lost')
    parent.abort(ownershipLoss)
    releaseOpen()

    await expect(opening).rejects.toBe(ownershipLoss)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('drains an unawaited opening publication and durably interrupts it on failure', async () => {
    const store = await stateStore(false)
    const openingFailure = new Error('open failed after publishing running')
    let runningPublication!: Promise<void>

    const opening = HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async context => {
        const claim = context.executionClaims.claim()
        runningPublication = commitTestObservation(context, {
          latestExecution: {
            executionId: claim.executionId,
            status: 'running',
            startedAt: 1
          },
          backgroundWork: null
        })
        throw openingFailure
      },
      createExecutionId: () => 'opening-running-race',
      now: () => 2,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    await expect(opening).rejects.toBe(openingFailure)
    await expect(runningPublication).resolves.toBeUndefined()
    expect(readHarnessThread(store.read(), 'bart-thread-1').observation.latestExecution)
      .toEqual({
        executionId: 'opening-running-race',
        status: 'interrupted',
        startedAt: 1,
        finishedAt: 2
      })
  })

  it('surfaces a failed opening observation instead of hiding it behind open failure', async () => {
    const store = await stateStore(false)
    const openingFailure = new Error('open failed')
    const observationFailure = new Error('opening observation commit failed')
    const originalCommit = store.commit.bind(store)
    vi.spyOn(store, 'commit').mockImplementation(mutation => {
      if (mutation.type === 'replace-thread-session-state' &&
          mutation.observation.latestExecution?.status === 'running') {
        return Promise.reject(observationFailure)
      }
      return originalCommit(mutation)
    })

    const opening = HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async context => {
        const claim = context.executionClaims.claim()
        void commitTestObservation(context, {
          latestExecution: {
            executionId: claim.executionId,
            status: 'running',
            startedAt: 1
          },
          backgroundWork: null
        }).catch(() => undefined)
        throw openingFailure
      },
      createExecutionId: () => 'opening-observation-failure',
      now: () => 2,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    const error = await opening.catch(failure => failure)
    expect(error).toBeInstanceOf(HarnessThreadOpeningCleanupError)
    expect(error).toMatchObject({
      openingError: openingFailure,
      cleanupError: observationFailure
    })
  })

  it('surfaces terminal convergence failure after opening published running', async () => {
    const store = await stateStore(false)
    const openingFailure = new Error('open failed after running commit')
    const convergenceFailure = new Error('interrupted observation commit failed')
    const originalCommit = store.commit.bind(store)
    vi.spyOn(store, 'commit').mockImplementation(mutation => {
      if (mutation.type === 'replace-thread-session-state' &&
          mutation.observation.latestExecution?.status === 'interrupted') {
        return Promise.reject(convergenceFailure)
      }
      return originalCommit(mutation)
    })

    const opening = HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async context => {
        const claim = context.executionClaims.claim()
        await commitTestObservation(context, {
          latestExecution: {
            executionId: claim.executionId,
            status: 'running',
            startedAt: 1
          },
          backgroundWork: null
        })
        throw openingFailure
      },
      createExecutionId: () => 'opening-convergence-failure',
      now: () => 2,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    const error = await opening.catch(failure => failure)
    expect(error).toBeInstanceOf(HarnessThreadOpeningCleanupError)
    expect(error).toMatchObject({
      openingError: openingFailure,
      cleanupError: convergenceFailure
    })
    expect(readHarnessThread(store.read(), 'bart-thread-1').observation.latestExecution)
      .toMatchObject({
        executionId: 'opening-convergence-failure',
        status: 'running'
      })
  })

  it('cancels a same-tick queued send before native admission', async () => {
    const store = await stateStore(false)
    const nativeSend = vi.fn()
    const nativeInterrupt = vi.fn()
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async () => ({
        ...handle(nativeSend),
        interrupt: nativeInterrupt
      }),
      createExecutionId: () => 'same-tick-cancel-execution',
      now: () => 1,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    const send = instance.send(
      { parts: [{ kind: 'text', text: 'cancel before admission' }] },
      new AbortController().signal
    )
    const rejected = expect(send).rejects.toThrow('interrupted before native admission')
    await expect(instance.interrupt()).resolves.toBeUndefined()
    await rejected
    expect(nativeSend).not.toHaveBeenCalled()
    expect(nativeInterrupt).not.toHaveBeenCalled()
    expect(instance.execution).toBeNull()
    await instance.dispose()
  })

  it('aborts an entered send before running authority and fences a late running publication', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    let requestSignal!: AbortSignal
    let reportEntered!: () => void
    let releaseLateObservation!: () => void
    const entered = new Promise<void>(resolve => { reportEntered = resolve })
    const lateObservationGate = new Promise<void>(resolve => {
      releaseLateObservation = resolve
    })
    let lateObservation!: Promise<void>
    const nativeInterrupt = vi.fn()
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            requestSignal = request.signal
            reportEntered()
            const interrupted = await new Promise<unknown>(resolve => {
              if (request.signal.aborted) {
                resolve(request.signal.reason)
                return
              }
              request.signal.addEventListener(
                'abort',
                () => resolve(request.signal.reason),
                { once: true }
              )
            })
            lateObservation = lateObservationGate.then(() => commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: 1
              },
              backgroundWork: null
            }))
            void lateObservation.catch(() => undefined)
            throw interrupted
          }),
          interrupt: nativeInterrupt
        }
      },
      createExecutionId: () => 'entered-before-running',
      now: () => 2,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    const send = instance.send(
      { parts: [{ kind: 'text', text: 'cancel after Handle entry' }] },
      new AbortController().signal
    )
    await entered
    const stop = instance.interrupt(null)
    const duplicateStop = instance.interrupt(null)
    expect(duplicateStop).toBe(stop)
    await expect(stop).resolves.toBeUndefined()
    expect(requestSignal.aborted).toBe(true)
    await expect(send).rejects.toThrow('interrupted before native admission')
    expect(nativeInterrupt).not.toHaveBeenCalled()

    releaseLateObservation()
    await expect(lateObservation).rejects.toThrow('迟到 running')
    expect(instance.execution).toBeNull()
    expect(instance.observation.latestExecution).toBeNull()
    expect(readHarnessThread(store.read(), 'bart-thread-1').observation.latestExecution)
      .toBeNull()
    await instance.dispose()
  })

  it('binds null Stop to the exact entered send whose running publication is submitted', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    let reportCommit!: () => void
    let releaseCommit!: () => void
    const commitStarted = new Promise<void>(resolve => { reportCommit = resolve })
    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve })
    const originalCommit = store.commit.bind(store)
    vi.spyOn(store, 'commit').mockImplementation(mutation => {
      if (mutation.type === 'replace-thread-session-state' &&
          mutation.observation.latestExecution?.executionId === 'submitted-send-owner' &&
          mutation.observation.latestExecution.status === 'running') {
        reportCommit()
        return commitGate.then(() => originalCommit(mutation))
      }
      return originalCommit(mutation)
    })
    const nativeInterrupt = vi.fn(async () => {
      await commitTestObservation(context, {
        latestExecution: {
          executionId: 'submitted-send-owner',
          status: 'interrupted',
          startedAt: 1,
          finishedAt: 2
        },
        backgroundWork: null
      })
    })
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: 1
              },
              backgroundWork: null
            })
          }),
          interrupt: nativeInterrupt
        }
      },
      createExecutionId: () => 'submitted-send-owner',
      now: () => 2,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    const send = instance.send(
      { parts: [{ kind: 'text', text: 'publish while Stop snapshots null' }] },
      new AbortController().signal
    )
    await commitStarted
    const stop = instance.interrupt(null)
    expect(nativeInterrupt).not.toHaveBeenCalled()

    releaseCommit()
    await expect(send).rejects.toThrow('interrupted before native admission')
    await expect(stop).resolves.toBeUndefined()
    expect(nativeInterrupt).toHaveBeenCalledTimes(1)
    expect(instance.observation.latestExecution).toMatchObject({
      executionId: 'submitted-send-owner',
      status: 'interrupted'
    })
    await instance.dispose()
  })

  it('does not call native interrupt when exact send rejects after pre-native cleanup', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    let reportRunningReturned!: () => void
    const runningReturned = new Promise<void>(resolve => {
      reportRunningReturned = resolve
    })
    let cleanedBeforeNative = false
    let nativeReady = false
    const nativeInterrupt = vi.fn(async () => {
      if (!nativeReady) throw new Error('native handle is not installed yet')
    })
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: 1
              },
              backgroundWork: null
            })
            reportRunningReturned()
            const interruption = await new Promise<unknown>(resolve => {
              if (request.signal.aborted) {
                resolve(request.signal.reason)
                return
              }
              request.signal.addEventListener(
                'abort',
                () => resolve(request.signal.reason),
                { once: true }
              )
            })
            cleanedBeforeNative = true
            throw interruption
          }),
          interrupt: nativeInterrupt
        }
      },
      createExecutionId: () => 'native-install-race',
      now: () => 2,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    const send = instance.send(
      { parts: [{ kind: 'text', text: 'stop between running and native install' }] },
      new AbortController().signal
    )
    await runningReturned
    const stop = instance.interrupt(null)

    await expect(send).rejects.toThrow('interrupted before native admission')
    await expect(stop).resolves.toBeUndefined()
    expect(cleanedBeforeNative).toBe(true)
    expect(nativeReady).toBe(false)
    expect(nativeInterrupt).not.toHaveBeenCalled()
    expect(instance.observation.latestExecution).toMatchObject({
      executionId: 'native-install-race',
      status: 'interrupted'
    })
    await instance.dispose()
  })

  it('accepts a fulfilled exact send as cleanup when the Plugin already published terminal', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    let reportRunningReturned!: () => void
    const runningReturned = new Promise<void>(resolve => {
      reportRunningReturned = resolve
    })
    const nativeInterrupt = vi.fn()
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: 1
              },
              backgroundWork: null
            })
            reportRunningReturned()
            await new Promise<void>(resolve => {
              if (request.signal.aborted) {
                resolve()
                return
              }
              request.signal.addEventListener('abort', () => resolve(), { once: true })
            })
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'interrupted',
                startedAt: 1,
                finishedAt: 2
              },
              backgroundWork: null
            })
          }),
          interrupt: nativeInterrupt
        }
      },
      createExecutionId: () => 'plugin-cleanup-ack',
      now: () => 2,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    const send = instance.send(
      { parts: [{ kind: 'text', text: 'Plugin owns pre-native cleanup' }] },
      new AbortController().signal
    )
    await runningReturned
    const stop = instance.interrupt(null)

    await expect(send).rejects.toThrow('interrupted before native admission')
    await expect(stop).resolves.toBeUndefined()
    expect(nativeInterrupt).not.toHaveBeenCalled()
    expect(instance.observation.latestExecution).toMatchObject({
      executionId: 'plugin-cleanup-ack',
      status: 'interrupted'
    })
    await instance.dispose()
  })

  it('lets null Stop cancel only queued sends without interrupting a pending native claim', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const nativeSend = vi.fn()
    const nativeInterrupt = vi.fn()
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(nativeSend),
          interrupt: nativeInterrupt
        }
      },
      createExecutionId: () => 'pending-native-claim',
      now: () => 1,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    const nativeClaim = context.executionClaims.claim()
    const send = instance.send(
      { parts: [{ kind: 'text', text: 'cancel only this queued send' }] },
      new AbortController().signal
    )
    const rejected = expect(send).rejects.toThrow('interrupted before native admission')

    await expect(instance.interrupt(null)).resolves.toBeUndefined()
    await rejected
    expect(nativeSend).not.toHaveBeenCalled()
    expect(nativeInterrupt).not.toHaveBeenCalled()
    expect(() => context.executionClaims.claim()).toThrow('active 或 pending')

    nativeClaim.abandon()
    await instance.dispose()
  })

  it('does not retarget null Stop to an unsettled submitted successor observation', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const executionIds = ['submitted-predecessor', 'submitted-successor']
    const nativeInterrupt = vi.fn()
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: 1
              },
              backgroundWork: null
            })
          }),
          interrupt: nativeInterrupt
        }
      },
      createExecutionId: () => executionIds.shift()!,
      now: () => 3,
      signal: new AbortController().signal,
      committed: () => undefined
    })
    await instance.send(
      { parts: [{ kind: 'text', text: 'predecessor' }] },
      new AbortController().signal
    )
    await commitTestObservation(context, {
      latestExecution: {
        executionId: 'submitted-predecessor',
        status: 'completed',
        startedAt: 1,
        finishedAt: 2
      },
      backgroundWork: null
    })

    let reportCommit!: () => void
    let releaseCommit!: () => void
    const commitStarted = new Promise<void>(resolve => { reportCommit = resolve })
    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve })
    const originalCommit = store.commit.bind(store)
    vi.spyOn(store, 'commit').mockImplementation(mutation => {
      if (mutation.type === 'replace-thread-session-state' &&
          mutation.observation.latestExecution?.executionId === 'submitted-successor' &&
          mutation.observation.latestExecution.status === 'running') {
        reportCommit()
        return commitGate.then(() => originalCommit(mutation))
      }
      return originalCommit(mutation)
    })

    const successorClaim = context.executionClaims.claim()
    const successor = commitTestObservation(context, {
      latestExecution: {
        executionId: successorClaim.executionId,
        status: 'running',
        startedAt: 3
      },
      backgroundWork: null
    })
    await commitStarted
    const stop = instance.interrupt(null).then(
      () => undefined,
      () => undefined
    )
    expect(nativeInterrupt).not.toHaveBeenCalled()

    releaseCommit()
    await successor
    await stop
    expect(nativeInterrupt).not.toHaveBeenCalled()
    expect(instance.observation.latestExecution).toMatchObject({
      executionId: 'submitted-successor',
      status: 'running'
    })
    await instance.dispose()
  })

  it('coalesces an in-flight Stop and retries the same Execution after rejection', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const nativeFailure = new Error('native interrupt failed')
    let nativeAttempts = 0
    const nativeInterrupt = vi.fn(async () => {
      nativeAttempts += 1
      if (nativeAttempts === 1) throw nativeFailure
    })
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: 1
              },
              backgroundWork: null
            })
          }),
          interrupt: nativeInterrupt
        }
      },
      createExecutionId: () => 'single-native-interrupt',
      now: () => 2,
      signal: new AbortController().signal,
      committed: () => undefined
    })
    await instance.send(
      { parts: [{ kind: 'text', text: 'run' }] },
      new AbortController().signal
    )

    const first = instance.interrupt('single-native-interrupt')
    const concurrent = instance.interrupt('single-native-interrupt')
    expect(concurrent).toBe(first)
    await expect(first).rejects.toBe(nativeFailure)

    const retry = instance.interrupt('single-native-interrupt')
    expect(retry).not.toBe(first)
    await expect(retry).resolves.toBeUndefined()
    expect(nativeInterrupt).toHaveBeenCalledTimes(2)
    expect(instance.observation.latestExecution).toMatchObject({
      executionId: 'single-native-interrupt',
      status: 'interrupted'
    })
    await instance.dispose()
  })

  it('retries terminal convergence without repeating a successful native interrupt', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const convergenceFailure = new Error('interrupted observation commit failed once')
    let rejectConvergence = true
    const originalCommit = store.commit.bind(store)
    vi.spyOn(store, 'commit').mockImplementation(mutation => {
      if (rejectConvergence && mutation.type === 'replace-thread-session-state' &&
          mutation.observation.latestExecution?.executionId === 'retry-convergence-only' &&
          mutation.observation.latestExecution.status === 'interrupted') {
        rejectConvergence = false
        return Promise.reject(convergenceFailure)
      }
      return originalCommit(mutation)
    })
    const nativeInterrupt = vi.fn(async () => undefined)
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: 1
              },
              backgroundWork: null
            })
          }),
          interrupt: nativeInterrupt
        }
      },
      createExecutionId: () => 'retry-convergence-only',
      now: () => 2,
      signal: new AbortController().signal,
      committed: () => undefined
    })
    await instance.send(
      { parts: [{ kind: 'text', text: 'run' }] },
      new AbortController().signal
    )

    await expect(instance.interrupt('retry-convergence-only'))
      .rejects.toBe(convergenceFailure)
    expect(nativeInterrupt).toHaveBeenCalledTimes(1)
    expect(instance.observation.latestExecution).toMatchObject({ status: 'running' })

    await expect(instance.interrupt('retry-convergence-only')).resolves.toBeUndefined()
    expect(nativeInterrupt).toHaveBeenCalledTimes(1)
    expect(instance.observation.latestExecution).toMatchObject({ status: 'interrupted' })
    await instance.dispose()
  })

  it('calls Handle interrupt once when successful Stop races terminal publication', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    let terminalPublication!: Promise<void>
    const nativeInterrupt = vi.fn(async () => {
      terminalPublication = commitTestObservation(context, {
        latestExecution: {
          executionId: 'successful-stop-terminal-race',
          status: 'interrupted',
          startedAt: 1,
          finishedAt: 2
        },
        backgroundWork: null
      })
      void terminalPublication.catch(() => undefined)
    })
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: 1
              },
              backgroundWork: null
            })
          }),
          interrupt: nativeInterrupt
        }
      },
      createExecutionId: () => 'successful-stop-terminal-race',
      now: () => 2,
      signal: new AbortController().signal,
      committed: () => undefined
    })
    await instance.send(
      { parts: [{ kind: 'text', text: 'run' }] },
      new AbortController().signal
    )

    const stop = instance.interrupt('successful-stop-terminal-race')
    await expect(stop).resolves.toBeUndefined()
    await expect(terminalPublication).resolves.toBeUndefined()
    const duplicate = instance.interrupt('successful-stop-terminal-race')
    expect(duplicate).toBe(stop)
    await expect(duplicate).resolves.toBeUndefined()
    expect(nativeInterrupt).toHaveBeenCalledTimes(1)
    expect(instance.observation.latestExecution).toMatchObject({
      executionId: 'successful-stop-terminal-race',
      status: 'interrupted'
    })
    await instance.dispose()
  })

  it('cuts off pre-Stop sends and gates post-Stop sends behind the exact target', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    let reportRunning!: () => void
    let releaseFirstSend!: () => void
    let reportInterrupt!: () => void
    let releaseInterrupt!: () => void
    const running = new Promise<void>(resolve => { reportRunning = resolve })
    const firstSendGate = new Promise<void>(resolve => { releaseFirstSend = resolve })
    const interruptStarted = new Promise<void>(resolve => { reportInterrupt = resolve })
    const interruptGate = new Promise<void>(resolve => { releaseInterrupt = resolve })
    const nativeExecutionIds: string[] = []
    const executionIds = ['interrupt-target-a', 'interrupt-successor-b']
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            nativeExecutionIds.push(request.executionId)
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: nativeExecutionIds.length
              },
              backgroundWork: null
            })
            if (nativeExecutionIds.length === 1) {
              reportRunning()
              await firstSendGate
            }
          }),
          async interrupt() {
            reportInterrupt()
            await interruptGate
            const execution = context.thread.read().observation.latestExecution
            if (!execution || execution.status !== 'running') {
              throw new Error('Interrupt target was not running')
            }
            await commitTestObservation(context, {
              latestExecution: {
                executionId: execution.executionId,
                status: 'interrupted',
                startedAt: execution.startedAt,
                finishedAt: Math.max(3, execution.startedAt)
              },
              backgroundWork: null
            })
          }
        }
      },
      createExecutionId: () => executionIds.shift()!,
      now: () => 3,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    const first = instance.send(
      { parts: [{ kind: 'text', text: 'execution A' }] },
      new AbortController().signal
    )
    const firstRejected = expect(first).rejects.toThrow(
      'interrupted before native admission'
    )
    await running
    const beforeStop = instance.send(
      { parts: [{ kind: 'text', text: 'must be cut off' }] },
      new AbortController().signal
    )
    const beforeStopRejected = expect(beforeStop).rejects.toThrow(
      'interrupted before native admission'
    )
    const stop = instance.interrupt()
    const afterStop = instance.send(
      { parts: [{ kind: 'text', text: 'must wait and become B' }] },
      new AbortController().signal
    )

    releaseFirstSend()
    await firstRejected
    await beforeStopRejected
    await interruptStarted
    await Promise.resolve()
    expect(nativeExecutionIds).toEqual(['interrupt-target-a'])

    releaseInterrupt()
    await stop
    await expect(afterStop).resolves.toEqual({
      executionId: 'interrupt-successor-b',
      startedNewExecution: true
    })
    expect(nativeExecutionIds).toEqual([
      'interrupt-target-a',
      'interrupt-successor-b'
    ])
    await instance.dispose()
  })

  it('interrupts a native successor instead of joining its predecessor Stop', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    let reportSuccessorRunning!: () => void
    let releaseFirstInterrupt!: () => void
    const successorRunning = new Promise<void>(resolve => { reportSuccessorRunning = resolve })
    const firstInterruptGate = new Promise<void>(resolve => { releaseFirstInterrupt = resolve })
    const executionIds = ['native-stop-a', 'native-successor-b']
    let nativeInterrupts = 0
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: 1
              },
              backgroundWork: null
            })
          }),
          async interrupt() {
            nativeInterrupts += 1
            const execution = context.thread.read().observation.latestExecution
            if (!execution || execution.status === 'completed' ||
                execution.status === 'failed' || execution.status === 'interrupted') return
            await commitTestObservation(context, {
              latestExecution: {
                executionId: execution.executionId,
                status: 'interrupted',
                startedAt: execution.startedAt,
                finishedAt: nativeInterrupts + 1
              },
              backgroundWork: null
            })
            if (nativeInterrupts !== 1) return
            const successor = context.executionClaims.claim()
            await commitTestObservation(context, {
              latestExecution: {
                executionId: successor.executionId,
                status: 'running',
                startedAt: 3
              },
              backgroundWork: null
            })
            reportSuccessorRunning()
            await firstInterruptGate
          }
        }
      },
      createExecutionId: () => executionIds.shift()!,
      now: () => 4,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    await instance.send(
      { parts: [{ kind: 'text', text: 'execution A' }] },
      new AbortController().signal
    )
    const firstStop = instance.interrupt('native-stop-a')
    await successorRunning
    const successorStop = instance.interrupt('native-successor-b')
    await Promise.resolve()
    expect(nativeInterrupts).toBe(1)

    releaseFirstInterrupt()
    await expect(Promise.all([firstStop, successorStop])).resolves.toEqual([undefined, undefined])
    expect(nativeInterrupts).toBe(2)
    expect(instance.observation.latestExecution).toMatchObject({
      executionId: 'native-successor-b',
      status: 'interrupted'
    })
    await instance.dispose()
  })

  it('treats a stale execution-scoped Stop as a no-op after its successor starts', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    let nativeInterrupts = 0
    const executionIds = ['stale-stop-a', 'stale-stop-b']
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: request.executionId === 'stale-stop-a' ? 1 : 3
              },
              backgroundWork: null
            })
          }),
          async interrupt() {
            nativeInterrupts += 1
            const execution = context.thread.read().observation.latestExecution
            if (!execution || execution.status === 'completed' ||
                execution.status === 'failed' || execution.status === 'interrupted') return
            await commitTestObservation(context, {
              latestExecution: {
                executionId: execution.executionId,
                status: 'interrupted',
                startedAt: execution.startedAt,
                finishedAt: Math.max(2, execution.startedAt)
              },
              backgroundWork: null
            })
          }
        }
      },
      createExecutionId: () => executionIds.shift()!,
      now: () => 3,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    await instance.send(
      { parts: [{ kind: 'text', text: 'A' }] },
      new AbortController().signal
    )
    await instance.interrupt('stale-stop-a')
    await instance.send(
      { parts: [{ kind: 'text', text: 'B' }] },
      new AbortController().signal
    )
    await expect(instance.interrupt('stale-stop-a')).resolves.toBeUndefined()

    expect(nativeInterrupts).toBe(1)
    expect(instance.observation.latestExecution).toMatchObject({
      executionId: 'stale-stop-b',
      status: 'running'
    })
    await instance.dispose()
  })

  it('does not abort an entered unpublished successor for a stale execution-scoped Stop', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    let reportSuccessorEntered!: () => void
    let releaseSuccessor!: () => void
    const successorEntered = new Promise<void>(resolve => {
      reportSuccessorEntered = resolve
    })
    const successorGate = new Promise<void>(resolve => { releaseSuccessor = resolve })
    const executionIds = ['stale-unpublished-a', 'stale-unpublished-b']
    let successorSignal!: AbortSignal
    const nativeInterrupt = vi.fn()
    let sends = 0
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            sends += 1
            if (sends === 2) {
              successorSignal = request.signal
              reportSuccessorEntered()
              await successorGate
              request.signal.throwIfAborted()
            }
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: sends === 1 ? 1 : 3
              },
              backgroundWork: null
            })
          }),
          interrupt: nativeInterrupt
        }
      },
      createExecutionId: () => executionIds.shift()!,
      now: () => 3,
      signal: new AbortController().signal,
      committed: () => undefined
    })
    await instance.send(
      { parts: [{ kind: 'text', text: 'A' }] },
      new AbortController().signal
    )
    await commitTestObservation(context, {
      latestExecution: {
        executionId: 'stale-unpublished-a',
        status: 'completed',
        startedAt: 1,
        finishedAt: 2
      },
      backgroundWork: null
    })

    const successor = instance.send(
      { parts: [{ kind: 'text', text: 'B' }] },
      new AbortController().signal
    )
    await successorEntered
    await expect(instance.interrupt('stale-unpublished-a')).resolves.toBeUndefined()
    expect(successorSignal.aborted).toBe(false)
    expect(nativeInterrupt).not.toHaveBeenCalled()

    releaseSuccessor()
    await expect(successor).resolves.toEqual({
      executionId: 'stale-unpublished-b',
      startedNewExecution: true
    })
    expect(instance.observation.latestExecution).toMatchObject({
      executionId: 'stale-unpublished-b',
      status: 'running'
    })
    await instance.dispose()
  })

  it('binds Stop before awaiting an already-submitted terminal observation', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    let nativeInterrupts = 0
    const executionIds = ['terminal-barrier-a', 'terminal-barrier-b']
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: request.executionId === 'terminal-barrier-a' ? 1 : 3
              },
              backgroundWork: null
            })
          }),
          interrupt: async () => { nativeInterrupts += 1 }
        }
      },
      createExecutionId: () => executionIds.shift()!,
      now: () => 3,
      signal: new AbortController().signal,
      committed: () => undefined
    })
    await instance.send(
      { parts: [{ kind: 'text', text: 'A' }] },
      new AbortController().signal
    )

    let reportCommit!: () => void
    let releaseCommit!: () => void
    const commitStarted = new Promise<void>(resolve => { reportCommit = resolve })
    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve })
    const originalCommit = store.commit.bind(store)
    vi.spyOn(store, 'commit').mockImplementation(mutation => {
      if (mutation.type === 'replace-thread-session-state' &&
          mutation.observation.latestExecution?.status === 'completed') {
        reportCommit()
        return commitGate.then(() => originalCommit(mutation))
      }
      return originalCommit(mutation)
    })
    const terminal = commitTestObservation(context, {
      latestExecution: {
        executionId: 'terminal-barrier-a',
        status: 'completed',
        startedAt: 1,
        finishedAt: 2
      },
      backgroundWork: null
    })
    await commitStarted
    const stop = instance.interrupt('terminal-barrier-a')
    expect(nativeInterrupts).toBe(0)

    releaseCommit()
    await terminal
    await expect(stop).resolves.toBeUndefined()
    await instance.send(
      { parts: [{ kind: 'text', text: 'B' }] },
      new AbortController().signal
    )
    expect(nativeInterrupts).toBe(0)
    expect(instance.observation.latestExecution).toMatchObject({
      executionId: 'terminal-barrier-b',
      status: 'running'
    })
    await instance.dispose()
  })

  it('fails a running claim after admission rejection and admits the next send freshly', async () => {
    const store = await stateStore(false)
    const admissionError = new Error('admission persistence failed')
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    let sends = 0
    const nativeContinuations: string[] = []
    const executionIds = [
      'failed-persistence-execution',
      'recovered-persistence-execution'
    ]
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle(async request => {
          sends += 1
          await commitTestObservation(context, {
            latestExecution: {
              executionId: request.executionId,
              status: 'running',
              startedAt: sends
            },
            backgroundWork: sends === 1 ? { status: 'running' } : null
          })
          nativeContinuations.push(request.executionId)
        })
      },
      createExecutionId: () => executionIds.shift()!,
      now: () => 10,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    await expect(instance.send(
      { parts: [{ kind: 'text', text: 'persist' }] },
      new AbortController().signal,
      [],
      async () => { throw admissionError }
    )).rejects.toBe(admissionError)
    expect(instance.execution).toBeNull()
    expect(nativeContinuations).toEqual([])
    expect(readHarnessThread(store.read(), 'bart-thread-1').observation.latestExecution)
      .toMatchObject({
        executionId: 'failed-persistence-execution',
        status: 'failed',
        startedAt: 1,
        finishedAt: 10
      })
    expect(readHarnessThread(store.read(), 'bart-thread-1').observation.backgroundWork)
      .toEqual({ status: 'running' })

    let reportAdmission!: () => void
    let releaseAdmission!: () => void
    const admissionStarted = new Promise<void>(resolve => { reportAdmission = resolve })
    const admissionGate = new Promise<void>(resolve => { releaseAdmission = resolve })
    const second = instance.send(
      { parts: [{ kind: 'text', text: 'fresh execution' }] },
      new AbortController().signal,
      [],
      async result => {
        expect(result).toEqual({
          executionId: 'recovered-persistence-execution',
          startedNewExecution: true
        })
        reportAdmission()
        await admissionGate
      }
    )
    await admissionStarted
    expect(nativeContinuations).toEqual([])
    expect(instance.execution).toMatchObject({
      executionId: 'recovered-persistence-execution',
      status: 'running'
    })
    releaseAdmission()
    await expect(second).resolves.toEqual({
      executionId: 'recovered-persistence-execution',
      startedNewExecution: true
    })
    expect(nativeContinuations).toEqual(['recovered-persistence-execution'])
    await instance.dispose()
  })

  it('auto-archives an Agent Thread the runtime converges to failed after admission rejection', async () => {
    const store = await stateStore(true)
    const admissionError = new Error('admission persistence failed')
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'agent-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle(async request => {
          await commitTestObservation(context, {
            latestExecution: {
              executionId: request.executionId,
              status: 'running',
              startedAt: 1
            },
            backgroundWork: null
          })
        })
      },
      createExecutionId: () => 'converged-agent-failure',
      now: () => 10,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    await expect(instance.send(
      { parts: [{ kind: 'text', text: 'fail through the runtime' }] },
      new AbortController().signal,
      [],
      async () => { throw admissionError }
    )).rejects.toBe(admissionError)
    const archived = readAgentThread(store.read(), 'agent-thread-1')
    expect(archived).toMatchObject({ archived: true, title: 'Agent', tags: [] })
    expect(archived.observation.latestExecution).toMatchObject({
      executionId: 'converged-agent-failure',
      status: 'failed',
      startedAt: 1,
      finishedAt: 10
    })
    await instance.dispose()
  })

  it('does not overwrite a Plugin terminal published after admission rejection', async () => {
    const store = await stateStore(false)
    const admissionError = new Error('admission rejected after running')
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle(async request => {
          try {
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: 5
              },
              backgroundWork: { status: 'running' }
            })
          } catch (error) {
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'failed',
                startedAt: 5,
                finishedAt: 7,
                summary: 'Plugin-owned terminal summary'
              },
              backgroundWork: null
            })
            throw error
          }
        })
      },
      createExecutionId: () => 'plugin-terminal-admission-failure',
      now: () => 20,
      signal: new AbortController().signal,
      committed: () => undefined
    })

    await expect(instance.send(
      { parts: [{ kind: 'text', text: 'terminalize in Plugin' }] },
      new AbortController().signal,
      [],
      async () => { throw admissionError }
    )).rejects.toBe(admissionError)
    expect(instance.execution).toBeNull()
    expect(readHarnessThread(store.read(), 'bart-thread-1').observation)
      .toEqual({
        latestExecution: {
          executionId: 'plugin-terminal-admission-failure',
          status: 'failed',
          startedAt: 5,
          finishedAt: 7,
          summary: 'Plugin-owned terminal summary'
        },
        backgroundWork: null
      })
    await instance.dispose()
  })

  it('aggregates the original send error when failed convergence cannot commit', async () => {
    const store = await stateStore(false)
    const admissionError = new Error('admission rejected')
    const convergenceError = new Error('failed convergence commit rejected')
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle(async request => {
          await commitTestObservation(context, {
            latestExecution: {
              executionId: request.executionId,
              status: 'running',
              startedAt: 1
            },
            backgroundWork: null
          })
        })
      },
      createExecutionId: () => 'failed-convergence-execution',
      now: () => 2,
      signal: new AbortController().signal,
      committed: () => undefined
    })
    const originalCommit = store.commit.bind(store)
    vi.spyOn(store, 'commit').mockImplementation(mutation => {
      if (mutation.type === 'replace-thread-session-state' &&
          mutation.observation.latestExecution?.status === 'failed') {
        return Promise.reject(convergenceError)
      }
      return originalCommit(mutation)
    })

    const failure = await instance.send(
      { parts: [{ kind: 'text', text: 'cannot converge' }] },
      new AbortController().signal,
      [],
      async () => { throw admissionError }
    ).catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure).toMatchObject({
      errors: [admissionError, convergenceError]
    })
    expect(instance.execution).toMatchObject({
      executionId: 'failed-convergence-execution',
      status: 'running'
    })
    expect(readHarnessThread(store.read(), 'bart-thread-1').observation.latestExecution)
      .toMatchObject({ executionId: 'failed-convergence-execution', status: 'running' })
    await instance.dispose()
  })

  it('routes closed responses and canonicalizes public multi-select answers', async () => {
    const store = await stateStore(false)
    const primary = permissionInteraction('permission-one')
    const secondary = questionInteraction('question-two')
    const multiple = multipleQuestionInteraction('question-multiple')
    const responses: unknown[] = []
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return {
          ...handle(async request => {
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'running',
                startedAt: 1
              },
              backgroundWork: null
            })
            await commitTestObservation(context, {
              latestExecution: {
                executionId: request.executionId,
                status: 'waiting-for-user',
                startedAt: 1,
                interactions: [primary, secondary, multiple]
              },
              backgroundWork: null
            })
          }),
          respond: async response => { responses.push(structuredClone(response)) }
        }
      },
      createExecutionId: () => 'plural-interaction-execution',
      now: () => 1,
      signal: new AbortController().signal,
      committed: () => undefined
    })
    await instance.send(
      { parts: [{ kind: 'text', text: 'wait twice' }] },
      new AbortController().signal
    )

    await expect(instance.respond({
      interactionId: secondary.id,
      actionId: 'submit',
      answers: undefined
    } as unknown as Parameters<typeof instance.respond>[0]))
      .rejects.toThrow('response 必须是对象')
    expect(responses).toEqual([])
    await expect(instance.respond({
      interactionId: secondary.id,
      actionId: 'allow'
    })).rejects.toThrow('action 不可用')
    await instance.respond({
      interactionId: secondary.id,
      actionId: 'submit',
      answers: {}
    })
    await instance.respond({
      interactionId: secondary.id,
      actionId: 'submit',
      answers: { choice: 'b' }
    })
    await instance.respond({
      interactionId: multiple.id,
      actionId: 'submit',
      answers: { choices: ['b', 'a', 'b', 'a'] }
    })
    await expect(instance.respond({
      interactionId: primary.id,
      actionId: 'deny',
      message: 'x'.repeat(MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS + 1)
    })).rejects.toThrow('message 无效')
    await expect(instance.respond({
      interactionId: primary.id,
      actionId: 'deny',
      message: 'unsafe\0feedback'
    })).rejects.toThrow('message 无效')
    await expect(instance.respond({
      interactionId: primary.id,
      actionId: 'deny',
      legacyMessage: 'not current'
    } as unknown as Parameters<typeof instance.respond>[0]))
      .rejects.toThrow('未知字段')
    await instance.respond({
      interactionId: primary.id,
      actionId: 'deny',
      message: 'Use the read-only operation.'
    })
    await expect(instance.respond({
      interactionId: 'unknown-interaction',
      actionId: 'allow'
    })).rejects.toThrow('已处理或不存在')
    expect(responses).toEqual([
      {
        interactionId: secondary.id,
        actionId: 'submit',
        answers: {}
      },
      {
        interactionId: secondary.id,
        actionId: 'submit',
        answers: { choice: 'b' }
      },
      {
        interactionId: multiple.id,
        actionId: 'submit',
        answers: { choices: ['b', 'a'] }
      },
      {
        interactionId: primary.id,
        actionId: 'deny',
        message: 'Use the read-only operation.'
      }
    ])
    await instance.dispose()
  })

  it('honors a call-before-send waiting observation before classifying the send', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    let nativeSends = 0
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle(async request => {
          nativeSends += 1
          await commitTestObservation(context, {
            latestExecution: {
              executionId: request.executionId,
              status: 'running',
              startedAt: 1
            },
            backgroundWork: null
          })
        })
      },
      createExecutionId: () => 'waiting-boundary-execution',
      now: () => 1,
      signal: new AbortController().signal,
      committed: () => undefined
    })
    await instance.send(
      { parts: [{ kind: 'text', text: 'start' }] },
      new AbortController().signal
    )

    let reportCommit!: () => void
    let releaseCommit!: () => void
    const commitStarted = new Promise<void>(resolve => { reportCommit = resolve })
    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve })
    const originalCommit = store.commit.bind(store)
    vi.spyOn(store, 'commit').mockImplementation(mutation => {
      if (mutation.type === 'replace-thread-session-state' &&
          mutation.observation.latestExecution?.status === 'waiting-for-user') {
        reportCommit()
        return commitGate.then(() => originalCommit(mutation))
      }
      return originalCommit(mutation)
    })
    const waiting = commitTestObservation(context, {
      latestExecution: {
        executionId: 'waiting-boundary-execution',
        status: 'waiting-for-user',
        startedAt: 1,
        interactions: [permissionInteraction('waiting-boundary-interaction')]
      },
      backgroundWork: null
    })
    await commitStarted
    const send = instance.send(
      { parts: [{ kind: 'text', text: 'must not bypass waiting' }] },
      new AbortController().signal
    )
    const rejected = expect(send).rejects.toThrow('等待 interaction response')
    await Promise.resolve()
    expect(nativeSends).toBe(1)

    releaseCommit()
    await waiting
    await rejected
    expect(nativeSends).toBe(1)
    await instance.dispose()
  })

  it('uses the same public prompt boundary as persistence before accepting observations', async () => {
    const store = await stateStore(false)
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle(async request => {
          await commitTestObservation(context, {
            latestExecution: { executionId: request.executionId, status: 'running', startedAt: 1 },
            backgroundWork: null
          })
        })
      },
      createExecutionId: () => 'bounded-interaction',
      now: () => 1,
      signal: new AbortController().signal,
      committed: () => undefined
    })
    await instance.send({ parts: [{ kind: 'text', text: 'Schema' }] }, new AbortController().signal)
    const waiting = (prompt: string): ThreadPublicObservation => {
      const interaction = questionInteraction('schema-question')
      return {
        latestExecution: {
          executionId: 'bounded-interaction', status: 'waiting-for-user', startedAt: 1,
          interactions: [{
            ...interaction,
            questions: [{ ...interaction.questions[0], prompt }]
          }]
        },
        backgroundWork: null
      }
    }
    try {
      for (const invalid of [
        waiting('x'.repeat(MAX_PUBLIC_INTERACTION_PROMPT_CHARACTERS + 1)),
        waiting('invalid\0prompt'),
        waiting('  ')
      ]) {
        const revision = readHarnessThread(store.read(), 'bart-thread-1').revision
        expect(isThreadPublicObservation(invalid)).toBe(false)
        await expect(commitTestObservation(context, invalid)).rejects.toThrow('question')
        expect(readHarnessThread(store.read(), 'bart-thread-1').revision).toBe(revision)
      }
      const valid = waiting('x'.repeat(MAX_PUBLIC_INTERACTION_PROMPT_CHARACTERS))
      expect(isThreadPublicObservation(valid)).toBe(true)
      await expect(commitTestObservation(context, valid)).resolves.toBeUndefined()
      expect(readHarnessThread(store.read(), 'bart-thread-1').observation).toEqual(valid)
    } finally {
      await instance.dispose()
    }
  })

  it('rejects empty, duplicate, and terminal interaction projections', async () => {
    const store = await stateStore(false)
    const primary = permissionInteraction('primary-interaction')
    const secondary = questionInteraction('secondary-interaction')
    let context!: HarnessThreadOpenContext<'codex', { model: string }>
    const instance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async value => {
        context = value
        return handle(async request => {
          await commitTestObservation(context, {
            latestExecution: {
              executionId: request.executionId,
              status: 'running',
              startedAt: 1
            },
            backgroundWork: null
          })
        })
      },
      createExecutionId: () => 'invalid-plural-execution',
      now: () => 1,
      signal: new AbortController().signal,
      committed: () => undefined
    })
    await instance.send(
      { parts: [{ kind: 'text', text: 'validate plural' }] },
      new AbortController().signal
    )
    const waiting = (interactions: readonly PublicInteraction[]): ThreadPublicObservation => ({
      latestExecution: {
        executionId: 'invalid-plural-execution',
        status: 'waiting-for-user',
        startedAt: 1,
        interactions
      },
      backgroundWork: null
    })

    await expect(commitTestObservation(context, waiting([]))).rejects.toThrow('非空数组')
    await expect(commitTestObservation(context, waiting([primary, structuredClone(primary)])))
      .rejects.toThrow('ID 重复')
    await expect(commitTestObservation(context, {
      latestExecution: {
        ...waiting([primary, secondary]).latestExecution,
        finishedAt: 2
      },
      backgroundWork: null
    } as ThreadPublicObservation)).rejects.toThrow('terminal 字段')
    await expect(commitTestObservation(context, {
      latestExecution: {
        executionId: 'invalid-plural-execution',
        status: 'completed',
        startedAt: 1,
        finishedAt: 2,
        interactions: [primary]
      },
      backgroundWork: null
    } as unknown as ThreadPublicObservation)).rejects.toThrow('terminal execution 字段')
    const projection = (interaction: unknown): ThreadPublicObservation => ({
      latestExecution: {
        executionId: 'invalid-plural-execution',
        status: 'waiting-for-user',
        startedAt: 1,
        interactions: [interaction as PublicInteraction]
      },
      backgroundWork: null
    })
    await expect(commitTestObservation(context, projection({
      ...primary,
      nativePayload: { secret: true }
    }))).rejects.toThrow('interaction 包含未知字段')
    await expect(commitTestObservation(context, projection({
      ...primary,
      actions: [{ ...primary.actions[0], nativeAction: true }, primary.actions[1]]
    }))).rejects.toThrow('action 包含未知字段')
    await expect(commitTestObservation(context, projection({
      ...secondary,
      questions: [{ ...secondary.questions[0], nativeQuestion: true }]
    }))).rejects.toThrow('question 包含未知字段')
    await expect(commitTestObservation(context, projection({
      ...secondary,
      questions: [{
        ...secondary.questions[0],
        options: [{ ...secondary.questions[0].options[0], nativeOption: true }]
      }]
    }))).rejects.toThrow('option 包含未知字段')
    const revisionBeforeStrictJsonRejections = readHarnessThread(
      store.read(),
      'bart-thread-1'
    ).revision
    await expect(commitTestObservation(context, {
      latestExecution: {
        executionId: 'invalid-plural-execution',
        status: 'running',
        startedAt: 1,
        summary: undefined
      },
      backgroundWork: null
    } as unknown as ThreadPublicObservation)).rejects.toThrow('sessionState')
    await expect(commitTestObservation(context, {
      latestExecution: {
        executionId: 'invalid-plural-execution',
        status: 'failed',
        startedAt: 1,
        finishedAt: 2,
        error: undefined
      },
      backgroundWork: null
    } as unknown as ThreadPublicObservation)).rejects.toThrow('sessionState')
    await expect(commitTestObservation(context, projection({
      ...primary,
      description: undefined
    }))).rejects.toThrow('sessionState')
    await expect(commitTestObservation(context, projection({
      ...secondary,
      questions: [{ ...secondary.questions[0], header: undefined }]
    }))).rejects.toThrow('sessionState')
    await expect(commitTestObservation(context, projection({
      ...secondary,
      questions: [{
        ...secondary.questions[0],
        options: [{ ...secondary.questions[0].options[0], description: undefined }]
      }]
    }))).rejects.toThrow('sessionState')
    expect(instance.observation.latestExecution).toMatchObject({ status: 'running' })
    expect(readHarnessThread(store.read(), 'bart-thread-1').revision)
      .toBe(revisionBeforeStrictJsonRejections)
    await instance.dispose()
  })

  it('fences late callbacks with the replaced Bart Thread id', async () => {
    const store = await stateStore(false)
    let oldContext!: HarnessThreadOpenContext<'codex', { model: string }>
    const oldInstance = await HarnessThreadInstance.open<'codex', { model: string }>({
      store,
      threadId: 'bart-thread-1',
      harnessId: 'codex',
      sessionStateAdapter: testSessionState,
      openThread: async context => {
        oldContext = context
        return handle()
      },
      createExecutionId: () => 'execution-old',
      now: () => 1,
      signal: new AbortController().signal,
      committed: () => undefined
    })
    const settings = store.read().settings
    await store.commit({
      type: 'replace-bart-thread',
      expectedThreadId: 'bart-thread-1',
      threadId: 'bart-thread-2',
      hostHarnessId: 'codex',
      settings,
      threadSettings: { model: 'gpt-5' },
      cwd: '/workspace/.bart',
      createdAt: 5
    })

    await expect(oldContext.sessionState.commit({ late: true }))
      .rejects.toThrow('Thread 不存在')
    expect(readHarnessThread(store.read(), 'bart-thread-2').sessionState).toBeNull()
    await oldInstance.dispose().catch(() => undefined)
  })
})

interface VersionedSessionFixture {
  version: string
  executions: PublicExecution[]
  tasks: Array<{ executionId: string; status: 'running' | 'completed' }>
}

/** An independently projected test Plugin schema, with Session-wide background facts. */
const versionedSessionState: HarnessSessionStateAdapter = {
  resolveExecution(state, executionId) {
    const session = state as unknown as VersionedSessionFixture | null
    return session?.executions.find(execution => execution.executionId === executionId) ?? null
  },
  project(state) {
    const session = state as unknown as VersionedSessionFixture | null
    const latest = session?.executions.at(-1)
    return {
      latestExecution: latest ? { ...structuredClone(latest), summary: session!.version } : null,
      backgroundWork: session?.tasks.some(task => task.status === 'running')
        ? { status: 'running' }
        : null
    }
  },
  settle({ sessionState, executionId, outcome, finishedAt }) {
    const state = structuredClone(sessionState) as unknown as VersionedSessionFixture
    state.executions = state.executions.map(execution => {
      if (execution.executionId !== executionId ||
        execution.status === 'completed' || execution.status === 'failed' ||
        execution.status === 'interrupted') return execution
      return { executionId, status: outcome, startedAt: execution.startedAt, finishedAt: Math.max(finishedAt, execution.startedAt) }
    })
    return state as unknown as JsonValue
  }
}

function handle(
  send: HarnessThreadHandle['send'] = async () => undefined
): HarnessThreadHandle {
  return {
    send,
    interrupt: async () => undefined,
    respond: async () => undefined,
    read: async question => question,
    dispose: async () => undefined
  }
}

function permissionInteraction(id: string): PublicInteraction {
  return {
    id,
    kind: 'permission',
    title: 'Permission',
    actions: [
      { id: 'allow', intent: 'allow', label: 'Allow' },
      { id: 'deny', intent: 'deny', label: 'Deny' }
    ],
    questions: []
  }
}

function questionInteraction(id: string): PublicInteraction {
  return {
    id,
    kind: 'question',
    title: 'Question',
    actions: [
      { id: 'submit', intent: 'submit', label: 'Submit' },
      { id: 'cancel', intent: 'cancel', label: 'Cancel' }
    ],
    questions: [{
      id: 'choice',
      prompt: 'Choose',
      multiple: false,
      allowOther: false,
      secret: false,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' }
      ]
    }]
  }
}

function multipleQuestionInteraction(id: string): PublicInteraction {
  return {
    id,
    kind: 'question',
    title: 'Multiple question',
    actions: [
      { id: 'submit', intent: 'submit', label: 'Submit' },
      { id: 'cancel', intent: 'cancel', label: 'Cancel' }
    ],
    questions: [{
      id: 'choices',
      prompt: 'Choose several',
      multiple: true,
      allowOther: false,
      secret: false,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' }
      ]
    }]
  }
}

async function stateStore(
  includeAgent: boolean,
  options: ThreadStateStoreOptions = {}
): Promise<ThreadStateStore> {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-runtime-'))
  directories.push(directory)
  const store = new ThreadStateStore(directory, options)
  stores.push(store)
  let state = createOpenAgentState({
    bartThreadId: 'bart-thread-1',
    hostHarnessId: 'codex',
    bartThreadSettings: { model: 'gpt-5' },
    bartCwd: '/workspace/.bart',
    createdAt: 1,
    selectedThreadId: 'bart-thread-1',
    settings: createDefaultOpenAgentSettings()
  })
  if (includeAgent) {
    state = reduceOpenAgentState(state, {
      type: 'add-agent-thread',
      thread: agentThread()
    })
  }
  await store.save(state)
  return store
}

function agentThread(): AgentThreadRecord<'codex', { model: string }> {
  return {
    id: 'agent-thread-1', harnessId: 'codex', archived: false, revision: 0, sessionState: null,
    observation: { latestExecution: null, backgroundWork: null }, title: 'Agent',
    tags: [], cwd: '/workspace', settings: { model: 'gpt-5' },
    createdAt: 1, updatedAt: 1
  }
}
