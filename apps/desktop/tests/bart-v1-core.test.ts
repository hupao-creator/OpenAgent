import { describe, expect, it, vi } from 'vitest'
import type { JsonObject, JsonValue } from '@openagent/contracts'
import type {
  BartTranscriptItem,
  HarnessToolBinding
} from '@openagent/contracts'
import { HARNESS_IDS, harnessDisplayName, type HarnessId } from '../src/shared/harnesses'
import {
  BART_CONTEXT_ENTRY_RULES,
  collectBartContextEntries,
  createRecordedHarnessToolBinding,
  describeThreadCreation,
  parseThreadCreationRequest,
  reduceBartTranscript,
  ThreadSettingsRefreshUnavailableError,
  type BartContextEntryComposition,
  type ThreadSettingsDescriptionComposition,
  type BartTranscriptMutation
} from '../src/main/bart-v1'

function reduceBartTranscriptMany(
  transcript: readonly BartTranscriptItem[],
  mutations: readonly BartTranscriptMutation[]
): readonly BartTranscriptItem[] {
  return mutations.reduce(reduceBartTranscript, transcript)
}

describe('Bart v1 transcript', () => {
  it('reduces ordered messages, tool calls and tool results', () => {
    const original: readonly BartTranscriptItem[] = [{
      type: 'message',
      id: 'user-1',
      role: 'user',
      content: 'Inspect this',
      createdAt: 1,
      status: 'complete'
    }]
    const mutations: readonly BartTranscriptMutation[] = [
      {
        type: 'append-reasoning',
        messageId: 'assistant-1',
        executionId: 'execution-1',
        createdAt: 2,
        delta: 'Checking'
      },
      {
        type: 'append-text',
        messageId: 'assistant-1',
        executionId: 'execution-1',
        createdAt: 2,
        delta: 'I will inspect it.'
      },
      {
        type: 'set-status',
        messageId: 'assistant-1',
        executionId: 'execution-1',
        createdAt: 2,
        status: 'Using a tool'
      },
      {
        type: 'append-tool-call',
        operation: {
          type: 'tool-operation',
          id: 'operation-1',
          executionId: 'execution-1',
          callId: 'call-1',
          name: 'inspect',
          arguments: { path: '/tmp/a' },
          createdAt: 3
        }
      },
      {
        type: 'complete-tool-result',
        operationId: 'operation-1',
        executionId: 'execution-1',
        callId: 'call-1',
        completedAt: 4,
        result: { ok: true }
      },
      {
        type: 'finish-execution',
        executionId: 'execution-1',
        status: 'complete'
      }
    ]

    const transcript = reduceBartTranscriptMany(original, mutations)
    expect(original).toHaveLength(1)
    expect(transcript).toEqual([
      original[0],
      expect.objectContaining({
        type: 'message',
        content: 'I will inspect it.',
        reasoning: 'Checking',
        status: 'complete',
        statusLabel: undefined
      }),
      expect.objectContaining({
        type: 'tool-operation',
        result: { ok: true },
        completedAt: 4
      })
    ])
  })

  it('rejects duplicate tool completion and output after an assistant terminal', () => {
    const call = reduceBartTranscript([], {
      type: 'append-tool-call',
      operation: {
        type: 'tool-operation',
        id: 'operation-1',
        executionId: 'execution-1',
        callId: 'call-1',
        name: 'inspect',
        arguments: null,
        createdAt: 1
      }
    })
    const completed = reduceBartTranscript(call, {
      type: 'complete-tool-result',
      operationId: 'operation-1',
      executionId: 'execution-1',
      callId: 'call-1',
      completedAt: 2,
      result: null
    })
    expect(() => reduceBartTranscript(completed, {
      type: 'complete-tool-result',
      operationId: 'operation-1',
      executionId: 'execution-1',
      callId: 'call-1',
      completedAt: 3,
      result: null
    })).toThrow('already complete')

    const streaming = reduceBartTranscript([], {
      type: 'append-text',
      messageId: 'assistant-1',
      executionId: 'execution-1',
      createdAt: 1,
      delta: 'done'
    })
    const finished = reduceBartTranscript(streaming, {
      type: 'finish-execution',
      executionId: 'execution-1',
      status: 'complete'
    })
    expect(() => reduceBartTranscript(finished, {
      type: 'append-text',
      messageId: 'assistant-1',
      executionId: 'execution-1',
      createdAt: 1,
      delta: 'late'
    })).toThrow('already terminal')
  })

  it('keeps assistant output after a tool result in a later transcript segment', () => {
    const transcript = reduceBartTranscriptMany([], [
      {
        type: 'append-text',
        messageId: 'assistant-before',
        executionId: 'execution-1',
        createdAt: 1,
        delta: 'Before.'
      },
      {
        type: 'append-tool-call',
        operation: {
          type: 'tool-operation',
          id: 'operation-1',
          executionId: 'execution-1',
          callId: 'call-1',
          name: 'inspect',
          arguments: null,
          createdAt: 2
        }
      },
      {
        type: 'complete-tool-result',
        operationId: 'operation-1',
        executionId: 'execution-1',
        callId: 'call-1',
        completedAt: 3,
        result: 'result'
      },
      {
        type: 'append-text',
        messageId: 'assistant-after',
        executionId: 'execution-1',
        createdAt: 4,
        delta: 'After.'
      },
      { type: 'finish-execution', executionId: 'execution-1', status: 'complete' }
    ])
    expect(transcript).toEqual([
      expect.objectContaining({ type: 'message', role: 'assistant', content: 'Before.', status: 'complete' }),
      expect.objectContaining({ type: 'tool-operation', callId: 'call-1', name: 'inspect', arguments: null, result: 'result', completedAt: 3 }),
      expect.objectContaining({ type: 'message', role: 'assistant', content: 'After.', status: 'complete' })
    ])
  })
})

