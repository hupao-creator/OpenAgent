import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import spawn from 'cross-spawn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexAppServer,
  type CodexNativeActivityEvent
} from '../src/main/runtime/app-server.js'
import type { CodexNativeEvent } from '../src/shared/types.js'
import {
  createEmptyCodexState,
  decodeCodexState,
  reduceCodexEvent,
  stageCodexExecution
} from '../src/shared/state.js'

vi.mock('cross-spawn', () => ({ default: vi.fn() }))

interface WireRequest {
  readonly id?: number
  readonly method: string
}

const servers: CodexAppServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()))
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('Codex app-server transport', () => {
  it('collects every full native history page in occurrence order for context replay', async () => {
    const { server, child } = createServer()
    const reading = server.readThreadHistory('history-source', new AbortController().signal)
    const first = await waitForRequest(child, 'thread/turns/list')
    expect(first).toMatchObject({ params: { threadId: 'history-source', itemsView: 'full', sortDirection: 'asc', limit: 100 } })
    const earlier = { id: 'turn-1', itemsView: 'full', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Remember saffron.' }] }] }
    child.respond(first, { data: [earlier], nextCursor: 'page-2' })
    const second = await waitForRequest(child, 'thread/turns/list', child.requests.indexOf(first) + 1)
    expect(second).toMatchObject({ params: { cursor: 'page-2', itemsView: 'full', sortDirection: 'asc' } })
    const later = { id: 'turn-2', itemsView: 'full', items: [{ type: 'functionCallOutput', name: 'example', output: { text: 'cobalt' } }] }
    child.respond(second, { data: [later], nextCursor: null })
    await expect(reading).resolves.toEqual([earlier, later])
    expect(child.requests.some(request => request.method === 'thread/start' || request.method === 'turn/start')).toBe(false)
  })

  it('rejects native summary history instead of silently replaying incomplete context', async () => {
    const { server, child } = createServer()
    const reading = server.readThreadHistory('history-source', new AbortController().signal)
    const rejected = expect(reading).rejects.toThrow(/full Thread items/)
    child.respond(await waitForRequest(child, 'thread/turns/list'), {
      data: [{ id: 'turn-1', itemsView: 'summary', items: [] }], nextCursor: null
    })
    await rejected
  })

  it.each([
    'MCP schema larger than 50 MiB',
    'several individually valid descriptions',
    'multibyte schema text',
    'JSON escaped schema text',
    'large schema key',
    'public identity expansion'
  ])('rejects the aggregate interaction budget for %s without ending the turn', async (scenario) => {
    const { server, child } = createServer()
    const events = await startFakeTurn(server, child, 'turn-budget', false, false)
    const request = oversizedInteractionRequest(scenario)
    expect(() => child.request(9100, request.method, {
      threadId: 'thread-1', turnId: 'turn-budget',
      interactionId: 'budget-interaction', ...request.params
    })).not.toThrow()
    expect(child.requests).toContainEqual({
      id: 9100, error: { code: -32_602, message: expect.any(String) }
    })
    expect(events.some(event => event.type === 'interaction-opened' || event.type === 'done')).toBe(false)
    expect(server.respond('budget-interaction', { actionId: 'cancel' })).toBe(false)
    expect(stateFromEvents(events, 'turn-budget').turns[0]!.interactions).toEqual([])

    child.request(9101, 'item/tool/requestUserInput', {
      threadId: 'thread-1', turnId: 'turn-budget', interactionId: 'small-interaction',
      isBlocking: true, questions: [{ id: 'q', question: 'Still available?' }]
    })
    expect(server.respond('small-interaction', { actionId: 'cancel' })).toBe(true)
    expect(child.requests).toContainEqual({ id: 9101, result: { answers: {} } })
  })

  it.each([0, 1])('checks the complete UTF-8 interaction at 8 MiB plus %i bytes', async extra => {
    const { server, child } = createServer()
    const events = await startFakeTurn(server, child, 'turn-budget', false, false)
    // An independent native protocol fixture counts its complete private shape,
    // including fixed actions, schema keys, IDs and JSON delimiters.
    const interaction = {
      id: 'budget-interaction', kind: 'mcp-elicitation',
      elicitation: { mode: 'form', requestedSchema: { description: '' }, questionId: 'values' },
      title: 'Budget test', blocksTurn: true, status: 'pending',
      actions: [
        { id: 'submit', intent: 'submit', label: '提交' },
        { id: 'deny', intent: 'deny', label: '拒绝' },
        { id: 'cancel', intent: 'cancel', label: '取消' }
      ],
      questions: [{ id: 'values', prompt: 'JSON form values', secret: false, allowOther: true, options: [] }]
    }
    const budget = 8 * 1024 * 1024
    interaction.elicitation.requestedSchema.description = 'x'.repeat(
      budget - Buffer.byteLength(JSON.stringify(interaction), 'utf8') + extra
    )
    expect(Buffer.byteLength(JSON.stringify(interaction), 'utf8')).toBe(budget + extra)
    child.request(9100, 'mcpServer/elicitation/request', {
      threadId: 'thread-1', turnId: 'turn-budget', interactionId: interaction.id,
      mode: 'form', message: interaction.title,
      requestedSchema: interaction.elicitation.requestedSchema
    })
    if (extra === 0) {
      const opened = events.find(event => event.type === 'interaction-opened')
      expect(opened?.type).toBe('interaction-opened')
      if (opened?.type !== 'interaction-opened') throw new Error('Expected admitted interaction')
      expect(Buffer.byteLength(JSON.stringify(opened.interaction), 'utf8')).toBe(budget)
      expect(server.respond(interaction.id, { actionId: 'cancel' })).toBe(true)
      expect(child.requests).toContainEqual({
        id: 9100, result: { action: 'cancel', content: null, _meta: null }
      })
    } else {
      expect(child.requests).toContainEqual({
        id: 9100, error: { code: -32_602, message: expect.any(String) }
      })
      expect(events.some(event => event.type === 'interaction-opened')).toBe(false)
    }
  })

  it.each([
    ['invalid private interaction ID', { interactionId: ' invalid ' }],
    ['NUL prompt', { questions: [{ id: 'q', question: 'a\0b' }] }],
    ['NUL header', { questions: [{ id: 'q', question: 'Q', header: 'a\0b' }] }],
    ['NUL option label', { questions: [{ id: 'q', question: 'Q', options: [{ label: 'a\0b' }] }] }],
    ['NUL option description', { questions: [{ id: 'q', question: 'Q', options: [{ label: 'A', description: 'a\0b' }] }] }],
    ['private text limit', { questions: [{ id: 'q', question: 'Q', options: [{ label: 'A', description: 'x'.repeat(8 * 1024 * 1024 + 1) }] }] }],
    ['duplicate public question IDs', { questions: [{ id: 'q', question: 'First' }, { id: 'q', question: 'Second' }] }],
    ['malformed question', { questions: [{ id: 'valid', question: 'First' }, { question: 'Missing ID' }] }],
    ['malformed option', { questions: [{ id: 'q', question: 'Q', options: [{ label: 'Valid' }, { description: 'Missing label' }] }] }],
    ['malformed question list', { questions: 'not an array' }]
  ])('rejects %s before registering or emitting an interaction', async (_name, overrides) => {
    const { server, child } = createServer()
    const events = await startFakeTurn(server, child, 'turn-interaction', false, false)
    expect(() => child.request(9000, 'item/tool/requestUserInput', {
      threadId: 'thread-1', turnId: 'turn-interaction', interactionId: 'native-interaction',
      isBlocking: true, questions: [{ id: 'q', question: 'Question', options: [{ label: 'Choice' }] }],
      ...overrides
    })).not.toThrow()
    expect(child.requests).toContainEqual({
      id: 9000, error: { code: -32_602, message: expect.any(String) }
    })
    expect(events.some(event => event.type === 'interaction-opened')).toBe(false)
    expect(server.respond('native-interaction', { actionId: 'submit', answers: {} })).toBe(false)
    expect(stateFromEvents(events, 'turn-interaction').turns[0]!.interactions).toEqual([])

    child.request(9001, 'item/tool/requestUserInput', {
      threadId: 'thread-1', turnId: 'turn-interaction', interactionId: 'valid-interaction',
      isBlocking: true, questions: [{ id: 'valid-q', question: 'Question', options: [{ label: 'Choice' }] }]
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'interaction-opened', interaction: expect.objectContaining({ id: 'valid-interaction' })
    }))
    expect(server.respond('valid-interaction', { actionId: 'cancel' })).toBe(true)
    expect(child.requests).toContainEqual({ id: 9001, result: { answers: {} } })
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['number', 42],
    ['empty', ''],
    ['blank', ' '],
    ['padded', ' message-a '],
    ['NUL', 'message\0a'],
    ['overlong', 'a'.repeat(1_025)]
  ])('rejects a %s terminal assistant identity before publishing any finals', async (_name, id) => {
    const { server, child } = createServer()
    child.autoBackgroundTerminals = true
    const events = await startFakeTurn(server, child, 'turn-invalid')
    child.notify('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-invalid', itemId: 'message-a', delta: 'Streamed answer'
    })
    child.notify('item/completed', {
      threadId: 'thread-1', turnId: 'turn-invalid',
      item: { id: 'message-a', type: 'agentMessage', text: 'Streamed answer' }
    })

    expect(() => child.notify('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-invalid', status: 'completed',
        items: [
          { id: 'message-a', type: 'agentMessage', text: 'Valid replacement' },
          { id, type: 'agentMessage', text: 'Invalid replacement' }
        ]
      }
    })).not.toThrow()
    await vi.waitFor(() => expect(events.some((event) => event.type === 'done')).toBe(true))

    expect(events.filter((event) => event.type === 'text-final')).toEqual([])
    expect(events.filter((event) => event.type === 'done')).toEqual([{ type: 'done', outcome: 'failed' }])
    expect(events).toContainEqual(expect.objectContaining({ type: 'error' }))
    const state = stateFromEvents(events, 'turn-invalid')
    expect(state.turns[0]?.answer).toBe('Streamed answer')
    expect(state.turns[0]?.timeline.filter((item) => item.kind === 'assistant')).toHaveLength(1)
    expect(state.turns[0]?.status).toBe('failed')

    child.notify('turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-invalid', status: 'completed' }
    })
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1)
  })

  it.each(['item/agentMessage/delta', 'item/completed'])(
    'rejects an invalid identity from %s without poisoning the durable state',
    async (method) => {
      const { server, child } = createServer()
      child.autoBackgroundTerminals = true
      const events = await startFakeTurn(server, child, 'turn-invalid')
      expect(() => child.notify(method, {
        threadId: 'thread-1', turnId: 'turn-invalid',
        ...(method === 'item/agentMessage/delta'
          ? { itemId: 'message\0a', delta: 'Malformed message' }
          : { item: { id: 'message\0a', type: 'agentMessage', text: 'Malformed message' } })
      })).not.toThrow()
      // The failure must settle locally even if Codex never sends a terminal notification.
      await vi.waitFor(() => expect(events).toContainEqual({ type: 'done', outcome: 'failed' }))
      expect(child.requests).toContainEqual(expect.objectContaining({ method: 'turn/interrupt' }))
      expect(events.filter((event) => event.type === 'text-delta' || event.type === 'text-final'))
        .toEqual([])
      expect(stateFromEvents(events, 'turn-invalid').turns[0]?.status).toBe('failed')
    }
  )

  it('cancels a malformed assistant message received before the turn/start acknowledgement', async () => {
    const { server, child } = createServer()
    child.autoBackgroundTerminals = true
    const events: CodexNativeEvent[] = []
    const admission = server.startTurn({
      executionId: 'execution-early', cwd: '/workspace',
      inputs: [{ type: 'text', text: 'Test transport', text_elements: [] }],
      settings: {}, signal: new AbortController().signal,
      emit: (event) => events.push(event)
    })
    const rejected = expect(admission).rejects.toThrow('agentMessage ID')
    child.respond(await waitForRequest(child, 'thread/start'), { thread: { id: 'thread-1' } })
    const start = await waitForRequest(child, 'turn/start')
    child.notify('item/agentMessage/delta', {
      threadId: 'thread-1', itemId: null, delta: 'Malformed message before acknowledgement'
    })
    child.respond(start, { turn: { id: 'turn-early' } })

    await rejected
    expect(child.requests).toContainEqual(expect.objectContaining({ method: 'turn/interrupt' }))
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'done'))
      .toEqual([{ type: 'done', outcome: 'failed' }]))
    expect(events.some((event) => event.type === 'text-delta' || event.type === 'text-final')).toBe(false)

    const nextEvents = await startFakeTurn(server, child, 'turn-next', true, true)
    child.notify('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-next', status: 'completed',
        items: [{ id: 'next-message', type: 'agentMessage', text: 'Recovered' }]
      }
    })
    await vi.waitFor(() => expect(nextEvents).toContainEqual({ type: 'done', outcome: 'completed' }))
    expect(stateFromEvents(nextEvents, 'turn-next').turns[0]?.answer).toBe('Recovered')
  })

  it('retains a valid maximum-length native identity across stream and terminal replacement', async () => {
    const { server, child } = createServer()
    child.autoBackgroundTerminals = true
    const events = await startFakeTurn(server, child, 'turn-max-id')
    const itemId = 'm'.repeat(1_024)
    child.notify('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-max-id', itemId, delta: 'Streamed'
    })
    child.notify('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-max-id', status: 'completed',
        items: [{ id: itemId, type: 'agentMessage', text: 'Final answer' }]
      }
    })
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'done', outcome: 'completed' }))
    const state = stateFromEvents(events, 'turn-max-id')
    expect(state.turns[0]?.answer).toBe('Final answer')
    expect(state.turns[0]?.timeline.filter((item) => item.kind === 'assistant')).toMatchObject([
      { itemId, content: 'Final answer', status: 'complete' }
    ])
  })

  it('retains native item identity on interleaved deltas and terminal messages', async () => {
    const { server, child } = createServer()
    child.autoBackgroundTerminals = true
    const events = await startFakeTurn(server, child, 'turn-identity')
    for (const [itemId, delta] of [['message-a', 'A'], ['message-b', 'B']]) {
      child.notify('item/agentMessage/delta', {
        threadId: 'thread-1', turnId: 'turn-identity', itemId, delta
      })
    }
    child.notify('item/completed', {
      threadId: 'thread-1', turnId: 'turn-identity',
      item: { id: 'message-c', type: 'agentMessage', text: 'C' }
    })
    child.notify('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-identity', status: 'completed',
        items: [
          { id: 'message-a', type: 'agentMessage', text: 'A final' },
          { id: 'message-b', type: 'agentMessage', text: 'B final' },
          { id: 'message-c', type: 'agentMessage', text: 'C' }
        ]
      }
    })
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'done', outcome: 'completed' }))
    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      { type: 'text-delta', itemId: 'message-a', delta: 'A' },
      { type: 'text-delta', itemId: 'message-b', delta: 'B' },
      { type: 'text-delta', itemId: 'message-c', delta: 'C' }
    ])
    expect(events.filter((event) => event.type === 'text-final')).toEqual([
      { type: 'text-final', itemId: 'message-a', text: 'A final' },
      { type: 'text-final', itemId: 'message-b', text: 'B final' },
      { type: 'text-final', itemId: 'message-c', text: 'C', displayText: 'A final\n\nB final\n\nC' }
    ])
  })

  it('preserves multibyte model metadata across arbitrary stdout chunk boundaries', async () => {
    const { server, child } = createServer()
    const models = server.listModels()
    await vi.waitFor(() => expect(child.requests.some((request) => request.method === 'model/list')).toBe(true))
    const request = child.requests.find((request) => request.method === 'model/list')!
    const response = Buffer.from(JSON.stringify({
      id: request.id,
      result: {
        data: [{
          id: 'model-1',
          model: 'gpt-test',
          displayName: '中文模型 🚀',
          description: '可以回答问题。',
          supportedReasoningEfforts: []
        }]
      }
    }) + '\n')
    for (const byte of response) child.stdout.write(Buffer.from([byte]))

    await expect(models).resolves.toMatchObject([{
      displayName: '中文模型 🚀',
      description: '可以回答问题。'
    }])
  })

  it.each(['first', 'second'] as const)(
    'cancels only the %s waiter while a shared initialization is pending',
    async (cancelledWaiter) => {
      const { server, child } = createServer(false)
      const controller = new AbortController()
      const first = server.listModels(cancelledWaiter === 'first' ? controller.signal : undefined)
      const second = server.listModels(cancelledWaiter === 'second' ? controller.signal : undefined)
      const cancelled = cancelledWaiter === 'first' ? first : second
      const survivor = cancelledWaiter === 'first' ? second : first
      const survivorResult = survivor.then((value) => ({ value }), (error) => ({ error }))
      const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
      controller.abort()

      await rejected
      expect(child.kill).not.toHaveBeenCalled()
      const initialize = child.requests.find((request) => request.method === 'initialize')!
      child.respond(initialize, {})
      await vi.waitFor(() => expect(child.requests.some((request) => request.method === 'model/list')).toBe(true))
      child.respond(child.requests.find((request) => request.method === 'model/list')!, { data: [] })

      await expect(survivorResult).resolves.toEqual({ value: [] })
      expect(spawn).toHaveBeenCalledTimes(1)
    }
  )

  it('disposes a pending shared initialization after its waiter has cancelled', async () => {
    const { server, child } = createServer(false)
    const controller = new AbortController()
    const cancelled = server.listModels(controller.signal)
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected

    await server.dispose()
    expect(child.kill).toHaveBeenCalledTimes(1)
    await expect(server.listModels()).rejects.toThrow('已关闭')
  })

  it('observes initialization failure when the caller aborts synchronously during spawn', async () => {
    const { server, child } = createServer(false)
    const controller = new AbortController()
    vi.mocked(spawn).mockImplementationOnce(() => {
      controller.abort()
      return child as unknown as ChildProcessWithoutNullStreams
    })

    await expect(server.listModels(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await server.dispose()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it.each(['stdin', 'stdout', 'stderr'] as const)(
    'fails pending requests on %s errors and reconnects without stale responses',
    async (stream) => {
      const { server, child } = createServer()
      const controller = new AbortController()
      const pending = Promise.allSettled([
        server.readUsage(controller.signal),
        server.listModels(controller.signal)
      ])
      await vi.waitFor(() => expect(child.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'account/rateLimits/read' }),
        expect.objectContaining({ method: 'model/list' })
      ])))
      const error = new Error('Codex transport pipe failed')

      expect(() => child[stream].emit('error', error)).not.toThrow()
      await expect(pending).resolves.toEqual([
        { status: 'rejected', reason: error },
        { status: 'rejected', reason: error }
      ])
      expect(child.kill).toHaveBeenCalledTimes(1)

      const replacement = new FakeChild(true)
      vi.mocked(spawn).mockReturnValue(replacement as unknown as ChildProcessWithoutNullStreams)
      const recovered = server.readUsage()
      await vi.waitFor(() => expect(replacement.requests.some(
        (request) => request.method === 'account/rateLimits/read'
      )).toBe(true))
      const request = replacement.requests.find(
        (entry) => entry.method === 'account/rateLimits/read'
      )!
      child.respond(request, { generation: 'stale' })
      replacement.respond(request, { generation: 'current' })

      await expect(recovered).resolves.toEqual({ generation: 'current' })
      expect(spawn).toHaveBeenCalledTimes(2)
    }
  )

  it('waits for a failed previous process to close before disposal returns', async () => {
    const { server, child } = createServer()
    const pending = server.readUsage().catch((error: unknown) => error)
    await vi.waitFor(() => expect(child.requests.some(
      (request) => request.method === 'account/rateLimits/read'
    )).toBe(true))
    child.kill.mockImplementation((signal) => {
      child.signalCode = signal
      return true
    })
    const error = new Error('Native process failure')
    child.emit('error', error)
    await expect(pending).resolves.toBe(error)

    let disposed = false
    const disposal = server.dispose().then(() => { disposed = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      expect(disposed).toBe(false)
      expect(child.kill).toHaveBeenCalledTimes(1)
    } finally {
      child.emit('close', null, 'SIGTERM')
      await disposal
    }
  })

  it('keeps a reconnected turn alive when the previous turn finishes its background refresh', async () => {
    vi.useFakeTimers()
    const { server, child } = createServer()
    const previousEvents = await startFakeTurn(server, child, 'turn-1')
    child.notify('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' }
    })
    await waitForRequest(child, 'thread/backgroundTerminals/list')
    child.exitCode = 1
    child.emit('close', 1)

    const replacement = new FakeChild(true)
    replacement.autoBackgroundTerminals = true
    vi.mocked(spawn).mockReturnValue(replacement as unknown as ChildProcessWithoutNullStreams)
    const currentEvents = await startFakeTurn(server, replacement, 'turn-2', true)
    const activities: CodexNativeActivityEvent[] = []
    server.subscribeNativeActivity((event) => activities.push(event))
    await vi.advanceTimersByTimeAsync(100)
    const staleRequests = replacement.requests.filter(
      (request) => request.method === 'thread/backgroundTerminals/list'
    )
    await vi.waitFor(() => expect(previousEvents).toContainEqual({
      type: 'done', outcome: 'completed'
    }), { interval: 1 })

    replacement.notify('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-2', itemId: 'message-2', delta: 'Still connected.'
    })
    expect(currentEvents).toContainEqual({ type: 'text-delta', itemId: 'message-2', delta: 'Still connected.' })
    expect(staleRequests).toHaveLength(0)
    expect(activities).not.toContainEqual(expect.objectContaining({ type: 'status-cleared' }))

    replacement.notify('turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' }
    })
    await vi.waitFor(() => expect(currentEvents).toContainEqual({
      type: 'done', outcome: 'completed'
    }), { interval: 1 })
  })
})

