import type { HarnessSessionStateAdapter, ThreadPublicObservation } from '@openagent/contracts'
import {
  currentClaudeTurn,
  summarizeClaudeState,
  type ClaudeThreadState
} from '../../shared/state.js'
import { toPublicClaudeInteraction } from '../../shared/public-interactions.js'
import { decodeClaudeMainState, encodeClaudeThreadState, nativeTaskActivityStatus } from './state.js'
import { settleClaudeTurn } from './timeline.js'

/** Reconstruct the public view exclusively from the persisted Session. */
export function claudeObservation(state: ClaudeThreadState): ThreadPublicObservation {
  const backgroundWork = claudeHasRunningBackgroundWork(state)
    ? { status: 'running' as const }
    : null
  const turn = currentClaudeTurn(state)
  if (!turn) return { latestExecution: null, backgroundWork }
  const summary = summarizeClaudeState(state, 2_000)
  const execution = {
    executionId: turn.executionId,
    startedAt: turn.createdAt,
    ...(summary ? { summary } : {})
  }
  if (turn.status !== 'running') {
    // The parser requires a terminal timestamp; background updates may change
    // updatedAt but never rewrite this execution's completion time.
    return {
      latestExecution: {
        ...execution,
        status: turn.status,
        finishedAt: turn.finishedAt!,
        ...(turn.status === 'failed' && turn.error ? { error: turn.error } : {})
      },
      backgroundWork
    }
  }
  const interactions = turn.interactions
    .filter(interaction => interaction.status === 'pending')
    .map(interaction => toPublicClaudeInteraction(turn.executionId, interaction))
  return {
    latestExecution: interactions.length > 0
      ? { ...execution, status: 'waiting-for-user', interactions }
      : { ...execution, status: 'running' },
    backgroundWork
  }
}

export const claudeSessionStateAdapter: HarnessSessionStateAdapter = {
  resolveExecution(value, executionId) {
    if (value === null) return null
    const state = decodeClaudeMainState(value)
    const turn = state.turns.find(candidate => candidate.executionId === executionId)
    return turn ? claudeObservation({ ...state, turns: [turn] }).latestExecution : null
  },
  project: value => claudeObservation(decodeClaudeMainState(value)),
  settle(input) {
    const state = decodeClaudeMainState(input.sessionState)
    const turn = state.turns.findLast(candidate => candidate.executionId === input.executionId)
    if (turn?.status === 'running') {
      turn.updatedAt = Math.max(turn.updatedAt, input.finishedAt)
      settleClaudeTurn(turn, input.outcome, new Set(
        state.runtime?.backgroundTasks?.filter(
          task => nativeTaskActivityStatus(task.status) === 'running'
        ).map(task => task.id) || []
      ), Math.max(turn.createdAt, input.finishedAt))
    }
    return encodeClaudeThreadState(state)
  }
}

export function claudeHasRunningBackgroundWork(state: ClaudeThreadState): boolean {
  return state.runtime?.backgroundTasks?.some(
    task => nativeTaskActivityStatus(task.status) === 'running'
  ) === true
}
