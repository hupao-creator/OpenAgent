import { describe, expect, it } from 'vitest'
import {
  parseClaudeThreadState,
  type ClaudeThreadState
} from '../src/shared/state.js'

describe('Claude current state schema', () => {
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
