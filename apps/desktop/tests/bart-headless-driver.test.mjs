import { describe, expect, it, vi } from 'vitest'
import { BartDriver } from './bart-headless/bart.mjs'
import { HeadlessClient } from './bart-headless/headless.mjs'
import { ScenarioContext } from './bart-headless/scenario.mjs'

describe('Bart headless acceptance driver', () => {
  it('retains a streamed running snapshot that disappears before the next poll', async () => {
    const client = new HeadlessClient({ port: 0, timeoutMs: 1_000 })
    client.loadState = async () => state({ revision: 0 })
    const waiting = client.waitForState(candidate => (
      candidate.executions[0]?.executionId
    ), 'transient Bart execution')
    await Promise.resolve()
    client.observe(state({
      revision: 1,
      execution: {
        threadId: 'bart-thread',
        executionId: 'transient-execution',
        status: 'running',
        startedAt: 1
      }
    }))
    client.observe(state({ revision: 2 }))

    await expect(waiting).resolves.toBe('transient-execution')
  })

  it('binds the exact completed tool sequence to the submitted Bart Execution', async () => {
    const client = new FakeBartClient([
      operation('operation-1', 'execution-user', 'thread_status'),
      operation('operation-2', 'execution-user', 'thread_list')
    ])
    const driver = new BartDriver(client)

    await expect(driver.askForTools({
      directive: 'Run the exact two calls.',
      expect: [
        { name: 'thread_status', expectedArguments: { threadId: 'thread-1' } },
        { name: 'thread_list', expectedArguments: {} }
      ]
    })).resolves.toEqual([
      expect.objectContaining({ id: 'operation-1', executionId: 'execution-user' }),
      expect.objectContaining({ id: 'operation-2', executionId: 'execution-user' })
    ])
  })

  it.each(['failed', 'interrupted'])('rejects a %s Bart host after the expected Core tool succeeds', async status => {
    const completed = operation('operation-1', 'execution-user', 'thread_status')
    const driver = new BartDriver(new FakeBartClient([completed], status))

    const result = driver.askForTools({
      directive: 'Run one exact call.',
      expect: [{ name: completed.name, expectedArguments: completed.arguments }]
    })
    await expect(result).rejects.toThrow(`Bart host did not complete: ${status}`)
    await expect(result).rejects.toMatchObject({ invariantId: 'bart.host.completed' })
  })

  it.each(['completed', 'failed', 'interrupted'])('distinguishes an expected Core tool rejection from a %s host', async status => {
    const rejected = {
      ...operation('operation-1', 'execution-user', 'thread_status'),
      isError: true,
      result: { ok: false, error: 'Thread does not exist' }
    }
    const driver = new BartDriver(new FakeBartClient([rejected], status))
    const result = driver.askForToolFailure({
      directive: 'Try the exact invalid Thread.',
      name: rejected.name,
      expectedArguments: rejected.arguments,
      errorPattern: /Thread does not exist/
    })

    if (status === 'completed') {
      await expect(result).resolves.toEqual({ operation: rejected, message: rejected.result.error })
    } else {
      await expect(result).rejects.toThrow(`Bart host did not complete: ${status}`)
    }
  })

  it.each(['completed', 'failed', 'interrupted'])('requires a completed host for a plain ask ending %s', async status => {
    const driver = new BartDriver(new FakeBartClient([], status))
    const result = driver.ask('Return the completion marker.')

    if (status === 'completed') {
      await expect(result).resolves.toEqual([userMessage('Return the completion marker.')])
    } else {
      await expect(result).rejects.toThrow(`Bart host did not complete: ${status}`)
    }
  })

  it.each([
    {
      label: 'an unexpected extra call',
      operations: [
        operation('operation-1', 'execution-user', 'thread_status'),
        operation('operation-2', 'execution-user', 'report_list')
      ],
      error: /unexpected number of tool calls/
    },
    {
      label: 'a duplicate expected call',
      operations: [
        operation('operation-1', 'execution-user', 'thread_status'),
        operation('operation-2', 'execution-user', 'thread_status')
      ],
      error: /unexpected number of tool calls/
    },
    {
      label: 'a matching call from another execution',
      operations: [
        operation('operation-1', 'execution-other', 'thread_status')
      ],
      error: /another Bart Execution/
    }
  ])('rejects $label', async ({ operations, error }) => {
    const driver = new BartDriver(new FakeBartClient(operations))

    await expect(driver.askForTools({
      directive: 'Run one exact call.',
      expect: [{
        name: 'thread_status',
        expectedArguments: { threadId: 'thread-1' }
      }]
    })).rejects.toThrow(error)
  })

  it('responds only to the current Bart host permission while preserving the exact Core tool sequence', async () => {
    const operations = [
      operation('operation-1', 'execution-user', 'thread_status'),
      operation('operation-2', 'execution-user', 'thread_list')
    ]
    const client = new HostPermissionClient(operations)
    const driver = new BartDriver(client)
    await expect(driver.askForTools({
      directive: 'Run the exact two calls.',
      expect: [
        { name: 'thread_status', expectedArguments: { threadId: 'thread-1' } },
        { name: 'thread_list', expectedArguments: {} }
      ]
    })).resolves.toEqual(operations)

    expect(client.invocations).toEqual([
      { channel: 'bart:submit', payload: { input: { parts: [{ kind: 'text', text: 'Run the exact two calls.' }] } } },
      { channel: 'thread:interaction-respond', payload: {
        threadId: 'bart-thread', interactionId: 'host-permission', actionId: 'allow'
      } }
    ])
    expect(driver.hostInteractions).toEqual([expect.objectContaining({
      threadId: 'bart-thread',
      executionId: 'execution-user',
      waiting: expect.objectContaining({ status: 'waiting-for-user' }),
      interaction: expect.objectContaining({ id: 'host-permission', kind: 'permission' }),
      action: expect.objectContaining({ id: 'allow', intent: 'allow' }),
      response: expect.objectContaining({ status: 'accepted' })
    })])
    const target = client.state.threads.find(thread => thread.id === 'thread-1')
    expect(target.observation.latestExecution.status).toBe('waiting-for-user')
  })

  it('rejects any attempt to use the direct response seam for a delegated Thread', async () => {
    const client = new HostPermissionClient([])
    const driver = new BartDriver(client)
    await expect(driver.respondToHostPermission({
      threadId: 'thread-1', executionId: 'target-execution', interactionId: 'target-permission'
    })).rejects.toThrow('restricted to the current Bart host')
    expect(client.invocations).toEqual([])
  })

  it('fails an unexpected Bart host question without submitting an answer', async () => {
    const client = new HostPermissionClient([], {
      ...permission('host-question'), kind: 'question',
      actions: [{ id: 'submit', intent: 'submit', label: 'Submit' }]
    })
    const driver = new BartDriver(client)
    await expect(driver.askForTools({
      directive: 'Run one exact call.',
      expect: [{ name: 'thread_list', expectedArguments: {} }]
    })).rejects.toThrow('Unsupported Bart host interaction: question')
    expect(client.invocations.map(call => call.channel)).toEqual(['bart:submit'])
    expect(driver.hostInteractions[0]).toMatchObject({
      interaction: { kind: 'question' }, response: { status: 'failed' }
    })
  })

  it('approves sequential public permissions until terminal completion', async () => {
    const second = permission('public-permission-2')
    const terminal = {
      executionId: 'execution-1',
      status: 'completed',
      startedAt: 1,
      finishedAt: 2,
      summary: 'done'
    }
    const snapshots = [
      threadObservation({ status: 'waiting-for-user', interactions: [second] }),
      threadObservation(terminal)
    ]
    const client = {
      timeoutMs: 1_000,
      waitForThread: vi.fn(async (_threadId, predicate) => predicate(snapshots.shift()))
    }
    const context = scenarioContext(client)
    context.respond = vi.fn(async () => undefined)

    await expect(context.allowPermissionChain({
      threadId: 'thread-1',
      interaction: permission('public-permission-1'),
      maxPermissions: 3,
      timeoutMs: 500
    })).resolves.toEqual({
      terminal,
      interactionIds: ['public-permission-1', 'public-permission-2']
    })
    expect(context.respond).toHaveBeenNthCalledWith(1, expect.objectContaining({
      threadId: 'thread-1',
      interaction: expect.objectContaining({ id: 'public-permission-1' }),
      actionId: 'allow',
      timeoutMs: expect.any(Number)
    }))
    expect(context.respond).toHaveBeenNthCalledWith(2, expect.objectContaining({
      threadId: 'thread-1',
      interaction: expect.objectContaining({ id: 'public-permission-2' }),
      actionId: 'allow',
      timeoutMs: expect.any(Number)
    }))
    expect(client.waitForThread).toHaveBeenCalledWith(
      'thread-1',
      expect.any(Function),
      'thread thread-1 permission chain',
      expect.any(Number)
    )
  })

  it('fails closed when a permission chain exceeds its interaction bound', async () => {
    const client = {
      timeoutMs: 1_000,
      waitForThread: vi.fn(async (_threadId, predicate) => predicate(
        threadObservation({
          status: 'waiting-for-user',
          interactions: [permission('public-permission-2')]
        })
      ))
    }
    const context = scenarioContext(client)
    context.respond = vi.fn(async () => undefined)

    await expect(context.allowPermissionChain({
      threadId: 'thread-1',
      interaction: permission('public-permission-1'),
      maxPermissions: 1,
      timeoutMs: 500
    })).rejects.toThrow('permission chain exceeded 1 interactions')
    expect(context.respond).toHaveBeenCalledTimes(1)
  })

  it('preserves separate oracle identities for native completion before and after approval', async () => {
    const client = { timeoutMs: 1_000,
      waitForThread: async (_id, predicate) => predicate(threadObservation({ status: 'failed' })) }
    const context = scenarioContext(client)
    context.respond = async () => undefined
    await expect(context.waitForCompleted('thread-1'))
      .rejects.toMatchObject({ invariantId: 'native.completed' })
    await expect(context.allowPermissionChain({ threadId: 'thread-1', interaction: permission('p1') }))
      .rejects.toMatchObject({ invariantId: 'permission.chain.completed' })
  })
})

