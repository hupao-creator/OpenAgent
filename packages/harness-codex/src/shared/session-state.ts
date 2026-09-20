import {
  isJsonValue,
  type HarnessSessionStateAdapter,
  type ThreadPublicObservation
} from '@openagent/contracts'
import { toPublicInteraction } from './public-interactions.js'
import { createEmptyCodexState, decodeCodexState, settleCodexExecution } from './state.js'
import type { CodexHarnessState, CodexTurn } from './types.js'

export const codexSessionState: HarnessSessionStateAdapter = {
  resolveExecution(value, executionId) {
    if (value === null) return null
    const state = decodeCodexState(value)
    const turn = state.turns.find(candidate => candidate.executionId === executionId)
    return turn ? projectCodexSessionState({ ...state, turns: [turn] }).latestExecution : null
  },
  project(value) {
    return projectCodexSessionState(value === null ? createEmptyCodexState() : decodeCodexState(value))
  },
  settle({ sessionState, executionId, outcome, finishedAt }) {
    if (sessionState === null) return null
    const state = decodeCodexState(sessionState)
    const turn = state.turns.find(candidate => candidate.executionId === executionId)
    if (!turn || isTerminal(turn)) return checkedJson(state)
    const settled = settleCodexExecution(state, executionId, outcome, finishedAt)
    // Core only settles the named foreground record. Native Session status may
    // describe unrelated work and remains owned by its event consumer.
    return checkedJson(state.nativeActivity
      ? { ...settled, nativeActivity: state.nativeActivity }
      : settled)
  }
}

function projectCodexSessionState(state: CodexHarnessState): ThreadPublicObservation {
  const backgroundWork = state.backgroundTerminals.length > 0 ||
    state.turns.some(turn => isTerminal(turn) &&
      turn.activities.some(activity => activity.status === 'running'))
    ? { status: 'running' as const }
    : null
  const turn = state.turns.at(-1)
  if (!turn) return { latestExecution: null, backgroundWork }
  const summary = summaryForTurn(turn)
  const identity = {
    executionId: turn.executionId,
    startedAt: turn.createdAt,
    ...(summary ? { summary } : {})
  }
  if (isTerminal(turn)) {
    return {
      latestExecution: {
        ...identity,
        status: turn.status,
        finishedAt: turn.finishedAt!,
        ...(turn.status === 'failed' && turn.error ? { error: turn.error } : {})
      },
      backgroundWork
    }
  }
  const interactions = turn.interactions
    .filter(interaction => interaction.status === 'pending' && interaction.blocksTurn)
    .map(toPublicInteraction)
  return {
    latestExecution: interactions.length
      ? { ...identity, status: 'waiting-for-user', interactions }
      : { ...identity, status: 'running' },
    backgroundWork
  }
}

function isTerminal(turn: CodexTurn): turn is CodexTurn & {
  readonly status: 'completed' | 'failed' | 'interrupted'
} {
  return turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted'
}

function summaryForTurn(turn: CodexTurn): string {
  if (isTerminal(turn)) {
    return turn.lastAssistantMessage?.text || ''
  }
  const source = turn.answer.trim() || turn.error?.trim() ||
    turn.messages.findLast(message => !message.internal)?.content.trim() || ''
  return source.replace(/\s+/g, ' ').slice(0, 2_000)
}

function checkedJson(state: CodexHarnessState) {
  const value: unknown = state
  if (!isJsonValue(value)) throw new Error('Codex sessionState 不是有效 JSON value')
  return value
}
