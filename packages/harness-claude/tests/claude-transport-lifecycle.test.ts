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
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      try {
        const frame = JSON.parse(chunk.toString()) as Record<string, unknown>
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
