import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeTransport, type ClaudeNativeEvent } from '../src/main/runtime/transport.js'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('cross-spawn', () => ({ default: mocks.spawn }))

const transports: ClaudeTransport[] = []

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.dispose()))
  vi.restoreAllMocks()
  mocks.spawn.mockReset()
})

describe('Claude transport lifecycle', () => {
  it('adds the exact directory mention scope while file references add their parent', async () => {
    const { transport } = fixture()
    await transport.send('execution', { parts: [
      { kind: 'mention', name: 'project', path: '/work/project', pathType: 'directory' },
      { kind: 'mention', name: 'file', path: '/files/project/readme.md' }
    ] }, 'now', new AbortController().signal)
    const args = mocks.spawn.mock.calls[0]?.[1] as string[]
    const scopes = args.flatMap((arg, index) => arg === '--add-dir' ? [args[index + 1]] : [])
    expect(scopes).toEqual(['/work/project', '/files/project'])
    expect(scopes).not.toContain('/work')
  })

  it('extends a live process scope before admitting later mentions and serializes cumulative updates', async () => {
    const { transport, child } = fixture()
    const signal = new AbortController().signal
    const mention = (path: string) => ({ parts: [{ kind: 'mention' as const, name: path, path, pathType: 'directory' as const }] })
    await transport.send('execution', mention('/work/first'), 'now', signal)
    child.onWrite = frame => { if (frame.type === 'user') child.frame(frame) }
    const second = transport.send('execution', mention('/work/second'), 'next', signal)
    const third = transport.send('execution', mention('/work/third'), 'next', signal)
    const updates = () => child.writes.filter(frame => (frame.request as Record<string, unknown> | undefined)?.subtype === 'apply_flag_settings')
    await expect.poll(() => updates().length).toBe(1)
    expect(updates()[0]?.request).toEqual({ subtype: 'apply_flag_settings', settings: {
      permissions: { additionalDirectories: ['/work/first', '/work/second'] }
    } })
    expect(child.writes.filter(frame => frame.type === 'user')).toHaveLength(1)
    child.frame({ type: 'control_response', response: { subtype: 'success', request_id: updates()[0]?.request_id } })
    await second
    await expect.poll(() => updates().length).toBe(2)
    expect(updates()[1]?.request).toEqual({ subtype: 'apply_flag_settings', settings: {
      permissions: { additionalDirectories: ['/work/first', '/work/second', '/work/third'] }
    } })
    child.frame({ type: 'control_response', response: { subtype: 'success', request_id: updates()[1]?.request_id } })
    await third
    await transport.send('execution', mention('/work/second'), 'next', signal)
    expect(updates()).toHaveLength(2)
    expect(child.writes.filter(frame => frame.type === 'user')).toHaveLength(4)
    expect(mocks.spawn).toHaveBeenCalledOnce()
  })

  it('does not admit input when a new scope is rejected and can retry the update', async () => {
    const { transport, child } = fixture()
    const signal = new AbortController().signal
    await transport.inspectInitialization()
    const input = { parts: [{ kind: 'mention' as const, name: 'project', path: '/work/project', pathType: 'directory' as const }] }
    child.onWrite = frame => child.frame({ type: 'control_response', response: {
      subtype: 'error', request_id: frame.request_id, error: 'scope rejected'
    } })
    await expect(transport.send('execution', input, 'now', signal)).rejects.toThrow('scope rejected')
    expect(child.writes.filter(frame => frame.type === 'user')).toHaveLength(0)
    child.onWrite = undefined
    await transport.send('execution', input, 'now', signal)
    expect(child.writes.filter(frame => (frame.request as Record<string, unknown> | undefined)?.subtype === 'apply_flag_settings')).toHaveLength(2)
    expect(child.writes.filter(frame => frame.type === 'user')).toHaveLength(1)
  })

  it('restores previously granted directory scopes when the native child reconnects', async () => {
    const { transport, child } = fixture()
    const signal = new AbortController().signal
    await transport.inspectInitialization()
    await transport.send('execution', { parts: [{ kind: 'mention', name: 'project', path: '/work/project', pathType: 'directory' }] }, 'now', signal)
    child.close(1)
    await expect.poll(() => transport.activeExecutionId).toBeUndefined()
    mocks.spawn.mockReturnValue(new FakeChild())
    await transport.send('recovery', { parts: [{ kind: 'text', text: 'continue' }] }, 'now', signal)
    expect(mocks.spawn.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['--add-dir', '/work/project']))
  })

  it('accepts root task results without treating user echoes as tool output', async () => {
    const { transport, child, events } = fixture()
    await transport.send('execution', { parts: [{ kind: 'text', text: 'Track two tasks' }] },
      'now', new AbortController().signal)
    const use = (id: string, name: string, input: unknown) => child.frame({ type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name, input }] } })
    const result = (id: string, text: string, isError = false) => child.frame({
      type: 'user', parent_tool_use_id: null, message: { content: [
        { type: 'text', text: 'Tool response follows' },
        { type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: isError }
      ] }
    })
    child.frame({ type: 'user', uuid: 'echo', message: { content: [{ type: 'text', text: 'Track two tasks' }] } })
    child.frame({ type: 'user', uuid: 'text-echo', message: { content: 'Track two tasks' } })
    expect(events.filter(event => event.type === 'text' || event.type === 'plan-update')).toEqual([])

    use('create-1', 'TaskCreate', { subject: 'Inspect' })
    use('create-2', 'TaskCreate', { subject: 'Verify' })
    expect(events.filter(event => event.type === 'plan-update')).toEqual([])
    result('create-1', 'Task #1 created successfully: Inspect')
    result('create-2', 'Task #2 created successfully: Verify')
    use('start-1', 'TaskUpdate', { taskId: '1', status: 'in_progress' })
    result('start-1', 'Updated task #1 status')
    await expect.poll(() => events.filter(event => event.type === 'plan-update').at(-1)).toMatchObject({
      plan: [{ step: 'Inspect', status: 'inProgress' }, { step: 'Verify', status: 'pending' }]
    })

    use('failed-create', 'TaskCreate', { subject: 'Must not appear' })
    result('failed-create', 'Task creation failed', true)
    use('failed-update', 'TaskUpdate', { taskId: '1', status: 'completed' })
    result('failed-update', 'Task update failed', true)
    use('shell', 'Bash', { command: 'false' })
    result('shell', 'Exit code 1', true)
    await expect.poll(() => events.filter(event => event.type === 'activity-end').length).toBe(6)
    expect(events.filter(event => event.type === 'plan-update')).toHaveLength(3)
    expect(events).toContainEqual(expect.objectContaining({ type: 'activity-end', id: 'shell', status: 'failed', detail: 'Exit code 1' }))

    use('complete-1', 'TaskUpdate', { taskId: '1', status: 'completed' })
    result('complete-1', 'Updated task #1 status')
    use('delete-2', 'TaskUpdate', { taskId: '2', status: 'deleted' })
    result('delete-2', 'Deleted task #2')
    await expect.poll(() => events.filter(event => event.type === 'plan-update').at(-1)).toMatchObject({
      plan: [{ step: 'Inspect', status: 'completed' }]
    })
  })

  it('finishes an execution if the native process exits with queued input still pending', async () => {
    const { transport, child, events } = fixture()
    await transport.applySettings(
      { executablePath: '/fake/claude', model: 'sonnet' },
      new AbortController().signal
    )
    const first = await transport.send(
      'execution', { parts: [{ kind: 'text', text: 'first' }] },
      'now', new AbortController().signal
    )
    await transport.send(
      'execution', { parts: [{ kind: 'text', text: 'follow-up' }] },
      'next', new AbortController().signal
    )
    child.frame({
      type: 'control_request', request_id: 'permission',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } }
    })
    child.stderr.write('native connection lost')
    child.close(17)

    await expect.poll(() => events.filter((event) => event.type === 'done')).toEqual([{
      type: 'done', executionToken: first.executionToken, generation: 2,
      outcome: 'failed', error: 'native connection lost'
    }])
    expect(events).toContainEqual({
      type: 'interaction-resolved', executionToken: first.executionToken,
      id: 'permission', status: 'cancelled'
    })
    expect(transport.activeExecutionId).toBeUndefined()

    const replacement = new FakeChild()
    mocks.spawn.mockReturnValue(replacement)
    await transport.send(
      'recovery', { parts: [{ kind: 'text', text: 'retry' }] },
      'now', new AbortController().signal
    )
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(mocks.spawn.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      '--model', 'sonnet', '--resume=00000000-0000-4000-8000-000000000001'
    ]))
    expect(transport.activeExecutionId).toBe('recovery')
  })

  it('finishes an interrupted execution when the process exits before returning a result', async () => {
    const { transport, child, events } = fixture()
    const sent = await transport.send(
      'execution', { parts: [{ kind: 'text', text: 'first' }] },
      'now', new AbortController().signal
    )
    await transport.interrupt()
    child.close(0)

    await expect.poll(() => events.filter((event) => event.type === 'done')).toMatchObject([{
      type: 'done', executionToken: sent.executionToken, generation: 1,
      outcome: 'interrupted'
    }])
    expect(transport.activeExecutionId).toBeUndefined()
  })

  it.each([true, false])('preserves split UTF-8 bytes with a trailing newline: %s', async (newline) => {
    const { transport, child, events } = fixture()
    await transport.inspectInitialization()
    const encoded = Buffer.from(JSON.stringify({
      type: 'system', subtype: 'task_notification', summary: '正在整理中文 🔎'
    }) + (newline ? '\n' : ''))
    for (const byte of encoded) child.stdout.write(Buffer.from([byte]))
    if (!newline) child.close(0)

    await expect.poll(() => events).toContainEqual({
      type: 'native-notification', summary: '正在整理中文 🔎'
    })
  })

  it('consumes initialization failure when cancellation occurs during startup', async () => {
    const { transport, child } = fixture()
    const controller = new AbortController()
    child.onWrite = () => {
      controller.abort()
      throw new Error('startup failed after cancellation')
    }

    await expect(transport.readUsage(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    // Allow promise rejection tracking to observe the abandoned initialization.
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  it('fails pending controls when stdin breaks without a child close event and reconnects', async () => {
    const { transport, child } = fixture()
    await transport.inspectInitialization()
    const requests: string[] = []
    child.onWrite = (frame) => {
      requests.push(String((frame.request as Record<string, unknown>).subtype))
    }
    const signal = new AbortController().signal
    let statuses: string[] = []
    const pending = Promise.allSettled([
      transport.readUsage(signal), transport.readUsage(signal)
    ]).then((results) => {
      statuses = results.map((result) => result.status)
      return results
    })
    await expect.poll(() => requests).toEqual(['get_usage', 'get_usage'])
    child.stdin.destroy(new Error('write EPIPE'))

    await expect.poll(() => statuses).toEqual(['rejected', 'rejected'])
    expect(await pending).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: 'write EPIPE' }) },
      { status: 'rejected', reason: expect.objectContaining({ message: 'write EPIPE' }) }
    ])
    expect(child.killed).toBe(true)

    mocks.spawn.mockReturnValue(new FakeChild())
    await expect(transport.inspectInitialization()).resolves.toEqual({})
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
  })

  it('keeps the accepted generation terminal when a follow-up write breaks stdin', async () => {
    const { transport, child, events } = fixture()
    const sent = await transport.send(
      'execution', { parts: [{ kind: 'text', text: 'first' }] },
      'now', new AbortController().signal
    )
    child.onWrite = () => { throw new Error('write EPIPE') }
    await expect(transport.send(
      'execution', { parts: [{ kind: 'text', text: 'follow-up' }] },
      'next', new AbortController().signal
    )).rejects.toThrow('write EPIPE')

    await expect.poll(() => events.filter((event) => event.type === 'done')).toEqual([{
      type: 'done', executionToken: sent.executionToken, generation: 1,
      outcome: 'failed', error: 'write EPIPE'
    }])
    expect(child.killed).toBe(true)
    mocks.spawn.mockReturnValue(new FakeChild())
    await transport.send(
      'recovery', { parts: [{ kind: 'text', text: 'retry' }] },
      'now', new AbortController().signal
    )
    expect(transport.activeExecutionId).toBe('recovery')
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
  })

  it('waits for failed-child escalation and ignores its delayed events after reconnecting', async () => {
    const { transport, child, events } = fixture()
    await transport.inspectInitialization()
    const killSignals: NodeJS.Signals[] = []
    let onTerm!: () => void
    const termSent = new Promise<void>((resolve) => { onTerm = resolve })
    vi.spyOn(child, 'kill').mockImplementation((signal) => {
      killSignals.push(signal)
      if (signal === 'SIGTERM') onTerm()
      if (signal === 'SIGKILL') {
        child.killed = true
        child.signalCode = signal
      }
      // The process exits on SIGKILL but its close event is delayed.
      return true
    })
    child.stdin.destroy(new Error('write EPIPE'))
    await termSent
    const replacement = new FakeChild()
    mocks.spawn.mockReturnValue(replacement)
    const restarting = transport.inspectInitialization()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    await expect(restarting).resolves.toEqual({})
    expect(killSignals).toEqual(['SIGTERM', 'SIGKILL'])

    child.frame({ type: 'system', subtype: 'task_notification', summary: 'stale output' })
    child.stderr.write('stale error')
    child.emit('error', new Error('stale process error'))
    child.close(17)
    await expect(transport.readUsage()).resolves.toEqual({})
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    // Retirement announces itself once; the stale child's late frame, output,
    // error and close must still reach nobody.
    expect(events).toEqual([{ type: 'process-exit' }])
  })
})