function oversizedInteractionRequest(scenario: string) {
  const mib = 1024 * 1024
  if (scenario === 'several individually valid descriptions' || scenario === 'public identity expansion') {
    return {
      method: 'item/tool/requestUserInput', params: {
        isBlocking: true,
        questions: [{ id: 'q', question: 'Question', options: scenario === 'public identity expansion'
          ? Array.from({ length: 100_000 }, () => ({ label: 'A' }))
          : Array.from({ length: 7 }, () => ({ label: 'A', description: 'x'.repeat(7.5 * mib) }))
        }]
      }
    }
  }
  return {
    method: 'mcpServer/elicitation/request', params: {
      mode: 'form', message: 'Budget test',
      requestedSchema: scenario === 'large schema key'
        ? { ['k'.repeat(8 * mib)]: true }
        : { description: scenario === 'multibyte schema text'
          ? '界'.repeat(3 * mib)
          : scenario === 'JSON escaped schema text'
            ? '\n'.repeat(5 * mib)
            : 'x'.repeat(51 * mib)
        }
    }
  }
}

function stateFromEvents(events: readonly CodexNativeEvent[], turnId: string) {
  const executionId = `execution-${turnId}`
  let state = stageCodexExecution(
    createEmptyCodexState(0), executionId,
    { parts: [{ kind: 'text', text: 'Test transport' }] }, 1, 'prompt'
  )
  for (const event of events) {
    state = reduceCodexEvent(state, executionId, event, state.updatedAt + 1, 'native-event')
  }
  return decodeCodexState(JSON.parse(JSON.stringify(state)))
}

