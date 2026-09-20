import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentThreadRecord, HarnessPluginHostContext, HarnessThreadHandle, JsonValue } from '@openagent/contracts'
import { openPiThread } from '../src/main/thread/handle.js'
import { piMainModule } from '../src/main/entry.js'
import { piJson, piSessionAdapter, piState } from '../src/shared/state.js'
import { projectPiBartPresentation } from '../src/shared/bart-presentation.js'
import type { PiThreadSettings } from '../src/shared/types.js'
import type { PiRpc } from '../src/main/runtime/rpc.js'
import { createAgentOpenContext } from '@openagent/test-kit'

const mocks = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock('../src/main/runtime/rpc.js', () => ({ startPiRpc: mocks.start }))
type Event = Record<string, unknown>
type Native = PiRpc & { emit(event: Event): void; fail(error: Error): void; file: string; args: string[]; requests: Event[]; replies: Event[] }
const handles: HarnessThreadHandle[] = []
const roots: string[] = []
const natives: Native[] = []
const signal = () => new AbortController().signal
const initialSnapshot = '{"type":"session","version":3,"id":"native-test","cwd":"/workspace"}\n{"type":"message","id":"reply-1","parentId":null,"message":{"role":"assistant","content":[{"type":"text","text":"Original branch answer"}]}}\n'

beforeEach(() => {
  mocks.start.mockReset()
  natives.length = 0
  mocks.start.mockImplementation(async (options: { args: string[]; signal: AbortSignal }) => {
    const arg = (name: string) => options.args[options.args.indexOf(name) + 1]
    const directory = arg('--session-dir')!
    let file = options.args.includes('--session') ? arg('--session')! : join(directory, `native-${natives.length}.jsonl`)
    if (!options.args.includes('--session')) await writeFile(file, initialSnapshot)
    const listeners = new Set<(event: Event) => void>()
    const failures = new Set<(error: Error) => void>()
    const requests: Event[] = []
    const replies: Event[] = []
    const native: Native = {
      get file() { return file }, args: [...options.args], requests, replies,
      request: vi.fn(async (command) => {
        requests.push(structuredClone(command))
        if (command.type === 'clone') {
          const source = await readFile(file, 'utf8')
          file = join(directory, `clone-${natives.length}.jsonl`)
          await writeFile(file, source)
          return { cancelled: false }
        }
        if (command.type === 'get_state') return { sessionFile: file, sessionId: 'fixture-session' }
        return {}
      }),
      write: vi.fn(async (message) => { replies.push(structuredClone(message)) }),
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
      onFailure(listener) { failures.add(listener); return () => { failures.delete(listener) } },
      dispose: vi.fn(async () => { listeners.clear(); failures.clear() }),
      emit(event) { for (const listener of listeners) listener(event) },
      fail(error) { for (const listener of failures) listener(error) }
    }
    options.signal.addEventListener('abort', () => native.fail(new Error('Pi RPC cancelled')), { once: true })
    natives.push(native)
    return native
  })
})
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(handles.splice(0).map(handle => handle.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function owner(initial: JsonValue = null, id = 'thread-1', root?: string) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'openagent-pi-thread-'))
  if (!root) roots.push(directory)
  const host: HarnessPluginHostContext = {
    harnessDataRoot: directory, temporaryWorkspaceRoot: directory,
    resolveExecutable: vi.fn(async () => '/fixture/pi'), environment: vi.fn(async () => ({}))
  }
  let record: AgentThreadRecord<'pi', PiThreadSettings> = {
    id, harnessId: 'pi', archived: false, revision: 0, title: 'Pi test', tags: [], cwd: directory,
    settings: { provider: 'fixture', model: 'model', thinkingLevel: 'low' }, sessionState: initial,
    observation: piSessionAdapter.project(initial), createdAt: 1, updatedAt: 1
  }
  const controller = new AbortController()
  const context = createAgentOpenContext({ sessionState: piSessionAdapter, getRecord: () => record, setRecord: next => { record = next }, signal: controller.signal })
  return {
    host, root: directory, controller, context, record: () => record, state: () => piState(record.sessionState),
    setWorktree(cwd: string) { record = { ...record, worktree: { baseCwd: record.cwd, cwd, native: false } } },
    setSettings(settings: PiThreadSettings) { record = { ...record, settings } },
    execution: () => record.observation.latestExecution,
    async open() { const handle = await openPiThread(host, context); handles.push(handle); return handle }
  }
}
const send = (handle: HarnessThreadHandle, executionId = 'run-1', text = 'Help with this task', runSignal = signal()) => handle.send({ executionId, input: { parts: [{ kind: 'text', text }] }, signal: runSignal })
const drain = (handle: HarnessThreadHandle) => handle.read('', signal())
function answer(native: Native, text: string, stopReason = 'stop') {
  native.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  native.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason } })
}

