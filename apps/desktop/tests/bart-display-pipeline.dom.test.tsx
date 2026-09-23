// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentThreadRecord } from '@openagent/contracts'
import { createAgentOpenContext } from '@openagent/test-kit'
import { openCodexThread } from '../../../packages/harness-codex/src/main/thread/thread-handle'
import type { CodexAppServer } from '../../../packages/harness-codex/src/main/runtime/app-server'
import type { CodexRuntime } from '../../../packages/harness-codex/src/main/runtime'
import type { CodexNativeEvent, CodexThreadSettings } from '../../../packages/harness-codex/src/shared/types'
import { codexSessionState } from '../../../packages/harness-codex/src/shared/session-state'
import { RendererStatePublisher } from '../src/main/services/renderer-state-publisher'
import { applyRendererStateStoreMutation, hydrateRendererStateStore, rendererAppState } from '../src/shared/renderer-store'
import { mergeRendererStateMutations } from '../src/shared/renderer-state-patch'
import type { RendererStateMutation } from '../src/shared/renderer-state-contracts'
import { createBartReplyFixture } from './fixtures/bart-reply'
import { createBartComposerStore } from '../src/renderer/src/bart-composer-store'

const disposals: (() => void | Promise<void>)[] = []
afterEach(async () => {
  cleanup()
  for (const dispose of disposals.splice(0).reverse()) await dispose()
  vi.useRealTimers()
})

async function pipeline() {
  vi.useFakeTimers()
  const f = createBartReplyFixture()
  const initial = rendererAppState(f.store.getState())
  const old = initial.threads[0]!
  let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
    id: old.id, harnessId: 'codex', revision: old.revision, title: old.title, tags: [], cwd: '/tmp', settings: {},
    sessionState: old.sessionState, observation: old.observation, createdAt: old.createdAt, updatedAt: old.updatedAt, archived: false
  }
  const snapshot = () => ({ ...initial, reports: [], threads: [{ ...record, archived: undefined, bart: true as const, transcript: [] }] })
  const publisher = new RendererStatePublisher({ read: snapshot, execution: () => undefined, defaultCwd: '' }, error => { throw error })
  publisher.initialize()
  hydrateRendererStateStore(f.store, publisher.snapshot())
  let batch: RendererStateMutation[] | undefined
  const unsubscribe = publisher.subscribe(mutation => {
    if (batch) batch.push(mutation)
    else applyRendererStateStoreMutation(f.store, mutation)
  })
  disposals.push(() => { unsubscribe(); publisher.close() })
  let emit!: (event: CodexNativeEvent) => void
  const server = {
    subscribeNativeActivity: () => () => {},
    startTurn: async (options: { emit: typeof emit }) => {
      emit = options.emit
      emit({ type: 'session', sessionId: 'native-bart-display' })
      return { sessionId: 'native-bart-display', steer: async () => {}, cancel: async () => emit({ type: 'done', outcome: 'interrupted' }) }
    }, dispose: async () => {}
  } as unknown as CodexAppServer
  const runtime = { context: {}, server: async () => ({ server }) } as unknown as CodexRuntime
  const handle = await openCodexThread(runtime, {
    ...createAgentOpenContext({
      sessionState: codexSessionState, getRecord: () => record,
      setRecord: next => {
        const changed = JSON.stringify(record.observation) !== JSON.stringify(next.observation)
        record = next
        publisher.threadCommitted({ record, observation: record.observation, observationChanged: changed })
      }
    }),
    bartDisplay: { publish: activity => publisher.bartActivity({ threadId: record.id, harnessId: 'codex', activity }) }
  })
  disposals.push(() => handle.dispose())
  const view = render(f.element())
  await act(() => handle.send({ executionId: 'display-run', input: { parts: [{ kind: 'text', text: 'Run' }] }, signal: new AbortController().signal }))
  return {
    view, f, emit: (event: CodexNativeEvent) => emit(event), record: () => record,
    advance: (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms)),
    role: () => view.container.querySelector('.bart-dock')?.getAttribute('data-role'),
    text: () => view.container.querySelector('.bart-role-arc textPath')?.textContent,
    name: () => view.container.querySelector('.bart-role-tool-name')?.textContent,
    startBatch: () => { batch = [] },
    flushBatch: () => {
      const pending = batch ?? []
      batch = undefined
      if (pending.length) act(() => applyRendererStateStoreMutation(f.store, pending.reduce(mergeRendererStateMutations)))
    }
  }
}

