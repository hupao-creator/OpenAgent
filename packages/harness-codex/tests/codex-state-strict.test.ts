import { describe, expect, it } from 'vitest'
import {
  bindCodexPrimarySession,
  createEmptyCodexState,
  decodeCodexState,
  reduceCodexEvent,
  stageCodexExecution,
  updateCodexBackgroundTerminals,
  updateCodexNativeActivity
} from '../src/shared/state.js'
import type { CodexHarnessState } from '../src/shared/types.js'

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T

describe('Codex current-v1 persisted state', () => {
  it('round-trips every current producer family as an isolated clone', () => {
    const source = validState()
    const decoded = decodeCodexState(source)

    expect(decoded).toEqual(source)
    expect(decoded).not.toBe(source)
    expect(decoded.turns[0]).not.toBe(source.turns[0])
    expect(decoded.turns[0]?.messages[0]).not.toBe(source.turns[0]?.messages[0])
    expect(decoded.turns[0]?.timeline.map((item) => item.kind)).toEqual([
      'user-message',
      'assistant',
      'reasoning',
      'plan',
      'diff',
      'review',
      'context-compaction',
      'activity',
      'interaction',
      'notice',
      'notice',
      'error'
    ])
  })

  it('rejects unknown and legacy keys at every nested state layer', () => {
    expectInvalid((state) => setUnknown(state, 'legacyVersion', 1))
    expectInvalid((state) => setUnknown(state.nativeActivity!, 'message', 'legacy'))
    expectInvalid((state) => setUnknown(state.backgroundTerminals[0]!, 'processId', 42))
    expectInvalid((state) => setUnknown(turn(state), 'runId', 'legacy'))
    expectInvalid((state) => setUnknown(turn(state).messages[0]!, 'text', 'legacy'))
    expectInvalid((state) => setUnknown(
      turn(state).messages[0]!.attachments[0]!,
      'path',
      '/legacy'
    ))
    expectInvalid((state) => setUnknown(turn(state).plan[0]!, 'id', 'legacy'))
    expectInvalid((state) => setUnknown(turn(state).activities[0]!, 'commandId', 'legacy'))
    expectInvalid((state) => setUnknown(turn(state).interactions[0]!, 'request', {}))
    expectInvalid((state) => setUnknown(
      turn(state).interactions[0]!.actions[0]!,
      'remember',
      true
    ))
    expectInvalid((state) => setUnknown(
      turn(state).interactions[0]!.questions[0]!,
      'multiSelect',
      false
    ))
    expectInvalid((state) => setUnknown(
      turn(state).interactions[0]!.questions[0]!.options[0]!,
      'value',
      'workspace'
    ))
    expectInvalid((state) => setUnknown(turn(state).notices[0]!, 'createdAt', 17))
    expectInvalid((state) => setUnknown(turn(state).usage!, 'input_tokens', 3))

    for (let index = 0; index < validState().turns[0]!.timeline.length; index += 1) {
      expectInvalid((state) => setUnknown(
        turn(state).timeline[index]!,
        'legacySequence',
        index
      ))
    }
  })

  it('rejects malformed types throughout arrays and discriminated objects', () => {
    expectInvalid((state) => {
      state.nativeActivity!.status = 42 as never
    })
    expectInvalid((state) => {
      ;(state.backgroundTerminals as unknown[])[0] = 42
    })
    expectInvalid((state) => {
      state.backgroundTerminals = Array.from({ length: 2_001 }, (_value, index) => ({
        id: `background-${String(index)}`,
        command: '',
        cwd: ''
      }))
    })
    expectInvalid((state) => {
      ;(turn(state).messages as unknown[])[0] = 42
    })
    expectInvalid((state) => {
      ;(turn(state).messages[0]!.attachments as unknown[])[0] = null
    })
    expectInvalid((state) => {
      ;(turn(state).timeline as unknown[])[0] = 42
    })
    expectInvalid((state) => {
      ;(turn(state).plan as unknown[])[0] = false
    })
    expectInvalid((state) => {
      turn(state).plan = Array.from({ length: 201 }, () => ({
        step: 'step',
        status: 'pending'
      }))
    })
    expectInvalid((state) => {
      ;(turn(state).activities as unknown[])[0] = 'activity'
    })
    expectInvalid((state) => {
      ;(turn(state).interactions as unknown[])[0] = null
    })
    expectInvalid((state) => {
      ;(turn(state).interactions[0]!.actions as unknown[])[0] = 42
    })
    expectInvalid((state) => {
      ;(turn(state).interactions[0]!.questions as unknown[])[0] = 'question'
    })
    expectInvalid((state) => {
      ;(turn(state).interactions[0]!.questions[0]!.options as unknown[])[0] = 42
    })
    expectInvalid((state) => {
      ;(turn(state).notices as unknown[])[0] = 42
    })
    expectInvalid((state) => {
      turn(state).usage!.inputTokens = '3' as never
    })
  })

  it('requires all current fields instead of accepting incomplete legacy shapes', () => {
    expectInvalid((state) => {
      delete (state as Partial<typeof state>).backgroundTerminals
    })
    expectInvalid((state) => {
      delete (turn(state).messages[0] as unknown as Record<string, unknown>).attachments
    })
    expectInvalid((state) => {
      const assistant = turn(state).timeline.find((item) => item.kind === 'assistant')!
      delete (assistant as unknown as Record<string, unknown>).itemId
    })
    expectInvalid((state) => {
      delete (turn(state).interactions[0] as unknown as Record<string, unknown>).blocksTurn
    })
    expectInvalid((state) => {
      delete (turn(state).interactions[0]!.questions[0] as unknown as
        Record<string, unknown>).secret
    })
    expectInvalid((state) => {
      ;(state as Record<string, unknown>).primarySessionId = undefined
    })
  })

  it.each(['', ' ', ' native-item ', 'native\u0000item', 42, null])(
    'rejects invalid native assistant identity %j', (itemId) => {
      expectInvalid((state) => {
        const assistant = turn(state).timeline.find((item) => item.kind === 'assistant')!
        ;(assistant as unknown as Record<string, unknown>).itemId = itemId
      })
    }
  )

  it('keeps raw current producer strings and finite native usage values', () => {
    const state = structuredClone(validState()) as Mutable<CodexHarnessState>
    turn(state).messages[0]!.attachments[0]!.id = ' attachment id '
    turn(state).interactions[0]!.questions[0]!.id = ' native question id '
    turn(state).interactions[0]!.questions[0]!.options[0]!.id =
      ' native question id :option:0'
    turn(state).usage!.inputTokens = -0.5

    expect(() => decodeCodexState(state)).not.toThrow()
  })

  it('enforces timestamp containment without rejecting terminal native activity', () => {
    expectInvalid((state) => {
      turn(state).updatedAt = turn(state).createdAt - 1
    })
    expectInvalid((state) => {
      state.updatedAt = turn(state).updatedAt - 1
    })
    expectInvalid((state) => {
      turn(state).messages[0]!.createdAt = turn(state).updatedAt + 1
    })
    expectInvalid((state) => {
      turn(state).timeline[0]!.createdAt = turn(state).createdAt - 1
    })
    expectInvalid((state) => {
      state.nativeActivity!.updatedAt = state.updatedAt + 1
    })

    expect(validState()).toMatchObject({
      nativeActivity: { status: 'idle' },
      turns: [{ status: 'completed' }]
    })
    expect(() => decodeCodexState(validState())).not.toThrow()
  })
})