function fixture(): {
  transport: ClaudeTransport
  child: FakeChild
  events: ClaudeNativeEvent[]
} {
  const child = new FakeChild()
  mocks.spawn.mockReturnValue(child as unknown as ChildProcessWithoutNullStreams)
  const events: ClaudeNativeEvent[] = []
  const transport = new ClaudeTransport({
    executable: '/fake/claude', cwd: process.cwd(),
    environment: { HTTPS_PROXY: 'http://localhost:1' },
    sessionId: '00000000-0000-4000-8000-000000000001',
    resume: false, settings: { executablePath: '/fake/claude' },
    interactive: true, persistSession: true,
    interruptTimeouts: { termMs: 75, killMs: 100 },
    onEvent: (event) => { events.push(event) }
  })
  transports.push(transport)
  return { transport, child, events }
}

class FakeChild extends EventEmitter {
  readonly writes: Record<string, unknown>[] = []
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      try {
        const frame = JSON.parse(chunk.toString()) as Record<string, unknown>
        this.writes.push(frame)
        if (this.onWrite) this.onWrite(frame)
        else if (frame.type === 'control_request') {
          this.frame({
            type: 'control_response',
            response: { subtype: 'success', request_id: frame.request_id, response: {} }
          })
        } else if (frame.type === 'user') this.frame(frame)
        callback()
      } catch (error) {
        callback(error as Error)
      }
    }
  })
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  onWrite?: (frame: Record<string, unknown>) => void

  frame(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`)
  }

  close(code: number): void {
    this.exitCode = code
    this.emit('close', code)
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true
    this.signalCode = signal
    this.close(0)
    return true
  }
}
