import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentThreadRecord, HarnessThreadInjection } from '@openagent/contracts'
import { CodexRuntime } from '../src/main/runtime/index.js'
import { CodexAppServer } from '../src/main/runtime/app-server.js'
import { openCodexThread } from '../src/main/thread/thread-handle.js'
import { codexSessionState } from '../src/shared/session-state.js'
import type { CodexThreadSettings } from '../src/shared/types.js'
import { createAgentOpenContext } from '@openagent/test-kit'

const fixture = resolve(import.meta.dirname, '../../../apps/desktop/tests/fixtures/fake-codex-app-server.mjs')
const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Codex generic Thread injection', () => {
  it.each(['extend', 'exclusive'] as const)('installs instructions, context and %s tools before the first model request', async mode => {
    const test = await setup()
    const execute = vi.fn(async () => ({ value: 'tool-result' }))
    const injection: HarnessThreadInjection = {
      instructions: ['Thread instruction: use the supplied context.'],
      contextEntries: [{ id: 'workspace', content: 'Thread context proof.' }],
      seed: [{ type: 'message', role: 'assistant', content: 'Historical context proof.' }],
      tools: {
        mode,
        bindings: [{
          name: 'example_tool', description: 'Example tool',
          inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
          outputSchema: { type: 'object', properties: { value: { type: 'string' } } },
          execute
        }]
      }
    }
    const handle = await openCodexThread(test.runtime, { ...test.context(), injection })
    try {
      await handle.send({
        executionId: 'injected-turn', input: { parts: [{ kind: 'text', text: 'Call the example tool.' }] },
        contextEntries: [{ id: 'run', content: 'Run context proof.' }],
        signal: new AbortController().signal
      })
      await vi.waitFor(() => expect(test.record().observation.latestExecution?.status).toBe('completed'))
      const wire = await test.wire()
      const startIndex = wire.findIndex(message => message.method === 'thread/start')
      const turnIndex = wire.findIndex(message => message.method === 'turn/start')
      expect(startIndex).toBeLessThan(turnIndex)
      const start = wire[startIndex]!.params!
      expect(start.developerInstructions).toContain('Thread instruction: use the supplied context.')
      expect(start.developerInstructions).toContain('Thread context proof.')
      expect(start.developerInstructions).toContain('Historical context proof.')
      expect(start.dynamicTools).toEqual([{
        type: 'function', name: 'example_tool', description: 'Example tool',
        inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } }
      }])
      expect(wire[turnIndex]!.params!.input).toEqual([
        { type: 'text', text: '<openagent_run_context id="run">\nRun context proof.\n</openagent_run_context>', text_elements: [] },
        { type: 'text', text: 'Call the example tool.', text_elements: [] }
      ])
      expect(execute).toHaveBeenCalledWith({
        callId: 'dynamic-tool-1', arguments: { prompt: 'Run tests' }, signal: expect.any(AbortSignal)
      })
      if (mode === 'exclusive') {
        expect(start.config).toMatchObject({
          features: { shell_tool: false, plugins: false, multi_agent: false },
          apps: { _default: { enabled: false } },
          tools: { web_search: false, update_plan: { enabled: false } }
        })
      } else {
        expect(start.config).toEqual({ tools: { update_plan: { enabled: true } } })
      }
    } finally {
      await handle.dispose()
    }
  })

  it.each([undefined, 'exclusive'] as const)('keeps native approval and respond available with tool mode %s', async mode => {
    const test = await setup()
    const handle = await openCodexThread(test.runtime, {
      ...test.context(),
      ...(mode ? { injection: { tools: { mode, bindings: [] } } } : {})
    })
    try {
      await handle.send({
        executionId: 'approval-turn', input: { parts: [{ kind: 'text', text: 'Run the task.' }] },
        signal: new AbortController().signal
      })
      await vi.waitFor(() => expect(test.record().observation.latestExecution?.status).toBe('waiting-for-user'))
      const execution = test.record().observation.latestExecution!
      if (execution.status !== 'waiting-for-user') throw new Error('Expected native interaction')
      const interaction = execution.interactions[0]!
      await handle.respond({ interactionId: interaction.id, actionId: interaction.actions.find(action => action.intent === 'allow')!.id })
      await vi.waitFor(() => expect(test.record().observation.latestExecution?.status).toBe('completed'))
      const start = (await test.wire()).find(message => message.method === 'thread/start')!.params!
      expect(start.approvalPolicy).toBe('on-request')
      expect(start).not.toHaveProperty('dynamicTools')
      if (mode) expect(start.config).toMatchObject({ features: { shell_tool: false } })
      else expect(start.config).toEqual({ tools: { update_plan: { enabled: true } } })
    } finally {
      await handle.dispose()
    }
  })

  it('rejects unsupported tool modes and duplicate tool names before allocating a native transport', async () => {
    const test = await setup()
    const server = vi.spyOn(test.runtime, 'server')
    const binding = { name: 'duplicate', description: 'Tool', inputSchema: {}, execute: async () => null }
    for (const tools of [
      { mode: 'unsupported', bindings: [] },
      { mode: 'extend', bindings: [binding, binding] }
    ]) {
      await expect(openCodexThread(test.runtime, {
        ...test.context(), injection: { tools } as HarnessThreadInjection
      })).rejects.toThrow(/tool mode|unique/)
    }
    expect(server).not.toHaveBeenCalled()
    expect(test.record().sessionState).toBeNull()
  })

  it.each([undefined, 'exclusive'] as const)('retains the native session and plan setting on %s reopen', async mode => {
    const test = await setup()
    const injection: HarnessThreadInjection = mode ? { tools: { mode, bindings: [] } } : {}
    const first = await openCodexThread(test.runtime, { ...test.context(), injection })
    await first.send({
      executionId: 'first-turn', input: { parts: [{ kind: 'text', text: 'First task.' }] },
      signal: new AbortController().signal
    })
    await vi.waitFor(() => expect(test.record().observation.latestExecution?.status).toBe('waiting-for-user'))
    await first.interrupt()
    await first.dispose()
    const reopened = await openCodexThread(test.runtime, {
      ...test.context(), injection: { ...injection, instructions: ['Refreshed thread instructions.'] }
    })
    try {
      await reopened.send({
        executionId: 'reopened-turn', input: { parts: [{ kind: 'text', text: 'Continue the task.' }] },
        signal: new AbortController().signal
      })
      await vi.waitFor(() => expect(test.record().observation.latestExecution?.status).toBe('waiting-for-user'))
      const wire = await test.wire()
      expect(wire.filter(message => message.method === 'thread/start')).toHaveLength(1)
      expect(wire.find(message => message.method === 'thread/resume')?.params).toMatchObject({
        threadId: 'thread-1', developerInstructions: 'Refreshed thread instructions.',
        config: { tools: { update_plan: { enabled: !mode } } }
      })
    } finally {
      await reopened.dispose()
    }
  })

  it('rotates native tools through full history context while retaining the public Thread and earlier replay seeds', async () => {
    const test = await setup()
    await completeOrdinaryTurn(test)
    const originalSession = (test.record().sessionState as { primarySessionId: string }).primarySessionId
    const histories = [
      [{ id: 'old-turn', itemsView: 'full', status: 'completed', items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'Remember the token saffron.' }] },
        { type: 'functionCallOutput', name: 'old_tool', output: { text: 'Tool result cobalt.' } },
        { type: 'agentMessage', text: 'I remember saffron and cobalt.' }
      ] }],
      [{ id: 'later-turn', itemsView: 'full', status: 'completed', items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'Also remember juniper.' }] }
      ] }]
    ]
    const readThreadHistory = vi.fn().mockResolvedValueOnce(histories[0]).mockResolvedValueOnce(histories[1])
    let nativeSequence = 0
    const startTurn = vi.fn(async (options: import('../src/main/runtime/app-server.js').CodexTurnOptions) => {
      const sessionId = options.sessionId ?? `rotated-native-${++nativeSequence}`
      options.emit({ type: 'session', sessionId })
      queueMicrotask(() => options.emit({ type: 'done', outcome: 'completed' }))
      return { sessionId, steer: async () => undefined, cancel: async () => undefined }
    })
    const native = {
      readThreadHistory, startTurn, subscribeNativeActivity: () => () => undefined,
      dispose: vi.fn(async () => undefined)
    } as unknown as CodexAppServer
    vi.spyOn(test.runtime, 'server').mockResolvedValue({ executable: fixture, environment: {}, server: native })
    const injection: HarnessThreadInjection = { tools: { mode: 'exclusive', bindings: [{
      name: 'new_tool', description: 'Current tool', inputSchema: { type: 'object' }, execute: async () => null
    }] } }
    const rotated = await openCodexThread(test.runtime, { ...test.context(), injection })
    expect((test.record().sessionState as { primarySessionId: string }).primarySessionId).toBe(originalSession)
    expect(readThreadHistory).toHaveBeenCalledWith(originalSession, expect.any(AbortSignal))
    await sendAndWait(rotated, test, 'rotated-turn')
    expect(startTurn.mock.calls[0]![0]).not.toHaveProperty('sessionId')
    expect(startTurn.mock.calls[0]![0].toolBindings?.map(tool => tool.name)).toEqual(['new_tool'])
    expect(startTurn.mock.calls[0]![0].developerInstructions).toContain('saffron')
    expect(startTurn.mock.calls[0]![0].developerInstructions).toContain('Tool result cobalt.')
    expect((test.record().sessionState as { primarySessionId: string }).primarySessionId).toBe('rotated-native-1')
    await rotated.dispose()

    const matching = await openCodexThread(test.runtime, { ...test.context(), injection })
    await sendAndWait(matching, test, 'matching-turn')
    expect(readThreadHistory).toHaveBeenCalledTimes(1)
    expect(startTurn.mock.lastCall![0].sessionId).toBe('rotated-native-1')
    expect(startTurn.mock.lastCall![0].developerInstructions).toContain('saffron')
    await matching.dispose()

    const changed: HarnessThreadInjection = { tools: { mode: 'extend', bindings: [] } }
    const again = await openCodexThread(test.runtime, { ...test.context(), injection: changed })
    await sendAndWait(again, test, 'second-rotation')
    expect(startTurn.mock.lastCall![0]).not.toHaveProperty('sessionId')
    expect(startTurn.mock.lastCall![0].developerInstructions).toContain('saffron')
    expect(startTurn.mock.lastCall![0].developerInstructions).toContain('juniper')
    expect((test.record().sessionState as { primarySessionId: string }).primarySessionId).toBe('rotated-native-2')
    await again.dispose()
  })

  it.each(['unavailable', 'oversize'] as const)('retains original native identity when full history replay is %s', async scenario => {
    const test = await setup()
    await completeOrdinaryTurn(test)
    const before = structuredClone(test.record())
    const readThreadHistory = scenario === 'unavailable'
      ? vi.fn(async () => { throw new Error('Full history unavailable') })
      : vi.fn(async () => [{ items: [{ text: 'x'.repeat(8 * 1024 * 1024) }] }])
    const dispose = vi.fn(async () => undefined)
    const startTurn = vi.fn()
    vi.spyOn(test.runtime, 'server').mockResolvedValue({
      executable: fixture, environment: {}, server: { readThreadHistory, startTurn, dispose } as unknown as CodexAppServer
    })
    await expect(openCodexThread(test.runtime, {
      ...test.context(), injection: { tools: { mode: 'exclusive', bindings: [] } }
    })).rejects.toThrow(scenario === 'unavailable' ? /unavailable/ : /8 MiB/)
    expect(test.record()).toEqual(before)
    expect(startTurn).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('rejects native tool rotation while the recorded execution still waits for a user', async () => {
    const test = await setup()
    const active = await openCodexThread(test.runtime, test.context())
    try {
      await active.send({ executionId: 'active', input: { parts: [{ kind: 'text', text: 'Work' }] }, signal: new AbortController().signal })
      await vi.waitFor(() => expect(test.record().observation.latestExecution?.status).toBe('waiting-for-user'))
      const before = structuredClone(test.record())
      const acquire = vi.spyOn(test.runtime, 'server')
      await expect(openCodexThread(test.runtime, {
        ...test.context(), injection: { tools: { mode: 'exclusive', bindings: [] } }
      })).rejects.toThrow(/execution or background work is active/)
      expect(acquire).not.toHaveBeenCalled()
      expect(test.record()).toEqual(before)
    } finally {
      await active.dispose()
    }
  })

  it('refuses a Thread Read while a native rotation is pending', async () => {
    const test = await setup()
    let nativeSequence = 0
    const startTurn = vi.fn(async (options: import('../src/main/runtime/app-server.js').CodexTurnOptions) => {
      const sessionId = options.sessionId ?? `exclusive-native-${++nativeSequence}`
      options.emit({ type: 'session', sessionId })
      queueMicrotask(() => options.emit({ type: 'done', outcome: 'completed' }))
      return { sessionId, steer: async () => undefined, cancel: async () => undefined }
    })
    const acquire = vi.spyOn(test.runtime, 'server').mockResolvedValue({
      executable: fixture, environment: {},
      server: {
        startTurn,
        readThreadHistory: vi.fn(async () => [
          { id: 'old-turn', itemsView: 'full', status: 'completed', items: [] }
        ]),
        dispose: vi.fn(async () => undefined)
      } as unknown as CodexAppServer
    })
    const exclusive: HarnessThreadInjection = { tools: { mode: 'exclusive', bindings: [] } }
    const bound = await openCodexThread(test.runtime, { ...test.context(), injection: exclusive })
    await sendAndWait(bound, test, 'exclusive-turn')
    await bound.dispose()

    // Reopened without an injection, this source has no *current* injection, so
    // the injection guard alone does not cover it: the bound Primary Session was
    // created under the exclusive tool configuration, so this open prepares a
    // rotation. A read would fork that old session on the standard runtime
    // without the rotation's history seed.
    const rotating = await openCodexThread(test.runtime, test.context())
    try {
      const acquired = acquire.mock.calls.length
      await expect(rotating.read('Summarize the Thread.', new AbortController().signal))
        .rejects.toThrow('pending native rotation')
      expect(acquire.mock.calls.length).toBe(acquired)
    } finally {
      await rotating.dispose()
    }
  })

  it('cancels active tool callbacks and releases copied credentials with the Thread Handle', async () => {
    const test = await setup()
    let toolSignal: AbortSignal | undefined
    const handle = await openCodexThread(test.runtime, {
      ...test.context(), injection: { tools: { mode: 'exclusive', bindings: [{
        name: 'long_tool', description: 'Long tool', inputSchema: {},
        execute: ({ signal }) => new Promise(resolve => {
          toolSignal = signal
          signal.addEventListener('abort', () => resolve(null), { once: true })
        })
      }] } }
    })
    await handle.send({
      executionId: 'tool-cleanup', input: { parts: [{ kind: 'text', text: 'Start the long tool.' }] },
      signal: new AbortController().signal
    })
    await vi.waitFor(() => expect(toolSignal).toBeDefined())
    const disposing = handle.dispose()
    expect(handle.dispose()).toBe(disposing)
    await disposing
    expect(toolSignal!.aborted).toBe(true)
    expect(test.record().observation.latestExecution?.status).toBe('interrupted')
    const isolationRoot = join(test.directory, 'application-tools-only')
    const [home] = await readdir(isolationRoot)
    await expect(stat(join(isolationRoot, home!, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves source native model preferences when exclusive tools require an isolated home', async () => {
    const test = await setup()
    vi.spyOn(CodexAppServer.prototype, 'readThreadConfiguration').mockResolvedValue({
      model: 'native-user-model', model_provider: 'custom',
      model_providers: { custom: { base_url: 'https://provider.test', wire_api: 'responses' } },
      model_reasoning_effort: 'high', service_tier: 'priority', personality: 'friendly',
      model_reasoning_summary: 'detailed'
    })
    const acquired = await test.runtime.server(test.directory, undefined, undefined, { toolMode: 'exclusive', threadId: 'native-config' })
    const isolationRoot = join(test.directory, 'application-tools-only')
    const [home] = await readdir(isolationRoot)
    const configPath = join(isolationRoot, home!, 'config.toml')
    try {
      const config = await readFile(configPath, 'utf8')
      expect(config).toContain('"model" = "native-user-model"')
      expect(config).toContain('"model_provider" = "custom"')
      expect(config).toContain('"model_reasoning_effort" = "high"')
      expect(config).toContain('"service_tier" = "priority"')
      expect(config).toContain('"base_url" = "https://provider.test"')
    } finally {
      await acquired.server.dispose()
    }
    await expect(stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reuses the source turn construction for a plain Thread Read so the fork keeps the cacheable prefix', async () => {
    const test = await setup({ sandbox: 'workspace-write', approvalPolicy: 'on-request', model: 'gpt-test' })
    const handle = await openCodexThread(test.runtime, test.context())
    try {
      await runSourceTurn(handle, test, 'plain-read-source')
      await expect(handle.read('Summarize the Thread.', new AbortController().signal))
        .resolves.toBe('Fork read complete.')

      const wire = await test.wire()
      const sourceStart = paramOf(wire, 'thread/start')
      const readFork = paramOf(wire, 'thread/fork')
      const sourceTurn = paramOf(wire, 'turn/start', 0)
      const readTurn = paramOf(wire, 'turn/start', -1)

      // The fork base and turn settings have to match the source request field
      // for field, including OpenAgent's session-local plan-tool setting.
      for (const key of ['cwd', 'approvalPolicy', 'sandbox', 'model', 'approvalsReviewer', 'config', 'developerInstructions']) {
        expect(readFork[key]).toEqual(sourceStart[key])
      }
      expect(readTurn.sandboxPolicy).toEqual(sourceTurn.sandboxPolicy)
      expect(readTurn.approvalPolicy).toEqual(sourceTurn.approvalPolicy)
      expect(readTurn.cwd).toEqual(sourceTurn.cwd)
      expect(sourceStart.config).toEqual({ tools: { update_plan: { enabled: true } } })
      expect(readFork.config).toEqual(sourceStart.config)
      // Read keeps the fork ephemeral; the source Thread itself is persisted.
      expect(readFork.ephemeral).toBe(true)
      expect(sourceStart.ephemeral).toBe(false)
    } finally {
      await handle.dispose()
    }
  })

  it('refuses a Thread Read whose source carries an injection instead of diverging from it', async () => {
    const test = await setup()
    const injection: HarnessThreadInjection = {
      instructions: ['Thread instruction: use the supplied context.'],
      contextEntries: [{ id: 'workspace', content: 'Thread context proof.' }],
      tools: { mode: 'extend', bindings: [] }
    }
    const handle = await openCodexThread(test.runtime, { ...test.context(), injection })
    try {
      await runSourceTurn(handle, test, 'injected-read-source')
      // The fork carries the source's developer instructions and config, but no
      // harness forwards an injected tool bridge into its read fork: answering
      // from such a source would advertise a different tool set than the Thread
      // claims to read. Fail loudly instead of diverging silently.
      await expect(handle.read('Summarize the Thread.', new AbortController().signal))
        .rejects.toThrow('Thread Read does not support a source Thread with an injection')

      const wire = await test.wire()
      expect(wire.some(entry => entry.method === 'thread/fork')).toBe(false)
    } finally {
      await handle.dispose()
    }
  })
})

async function setup(settings: CodexThreadSettings = {}) {
  await chmod(fixture, 0o755)
  const directory = await mkdtemp(join(tmpdir(), 'codex-generic-injection-'))
  directories.push(directory)
  const sourceHome = join(directory, 'source-home')
  await mkdir(sourceHome)
  await writeFile(join(sourceHome, 'auth.json'), '{"token":"test-only"}')
  const logPath = join(directory, 'wire.jsonl')
  const runtime = new CodexRuntime({
    resolveExecutable: async () => fixture,
    environment: async () => ({ ...process.env, CODEX_HOME: sourceHome, FAKE_CODEX_LOG: logPath, FAKE_CODEX_INTERRUPT_COMPLETES: '1' }),
    dataRoot: directory, temporaryWorkspaceRoot: directory
  })
  let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
    id: 'generic-thread', harnessId: 'codex', archived: false, revision: 0, title: 'Generic thread', tags: [],
    cwd: directory, settings, sessionState: null,
    observation: { latestExecution: null, backgroundWork: null }, createdAt: 1, updatedAt: 1
  }
  return {
    directory, runtime, record: () => record,
    context: () => createAgentOpenContext({
      sessionState: codexSessionState, getRecord: () => record, setRecord: next => { record = next }
    }),
    wire: async () => (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) as Array<{
      method?: string; params?: Record<string, unknown>
    }>
  }
}

async function completeOrdinaryTurn(test: Awaited<ReturnType<typeof setup>>): Promise<void> {
  const handle = await openCodexThread(test.runtime, test.context())
  try {
    await handle.send({ executionId: 'ordinary-turn', input: { parts: [{ kind: 'text', text: 'Original conversation' }] }, signal: new AbortController().signal })
    await vi.waitFor(() => expect(test.record().observation.latestExecution?.status).toBe('waiting-for-user'))
    const execution = test.record().observation.latestExecution!
    if (execution.status !== 'waiting-for-user') throw new Error('Expected approval')
    const interaction = execution.interactions[0]!
    await handle.respond({ interactionId: interaction.id, actionId: interaction.actions.find(action => action.intent === 'allow')!.id })
    await vi.waitFor(() => expect(test.record().observation.latestExecution?.status).toBe('completed'))
  } finally {
    await handle.dispose()
  }
}

async function sendAndWait(
  handle: import('@openagent/contracts').HarnessThreadHandle,
  test: Awaited<ReturnType<typeof setup>>,
  executionId: string
): Promise<void> {
  await handle.send({ executionId, input: { parts: [{ kind: 'text', text: 'Continue.' }] }, signal: new AbortController().signal })
  await vi.waitFor(() => expect(test.record().observation.latestExecution?.status).toBe('completed'))
}

async function runSourceTurn(
  handle: import('@openagent/contracts').HarnessThreadHandle,
  test: Awaited<ReturnType<typeof setup>>,
  executionId: string
): Promise<void> {
  await handle.send({
    executionId,
    input: { parts: [{ kind: 'text', text: 'Original conversation' }] },
    signal: new AbortController().signal
  })
  await vi.waitFor(() => expect(test.record().observation.latestExecution?.status).toBe('waiting-for-user'))
  const execution = test.record().observation.latestExecution!
  if (execution.status !== 'waiting-for-user') throw new Error('Expected approval')
  const interaction = execution.interactions[0]!
  await handle.respond({
    interactionId: interaction.id,
    actionId: interaction.actions.find(action => action.intent === 'allow')!.id
  })
  await vi.waitFor(() => expect(test.record().observation.latestExecution?.status).toBe('completed'))
}

function paramOf(
  wire: Array<{ method?: string; params?: Record<string, unknown> }>,
  method: string,
  index = 0
): Record<string, unknown> {
  const matches = wire.filter((message) => message.method === method)
  const message = index < 0 ? matches.at(index) : matches[index]
  if (!message?.params) throw new Error(`Missing ${method} in Codex wire log`)
  return message.params
}
