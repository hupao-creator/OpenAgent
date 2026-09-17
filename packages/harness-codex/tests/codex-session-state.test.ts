import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonValue, type JsonValue } from '@openagent/contracts'
import { codexSessionState } from '../src/shared/session-state.js'
import {
  completeCodexBackgroundActivity,
  createEmptyCodexState,
  decodeCodexState,
  reduceCodexEvent,
  settleCodexExecution,
  stageCodexExecution,
  updateCodexBackgroundTerminals,
  updateCodexNativeActivity
} from '../src/shared/state.js'
import type { CodexHarnessState } from '../src/shared/types.js'

afterEach(() => vi.restoreAllMocks())

describe('Codex Session authority', () => {
  it.each(['completed', 'failed', 'interrupted'] as const)(
    'reconstructs a stable %s observation using only the persisted terminal record', outcome => {
      const state = settleCodexExecution(staged('first', 10), 'first', outcome, 20, 'native failed')
      const stored = json(state)
      const before = structuredClone(stored)
      vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('projection read the clock') })

      const observation = codexSessionState.project(stored)
      expect(observation).toEqual({
        latestExecution: {
          executionId: 'first',
          status: outcome,
          startedAt: 10,
          finishedAt: 20,
          summary: outcome === 'failed' ? 'native failed' : 'Prompt first',
          ...(outcome === 'failed' ? { error: 'native failed' } : {})
        },
        backgroundWork: null
      })
      expect(codexSessionState.project(json(decodeCodexState(stored)))).toEqual(observation)
      expect(codexSessionState.project(stored)).toEqual(observation)
      expect(stored).toEqual(before)
    }
  )

  it('projects the last record while scanning older records for Session background work', () => {
    let state = staged('older', 10)
    state = reduceCodexEvent(state, 'older', {
      type: 'activity-start',
      activity: { id: 'background-command', kind: 'command', label: 'build', status: 'running' }
    }, 11, 'activity')
    state = updateCodexBackgroundTerminals(state, [{
      id: 'background-command', command: 'build', cwd: '/workspace'
    }], 12)
    state = settleCodexExecution(state, 'older', 'completed', 20)
    state = updateCodexBackgroundTerminals(state, [], 21)
    state = stageCodexExecution(state, 'latest', {
      parts: [{ kind: 'text', text: 'New task' }]
    }, 30, 'latest-message')
    expect(codexSessionState.project(json(state))).toEqual({
      latestExecution: {
        executionId: 'latest', status: 'running', startedAt: 30, summary: 'New task'
      },
      backgroundWork: { status: 'running' }
    })
    state = settleCodexExecution(state, 'latest', 'completed', 40)
    const terminalObservation = codexSessionState.project(json(state)).latestExecution
    const completed = completeCodexBackgroundActivity(
      state, 'background-command', 'completed', 'build succeeded', 1_000
    )
    expect(completed.turns[0]).toMatchObject({ updatedAt: 1_000, finishedAt: 20 })
    expect(completed.turns[1]).toEqual(state.turns[1])
    expect(codexSessionState.project(json(completed))).toEqual({
      latestExecution: terminalObservation,
      backgroundWork: null
    })
    expect(codexSessionState.project(json(completed)).latestExecution).toMatchObject({
      executionId: 'latest', finishedAt: 40
    })
  })

  it('settles only the named nonterminal record and retains unrelated Session facts', () => {
    let state = staged('target', 10)
    const later = settleCodexExecution(staged('latest', 30), 'latest', 'completed', 40)
    state = {
      ...state,
      updatedAt: 40,
      turns: [...state.turns, ...later.turns]
    }
    state = updateCodexBackgroundTerminals(state, [{
      id: 'unrelated-background', command: 'watch', cwd: '/workspace'
    }], 41)
    state = updateCodexNativeActivity(state, 'background', 'Unrelated native work', 42)
    const previous = json(state)
    const settled = codexSessionState.settle({
      sessionState: previous, executionId: 'target', outcome: 'failed', finishedAt: 50
    })
    const decoded = decodeCodexState(settled)
    expect(decoded.turns[0]).toMatchObject({ status: 'failed', finishedAt: 50 })
    expect(decoded.turns[1]).toEqual(state.turns[1])
    expect(decoded.backgroundTerminals).toEqual(state.backgroundTerminals)
    expect(decoded.nativeActivity).toEqual(state.nativeActivity)
    expect(codexSessionState.project(settled).latestExecution).toMatchObject({
      executionId: 'latest', status: 'completed', finishedAt: 40
    })
    expect(codexSessionState.settle({
      sessionState: settled, executionId: 'target', outcome: 'interrupted', finishedAt: 100
    })).toEqual(settled)
    expect(codexSessionState.settle({
      sessionState: settled, executionId: 'unknown', outcome: 'failed', finishedAt: 100
    })).toEqual(settled)
    expect(previous).toEqual(json(state))
  })

  it('reconstructs pending interaction identities from the persisted turn and clears them on resolution', () => {
    const waiting = reduceCodexEvent(staged('interaction', 10), 'interaction', {
      type: 'interaction-opened',
      interaction: {
        id: 'native-approval', kind: 'command-approval', title: 'Run the build?',
        blocksTurn: true, status: 'pending',
        actions: [{ id: 'allow-once', intent: 'allow', label: 'Allow once' }],
        questions: []
      }
    }, 11, 'request')
    const before = json(waiting)
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('projection read the clock') })
    const observation = codexSessionState.project(before)
    expect(observation.latestExecution).toMatchObject({
      executionId: 'interaction', status: 'waiting-for-user', startedAt: 10,
      interactions: [{ kind: 'permission', title: 'Run the build?' }]
    })
    expect(codexSessionState.project(json(decodeCodexState(before)))).toEqual(observation)
    const resolved = reduceCodexEvent(waiting, 'interaction', {
      type: 'interaction-closed', interactionId: 'native-approval', resolution: 'accept'
    }, 12, 'resolved')
    expect(codexSessionState.project(json(resolved))).toEqual({
      latestExecution: {
        executionId: 'interaction', status: 'running', startedAt: 10, summary: 'Prompt interaction'
      },
      backgroundWork: null
    })
    expect(codexSessionState.project(null)).toEqual({ latestExecution: null, backgroundWork: null })
  })

  it('persists the native done timestamp and rejects a terminal record without that fact', () => {
    const done = reduceCodexEvent(staged('native', 10), 'native', {
      type: 'done', outcome: 'completed'
    }, 20, 'done')
    expect(decodeCodexState(json(done)).turns[0]?.finishedAt).toBe(20)
    expect(codexSessionState.project(json(done)).latestExecution).toMatchObject({
      executionId: 'native', finishedAt: 20
    })
    const { finishedAt: _finishedAt, ...withoutFinish } = done.turns[0]!
    expect(() => decodeCodexState({ ...done, turns: [withoutFinish] })).toThrow(/sessionState/)
    const active = staged('active', 10)
    expect(() => decodeCodexState({
      ...active, turns: [{ ...active.turns[0]!, finishedAt: 10 }]
    })).toThrow(/sessionState/)
    expect(codexSessionState.project(null)).toEqual({ latestExecution: null, backgroundWork: null })
  })
})

function staged(executionId: string, at: number): CodexHarnessState {
  return stageCodexExecution(createEmptyCodexState(1), executionId, {
    parts: [{ kind: 'text', text: `Prompt ${executionId}` }]
  }, at, `${executionId}-message`)
}

function json(state: CodexHarnessState): JsonValue {
  const value: unknown = structuredClone(state)
  if (!isJsonValue(value)) throw new Error('invalid test fixture')
  return value
}
