import { describe, expect, it } from 'vitest'
import {
  advanceBartForeground,
  extendBartReasoningTail,
  MAX_BART_REASONING_TAIL_POINTS
} from '@openagent/contracts/renderer'
import { projectClaudeBartPresentation } from '../src/shared/bart-presentation.js'
import type { ClaudeThreadState, ClaudeTimelineItem, ClaudeTurn } from '../src/shared/state.js'

function turn(
  executionId: string,
  status: ClaudeTurn['status'],
  timeline: ClaudeTimelineItem[] = []
): ClaudeTurn {
  return {
    executionId,
    createdAt: 1,
    updatedAt: 2,
    ...(status === 'running' ? {} : { finishedAt: 2 }),
    prompts: ['Run'],
    promptAttachments: [[]],
    text: '',
    reasoning: '',
    status,
    plan: [],
    activities: [],
    interactions: [],
    notices: [],
    timeline
  }
}

function state(turns: ClaudeTurn[]): ClaudeThreadState {
  return { version: 1, turns, nativeNotifications: [] }
}

function assistant(id: string, content: string, messageId?: string): ClaudeTimelineItem {
  return {
    id,
    kind: 'assistant',
    createdAt: 1,
    content,
    status: 'complete',
    ...(messageId ? { messageId } : {})
  }
}

describe('Claude Bart foreground activity', () => {
  it('keeps one sequence while reasoning deltas keep arriving', () => {
    const current = turn('execution-1', 'running')
    current.foreground = advanceBartForeground(current.foreground, {
      kind: 'reasoning',
      text: extendBartReasoningTail(current.foreground, '先看 ')
    })
    const first = current.foreground
    current.foreground = advanceBartForeground(current.foreground, {
      kind: 'reasoning',
      text: extendBartReasoningTail(current.foreground, '调用链')
    })

    expect(first).toEqual({ kind: 'reasoning', text: '先看 ', sequence: 1 })
    expect(current.foreground).toEqual({ kind: 'reasoning', text: '先看 调用链', sequence: 1 })
  })

  it('bumps the sequence when the kind changes or a distinct call arrives', () => {
    const current = turn('execution-1', 'running')
    current.foreground = advanceBartForeground(current.foreground, { kind: 'reasoning', text: '想' })
    current.foreground = advanceBartForeground(current.foreground, { kind: 'assistant-text' })
    expect(current.foreground).toEqual({ kind: 'assistant-text', sequence: 2 })

    current.foreground = advanceBartForeground(current.foreground, {
      kind: 'tool-call',
      callId: 'call-1',
      toolName: 'read_file'
    })
    expect(current.foreground).toEqual({
      kind: 'tool-call',
      callId: 'call-1',
      toolName: 'read_file',
      sequence: 3
    })

    // The same call re-announced is not a new semantic event.
    current.foreground = advanceBartForeground(current.foreground, {
      kind: 'tool-call',
      callId: 'call-1',
      toolName: 'read_file'
    })
    expect(current.foreground).toMatchObject({ callId: 'call-1', sequence: 3 })

    current.foreground = advanceBartForeground(current.foreground, {
      kind: 'tool-call',
      callId: 'call-2',
      toolName: 'read_file'
    })
    expect(current.foreground).toMatchObject({ callId: 'call-2', sequence: 4 })
  })

  it('bounds the retained reasoning tail by code point', () => {
    const current = turn('execution-1', 'running')
    for (const chunk of ['推'.repeat(60), '再推'.repeat(40)]) {
      current.foreground = advanceBartForeground(current.foreground, {
        kind: 'reasoning',
        text: extendBartReasoningTail(current.foreground, chunk)
      })
    }
    const reasoning = current.foreground
    expect(reasoning?.kind).toBe('reasoning')
    const text = reasoning?.kind === 'reasoning' ? reasoning.text : ''
    expect([...text].length).toBe(MAX_BART_REASONING_TAIL_POINTS)
    expect(text).toBe([...('推'.repeat(60) + '再推'.repeat(40))].slice(-MAX_BART_REASONING_TAIL_POINTS).join(''))
  })
})

describe('Claude Bart presentation', () => {
  it('publishes the foreground only while the latest turn is running', () => {
    const running = turn('execution-1', 'running')
    running.foreground = { kind: 'assistant-text', sequence: 1 }
    expect(projectClaudeBartPresentation(state([running])).activity).toEqual({
      kind: 'assistant-text',
      sequence: 1,
      executionId: 'execution-1'
    })
    expect(projectClaudeBartPresentation(state([turn('execution-1', 'completed')])).activity).toBeNull()
    expect(projectClaudeBartPresentation(state([running, turn('execution-2', 'running')])).activity).toBeNull()
    expect(projectClaudeBartPresentation(state([])).activity).toBeNull()
  })

  it('publishes the last non-empty assistant answer of the latest completed turn', () => {
    const completed = turn('execution-1', 'completed', [
      assistant('blank', '   '),
      assistant('answer-1', '旧答案'),
      assistant('answer-2', '最终答案')
    ])
    const reply = projectClaudeBartPresentation(state([completed])).reply
    expect(reply).toMatchObject({ executionId: 'execution-1', excerpt: '最终答案' })
    expect(reply?.id).toBe(JSON.stringify(['execution-1', 'answer-2']))
    expect(reply?.target).toEqual({ executionId: 'execution-1', messageId: 'answer-2' })
  })

  it('aggregates the same native message id into one stable reply', () => {
    const completed = turn('execution-1', 'completed', [
      assistant('segment-1', 'Same', 'native-answer-1'),
      assistant('segment-2', ' answer.', 'native-answer-1')
    ])
    const completedState = state([completed])
    const reply = projectClaudeBartPresentation(completedState).reply
    expect(reply?.excerpt).toBe('Same answer.')
    expect(reply?.id).toBe(JSON.stringify(['execution-1', 'native-answer-1']))
    expect(reply?.target).toEqual({ executionId: 'execution-1', messageId: 'native-answer-1' })
  })

  it('never advertises a running, failed, interrupted or blank turn', () => {
    expect(projectClaudeBartPresentation(state([
      turn('execution-1', 'running', [assistant('a', '进行中')])
    ])).reply).toBeNull()
    expect(projectClaudeBartPresentation(state([
      turn('execution-1', 'failed', [assistant('a', '半句')])
    ])).reply).toBeNull()
    expect(projectClaudeBartPresentation(state([
      turn('execution-1', 'interrupted', [assistant('a', '半句')])
    ])).reply).toBeNull()
    expect(projectClaudeBartPresentation(state([
      turn('execution-1', 'completed', [assistant('a', '   ')])
    ])).reply).toBeNull()
    expect(projectClaudeBartPresentation(state([])).reply).toBeNull()
  })

  it('reaches past a completed turn with no answer to the earlier unread one', () => {
    // A tool-only or otherwise answer-less run is not a reminder of its own, so
    // it must not hide the answer the reader has not seen yet.
    const reply = projectClaudeBartPresentation(state([
      turn('execution-1', 'completed', [assistant('old', '旧答案')]),
      turn('execution-2', 'completed')
    ])).reply
    expect(reply).toMatchObject({ executionId: 'execution-1', excerpt: '旧答案' })
  })
})
