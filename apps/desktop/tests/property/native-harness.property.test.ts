import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import fc from 'fast-check'
import { expect, it, vi } from 'vitest'
import { parseThreadPublicObservation, type AgentThreadRecord, type HarnessPluginHostContext, type HarnessSessionStateAdapter, type HarnessThreadHandle } from '@openagent/contracts'
import { createClaudeMainPlugin } from '../../../../packages/harness-claude/src/main'
import { openPiThread } from '../../../../packages/harness-pi/src/main/thread/handle'
import type { PiRpc } from '../../../../packages/harness-pi/src/main/runtime/rpc'
import { piSessionAdapter } from '../../../../packages/harness-pi/src/shared/state'
import type { PiThreadSettings } from '../../../../packages/harness-pi/src/shared/types'
import { createAgentOpenContext, type TestAgentChange } from '@openagent/test-kit'
import { checkAsync } from './check'

// The Pi Handle family drives the real Handle against an in-process process double.
const piRpcMock = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock('../../../../packages/harness-pi/src/main/runtime/rpc', () => ({ startPiRpc: piRpcMock.start }))

type PiNativeDouble = PiRpc & {
  emit(event: Record<string, unknown>): void
  fail(error: Error): void
  requests: Record<string, unknown>[]
  disposeCalls: number
}
const piNatives: PiNativeDouble[] = []

const nativeBudget = process.env.FC_EXPLORE ? 120_000 : 30_000
const nativeTimeout = process.env.FC_EXPLORE ? 130_000 : 35_000
const scenario = fc.record({
  id: fc.integer({ min: 0, max: 9999 }).map(n => `execution-${n}`),
  chunks: fc.array(fc.constantFrom('hello', ' world', '\n', '中文', '🙂'), { minLength: 1, maxLength: 8 }),
  stop: fc.boolean(),
  disposals: fc.integer({ min: 1, max: 4 })
})

function capture<Id extends 'codex' | 'claude' | 'pi', Settings>(id: Id, cwd: string, adapter: HarnessSessionStateAdapter, settings: Settings) {
  let record: AgentThreadRecord<Id, Settings> = { id: `property-${id}`, harnessId: id, archived: false, revision: 0,
    title: 'Native property', tags: [], cwd, settings, sessionState: null,
    observation: { latestExecution: null, backgroundWork: null }, createdAt: 1, updatedAt: 1 }
  const changes: TestAgentChange[] = []
  const context = createAgentOpenContext({ sessionState: adapter, getRecord: () => record,
    setRecord: next => { record = next }, changes })
  return { context, changes, read: () => record }
}

// `summary` has three states: omitted leaves the projection's summary unchecked (used by
// the families whose terminal path does not project one), `null` requires its absence and a
// string requires that exact value — so an expected-absent summary is asserted, not skipped.
function assertTerminal(captured: { read: () => AgentThreadRecord; changes: TestAgentChange[] }, adapter: HarnessSessionStateAdapter,
  id: string, outcome: 'completed' | 'failed' | 'interrupted', summary?: string | null) {
  const record = captured.read()
  expect(record.observation.latestExecution).toMatchObject({ executionId: id, status: outcome })
  if (summary !== undefined) expect(record.observation.latestExecution?.summary ?? null).toBe(summary)
  expect(captured.changes.flatMap(change => change.lifecycle ? [change.lifecycle] : [])).toEqual([
    { type: 'started', executionId: id }, { type: 'terminal', executionId: id, outcome }
  ])
  for (const change of captured.changes) {
    expect(parseThreadPublicObservation(change.observation)).toEqual(change.observation)
    expect(adapter.project(JSON.parse(JSON.stringify(change.state)))).toEqual(change.observation)
  }
  expect(adapter.resolveExecution(record.sessionState, id)).toEqual(record.observation.latestExecution)
  expect(adapter.resolveExecution(record.sessionState, 'unknown-execution')).toBeNull()
}