function scenarioContext(client) {
  return new ScenarioContext({
    client,
    bart: {},
    harness: 'claude',
    config: {},
    suiteId: 'permission',
    caseId: 'allow',
    label: 'claude/permission:allow',
    runRoot: '/tmp/run',
    proofRoot: '/tmp/proofs',
    repositoryRoot: '/tmp/repository',
    token: 'TEST_TOKEN'
  })
}

function permission(id) {
  return {
    id,
    kind: 'permission',
    title: 'Allow native tool?',
    actions: [{ id: 'allow', intent: 'allow', label: 'Allow' }],
    questions: []
  }
}

function threadObservation(latestExecution) {
  return {
    id: 'thread-1',
    observation: { latestExecution, backgroundWork: null }
  }
}

class FakeBartClient {
  constructor(operations, terminalStatus = 'completed') {
    this.operations = operations
    this.terminalStatus = terminalStatus
    this.waiters = new Set()
    this.state = state({ revision: 0 })
  }

  async waitForBartIdle() {
    if (this.state.executions.length === 0) return this.state
    return this.waitForState(candidate => (
      candidate.executions.length === 0 ? candidate : undefined
    ))
  }

  async loadState() {
    return this.state
  }

  async invoke(channel, payload) {
    expect(channel).toBe('bart:submit')
    const directive = payload.input.parts[0].text
    this.publish(state({
      revision: 1,
      execution: {
        threadId: 'bart-thread',
        executionId: 'execution-user',
        status: 'running',
        startedAt: 1
      },
      latestExecution: {
        executionId: 'execution-user',
        status: 'running',
        startedAt: 1
      },
      transcript: [userMessage(directive)]
    }))
    await Promise.resolve()
    this.publish(state({
      revision: 2,
      latestExecution: {
        executionId: 'execution-user',
        status: this.terminalStatus,
        startedAt: 1,
        finishedAt: 2
      },
      transcript: [userMessage(directive), ...this.operations]
    }))
    return null
  }