describe('Pi native Thread boundary', () => {
  it.each(['stop', 'error', 'aborted'])(
    'retains only the last assistant message text on native %s', async stopReason => {
      const test = await owner(); const handle = await test.open()
      await send(handle); const native = natives.at(-1)!
      answer(native, 'I will check this first.', 'toolUse')
      const final = `  ## Result\n\n${'detail\n'.repeat(500)}`
      answer(native, final, stopReason)
      native.emit({ type: 'agent_settled' }); await drain(handle)
      expect(test.execution()).toMatchObject({
        summary: final, status: stopReason === 'stop' ? 'completed' : stopReason === 'error' ? 'failed' : 'interrupted'
      })
      const stored = JSON.parse(JSON.stringify(test.record().sessionState)) as JsonValue
      expect(piSessionAdapter.resolveExecution(stored, 'run-1')?.summary).toBe(final)
    }
  )

  it.each([false, true])('does not reuse commentary after an empty last message, recovery=%s', async recovery => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    answer(native, 'Working on it', 'toolUse')
    answer(native, '', 'toolUse')
    await drain(handle)
    if (recovery) {
      const settled = piSessionAdapter.settle({ sessionState: test.record().sessionState,
        executionId: 'run-1', outcome: 'interrupted', finishedAt: Date.now() })
      expect(piSessionAdapter.project(settled).latestExecution).not.toHaveProperty('summary')
    } else {
      native.emit({ type: 'agent_settled' }); await drain(handle)
      expect(test.execution()).not.toHaveProperty('summary')
    }
  })

  it('preserves the last partial assistant message during Core recovery settlement', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    answer(native, 'Earlier commentary', 'toolUse')
    answer(native, '## Partial\n\nLast message', 'toolUse')
    await drain(handle)
    const settled = piSessionAdapter.settle({ sessionState: test.record().sessionState,
      executionId: 'run-1', outcome: 'interrupted', finishedAt: Date.now() })
    expect(piSessionAdapter.project(settled).latestExecution)
      .toMatchObject({ status: 'interrupted', summary: '## Partial\n\nLast message' })
  })

  it('keeps acknowledged and retrying work running until agent_settled', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    expect(test.execution()?.status).toBe('running')
    answer(native, 'Temporary error', 'error')
    native.emit({ type: 'agent_end', willRetry: true })
    native.emit({ type: 'auto_retry_start', attempt: 1 })
    await drain(handle)
    expect(test.execution()?.status).toBe('running')
    answer(native, 'Recovered answer')
    native.emit({ type: 'agent_end', willRetry: false })
    await drain(handle)
    expect(test.execution()?.status).toBe('running')
    native.emit({ type: 'agent_settled' }); await drain(handle)
    expect(test.execution()).toMatchObject({ executionId: 'run-1', status: 'completed', summary: 'Recovered answer' })
    expect(test.state().nativeSessionJsonl).toBe(initialSnapshot)
  })

  it('projects streamed text, reasoning, tool output, usage and native user messages once', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    native.emit({ type: 'message_start', message: { role: 'user', content: 'Help with this task' } })
    native.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    native.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Check the file' }, { type: 'text', text: 'Checking' }] } })
    native.emit({ type: 'message_end', message: { role: 'assistant', provider: 'fixture', model: 'model', content: [{ type: 'thinking', thinking: 'Check the file' }, { type: 'text', text: 'Checked' }], stopReason: 'toolUse', usage: { input: 5, output: 8, cacheRead: 2, cacheWrite: 0, cost: { total: 0.01 } } } })
    native.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'a.txt' } })
    native.emit({ type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'partial' }] } })
    native.emit({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', result: { content: [{ type: 'text', text: 'file contents' }] }, isError: false })
    await drain(handle)
    expect(test.state().messages).toHaveLength(3)
    expect(test.execution()).toMatchObject({ status: 'running', summary: 'Checked' })
    expect(test.state().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', text: 'Help with this task' }),
      expect.objectContaining({ role: 'assistant', text: 'Checked', thinking: 'Check the file', usage: { input: 5, output: 8, cacheRead: 2, cacheWrite: 0, cost: 0.01 } }),
      expect.objectContaining({ role: 'tool', toolName: 'read', text: 'file contents' })
    ]))
  })

  it('advances foreground only on new semantic events and clears it on settlement', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    native.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'First thought' }] } })
    native.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'First thought, more' }] } })
    await drain(handle)
    expect(test.state().foregrounds).toEqual([
      { executionId: 'run-1', foreground: { kind: 'reasoning', text: 'First thought, more', sequence: 1 } }
    ])
    expect(projectPiBartPresentation(test.state()).activity).toEqual({
      kind: 'reasoning', text: 'First thought, more', sequence: 1, executionId: 'run-1'
    })
    // A tool call opens a new segment; progress and results never bump it.
    native.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'a.txt' } })
    native.emit({ type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'partial' }] } })
    native.emit({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', result: { content: [{ type: 'text', text: 'file contents' }] }, isError: false })
    await drain(handle)
    expect(test.state().foregrounds).toEqual([
      { executionId: 'run-1', foreground: { kind: 'tool-call', callId: 'call-1', toolName: 'read', sequence: 2 } }
    ])
    // Intermediate assistant text supersedes the call; a distinct call bumps again.
    native.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Partial' }] } })
    native.emit({ type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'bash', args: {} })
    await drain(handle)
    expect(test.state().foregrounds).toEqual([
      { executionId: 'run-1', foreground: { kind: 'tool-call', callId: 'call-2', toolName: 'bash', sequence: 4 } }
    ])
    native.emit({ type: 'agent_settled' }); await drain(handle)
    expect(test.state().foregrounds).toEqual([])
    expect(projectPiBartPresentation(test.state()).activity).toBeNull()
  })

  it('bounds and sanitizes a native tool identifier before persisting it', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    const nul = String.fromCharCode(0)
    native.emit({
      type: 'tool_execution_start',
      toolCallId: `call${nul}-1-${'x'.repeat(2_000)}`,
      toolName: 'read',
      args: {}
    })
    await drain(handle)
    // `piState` refuses a NUL and an identifier past 1,024 characters, so the
    // native identifier must not fail the commit of an otherwise valid run.
    expect(test.execution()?.status).toBe('running')
    expect(test.state().foregrounds).toEqual([
      {
        executionId: 'run-1',
        foreground: {
          kind: 'tool-call',
          callId: `call-1-${'x'.repeat(1_017)}`,
          toolName: 'read',
          sequence: 1
        }
      }
    ])
  })

  it('gives a second native assistant message its own reasoning segment', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    const thinking = (text: string) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: text }] })
    native.emit({ type: 'message_update', message: thinking('First thought') })
    native.emit({ type: 'message_end', message: { ...thinking('First thought'), stopReason: 'toolUse' } })
    native.emit({ type: 'message_update', message: thinking('Second thought') })
    await drain(handle)
    // The second message opens a new segment, so Bart replays its arrival
    // instead of extending the arc of the one it replaces.
    expect(projectPiBartPresentation(test.state()).activity).toEqual({
      kind: 'reasoning', text: 'Second thought', sequence: 2, executionId: 'run-1'
    })
  })

  it('keeps a NUL from a native reasoning delta out of the persisted foreground', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    const thinking = (text: string) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: text }] })
    native.emit({ type: 'message_update', message: thinking('Real thought') })
    native.emit({ type: 'message_update', message: thinking('Real thought\u0000 more') })
    await drain(handle)
    // `state()` re-validates the persisted session, and its foreground codec
    // rejects a NUL, so an unsanitized delta would fail the read outright.
    expect(test.state().foregrounds).toEqual([
      { executionId: 'run-1', foreground: { kind: 'reasoning', text: 'Real thought more', sequence: 1 } }
    ])
  })

  it('steers the same execution and supports a later independent turn', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    await send(handle, 'run-1', 'Focus on tests')
    expect(native.requests.filter(c => c.type === 'prompt')).toEqual([
      { type: 'prompt', message: 'Help with this task' },
      { type: 'prompt', message: 'Focus on tests', streamingBehavior: 'steer' }
    ])
    await expect(send(handle, 'conflicting')).rejects.toThrow('active Execution')
    answer(native, 'First complete'); native.emit({ type: 'agent_settled' }); await drain(handle)
    await send(handle, 'run-2', 'Next task')
    answer(native, 'Second complete'); native.emit({ type: 'agent_settled' }); await drain(handle)
    expect(piSessionAdapter.resolveExecution(test.record().sessionState, 'run-1')).toMatchObject({ status: 'completed', summary: 'First complete' })
    expect(test.execution()).toMatchObject({ executionId: 'run-2', status: 'completed', summary: 'Second complete' })
    expect(mocks.start).toHaveBeenCalledOnce()
  })

  it.each(['confirm', 'select', 'input', 'editor'])('roundtrips %s interaction and rejects a replayed answer', async method => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    native.emit({ type: 'extension_ui_request', id: 'native-question', method, title: 'Choose', options: ['One', 'Two'] })
    await drain(handle)
    const execution = test.execution()
    expect(execution?.status).toBe('waiting-for-user')
    if (execution?.status !== 'waiting-for-user') throw new Error('missing interaction')
    const response = { interactionId: execution.interactions[0]!.id, actionId: method === 'confirm' ? 'allow' : 'submit', ...(method === 'confirm' ? {} : { answers: { answer: 'One' } }) }
    expect(response.interactionId).not.toBe('native-question')
    await handle.respond(response)
    expect(native.replies).toEqual([{ type: 'extension_ui_response', id: 'native-question', ...(method === 'confirm' ? { confirmed: true } : { value: 'One' }) }])
    expect(test.execution()?.status).toBe('running')
    await expect(handle.respond(response)).rejects.toThrow(/Unknown|expired/)
    expect(native.replies).toHaveLength(1)
  })

  it('rejects unknown choices while retaining a valid pending interaction', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    native.emit({ type: 'extension_ui_request', id: 'choice', method: 'select', title: 'Pick', options: ['A'] }); await drain(handle)
    const execution = test.execution()
    if (execution?.status !== 'waiting-for-user') throw new Error('missing interaction')
    await expect(handle.respond({ interactionId: execution.interactions[0]!.id, actionId: 'submit', answers: { answer: 'B' } })).rejects.toThrow('Invalid Pi answer')
    expect(native.replies).toEqual([])
    expect(test.execution()?.status).toBe('waiting-for-user')
  })

  it('expires interactions without accepting stale input', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    vi.useFakeTimers()
    native.emit({ type: 'extension_ui_request', id: 'expired', method: 'input', title: 'Answer', timeout: 5 }); await drain(handle)
    const execution = test.execution()
    if (execution?.status !== 'waiting-for-user') throw new Error('missing interaction')
    await vi.advanceTimersByTimeAsync(6)
    await drain(handle)
    expect(test.execution()?.status).toBe('failed')
    expect(native.dispose).toHaveBeenCalled()
    await expect(handle.respond({ interactionId: execution.interactions[0]!.id, actionId: 'submit', answers: { answer: 'late' } })).rejects.toThrow()
    expect(native.replies).toEqual([])
  })

  it('fails unsupported UI instead of leaving execution waiting forever', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    native.emit({ type: 'extension_ui_request', id: 'unsupported', method: 'custom' })
    await vi.waitFor(() => expect(test.execution()?.status).toBe('failed'))
    expect(native.dispose).toHaveBeenCalled()
  })

  it('interrupts and reconnects the same handle for another send', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const first = natives.at(-1)!
    answer(first, 'Remember this partial conversation'); await drain(handle)
    await handle.interrupt()
    expect(test.execution()?.status).toBe('interrupted')
    expect(first.dispose).toHaveBeenCalled()
    await send(handle, 'run-2')
    const second = natives.at(-1)!
    expect(second).not.toBe(first)
    expect(second.args).toContain(first.file)
    expect(await drain(handle)).toContain('Remember this partial conversation')
    answer(second, 'After interruption'); second.emit({ type: 'agent_settled' }); await drain(handle)
    expect(test.execution()?.status).toBe('completed')
  })

  it('settles a process exit as failed and ignores late native events', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    native.fail(new Error('process exited'))
    await vi.waitFor(() => expect(test.execution()?.status).toBe('failed'))
    native.emit({ type: 'agent_settled' }); await drain(handle)
    expect(test.execution()).toMatchObject({ status: 'failed', error: 'process exited' })
    expect(native.dispose).toHaveBeenCalled()
  })

  it('restores persisted history and marks an unrecoverable in-flight execution interrupted', async () => {
    const first = await owner(); const handle = await first.open()
    await send(handle); const native = natives.at(-1)!
    answer(native, 'Partial answer'); await drain(handle)
    const saved = structuredClone(first.record().sessionState)
    await handle.dispose()
    const restored = await owner(saved, 'thread-1', first.root)
    const reopened = await restored.open()
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(restored.execution()?.status).toBe('interrupted')
    expect(await drain(reopened)).toContain('Partial answer')
    await send(reopened, 'run-after-recovery')
    expect(natives.at(-1)!.args).toContain(native.file)
    expect(restored.execution()).toMatchObject({ executionId: 'run-after-recovery', status: 'running' })
  })

  it('forks a stable snapshot without native I/O and opens an independent native clone', async () => {
    const source = await owner(); const handle = await source.open()
    await send(handle); const sourceNative = natives.at(-1)!
    answer(sourceNative, 'Original branch answer'); sourceNative.emit({ type: 'agent_settled' }); await drain(handle)
    const plugin = piMainModule.createMainPlugin(source.host)
    const before = mocks.start.mock.calls.length
    const fork = await plugin.forkThread!({ source: source.record(), request: null, signal: signal() })
    expect(mocks.start).toHaveBeenCalledTimes(before)
    expect(piSessionAdapter.project(fork.sessionState).latestExecution).toBeNull()
    await writeFile(sourceNative.file, 'source advanced after fork\n')
    await send(handle, 'source-next'); answer(sourceNative, 'Source changed'); sourceNative.emit({ type: 'agent_settled' }); await drain(handle)
    expect(piState(fork.sessionState).forkSource?.jsonl).toBe(initialSnapshot)
    const child = await owner(fork.sessionState, 'child', source.root)
    const childHandle = await child.open()
    expect(piState(child.record().sessionState).forkSource?.jsonl).toBe(initialSnapshot)
    expect(mocks.start).toHaveBeenCalledTimes(before)
    await send(childHandle, 'child-run')
    const cloneProcess = natives.find(n => n.requests.some(c => c.type === 'clone'))!
    expect(cloneProcess.args).toContain('--no-extensions')
    expect(cloneProcess.args).toEqual(expect.arrayContaining(['--provider', 'fixture', '--model', 'model', '--thinking', 'low']))
    expect(natives.at(-1)!.args).toEqual(expect.arrayContaining(['--provider', 'fixture', '--model', 'model', '--thinking', 'low']))
    expect(child.state().sessionFile).not.toBe(sourceNative.file)
    expect(await readFile(child.state().sessionFile!, 'utf8')).toBe(initialSnapshot)
    const staging = cloneProcess.args[cloneProcess.args.indexOf('--session') + 1]!
    await expect(readFile(staging)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(sourceNative.file, 'utf8')).toBe('source advanced after fork\n')
    expect(natives.at(-1)!.args).not.toContain('--no-extensions')
  })

  it('session adapter settles only active execution and retains completed history', () => {
    const state = piJson({ version: 1, messages: [], latestExecutionId: 'active', executions: [
      { executionId: 'done', startedAt: 1, finishedAt: 2, status: 'completed', summary: 'kept' },
      { executionId: 'active', startedAt: 10, status: 'running' }
    ] })
    const settled = piSessionAdapter.settle({ sessionState: state, executionId: 'active', outcome: 'interrupted', finishedAt: 3 })
    expect(piSessionAdapter.resolveExecution(settled, 'active')).toMatchObject({ status: 'interrupted', startedAt: 10, finishedAt: 10 })
    expect(piSessionAdapter.resolveExecution(settled, 'done')).toMatchObject({ status: 'completed', summary: 'kept', finishedAt: 2 })
  })

  it('sends image bytes using the native Pi ImageContent protocol', async () => {
    const test = await owner(); const handle = await test.open()
    const path = join(test.root, 'image.png')
    await writeFile(path, Buffer.from([1, 2, 3]))
    await handle.send({ executionId: 'image-run', signal: signal(), input: { parts: [
      { kind: 'text', text: 'Describe this' },
      { kind: 'image', file: { id: 'img', path, name: 'image.png', mimeType: 'image/png', size: 3 } }
    ] } })
    const native = natives.at(-1)!
    expect(native.requests.find(c => c.type === 'prompt')).toEqual({ type: 'prompt', message: 'Describe this', images: [{ type: 'image', data: 'AQID', mimeType: 'image/png' }] })
  })

  it('does not cancel accepted work when its caller acceptance signal ends', async () => {
    const test = await owner(); const handle = await test.open()
    const run = new AbortController()
    await send(handle, 'run-1', 'Start', run.signal)
    const native = natives.at(-1)!
    run.abort()
    await drain(handle)
    expect(test.execution()?.status).toBe('running')
    expect(native.dispose).not.toHaveBeenCalled()
    answer(native, 'Completed after caller returned'); native.emit({ type: 'agent_settled' }); await drain(handle)
    expect(test.execution()?.status).toBe('completed')
  })

  it('interrupts when the Thread context signal is cancelled', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    test.controller.abort()
    await vi.waitFor(() => expect(test.execution()?.status).toBe('interrupted'))
    expect(native.dispose).toHaveBeenCalled()
  })

  it('cancels a prompt that has not yet been acknowledged', async () => {
    const test = await owner(); const handle = await test.open()
    const initialize = mocks.start.getMockImplementation()!
    let waiting = false
    mocks.start.mockImplementationOnce(async options => {
      const native = await initialize(options) as Native
      const original = native.request
      native.request = vi.fn(async (command, requestSignal) => {
        if (command.type !== 'prompt') return original(command, requestSignal)
        waiting = true
        return new Promise<Record<string, unknown>>((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(new Error('request cancelled')), { once: true })
        })
      })
      return native
    })
    const run = new AbortController()
    const sending = send(handle, 'run-1', 'Pending prompt', run.signal)
    const rejected = expect(sending).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(waiting).toBe(true))
    run.abort()
    await rejected
    expect(test.execution()?.status).toBe('interrupted')
    expect(natives.at(-1)!.dispose).toHaveBeenCalled()
  })

  it('rejects unsupported slash commands before admitting native work', async () => {
    const test = await owner(); const handle = await test.open()
    await expect(send(handle, 'slash', '/login')).rejects.toThrow('slash commands')
    expect(test.execution()).toBeNull()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it.each(['error', 'aborted'])('settles native %s without reporting successful completion', async stopReason => {
    const test = await owner(); const handle = await test.open()
    await send(handle); const native = natives.at(-1)!
    native.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason, errorMessage: 'Native request failed' } })
    native.emit({ type: 'agent_settled' }); await drain(handle)
    expect(test.execution()?.status).toBe(stopReason === 'error' ? 'failed' : 'interrupted')
    if (stopReason === 'error') expect(test.execution()).toMatchObject({ error: 'Native request failed' })
  })

  it('rejects a fork while native work is active', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle)
    await expect(piMainModule.createMainPlugin(test.host).forkThread!({ source: test.record(), request: null, signal: signal() })).rejects.toThrow('finish before forking')
  })

  it('opens, reads and disposes an unused handle without launching or resolving native code', async () => {
    const test = await owner(); const handle = await test.open()
    expect(await drain(handle)).toBe('')
    await handle.dispose()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(test.host.resolveExecutable).not.toHaveBeenCalled()
    expect(test.host.environment).not.toHaveBeenCalled()
    await expect(send(handle)).rejects.toThrow('disposed')
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('waits for Core admission and launches in the newly prepared managed worktree', async () => {
    const test = await owner()
    const prepared = join(test.root, 'prepared-worktree')
    let admit!: () => void
    const admission = new Promise<void>(resolve => { admit = resolve })
    let committing = false
    let admitted = false
    const handle = await openPiThread(test.host, { ...test.context, sessionState: {
      read: test.context.sessionState.read,
      async commit(state) {
        if (!admitted && piSessionAdapter.project(state).latestExecution?.status === 'running') {
          committing = true
          await admission
          await test.context.sessionState.commit(state)
          test.setWorktree(prepared)
          admitted = true
        } else await test.context.sessionState.commit(state)
      }
    } })
    handles.push(handle)
    const sending = send(handle)
    await vi.waitFor(() => expect(committing).toBe(true))
    expect(mocks.start).not.toHaveBeenCalled()
    expect(test.host.resolveExecutable).not.toHaveBeenCalled()
    admit(); await sending
    expect(mocks.start).toHaveBeenCalledOnce()
    expect(mocks.start.mock.calls[0]![0]).toMatchObject({ cwd: prepared })
    expect(test.host.resolveExecutable).toHaveBeenCalledWith('pi', prepared, undefined)
    const first = natives.at(-1)!
    answer(first, 'Prepared workspace complete'); first.emit({ type: 'agent_settled' }); await drain(handle)
    const moved = join(test.root, 'another-worktree')
    test.setWorktree(moved)
    await send(handle, 'next-workspace')
    expect(first.dispose).toHaveBeenCalled()
    expect(mocks.start.mock.calls.at(-1)![0]).toMatchObject({ cwd: moved })
    expect(natives.at(-1)!.args).toContain(first.file)
  })

  it('does not launch a process when Core rejects execution admission', async () => {
    const test = await owner()
    const handle = await openPiThread(test.host, { ...test.context, sessionState: {
      read: test.context.sessionState.read,
      async commit(state) {
        if (piSessionAdapter.project(state).latestExecution?.status === 'running') throw new Error('Workspace preparation failed')
        await test.context.sessionState.commit(state)
      }
    } })
    handles.push(handle)
    await expect(send(handle)).rejects.toThrow('Workspace preparation failed')
    expect(mocks.start).not.toHaveBeenCalled()
    expect(test.host.resolveExecutable).not.toHaveBeenCalled()
  })

  it('shares one lazy connection and preserves primary-before-steering order during startup', async () => {
    const test = await owner(); const handle = await test.open()
    const initialize = mocks.start.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    mocks.start.mockImplementationOnce(async options => { await gate; return initialize(options) })
    const primary = send(handle, 'run-1', 'First')
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
    const steering = send(handle, 'run-1', 'Second')
    release()
    await Promise.all([primary, steering])
    expect(mocks.start).toHaveBeenCalledOnce()
    expect(natives.at(-1)!.requests.filter(c => c.type === 'prompt')).toEqual([
      { type: 'prompt', message: 'First' },
      { type: 'prompt', message: 'Second', streamingBehavior: 'steer' }
    ])
  })

  it('uses session-local CLI options and never writes native global model defaults', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle)
    const native = natives.at(-1)!
    expect(native.args).toEqual(expect.arrayContaining(['--provider', 'fixture', '--model', 'model', '--thinking', 'low']))
    expect(native.requests.map(command => command.type)).toEqual(['get_state', 'prompt'])
    answer(native, 'First'); native.emit({ type: 'agent_settled' }); await drain(handle)
    await send(handle, 'next')
    expect(mocks.start).toHaveBeenCalledOnce()
    expect(native.requests.some(command => ['set_model', 'set_thinking_level'].includes(String(command.type)))).toBe(false)
  })

  it.each([
    { provider: 'other', model: 'model', thinkingLevel: 'low' },
    { provider: 'fixture', model: 'other-model', thinkingLevel: 'low' },
    { provider: 'fixture', model: 'model', thinkingLevel: 'high' },
    { provider: 'fixture', model: 'model', thinkingLevel: 'low', executablePath: '/other/pi' }
  ])('restarts a completed session with changed native configuration %j', async settings => {
    const test = await owner(); const handle = await test.open()
    await send(handle)
    const first = natives.at(-1)!
    answer(first, 'Retain this history'); first.emit({ type: 'agent_settled' }); await drain(handle)
    test.setSettings(settings)
    await send(handle, 'changed')
    const second = natives.at(-1)!
    expect(second).not.toBe(first)
    expect(first.dispose).toHaveBeenCalled()
    expect(second.args).toEqual(expect.arrayContaining(['--session', first.file, '--provider', settings.provider, '--model', settings.model, '--thinking', settings.thinkingLevel]))
    expect(await drain(handle)).toContain('Retain this history')
    expect(second.requests.map(command => command.type)).toEqual(['get_state', 'prompt'])
  })

  it('retains a running native configuration for steering then applies edits to the next execution', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle)
    const first = natives.at(-1)!
    test.setSettings({ provider: 'next-provider', model: 'next-model', thinkingLevel: 'high' })
    await send(handle, 'run-1', 'Continue current task')
    expect(mocks.start).toHaveBeenCalledOnce()
    expect(first.requests.at(-1)).toEqual({ type: 'prompt', message: 'Continue current task', streamingBehavior: 'steer' })
    answer(first, 'Current configuration finished'); first.emit({ type: 'agent_settled' }); await drain(handle)
    await send(handle, 'next-config')
    expect(mocks.start).toHaveBeenCalledTimes(2)
    expect(natives.at(-1)!.args).toEqual(expect.arrayContaining(['--provider', 'next-provider', '--model', 'next-model', '--thinking', 'high']))
  })

  it.each(['cancel', 'reject'])('does not stop the original execution when steering acceptance is %s', async outcome => {
    const test = await owner(); const handle = await test.open()
    await send(handle)
    const native = natives.at(-1)!
    native.emit({ type: 'extension_ui_request', id: 'primary-question', method: 'confirm', title: 'Continue original work?' })
    await drain(handle)
    const waiting = test.execution()
    if (waiting?.status !== 'waiting-for-user') throw new Error('Expected original interaction')
    const originalRequest = native.request
    let steeringStarted = false
    native.request = vi.fn(async (command, requestSignal) => {
      if (command.streamingBehavior !== 'steer') return originalRequest(command, requestSignal)
      steeringStarted = true
      if (outcome === 'reject') throw new Error('Steering was rejected')
      return new Promise<Record<string, unknown>>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new Error('Steering was cancelled')), { once: true })
      })
    })
    const cancellation = new AbortController()
    const steering = send(handle, 'run-1', 'Additional instruction', cancellation.signal)
    const rejected = expect(steering).rejects.toThrow(outcome === 'reject' ? 'rejected' : 'cancelled')
    await vi.waitFor(() => expect(steeringStarted).toBe(true))
    if (outcome === 'cancel') cancellation.abort()
    await rejected
    expect(native.dispose).not.toHaveBeenCalled()
    expect(test.execution()).toEqual(waiting)
    expect(test.state().messages.some(row => row.text === 'Additional instruction')).toBe(false)
    await handle.respond({ interactionId: waiting.interactions[0]!.id, actionId: 'allow' })
    answer(native, 'Original execution completed'); native.emit({ type: 'agent_settled' }); await drain(handle)
    expect(test.execution()).toMatchObject({ executionId: 'run-1', status: 'completed', summary: 'Original execution completed' })
  })

  it('persists submitted input before startup and retains it after startup failure and reopen', async () => {
    const test = await owner(); const handle = await test.open()
    const task = 'Find why the build fails in the new workspace'
    mocks.start.mockImplementationOnce(async () => {
      expect(test.execution()?.status).toBe('running')
      expect(test.state().messages).toEqual([expect.objectContaining({ role: 'user', executionId: 'run-1', text: task })])
      throw new Error('Pi could not start')
    })
    await expect(send(handle, 'run-1', task)).rejects.toThrow('could not start')
    expect(test.execution()?.status).toBe('failed')
    expect(await drain(handle)).toContain(task)
    const submittedId = test.state().messages[0]!.id
    const restored = await owner(structuredClone(test.record().sessionState), 'restored', test.root)
    const restoredHandle = await restored.open()
    expect(await drain(restoredHandle)).toContain(task)
    expect(restored.execution()?.status).toBe('failed')
    expect(restored.state().messages[0]!.id).toBe(submittedId)
    expect(mocks.start).toHaveBeenCalledOnce()
  })

  it('deduplicates native user echoes one-for-one without losing repeated submitted messages', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle, 'run-1', 'Repeat this')
    const native = natives.at(-1)!
    const admittedId = test.state().messages[0]!.id
    native.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'Repeat this' }] } })
    await drain(handle)
    expect(test.state().messages.filter(m => m.role === 'user')).toHaveLength(1)
    expect(test.state().messages[0]!.id).toBe(admittedId)
    await send(handle, 'run-1', 'Repeat this')
    native.emit({ type: 'message_start', message: { role: 'user', content: 'Repeat this' } })
    await drain(handle)
    expect(test.state().messages.filter(m => m.role === 'user').map(m => m.text)).toEqual(['Repeat this', 'Repeat this'])
    native.emit({ type: 'message_start', message: { role: 'user', content: 'Native extension contributed context' } })
    await drain(handle)
    expect(test.state().messages.filter(m => m.role === 'user')).toHaveLength(3)
  })

  it('retains steering whose native echo raced a rejected acknowledgement', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle)
    const native = natives.at(-1)!
    const original = native.request
    native.request = vi.fn(async (command, requestSignal) => {
      if (command.streamingBehavior !== 'steer') return original(command, requestSignal)
      native.emit({ type: 'message_start', message: { role: 'user', content: command.message } })
      throw new Error('Acknowledgement cancelled')
    })
    await expect(send(handle, 'run-1', 'Already delivered')).rejects.toThrow('cancelled')
    expect(test.state().messages.filter(row => row.text === 'Already delivered')).toHaveLength(1)
    expect(test.execution()?.status).toBe('running')
    expect(native.dispose).not.toHaveBeenCalled()
  })

  it('does not consume a later native message as the echo of removed rejected steering', async () => {
    const test = await owner(); const handle = await test.open()
    await send(handle)
    const native = natives.at(-1)!
    native.request = vi.fn(async () => { throw new Error('Rejected') })
    await expect(send(handle, 'run-1', 'Not accepted')).rejects.toThrow('Rejected')
    expect(test.state().messages.some(row => row.text === 'Not accepted')).toBe(false)
    native.emit({ type: 'message_start', message: { role: 'user', content: 'Not accepted' } })
    await drain(handle)
    expect(test.state().messages.filter(row => row.text === 'Not accepted')).toHaveLength(1)
  })

  it.each(['settlement', 'interrupt'])('recovers a transient terminal commit failure on %s before a later send', async path => {
    const test = await owner()
    let rejectedTerminal = false
    const handle = await openPiThread(test.host, { ...test.context, sessionState: {
      read: test.context.sessionState.read,
      async commit(state) {
        const status = piSessionAdapter.project(state).latestExecution?.status
        if (!rejectedTerminal && ['completed', 'interrupted'].includes(status ?? '')) {
          rejectedTerminal = true
          throw new Error('Temporary persistence failure')
        }
        await test.context.sessionState.commit(state)
      }
    } })
    handles.push(handle)
    await send(handle)
    const first = natives.at(-1)!
    if (path === 'interrupt') {
      await expect(handle.interrupt()).rejects.toThrow('Temporary persistence failure')
      expect(test.execution()?.status).toBe('running')
    } else {
      answer(first, 'Native completed'); first.emit({ type: 'agent_settled' })
      await vi.waitFor(() => expect(test.execution()?.status).toBe('failed'))
    }
    await send(handle, 'recovered-run', 'Try another task')
    expect(test.execution()).toMatchObject({ executionId: 'recovered-run', status: 'running' })
    expect(piSessionAdapter.resolveExecution(test.record().sessionState, 'run-1')?.status).toBe(path === 'interrupt' ? 'interrupted' : 'failed')
    answer(natives.at(-1)!, 'Recovery completed'); natives.at(-1)!.emit({ type: 'agent_settled' }); await drain(handle)
    expect(test.execution()?.status).toBe('completed')
    expect(first.dispose).toHaveBeenCalled()
  })

  it('reinstalls exclusive Host tools and immutable context on reopen and configuration restart', async () => {
    const test = await owner()
    const injection = { instructions: ['Host instructions nonce'], contextEntries: [{ id: 'workspace', content: 'Thread context nonce' }],
      tools: { mode: 'exclusive' as const, bindings: [{ name: 'core_task', description: 'Core task', inputSchema: { type: 'object' }, execute: async () => ({ ok: true }) }] } }
    const initialize = mocks.start.getMockImplementation()!
    const sources: string[] = []
    mocks.start.mockImplementation(async options => {
      sources.push(await readFile(options.args[options.args.indexOf('-e') + 1], 'utf8'))
      return initialize(options)
    })
    const handle = await openPiThread(test.host, { ...test.context, injection }); handles.push(handle)
    await handle.send({ executionId: 'host-1', input: { parts: [{ kind: 'text', text: 'First user input' }] }, contextEntries: [{ id: 'runtime', content: 'First send context' }], signal: signal() })
    const first = natives.at(-1)!
    expect(first.args).toEqual(expect.arrayContaining(['--no-tools', '--tools', 'core_task', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files']))
    expect(first.requests.at(-1)).toEqual({ type: 'prompt', message: 'First send context\n\nFirst user input' })
    expect(test.state().messages.filter(row => row.role === 'user').map(row => row.text)).toEqual(['First user input'])
    expect(sources[0]).toContain('Host instructions nonce')
    expect(sources[0]).toContain('Thread context nonce')
    expect(sources[0]).not.toContain('First send context')
    answer(first, 'Host first answer'); first.emit({ type: 'agent_settled' }); await drain(handle)
    await handle.dispose()
    const restored = await owner(structuredClone(test.record().sessionState), 'thread-1', test.root)
    const reopened = await openPiThread(restored.host, { ...restored.context, injection }); handles.push(reopened)
    await send(reopened, 'host-2', 'Follow up')
    expect(natives.at(-1)!.args).toContain(first.file)
    expect(sources[1]).toBe(sources[0])
    const second = natives.at(-1)!
    answer(second, 'Host reopened answer'); second.emit({ type: 'agent_settled' }); await drain(reopened)
    restored.setSettings({ provider: 'changed', model: 'changed' })
    await send(reopened, 'host-3', 'Changed model')
    expect(natives.at(-1)!.args).toEqual(expect.arrayContaining(['--no-tools', '--tools', 'core_task', '--no-extensions']))
    expect(sources[2]).toBe(sources[0])
    expect(await drain(reopened)).toContain('Host first answer')
  })

  it('rejects unsupported injection mode and duplicate tools without native work', async () => {
    const test = await owner()
    await expect(openPiThread(test.host, { ...test.context, injection: { tools: { mode: 'extend', bindings: [] } } })).rejects.toThrow('exclusive')
    const binding = { name: 'same', description: 'Same', inputSchema: {}, execute: async () => null }
    await expect(openPiThread(test.host, { ...test.context, injection: { tools: { mode: 'exclusive', bindings: [binding, binding] } } })).rejects.toThrow('unique')
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('preserves ordinary native tools for context-only injection without an exclusive tool request', async () => {
    const test = await owner()
    const handle = await openPiThread(test.host, { ...test.context, injection: { instructions: ['Additional instructions'] } }); handles.push(handle)
    await send(handle)
    expect(natives.at(-1)!.args).toContain('-e')
    expect(natives.at(-1)!.args).not.toContain('--no-tools')
    expect(natives.at(-1)!.args).not.toContain('--no-extensions')
  })

})