it('native Claude public Handle and projection contract', async () => {
  await checkAsync('native Claude public Handle and projection contract', fc.asyncProperty(scenario, async value => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-property-'))
    const executable = resolve('tests/property/native-claude-fixture.cjs')
    await chmod(executable, 0o755)
    const plugin = createClaudeMainPlugin({ resolveExecutable: async () => executable,
      environment: async () => ({ ...process.env, NATIVE_PROPERTY_SCENARIO: JSON.stringify({ chunks: value.chunks, failed: value.stop, background: value.disposals > 1 }) }) })
    const captured = capture('claude', directory, plugin.sessionState, { executablePath: executable })
    let handle: HarnessThreadHandle | undefined
    try {
      handle = await plugin.openThread(captured.context)
      await handle.send({ executionId: value.id, input: { parts: [{ kind: 'text', text: 'Run fixture' }] },
        signal: new AbortController().signal })
      const outcome = value.stop ? 'failed' : 'completed'
      await vi.waitFor(() => expect(captured.read().observation.latestExecution?.status).toBe(outcome), { interval: 5 })
      assertTerminal(captured, plugin.sessionState, value.id, outcome, value.chunks.join('') || null)
      expect(captured.read().observation.backgroundWork).toEqual(value.disposals > 1 ? { status: 'running' } : null)
      const before = structuredClone(captured.read())
      await Promise.all(Array.from({ length: value.disposals }, () => handle!.dispose()))
      await expect(handle.send({ executionId: 'after-dispose', input: { parts: [{ kind: 'text', text: 'late' }] },
        signal: new AbortController().signal })).rejects.toThrow()
      const settled = structuredClone(captured.read())
      if (value.disposals > 1) {
        // Disposal ends the native session, so background work the CLI never reported
        // terminal is released with it instead of staying `running` forever. That is
        // the one write disposal may make, and it leaves the Execution it belongs to
        // and everything else in the record alone.
        expect(settled.observation).toEqual({ ...before.observation, backgroundWork: null })
        expect(settled.sessionState).toMatchObject({ runtime: { backgroundTasks: [{ id: 'background-property', status: 'failed' }] } })
        expect(settled.revision).toBe(before.revision + 1)
      } else {
        expect(settled).toEqual(before)
      }
      // Disposal is idempotent: a second round leaves the final record alone.
      await handle!.dispose()
      expect(captured.read()).toEqual(settled)
    } finally { await handle?.dispose(); await rm(directory, { recursive: true, force: true }) }
  }), 'open → send → stream-json chunks in generated order → optional background snapshot → native result → await terminal → repeated dispose → release of background work the session died with → rejected send', nativeBudget)
}, nativeTimeout)

const piFinishes = ['settled', 'settled-error', 'settled-aborted', 'interrupt', 'process-failure', 'extension-failure'] as const
const piAnswers = ['Final answer', '多行\n回答', ''] as const
type PiScenario = { id: string; retries: ('Temporary failure' | 'Rate limit reached')[]; answer: typeof piAnswers[number]
  finish: typeof piFinishes[number]; disposals: number }
const piScenario: fc.Arbitrary<PiScenario> = fc.record({
  id: fc.integer({ min: 0, max: 9999 }).map(n => `execution-${n}`),
  retries: fc.array(fc.constantFrom('Temporary failure', 'Rate limit reached'), { maxLength: 3 }),
  answer: fc.constantFrom(...piAnswers),
  finish: fc.constantFrom(...piFinishes),
  disposals: fc.integer({ min: 1, max: 3 })
})
const piOutcome = (mode: string): 'completed' | 'failed' | 'interrupted' => {
  if (mode === 'settled') return 'completed'
  if (mode === 'settled-aborted' || mode === 'interrupt') return 'interrupted'
  return 'failed'
}
const piError = (mode: string): string | undefined =>
  mode === 'settled-error' ? 'Native failure' : mode === 'process-failure' ? 'Native process failed' : mode === 'extension-failure' ? 'Pi extension failed: Extension exploded' : undefined

function piAnswer(native: PiNativeDouble, text: string, stopReason: string, errorMessage?: string) {
  native.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  native.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason, ...(errorMessage ? { errorMessage } : {}) } })
}