async function startFakeTurn(
  server: CodexAppServer,
  child: FakeChild,
  turnId: string,
  resume = false,
  alreadyLoaded = false
): Promise<CodexNativeEvent[]> {
  const events: CodexNativeEvent[] = []
  const requestOffset = child.requests.length
  const admission = server.startTurn({
    executionId: `execution-${turnId}`,
    cwd: '/workspace',
    inputs: [{ type: 'text', text: 'Test transport', text_elements: [] }],
    settings: {},
    ...(resume ? { sessionId: 'thread-1' } : {}),
    signal: new AbortController().signal,
    emit: (event) => events.push(event)
  })
  if (!alreadyLoaded) {
    child.respond(await waitForRequest(child, resume ? 'thread/resume' : 'thread/start', requestOffset), {
      thread: { id: 'thread-1' }
    })
  }
  child.respond(await waitForRequest(child, 'turn/start', requestOffset), { turn: { id: turnId } })
  await admission
  return events
}

async function waitForRequest(child: FakeChild, method: string, offset = 0): Promise<WireRequest> {
  return vi.waitFor(() => {
    const request = child.requests.slice(offset).find((entry) => entry.method === method)
    expect(request).toBeDefined()
    return request!
  }, { interval: 1 })
}

function createServer(autoInitialize = true): { server: CodexAppServer; child: FakeChild } {
  const child = new FakeChild(autoInitialize)
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams)
  const server = new CodexAppServer('/fake/codex', {})
  servers.push(server)
  return { server, child }
}

class FakeChild extends EventEmitter {
  readonly requests: WireRequest[] = []
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  autoBackgroundTerminals = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kill = vi.fn((signal: NodeJS.Signals) => {
    this.signalCode = signal
    this.emit('close', null, signal)
    return true
  })

  constructor(autoInitialize: boolean) {
    super()
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const request = JSON.parse(chunk.toString('utf8')) as WireRequest
        this.requests.push(request)
        if (request.method === 'initialize' && autoInitialize) {
          queueMicrotask(() => this.respond(request, {}))
        }
        if (request.method === 'thread/backgroundTerminals/list' && this.autoBackgroundTerminals) {
          queueMicrotask(() => this.respond(request, { data: [] }))
        }
        callback()
      }
    })
  }

  respond(request: WireRequest, result: unknown): void {
    this.stdout.write(JSON.stringify({ id: request.id, result }) + '\n')
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(JSON.stringify({ method, params }) + '\n')
  }

  request(id: number, method: string, params: unknown): void {
    this.stdout.write(JSON.stringify({ id, method, params }) + '\n')
  }
}