describe('Bart v1 context entries', () => {
  it('runs contributions in parallel and emits them in descriptor order', async () => {
    const releases = new Map<HarnessId, () => void>()
    const started: HarnessId[] = []
    const composition = contextComposition((harnessId) => async () => {
      started.push(harnessId)
      await new Promise<void>((resolve) => releases.set(harnessId, resolve))
      return `from ${harnessId}`
    })

    const collecting = collectBartContextEntries({
      timing: 'system',
      composition,
      signal: new AbortController().signal
    })
    await vi.waitFor(() => expect(started).toHaveLength(HARNESS_IDS.length))
    for (const release of releases.values()) release()

    await expect(collecting).resolves.toEqual([{
      id: 'workspace',
      content: HARNESS_IDS.map(id => `### ${harnessDisplayName(id)} (${id})\nfrom ${id}`).join('\n\n')
    }])
  })

  it('aborts and omits one timed-out contribution without dropping peers', async () => {
    vi.useFakeTimers()
    try {
      let timedOutSignal: AbortSignal | undefined
      const failures: string[] = []
      const composition = emptyContextComposition()
      composition.codex.contextEntries = {
        telemetry: ({ signal }) => {
          timedOutSignal = signal
          return new Promise(() => {})
        }
      }
      composition.claude.contextEntries = { telemetry: () => 'healthy' }

      const collecting = collectBartContextEntries({
        timing: 'run',
        composition,
        signal: new AbortController().signal,
        onFailure: ({ harnessId, reason }) => failures.push(`${harnessId}:${reason}`)
      })
      const telemetryRule = BART_CONTEXT_ENTRY_RULES.find(
        (rule) => rule.id === 'telemetry'
      )!
      await vi.advanceTimersByTimeAsync(telemetryRule.timeoutMs)

      await expect(collecting).resolves.toEqual([{
        id: 'telemetry',
        content: '### Claude (claude)\nhealthy'
      }])
      expect(timedOutSignal?.aborted).toBe(true)
      expect(failures).toEqual(['codex:timeout'])
    } finally {
      vi.useRealTimers()
    }
  })
  it('collects evaluation advice and telemetry as separate entries without interpreting their contents', async () => {
    const composition = emptyContextComposition()
    composition.codex.contextEntries = {
      evaluation: () => 'Native model has no evaluation record.',
      telemetry: () => 'Native usage: 12 requests.'
    }
    await expect(collectBartContextEntries({
      timing: 'run', composition, signal: new AbortController().signal
    })).resolves.toEqual([
      { id: 'evaluation', content: '### Codex (codex)\nNative model has no evaluation record.' },
      { id: 'telemetry', content: '### Codex (codex)\nNative usage: 12 requests.' }
    ])
  })

  it('isolates a failed evaluation source from telemetry and other Harness advice', async () => {
    const composition = emptyContextComposition()
    const failures: unknown[] = []
    composition.codex.contextEntries = {
      evaluation: () => { throw new Error('evaluation source offline') },
      telemetry: () => 'Native usage is available.'
    }
    composition.claude.contextEntries = { evaluation: () => 'Native model advice.' }
    await expect(collectBartContextEntries({
      timing: 'run', composition, signal: new AbortController().signal,
      onFailure: failure => failures.push(failure)
    })).resolves.toEqual([
      { id: 'evaluation', content: '### Claude (claude)\nNative model advice.' },
      { id: 'telemetry', content: '### Codex (codex)\nNative usage is available.' }
    ])
    expect(failures).toEqual([expect.objectContaining({
      entryId: 'evaluation', harnessId: 'codex', reason: 'failed'
    })])
  })
})