  waitForState(predicate) {
    const immediate = predicate(this.state)
    if (immediate !== undefined) return Promise.resolve(immediate)
    return new Promise(resolve => {
      const inspect = () => {
        const result = predicate(this.state)
        if (result === undefined) return
        this.waiters.delete(inspect)
        resolve(result)
      }
      this.waiters.add(inspect)
    })
  }

  publish(next) {
    this.state = next
    for (const waiter of [...this.waiters]) waiter()
  }
}

class HostPermissionClient extends FakeBartClient {
  constructor(operations, interaction = permission('host-permission')) {
    super(operations)
    this.timeoutMs = 1_000
    this.interaction = interaction
    this.invocations = []
    this.submission = new Promise(resolve => { this.finishSubmission = resolve })
    this.state = this.withWaitingTarget(this.state)
  }

  withWaitingTarget(snapshot) {
    return {
      ...snapshot,
      threads: [...snapshot.threads, {
        id: 'thread-1', harnessId: 'pi',
        observation: {
          latestExecution: { executionId: 'target-execution', status: 'waiting-for-user', startedAt: 1,
            interactions: [permission('target-permission')] },
          backgroundWork: null
        }
      }]
    }
  }

  async invoke(channel, payload) {
    this.invocations.push({ channel, payload })
    if (channel === 'bart:submit') {
      this.directive = payload.input.parts[0].text
      this.publish(this.withWaitingTarget(state({
        revision: 1,
        execution: { threadId: 'bart-thread', executionId: 'execution-user', status: 'running', startedAt: 1 },
        latestExecution: { executionId: 'execution-user', status: 'running', startedAt: 1 },
        transcript: [userMessage(this.directive)]
      })))
      await Promise.resolve()
      this.publish(this.withWaitingTarget(state({
        revision: 2,
        execution: { threadId: 'bart-thread', executionId: 'execution-user', status: 'waiting-for-user', startedAt: 1 },
        latestExecution: { executionId: 'execution-user', status: 'waiting-for-user', startedAt: 1,
          interactions: [this.interaction] },
        transcript: [userMessage(this.directive)]
      })))
      // Exercise a transport that keeps submission pending until the native
      // permission is answered: the driver must observe/respond concurrently.
      return this.submission
    }
    expect(channel).toBe('thread:interaction-respond')
    expect(payload).toEqual({ threadId: 'bart-thread', interactionId: 'host-permission', actionId: 'allow' })
    this.publish(this.withWaitingTarget(state({
      revision: 3,
      latestExecution: { executionId: 'execution-user', status: 'completed', startedAt: 1, finishedAt: 2 },
      transcript: [userMessage(this.directive), ...this.operations]
    })))
    this.finishSubmission(null)
    return null
  }
}

function state({
  revision,
  execution,
  latestExecution = null,
  transcript = []
}) {
  return {
    revision,
    executions: execution ? [execution] : [],
    threads: [{
      id: 'bart-thread',
      bart: true,
      observation: { latestExecution, backgroundWork: null },
      transcript
    }],
    reports: [],
    selectedThreadId: 'bart-thread',
    settings: {}
  }
}

function userMessage(content) {
  return {
    type: 'message',
    id: 'user-message',
    role: 'user',
    content,
    createdAt: 1,
    status: 'complete'
  }
}

function operation(id, executionId, name) {
  return {
    type: 'tool-operation',
    id,
    executionId,
    callId: `call-${id}`,
    name,
    arguments: name === 'thread_status' ? { threadId: 'thread-1' } : {},
    createdAt: 1,
    completedAt: 2,
    result: { ok: true }
  }
}