function validState(): CodexHarnessState {
  let state = createEmptyCodexState(0)
  state = stageCodexExecution(state, 'execution-1', {
    presentation: 'internal',
    parts: [
      { kind: 'text', text: 'Inspect the repository' },
      {
        kind: 'image',
        file: {
          id: 'attachment-1',
          path: '/workspace/screenshot.png',
          name: 'screenshot.png',
          mimeType: 'image/png',
          size: 12
        }
      },
      { kind: 'audio-url', url: 'https://example.test/briefing.mp3' }
    ]
  }, 1, 'message-1')
  state = bindCodexPrimarySession(state, 'session-1', 2)
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'runtime-model',
    model: 'gpt-current'
  }, 3, 'event-3')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'text-delta',
    itemId: 'answer-1',
    delta: 'Inspecting'
  }, 4, 'event-4')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'text-final',
    itemId: 'answer-1',
    text: 'Inspection complete'
  }, 5, 'event-5')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'reasoning-delta',
    delta: 'Checked state writers'
  }, 6, 'event-6')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'plan',
    explanation: 'Current-only schema',
    steps: [{ step: 'Validate nested state', status: 'completed' }]
  }, 7, 'event-7')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'diff',
    diff: '+ strict decoder'
  }, 8, 'event-8')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'review',
    review: 'No legacy compatibility'
  }, 9, 'event-9')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'context-compacted'
  }, 10, 'event-10')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'activity-start',
    activity: {
      id: 'activity-1',
      kind: 'command',
      label: 'pnpm test',
      status: 'running',
      detail: 'producer detail is replaced at start'
    }
  }, 11, 'event-11')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'activity-end',
    activityId: 'activity-1',
    status: 'completed',
    detail: 'tests passed'
  }, 12, 'event-12')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'interaction-opened',
    interaction: {
      id: 'interaction-1',
      kind: 'user-input',
      title: 'Choose scope',
      detail: 'Select the current scope',
      blocksTurn: true,
      status: 'pending',
      actions: [
        { id: 'submit', intent: 'submit', label: 'Submit' },
        { id: 'cancel', intent: 'cancel', label: 'Cancel' }
      ],
      questions: [{
        id: 'scope',
        header: 'Scope',
        prompt: 'Which scope?',
        secret: false,
        allowOther: true,
        options: [{
          id: 'workspace',
          label: 'Workspace',
          description: 'Current workspace'
        }]
      }]
    }
  }, 13, 'event-13')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'interaction-closed',
    interactionId: 'interaction-1',
    resolution: 'submit'
  }, 14, 'event-14')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'usage',
    usage: {
      inputTokens: 3,
      cachedInputTokens: 2,
      outputTokens: 5,
      reasoningTokens: 1,
      contextWindow: 128_000
    }
  }, 15, 'event-15')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'warning',
    message: 'Transient warning'
  }, 16, 'notice-warning')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'error',
    message: 'Native error detail'
  }, 17, 'notice-error')
  state = reduceCodexEvent(state, 'execution-1', {
    type: 'done',
    outcome: 'completed'
  }, 18, 'event-18')
  state = updateCodexNativeActivity(state, 'idle', 'Background session remains alive', 19)
  return updateCodexBackgroundTerminals(state, [{
    id: 'background-1',
    command: 'pnpm test',
    cwd: '/workspace'
  }], 20)
}

function turn(state: Mutable<CodexHarnessState>): Mutable<CodexHarnessState>['turns'][number] {
  return state.turns[0]!
}

function expectInvalid(mutate: (state: Mutable<CodexHarnessState>) => void): void {
  const state = structuredClone(validState()) as Mutable<CodexHarnessState>
  mutate(state)
  expect(() => decodeCodexState(state)).toThrow(/Codex sessionState/)
}

function setUnknown(value: object, key: string, data: unknown): void {
  ;(value as Record<string, unknown>)[key] = data
}