it('native Pi public Handle and projection contract', async () => {
  piRpcMock.start.mockReset()
  piRpcMock.start.mockImplementation(async (options: { args: string[]; signal: AbortSignal }) => {
    const directory = options.args[options.args.indexOf('--session-dir') + 1]!
    const listeners = new Set<(event: Record<string, unknown>) => void>()
    const failures = new Set<(error: Error) => void>()
    const requests: Record<string, unknown>[] = []
    const native: PiNativeDouble = {
      requests,
      disposeCalls: 0,
      request: async command => {
        requests.push(structuredClone(command))
        return command.type === 'get_state' ? { sessionFile: join(directory, 'native.jsonl'), sessionId: 'fixture-session' } : {}
      },
      write: async () => undefined,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
      onFailure(listener) { failures.add(listener); return () => { failures.delete(listener) } },
      // Released explicitly, so the Handle cannot claim cleanup by fencing itself only.
      dispose: async () => { native.disposeCalls += 1; listeners.clear(); failures.clear() },
      emit(event) { for (const listener of [...listeners]) listener(event) },
      fail(error) { for (const listener of [...failures]) listener(error) }
    }
    options.signal.addEventListener('abort', () => native.fail(new Error('Pi RPC cancelled')), { once: true })
    piNatives.push(native)
    return native
  })
  await checkAsync('native Pi public Handle and projection contract', fc.asyncProperty(piScenario, async value => {
    piNatives.length = 0
    const directory = await mkdtemp(join(tmpdir(), 'pi-property-'))
    const captured = capture<'pi', PiThreadSettings>('pi', directory, piSessionAdapter, { provider: 'fixture', model: 'model', thinkingLevel: 'low' })
    const host: HarnessPluginHostContext = { harnessDataRoot: directory, temporaryWorkspaceRoot: directory,
      resolveExecutable: async () => '/fixture/pi', environment: async () => ({}) }
    let handle: HarnessThreadHandle | undefined
    try {
      const drain = async () => { await handle!.read('', new AbortController().signal); return captured.read().observation.latestExecution }
      const stillRunning = async (stage: string) => { expect((await drain())?.status, stage).toBe('running') }
      handle = await openPiThread(host, captured.context)
      await handle.send({ executionId: value.id, input: { parts: [{ kind: 'text', text: 'Investigate the failure' }] },
        signal: new AbortController().signal })
      const live = piNatives.at(-1)!
      // The prompt acknowledgement is not completion, and it reaches native as one prompt.
      await stillRunning('prompt acknowledgement')
      expect(live.requests.filter(request => request.type === 'prompt')).toEqual([{ type: 'prompt', message: 'Investigate the failure' }])
      for (const attempt of value.retries) {
        piAnswer(live, attempt, 'error')
        await stillRunning('assistant error message')
        live.emit({ type: 'agent_end', willRetry: true })
        live.emit({ type: 'auto_retry_start', attempt: 1 })
        await stillRunning('retrying agent_end')
      }
      if (value.finish.startsWith('settled')) {
        piAnswer(live, value.answer, value.finish === 'settled-error' ? 'error' : value.finish === 'settled-aborted' ? 'aborted' : 'stop',
          value.finish === 'settled-error' ? 'Native failure' : undefined)
        live.emit({ type: 'agent_end', willRetry: false })
        // A completed turn is still not a completed Execution: only agent_settled settles it.
        await stillRunning('final agent_end without settlement')
        live.emit({ type: 'agent_settled' })
      }
      else if (value.finish === 'interrupt') await handle!.interrupt()
      else if (value.finish === 'process-failure') live.fail(new Error('Native process failed'))
      else live.emit({ type: 'extension_error', error: 'Extension exploded' })
      const outcome = piOutcome(value.finish)
      await vi.waitFor(() => expect(captured.read().observation.latestExecution?.status).toBe(outcome), { interval: 5 })
      // The Handle summarises a terminal Execution with the last assistant text it saw —
      // the turn's answer on a settled path (including an aborted one, which still delivers
      // an answer), otherwise the last retry's message — and omits the field entirely when
      // that text is empty. Both the value and the expected absence are asserted here.
      const lastAssistant = value.finish.startsWith('settled') ? value.answer : value.retries.at(-1) ?? ''
      assertTerminal(captured, piSessionAdapter, value.id, outcome,
        lastAssistant ? lastAssistant.replaceAll('\0', '') : null)
      const error = piError(value.finish)
      if (error) {
        const terminal = captured.read().observation.latestExecution
        if (terminal?.status !== 'failed') throw new Error(`Expected a failed Pi Execution for ${value.finish}`)
        expect(terminal.error).toBe(error)
      }
      // Late native traffic never reopens or rewrites a terminal Execution.
      const before = structuredClone(captured.read())
      live.emit({ type: 'agent_end', willRetry: false })
      live.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'late output' }], stopReason: 'stop' } })
      live.emit({ type: 'tool_execution_end', toolCallId: 'late', toolName: 'read', result: { content: [{ type: 'text', text: 'late tool' }] } })
      live.emit({ type: 'agent_settled' })
      await handle!.read('', new AbortController().signal)
      expect(captured.read()).toEqual(before)
      await Promise.all(Array.from({ length: value.disposals }, () => handle!.dispose()))
      // Disposal releases the native connection itself, not only the Handle's own fence.
      expect(live.disposeCalls).toBe(1)
      await expect(handle!.send({ executionId: 'after-dispose', input: { parts: [{ kind: 'text', text: 'late' }] },
        signal: new AbortController().signal })).rejects.toThrow()
      expect(captured.read()).toEqual(before)
    } finally { await handle?.dispose(); await rm(directory, { recursive: true, force: true }) }
  }), 'open → send acknowledgement → generated retry attempts → settled/failure/interrupt terminal → late native traffic → repeated dispose → rejected send', nativeBudget, { normal: 30, explore: 100 })
}, nativeTimeout)
