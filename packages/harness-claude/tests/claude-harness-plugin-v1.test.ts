import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClaudeMainPlugin } from '../src/main/index.js'
import {
  claudePublicInteractionId,
  claudePublicOptionId,
  claudePublicQuestionId
} from '../src/shared/public-interactions.js'
import { ClaudeToolBridge } from '../src/main/tool-bridge.js'
import { ClaudeTransport } from '../src/main/runtime/transport.js'
import {
  CLAUDE_STATE_LIMITS,
  latestVisibleClaudePrompt,
  parseClaudeThreadState
} from '../src/shared/state.js'
import { projectClaudeTimeline } from '../src/shared/timeline.js'
import {
  CLAUDE_PERMISSION_MODES,
  DEFAULT_CLAUDE_HARNESS_SETTINGS,
  defaultClaudeThreadSettings,
  normalizeClaudeHarnessSettings,
  type ClaudeHarnessSettings,
  type ClaudeThreadSettings
} from '../src/shared/settings.js'
import type {
  AgentThreadRecord,
  HarnessRespondRequest,
  HarnessThreadInjection
} from '@openagent/contracts'
import {
  createAgentOpenContext,
  type TestAgentChange
} from '@openagent/test-kit'
import type { BartTelemetryLedgerSample } from '@openagent/contracts'
import { createOpaqueTelemetrySampleId } from '@openagent/plugin-kit/bart/main'