describe('Bart v1 Thread creation', () => {
  it('composes the complete Harness settings schema with Core-owned start fields', async () => {
    const composition = settingsComposition()
    const described = await describeThreadCreation({
      composition,
      targetHarnessIds: [...HARNESS_IDS],
      cwd: '/bart',
      signal: new AbortController().signal
    })
    expect(described.targetHarnessIds).toEqual(HARNESS_IDS)
    expect(Object.keys(described).sort()).toEqual(['inputSchema', 'instructions', 'targetHarnessIds'])
    const variants = described.inputSchema.oneOf as JsonValue[]
    expect(variants).toHaveLength(HARNESS_IDS.length)
    expect(variants[0]).toEqual(expect.objectContaining({
      required: ['prompt', 'harnessId', 'options'],
      additionalProperties: false,
      properties: expect.objectContaining({
        harnessId: expect.objectContaining({ const: 'codex' }),
        options: await composition.codex.describe({ cwd: '/bart', signal: new AbortController().signal })
      })
    }))
    expect(described.instructions).toContain('Codex (codex)')
    expect(parseThreadCreationRequest({
      prompt: '  do it  ',
      cwd: ' /repo ',
      worktree: true,
      harnessId: 'codex',
      options: { model: 'native-unrated-model', sandbox: 'workspace-write' }
    })).toEqual({
      prompt: 'do it',
      cwd: '/repo',
      worktree: true,
      harnessId: 'codex',
      options: { model: 'native-unrated-model', sandbox: 'workspace-write' }
    })
  })

  it('describes only enabled Harnesses in configured order', async () => {
    const composition = settingsComposition()
    const disabledDescribe = vi.fn(async () => { throw new Error('disabled Harness must not perform I/O') })
    const described = await describeThreadCreation({
      composition: { ...composition, claude: { ...composition.claude, describe: disabledDescribe } },
      targetHarnessIds: ['pi', 'codex'],
      cwd: '/bart',
      signal: new AbortController().signal
    })
    expect(described.targetHarnessIds).toEqual(['pi', 'codex'])
    expect(disabledDescribe).not.toHaveBeenCalled()
    expect(described.inputSchema.oneOf).toHaveLength(2)
    expect(described.instructions.indexOf('Pi Agent (pi)'))
      .toBeLessThan(described.instructions.indexOf('Codex (codex)'))
  })

  it('uses each fresh settings schema and preserves native fields without an evaluation gate', async () => {
    const composition = settingsComposition()
    const schema = {
      type: 'object',
      properties: {
        model: { type: 'string', enum: ['native-unrated-model', 'native-low-score-model'] },
        permissionMode: { type: 'string', enum: ['default', 'acceptEdits'] },
        nestedNativeOption: { type: 'object', properties: { enabled: { type: 'boolean' } } }
      },
      additionalProperties: false
    }
    const describe = vi.fn(async () => schema)
    const input = {
      composition: { ...composition, codex: { ...composition.codex, describe } },
      targetHarnessIds: ['codex'] as HarnessId[], cwd: '/bart', signal: new AbortController().signal
    }
    const first = await describeThreadCreation(input)
    schema.properties.model.enum.push('new-native-model')
    const second = await describeThreadCreation(input)
    const firstOptions = ((first.inputSchema.oneOf as JsonValue[])[0] as { properties: { options: unknown } }).properties.options
    const secondOptions = ((second.inputSchema.oneOf as JsonValue[])[0] as { properties: { options: unknown } }).properties.options
    expect(firstOptions).toMatchObject({ properties: { model: { enum: ['native-unrated-model', 'native-low-score-model'] } } })
    expect(secondOptions).toEqual(schema)
    expect(describe).toHaveBeenCalledTimes(2)
  })

  it('preserves classified discovery failure without hiding its cause or using another Harness schema', async () => {
    const composition = settingsComposition()
    const failure = new Error('native settings unavailable')
    const unavailable = new ThreadSettingsRefreshUnavailableError(failure.message, { cause: failure })
    await expect(describeThreadCreation({
      composition: { ...composition, codex: { ...composition.codex, describe: async () => { throw unavailable } } },
      targetHarnessIds: ['codex', 'claude'], cwd: '/bart', signal: new AbortController().signal
    })).rejects.toMatchObject({
      name: 'ThreadSettingsRefreshUnavailableError',
      message: expect.stringContaining('native settings unavailable'),
      cause: failure
    })
  })

  it.each(['invalid', 'oversized'] as const)('keeps a %s schema fatal when another source is unavailable', async kind => {
    const composition = settingsComposition()
    const result = describeThreadCreation({
      composition: {
        ...composition,
        codex: { ...composition.codex, describe: async () => { throw new ThreadSettingsRefreshUnavailableError('catalog outage') } },
        claude: { ...composition.claude, describe: async (): Promise<JsonObject> => kind === 'invalid'
          ? { type: 'string' }
          : { type: 'object', description: 'x'.repeat(100_000) }
        }
      },
      targetHarnessIds: ['codex', 'claude'], cwd: '/bart', signal: new AbortController().signal
    })
    await expect(result).rejects.not.toBeInstanceOf(ThreadSettingsRefreshUnavailableError)
    await expect(result).rejects.toThrow(kind === 'invalid' ? 'must describe an object' : /exceeds .* bytes/)
  })

  it('preserves cancellation instead of classifying it as a settings outage', async () => {
    const composition = settingsComposition()
    const controller = new AbortController()
    const cancellation = new Error('admission cancelled')
    await expect(describeThreadCreation({
      composition: { ...composition, codex: { ...composition.codex, describe: async () => {
        controller.abort(cancellation)
        throw new Error('native request aborted')
      } } },
      targetHarnessIds: ['codex'], cwd: '/bart', signal: controller.signal
    })).rejects.toBe(cancellation)
  })

  it('bounds Plugin schemas before they become tool input', async () => {
    const composition = settingsComposition()
    await expect(describeThreadCreation({
      composition: { ...composition, codex: { ...composition.codex, describe: async () => ({
        type: 'object', properties: { model: { type: 'string', description: '模'.repeat(100_000) } }
      }) } },
      targetHarnessIds: ['codex'], cwd: '/bart', signal: new AbortController().signal
    })).rejects.toThrow(/exceeds .* bytes/)
  })

  it('parses only the Core envelope and leaves native option validation to settings resolution', () => {
    const options = { model: 'native-only', permissionMode: 'acceptEdits', nested: { variant: 3 } }
    expect(parseThreadCreationRequest({ prompt: 'Start', harnessId: 'codex', options })).toEqual({
      prompt: 'Start', harnessId: 'codex', options
    })
    const invalidRequests: JsonValue[] = [
      { prompt: '', harnessId: 'codex', options },
      { prompt: 'Start', harnessId: '', options },
      { prompt: 'Start', harnessId: 'codex', options: [] },
      { prompt: 'Start', harnessId: 'codex', options, worktree: 'yes' }
    ]
    for (const invalid of invalidRequests) expect(parseThreadCreationRequest(invalid)).toBeNull()
  })
})

