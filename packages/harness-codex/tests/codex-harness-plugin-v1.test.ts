import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { getEventListeners } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCodexMainPlugin } from '../src/main/index.js'
import {
  codexPublicInteractionId,
  codexPublicOptionId,
  codexPublicQuestionId
} from '../src/shared/public-interactions.js'
import { CodexRuntime } from '../src/main/runtime/index.js'
import { createCodexSettingsApi } from '../src/main/settings.js'
import {
  createEmptyCodexState,
  decodeCodexState,
  stageCodexExecution
} from '../src/shared/state.js'
import type { CodexThreadSettings } from '../src/shared/types.js'
import { isJsonValue, parseThreadPublicObservation, type JsonValue } from '@openagent/contracts'
import type { BartTelemetryLedgerSample } from '@openagent/contracts'
import { createOpaqueTelemetrySampleId } from '@openagent/plugin-kit/bart/main'
import type { AgentThreadRecord } from '@openagent/contracts'
import {
  createAgentOpenContext,
  type TestAgentChange
} from '@openagent/test-kit'

const codexSettingsApi = createCodexSettingsApi()

const fixture = resolve(import.meta.dirname, '../../../apps/desktop/tests/fixtures/fake-codex-app-server.mjs')
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('Codex Harness Plugin v1', () => {
  it('marks Core orchestration inputs as internal plugin messages', () => {
    const state = stageCodexExecution(
      createEmptyCodexState(1),
      'internal-execution',
      {
        parts: [{ kind: 'text', text: '{"event":"thread-terminal"}' }],
        presentation: 'internal'
      },
      2,
      'internal-message'
    )

    expect(state.turns[0]?.messages[0]).toMatchObject({
      content: '{"event":"thread-terminal"}',
      internal: true
    })
    expect(decodeCodexState(state).turns[0]?.messages[0]?.internal).toBe(true)
  })

  it('gives concurrent owners distinct app-server instances', async () => {
    const directory = await temporaryDirectory('codex-harness-owner-')
    const runtime = new CodexRuntime({
      resolveExecutable: async () => fixture,
      environment: async () => ({ ...process.env }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    const [first, second] = await Promise.all([
      runtime.server(directory),
      runtime.server(directory)
    ])
    expect(first.server).not.toBe(second.server)
    await Promise.all([first.server.dispose(), second.server.dispose()])
  })

  it('records each raw native response once with its actual rerouted model', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-harness-native-usage-')
    const logPath = join(directory, 'app-server.jsonl')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_RAW_USAGE: '1'
      }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'thread-native-usage',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex native usage',
      tags: [],
      cwd: directory,
      settings: {},
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const samples: BartTelemetryLedgerSample[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      telemetryLedger: {
        record: async sample => { samples.push(sample) },
        read: () => ({ windows: [] })
      }
    }))

    await handle.send({
      executionId: 'execution-native-usage',
      input: { parts: [{ kind: 'text', text: 'Measure this response.' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => record.observation.latestExecution?.status === 'completed')

    expect(samples).toHaveLength(2)
    expect(samples[0]).toMatchObject({
      type: 'execution-usage',
      executionId: 'execution-native-usage',
      model: 'gpt-5.4-rerouted',
      usageKind: 'generation',
      inputTokens: 100,
      uncachedInputTokens: 50,
      cachedReadTokens: 40,
      cacheWriteTokens: 10,
      outputTokens: 20,
      reasoningTokens: 6
    })
    expect(samples[0]?.type === 'execution-usage' ? samples[0].sampleId : '')
      .toBe(createOpaqueTelemetrySampleId([
        'codex',
        'thread-native-usage',
        'thread-1',
        'response-raw-usage-1'
      ]))
    expect(samples[1]).toMatchObject({
      type: 'execution-usage',
      executionId: 'execution-native-usage',
      model: 'gpt-5.4-rerouted',
      usageKind: 'generation',
      inputTokens: 50,
      uncachedInputTokens: 45,
      cachedReadTokens: 5,
      cacheWriteTokens: 0,
      outputTokens: 7,
      reasoningTokens: 1
    })
    expect(samples[0]?.type === 'execution-usage' &&
      samples[1]?.type === 'execution-usage' &&
      samples[0].sampleId !== samples[1].sampleId).toBe(true)
    expect(samples[1]?.type === 'execution-usage' ? samples[1].sampleId : '')
      .toBe(createOpaqueTelemetrySampleId([
        'codex',
        'thread-native-usage',
        'thread-1',
        'response-raw-usage-2'
      ]))
    expect(JSON.stringify(samples)).not.toContain('response-raw-usage-1')
    expect(JSON.stringify(samples)).not.toContain('thread-1')
    const threadStart = (await readLog(logPath)).find(
      (message) => message.method === 'thread/start'
    )
    expect(threadStart?.params).toMatchObject({ experimentalRawEvents: true })
    await handle.dispose()
  })

  it('escalates app-server disposal and waits for the detached process group', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-harness-kill-')
    const pidFile = join(directory, 'app-server.pid')
    const childPidFile = join(directory, 'app-server-child.pid')
    const childReadyFile = join(directory, 'app-server-child.ready')
    const runtime = new CodexRuntime({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_CHILD_IGNORE_SIGTERM: '1',
        FAKE_CODEX_PID_FILE: pidFile,
        FAKE_CODEX_CHILD_PID_FILE: childPidFile,
        FAKE_CODEX_CHILD_READY_FILE: childReadyFile
      }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    const acquired = await runtime.server(directory)
    await acquired.server.listModels()
    await waitFor(async () => readFile(childReadyFile).then(() => true, () => false))
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    const childPid = Number((await readFile(childPidFile, 'utf8')).trim())
    expect(Number.isInteger(pid) && pid > 0).toBe(true)
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true)
    try {
      const firstDispose = acquired.server.dispose()
      const secondDispose = acquired.server.dispose()
      expect(secondDispose).toBe(firstDispose)
      await Promise.all([firstDispose, secondDispose])
      expect(processIsAlive(pid)).toBe(false)
      expect(processIsAlive(childPid)).toBe(false)
    } finally {
      if (processIsAlive(pid)) {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
      if (processIsAlive(childPid)) {
        try { process.kill(childPid, 'SIGKILL') } catch {}
      }
    }
  })

  it('uses JSON null to clear Thread overrides without reapplying changed App defaults', async () => {
    const update = {
      model: null,
      effort: null,
      serviceTier: null,
      personality: null,
      approvalPolicy: null,
      sandbox: null,
      summary: null
    } as const
    expect(isJsonValue(update)).toBe(true)

    await expect(codexSettingsApi.applyThreadSettingsUpdate({
      current: {
        executablePath: '/opt/codex',
        model: 'thread-model',
        effort: 'high',
        serviceTier: 'priority',
        personality: 'friendly',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        summary: 'detailed'
      },
      defaults: {
        executablePath: '/opt/codex',
        model: 'app-model',
        serviceTier: 'default',
        personality: 'pragmatic',
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
        summary: 'concise'
      },
      update,
      hasContent: true,
      cwd: '/workspace',
      signal: new AbortController().signal
    })).resolves.toEqual({ executablePath: '/opt/codex' })

    expect(() => codexSettingsApi.normalizeHarnessSettings({
    } as never)).toThrow('缺少 threadSettings')
    expect(() => codexSettingsApi.normalizeHarnessSettings({
      threadSettings: null
    } as never)).toThrow('必须是对象')
  })

  it('updates sandbox and sandboxPolicy as one mutually-exclusive setting group', async () => {
    const customPolicy = {
      type: 'workspaceWrite' as const,
      writableRoots: ['/tmp/shared'],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true
    }
    const common = {
      hasContent: true,
      cwd: '/workspace',
      signal: new AbortController().signal
    }

    await expect(codexSettingsApi.applyThreadSettingsUpdate({
      ...common,
      current: { sandboxPolicy: customPolicy },
      defaults: { sandboxPolicy: customPolicy },
      update: { sandbox: 'read-only', sandboxPolicy: null }
    })).resolves.toEqual({ sandbox: 'read-only' })

    await expect(codexSettingsApi.applyThreadSettingsUpdate({
      ...common,
      current: { sandboxPolicy: customPolicy },
      defaults: { sandboxPolicy: customPolicy },
      update: { sandbox: 'workspace-write' }
    })).resolves.toEqual({ sandbox: 'workspace-write' })

    await expect(codexSettingsApi.applyThreadSettingsUpdate({
      ...common,
      current: { sandbox: 'read-only' },
      defaults: { sandbox: 'danger-full-access' },
      update: { sandbox: null, sandboxPolicy: customPolicy }
    })).resolves.toEqual({ sandboxPolicy: customPolicy })

    await expect(codexSettingsApi.applyThreadSettingsUpdate({
      ...common,
      current: { sandbox: 'read-only' },
      defaults: { sandbox: 'danger-full-access' },
      update: { sandboxPolicy: customPolicy }
    })).resolves.toEqual({ sandboxPolicy: customPolicy })

    await expect(codexSettingsApi.applyThreadSettingsUpdate({
      ...common,
      current: { sandbox: 'read-only' },
      defaults: { sandboxPolicy: customPolicy },
      update: { sandbox: null, sandboxPolicy: null }
    })).resolves.toEqual({})

    await expect(codexSettingsApi.applyThreadSettingsUpdate({
      ...common,
      current: { sandboxPolicy: customPolicy },
      defaults: { sandbox: 'danger-full-access' },
      update: { sandbox: null }
    })).resolves.toEqual({ sandboxPolicy: customPolicy })

    await expect(codexSettingsApi.applyThreadSettingsUpdate({
      ...common,
      current: { sandbox: 'read-only' },
      defaults: { sandboxPolicy: customPolicy },
      update: { sandboxPolicy: null }
    })).resolves.toEqual({ sandbox: 'read-only' })

    await expect(codexSettingsApi.applyThreadSettingsUpdate({
      ...common,
      current: { sandboxPolicy: customPolicy },
      defaults: { sandbox: 'danger-full-access' },
      update: { sandboxPolicy: null }
    })).resolves.toEqual({})

    await expect(codexSettingsApi.applyThreadSettingsUpdate({
      ...common,
      current: { sandbox: 'read-only' },
      defaults: { sandboxPolicy: customPolicy },
      update: { sandbox: null }
    })).resolves.toEqual({})

    await expect(codexSettingsApi.applyThreadSettingsUpdate({
      ...common,
      current: { sandbox: 'read-only' },
      defaults: {},
      update: { sandbox: 'workspace-write', sandboxPolicy: customPolicy }
    })).rejects.toThrow('不能同时设置')
  })

  it('keeps sparse Thread settings sparse and preserves only current values', async () => {
    await expect(codexSettingsApi.applyThreadSettingsUpdate({
      current: {
        executablePath: '/opt/codex',
        model: 'thread-model',
        sandbox: 'read-only'
      },
      defaults: {
        model: 'new-app-model',
        effort: 'high',
        serviceTier: 'priority',
        personality: 'friendly',
        approvalPolicy: 'never',
        summary: 'detailed'
      },
      update: { model: 'updated-thread-model' },
      hasContent: true,
      cwd: '/workspace',
      signal: new AbortController().signal
    })).resolves.toEqual({
      executablePath: '/opt/codex',
      model: 'updated-thread-model',
      sandbox: 'read-only'
    })
  })

  it('binds one Primary Session and commits started through atomic terminal', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-harness-base-')
    const worktreeDirectory = await temporaryDirectory('codex-harness-worktree-')
    const logPath = join(directory, 'app-server.jsonl')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({ ...process.env, FAKE_CODEX_LOG: logPath }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'thread-product-1',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex test',
      tags: [],
      cwd: directory,
      worktree: {
        baseCwd: directory,
        native: true,
        cwd: worktreeDirectory
      },
      settings: {},
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const commits: TestAgentChange[] = []
    const handleAbort = new AbortController()
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits,
      signal: handleAbort.signal
    }))

    const executionSignal = new AbortController()
    const first = handle.send({
      executionId: 'execution-1',
      input: { parts: [{ kind: 'text', text: 'Check the project.' }] },
      signal: executionSignal.signal
    })
    const followUp = handle.send({
      executionId: 'execution-1',
      input: { parts: [{ kind: 'text', text: 'Also report the test result.' }] },
      signal: executionSignal.signal
    })
    await Promise.all([first, followUp])

    // Private state and its public observation are published separately.
    // Wait for both before responding; pending sessionState alone is not admission.
    await waitFor(() => {
      const state = decodeCodexState(record.sessionState)
      return record.observation.latestExecution?.status === 'waiting-for-user' &&
        Boolean(state.turns[0]?.interactions.some((item) => item.status === 'pending'))
    })
    const waitingExecution = record.observation.latestExecution
    if (waitingExecution?.status !== 'waiting-for-user') {
      throw new Error('Expected public waiting interaction')
    }
    const interaction = waitingExecution.interactions[0]!
    await handle.respond({
      interactionId: interaction.id,
      actionId: 'allow-once'
    })
    await waitFor(() => commits.some((change) => change.lifecycle?.type === 'terminal'))

    const lifecycle = commits.flatMap((change) => change.lifecycle ? [change.lifecycle] : [])
    expect(lifecycle).toEqual([
      { type: 'started', executionId: 'execution-1' },
      { type: 'terminal', executionId: 'execution-1', outcome: 'completed' }
    ])
    const terminalCommit = commits.find((change) => change.lifecycle?.type === 'terminal')!
    expect(terminalCommit.state).toBeDefined()
    const finalState = decodeCodexState(terminalCommit.state)
    expect(finalState.primarySessionId).toBe('thread-1')
    expect(finalState.turns[0]).toMatchObject({
      status: 'completed',
      answer: 'All good.'
    })
    expect(finalState.turns[0]!.messages.map((message) => message.kind)).toEqual([
      'prompt',
      'follow-up'
    ])

    const beforeRead = structuredClone(record)
    await expect(handle.read('Summarize this thread.', new AbortController().signal))
      .resolves.toBe('Fork read complete.')
    expect(record).toEqual(beforeRead)
    const requests = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method?: string; params?: { cwd?: string } })
      .filter((message) => ['thread/start', 'thread/fork', 'turn/start'].includes(
        message.method || ''
      ))
    expect(requests).not.toHaveLength(0)
    expect(requests.every((message) => message.params?.cwd === worktreeDirectory)).toBe(true)

    await handle.dispose()
  })

  it.each(['short labels', 'long labels with the same public prefix'] as const)(
    'bridges non-blocking user input through Core and sends original Codex option labels: %s',
    async (scenario) => {
      await chmod(fixture, 0o755)
      const directory = await temporaryDirectory('codex-harness-nonblocking-input-')
      const logPath = join(directory, 'app-server.jsonl')
      const nativeInteractionId = `native/interaction?${'\u754c'.repeat(300)}#end`
      const nativeQuestionId = `native/question?${'\u754c'.repeat(300)}#end`
      const commonLabelPrefix = '界'.repeat(2_000)
      const nativeOptions = scenario === 'short labels'
        ? [{ label: 'Workspace', description: 'Current workspace' }]
        : [
            { label: `${commonLabelPrefix} first option  `, description: 'First '.repeat(2_001) },
            { label: `${commonLabelPrefix} second option\t `, description: 'Second '.repeat(2_001) }
          ]
      const selectedOptionIndex = nativeOptions.length - 1
      const plugin = createCodexMainPlugin({
        resolveExecutable: async () => fixture,
        environment: async () => ({
          ...process.env,
          FAKE_CODEX_LOG: logPath,
          FAKE_CODEX_NONBLOCKING_INPUT: '1',
          FAKE_CODEX_NATIVE_INTERACTION_ID: nativeInteractionId,
          FAKE_CODEX_NATIVE_QUESTION_ID: nativeQuestionId,
          FAKE_CODEX_NONBLOCKING_INPUT_OPTIONS: JSON.stringify(nativeOptions)
        }),
        dataRoot: directory,
        temporaryWorkspaceRoot: directory
      })
      let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
        id: 'thread-nonblocking-input',
        harnessId: 'codex',
        archived: false,
        revision: 0,
        title: 'Codex non-blocking input',
        tags: [],
        cwd: directory,
        settings: {},
        sessionState: null,
        observation: { latestExecution: null, backgroundWork: null },
        createdAt: 1,
        updatedAt: 1
      }
      const commits: TestAgentChange[] = []
      const observationErrors: string[] = []
      const context = createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: next => { record = next },
        changes: commits
      })
      const handle = await plugin.openThread({
        ...context,
        sessionState: {
          read: context.sessionState.read,
          commit: async state => {
            try {
              parseThreadPublicObservation(plugin.sessionState.project(state))
              await context.sessionState.commit(state)
            } catch (error) {
              observationErrors.push(error instanceof Error ? error.message : String(error))
              throw error
            }
          }
        }
      })

      try {
        await handle.send({
          executionId: 'execution-nonblocking-input',
          input: { parts: [{ kind: 'text', text: 'Ask a non-blocking question.' }] },
          signal: new AbortController().signal
        })
        await waitFor(() => record.observation.latestExecution?.status === 'waiting-for-user' ||
          observationErrors.length > 0)
        expect(observationErrors).toEqual([])
        const execution = record.observation.latestExecution
        expect(execution?.status).toBe('waiting-for-user')
        if (execution?.status !== 'waiting-for-user') throw new Error('Expected waiting execution')
        const interaction = execution.interactions[0]
        if (!interaction) throw new Error('Expected pending interaction')
        expect(execution.interactions).toHaveLength(1)
        expect(interaction.id).toBe(codexPublicInteractionId(nativeInteractionId))
        expect(interaction.questions).toMatchObject([{
          id: codexPublicQuestionId(nativeInteractionId, nativeQuestionId),
          header: 'Scope',
          prompt: 'Which scope?',
          multiple: false,
          allowOther: false,
          secret: false
        }])

        const question = interaction.questions[0]!
        expect(question.options).toHaveLength(nativeOptions.length)
        expect(new Set(question.options.map(option => option.value)).size).toBe(nativeOptions.length)
        for (const [index, option] of question.options.entries()) {
          expect(option.value).toBe(codexPublicOptionId(
            nativeInteractionId,
            nativeQuestionId,
            `${nativeQuestionId}:option:${index}`
          ))
          expect(option.label.length).toBeLessThanOrEqual(2_000)
          expect(option.description?.length).toBeLessThanOrEqual(10_000)
        }
        if (scenario === 'short labels') {
          expect(question.options[0]).toMatchObject(nativeOptions[0]!)
        } else {
          expect(question.options.map(option => option.label)).toEqual([
            commonLabelPrefix,
            commonLabelPrefix
          ])
        }
        const option = question.options[selectedOptionIndex]!
        expect(interaction.id).toMatch(/^codex-interaction-sha256-[a-f0-9]{64}$/)
        expect(interaction.id.length).toBeLessThanOrEqual(128)
        expect(question.id.length).toBeLessThanOrEqual(128)
        expect(JSON.stringify(interaction)).not.toContain(nativeInteractionId)
        expect(JSON.stringify(interaction)).not.toContain(nativeQuestionId)
        const restoredState = decodeCodexState(structuredClone(record.sessionState))
        const privatePending = restoredState.turns[0]!.interactions.find(
          (candidate) => candidate.status === 'pending'
        )!
        expect(privatePending.id).toBe(nativeInteractionId)
        expect(privatePending.questions[0]?.id).toBe(nativeQuestionId)
        expect(privatePending.questions[0]?.options).toEqual(nativeOptions.map((option, index) => ({
          id: `${nativeQuestionId}:option:${index}`,
          ...option
        })))
        expect(codexPublicInteractionId(privatePending.id)).toBe(interaction.id)
        expect(codexPublicQuestionId(
          privatePending.id,
          privatePending.questions[0]!.id
        )).toBe(question.id)
        await handle.respond({
          interactionId: interaction.id,
          actionId: 'submit',
          answers: { [question.id]: option.value }
        })
        await waitFor(() => commits.some((change) => change.lifecycle?.type === 'terminal'))
        const response = (await readLog(logPath)).find((message) =>
          message.id === 'wire-nonblocking-input' && message.result
        )
        expect(response?.result).toEqual({
          answers: { [nativeQuestionId]: { answers: [nativeOptions[selectedOptionIndex]!.label] } }
        })
        expect(observationErrors).toEqual([])
      } finally {
        await handle.dispose()
      }
    }
  )

  it.each(['form', 'openai/form'] as const)(
    'supports Codex MCP %s elicitation with structured JSON content',
    async (mode) => {
      const { execution, handle, logPath, commits, nativeState } = await startElicitation(mode)
      expect(nativeState.turns[0]?.interactions[0]).toMatchObject({
        kind: 'mcp-elicitation',
        elicitation: {
          mode: 'form', questionId: 'values',
          requestedSchema: { type: 'object', properties: { replicas: { type: 'integer' } } }
        }
      })
      const interaction = execution.interactions[0]
      if (!interaction) throw new Error('Expected pending interaction')
      expect(execution.interactions).toHaveLength(1)
      expect(interaction).toMatchObject({
        kind: 'question',
        title: 'Provide deployment details',
        description: expect.stringContaining('"environment"'),
        actions: [
          { id: 'submit', intent: 'submit' },
          { id: 'deny', intent: 'deny' },
          { id: 'cancel', intent: 'cancel' }
        ],
        questions: [{
          id: expect.stringMatching(/^codex-question-sha256-[a-f0-9]{64}$/),
          prompt: expect.stringContaining('"replicas"'),
          multiple: false,
          allowOther: true,
          secret: false,
          options: []
        }]
      })

      const question = interaction.questions[0]!
      await handle.respond({
        interactionId: interaction.id,
        actionId: 'submit',
        answers: { [question.id]: '{"environment":"staging","replicas":2}' }
      })
      await waitFor(() => commits.some((change) => change.lifecycle?.type === 'terminal'))
      const log = await readLog(logPath)
      expect(log.find((message) => message.method === 'initialize')).toMatchObject({
        params: {
          capabilities: {
            extensions: { 'openai/form': {} }
          }
        }
      })
      const response = log.find((message) =>
        message.id === 'wire-elicitation-1' && message.result
      )
      expect(response?.result).toEqual({
        action: 'accept',
        content: { environment: 'staging', replicas: 2 },
        _meta: { formContext: 'deployment-request-1' }
      })
      await handle.dispose()
    }
  )

  it.each([
    ['deny', 'decline'],
    ['cancel', 'cancel']
  ] as const)('encodes Codex MCP form %s as native %s', async (actionId, action) => {
    const { commits, execution, handle, logPath } = await startElicitation('form')
    const interaction = execution.interactions[0]
    if (!interaction) throw new Error('Expected pending interaction')
    expect(execution.interactions).toHaveLength(1)
    expect(interaction.actions.map(({ id }) => id)).toEqual([
      'submit',
      'deny',
      'cancel'
    ])

    await handle.respond({ interactionId: interaction.id, actionId })
    await waitFor(() => commits.some((change) => change.lifecycle?.type === 'terminal'))
    expect((await readLog(logPath)).find((message) =>
      message.id === 'wire-elicitation-1' && message.result
    )?.result).toEqual({ action, content: null, _meta: null })
    await handle.dispose()
  })

  it.each([
    ['submit', 'accept', {}],
    ['deny', 'decline', null],
    ['cancel', 'cancel', null]
  ] as const)(
    'keeps Codex MCP URL elicitation pending until %s and encodes native %s',
    async (actionId, action, content) => {
      const { commits, execution, handle, logPath, nativeState } = await startElicitation('url')
      expect(nativeState.turns[0]?.interactions[0]).toMatchObject({
        kind: 'mcp-elicitation',
        elicitation: { mode: 'url', url: 'https://example.test/form' }
      })
      const interaction = execution.interactions[0]
      if (!interaction) throw new Error('Expected pending interaction')
      expect(execution.interactions).toHaveLength(1)
      expect(interaction).toMatchObject({
        kind: 'permission',
        title: 'Open the external form',
        description: 'https://example.test/form',
        actions: [
          { id: 'submit', intent: 'submit' },
          { id: 'deny', intent: 'deny' },
          { id: 'cancel', intent: 'cancel' }
        ],
        questions: []
      })

      await handle.respond({ interactionId: interaction.id, actionId })
      await waitFor(() => commits.some((change) => change.lifecycle?.type === 'terminal'))
      expect((await readLog(logPath)).find((message) =>
        message.id === 'wire-elicitation-1' && message.result
      )?.result).toEqual({ action, content, _meta: null })
      await handle.dispose()
    }
  )

  it('settles every persisted running turn before accepting a post-restart send', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-harness-restart-')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({ ...process.env, FAKE_CODEX_SPLIT_MESSAGES: '1' }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    const first = stageCodexExecution(
      { ...createEmptyCodexState(1), primarySessionId: 'thread-1' },
      'orphan-1',
      { parts: [{ kind: 'text', text: 'Old work.' }] },
      2,
      'orphan-message-1'
    )
    const orphanedState = {
      ...first,
      turns: [
        first.turns[0]!,
        {
          ...first.turns[0]!,
          executionId: 'orphan-2',
          messages: [{
            ...first.turns[0]!.messages[0]!,
            id: 'orphan-message-2'
          }]
        }
      ]
    }
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'thread-restart',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Restarted Codex thread',
      tags: [],
      cwd: directory,
      settings: {},
      sessionState: checkedJson(orphanedState),
      observation: {
        latestExecution: {
          executionId: 'orphan-1',
          startedAt: 100,
          status: 'running'
        },
        backgroundWork: null
      },
      createdAt: 1,
      updatedAt: 2
    }
    const commits: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits
    }))

    const reconciled = decodeCodexState(record.sessionState)
    expect(reconciled.primarySessionId).toBe('thread-1')
    expect(reconciled.turns.map((turn) => turn.status)).toEqual([
      'interrupted',
      'interrupted'
    ])
    expect(commits[0]?.lifecycle).toBeUndefined()
    expect(record.observation.latestExecution).toMatchObject({
      executionId: 'orphan-2',
      startedAt: 2,
      finishedAt: reconciled.turns[1]!.finishedAt,
      status: 'interrupted'
    })
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({
      state: reconciled,
      observation: record.observation
    })

    await handle.send({
      executionId: 'execution-after-restart',
      input: { parts: [{ kind: 'text', text: 'Continue after restart.' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => commits.some((change) =>
      change.lifecycle?.type === 'terminal' &&
      change.lifecycle.executionId === 'execution-after-restart'
    ))
    expect(decodeCodexState(record.sessionState).turns.at(-1)?.status).toBe('completed')
    await handle.dispose()
  })

  it('keeps Thread active and retries a rejected terminal commit on interrupt', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-harness-thread-terminal-retry-')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({ ...process.env, FAKE_CODEX_SPLIT_MESSAGES: '1' }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'thread-terminal-retry',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex terminal retry',
      tags: [],
      cwd: directory,
      settings: {},
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    let terminalAttempts = 0
    let firstFinishedAt: number | undefined
    const accepted: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: accepted,
      onChange: change => {
        if (change.lifecycle?.type === 'terminal' && ++terminalAttempts === 1) {
          firstFinishedAt = decodeCodexState(change.state).turns.at(-1)?.finishedAt
          throw new Error('terminal commit rejected')
        }
      }
    }))

    await handle.send({
      executionId: 'thread-terminal-retry-execution',
      input: { parts: [{ kind: 'text', text: 'Complete once.' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => terminalAttempts === 1)
    expect(accepted.some((change) => change.lifecycle?.type === 'terminal')).toBe(false)
    expect(decodeCodexState(record.sessionState).turns.at(-1)).toMatchObject({
      status: 'running'
    })
    expect(decodeCodexState(record.sessionState).turns.at(-1)?.finishedAt).toBeUndefined()
    expect(record.observation.latestExecution?.status).toBe('running')

    await handle.interrupt()
    expect(terminalAttempts).toBe(2)
    expect(accepted.flatMap((change) =>
      change.lifecycle?.type === 'terminal' ? [change.lifecycle] : []
    )).toEqual([{
      type: 'terminal',
      executionId: 'thread-terminal-retry-execution',
      outcome: 'completed'
    }])
    expect(decodeCodexState(record.sessionState).turns.at(-1)?.status).toBe('completed')
    expect(decodeCodexState(record.sessionState).turns.at(-1)?.finishedAt).toBe(firstFinishedAt)
    await handle.dispose()
  })

  it('interrupts Thread admission during app-server initialization without starting a turn', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-harness-admission-abort-')
    const logPath = join(directory, 'app-server.jsonl')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_INITIALIZE_DELAY_MS: '500',
        FAKE_CODEX_LOG: logPath
      }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'thread-admission-abort',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex admission abort',
      tags: [],
      cwd: directory,
      settings: {},
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const commits: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits
    }))
    const sending = handle.send({
      executionId: 'execution-admission-abort',
      input: { parts: [{ kind: 'text', text: 'Do not reach native admission.' }] },
      signal: new AbortController().signal
    })
    await waitForLogMethod(logPath, 'initialize')
    const interrupting = handle.interrupt()

    await expect(sending).resolves.toBeUndefined()
    await interrupting
    expect(commits.flatMap((change) =>
      change.lifecycle?.type === 'terminal' ? [change.lifecycle] : []
    )).toEqual([{
      type: 'terminal',
      executionId: 'execution-admission-abort',
      outcome: 'interrupted'
    }])
    const methods = (await readLog(logPath)).flatMap((message) =>
      typeof message.method === 'string' ? [message.method] : []
    )
    expect(methods).not.toContain('thread/start')
    expect(methods).not.toContain('turn/start')
    await handle.dispose()
  })

  it('sends one native turn/interrupt for one admitted Thread Stop', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-harness-single-interrupt-')
    const logPath = join(directory, 'app-server.jsonl')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_STATUS_STUCK: '1',
        FAKE_CODEX_INTERRUPT_COMPLETES: '1'
      }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'thread-single-interrupt',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex single interrupt',
      tags: [],
      cwd: directory,
      settings: {},
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))
    await handle.send({
      executionId: 'execution-single-interrupt',
      input: { parts: [{ kind: 'text', text: 'Keep running until Stop.' }] },
      signal: new AbortController().signal
    })

    await handle.interrupt()

    const interrupts = (await readLog(logPath)).filter((message) =>
      message.method === 'turn/interrupt'
    )
    expect(interrupts).toHaveLength(1)
    expect(interrupts[0]?.params).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-1'
    })
    expect(record.observation.latestExecution).toMatchObject({
      executionId: 'execution-single-interrupt',
      status: 'interrupted'
    })
    await handle.dispose()
  })

  it('limits send signal to admission and rechecks follow-up abort after state commit', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-harness-followup-abort-')
    const logPath = join(directory, 'app-server.jsonl')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({ ...process.env, FAKE_CODEX_LOG: logPath }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'thread-followup-abort',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex follow-up abort',
      tags: [],
      cwd: directory,
      settings: {},
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const commits: TestAgentChange[] = []
    const followUpOperation = new AbortController()
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits,
      onChange: change => {
        if (change.state !== undefined) {
          const state = decodeCodexState(change.state)
          if (state.turns.at(-1)?.messages.length === 2) followUpOperation.abort()
        }
      }
    }))
    const firstOperation = new AbortController()
    await handle.send({
      executionId: 'execution-followup-abort',
      input: { parts: [{ kind: 'text', text: 'Wait for approval.' }] },
      signal: firstOperation.signal
    })
    firstOperation.abort()
    await waitFor(() => decodeCodexState(record.sessionState).turns[0]?.interactions.some(
      (interaction) => interaction.status === 'pending'
    ) === true)

    await expect(handle.send({
      executionId: 'execution-followup-abort',
      input: { parts: [{ kind: 'text', text: 'Abort before steer.' }] },
      signal: followUpOperation.signal
    })).rejects.toMatchObject({ name: 'AbortError' })
    const methods = (await readLog(logPath)).flatMap((message) =>
      typeof message.method === 'string' ? [message.method] : []
    )
    expect(methods).not.toContain('turn/interrupt')
    expect(methods).not.toContain('turn/steer')

    const waitingExecution = record.observation.latestExecution
    if (waitingExecution?.status !== 'waiting-for-user') {
      throw new Error('Expected public waiting interaction')
    }
    const interaction = waitingExecution.interactions[0]!
    await handle.respond({ interactionId: interaction.id, actionId: 'allow-once' })
    await waitFor(() => commits.some((change) => change.lifecycle?.type === 'terminal'))
    await handle.dispose()
  })

  it('projects current native command and file approval unions and independently routes replies', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-harness-plural-interactions-')
    const logPath = join(directory, 'app-server.jsonl')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_BATCH: '1',
        FAKE_CODEX_LOG: logPath
      }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'thread-plural-interactions',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex plural interactions',
      tags: [],
      cwd: directory,
      settings: {},
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const commits: TestAgentChange[] = []
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next },
      changes: commits
    }))

    await handle.send({
      executionId: 'execution-plural-interactions',
      input: { parts: [{ kind: 'text', text: 'Request two approvals.' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => {
      const execution = record.observation.latestExecution
      return execution?.status === 'waiting-for-user' && execution.interactions.length === 2
    })
    const execution = record.observation.latestExecution
    if (execution?.status !== 'waiting-for-user') throw new Error('Expected waiting execution')
    const [first, second] = execution.interactions
    if (!first || !second) throw new Error('Expected two pending interactions')
    // Generated Codex 0.150.1 request types do not have availableDecisions.
    // Both response unions support these four explicit user decisions.
    expect(first.actions).toEqual([
      { id: 'allow-once', intent: 'allow', label: '允许一次' },
      { id: 'allow-session', intent: 'allow', label: '本会话允许' },
      { id: 'deny', intent: 'deny', label: '拒绝' },
      { id: 'cancel', intent: 'cancel', label: '取消' }
    ])
    expect(second.actions).toEqual(first.actions)

    await handle.respond({ interactionId: second.id, actionId: 'allow-once' })
    await waitFor(() => {
      const latest = record.observation.latestExecution
      return latest?.status === 'waiting-for-user' &&
        latest.interactions.length === 1 && latest.interactions[0]?.id === first.id
    })
    await handle.respond({ interactionId: first.id, actionId: 'cancel' })
    await waitFor(() => commits.some((change) => change.lifecycle?.type === 'terminal'))

    expect(record.observation.latestExecution).toMatchObject({ status: 'completed' })
    const responses = (await readLog(logPath)).filter((message) =>
      message.id === 'wire-batch-1' || message.id === 'wire-batch-2'
    )
    expect(responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'wire-batch-1', result: { decision: 'cancel' } }),
      expect.objectContaining({ id: 'wire-batch-2', result: { decision: 'accept' } })
    ]))
    await handle.dispose()
  })

  it('stops a pending steer retry when the follow-up operation is aborted', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-harness-steer-abort-')
    const logPath = join(directory, 'app-server.jsonl')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_STATUS_STUCK: '1',
        FAKE_CODEX_STEER_PENDING: '1',
        FAKE_CODEX_INTERRUPT_COMPLETES: '1'
      }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'thread-steer-abort',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex steer abort',
      tags: [],
      cwd: directory,
      settings: {},
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: next => { record = next }
    }))
    await handle.send({
      executionId: 'execution-steer-abort',
      input: { parts: [{ kind: 'text', text: 'Keep running.' }] },
      signal: new AbortController().signal
    })
    const operation = new AbortController()
    const following = handle.send({
      executionId: 'execution-steer-abort',
      input: { parts: [{ kind: 'text', text: 'Retry this steer once.' }] },
      signal: operation.signal
    })
    await waitForLogMethod(logPath, 'turn/steer')
    operation.abort()

    await expect(following).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await readLog(logPath)).filter((message) => message.method === 'turn/steer'))
      .toHaveLength(1)
    await handle.interrupt()
    await handle.dispose()
  })

  it('rechecks read abort after auxiliary executable resolution', async () => {
    const directory = await temporaryDirectory('codex-harness-read-abort-')
    const operation = new AbortController()
    let environmentCalls = 0
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => {
        operation.abort()
        return fixture
      },
      environment: async () => {
        environmentCalls += 1
        return { ...process.env }
      },
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    const record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'thread-read-abort',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex read abort',
      tags: [],
      cwd: directory,
      settings: {},
      sessionState: checkedJson({
        ...createEmptyCodexState(1),
        primarySessionId: 'thread-1'
      }),
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: () => undefined
    }))

    await expect(handle.read('Do not start a reader.', operation.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(environmentCalls).toBe(0)
    await handle.dispose()
  })

  it('cancels a read disposed before its initial state flush resumes', async () => {
    const directory = await temporaryDirectory('codex-harness-read-immediate-dispose-')
    let executableCalls = 0
    const lifetime = new AbortController()
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => {
        executableCalls += 1
        throw new Error('An auxiliary server must not start after disposal begins')
      },
      environment: async () => ({ ...process.env }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    const record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'thread-read-immediate-dispose',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex immediate read disposal',
      tags: [],
      cwd: directory,
      settings: {},
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const listenersBeforeOpen = getEventListeners(lifetime.signal, 'abort').length
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: () => undefined,
      signal: lifetime.signal
    }))
    const reading = expect(handle.read('Do not start a reader.', new AbortController().signal))
      .rejects.toMatchObject({ name: 'AbortError' })

    await handle.dispose()
    await reading

    expect(executableCalls).toBe(0)
    expect(getEventListeners(lifetime.signal, 'abort')).toHaveLength(listenersBeforeOpen)
  })

  it('aborts and joins an in-flight auxiliary read before Handle disposal returns', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-harness-read-dispose-')
    const logPath = join(directory, 'app-server.jsonl')
    const pidFile = join(directory, 'app-server.pid')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_PID_FILE: pidFile,
        FAKE_CODEX_STATUS_STUCK: '1'
      }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    const record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'thread-read-dispose',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex read dispose',
      tags: [],
      cwd: directory,
      settings: {},
      sessionState: checkedJson({
        ...createEmptyCodexState(1),
        primarySessionId: 'thread-1'
      }),
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: () => undefined
    }))
    const reading = handle.read('Keep this auxiliary read open.', new AbortController().signal)
    await waitForLogMethod(logPath, 'turn/start')
    const pid = Number((await readFile(pidFile, 'utf8')).trim())

    const firstDispose = handle.dispose()
    const secondDispose = handle.dispose()
    expect(secondDispose).toBe(firstDispose)
    await Promise.all([firstDispose, secondDispose])
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(processIsAlive(pid)).toBe(false)
  })
})