const cleanups: Array<() => Promise<void>> = []
const OPAQUE_NATIVE_INTERACTION_ID =
  `native/request?scope[]=repository#${'x'.repeat(320)}`

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('Claude Harness Plugin v1', () => {
  it.each(['stream', 'record', 'stream-empty', 'record-empty', 'result-only'])(
    'publishes only the last root assistant message through %s events', async mode => {
      const fixture = await createFakeClaude()
      const plugin = createClaudeMainPlugin({
        resolveExecutable: async () => fixture.executable, environment: async () => process.env
      })
      let record = threadRecord(fixture.directory)
      const commits: TestAgentChange[] = []
      const handle = await plugin.openThread(createAgentOpenContext({
        sessionState: plugin.sessionState, getRecord: () => record,
        setRecord: next => { record = next }, changes: commits
      }))
      cleanups.push(() => handle.dispose())
      await handle.send({ executionId: 'terminal-summary',
        input: { parts: [{ kind: 'text', text: `terminal-summary-${mode}` }] },
        signal: new AbortController().signal })
      await waitFor(() => terminalCount(commits, 'terminal-summary') === 1)
      const stored = JSON.parse(JSON.stringify(record.sessionState))
      const execution = plugin.sessionState.project(stored).latestExecution
      expect(execution?.status).toBe('completed')
      if (mode.endsWith('empty') || mode === 'result-only') {
        expect(execution).not.toHaveProperty('summary')
      } else {
        expect(execution?.summary).toBe(`  ## Result\n\n${'detail '.repeat(400)}`)
      }
    }
  )

  it.each(['stream', 'record'] as const)('preserves native assistant identity through the %s transport and timeline', async mode => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const commits: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits
    }))
    cleanups.push(() => handle.dispose())
    await handle.send({
      executionId: 'native-identity',
      input: { parts: [{ kind: 'text', text: `native-identity-${mode}` }] },
      signal: new AbortController().signal
    })
    await waitFor(() => terminalCount(commits, 'native-identity') === 1)
    const state = parseClaudeThreadState(JSON.parse(JSON.stringify(record.sessionState)))
    const turn = state.turns[0]!
    const messages = turn.timeline.filter(item => item.kind === 'assistant')
    expect(messages.map(item => ({ messageId: item.messageId, content: item.content })))
      .toEqual(mode === 'stream' ? [
        { messageId: 'native-answer-1', content: 'Same' },
        { messageId: 'native-answer-1', content: ' answer' },
        { messageId: 'native-answer-1', content: '.' },
        { messageId: 'native-answer-2', content: 'Same answer.' }
      ] : [
        { messageId: 'native-answer-1', content: 'Same answer.' },
        { messageId: 'native-answer-2', content: 'Same answer.' }
      ])
    expect(new Set(messages.map(item => item.id)).size).toBe(messages.length)
    expect(turn.text).toBe('Same answer.Same answer.')
    expect(record.observation.latestExecution?.summary).toBe('Same answer.')
    expect(messages.every(item => item.status === 'complete')).toBe(true)
  })

  it.each(['extend', 'exclusive'] as const)('injects ordinary Thread context and %s tools before the first request, then cleans up', async mode => {
    const fixture = await createFakeClaude()
    const execute = vi.fn(async () => ({ echoed: 'tool result' }))
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record: AgentThreadRecord<'claude', ClaudeThreadSettings> = {
      ...threadRecord(fixture.directory),
      settings: { executablePath: 'claude', allowedTools: ['Read'] }
    }
    const handle = await plugin.openThread({
      ...createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: next => { record = next }
      }),
      injection: {
        instructions: ['Use the supplied project policy.'],
        contextEntries: [{ id: 'project', content: 'Workspace context before first request.' }],
        seed: [{ type: 'message', role: 'user', content: 'Previous task' }],
        tools: {
          mode,
          bindings: [{
            name: 'echo', description: 'Return a fixture result',
            inputSchema: { type: 'object' }, execute
          }]
        }
      }
    })
    cleanups.push(() => handle.dispose())
    await handle.send({
      executionId: 'injected',
      input: { parts: [{ kind: 'text', text: 'permission-denial' }] },
      contextEntries: [{ id: 'run', content: 'Only this send.' }],
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.status === 'waiting-for-user')
    const logs = await fakeLog(fixture.directory)
    const args: string[] = JSON.parse(logs.find(entry => entry.type === 'process')!.args)
    expect(args[args.indexOf('--system-prompt-snapshot') + 1]).toBe('off')
    expect(args.includes('--tools')).toBe(mode === 'exclusive')
    expect(args.includes('--strict-mcp-config')).toBe(mode === 'exclusive')
    if (mode === 'exclusive') expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read')
    const initialization = JSON.parse(logs.find(entry => entry.type === 'initialization')!.payload)
    expect(initialization.systemPrompt).toContain('Use the supplied project policy.')
    expect(initialization.systemPrompt).toContain('Workspace context before first request.')
    expect(initialization.systemPrompt).toContain('Previous task')
    expect(initialization.supportedDialogKinds).toEqual(['refusal_fallback_prompt'])
    expect(logs.findIndex(entry => entry.type === 'initialization')).toBeLessThan(logs.findIndex(entry => entry.type === 'user'))
    expect(logs.find(entry => entry.type === 'user')!.content).toContain('Only this send.')
    expect(logs.some(entry => entry.type === 'control-response')).toBe(false)
    const configuration = JSON.parse(args[args.indexOf('--mcp-config') + 1])
    const toolEnvironment = configuration.mcpServers.openagent.env
    const response = await fetch(toolEnvironment.OPENAGENT_TOOL_BRIDGE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${toolEnvironment.OPENAGENT_TOOL_BRIDGE_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ name: 'echo', arguments: { input: 'hello' }, callId: 'tool-1' })
    })
    expect(await response.json()).toEqual({ result: { echoed: 'tool result' } })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ arguments: { input: 'hello' }, callId: 'tool-1' }))
    await handle.respond(harnessResponse({ interactionId: 'permission-response', actionId: 'allow' }, 'injected'))
    await waitFor(() => record.observation.latestExecution?.status === 'completed')
    await handle.send({
      executionId: 'next-injected',
      input: { parts: [{ kind: 'text', text: 'normal' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.executionId === 'next-injected' && record.observation.latestExecution?.status === 'completed')
    expect((await fakeLog(fixture.directory)).filter(entry => entry.type === 'user').at(-1)?.content).not.toContain('Only this send.')
    await handle.dispose()
    await expect(readFile(toolEnvironment.OPENAGENT_TOOL_DEFINITIONS_PATH, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fetch(toolEnvironment.OPENAGENT_TOOL_BRIDGE_URL)).rejects.toThrow()
  })

  it.each(['extend', 'exclusive'] as const)(
    'preserves explicit permission policy for %s injected tools',
    async mode => {
      const fixture = await createFakeClaude()
      const plugin = createClaudeMainPlugin({
        resolveExecutable: async () => fixture.executable,
        environment: async () => process.env
      })
      let record: AgentThreadRecord<'claude', ClaudeThreadSettings> = {
        ...threadRecord(fixture.directory),
        settings: {
          executablePath: 'claude',
          permissionMode: 'manual',
          allowedTools: ['Read'],
          disallowedTools: ['mcp__openagent__echo']
        }
      }
      const handle = await plugin.openThread({
        ...createAgentOpenContext({
          sessionState: plugin.sessionState,
          getRecord: () => record,
          setRecord: next => { record = next }
        }),
        injection: {
          tools: { mode, bindings: [{
            name: 'echo', description: 'Echo',
            inputSchema: { type: 'object' }, execute: async () => null
          }] }
        }
      })
      cleanups.push(() => handle.dispose())
      await handle.send({
        executionId: `permission-policy-${mode}`,
        input: { parts: [{ kind: 'text', text: 'normal' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => record.observation.latestExecution?.status === 'completed')
      const launch = (await fakeLog(fixture.directory)).find(entry => entry.type === 'process')
      const args: string[] = JSON.parse(launch!.args)
      expect(args).toContain('--disallowedTools')
      expect(args[args.indexOf('--disallowedTools') + 1]).toBe('mcp__openagent__echo')
      expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read')
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('manual')
      expect(args).toContain('--mcp-config')
      expect(args.includes('--tools')).toBe(mode === 'exclusive')
    }
  )

  it('keeps an empty exclusive tool set and rejects unsupported modes before native I/O', async () => {
    const fixture = await createFakeClaude()
    const resolveExecutable = vi.fn(async () => fixture.executable)
    const plugin = createClaudeMainPlugin({ resolveExecutable, environment: async () => process.env })
    let record = threadRecord(fixture.directory)
    const context = createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    })
    await expect(plugin.openThread({
      ...context,
      injection: { tools: { mode: 'invalid', bindings: [] } } as unknown as HarnessThreadInjection
    })).rejects.toThrow('custom tool mode')
    expect(resolveExecutable).not.toHaveBeenCalled()
    const handle = await plugin.openThread({ ...context, injection: { tools: { mode: 'exclusive', bindings: [] } } })
    cleanups.push(() => handle.dispose())
    await handle.send({
      executionId: 'empty-exclusive',
      input: { parts: [{ kind: 'text', text: 'normal' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.status === 'completed')
    const args: string[] = JSON.parse((await fakeLog(fixture.directory)).find(entry => entry.type === 'process')!.args)
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--allowedTools')
    expect(args).not.toContain('--mcp-config')
  })

  it('disposes tools if cancellation lands while ordinary Thread opening creates the bridge', async () => {
    const controller = new AbortController()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => '/unused/claude',
      environment: async () => ({})
    })
    let record = threadRecord('/tmp/project')
    let definitionsPath = ''
    const create = ClaudeToolBridge.create.bind(ClaudeToolBridge)
    const spy = vi.spyOn(ClaudeToolBridge, 'create').mockImplementationOnce(async bindings => {
      const bridge = await create(bindings)
      const configuration = bridge.claudeConfiguration() as {
        mcpServers: { openagent: { env: Record<string, string> } }
      }
      definitionsPath = configuration.mcpServers.openagent.env.OPENAGENT_TOOL_DEFINITIONS_PATH
      controller.abort(new Error('cancelled during bridge creation'))
      return bridge
    })
    try {
      await expect(plugin.openThread({
        ...createAgentOpenContext({
          sessionState: plugin.sessionState,
          getRecord: () => record,
          setRecord: next => { record = next },
          signal: controller.signal
        }),
        injection: { tools: { mode: 'exclusive', bindings: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' }, execute: async () => null }] } }
      })).rejects.toMatchObject({ name: 'AbortError' })
      expect(definitionsPath).not.toBe('')
      await expect(readFile(definitionsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('removes the Thread abort listener when the Handle is disposed', async () => {
    const controller = new AbortController()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => '/unused/claude',
      environment: async () => ({})
    })
    let record = threadRecord('/tmp/project')
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      signal: controller.signal
    }))
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
    await handle.dispose()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('rejects an open cancelled while its recovered observation is being persisted', async () => {
    const controller = new AbortController()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => '/unused/claude',
      environment: async () => ({})
    })
    let record = threadRecord('/tmp/project')
    const context = createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      signal: controller.signal
    })
    await expect(plugin.openThread({
      ...context,
      sessionState: {
        read: context.sessionState.read,
        commit: async () => { controller.abort() }
      }
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('reuses resolved process inputs while the existing transport handles later turns', async () => {
    const fixture = await createFakeClaude()
    const resolveExecutable = vi.fn(async () => fixture.executable)
    const environment = vi.fn(async () => process.env)
    const plugin = createClaudeMainPlugin({ resolveExecutable, environment })
    let record = threadRecord(fixture.directory)
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))
    cleanups.push(() => handle.dispose())
    for (const executionId of ['reuse-first', 'reuse-second']) {
      await handle.send({
        executionId,
        input: { parts: [{ kind: 'text', text: 'normal' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => {
        const latest = record.observation.latestExecution
        return latest?.executionId === executionId && latest.status === 'completed'
      })
    }
    expect(resolveExecutable).toHaveBeenCalledTimes(1)
    expect(environment).toHaveBeenCalledTimes(1)
  })

  it('reads only Claude-native supportedEffortLevels from initialization', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })

    await expect(plugin.settingsPresentation.load({
      settings: DEFAULT_CLAUDE_HARNESS_SETTINGS,
      cwd: fixture.directory,
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      cli: { status: 'available', version: 'fixture-1.0.0' },
      models: [{
        value: 'sonnet',
        supportedEfforts: ['low', 'high']
      }]
    })
  })

  it('binds the Primary Native Session, commits one terminal, and treats a native notification as state only', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const commits: TestAgentChange[] = []
    let resolveTerminal!: () => void
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve
    })
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits,
      onChange: change => {
        if (change.lifecycle?.type === 'terminal') resolveTerminal()
      }
    }))

    await handle.send({
      executionId: 'execution-1',
      input: {
        parts: [{ kind: 'text', text: '{"event":"thread-terminal"}' }],
        presentation: 'internal'
      },
      signal: new AbortController().signal
    })
    await terminal
    await waitFor(() => record.observation.latestExecution?.status === 'completed')
    await waitFor(
      () => parseClaudeThreadState(record.sessionState).nativeNotifications.length === 1
    )

    const lifecycles = commits.flatMap((commit) =>
      commit.lifecycle ? [commit.lifecycle] : []
    )
    expect(lifecycles).toEqual([
      { type: 'started', executionId: 'execution-1' },
      {
        type: 'terminal',
        executionId: 'execution-1',
        outcome: 'completed'
      }
    ])
    const state = parseClaudeThreadState(record.sessionState)
    expect(state.primarySessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(state.turns.at(-1)).toMatchObject({
      executionId: 'execution-1',
      internalPromptIndexes: [0],
      text: 'hello',
      status: 'completed'
    })
    expect(latestVisibleClaudePrompt(state.turns.at(-1))).toBeUndefined()
    expect(state.nativeNotifications).toEqual([
      { summary: 'native task finished', status: 'completed' }
    ])
    const terminalCommit = commits.find(
      (commit) => commit.lifecycle?.type === 'terminal'
    )
    expect(terminalCommit?.state).toBeDefined()
    await handle.dispose()

    await expect(
      plugin.prompt.complete({
        messages: [{ role: 'user', content: 'normal' }],
        outputFormat: { type: 'text' },
        signal: new AbortController().signal
      })
    ).resolves.toEqual({
      output: { type: 'text', text: 'hello' },
      finishReason: 'stop'
    })
  })

  it('batches 100 native deltas into at most two writes and drains the tail on dispose', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const commits: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits
    }))
    const writeCount = () => commits.filter(
      (change) => change.state !== undefined
    ).length

    await handle.send({
      executionId: 'delta-burst-execution',
      input: { parts: [{ kind: 'text', text: 'delta-burst-hang' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => Boolean(
      parseClaudeThreadState(record.sessionState).primarySessionId
    ))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const writesBeforeBurst = writeCount()
    await waitFor(async () => (await fakeLog(fixture.directory)).some(
      (entry) => entry.type === 'delta-burst-emitted'
    ))
    // Allow stdout parsing to enqueue the burst while staying inside the
    // 50 ms fixed window, then make disposal the durability boundary.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await handle.dispose()

    const writesAfterDispose = writeCount()
    expect(writesAfterDispose - writesBeforeBurst).toBeGreaterThanOrEqual(1)
    expect(writesAfterDispose - writesBeforeBurst).toBeLessThanOrEqual(2)
    expect(parseClaudeThreadState(record.sessionState).turns.at(-1)).toMatchObject({
      executionId: 'delta-burst-execution',
      text: 't'.repeat(50),
      reasoning: 'r'.repeat(50),
      status: 'interrupted'
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(writeCount()).toBe(writesAfterDispose)
  })

  it('coalesces a terminal boundary with the final native delta batch', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const commits: TestAgentChange[] = []
    let resolveTerminal!: () => void
    const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve })
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits,
      onChange: change => {
        if (change.lifecycle?.type === 'terminal') resolveTerminal()
      }
    }))
    const writeCount = () => commits.filter(
      (change) => change.state !== undefined
    ).length

    await handle.send({
      executionId: 'delta-burst-terminal-execution',
      input: { parts: [{ kind: 'text', text: 'delta-burst-terminal' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => Boolean(
      parseClaudeThreadState(record.sessionState).primarySessionId
    ))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const writesBeforeBurst = writeCount()
    await terminal
    await waitFor(() => record.observation.latestExecution?.status === 'completed')

    const writesAtTerminal = writeCount()
    expect(writesAtTerminal - writesBeforeBurst).toBeGreaterThanOrEqual(1)
    expect(writesAtTerminal - writesBeforeBurst).toBeLessThanOrEqual(2)
    expect(parseClaudeThreadState(record.sessionState).turns.at(-1)).toMatchObject({
      executionId: 'delta-burst-terminal-execution',
      text: 't'.repeat(50),
      reasoning: 'r'.repeat(50),
      status: 'completed'
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(writeCount()).toBe(writesAtTerminal)
    await handle.dispose()
  })

  it('keeps historical native task updates separate from the latest execution in every atomic commit', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const commits: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits
    }))
    cleanups.push(() => handle.dispose())
    await handle.send({
      executionId: 'background-origin',
      input: { parts: [{ kind: 'text', text: 'background-across-first' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.status === 'completed')
    const first = parseClaudeThreadState(record.sessionState).turns[0]!
    expect(first.activities).toMatchObject([{ id: 'old-native-task', status: 'running' }])
    expect(record.observation.backgroundWork).toEqual({ status: 'running' })
    await handle.send({
      executionId: 'newest-foreground',
      input: { parts: [{ kind: 'text', text: 'background-across-second' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => parseClaudeThreadState(record.sessionState).nativeNotifications.length === 1)
    expect(record.observation.latestExecution).toMatchObject({
      executionId: 'newest-foreground', status: 'running'
    })
    expect(record.observation.backgroundWork).toBeNull()
    const updated = parseClaudeThreadState(record.sessionState)
    expect(updated.turns[0]).toMatchObject({
      status: 'completed', finishedAt: first.finishedAt,
      activities: [{ id: 'old-native-task', status: 'completed' }]
    })
    expect(updated.turns[0]!.updatedAt).toBeGreaterThan(first.finishedAt!)
    expect(updated.turns[1]!.activities).toEqual([])
    await waitFor(() => record.observation.latestExecution?.status === 'completed')
    const latest = structuredClone(record.observation.latestExecution)
    await waitFor(() => parseClaudeThreadState(record.sessionState).nativeNotifications.length === 2)
    expect(record.observation.latestExecution).toEqual(latest)
    expect(parseClaudeThreadState(record.sessionState).turns[0]!.finishedAt).toBe(first.finishedAt)
    for (const change of commits) {
      expect(change.state).toBeDefined()
      expect(change.observation).toEqual(plugin.sessionState.project(change.state!))
    }
  })

  it('settles background work the CLI never reported terminal when the native session ends', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))

    await handle.send({
      executionId: 'ended-session-background',
      input: { parts: [{ kind: 'text', text: 'background-across-first' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.status === 'completed')
    expect(record.observation.backgroundWork).toEqual({ status: 'running' })

    await handle.dispose()

    expect(record.observation.backgroundWork).toBeNull()
    expect(parseClaudeThreadState(record.sessionState).runtime?.backgroundTasks)
      .toMatchObject([{ id: 'old-native-task', status: 'failed' }])
  })

  it('settles background work when the CLI process exits before reporting the task terminal', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))
    cleanups.push(() => handle.dispose())

    await handle.send({
      executionId: 'process-exit-background',
      input: { parts: [{ kind: 'text', text: 'background-process-exit' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.status === 'completed')
    await waitFor(() => record.observation.backgroundWork === null)

    expect(parseClaudeThreadState(record.sessionState).runtime?.backgroundTasks)
      .toMatchObject([{ id: 'crash-native-task', status: 'failed' }])
  })

  it.skipIf(process.platform === 'win32')(
    'settles background work when a timed-out interrupt kills the process tree',
    async () => {
      const fixture = await createFakeClaude()
      const plugin = createClaudeMainPlugin({
        resolveExecutable: async () => fixture.executable,
        environment: async () => ({
          ...process.env,
          OPENAGENT_FAKE_IGNORE_INTERRUPT: '1',
          OPENAGENT_FAKE_IGNORE_TERM: '1'
        }),
        interruptTimeouts: { controlMs: 50, termMs: 75, killMs: 1_000 }
      })
      let record = threadRecord(fixture.directory)
      const handle = await plugin.openThread(createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: next => { record = next }
      }))
      cleanups.push(() => handle.dispose())

      const sending = handle.send({
        executionId: 'interrupted-background',
        input: { parts: [{ kind: 'text', text: 'background-interrupt-hang' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => record.observation.backgroundWork !== null)
      await handle.interrupt()
      await sending

      await waitFor(() => record.observation.backgroundWork === null)
      expect(record.observation.latestExecution?.status).toBe('interrupted')
      expect(parseClaudeThreadState(record.sessionState).runtime?.backgroundTasks)
        .toMatchObject([{ id: 'interrupt-native-task', status: 'failed' }])
    }
  )

  it('claims a Core public identity for a provider-initiated task notification', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const commits: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits,
      createExecutionId: () => 'public-provider-task'
    }))

    await handle.send({
      executionId: 'foreground-provider-trigger',
      input: { parts: [{ kind: 'text', text: 'provider-task-wake' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => commits.some(
      (change) => change.lifecycle?.type === 'terminal' &&
        change.lifecycle.executionId === 'public-provider-task'
    ))

    const lifecycles = commits.flatMap((change) =>
      change.lifecycle ? [change.lifecycle] : []
    )
    expect(lifecycles).toEqual([
      { type: 'started', executionId: 'foreground-provider-trigger' },
      {
        type: 'terminal',
        executionId: 'foreground-provider-trigger',
        outcome: 'completed'
      },
      { type: 'started', executionId: 'public-provider-task' },
      {
        type: 'terminal',
        executionId: 'public-provider-task',
        outcome: 'completed'
      }
    ])
    const state = parseClaudeThreadState(record.sessionState)
    expect(state.turns.at(-1)).toMatchObject({
      executionId: 'public-provider-task',
      prompts: ['Provider task completed'],
      promptAttachments: [[]],
      text: 'provider background answer',
      status: 'completed'
    })
    expect(JSON.stringify(record.sessionState)).not.toContain('native-provider-task-private')
    await handle.dispose()
  })

  it('awaits Core admission before accepting provider-initiated native output', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    let resolveAdmission!: () => void
    const admissionGate = new Promise<void>((resolve) => {
      resolveAdmission = resolve
    })
    const admitted: string[] = []
    const base = createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      createExecutionId: () => 'public-provider-admission'
    })
    const handle = await plugin.openThread({
      ...base,
      executionAdmission: {
        admit: async (executionId) => {
          admitted.push(executionId)
          expect(record.observation.latestExecution).toMatchObject({
            executionId,
            status: 'running'
          })
          expect(parseClaudeThreadState(record.sessionState).turns.at(-1))
            .toMatchObject({ executionId, status: 'running', text: '' })
          await admissionGate
        }
      }
    })

    await handle.send({
      executionId: 'foreground-admission-trigger',
      input: { parts: [{ kind: 'text', text: 'provider-task-wake' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => admitted.length === 1)
    expect(admitted).toEqual(['public-provider-admission'])
    expect(parseClaudeThreadState(record.sessionState).turns.at(-1))
      .toMatchObject({ text: '', status: 'running' })

    resolveAdmission()
    await waitFor(() =>
      record.observation.latestExecution?.executionId ===
        'public-provider-admission' &&
      record.observation.latestExecution.status === 'completed'
    )
    expect(parseClaudeThreadState(record.sessionState).turns.at(-1))
      .toMatchObject({ text: 'provider background answer', status: 'completed' })
    expect(admitted).toEqual(['public-provider-admission'])
    await handle.dispose()
  })

  it('fails and releases a provider wake when Core admission rejects it', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const commits: TestAgentChange[] = []
    const base = createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits,
      createExecutionId: () => 'public-provider-admission-denied'
    })
    const handle = await plugin.openThread({
      ...base,
      executionAdmission: {
        admit: async () => {
          throw new Error('Core denied provider native execution admission')
        }
      }
    })

    await handle.send({
      executionId: 'foreground-denied-admission-trigger',
      input: { parts: [{ kind: 'text', text: 'provider-task-wake' }] },
      signal: new AbortController().signal
    })
    await waitFor(() =>
      record.observation.latestExecution?.executionId ===
        'public-provider-admission-denied' &&
      record.observation.latestExecution.status === 'failed'
    )
    expect(parseClaudeThreadState(record.sessionState).turns.at(-1)).toMatchObject({
      executionId: 'public-provider-admission-denied',
      text: '',
      status: 'failed',
      error: 'Core denied provider native execution admission'
    })
    expect(commits.flatMap((change) => change.lifecycle ? [change.lifecycle] : []))
      .toEqual([
        { type: 'started', executionId: 'foreground-denied-admission-trigger' },
        {
          type: 'terminal',
          executionId: 'foreground-denied-admission-trigger',
          outcome: 'completed'
        },
        { type: 'started', executionId: 'public-provider-admission-denied' },
        {
          type: 'terminal',
          executionId: 'public-provider-admission-denied',
          outcome: 'failed'
        }
      ])
    await handle.dispose()
  })

  it('rejects an unclaimed provider wake without persisting its private identity', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const commits: TestAgentChange[] = []
    const base = createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits
    })
    const handle = await plugin.openThread({
      ...base,
      executionClaims: {
        claim: () => { throw new Error('Core rejected native claim') }
      }
    })

    await handle.send({
      executionId: 'foreground-unclaimed-trigger',
      input: { parts: [{ kind: 'text', text: 'provider-task-wake' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => parseClaudeThreadState(record.sessionState).nativeNotifications.some(
      (notification) => notification.summary === 'Provider task completed'
    ))

    expect(commits.flatMap((change) => change.lifecycle ? [change.lifecycle] : []))
      .toEqual([
        { type: 'started', executionId: 'foreground-unclaimed-trigger' },
        {
          type: 'terminal',
          executionId: 'foreground-unclaimed-trigger',
          outcome: 'completed'
        }
      ])
    expect(parseClaudeThreadState(record.sessionState).turns).toHaveLength(1)
    expect(JSON.stringify(record.sessionState)).not.toContain('native-provider-task-private')
    await handle.dispose()
  })

  it('abandons and clears a provider wake claim during disposal', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    let abandons = 0
    const base = createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    })
    const handle = await plugin.openThread({
      ...base,
      executionClaims: {
        claim: () => ({
          executionId: 'public-provider-dispose',
          abandon: () => { abandons += 1 }
        })
      }
    })

    await handle.send({
      executionId: 'foreground-dispose-trigger',
      input: { parts: [{ kind: 'text', text: 'provider-task-wake-hang' }] },
      signal: new AbortController().signal
    })
    await waitFor(() =>
      record.observation.latestExecution?.executionId === 'public-provider-dispose'
    )
    await handle.dispose()

    expect(abandons).toBeGreaterThanOrEqual(1)
    expect(record.observation.latestExecution).toMatchObject({
      executionId: 'public-provider-dispose',
      status: 'interrupted'
    })
    expect(JSON.stringify(record.sessionState)).not.toContain('native-provider-task-private')
  })

  it('records stopped native messages once and diffs cumulative per-model cost', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const samples: BartTelemetryLedgerSample[] = []
    const liveUsage: Array<{ output?: number; cached?: number; samples: number }> = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => {
        record = next
        if (next.observation.latestExecution?.status === 'running') {
          const turn = parseClaudeThreadState(next.sessionState).turns.at(-1)
          const usage = turn?.usage
          liveUsage.push({ output: usage?.outputTokens, cached: usage?.cachedTokens, samples: samples.length })
        }
      },
      telemetryLedger: {
        async record(sample) {
          samples.push(sample)
        },
        read: () => ({ windows: [] })
      }
    }))

    await handle.send({
      executionId: 'execution-usage-ledger',
      input: { parts: [{ kind: 'text', text: 'usage-ledger-one' }] },
      signal: new AbortController().signal
    })
    await handle.send({
      executionId: 'execution-usage-ledger',
      input: { parts: [{ kind: 'text', text: 'usage-ledger-two' }] },
      signal: new AbortController().signal
    })
    await waitFor(() =>
      record.observation.latestExecution?.status === 'completed'
    )

    expect(liveUsage).toEqual(expect.arrayContaining([
      { output: 1, cached: 3, samples: 0 },
      { output: 2, cached: 3, samples: 0 },
      { output: 4, cached: 3, samples: 0 },
      { output: 5, cached: 6, samples: 2 },
      { output: 6, cached: 6, samples: 2 }
    ]))
    expect(samples).toHaveLength(4)
    expect(samples.every((sample) =>
      sample.type !== 'execution-usage' || /^sha256:[0-9a-f]{64}$/.test(sample.sampleId)
    )).toBe(true)
    expect(JSON.stringify(samples)).not.toContain('message-usage-ledger')
    expect(samples.map((sample) =>
      sample.type === 'execution-usage' ? sample.usageKind : sample.type
    )).toEqual(['generation', 'summary', 'generation', 'summary'])
    const generations = samples.filter(
      (sample) => sample.type === 'execution-usage' && sample.usageKind === 'generation'
    )
    const summaries = samples.filter(
      (sample) => sample.type === 'execution-usage' && sample.usageKind === 'summary'
    )
    const nativeSessionId = parseClaudeThreadState(record.sessionState).primarySessionId
    expect(nativeSessionId).toBeTruthy()
    expect(JSON.stringify(samples)).not.toContain(nativeSessionId)
    expect(generations.map((sample) =>
      sample.type === 'execution-usage' ? sample.sampleId : ''
    )).toEqual([
      createOpaqueTelemetrySampleId([
        'claude',
        'claude-thread',
        nativeSessionId!,
        'message-usage-ledger-1'
      ]),
      createOpaqueTelemetrySampleId([
        'claude',
        'claude-thread',
        nativeSessionId!,
        'message-usage-ledger-2'
      ])
    ])
    expect(generations).toMatchObject([
      {
        type: 'execution-usage',
        executionId: 'execution-usage-ledger',
        model: 'claude-sonnet-4-6',
        usageKind: 'generation',
        uncachedInputTokens: 10,
        cachedReadTokens: 3,
        cacheWriteTokens: 2,
        outputTokens: 4,
        reasoningTokens: 2
      },
      {
        type: 'execution-usage',
        executionId: 'execution-usage-ledger',
        model: 'claude-sonnet-4-6',
        usageKind: 'generation',
        uncachedInputTokens: 20,
        cachedReadTokens: 3,
        cacheWriteTokens: 2,
        outputTokens: 4,
        reasoningTokens: 2
      }
    ])
    expect(summaries).toMatchObject([
      {
        type: 'execution-usage',
        executionId: 'execution-usage-ledger',
        model: 'claude-sonnet-4-6',
        usageKind: 'summary',
        costUsd: 0.0125
      },
      {
        type: 'execution-usage',
        executionId: 'execution-usage-ledger',
        model: 'claude-sonnet-4-6',
        usageKind: 'summary',
        costUsd: 0.0075
      }
    ])
    expect(parseClaudeThreadState(record.sessionState).turns.at(-1)?.usage).toMatchObject({
      inputTokens: 30,
      cachedTokens: 6,
      cacheWriteTokens: 4,
      outputTokens: 8,
      reasoningTokens: 4,
      costUsd: 0.02
    })
    await handle.dispose()
  })

  it('keeps one lifecycle across follow-ups and isolates a late result from the next execution', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    record = {
      ...record,
      settings: { ...record.settings, permissionMode: 'manual' }
    }
    const commits: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits
    }))
    const firstOperation = new AbortController()
    const signal = new AbortController().signal

    await handle.send({
      executionId: 'execution-a',
      input: { parts: [{ kind: 'text', text: 'followup-one' }] },
      signal: firstOperation.signal
    })
    firstOperation.abort()
    await handle.send({
      executionId: 'execution-a',
      input: { parts: [{ kind: 'text', text: 'followup-two' }] },
      signal
    })
    await waitFor(() => terminalCount(commits, 'execution-a') === 1)

    const lifecycleA = commits.flatMap((commit) =>
      commit.lifecycle?.executionId === 'execution-a' ? [commit.lifecycle] : []
    )
    expect(lifecycleA).toEqual([
      { type: 'started', executionId: 'execution-a' },
      { type: 'terminal', executionId: 'execution-a', outcome: 'completed' }
    ])
    expect(parseClaudeThreadState(record.sessionState).turns.at(-1)).toMatchObject({
      executionId: 'execution-a',
      prompts: ['followup-one', 'followup-two'],
      text: 'onetwo',
      status: 'completed'
    })
    await expect(
      handle.send({
        executionId: 'execution-a',
        input: { parts: [{ kind: 'text', text: 'late-followup' }] },
        signal
      })
    ).rejects.toThrow(/已使用|已 terminal/)

    const defaults = plugin.settings.defaultThreadSettings(
      DEFAULT_CLAUDE_HARNESS_SETTINGS
    )
    const cleared = await plugin.settings.applyThreadSettingsUpdate({
      current: record.settings,
      defaults,
      update: { permissionMode: null },
      hasContent: true,
      cwd: fixture.directory,
      signal
    })
    expect(cleared.permissionMode).toBe('auto')
    record = { ...record, settings: cleared }

    await handle.send({
      executionId: 'execution-b',
      input: { parts: [{ kind: 'text', text: 'second-execution' }] },
      signal
    })
    await waitFor(() => terminalCount(commits, 'execution-b') === 1)
    const state = parseClaudeThreadState(record.sessionState)
    expect(state.turns.at(-1)).toMatchObject({
      executionId: 'execution-b',
      text: 'B',
      status: 'completed'
    })
    expect(state.turns.at(-1)?.text).not.toContain('LATE_A')
    expect(await fakeLog(fixture.directory)).toContainEqual({
      type: 'control',
      subtype: 'set_permission_mode',
      mode: 'auto'
    })
    await handle.dispose()
  })

  it('keeps a NUL-only assistant delta from claiming the foreground', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const commits: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits
    }))

    await handle.send({
      executionId: 'execution-nul',
      input: { parts: [{ kind: 'text', text: 'nul-text-delta' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => terminalCount(commits, 'execution-nul') === 1)

    // Both text fields drop a NUL, so a delta that sanitizes to nothing was
    // never assistant text and must not take the foreground from the tool call
    // that is still running.
    const turn = parseClaudeThreadState(record.sessionState).turns.at(-1)
    expect(turn?.text).toBe('')
    expect(turn?.foreground).toMatchObject({ kind: 'tool-call', callId: 'nul-tool' })
    await handle.dispose()
  })

  it('persists typed attachment metadata for every prompt and follow-up', async () => {
    const fixture = await createFakeClaude()
    const imagePath = join(fixture.directory, 'diagram.png')
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))

    await handle.send({
      executionId: 'attachment-execution',
      input: {
        parts: [{ kind: 'text', text: 'followup-one' }, {
          kind: 'image',
          file: {
            id: 'image-1',
            path: imagePath,
            name: 'diagram.png',
            mimeType: 'image/png',
            size: 4
          },
          detail: 'high'
        }]
      },
      signal: new AbortController().signal
    })
    await handle.send({
      executionId: 'attachment-execution',
      input: {
        parts: [{ kind: 'text', text: 'followup-two' }, {
          kind: 'audio-url',
          url: 'https://example.test/clip.wav'
        }]
      },
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.status === 'completed')

    const turn = parseClaudeThreadState(record.sessionState).turns.at(-1)
    expect(turn?.prompts).toEqual([
      'followup-one\ndiagram.png',
      'followup-two\nhttps://example.test/clip.wav'
    ])
    expect(turn?.promptAttachments).toEqual([[{
      id: 'image-1',
      name: 'diagram.png',
      mimeType: 'image/png',
      size: 4,
      kind: 'image'
    }], [{
      id: 'audio-url:1',
      name: 'https://example.test/clip.wav',
      mimeType: 'audio/*',
      size: 0,
      kind: 'audio'
    }]])
    await handle.dispose()
  })

  it('strictly rejects missing, misaligned, or malformed attachment history', () => {
    const base = {
      version: 1,
      turns: [{
        executionId: 'attachment-state',
        createdAt: 1,
        updatedAt: 1,
        prompts: ['prompt'],
        promptAttachments: [[]],
        text: '',
        reasoning: '',
        finishedAt: 1,
        status: 'completed',
        plan: [],
        activities: [],
        interactions: [],
        notices: [],
        timeline: []
      }],
      nativeNotifications: []
    }
    expect(parseClaudeThreadState(base).turns[0]?.promptAttachments).toEqual([[]])
    const missing = structuredClone(base) as Record<string, any>
    delete missing.turns[0].promptAttachments
    expect(() => parseClaudeThreadState(missing)).toThrow('turn content')
    const misaligned = structuredClone(base) as Record<string, any>
    misaligned.turns[0].promptAttachments = []
    expect(() => parseClaudeThreadState(misaligned)).toThrow('turn content')
    const malformed = structuredClone(base) as Record<string, any>
    malformed.turns[0].promptAttachments = [[{
      id: 'attachment',
      name: 'file.txt',
      mimeType: 'text/plain',
      size: 1,
      kind: 'file',
      legacyPath: '/must-not-be-accepted'
    }]]
    expect(() => parseClaudeThreadState(malformed)).toThrow('turn content')
  })

  it('settles a restored waiting interaction into one public interrupted execution', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    record = {
      ...record,
      sessionState: {
        version: 1,
        turns: [{
          executionId: 'waiting-execution',
          createdAt: 10,
          updatedAt: 11,
          prompts: ['Need approval'],
          promptAttachments: [[]],
          text: '',
          reasoning: '',
          status: 'running',
          plan: [],
          activities: [{
            id: 'running-tool', kind: 'tool', label: 'Running tool', status: 'running'
          }],
          interactions: [{
            id: 'permission-1',
            kind: 'permission',
            title: 'Allow tool?',
            status: 'pending'
          }],
          notices: [],
          timeline: [{
            id: 'activity-start', kind: 'activity', createdAt: 10,
            activity: { id: 'running-tool', kind: 'tool', label: 'Running tool', status: 'running' }
          }, {
            id: 'permission-pending', kind: 'interaction', createdAt: 11,
            interaction: { id: 'permission-1', kind: 'permission', title: 'Allow tool?', status: 'pending' }
          }]
        }],
        nativeNotifications: []
      },
      observation: {
        latestExecution: {
          executionId: 'waiting-execution',
          startedAt: 10,
          status: 'waiting-for-user',
          interactions: [{
            id: 'permission-1',
            kind: 'permission',
            title: 'Allow tool?',
            actions: [
              { id: 'allow', intent: 'allow', label: 'Allow' },
              { id: 'deny', intent: 'deny', label: 'Deny' }
            ],
            questions: []
          }]
        },
        backgroundWork: null
      }
    }
    const changes: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes
    }))

    const recoveredTurn = parseClaudeThreadState(record.sessionState).turns.at(-1)!
    expect(recoveredTurn).toMatchObject({
      executionId: 'waiting-execution',
      status: 'interrupted',
      activities: [{ id: 'running-tool', status: 'cancelled' }],
      interactions: [{ id: 'permission-1', status: 'cancelled' }]
    })
    expect(projectClaudeTimeline(recoveredTurn)).toMatchObject([
      { id: 'activity-start', activity: { status: 'cancelled' } },
      { id: 'permission-pending', interaction: { status: 'cancelled' } },
      { kind: 'error' }
    ])
    expect(recoveredTurn.timeline.findLast((item) => item.kind === 'activity')?.activity.status)
      .toBe('cancelled')
    expect(recoveredTurn.timeline.findLast((item) => item.kind === 'interaction')?.interaction.status)
      .toBe('cancelled')
    expect(record.observation.latestExecution).toMatchObject({
      executionId: 'waiting-execution',
      startedAt: 10,
      status: 'interrupted'
    })
    expect(changes.filter(change => change.lifecycle?.type === 'terminal'))
      .toHaveLength(1)
    await handle.dispose()
  })

  it.each([
    {
      prompt: 'permission-denial',
      nativeInteractionId: 'permission-response',
      response: harnessResponse({
        interactionId: 'permission-response',
        actionId: 'deny',
        message: 'Not in this directory'
      }, 'execution-permission-denial'),
      expected: {
        behavior: 'deny',
        message: 'Not in this directory',
        toolUseID: 'tool-permission'
      }
    },
    {
      prompt: 'elicitation-response',
      nativeInteractionId: 'elicitation-response',
      response: harnessResponse({
        interactionId: 'elicitation-response',
        actionId: 'submit',
        answers: {
          [publicQuestionId('elicitation-response', 0, 'execution-elicitation-response')]:
            '{"branch":"release","force":false}'
        }
      }, 'execution-elicitation-response'),
      expected: {
        action: 'accept',
        content: { branch: 'release', force: false }
      }
    },
    {
      prompt: 'dialog-response',
      nativeInteractionId: 'dialog-response',
      response: harnessResponse({
        interactionId: 'dialog-response',
        actionId: 'submit',
        answers: {
          [publicQuestionId('dialog-response', 0, 'execution-dialog-response')]: 'Try the fallback flow'
        }
      }, 'execution-dialog-response'),
      expected: {
        behavior: 'completed',
        result: 'Try the fallback flow'
      }
    }
  ].flatMap(testCase => [
    { ...testCase, injected: false }, { ...testCase, injected: true }
  ]))('encodes $prompt answers with injected=$injected into the native control payload', async ({
    prompt,
    nativeInteractionId,
    response,
    expected,
    injected
  }) => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const handle = await plugin.openThread({
      ...createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: next => { record = next }
      }),
      ...(injected ? { injection: { tools: { mode: 'exclusive' as const, bindings: [] } } } : {})
    })

    await handle.send({
      executionId: `execution-${prompt}`,
      input: { parts: [{ kind: 'text', text: prompt }] },
      signal: new AbortController().signal
    })
    await waitFor(() =>
      record.observation.latestExecution?.status === 'waiting-for-user'
    )
    await handle.respond(response)
    await waitFor(async () =>
      (await fakeLog(fixture.directory)).some(
        (entry) => entry.type === 'control-response' &&
          entry.requestId === nativeInteractionId
      )
    )
    const logged = (await fakeLog(fixture.directory)).find(
      (entry) => entry.type === 'control-response' &&
        entry.requestId === nativeInteractionId
    )
    expect(JSON.parse(logged?.payload || 'null')).toEqual(expected)
    await handle.dispose()
  })

  it.each([
    { actionId: 'deny', expected: { action: 'decline' } },
    { actionId: 'cancel', expected: { action: 'cancel' } }
  ] as const)('projects and maps form-elicitation $actionId', async ({
    actionId,
    expected
  }) => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))

    await handle.send({
      executionId: 'execution-form-elicitation-actions',
      input: { parts: [{ kind: 'text', text: 'elicitation-response' }] },
      signal: new AbortController().signal
    })
    await waitFor(() =>
      record.observation.latestExecution?.status === 'waiting-for-user'
    )
    const execution = record.observation.latestExecution
    if (execution?.status !== 'waiting-for-user') {
      throw new Error('Missing Claude form elicitation')
    }
    expect(execution.interactions[0]?.actions).toEqual([
      { id: 'submit', intent: 'submit', label: 'Submit' },
      { id: 'deny', intent: 'deny', label: 'Decline' },
      { id: 'cancel', intent: 'cancel', label: 'Cancel' }
    ])
    await handle.respond({
      interactionId: execution.interactions[0]!.id,
      actionId
    })
    await waitFor(async () =>
      (await fakeLog(fixture.directory)).some(
        (entry) => entry.requestId === 'elicitation-response'
      )
    )
    expect(JSON.parse((await fakeLog(fixture.directory)).find(
      (entry) => entry.requestId === 'elicitation-response'
    )?.payload || 'null')).toEqual(expected)
    await handle.dispose()
  })

  it('answers injected Thread questions with long colliding displays by opaque public identity', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const handle = await plugin.openThread({
      ...createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: next => { record = next }
      }),
      injection: { tools: { mode: 'exclusive', bindings: [] } }
    })

    await handle.send({
      executionId: 'execution-long-colliding-question',
      input: { parts: [{ kind: 'text', text: 'long-colliding-question' }] },
      signal: new AbortController().signal
    })
    await waitFor(() =>
      record.observation.latestExecution?.status === 'waiting-for-user'
    )
    const execution = record.observation.latestExecution
    if (execution?.status !== 'waiting-for-user') {
      throw new Error('Missing long Claude question')
    }
    const interaction = execution.interactions[0]!
    const [first, second] = interaction.questions
    expect(first?.prompt).toBe(second?.prompt)
    expect(first?.options[0]?.label).toBe(first?.options[1]?.label)
    expect(first?.id).not.toBe(second?.id)
    expect(first?.options[0]?.value).not.toBe(first?.options[1]?.value)
    expect(first?.options[0]?.value).toMatch(
      /^claude-option-sha256-[0-9a-f]{64}$/
    )
    const persistedInteraction = parseClaudeThreadState(
      record.sessionState
    ).turns.at(-1)?.interactions[0]
    expect(persistedInteraction?.questions?.[0]?.question.length)
      .toBeLessThanOrEqual(10_000)
    expect(persistedInteraction?.questions?.[0]?.options[0]?.label.length)
      .toBeLessThanOrEqual(2_000)
    expect(JSON.stringify(record.sessionState)).not.toContain(
      `${'Q'.repeat(10_000)}-first`
    )
    expect(JSON.stringify(record.sessionState)).not.toContain(
      `${'O'.repeat(2_000)}-second`
    )

    await handle.respond({
      interactionId: interaction.id,
      actionId: 'submit',
      answers: {
        [first!.id]: first!.options[1]!.value,
        [second!.id]: second!.options[0]!.value
      }
    })
    await waitFor(async () =>
      (await fakeLog(fixture.directory)).some(
        (entry) => entry.requestId === 'long-colliding-question-response'
      )
    )
    const payload = JSON.parse((await fakeLog(fixture.directory)).find(
      (entry) => entry.requestId === 'long-colliding-question-response'
    )?.payload || 'null') as {
      updatedInput: { answers: Record<string, string> }
    }
    expect(payload.updatedInput.answers).toEqual({
      [`${'Q'.repeat(10_000)}-first`]: `${'O'.repeat(2_000)}-second`,
      [`${'Q'.repeat(10_000)}-second`]: `${'P'.repeat(2_000)}-first`
    })
    await handle.dispose()
  })

  it('keeps symbolic long native interaction ids private, stable, and reversible', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    const projectedAcrossRestarts: string[] = []

    for (let run = 0; run < 2; run += 1) {
      const executionId = `execution-opaque-interaction-${run}`
      const expectedInteractionId = publicInteractionId(OPAQUE_NATIVE_INTERACTION_ID, executionId)
      const expectedQuestionId = publicQuestionId(OPAQUE_NATIVE_INTERACTION_ID, 0, executionId)

      let record = threadRecord(fixture.directory)
      const handle = await plugin.openThread(createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: next => { record = next }
      }))

      await handle.send({
        executionId,
        input: { parts: [{ kind: 'text', text: 'opaque-interaction-id' }] },
        signal: new AbortController().signal
      })
      await waitFor(() =>
        record.observation.latestExecution?.status === 'waiting-for-user'
      )
      const execution = record.observation.latestExecution
      if (execution?.status !== 'waiting-for-user') {
        throw new Error('Missing opaque Claude interaction')
      }
      const interaction = execution.interactions[0]
      expect(interaction).toMatchObject({
        id: expectedInteractionId,
        kind: 'question',
        questions: [{
          id: expectedQuestionId,
          prompt: 'Which scope?',
          options: [{
            value: publicOptionId(OPAQUE_NATIVE_INTERACTION_ID, 0, 0, executionId),
            label: 'Repository only',
            description: 'Use this repository'
          }, {
            value: publicOptionId(OPAQUE_NATIVE_INTERACTION_ID, 0, 1, executionId),
            label: 'All workspaces',
            description: 'Use every workspace'
          }]
        }]
      })
      expect(interaction?.id).toMatch(
        /^claude-interaction-sha256-[0-9a-f]{64}$/
      )
      expect(interaction?.questions[0]?.id).toMatch(
        /^claude-question-sha256-[0-9a-f]{64}$/
      )
      expect(interaction?.id.length).toBeLessThanOrEqual(128)
      expect(interaction?.questions[0]?.id.length).toBeLessThanOrEqual(128)
      expect(JSON.stringify(record.observation)).not.toContain(
        OPAQUE_NATIVE_INTERACTION_ID
      )
      expect(parseClaudeThreadState(record.sessionState).turns.at(-1)?.interactions)
        .toMatchObject([{ id: OPAQUE_NATIVE_INTERACTION_ID, status: 'pending' }])
      projectedAcrossRestarts.push(interaction!.id)
      expect(plugin.sessionState.project(JSON.parse(JSON.stringify(record.sessionState))))
        .toEqual(record.observation)

      await expect(handle.respond({
        interactionId: OPAQUE_NATIVE_INTERACTION_ID,
        actionId: 'submit'
      })).rejects.toThrow('当前没有待处理 interaction')
      await handle.respond({
        interactionId: interaction!.id,
        actionId: 'submit',
        answers: {
          [interaction!.questions[0]!.id]: interaction!.questions[0]!.options[0]!.value
        }
      })
      await waitFor(() => record.observation.latestExecution?.status === 'completed')
      await waitFor(async () =>
        (await fakeLog(fixture.directory)).filter(
          (entry) => entry.requestId === OPAQUE_NATIVE_INTERACTION_ID
        ).length === run + 1
      )
      const response = (await fakeLog(fixture.directory)).filter(
        (entry) => entry.requestId === OPAQUE_NATIVE_INTERACTION_ID
      ).at(-1)
      expect(JSON.parse(response?.payload || 'null')).toMatchObject({
        behavior: 'allow',
        updatedInput: {
          answers: { 'Which scope?': 'Repository only' }
        },
        toolUseID: 'opaque-question-tool'
      })
      await handle.dispose()
    }

    expect(new Set(projectedAcrossRestarts).size).toBe(2)

  })

  it.each([
    {
      mode: 'permission',
      interactionId: 'pending-initialize-permission',
      response: harnessResponse({
        interactionId: 'pending-initialize-permission',
        actionId: 'allow'
      }, 'execution-pending-initialize'),
      expected: { behavior: 'allow' }
    },
    {
      mode: 'dialog',
      interactionId: 'pending-initialize-dialog',
      response: harnessResponse({
        interactionId: 'pending-initialize-dialog',
        actionId: 'submit',
        answers: {
          [publicQuestionId('pending-initialize-dialog', 0, 'execution-pending-initialize')]:
            'Continue with fallback'
        }
      }, 'execution-pending-initialize'),
      expected: { behavior: 'completed', result: 'Continue with fallback' }
    }
  ])('registers a pending $mode returned while resuming initialization', async ({
    mode,
    interactionId,
    response,
    expected
  }) => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => ({
        ...process.env,
        OPENAGENT_FAKE_PENDING_INITIALIZE: mode
      })
    })
    let record = threadRecord(fixture.directory)
    record = {
      ...record,
      sessionState: {
        version: 1,
        primarySessionId: '00000000-0000-4000-8000-000000000001',
        turns: [],
        nativeNotifications: []
      }
    }
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))

    await handle.send({
      executionId: 'execution-pending-initialize',
      input: { parts: [{ kind: 'text', text: 'pending-initialize' }] },
      signal: new AbortController().signal
    })
    await waitFor(() =>
      record.observation.latestExecution?.status === 'waiting-for-user'
    )
    expect(record.observation.latestExecution).toMatchObject({
      interactions: [{ id: publicInteractionId(interactionId, record.observation.latestExecution!.executionId) }]
    })
    await handle.respond(response)
    await waitFor(async () =>
      (await fakeLog(fixture.directory)).some(
        (entry) => entry.requestId === interactionId
      )
    )
    expect(JSON.parse(
      (await fakeLog(fixture.directory)).find(
        (entry) => entry.requestId === interactionId
      )?.payload || 'null'
    )).toMatchObject(expected)
    await handle.dispose()
  })

  it('moves foreground and late background approvals into responsive execution wakes', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const commits: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits,
      // Keep interaction-resolved delivery in flight long enough for the fake
      // native process to enqueue its next request on the same synthetic wake.
      onChange: () => new Promise((resolve) => setTimeout(resolve, 25))
    }))

    await handle.send({
      executionId: 'execution-background-approvals',
      input: { parts: [{ kind: 'text', text: 'background-approvals' }] },
      signal: new AbortController().signal
    })
    await waitFor(() =>
      terminalCount(commits, 'execution-background-approvals') === 1 &&
      record.observation.latestExecution?.status === 'waiting-for-user' &&
      record.observation.latestExecution.interactions[0].id ===
        publicInteractionId('background-before-result', record.observation.latestExecution!.executionId)
    )
    const interactionWakeId = record.observation.latestExecution?.executionId
    expect(interactionWakeId).toBeTruthy()
    expect(record.observation.backgroundWork).toEqual({ status: 'running' })
    await handle.respond({
      interactionId: publicInteractionId('background-before-result', record.observation.latestExecution!.executionId),
      actionId: 'deny',
      message: 'Skip the first operation'
    })
    await waitFor(() =>
      record.observation.latestExecution?.status === 'waiting-for-user' &&
      record.observation.latestExecution.interactions[0].id ===
        publicInteractionId('background-after-result', record.observation.latestExecution!.executionId)
    )
    expect(record.observation.latestExecution?.executionId).toBe(interactionWakeId)
    expect(terminalCount(commits, interactionWakeId!)).toBe(0)
    await handle.respond({
      interactionId: publicInteractionId('background-after-result', record.observation.latestExecution!.executionId),
      actionId: 'allow'
    })
    await waitFor(async () => {
      const entries = await fakeLog(fixture.directory)
      return terminalCount(commits, interactionWakeId!) === 1 &&
        entries.some((entry) => entry.requestId === 'background-before-result') &&
        entries.some((entry) => entry.requestId === 'background-after-result')
    })
    await waitFor(() =>
      record.observation.backgroundWork === null &&
      parseClaudeThreadState(record.sessionState).runtime?.backgroundTasks?.length === 0
    )
    expect((await fakeLog(fixture.directory)).filter(
      (entry) => entry.type === 'control-response'
    ).map((entry) => entry.requestId)).toEqual([
      'background-before-result',
      'background-after-result'
    ])
    await handle.dispose()
  })

  it('preserves a control request parsed after the foreground result but before terminal delivery', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const commits: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits
    }))

    await handle.send({
      executionId: 'execution-result-before-control',
      input: { parts: [{ kind: 'text', text: 'result-before-control' }] },
      signal: new AbortController().signal
    })
    await waitFor(() =>
      terminalCount(commits, 'execution-result-before-control') === 1 &&
      record.observation.latestExecution?.status === 'waiting-for-user' &&
      record.observation.latestExecution.interactions[0].id ===
        publicInteractionId('control-after-result', record.observation.latestExecution!.executionId)
    )
    await handle.respond({
      interactionId: publicInteractionId('control-after-result', record.observation.latestExecution!.executionId),
      actionId: 'allow'
    })
    await waitFor(async () =>
      (await fakeLog(fixture.directory)).some(
        (entry) => entry.requestId === 'control-after-result'
      )
    )
    expect(JSON.parse(
      (await fakeLog(fixture.directory)).find(
        (entry) => entry.requestId === 'control-after-result'
      )?.payload || 'null'
    )).toMatchObject({ behavior: 'allow' })
    await handle.dispose()
  })

  it('fails stale persisted background work when reopening a Thread', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    record = {
      ...record,
      sessionState: {
        version: 1,
        primarySessionId: '00000000-0000-4000-8000-000000000002',
        turns: [{
          executionId: 'completed-with-background',
          createdAt: 10,
          updatedAt: 11,
          prompts: ['Start task'],
          promptAttachments: [[]],
          text: 'Foreground finished',
          reasoning: '',
          finishedAt: 11,
          status: 'completed',
          plan: [],
          activities: [{
            id: 'task-stale',
            taskId: 'task-stale',
            kind: 'task',
            label: 'Stale task',
            status: 'running'
          }, {
            id: 'truncated-from-runtime-list',
            kind: 'command',
            label: 'Stale command omitted from runtime task list',
            status: 'running'
          }],
          interactions: [],
          notices: [],
          timeline: []
        }, {
          executionId: 'orphaned-foreground',
          createdAt: 12,
          updatedAt: 13,
          prompts: ['Foreground still running at restart'],
          promptAttachments: [[]],
          text: '',
          reasoning: '',
          status: 'running',
          plan: [],
          activities: [{
            id: 'orphaned-running-command',
            kind: 'command',
            label: 'Interrupted foreground command',
            status: 'running'
          }],
          interactions: [],
          notices: [],
          timeline: []
        }],
        runtime: {
          backgroundTasks: [{
            id: 'task-stale',
            description: 'Stale task',
            status: 'in_progress'
          }]
        },
        nativeNotifications: []
      },
      observation: {
        latestExecution: {
          executionId: 'completed-with-background',
          startedAt: 10,
          finishedAt: 11,
          status: 'completed'
        },
        backgroundWork: { status: 'running' }
      }
    }
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))

    const recovered = parseClaudeThreadState(record.sessionState)
    expect(recovered.runtime?.backgroundTasks).toMatchObject([
      { id: 'task-stale', status: 'failed' }
    ])
    expect(recovered.turns[0]?.activities).toMatchObject([
      { id: 'task-stale', status: 'failed' },
      { id: 'truncated-from-runtime-list', status: 'failed' }
    ])
    expect(recovered.turns[1]).toMatchObject({
      executionId: 'orphaned-foreground',
      status: 'interrupted',
      activities: [{ id: 'orphaned-running-command', status: 'cancelled' }]
    })
    expect(record.observation.backgroundWork).toBeNull()
    await handle.dispose()
  })

  it('preserves URL-mode elicitation identity and responds without treating it as a JSON form', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))

    await handle.send({
      executionId: 'execution-url-elicitation',
      input: { parts: [{ kind: 'text', text: 'url-elicitation' }] },
      signal: new AbortController().signal
    })
    await waitFor(() =>
      record.observation.latestExecution?.status === 'waiting-for-user'
    )
    const interaction = parseClaudeThreadState(record.sessionState)
      .turns.at(-1)?.interactions.at(-1)
    expect(interaction).toMatchObject({
      id: 'url-elicitation-response',
      kind: 'elicitation',
      title: 'Connect Example MCP',
      description: 'Complete authorization in the provider page',
      elicitationMode: 'url',
      url: 'https://mcp.example.test/elicitation/abc',
      elicitationId: 'native-elicitation-abc',
      serverName: 'example-mcp'
    })
    expect(record.observation.latestExecution).toMatchObject({
      interactions: [{
        id: publicInteractionId('url-elicitation-response', record.observation.latestExecution!.executionId),
        actions: [
          { id: 'submit', intent: 'submit' },
          { id: 'deny', intent: 'deny' },
          { id: 'cancel', intent: 'cancel' }
        ],
        questions: []
      }]
    })
    await handle.respond({
      interactionId: publicInteractionId('url-elicitation-response', record.observation.latestExecution!.executionId),
      actionId: 'submit'
    })
    await waitFor(() => record.observation.latestExecution?.status === 'completed')
    await handle.send({
      executionId: 'execution-url-elicitation-deny',
      input: { parts: [{ kind: 'text', text: 'url-elicitation' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.status === 'waiting-for-user')
    await handle.respond({
      interactionId: publicInteractionId('url-elicitation-response', record.observation.latestExecution!.executionId),
      actionId: 'deny'
    })
    await waitFor(() => record.observation.latestExecution?.status === 'completed')
    await handle.send({
      executionId: 'execution-url-elicitation-cancel',
      input: { parts: [{ kind: 'text', text: 'url-elicitation' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.status === 'waiting-for-user')
    await handle.respond({
      interactionId: publicInteractionId('url-elicitation-response', record.observation.latestExecution!.executionId),
      actionId: 'cancel'
    })
    await waitFor(async () =>
      (await fakeLog(fixture.directory)).filter(
        (entry) => entry.requestId === 'url-elicitation-response'
      ).length === 3
    )
    expect((await fakeLog(fixture.directory))
      .filter((entry) => entry.requestId === 'url-elicitation-response')
      .map((entry) => JSON.parse(entry.payload || 'null'))).toEqual([
      { action: 'accept' },
      { action: 'decline' },
      { action: 'cancel' }
    ])
    await handle.dispose()
  })

  it('retains permission presentation metadata and only offers session allow with native suggestions', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))

    await handle.send({
      executionId: 'execution-permission-metadata',
      input: { parts: [{ kind: 'text', text: 'permission-metadata' }] },
      signal: new AbortController().signal
    })
    await waitFor(() =>
      record.observation.latestExecution?.status === 'waiting-for-user'
    )
    expect(parseClaudeThreadState(record.sessionState).turns.at(-1)?.interactions.at(-1))
      .toMatchObject({
        title: '允许 Claude 使用 Run status command？',
        description: 'Needs repository status',
        canRemember: true
      })
    const rememberableExecution = record.observation.latestExecution
    expect(rememberableExecution?.status).toBe('waiting-for-user')
    if (rememberableExecution?.status !== 'waiting-for-user') {
      throw new Error('Missing Claude permission observation')
    }
    expect(rememberableExecution.interactions[0].actions).toEqual(
      expect.arrayContaining([{ id: 'allow-session', intent: 'allow', label: 'Allow for session' }])
    )
    await handle.respond({
      interactionId: publicInteractionId('permission-metadata-response', record.observation.latestExecution!.executionId),
      actionId: 'allow-session'
    })
    await waitFor(() => record.observation.latestExecution?.status === 'completed')
    expect(JSON.parse(
      (await fakeLog(fixture.directory)).find(
        (entry) => entry.requestId === 'permission-metadata-response'
      )?.payload || 'null'
    )).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'addRules' }]
    })

    await handle.send({
      executionId: 'execution-permission-no-suggestions',
      input: { parts: [{ kind: 'text', text: 'permission-no-suggestions' }] },
      signal: new AbortController().signal
    })
    await waitFor(() =>
      record.observation.latestExecution?.status === 'waiting-for-user'
    )
    expect(record.observation.latestExecution).toMatchObject({
      interactions: [{
        id: publicInteractionId('permission-no-suggestions-response', record.observation.latestExecution!.executionId),
        actions: [
          { id: 'allow', intent: 'allow' },
          { id: 'deny', intent: 'deny' },
          { id: 'cancel', intent: 'cancel' }
        ]
      }]
    })
    await expect(handle.respond({
      interactionId: publicInteractionId('permission-no-suggestions-response', record.observation.latestExecution!.executionId),
      actionId: 'allow-session'
    })).rejects.toThrow('不支持会话级授权')
    await handle.respond({
      interactionId: publicInteractionId('permission-no-suggestions-response', record.observation.latestExecution!.executionId),
      actionId: 'deny'
    })
    await handle.dispose()
  })

  it('projects parallel pending interactions and resolves them by ID out of order', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))

    await handle.send({
      executionId: 'execution-parallel-interactions',
      input: { parts: [{ kind: 'text', text: 'parallel-interactions' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => {
      const execution = record.observation.latestExecution
      return execution?.status === 'waiting-for-user' &&
        execution.interactions.length === 2
    })
    expect(record.observation.latestExecution).toMatchObject({
      interactions: [
        { id: publicInteractionId('parallel-first', record.observation.latestExecution!.executionId) },
        { id: publicInteractionId('parallel-second', record.observation.latestExecution!.executionId) }
      ]
    })

    await handle.respond({
      interactionId: publicInteractionId('parallel-second', record.observation.latestExecution!.executionId),
      actionId: 'allow'
    })
    expect(parseClaudeThreadState(record.sessionState).turns.at(-1)?.interactions)
      .toMatchObject([
        { id: 'parallel-first', status: 'pending' },
        { id: 'parallel-second', status: 'allowed' }
      ])
    expect(record.observation.latestExecution).toMatchObject({
      interactions: [{ id: publicInteractionId('parallel-first', record.observation.latestExecution!.executionId) }]
    })

    await handle.respond({
      interactionId: publicInteractionId('parallel-first', record.observation.latestExecution!.executionId),
      actionId: 'deny'
    })
    await waitFor(() => record.observation.latestExecution?.status === 'completed')
    expect((await fakeLog(fixture.directory))
      .filter((entry) => String(entry.requestId).startsWith('parallel-'))
      .map((entry) => entry.requestId)).toEqual([
      'parallel-second',
      'parallel-first'
    ])
    await handle.dispose()
  })

  it('keeps /goal pending across a failed first native initialization and consumes it after admission', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => ({
        ...process.env,
        OPENAGENT_FAKE_FAIL_FIRST_INITIALIZE: '1'
      })
    })
    let record = {
      ...threadRecord(fixture.directory),
      settings: { executablePath: 'claude', goalMode: true }
    } satisfies AgentThreadRecord<'claude', ClaudeThreadSettings>
    let handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))

    await handle.send({
      executionId: 'goal-first-failed',
      input: { parts: [{ kind: 'text', text: 'Initial goal' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.status === 'failed')
    expect(parseClaudeThreadState(record.sessionState).goalPromptPending).toBe(true)
    await handle.dispose()
    handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))

    await handle.send({
      executionId: 'goal-retry',
      input: {
        parts: [{
          kind: 'local-file',
          file: {
            id: 'goal-context-file',
            path: join(fixture.directory, 'context.txt'),
            name: 'context.txt',
            mimeType: 'text/plain',
            size: 7
          }
        }, { kind: 'text', text: 'Retry goal' }]
      },
      contextEntries: [{ id: 'workspace', content: 'Trusted runtime context' }],
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.status === 'completed')
    const users = (await fakeLog(fixture.directory)).filter(
      (entry) => entry.type === 'user'
    )
    expect(users).toHaveLength(1)
    const nativeContent = JSON.parse(users[0]?.content || 'null') as Array<{
      type: string
      text?: string
    }>
    expect(nativeContent.map((block) => block.text)).toEqual([
      '/goal Retry goal',
      '<openagent_run_context id="workspace">\nTrusted runtime context\n</openagent_run_context>',
      `[Attached local file: context.txt\nPath: ${join(fixture.directory, 'context.txt')}]`
    ])
    expect(parseClaudeThreadState(record.sessionState).goalPromptPending).toBeUndefined()
    await handle.dispose()
  })

  it('falls back from a failed native read fork to a persisted read-only snapshot workspace', async () => {
    const fixture = await createFakeClaude()
    const temporaryWorkspaceRoot = join(fixture.directory, 'read-workspaces')
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => ({
        ...process.env,
        OPENAGENT_FAKE_FAIL_FORK: '1'
      }),
      temporaryWorkspaceRoot
    })
    let record = threadRecord(fixture.directory)
    record = {
      ...record,
      sessionState: {
        version: 1,
        primarySessionId: '00000000-0000-4000-8000-000000000003',
        turns: [{
          executionId: 'persisted-read-source',
          createdAt: 1,
          updatedAt: 2,
          prompts: ['Original question'],
          promptAttachments: [[]],
          text: 'Persisted answer',
          reasoning: '',
          finishedAt: 2,
          status: 'completed',
          plan: [],
          activities: [],
          interactions: [],
          notices: [],
          timeline: []
        }],
        nativeNotifications: []
      }
    }
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))

    await expect(handle.read(
      'What was persisted?',
      new AbortController().signal
    )).resolves.toBe('snapshot answer')
    const logs = await fakeLog(fixture.directory)
    expect(logs).toContainEqual({
      type: 'snapshot-read',
      executionId: 'persisted-read-source'
    })
    expect(logs.filter((entry) => entry.type === 'process').map((entry) => entry.fork))
      .toEqual(['true', 'false'])
    const [nativeAttempt, snapshotAttempt] = logs.filter(
      (entry) => entry.type === 'process'
    )
    // The native fork attempt already reuses the source tool set (no isolation).
    const nativeArgs = JSON.parse(nativeAttempt!.args) as string[]
    expect(nativeArgs).not.toContain('--tools')
    expect(nativeArgs[nativeArgs.indexOf('--permission-mode') + 1]).toBe('auto')
    // The snapshot fallback is a distinct path: it exists only for a source
    // Thread without a native session, so there is no prefix to align with and
    // it keeps the read-only, non-interactive request construction.
    const snapshotArgs = JSON.parse(snapshotAttempt!.args) as string[]
    expect(snapshotArgs[snapshotArgs.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(snapshotArgs[snapshotArgs.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep')
    expect(snapshotArgs[snapshotArgs.indexOf('--disallowedTools') + 1])
      .toBe('Bash,Edit,Write,WebFetch,WebSearch')
    expect(snapshotAttempt?.cwd).toContain('/read-workspaces/claude-read-')
    expect(await readdir(temporaryWorkspaceRoot)).toEqual([])
    await handle.dispose()
  })

  it('answers a native read with the source Thread request construction so the fork prefix matches', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record: AgentThreadRecord<'claude', ClaudeThreadSettings> = {
      ...threadRecord(fixture.directory),
      settings: {
        executablePath: 'claude',
        permissionMode: 'manual',
        allowedTools: ['Read', 'Bash'],
        disallowedTools: ['Write']
      }
    }
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))
    cleanups.push(() => handle.dispose())
    await handle.send({
      executionId: 'read-prefix-source',
      input: { parts: [{ kind: 'text', text: 'normal' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.status === 'completed')

    await expect(handle.read(
      'What did this thread do?',
      new AbortController().signal
    )).resolves.toBe('hello')

    const processes = (await fakeLog(fixture.directory)).filter(
      (entry) => entry.type === 'process'
    )
    const source = processes.find((entry) => entry.fork === 'false')
    const read = processes.find((entry) => entry.fork === 'true')
    expect(read).toMatchObject({ resume: expect.any(String) })
    const sourceArgs = JSON.parse(source!.args) as string[]
    const readArgs = JSON.parse(read!.args) as string[]
    // The native fork must reuse the source tool set instead of re-isolating it
    // (`--tools ''`), which would break the first cacheable block.
    expect(readArgs).not.toContain('--tools')
    expect(readArgs).not.toContain('--strict-mcp-config')
    expect(readArgs).not.toContain('--mcp-config')
    expect(readArgs).not.toContain('--bare')
    expect(sourceArgs).not.toContain('--tools')
    // Prefix-relevant fields are byte-for-byte equal on both sides.
    expect(readArgs[readArgs.indexOf('--permission-mode') + 1])
      .toBe(sourceArgs[sourceArgs.indexOf('--permission-mode') + 1])
    expect(readArgs[readArgs.indexOf('--permission-mode') + 1]).toBe('manual')
    // The tool allow / deny lists also determine the request's tool list.
    expect(readArgs[readArgs.indexOf('--allowedTools') + 1])
      .toBe(sourceArgs[sourceArgs.indexOf('--allowedTools') + 1])
    expect(readArgs[readArgs.indexOf('--disallowedTools') + 1])
      .toBe(sourceArgs[sourceArgs.indexOf('--disallowedTools') + 1])
    expect(readArgs[readArgs.indexOf('--allowedTools') + 1]).toBe('Read,Bash')
    expect(readArgs[readArgs.indexOf('--disallowedTools') + 1]).toBe('Write')
    await handle.dispose()
  })

  it('refuses a Thread Read whose source carries an injection instead of diverging from it', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const handle = await plugin.openThread({
      ...createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: next => { record = next }
      }),
      injection: {
        instructions: ['Thread instruction: use the supplied context.'],
        tools: { mode: 'exclusive', bindings: [] }
      }
    })
    cleanups.push(() => handle.dispose())
    await handle.send({
      executionId: 'injected-read-source',
      input: { parts: [{ kind: 'text', text: 'normal' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.status === 'completed')

    // Read reuses the source's request construction, and the injected tool
    // bridge / system prompt never reaches the read fork: answering from such a
    // source would hand back a different tool set than the Thread claims to
    // read. Fail loudly, before any native process starts.
    await expect(handle.read(
      'What did this thread do?',
      new AbortController().signal
    )).rejects.toThrow('Thread Read does not support a source Thread with an injection')

    const processes = (await fakeLog(fixture.directory)).filter(
      (entry) => entry.type === 'process'
    )
    expect(processes.some((entry) => entry.fork === 'true')).toBe(false)
  })

  it.each(['running', 'in_progress', 'in-progress', 'inProgress'])(
    'normalizes native background status %s as public running work',
    async (status) => {
      const fixture = await createFakeClaude()
      const plugin = createClaudeMainPlugin({
        resolveExecutable: async () => fixture.executable,
        environment: async () => process.env
      })
      let record = threadRecord(fixture.directory)
      const handle = await plugin.openThread(createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: next => { record = next }
      }))

      await handle.send({
        executionId: `background-${status}`,
        input: { parts: [{ kind: 'text', text: `background-status:${status}` }] },
        signal: new AbortController().signal
      })
      await waitFor(() => record.observation.latestExecution?.status === 'completed')
      expect(record.observation.backgroundWork).toEqual({ status: 'running' })
      expect(parseClaudeThreadState(record.sessionState).runtime?.backgroundTasks)
        .toMatchObject([{ status }])
      await handle.dispose()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'preempts an in-flight initialization before the controller queue can drain',
    async () => {
      const fixture = await createFakeClaude()
      const plugin = createClaudeMainPlugin({
        resolveExecutable: async () => fixture.executable,
        environment: async () => ({
          ...process.env,
          OPENAGENT_FAKE_HANG_INITIALIZE: '1',
          OPENAGENT_FAKE_IGNORE_INTERRUPT: '1',
          OPENAGENT_FAKE_IGNORE_TERM: '1'
        }),
        interruptTimeouts: { controlMs: 50, termMs: 75, killMs: 1_000 }
      })
      let record = threadRecord(fixture.directory)
      const commits: TestAgentChange[] = []
      const handle = await plugin.openThread(createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: next => { record = next },
        changes: commits
      }))
      const sending = handle.send({
        executionId: 'hung-initialize',
        input: { parts: [{ kind: 'text', text: 'Never admitted' }] },
        signal: new AbortController().signal
      })
      await waitFor(async () =>
        (await fakeLog(fixture.directory)).some(
          (entry) => entry.subtype === 'initialize-hung'
        )
      )
      const pid = Number((await fakeLog(fixture.directory)).find(
        (entry) => entry.type === 'process'
      )?.pid)

      const startedAt = Date.now()
      await handle.interrupt()
      await sending
      expect(Date.now() - startedAt).toBeLessThan(1_500)
      expect(processIsRunning(pid)).toBe(false)
      expect(record.observation.latestExecution?.status).toBe('interrupted')
      expect(commits.flatMap((commit) => commit.lifecycle ? [commit.lifecycle] : []))
        .toEqual([
          { type: 'started', executionId: 'hung-initialize' },
          { type: 'terminal', executionId: 'hung-initialize', outcome: 'interrupted' }
        ])
      await handle.dispose()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'escalates a timed-out interrupt from SIGTERM to SIGKILL and can respawn cleanly',
    async () => {
      const fixture = await createFakeClaude()
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        OPENAGENT_FAKE_IGNORE_INTERRUPT: '1',
        OPENAGENT_FAKE_IGNORE_TERM: '1'
      }
      const events: Array<{ type: string; executionId?: string }> = []
      const transport = new ClaudeTransport({
        executable: fixture.executable,
        cwd: fixture.directory,
        environment,
        sessionId: '00000000-0000-4000-8000-000000000004',
        resume: false,
        settings: { executablePath: fixture.executable },
        interactive: true,
        persistSession: true,
        interruptTimeouts: { controlMs: 50, termMs: 75, killMs: 1_000 },
        onEvent: (event) => { events.push(event) }
      })
      cleanups.push(async () => {
        await transport.dispose().catch(() => undefined)
        for (const entry of await fakeLog(fixture.directory)) {
          if (entry.type !== 'process') continue
          const pid = Number(entry.pid)
          if (!Number.isSafeInteger(pid) || !processIsRunning(pid)) continue
          try { process.kill(pid, 'SIGKILL') } catch {}
        }
      })

      await transport.send(
        'poisoned-execution',
        { parts: [{ kind: 'text', text: 'hang-read' }] },
        'now',
        new AbortController().signal
      )
      await waitFor(async () =>
        (await fakeLog(fixture.directory)).some((entry) => entry.type === 'user')
      )
      const firstPid = Number((await fakeLog(fixture.directory)).find(
        (entry) => entry.type === 'process'
      )?.pid)
      await expect(transport.interrupt()).rejects.toThrow('控制请求超时')
      expect(processIsRunning(firstPid)).toBe(false)
      // The forced shutdown confirmed the process tree is gone, so the session end
      // is announced here even though the close handler stays silent (`stopping`).
      expect(events.filter((event) => event.type === 'process-exit')).toHaveLength(1)
      expect(await fakeLog(fixture.directory)).toContainEqual({
        type: 'signal',
        target: 'process',
        signal: 'SIGTERM'
      })

      transport.abandonActiveExecution('poisoned-execution')
      delete environment.OPENAGENT_FAKE_IGNORE_TERM
      await transport.send(
        'replacement-execution',
        { parts: [{ kind: 'text', text: 'replacement succeeds' }] },
        'now',
        new AbortController().signal
      )
      await waitFor(() => events.some(
        (event) => event.type === 'done'
      ))
      expect((await fakeLog(fixture.directory)).filter(
        (entry) => entry.type === 'process'
      )).toHaveLength(2)
      await transport.dispose()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'disposes 500 pending interactions within one fixed shutdown window',
    async () => {
      const fixture = await createFakeClaude()
      const events: Array<{ type: string }> = []
      const transport = new ClaudeTransport({
        executable: fixture.executable,
        cwd: fixture.directory,
        environment: {
          ...process.env,
          OPENAGENT_FAKE_IGNORE_TERM: '1'
        },
        sessionId: '00000000-0000-4000-8000-000000000008',
        resume: false,
        settings: { executablePath: fixture.executable },
        interactive: true,
        persistSession: true,
        interruptTimeouts: { termMs: 75, killMs: 1_000 },
        onEvent: (event) => { events.push(event) }
      })
      cleanups.push(async () => {
        await transport.dispose().catch(() => undefined)
      })

      await transport.send(
        'many-pending-interactions-execution',
        { parts: [{ kind: 'text', text: 'many-pending-interactions' }] },
        'now',
        new AbortController().signal
      )
      await waitFor(() =>
        events.filter(({ type }) => type === 'interaction').length === 500,
      10_000)
      const pid = Number((await fakeLog(fixture.directory)).find(
        (entry) => entry.type === 'process'
      )?.pid)

      const startedAt = Date.now()
      await transport.dispose()
      expect(Date.now() - startedAt).toBeLessThan(1_500)
      expect(processIsRunning(pid)).toBe(false)
      expect(await fakeLog(fixture.directory)).toContainEqual({
        type: 'signal',
        target: 'process',
        signal: 'SIGTERM'
      })
    }
  )

  it('cancels an isolated read through its caller signal', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    const commits: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits
    }))
    const commitsBeforeRead = [...commits]
    const controller = new AbortController()
    const reading = handle.read('hang-read', controller.signal)
    await waitFor(async () =>
      (await fakeLog(fixture.directory)).some(
        (entry) => entry.type === 'user' && entry.content.includes('hang-read')
      )
    )
    controller.abort()
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(commits).toEqual(commitsBeforeRead)
    await handle.dispose()
  })

  it('does not admit a started Thread send after dispose aborts native initialization', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => ({
        ...process.env,
        OPENAGENT_FAKE_DELAY_INITIALIZE: '1'
      })
    })
    let record = threadRecord(fixture.directory)
    const commits: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits
    }))

    const sending = handle.send({
      executionId: 'dispose-during-initialize',
      input: { parts: [{ kind: 'text', text: 'must-not-be-admitted' }] },
      signal: new AbortController().signal
    })
    await waitFor(async () =>
      (await fakeLog(fixture.directory)).some(
        (entry) => entry.type === 'control' && entry.subtype === 'initialize'
      )
    )
    await Promise.all([sending, handle.dispose()])

    expect(
      commits.flatMap((commit) => (commit.lifecycle ? [commit.lifecycle] : []))
    ).toEqual([
      { type: 'started', executionId: 'dispose-during-initialize' },
      {
        type: 'terminal',
        executionId: 'dispose-during-initialize',
        outcome: 'interrupted'
      }
    ])
    expect(
      (await fakeLog(fixture.directory)).filter((entry) => entry.type === 'user')
    ).toEqual([])
  })

  it('exposes only the ordinary Thread capabilities', async () => {
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => '/unused/claude',
      environment: async () => ({})
    })
    let record = threadRecord('/tmp/project')
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))
    expect(handle).not.toHaveProperty('invokeAction')
    for (const method of ['send', 'respond', 'interrupt', 'read', 'dispose']) {
      expect(typeof handle[method as keyof typeof handle]).toBe('function')
    }
    await handle.dispose()
  })

  it('persists current native surface events in exact timeline occurrence order across restart', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    let record = threadRecord(fixture.directory)
    let resolveTerminal!: () => void
    const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve })
    const context = () => createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      onChange: change => {
        if (change.lifecycle?.type === 'terminal') resolveTerminal()
      }
    })
    const handle = await plugin.openThread(context())
    await handle.send({
      executionId: 'surface-events-execution',
      input: { parts: [{ kind: 'text', text: 'surface-events' }] },
      signal: new AbortController().signal
    })
    await terminal
    await waitFor(() => record.observation.latestExecution?.status === 'completed')

    const beforeRestart = parseClaudeThreadState(record.sessionState)
    const turn = beforeRestart.turns.at(-1)
    expect(turn).toMatchObject({
      diff: 'diff --git a/a.ts b/a.ts',
      review: 'Review found one issue',
      compacted: true,
      text: 'surface answer'
    })
    expect(turn?.timeline.map(({ kind }) => kind)).toEqual([
      'user-message',
      'diff',
      'review',
      'context-compaction',
      'assistant'
    ])
    await handle.dispose()

    const reopened = await plugin.openThread(context())
    expect(parseClaudeThreadState(record.sessionState)).toEqual(beforeRestart)
    await reopened.dispose()
  })

  it('keeps pending native fork/history across restart and consumes only the intent on first send', async () => {
    const fixture = await createFakeClaude()
    const plugin = createClaudeMainPlugin({
      resolveExecutable: async () => fixture.executable,
      environment: async () => process.env
    })
    const source: AgentThreadRecord<'claude', ClaudeThreadSettings> = {
      ...completedThreadRecord(fixture.directory),
      id: 'claude-source-thread',
      title: 'Claude source'
    }
    const derived = await plugin.forkThread?.({
      source,
      request: { checkpointId: 'native-user-message-1' },
      signal: new AbortController().signal
    })
    if (!derived) throw new Error('Claude Thread fork unavailable')
    let record: AgentThreadRecord<'claude', ClaudeThreadSettings> = {
      ...threadRecord(fixture.directory),
      id: 'claude-fork-target',
      title: derived.title || 'Claude fork',
      sessionState: derived.sessionState
    }
    const open = () => plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))

    const beforeRestart = parseClaudeThreadState(record.sessionState)
    expect(beforeRestart.pendingFork).toEqual({
      sourceSessionId: 'native-session-source',
      checkpointId: 'native-user-message-1'
    })
    expect(beforeRestart.forkHistory?.items.flatMap((item) =>
      item.kind === 'user-message' || item.kind === 'assistant'
        ? [{ kind: item.kind, content: item.content }]
        : []
    )).toEqual([
      { kind: 'user-message', content: 'hello' },
      { kind: 'assistant', content: 'answer' }
    ])
    const firstHandle = await open()
    await firstHandle.dispose()
    expect(parseClaudeThreadState(record.sessionState).pendingFork).toEqual(
      beforeRestart.pendingFork
    )

    let resolveTerminal!: () => void
    const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve })
    const secondHandle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      onChange: change => {
        if (change.lifecycle?.type === 'terminal') resolveTerminal()
      }
    }))
    await secondHandle.send({
      executionId: 'public-fork-execution',
      input: { parts: [{ kind: 'text', text: 'continue from fork' }] },
      signal: new AbortController().signal
    })
    await terminal
    await waitFor(() => record.observation.latestExecution?.status === 'completed')

    const afterSend = parseClaudeThreadState(record.sessionState)
    expect(afterSend.pendingFork).toBeUndefined()
    expect(afterSend.primarySessionId).toBeTruthy()
    expect(afterSend.primarySessionId).not.toBe('native-session-source')
    expect(afterSend.forkHistory).toEqual(beforeRestart.forkHistory)
    expect(JSON.stringify(afterSend.forkHistory)).not.toContain(
      'public-execution-source'
    )
    expect(await fakeLog(fixture.directory)).toContainEqual(expect.objectContaining({
      type: 'process',
      fork: 'true',
      resume: 'native-session-source',
      resumeAt: 'native-user-message-1'
    }))
    await secondHandle.dispose()
  })

  it.skipIf(process.platform === 'win32')(
    'waits for an in-flight read and kills its TERM-ignoring process-group descendant',
    async () => {
      const fixture = await createFakeClaude()
      cleanups.push(async () => {
        const entries = await fakeLog(fixture.directory)
        for (const entry of entries) {
          if (!['process', 'descendant'].includes(entry.type)) continue
          const pid = Number(entry.pid)
          if (!Number.isSafeInteger(pid) || !processIsRunning(pid)) continue
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
      })
      const plugin = createClaudeMainPlugin({
        resolveExecutable: async () => fixture.executable,
        environment: async () => ({
          ...process.env,
          OPENAGENT_FAKE_TERM_DESCENDANT: '1'
        })
      })
      let record = threadRecord(fixture.directory)
      const handle = await plugin.openThread(createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: next => { record = next }
      }))
      const reading = handle.read(
        'hang-read',
        new AbortController().signal
      )
      let readSettled = false
      void reading.then(
        () => { readSettled = true },
        () => { readSettled = true }
      )
      await waitFor(async () => {
        const entries = await fakeLog(fixture.directory)
        return (
          entries.some((entry) => entry.type === 'user') &&
          entries.some((entry) => entry.type === 'descendant')
        )
      })
      const entries = await fakeLog(fixture.directory)
      const processEntry = entries.find(
        (entry) => entry.type === 'process'
      )
      const descendantEntry = entries.find(
        (entry) => entry.type === 'descendant'
      )
      const pid = Number(processEntry?.pid)
      const descendantPid = Number(descendantEntry?.pid)
      expect(Number.isSafeInteger(pid)).toBe(true)
      expect(Number.isSafeInteger(descendantPid)).toBe(true)

      const startedAt = Date.now()
      await handle.dispose()
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_800)
      expect(readSettled).toBe(true)
      await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
      expect(await fakeLog(fixture.directory)).toContainEqual({
        type: 'signal',
        target: 'descendant',
        signal: 'SIGTERM'
      })
      expect(processIsRunning(pid)).toBe(false)
      expect(processIsRunning(descendantPid)).toBe(false)
    }
  )

  it('rejects empty session identities and oversized persisted state', () => {
    expect(CLAUDE_PERMISSION_MODES).toEqual([
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'manual',
      'dontAsk',
      'plan'
    ])
    expect(() =>
      parseClaudeThreadState({
        version: 1,
        primarySessionId: '',
        turns: [],
        nativeNotifications: []
      })
    ).toThrow(/primarySessionId/)
    expect(() =>
      parseClaudeThreadState({
        version: 1,
        turns: [],
        nativeNotifications: [
          { summary: 'x'.repeat(CLAUDE_STATE_LIMITS.nativeNotificationCharacters + 1) }
        ]
      })
    ).toThrow(/native notification/)
    expect(() => parseClaudeThreadState(null)).toThrow(/sessionState/)
    expect(() => parseClaudeThreadState(undefined)).toThrow(/sessionState/)
  })

  it('requires generic Thread defaults as an own object and rejects removed profiles', () => {
    const inherited = Object.create({
      threadSettings: {}
    }) as unknown
    const malformed: unknown[] = [
      {},
      { threadSettings: null },
      { defaultThreadSettings: null, threadSettings: {} },
      { threadSettings: [] },
      inherited
    ]
    for (const value of malformed) {
      expect(() =>
        normalizeClaudeHarnessSettings(value as ClaudeHarnessSettings)
      ).toThrow()
    }
    expect(normalizeClaudeHarnessSettings(DEFAULT_CLAUDE_HARNESS_SETTINGS)).toEqual(
      DEFAULT_CLAUDE_HARNESS_SETTINGS
    )
  })

  it('keeps the use-default Thread settings flag explicit and never writes true', () => {
    expect(normalizeClaudeHarnessSettings({
      useDefaultThreadSettings: false,
      threadSettings: {}
    })).toStrictEqual({ useDefaultThreadSettings: false, threadSettings: {} })

    // Stored Thread values without the flag are canonicalized away: the
    // Agent's defaults win until the switch turns them off (A3).
    expect(normalizeClaudeHarnessSettings({
      threadSettings: { model: 'sonnet' }
    })).toStrictEqual({ threadSettings: {} })

    expect(normalizeClaudeHarnessSettings({ threadSettings: {} }))
      .toStrictEqual({ threadSettings: {} })
    expect(normalizeClaudeHarnessSettings({
      useDefaultThreadSettings: true,
      threadSettings: {}
    })).toStrictEqual({ threadSettings: {} })
  })

  it('drops persisted Thread defaults while the flag is absent or true', () => {
    // Regression P1-a: a payload that carries Thread values without the
    // customization flag must not execute against hidden custom settings.
    expect(defaultClaudeThreadSettings({
      threadSettings: { model: 'sonnet', effort: 'high', permissionMode: 'manual' }
    })).toEqual({ executablePath: 'claude', permissionMode: 'auto' })
    expect(defaultClaudeThreadSettings({
      useDefaultThreadSettings: true,
      threadSettings: { model: 'sonnet' }
    })).toEqual({ executablePath: 'claude', permissionMode: 'auto' })
  })

  it('keeps custom Thread defaults only when the flag opts out', () => {
    expect(defaultClaudeThreadSettings({
      useDefaultThreadSettings: false,
      threadSettings: { model: 'sonnet', effort: 'high', permissionMode: 'manual' }
    })).toEqual({
      executablePath: 'claude',
      permissionMode: 'manual',
      model: 'sonnet',
      effort: 'high'
    })
  })

  it('rejects a harness-level executable and keeps the literal claude default', () => {
    // Regression P1-b: a settings key can never choose the executable (A1).
    expect(() => normalizeClaudeHarnessSettings({
      threadSettings: { executablePath: '/somewhere/claude' }
    })).toThrow('未知字段')
    expect(() => normalizeClaudeHarnessSettings({
      useDefaultThreadSettings: false,
      threadSettings: { executablePath: '/somewhere/claude' }
    })).toThrow('未知字段')
    expect(defaultClaudeThreadSettings({ threadSettings: {} }).executablePath)
      .toBe('claude')
  })

  it('rejects a non-boolean use-default flag', () => {
    // Regression P2-4: 'false', null and 0 must not read as defaults-enabled.
    for (const flag of ['false', null, 0]) {
      expect(() => normalizeClaudeHarnessSettings({
        useDefaultThreadSettings: flag as never,
        threadSettings: {}
      })).toThrow('useDefaultThreadSettings')
    }
  })
})