it('preserves native semantic order through Harness batching, main publication and React batching while storage advances', async () => {
  const p = await pipeline()
  p.startBatch()
  p.emit({ type: 'reasoning-delta', delta: 'First thought' })
  p.emit({ type: 'text-delta', itemId: 'intermediate', delta: 'Working' })
  p.emit({ type: 'reasoning-delta', delta: 'Second thought' })
  await p.advance(50) // All three native deltas share one durable commit.
  await p.advance(50) // Main combines detail publication, preserving display events.
  p.emit({ type: 'activity-start', activity: { id: 'call', kind: 'tool', toolName: 'read_file', label: 'Read', status: 'running' } })
  p.emit({ type: 'done', outcome: 'completed' })
  await p.advance(0)
  expect(p.record().observation.latestExecution?.status).toBe('completed')
  p.flushBatch() // Two IPC patches can arrive in one renderer task.
  expect(p.f.store.getState().threadsById[p.record().id].observation.latestExecution?.status).toBe('completed')
  expect(p.role()).toBe('reasoning')
  expect(p.text()).toBe('First thought')
  await p.advance(799)
  expect(p.role()).toBe('reasoning')
  await p.advance(1)
  expect(p.role()).toBe('running')
  await p.advance(800)
  expect(p.text()).toBe('Second thought')
  await p.advance(800)
  expect(p.name()).toBe('read_file')
  await p.advance(800)
  expect(p.role()).toBe('idle')
})

it('accepts every synchronous store transition even if React has not rendered in between', () => {
  vi.useFakeTimers()
  const f = createBartReplyFixture()
  const view = render(f.element())
  act(() => f.startTurn('batched'))
  act(() => {
    f.acceptEvent('batched', { type: 'reasoning-delta', delta: 'one' })
    f.acceptEvent('batched', { type: 'activity-start', activity: { id: 'c', kind: 'tool', toolName: 'read_file', label: 'Read', status: 'running' } })
    f.acceptEvent('batched', { type: 'reasoning-delta', delta: 'two' })
  })
  expect(view.container.querySelector('.bart-role-arc textPath')?.textContent).toBe('one')
  act(() => vi.advanceTimersByTime(2000))
  expect(view.container.querySelector('.bart-role-tool-name')?.textContent).toBe('read_file')
  act(() => vi.advanceTimersByTime(2000))
  expect(view.container.querySelector('.bart-role-arc textPath')?.textContent).toBe('two')
})

it('shortens the subscribed Dock interval only once the completed session is also no longer submitting', () => {
  vi.useFakeTimers()
  const f = createBartReplyFixture()
  const composer = createBartComposerStore()
  const view = render(f.element({ composer }))
  const role = () => view.container.querySelector('.bart-dock')?.getAttribute('data-role')
  act(() => {
    f.startTurn('idle-cadence')
    f.acceptEvent('idle-cadence', { type: 'reasoning-delta', delta: 'thought' })
    f.acceptEvent('idle-cadence', { type: 'activity-start', activity: { id: 'read', kind: 'tool', toolName: 'read_file', label: 'Read', status: 'running' } })
    composer.setState({ submitting: true })
  })
  act(() => vi.advanceTimersByTime(100))
  act(() => f.finishTurn('idle-cadence', 'Answer is already stored.'))
  act(() => vi.advanceTimersByTime(900))
  expect(role()).toBe('reasoning')
  act(() => composer.setState({ submitting: false }))
  act(() => vi.advanceTimersByTime(0))
  expect(view.container.querySelector('.bart-role-tool-name')?.textContent).toBe('read_file')
  act(() => vi.advanceTimersByTime(799))
  expect(role()).toBe('tool')
  act(() => vi.advanceTimersByTime(1))
  expect(role()).toBe('idle')
})

it('catches up across dedicated ownership even when it starts and finishes inside a batch', async () => {
  const p = await pipeline()
  p.emit({ type: 'reasoning-delta', delta: 'old visible thought' })
  await p.advance(100)
  expect(p.text()).toBe('old visible thought')
  p.startBatch()
  p.emit({ type: 'text-delta', itemId: 'old-message', delta: 'old pending text' })
  p.emit({ type: 'activity-start', activity: { id: 'dedicated', kind: 'tool', toolName: 'thread_list', label: 'List', status: 'running' } })
  p.emit({ type: 'activity-end', activityId: 'dedicated', status: 'completed' })
  p.emit({ type: 'reasoning-delta', delta: 'latest thought' })
  p.emit({ type: 'done', outcome: 'completed' })
  await p.advance(0)
  p.flushBatch()
  expect(p.text()).toBe('latest thought')
  await p.advance(799)
  expect(p.role()).toBe('reasoning')
  await p.advance(1)
  expect(p.role()).toBe('idle')
})

it('discards a completed backlog on input takeover and restores the current idle state', async () => {
  const p = await pipeline()
  p.emit({ type: 'reasoning-delta', delta: 'thinking' })
  p.emit({ type: 'text-delta', itemId: 'answer', delta: 'done' })
  p.emit({ type: 'done', outcome: 'completed' })
  await p.advance(0)
  expect(p.role()).toBe('reasoning')
  p.view.rerender(p.f.element({ inputOpen: true }))
  p.view.rerender(p.f.element({ inputOpen: false }))
  expect(p.role()).toBe('idle')
  await p.advance(5000)
  expect(p.role()).toBe('idle')
})
