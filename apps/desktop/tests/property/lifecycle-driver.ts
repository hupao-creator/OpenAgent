import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentThreadRecord, HarnessThreadHandle, HarnessThreadOpenContext, ThreadPublicObservation } from '@openagent/contracts'
import { HarnessThreadInstance } from '../../src/main/harness-thread-runtime'
import { ThreadStateStore } from '../../src/main/services/thread-state-store'
import { ThreadLifecycleService } from '../../src/main/use-cases/thread-lifecycle-service'
import { createDefaultOpenAgentSettings } from '../../src/shared/openagent-settings'
import { createOpenAgentState, readHarnessThread, reduceOpenAgentState } from '../../src/shared/openagent-state'
import { commitTestObservation, testSessionState } from '@openagent/test-kit'

export const input = { parts: [{ kind: 'text' as const, text: 'property input' }] }
export const signal = (): AbortSignal => new AbortController().signal
export const permission = (id: string) => ({ id, kind: 'permission' as const, title: 'Permit',
  actions: [{ id: 'allow', intent: 'allow' as const, label: 'Allow' }], questions: [] })

/** Test-owned native boundary. Only this fixture interprets its own sessionState. */
export async function lifecycleDriver() {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-m2-'))
  const store = new ThreadStateStore(directory)
  let instance: HarnessThreadInstance<'codex'>
  let context: HarnessThreadOpenContext
  let counter = 0
  const io = { sends: [] as string[], stops: [] as string[], responses: [] as string[], disposed: 0, admissions: 0 }
  let admission: () => Promise<void> = async () => undefined
  const observation = () => readHarnessThread(store.read(), 'agent').observation
  const publish = (next: ThreadPublicObservation) => commitTestObservation(context, next)
  const options = () => ({ store, threadId: 'agent', harnessId: 'codex' as const,
    sessionStateAdapter: testSessionState, createExecutionId: () => `execution-${++counter}`,
    now: () => 100, signal: signal(), committed: () => undefined,
    admitNativeExecution: async () => { io.admissions++; await admission() } })
  const open = async () => {
    instance = await HarnessThreadInstance.open({ ...options(), openThread: async value => {
      context = value
      const handle: HarnessThreadHandle = {
        send: async request => {
          request.signal.throwIfAborted()
          if (observation().latestExecution?.executionId !== request.executionId) {
            await publish({ ...observation(), latestExecution: {
              executionId: request.executionId, status: 'running', startedAt: 1
            } })
          }
          io.sends.push(request.executionId)
        },
        interrupt: async () => {
          io.stops.push(observation().latestExecution!.executionId)
        },
        respond: async request => {
          io.responses.push(request.interactionId)
          const current = observation().latestExecution!
          await publish({ ...observation(), latestExecution: {
            executionId: current.executionId, status: 'running', startedAt: current.startedAt
          } })
        },
        read: async question => question,
        dispose: async () => { io.disposed++ }
      }
      return handle
    } })
    return instance
  }
  try {
    const base = createOpenAgentState({ bartThreadId: 'bart', hostHarnessId: 'codex',
      bartThreadSettings: {}, bartCwd: directory, createdAt: 1, selectedThreadId: null,
      settings: createDefaultOpenAgentSettings() })
    await store.save(reduceOpenAgentState(base, { type: 'add-agent-thread', thread: {
      id: 'agent', harnessId: 'codex', revision: 0, sessionState: null,
      observation: { latestExecution: null, backgroundWork: null }, title: 'Property', tags: [],
      cwd: directory, settings: {}, createdAt: 1, updatedAt: 1, archived: false
    } }))
    await open()
  } catch (error) { await store.close(); await rm(directory, { recursive: true, force: true }); throw error }
  const service = new ThreadLifecycleService({
    read: () => readHarnessThread(store.read(), 'agent') as AgentThreadRecord,
    delete: async () => { throw new Error('deletion outside this driver') }
  }, {
    run: async (_id, operation) => operation(), open: async () => instance,
    peek: () => instance, forget: () => undefined, cancelPending: () => undefined,
    interrupt: async (_id, _signal, _cancel, expectedId) => instance.interrupt(expectedId),
    admit: async () => undefined, releaseWorkspace: async () => undefined
  })
  return {
    store, io, service, observation, publish, open,
    get instance() { return instance }, get context() { return context },
    archived: () => (readHarnessThread(store.read(), 'agent') as AgentThreadRecord).archived,
    /** Core archive authority is a command on the store, not a runtime call. */
    unarchive: () => store.commit({ type: 'set-agent-thread-archived', threadId: 'agent', archived: false }),
    setAdmission(next: () => Promise<void>) { admission = next },
    async close() {
      try { await instance.dispose() }
      finally { try { await store.close() } finally { await rm(directory, { recursive: true, force: true }) } }
    }
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
