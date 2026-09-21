import { describe, expect, it } from 'vitest'
import { MAX_BART_REASONING_SOURCE_POINTS } from '@openagent/contracts/renderer'
import {
  parseClaudeThreadState,
  type ClaudeThreadState
} from '../src/shared/state.js'

describe('Claude current state schema', () => {
  it('preserves reasoning source positions and rejects invalid offsets', () => {
    const state = questionState()
    state.turns[0]!.foreground = { kind: 'reasoning', sequence: 1, text: '保留片段', textOffset: 120 }
    expect(parseClaudeThreadState(state).turns[0]!.foreground).toEqual(state.turns[0]!.foreground)
    state.turns[0]!.foreground = { kind: 'reasoning', sequence: 1, text: '🧠'.repeat(MAX_BART_REASONING_SOURCE_POINTS) }
    expect(parseClaudeThreadState(state).turns[0]!.foreground).toEqual(state.turns[0]!.foreground)
    state.turns[0]!.foreground = { kind: 'reasoning', sequence: 1, text: '推'.repeat(MAX_BART_REASONING_SOURCE_POINTS + 1) }
    expect(() => parseClaudeThreadState(state)).toThrow(/foreground/)
    for (const textOffset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      state.turns[0]!.foreground = { kind: 'reasoning', sequence: 1, text: '保留片段', textOffset }
      expect(() => parseClaudeThreadState(state)).toThrow(/foreground/)
    }
  })

  it('preserves a current-format question and its options', () => {
    const state = questionState()

    expect(parseClaudeThreadState(state)).toEqual(state)
  })

  it('rejects a foreground snapshot that carries a NUL', () => {
    // The reducer sanitizes the native delta before it reaches the snapshot,
    // because this codec refuses the whole commit otherwise.
    const state = questionState()
    state.turns[0]!.status = 'running'
    state.turns[0]!.foreground = {
      kind: 'reasoning',
      text: `想${String.fromCharCode(0)}`,
      sequence: 1
    }
    expect(() => parseClaudeThreadState(state)).toThrow(/foreground/)
  })

  it('rejects unknown question fields instead of coercing a legacy shape', () => {
    const state = questionState()
    const question = state.turns[0]!.interactions[0]!.questions![0]!
    state.turns[0]!.interactions[0]!.questions![0] = {
      ...question,
      legacyOptions: question.options
    } as typeof question

    expect(() => parseClaudeThreadState(state)).toThrow(
      /Claude interaction question .*legacyOptions/
    )
  })

  it('rejects unknown option fields instead of silently dropping them', () => {
    const state = questionState()
    const option = state.turns[0]!.interactions[0]!.questions![0]!.options[0]!
    state.turns[0]!.interactions[0]!.questions![0]!.options[0] = {
      ...option,
      value: 'legacy-a'
    } as typeof option

    expect(() => parseClaudeThreadState(state)).toThrow(
      /Claude interaction option .*value/
    )
  })
})

function questionState(): ClaudeThreadState {
  return {
    version: 1,
    turns: [
      {
        executionId: 'execution-1',
        createdAt: 1,
        updatedAt: 2,
        prompts: ['Choose one'],
        promptAttachments: [[]],
        text: '',
        reasoning: '',
        status: 'running',
        plan: [],
        activities: [],
        interactions: [
          {
            id: 'interaction-1',
            kind: 'question',
            title: 'Question',
            status: 'pending',
            questions: [
              {
                question: 'Which option?',
                header: 'Choice',
                multiSelect: false,
                options: [
                  { label: 'A', description: 'First option' },
                  { label: 'B' }
                ]
              }
            ]
          }
        ],
        notices: [],
        timeline: []
      }
    ],
    nativeNotifications: []
  }
}