function threadRecord(
  cwd: string
): AgentThreadRecord<'claude', ClaudeThreadSettings> {
  return {
    id: 'claude-thread',
    harnessId: 'claude',
    archived: false,
    revision: 0,
    title: 'Claude thread',
    tags: [],
    cwd,
    sessionState: null,
    observation: { latestExecution: null, backgroundWork: null },
    settings: { executablePath: 'claude' },
    createdAt: 1,
    updatedAt: 1
  }
}

function completedThreadRecord(
  cwd: string
): AgentThreadRecord<'claude', ClaudeThreadSettings> {
  return {
    ...threadRecord(cwd),
    sessionState: {
      version: 1,
      primarySessionId: 'native-session-source',
      runtime: { cwd },
      turns: [{
        executionId: 'public-execution-source',
        createdAt: 1,
        updatedAt: 2,
        prompts: ['hello'],
        promptAttachments: [[]],
        text: 'answer',
        reasoning: '',
        finishedAt: 2,
        status: 'completed',
        plan: [],
        activities: [],
        interactions: [],
        notices: [],
        timeline: [{
          id: 'timeline-user-1',
          kind: 'user-message',
          createdAt: 1,
          promptIndex: 0,
          checkpointId: 'native-user-message-1'
        }, {
          id: 'timeline-assistant-1',
          kind: 'assistant',
          createdAt: 2,
          content: 'answer',
          status: 'complete'
        }]
      }],
      nativeNotifications: []
    },
    observation: {
      latestExecution: {
        executionId: 'public-execution-source',
        status: 'completed',
        startedAt: 1,
        finishedAt: 2
      },
      backgroundWork: null
    }
  }
}