async function startElicitation(mode: 'form' | 'openai/form' | 'url') {
  await chmod(fixture, 0o755)
  const slug = mode.replace('/', '-')
  const directory = await temporaryDirectory(`codex-harness-elicitation-${slug}-`)
  const logPath = join(directory, 'app-server.jsonl')
  const plugin = createCodexMainPlugin({
    resolveExecutable: async () => fixture,
    environment: async () => ({
      ...process.env,
      FAKE_CODEX_LOG: logPath,
      FAKE_CODEX_ELICITATION_MODE: mode
    }),
    dataRoot: directory,
    temporaryWorkspaceRoot: directory
  })
  let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
    id: `thread-elicitation-${slug}`,
    harnessId: 'codex',
    archived: false,
    revision: 0,
    title: 'Codex MCP elicitation',
    tags: [],
    cwd: directory,
    settings: {},
    sessionState: null,
    observation: { latestExecution: null, backgroundWork: null },
    createdAt: 1,
    updatedAt: 1
  }
  const commits: TestAgentChange[] = []
  const handle = await plugin.openThread(createAgentOpenContext({
    sessionState: plugin.sessionState,
    getRecord: () => record,
    setRecord: next => { record = next },
    changes: commits
  }))

  await handle.send({
    executionId: `execution-elicitation-${slug}`,
    input: { parts: [{ kind: 'text', text: 'Request MCP elicitation.' }] },
    signal: new AbortController().signal
  })
  await waitFor(() => record.observation.latestExecution?.status === 'waiting-for-user')
  const execution = record.observation.latestExecution
  if (execution?.status !== 'waiting-for-user') throw new Error('Expected waiting execution')
  return { commits, execution, handle, logPath, nativeState: decodeCodexState(record.sessionState) }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const startedAt = Date.now()
  while (!(await check())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for Codex test')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function checkedJson(value: unknown): JsonValue {
  const clone: unknown = structuredClone(value)
  if (!isJsonValue(clone)) throw new Error('Codex test fixture is not JSON')
  return clone
}

async function readLog(path: string): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text.trim()
    ? text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
}

async function waitForLogMethod(path: string, method: string): Promise<void> {
  const startedAt = Date.now()
  while (!(await readLog(path)).some((message) => message.method === method)) {
    if (Date.now() - startedAt > 5_000) {
      throw new Error(`Timed out waiting for Codex log method ${method}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
