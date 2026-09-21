import { describe, expect, it } from 'vitest'
import { MAX_BART_REASONING_SOURCE_POINTS, MAX_BART_TOOL_NAME_POINTS } from '@openagent/contracts/renderer'
import { projectCodexBartPresentation } from '../src/shared/bart-presentation.js'
import {
  createEmptyCodexState,
  decodeCodexState,
  reduceCodexEvent,
  settleCodexExecution,
  stageCodexExecution
} from '../src/shared/state.js'
import type { CodexHarnessState } from '../src/shared/types.js'

function staged(executionId = 'execution-1', messageId = 'user-1', at = 2): CodexHarnessState {
  return stageCodexExecution(
    createEmptyCodexState(1),
    executionId,
    { parts: [{ kind: 'text', text: `Prompt ${executionId}` }] },
    at,
    messageId
  )
}

function send(
  state: CodexHarnessState,
  event: Parameters<typeof reduceCodexEvent>[2],
  executionId = 'execution-1'
): CodexHarnessState {
  return reduceCodexEvent(state, executionId, event, 100, `event-${Math.random()}`)
}

function activityOf(state: CodexHarnessState): unknown {
  return projectCodexBartPresentation(state).activity
}

describe('Codex Bart foreground activity', () => {
  it('keeps one segment while reasoning deltas keep arriving', () => {
    let state = staged()
    state = send(state, { type: 'reasoning-delta', delta: '先看 ' })
    const first = activityOf(state)
    state = send(state, { type: 'reasoning-delta', delta: '调用链' })
    const second = activityOf(state)

    expect(first).toEqual({ kind: 'reasoning', text: '先看 ', sequence: 1, executionId: 'execution-1' })
    expect(second).toEqual({ kind: 'reasoning', text: '先看 调用链', sequence: 1, executionId: 'execution-1' })
  })

  it('opens a new reasoning segment at a marker the timeline deduped', () => {
    let state = send(staged(), { type: 'reasoning-delta', delta: '先看' })
    expect(activityOf(state)).toMatchObject({ kind: 'reasoning', sequence: 1 })

    // The first plan reaches the timeline, so it ends the segment either way.
    state = send(state, { type: 'plan', steps: [{ step: 'One', status: 'pending' }] })
    state = send(state, { type: 'reasoning-delta', delta: '再想' })
    expect(activityOf(state)).toMatchObject({ kind: 'reasoning', text: '再想', sequence: 2 })

    // A second plan of the same kind is deduped out of the timeline, but it is
    // still an event: the reasoning after it begins a segment of its own.
    state = send(state, { type: 'plan', steps: [{ step: 'Two', status: 'pending' }] })
    state = send(state, { type: 'reasoning-delta', delta: '还想' })
    expect(activityOf(state)).toMatchObject({ kind: 'reasoning', text: '还想', sequence: 3 })
  })

  it('bumps the sequence when the semantic kind changes or a new call arrives', () => {
    let state = send(staged(), { type: 'reasoning-delta', delta: '想' })
    state = send(state, { type: 'text-delta', itemId: 'answer-1', delta: '写' })
    expect(activityOf(state)).toMatchObject({ kind: 'assistant-text', sequence: 2 })

    state = send(state, {
      type: 'activity-start',
      activity: { id: 'call-1', kind: 'tool', label: 'Read', status: 'running', toolName: 'read_file' }
    })
    expect(activityOf(state)).toMatchObject({ kind: 'tool-call', callId: 'call-1', sequence: 3 })

    state = send(state, {
      type: 'activity-start',
      activity: { id: 'call-2', kind: 'tool', label: 'Read', status: 'running', toolName: 'read_file' }
    })
    expect(activityOf(state)).toMatchObject({ kind: 'tool-call', callId: 'call-2', sequence: 4 })

    state = send(state, { type: 'activity-update', activityId: 'call-2', detail: '进度' })
    expect(activityOf(state)).toMatchObject({ kind: 'tool-call', callId: 'call-2', sequence: 4 })
  })

  it('keeps a replayed call start from reclaiming the foreground', () => {
    let state = send(staged(), {
      type: 'activity-start',
      activity: { id: 'call-1', kind: 'tool', label: 'Read', status: 'running', toolName: 'read_file' }
    })
    state = send(state, { type: 'activity-end', activityId: 'call-1', status: 'completed', detail: 'done' })
    state = send(state, { type: 'reasoning-delta', delta: '想' })
    const before = activityOf(state)
    expect(before).toMatchObject({ kind: 'reasoning', sequence: 2 })

    // A parser re-reading its own timeline announces the call a second time.
    state = send(state, {
      type: 'activity-start',
      activity: { id: 'call-1', kind: 'tool', label: 'Read', status: 'running', toolName: 'read_file' }
    })
    expect(activityOf(state)).toEqual(before)
  })

  it('bounds a surrogate-pair tool name by code point without splitting a pair', () => {
    const state = send(staged(), {
      type: 'activity-start',
      activity: {
        id: 'call-1',
        kind: 'tool',
        label: 'Read',
        status: 'running',
        toolName: '🚀'.repeat(MAX_BART_TOOL_NAME_POINTS + 10)
      }
    })
    const projected = projectCodexBartPresentation(state).activity
    const toolName = projected?.kind === 'tool-call' ? projected.toolName : ''
    expect([...toolName].length).toBe(MAX_BART_TOOL_NAME_POINTS)
    expect(toolName).toBe('🚀'.repeat(MAX_BART_TOOL_NAME_POINTS))
  })

  it('ignores empty deltas, tool results, usage and duplicate settlement', () => {
    let state = send(staged(), { type: 'reasoning-delta', delta: '想' })
    const before = activityOf(state)
    for (const event of [
      { type: 'reasoning-delta', delta: '' } as const,
      { type: 'text-delta', itemId: 'answer-1', delta: '' } as const,
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } } as const,
      { type: 'status', label: 'Working' } as const,
      {
        type: 'activity-end',
        activityId: 'call-1',
        status: 'completed' as const,
        result: 'done'
      } as const
    ]) {
      state = send(state, event)
    }
    expect(activityOf(state)).toEqual(before)
  })

  it('publishes nothing once the execution settles', () => {
    const state = settleCodexExecution(send(staged(), { type: 'reasoning-delta', delta: '想' }), 'execution-1', 'completed', 50)
    expect(projectCodexBartPresentation(state).activity).toBeNull()
  })

  it('retains reasoning bursts for consumption and bounds the canonical tool name', () => {
    let state = staged()
    for (const chunk of ['推'.repeat(60), '再推'.repeat(40)]) {
      state = send(state, { type: 'reasoning-delta', delta: chunk })
    }
    const reasoning = projectCodexBartPresentation(state).activity
    expect(reasoning?.kind).toBe('reasoning')
    const text = reasoning?.kind === 'reasoning' ? reasoning.text : ''
    expect([...text].length).toBeLessThanOrEqual(MAX_BART_REASONING_SOURCE_POINTS)
    expect(text).toBe('推'.repeat(60) + '再推'.repeat(40))

    const tool = send(state, {
      type: 'activity-start',
      activity: {
        id: 'call-1',
        kind: 'tool',
        label: 'Read',
        status: 'running',
        toolName: `${'名'.repeat(70)}tail`
      }
    })
    const projected = projectCodexBartPresentation(tool).activity
    expect(projected?.kind).toBe('tool-call')
    const toolName = projected?.kind === 'tool-call' ? projected.toolName : ''
    expect([...toolName].length).toBe(MAX_BART_TOOL_NAME_POINTS)
    expect(toolName.startsWith('名')).toBe(true)
  })

  it('keeps a canonical tool name through the persisted-state round trip', () => {
    const state = send(staged(), {
      type: 'activity-start',
      activity: { id: 'call-1', kind: 'tool', label: 'Read', status: 'running', toolName: 'read_file' }
    })
    // A rejected activity would fail the whole turn, so the decoder has to
    // accept the canonical name the projection adds.
    const decoded = decodeCodexState(JSON.parse(JSON.stringify(state)) as unknown)
    expect(decoded.turns[0]!.activities[0]!.toolName).toBe('read_file')
    expect(projectCodexBartPresentation(decoded).activity).toMatchObject({
      kind: 'tool-call',
      callId: 'call-1',
      toolName: 'read_file'
    })
  })

  it('persists the absolute reasoning window position without splitting surrogate pairs', () => {
    let state = send(staged(), { type: 'reasoning-delta', delta: '🧠'.repeat(MAX_BART_REASONING_SOURCE_POINTS + 3) })
    state = send(state, { type: 'reasoning-delta', delta: '完成' })
    const decoded = decodeCodexState(JSON.parse(JSON.stringify(state)))
    expect(activityOf(decoded)).toMatchObject({
      kind: 'reasoning', sequence: 1, textOffset: 10,
      text: '🧠'.repeat(MAX_BART_REASONING_SOURCE_POINTS - 2) + '完成'
    })
    const oversized = JSON.parse(JSON.stringify(state))
    oversized.turns[0].foreground.text = '推'.repeat(MAX_BART_REASONING_SOURCE_POINTS + 1)
    expect(() => decodeCodexState(oversized)).toThrow()
    state = send(state, { type: 'text-delta', itemId: 'a', delta: '说明' })
    state = send(state, { type: 'reasoning-delta', delta: '新的段落' })
    expect(activityOf(state)).toEqual({ kind: 'reasoning', text: '新的段落', sequence: 3, executionId: 'execution-1' })
  })

  it('starts the next execution from an empty foreground', () => {
    let state = send(staged(), { type: 'reasoning-delta', delta: '想' })
    state = settleCodexExecution(state, 'execution-1', 'completed', 50)
    const next = send(staged('execution-2', 'user-2', 60), { type: 'text-delta', itemId: 'answer-9', delta: '答' }, 'execution-2')
    expect(projectCodexBartPresentation(next).activity).toEqual({
      kind: 'assistant-text',
      sequence: 1,
      executionId: 'execution-2'
    })
  })
})