function harnessResponse(value: HarnessRespondRequest, executionId: string): HarnessRespondRequest {
  return {
    ...value,
    interactionId: publicInteractionId(value.interactionId, executionId)
  }
}

function publicInteractionId(nativeInteractionId: string, executionId: string): string {
  return claudePublicInteractionId(executionId, nativeInteractionId)
}

function publicQuestionId(nativeInteractionId: string, index: number, executionId: string): string {
  return claudePublicQuestionId(executionId, nativeInteractionId, index)
}

function publicOptionId(
  nativeInteractionId: string,
  questionIndex: number,
  optionIndex: number,
  executionId: string
): string {
  return claudePublicOptionId(
    executionId,
    nativeInteractionId,
    questionIndex,
    optionIndex
  )
}

async function createFakeClaude(): Promise<{
  directory: string
  executable: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-claude-v1-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'claude')
  await writeFile(executable, FAKE_CLAUDE, { mode: 0o755 })
  return { directory, executable }
}

function terminalCount(
  commits: readonly TestAgentChange[],
  executionId: string
): number {
  return commits.filter(
    (commit) =>
      commit.lifecycle?.type === 'terminal' &&
      commit.lifecycle.executionId === executionId
  ).length
}

async function fakeLog(directory: string): Promise<Array<Record<string, string>>> {
  try {
    return (await readFile(join(directory, 'fake-log.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, string>)
  } catch {
    return []
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Claude event')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const FAKE_CLAUDE = `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('fixture-1.0.0')
  process.exit(0)
}
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const sessionArgument = process.argv.find((value) => value.startsWith('--session-id='))
const resumeArgument = process.argv.find((value) => value.startsWith('--resume='))
const resumeAtArgument = process.argv.find((value) => value.startsWith('--resume-session-at='))
const sessionId = sessionArgument
  ? sessionArgument.slice('--session-id='.length)
  : resumeArgument
    ? resumeArgument.slice('--resume='.length)
    : 'session-fallback'
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const log = (value) => fs.appendFileSync(
  path.join(__dirname, 'fake-log.jsonl'),
  JSON.stringify(value) + '\\n'
)
log({
  type: 'process',
  pid: String(process.pid),
  args: JSON.stringify(process.argv.slice(2)),
  cwd: process.cwd(),
  fork: process.argv.includes('--fork-session') ? 'true' : 'false',
  ...(resumeArgument ? { resume: resumeArgument.slice('--resume='.length) } : {}),
  ...(resumeAtArgument
    ? { resumeAt: resumeAtArgument.slice('--resume-session-at='.length) }
    : {})
})
if (process.env.OPENAGENT_FAKE_IGNORE_TERM === '1') {
  process.on('SIGTERM', () => log({
    type: 'signal',
    target: 'process',
    signal: 'SIGTERM'
  }))
}
if (process.env.OPENAGENT_FAKE_TERM_DESCENDANT === '1') {
  const { spawn } = require('node:child_process')
  const readyPath = path.join(__dirname, 'fake-descendant-ready')
  const descendantSource = [
    "const fs = require('node:fs')",
    "const logPath = process.env.OPENAGENT_FAKE_DESCENDANT_LOG",
    "process.on('SIGTERM', () => fs.appendFileSync(logPath, JSON.stringify({ type: 'signal', target: 'descendant', signal: 'SIGTERM' }) + String.fromCharCode(10)))",
    "fs.writeFileSync(process.env.OPENAGENT_FAKE_DESCENDANT_READY, 'ready')",
    "setInterval(() => {}, 1000)"
  ].join(';')
  const descendant = spawn(process.execPath, ['-e', descendantSource], {
    env: {
      ...process.env,
      OPENAGENT_FAKE_DESCENDANT_LOG: path.join(__dirname, 'fake-log.jsonl'),
      OPENAGENT_FAKE_DESCENDANT_READY: readyPath
    },
    stdio: 'ignore'
  })
  descendant.unref()
  const readyTimer = setInterval(() => {
    if (!fs.existsSync(readyPath)) return
    clearInterval(readyTimer)
    log({ type: 'descendant', pid: String(descendant.pid) })
  }, 5)
}
const rl = readline.createInterface({ input: process.stdin })
let lastResultUuid
let activeUserUuid
const parallelResponses = new Set()
let usageLedgerCount = 0

const result = (uuid, text = '', extra = {}) => {
  lastResultUuid = uuid
  send({
    type: 'result',
    session_id: sessionId,
    user_message_uuid: uuid,
    subtype: 'success',
    is_error: false,
    result: text,
    origin: { kind: 'human' },
    ...extra
  })
}

rl.on('line', (line) => {
  const value = JSON.parse(line)
  if (value.type === 'control_request') {
    if (value.request.subtype === 'initialize') log({ type: 'initialization', payload: JSON.stringify(value.request) })
    if (value.request.subtype !== 'initialize') {
      log({
        type: 'control',
        subtype: value.request.subtype,
        ...(value.request.mode ? { mode: value.request.mode } : {}),
        ...(value.request.serverName ? { serverName: value.request.serverName } : {}),
        ...(typeof value.request.enabled === 'boolean'
          ? { enabled: String(value.request.enabled) }
          : {}),
        ...(value.request.task_id ? { taskId: value.request.task_id } : {}),
        ...(value.request.tool_use_id ? { toolUseId: value.request.tool_use_id } : {}),
        ...(value.request.user_message_id
          ? { checkpointId: value.request.user_message_id }
          : {}),
        ...(typeof value.request.dry_run === 'boolean'
          ? { dryRun: String(value.request.dry_run) }
          : {})
      })
    }
    if (
      value.request.subtype === 'interrupt' &&
      process.env.OPENAGENT_FAKE_IGNORE_INTERRUPT === '1'
    ) {
      log({ type: 'control', subtype: 'interrupt-ignored' })
      return
    }
    if (
      value.request.subtype === 'initialize' &&
      process.env.OPENAGENT_FAKE_FAIL_FORK === '1' &&
      process.argv.includes('--fork-session')
    ) {
      send({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: value.request_id,
          error: 'native fork missing'
        }
      })
      return
    }
    const initializationFailure = path.join(__dirname, 'failed-first-initialize')
    if (
      value.request.subtype === 'initialize' &&
      process.env.OPENAGENT_FAKE_FAIL_FIRST_INITIALIZE === '1' &&
      !fs.existsSync(initializationFailure)
    ) {
      fs.writeFileSync(initializationFailure, 'failed')
      log({ type: 'initialize-failure' })
      process.exit(17)
      return
    }
    if (
      value.request.subtype === 'initialize' &&
      process.env.OPENAGENT_FAKE_HANG_INITIALIZE === '1'
    ) {
      log({ type: 'control', subtype: 'initialize-hung' })
      return
    }
    const respond = () => send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: value.request_id,
        response: value.request.subtype === 'initialize'
          ? {
              models: [{
                value: 'sonnet',
                displayName: 'Sonnet',
                supportedEffortLevels: ['low', 'high'],
                supportedReasoningEfforts: ['max']
              }],
              agents: [{ name: 'reviewer', description: 'Reviews code' }],
              commands: [{ name: 'compact', description: 'Compact context' }],
              skills: ['repo-review'],
              plugins: [{ name: 'fixture-plugin', version: '1.0.0' }],
              capabilities: ['native-controls'],
              claudeVersion: 'fixture-1.0.0'
            }
          : value.request.subtype === 'mcp_status'
            ? {
                mcpServers: [{
                  name: 'github',
                  status: 'connected',
                  serverInfo: 'fixture-server'
                }]
              }
            : value.request.subtype === 'get_context_usage'
              ? { totalTokens: 123, maxTokens: 1000 }
              : value.request.subtype === 'mcp_authenticate'
                ? {
                    authUrl: 'https://example.test/claude-auth',
                    requiresUserAction: true,
                    callbackExpected: false
                  }
                : value.request.subtype === 'stop_task'
                  ? { stopped: true }
                  : value.request.subtype === 'background_tasks'
                    ? { backgrounded: true }
                    : value.request.subtype === 'remote_control'
                      ? {
                          enabled: value.request.enabled,
                          sessionUrl: 'https://example.test/claude-remote',
                          environmentId: 'fixture-environment'
                        }
                      : value.request.subtype === 'rewind_files'
                        ? {
                            canRewind: true,
                            filesChanged: 2,
                            insertions: 3,
                            deletions: 1
                          }
                        : {},
        ...(value.request.subtype === 'initialize' &&
          process.env.OPENAGENT_FAKE_PENDING_INITIALIZE === 'permission'
          ? {
              pending_permission_requests: [{
                request_id: 'pending-initialize-permission',
                request: {
                  subtype: 'can_use_tool',
                  tool_name: 'Bash',
                  tool_use_id: 'pending-initialize-tool',
                  input: { command: 'pwd' }
                }
              }]
            }
          : process.env.OPENAGENT_FAKE_PENDING_INITIALIZE === 'dialog'
            ? {
                pending_user_dialog_requests: [{
                  request_id: 'pending-initialize-dialog',
                  request: {
                    subtype: 'request_user_dialog',
                    dialog_kind: 'refusal_fallback_prompt',
                    payload: { reason: 'resume' }
                  }
                }]
              }
          : {})
      }
    })
    if (
      value.request.subtype === 'initialize' &&
      process.env.OPENAGENT_FAKE_DELAY_INITIALIZE === '1'
    ) {
      log({ type: 'control', subtype: 'initialize' })
      setTimeout(respond, 1_000)
    } else {
      respond()
    }
    return
  }
  if (value.type === 'control_response') {
    log({
      type: 'control-response',
      requestId: value.response.request_id,
      payload: JSON.stringify(value.response.response)
    })
    if (
      value.response.request_id === 'background-before-result'
    ) {
      send({
        type: 'control_request',
        request_id: 'background-after-result',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'background-tool-after',
          input: { command: 'git status' }
        }
      })
    } else if (value.response.request_id === 'background-after-result') {
      setTimeout(() => send({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: []
      }), 300)
    } else if (String(value.response.request_id).startsWith('parallel-')) {
      parallelResponses.add(value.response.request_id)
      if (parallelResponses.size === 2 && activeUserUuid) {
        setTimeout(() => result(activeUserUuid), 0)
      }
    } else if (
      activeUserUuid &&
      !String(value.response.request_id).startsWith('background-')
    ) {
      setTimeout(() => result(activeUserUuid), 0)
    }
    return
  }
  if (value.type !== 'user') return
  activeUserUuid = value.uuid
  send({
    type: 'user',
    message: value.message,
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: value.uuid,
    isReplay: true,
    origin: { kind: 'human' }
  })
  send({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'sonnet',
    cwd: process.cwd()
  })
  const content = typeof value.message.content === 'string'
    ? value.message.content
    : JSON.stringify(value.message.content)
  log({ type: 'user', content })
  if (content.includes('Read thread.json')) {
    if (content.includes('hang-read')) return
    const snapshotPath = path.join(process.cwd(), 'thread.json')
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
    log({
      type: 'snapshot-read',
      executionId: String(snapshot.turns && snapshot.turns[0] && snapshot.turns[0].executionId)
    })
    send({
      type: 'stream_event',
      user_message_uuid: value.uuid,
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'snapshot answer' }
      }
    })
    result(value.uuid)
    return
  }
  if (content.includes('surface-events')) {
    send({ type: 'diff_update', diff: 'diff --git a/a.ts b/a.ts' })
    send({ type: 'review_update', text: 'Review found one issue' })
    send({ type: 'system', subtype: 'compact_boundary' })
    send({
      type: 'stream_event',
      user_message_uuid: value.uuid,
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'surface answer' }
      }
    })
    result(value.uuid)
    return
  }
  if (content.includes('delta-burst-hang') || content.includes('delta-burst-terminal')) {
    setTimeout(() => {
      for (let index = 0; index < 100; index += 1) {
        send({
          type: 'stream_event',
          user_message_uuid: value.uuid,
          event: {
            type: 'content_block_delta',
            delta: index % 2 === 0
              ? { type: 'text_delta', text: 't' }
              : { type: 'thinking_delta', thinking: 'r' }
          }
        })
      }
      log({ type: 'delta-burst-emitted' })
      if (content.includes('delta-burst-terminal')) result(value.uuid)
    }, 100)
    return
  }
  if (content.includes('permission-denial')) {
    send({
      type: 'control_request',
      request_id: 'permission-response',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'tool-permission',
        input: { command: 'rm generated.tmp' }
      }
    })
    return
  }
  if (content.includes('many-pending-interactions')) {
    for (let index = 0; index < 500; index += 1) {
      send({
        type: 'control_request',
        request_id: 'mass-pending-' + String(index),
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'mass-tool-' + String(index),
          input: { command: 'echo ' + String(index) }
        }
      })
    }
    // Model a CLI that stops consuming replies. Synchronous per-reply log I/O
    // must not starve its SIGTERM handler before the fixed SIGKILL deadline.
    process.stdin.pause()
    setInterval(() => {}, 1000)
    return
  }
  if (content.includes('opaque-interaction-id')) {
    send({
      type: 'control_request',
      request_id: 'native/request?scope[]=repository#' + 'x'.repeat(320),
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'opaque-question-tool',
        input: {
          questions: [{
            question: 'Which scope?',
            header: 'Scope',
            multiSelect: false,
            options: [
              { label: 'Repository only', description: 'Use this repository' },
              { label: 'All workspaces', description: 'Use every workspace' }
            ]
          }]
        }
      }
    })
    return
  }
  if (content.includes('long-colliding-question')) {
    send({
      type: 'control_request',
      request_id: 'long-colliding-question-response',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'long-colliding-question-tool',
        input: {
          questions: [{
            question: 'Q'.repeat(10000) + '-first',
            multiSelect: false,
            options: [
              { label: 'O'.repeat(2000) + '-first' },
              { label: 'O'.repeat(2000) + '-second' }
            ]
          }, {
            question: 'Q'.repeat(10000) + '-second',
            multiSelect: false,
            options: [
              { label: 'P'.repeat(2000) + '-first' },
              { label: 'P'.repeat(2000) + '-second' }
            ]
          }]
        }
      }
    })
    return
  }
  if (content.includes('elicitation-response')) {
    send({
      type: 'control_request',
      request_id: 'elicitation-response',
      request: {
        subtype: 'elicitation',
        title: 'Release options',
        requested_schema: { type: 'object' }
      }
    })
    return
  }
  if (content.includes('url-elicitation')) {
    send({
      type: 'control_request',
      request_id: 'url-elicitation-response',
      request: {
        subtype: 'elicitation',
        mode: 'url',
        url: 'https://mcp.example.test/elicitation/abc',
        elicitation_id: 'native-elicitation-abc',
        display_name: 'Connect Example MCP',
        message: 'Complete authorization in the provider page',
        mcp_server_name: 'example-mcp',
        requested_schema: { type: 'object', properties: { ignored: { type: 'string' } } }
      }
    })
    return
  }
  if (content.includes('permission-metadata')) {
    send({
      type: 'control_request',
      request_id: 'permission-metadata-response',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        display_name: 'Run status command',
        decision_reason: 'Needs repository status',
        tool_use_id: 'permission-metadata-tool',
        input: { command: 'git status' },
        permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }]
      }
    })
    return
  }
  if (content.includes('permission-no-suggestions')) {
    send({
      type: 'control_request',
      request_id: 'permission-no-suggestions-response',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        display_name: 'Run one command',
        tool_use_id: 'permission-no-suggestions-tool',
        input: { command: 'pwd' }
      }
    })
    return
  }
  if (content.includes('parallel-interactions')) {
    send({
      type: 'control_request',
      request_id: 'parallel-first',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'parallel-tool-first',
        input: { command: 'pwd' }
      }
    })
    send({
      type: 'control_request',
      request_id: 'parallel-second',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        tool_use_id: 'parallel-tool-second',
        input: { file_path: 'README.md' }
      }
    })
    return
  }
  if (content.includes('background-across-first')) {
    send({ type: 'system', subtype: 'task_started', task_id: 'old-native-task', description: 'Background from first execution' })
    send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'old-native-task', description: 'Background from first execution', status: 'running' }] })
    result(value.uuid, 'First execution finished')
    return
  }
  if (content.includes('background-across-second')) {
    setTimeout(() => send({ type: 'system', subtype: 'task_notification', task_id: 'old-native-task', status: 'completed', summary: 'Old task completed during next execution' }), 30)
    setTimeout(() => result(value.uuid, 'Newest execution finished'), 120)
    setTimeout(() => send({ type: 'system', subtype: 'task_notification', task_id: 'old-native-task', status: 'completed', summary: 'Old task final notification' }), 200)
    return
  }
  if (content.includes('background-process-exit')) {
    send({ type: 'system', subtype: 'task_started', task_id: 'crash-native-task', description: 'Background from a dying process' })
    send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'crash-native-task', description: 'Background from a dying process', status: 'running' }] })
    result(value.uuid, 'Turn finished before the process died')
    setTimeout(() => process.exit(1), 200)
    return
  }
  if (content.includes('background-interrupt-hang')) {
    send({ type: 'system', subtype: 'task_started', task_id: 'interrupt-native-task', description: 'Background during a forced interrupt' })
    send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'interrupt-native-task', description: 'Background during a forced interrupt', status: 'running' }] })
    // Never finishes: the interrupt has to fall back to killing the process tree.
    return
  }
  const backgroundStatus = content.match(/background-status:([A-Za-z_-]+)/)
  if (backgroundStatus) {
    send({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{
        task_id: 'background-status-task',
        task_type: 'agent',
        description: 'Background status task',
        status: backgroundStatus[1]
      }]
    })
    result(value.uuid)
    return
  }
  if (content.includes('dialog-response')) {
    send({
      type: 'control_request',
      request_id: 'dialog-response',
      request: {
        subtype: 'request_user_dialog',
        dialog_kind: 'refusal_fallback_prompt',
        payload: { reason: 'blocked' }
      }
    })
    return
  }
  if (content.includes('pending-initialize')) return
  if (content.includes('background-approvals')) {
    send({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{
        task_id: 'background-task',
        task_type: 'agent',
        description: 'Background task',
        status: 'running'
      }]
    })
    send({
      type: 'control_request',
      request_id: 'background-before-result',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'background-tool-before',
        input: { command: 'pwd' }
      }
    })
    result(value.uuid)
    return
  }
  if (content.includes('result-before-control')) {
    result(value.uuid)
    send({
      type: 'control_request',
      request_id: 'control-after-result',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'tool-after-result',
        input: { command: 'git diff --stat' }
      }
    })
    return
  }
  if (content.includes('unsupported-interaction')) {
    send({
      type: 'control_request',
      request_id: 'unexpected-control',
      request: { subtype: 'future_native_interaction' }
    })
    return
  }
  if (content.includes('interaction-write-fail')) {
    rl.close()
    process.stdin.destroy()
    try { fs.closeSync(0) } catch {}
    setTimeout(() => send({
      type: 'control_request',
      request_id: 'unexpected-permission',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        input: { command: 'pwd' }
      }
    }), 20)
    setInterval(() => {}, 1_000)
    return
  }
  if (content.includes('interaction')) {
    send({
      type: 'control_request',
      request_id: 'unexpected-permission',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        input: { command: 'pwd' }
      }
    })
    return
  }
  if (content.includes('hang-read')) return
  if (content.includes('terminal-summary-')) {
    if (content.includes('result-only')) {
      result(value.uuid, 'Synthetic result is not an assistant message')
      return
    }
    const final = '  ## Result' + String.fromCharCode(10).repeat(2) + 'detail '.repeat(400)
    const empty = content.includes('-empty')
    const stream = (event) => send({ type: 'stream_event', user_message_uuid: value.uuid, event })
    const assistant = (id, text, parent_tool_use_id = null) => send({
      type: 'assistant', user_message_uuid: value.uuid, parent_tool_use_id,
      message: { id, content: text === null ? [] : [{ type: 'text', text }] }
    })
    if (content.includes('-stream')) {
      stream({ type: 'message_start', message: { id: 'commentary' } })
      stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Starting work.' } })
      stream({ type: 'message_stop' })
      stream({ type: 'message_start', message: { id: 'final' } })
      if (!empty) {
        stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: final.slice(0, 20) } })
        stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Private thought' } })
        stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: final.slice(20) } })
      }
      stream({ type: 'message_stop' })
      assistant('final', empty ? null : final)
    } else {
      assistant('commentary', 'Starting work.')
      assistant('final', empty ? null : final.slice(0, 20))
      if (!empty) assistant('final', final.slice(20))
    }
    assistant('child', 'Subagent text is not the root answer', 'child-tool')
    result(value.uuid, 'Synthetic result must not override the assistant message')
    return
  }
  if (content.includes('native-identity-')) {
    const stream = (event) => send({ type: 'stream_event', user_message_uuid: value.uuid, event })
    if (content.includes('native-identity-stream')) {
      stream({ type: 'message_start', message: { id: 'native-answer-1' } })
      stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Same' } })
      stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Reasoning' } })
      stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' answer' } })
      stream({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'identity-tool', name: 'Read', input: {} } })
      stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: '.' } })
      stream({ type: 'message_stop' })
      stream({ type: 'message_start', message: { id: 'native-answer-2' } })
      stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Same answer.' } })
      stream({ type: 'message_stop' })
    } else {
      for (const id of ['native-answer-1', 'native-answer-2']) {
        send({ type: 'assistant', user_message_uuid: value.uuid, message: { id, content: [{ type: 'text', text: 'Same answer.' }] } })
      }
    }
    result(value.uuid)
    return
  }
  if (content.includes('followup-one')) {
    send({
      type: 'stream_event',
      user_message_uuid: value.uuid,
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'one' }
      }
    })
    setTimeout(() => result(value.uuid), 20)
    return
  }
  if (content.includes('followup-two')) {
    setTimeout(() => send({
      type: 'assistant',
      user_message_uuid: value.uuid,
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'two' }] }
    }), 30)
    setTimeout(() => result(value.uuid), 40)
    return
  }
  if (content.includes('nul-text-delta')) {
    const stream = (event) => send({ type: 'stream_event', user_message_uuid: value.uuid, event })
    stream({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'nul-tool', name: 'Read', input: { file: 'a.txt' } }
    })
    stream({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: String.fromCharCode(0) + String.fromCharCode(0) }
    })
    setTimeout(() => result(value.uuid), 20)
    return
  }
  if (content.includes('second-execution')) {
    if (lastResultUuid) {
      send({
        type: 'result',
        session_id: sessionId,
        user_message_uuid: lastResultUuid,
        subtype: 'success',
        is_error: false,
        result: 'LATE_A',
        origin: { kind: 'human' }
      })
    }
    send({
      type: 'stream_event',
      user_message_uuid: value.uuid,
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'B' }
      }
    })
    result(value.uuid)
    return
  }
  if (content.includes('provider-task-wake')) {
    const nativeExecutionId = 'native-provider-task-private'
    result(value.uuid)
    setTimeout(() => {
      log({ type: 'provider-wake-emitted', nativeExecutionId })
      send({
        type: 'user',
        uuid: nativeExecutionId,
        parent_tool_use_id: null,
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: 'Provider task completed' }
      })
      send({
        type: 'stream_event',
        user_message_uuid: nativeExecutionId,
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'provider background answer' }
        }
      })
      if (!content.includes('provider-task-wake-hang')) result(nativeExecutionId)
    }, 50)
    return
  }
  if (content.includes('usage-ledger')) {
    usageLedgerCount += 1
    const usageOrdinal = usageLedgerCount
    const messageId = 'message-usage-ledger-' + usageOrdinal
    const streamFrames = [
      {
        type: 'message_start',
        message: {
          id: messageId,
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: usageOrdinal === 1 ? 10 : 20,
            output_tokens: 1,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2
          }
        }
      },
      {
        type: 'message_delta',
        usage: {
          output_tokens: 2,
          output_tokens_details: { thinking_tokens: 1 }
        }
      },
      {
        type: 'message_delta',
        usage: {
          output_tokens: 4,
          output_tokens_details: { thinking_tokens: 2 }
        }
      },
      { type: 'message_stop' }
    ]
    const emitUsageFrames = () => {
      for (const event of streamFrames) {
        send({ type: 'stream_event', user_message_uuid: value.uuid, event })
      }
      // A transcript replay of the same native message must not be billed again.
      for (const event of streamFrames) {
        send({ type: 'stream_event', user_message_uuid: value.uuid, event })
      }
      for (let replay = 0; replay < 3; replay += 1) {
        send({
          type: 'assistant',
          user_message_uuid: value.uuid,
          message: {
            id: messageId,
            model: 'claude-sonnet-4-6',
            content: [],
            usage: {
              input_tokens: usageOrdinal === 1 ? 10 : 20,
              output_tokens: 4,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 2
            }
          }
        })
      }
    }
    if (usageOrdinal === 1) emitUsageFrames()
    else setTimeout(emitUsageFrames, 30)
    const cumulativeCost = usageOrdinal === 1 ? 0.0125 : 0.02
    setTimeout(() => result(value.uuid, '', {
      modelUsage: {
        'claude-sonnet-4-6': {
          canonicalModel: 'claude-sonnet-4-6',
          inputTokens: 10 * usageOrdinal,
          outputTokens: 4 * usageOrdinal,
          cacheReadInputTokens: 3 * usageOrdinal,
          cacheCreationInputTokens: 2 * usageOrdinal,
          costUSD: cumulativeCost,
          contextWindow: 200000
        }
      },
      // Current ledger intentionally ignores result.usage/total_cost_usd.
      usage: { input_tokens: 9999, output_tokens: 9999 },
      total_cost_usd: 99
    }), usageOrdinal === 1 ? 20 : 50)
    return
  }
  send({
    type: 'stream_event',
    user_message_uuid: value.uuid,
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'hello' }
    }
  })
  result(value.uuid)
  setTimeout(() => send({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'native-task',
    status: 'completed',
    summary: 'native task finished'
  }), 20)
})
`
