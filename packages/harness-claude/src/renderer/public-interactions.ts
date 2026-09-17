import type { PublicInteraction, ThreadPublicObservation } from '@openagent/contracts'
import { bindPublicInteractions, EMPTY_PUBLIC_INTERACTIONS } from '@openagent/plugin-kit/shared'
import type { ClaudeThreadState } from '../shared/state.js'
import { toPublicClaudeInteraction } from '../shared/public-interactions.js'

export function claudePublicInteractionsByNativeId(
  state: ClaudeThreadState,
  observation: ThreadPublicObservation
): ReadonlyMap<string, PublicInteraction> {
  const execution = observation.latestExecution
  if (execution?.status !== 'waiting-for-user') return EMPTY_PUBLIC_INTERACTIONS
  const turn = state.turns.findLast(candidate => candidate.executionId === execution.executionId)
  if (!turn) return EMPTY_PUBLIC_INTERACTIONS
  return bindPublicInteractions(
    turn.interactions.filter(interaction => interaction.status === 'pending'),
    execution.interactions,
    interaction => toPublicClaudeInteraction(turn.executionId, interaction)
  )
}