describe('Codex Bart final reply', () => {
  it('publishes the last non-empty assistant answer of the latest completed turn', () => {
    let state = send(staged(), { type: 'text-delta', itemId: 'answer-1', delta: '第一段' })
    // The terminal item completes the native text before the turn settles; the
    // reply must carry that completed text rather than the last streamed delta.
    state = send(state, { type: 'text-final', itemId: 'answer-1', text: '完整答案' })
    state = settleCodexExecution(state, 'execution-1', 'completed', 50)

    const reply = projectCodexBartPresentation(state).reply
    expect(reply).toMatchObject({ executionId: 'execution-1', excerpt: '完整答案' })
    expect(reply?.target).toEqual({ executionId: 'execution-1', itemId: 'answer-1' })
  })

  it.each(['failed', 'interrupted'] as const)('never advertises a %s turn', (outcome) => {
    const state = settleCodexExecution(send(staged(), { type: 'text-delta', itemId: 'answer-1', delta: '半句' }), 'execution-1', outcome, 50)
    expect(projectCodexBartPresentation(state).reply).toBeNull()
  })

  it('advertises nothing while the turn is still running', () => {
    const state = send(staged(), { type: 'text-delta', itemId: 'answer-1', delta: '进行中' })
    expect(projectCodexBartPresentation(state).reply).toBeNull()
  })

  it('skips a completed turn whose last assistant message is blank', () => {
    const state = settleCodexExecution(staged(), 'execution-1', 'completed', 50)
    expect(projectCodexBartPresentation(state).reply).toBeNull()
  })

  it('reaches past a completed turn with no answer to the earlier unread one', () => {
    // A tool-only or otherwise answer-less run is not a reminder of its own, so
    // it must not hide the answer the reader has not seen yet.
    let state = send(staged(), { type: 'text-delta', itemId: 'answer-1', delta: '旧答案' })
    state = settleCodexExecution(state, 'execution-1', 'completed', 50)
    state = stageCodexExecution(
      state, 'execution-2', { parts: [{ kind: 'text', text: 'Prompt execution-2' }] }, 60, 'user-2'
    )
    state = settleCodexExecution(state, 'execution-2', 'completed', 70)
    expect(projectCodexBartPresentation(state).reply)
      .toMatchObject({ executionId: 'execution-1', excerpt: '旧答案' })
  })
})