describe('Bart v1 tool bindings', () => {
  it('generates a missing call id, binds all signals, and atomically records call/result', async () => {
    let transcript: readonly BartTranscriptItem[] = []
    let received: { callId?: string; signal: AbortSignal } | undefined
    const binding: HarnessToolBinding = {
      name: 'inspect',
      description: 'Inspect a path',
      inputSchema: {},
      async execute({ callId, signal }) {
        received = { callId, signal }
        return { ok: true }
      }
    }
    const thread = new AbortController()
    const execution = new AbortController()
    const native = new AbortController()
    const times = [10, 11]
    const recorded = createRecordedHarnessToolBinding({
      binding,
      threadId: 'bart-thread-1',
      threadSignal: thread.signal,
      currentExecution: () => ({
        threadId: 'bart-thread-1',
        executionId: 'execution-1',
        signal: execution.signal
      }),
      createCallId: () => 'call-generated',
      createOperationId: () => 'operation-1',
      now: () => times.shift()!,
      recordTranscript: async (mutation) => {
        transcript = reduceBartTranscript(transcript, mutation)
      }
    })

    await expect(recorded.execute({
      arguments: { path: '/tmp/a' },
      signal: native.signal
    })).resolves.toEqual({ ok: true })
    expect(received?.callId).toBe('call-generated')
    expect(transcript).toEqual([expect.objectContaining({
      type: 'tool-operation',
      id: 'operation-1',
      callId: 'call-generated',
      executionId: 'execution-1',
      completedAt: 11,
      result: { ok: true }
    })])

    thread.abort(new Error('thread replaced'))
    expect(received?.signal.aborted).toBe(true)
  })

  it('records an error result before propagating tool failure', async () => {
    let transcript: readonly BartTranscriptItem[] = []
    const recorded = createRecordedHarnessToolBinding({
      binding: {
        name: 'fail',
        description: 'Fail',
        inputSchema: {},
        execute: async () => { throw new Error('native failure') }
      },
      threadId: 'bart-thread-1',
      threadSignal: new AbortController().signal,
      currentExecution: () => ({
        threadId: 'bart-thread-1',
        executionId: 'execution-1',
        signal: new AbortController().signal
      }),
      createCallId: () => 'call-1',
      createOperationId: () => 'operation-1',
      now: (() => {
        let time = 0
        return () => ++time
      })(),
      recordTranscript: async (mutation) => {
        transcript = reduceBartTranscript(transcript, mutation)
      }
    })

    await expect(recorded.execute({
      callId: 'native-call',
      arguments: null,
      signal: new AbortController().signal
    })).rejects.toThrow('native failure')
    expect(transcript).toEqual([expect.objectContaining({
      callId: 'call-1',
      isError: true,
      result: { error: 'native failure' }
    })])
  })
})

function emptyContextComposition(): {
  -readonly [Id in HarnessId]: { contextEntries?: BartContextEntryComposition[Id]['contextEntries'] }
} {
  return Object.fromEntries(HARNESS_IDS.map(id => [id, {}])) as ReturnType<typeof emptyContextComposition>
}

function contextComposition(
  contributor: (harnessId: HarnessId) => NonNullable<
    BartContextEntryComposition[HarnessId]['contextEntries']
  >['workspace']
): BartContextEntryComposition {
  return Object.fromEntries(HARNESS_IDS.map(id => [id, {
    contextEntries: { workspace: contributor(id)! }
  }]))
}

function settingsComposition(): ThreadSettingsDescriptionComposition {
  return Object.fromEntries(HARNESS_IDS.map(id => [id, {
    id,
    displayName: harnessDisplayName(id),
    describe: async () => ({
      type: 'object',
      properties: {
        model: { type: 'string', enum: ['native-unrated-model', 'native-low-score-model'] },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write'] }
      },
      additionalProperties: false
    })
  }]))
}
