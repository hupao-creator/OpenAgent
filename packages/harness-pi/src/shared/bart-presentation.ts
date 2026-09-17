import {
  headPoints,
  MAX_BART_REPLY_EXCERPT_POINTS,
  readBartReplyTarget,
  type HarnessBartPresentation
} from '@openagent/contracts/renderer'
import type { JsonValue } from '@openagent/contracts'
import type { PiSessionState } from './types.js'

export function projectPiBartPresentation(state: PiSessionState): HarnessBartPresentation {
  return { activity: projectActivity(state), reply: projectReply(state) }
}

/**
 * Resolves the opaque target back to the message row the reader should stop at.
 * A stale, foreign or malformed target resolves to nothing, so the navigation
 * still opens the execution it was given.
 */
export function piBartReplyAnchor(
  state: PiSessionState,
  message: JsonValue | undefined
): string | undefined {
  const target = readBartReplyTarget(message, ['executionId', 'messageId'] as const)
  if (!target) return undefined
  const found = state.messages.some((entry) =>
    entry.id === target.messageId &&
    entry.executionId === target.executionId &&
    entry.role === 'assistant'
  )
  return found ? target.messageId : undefined
}

function projectActivity(state: PiSessionState): HarnessBartPresentation['activity'] {
  const executionId = state.latestExecutionId
  if (executionId === null) return null
  const execution = state.executions.find((entry) => entry.executionId === executionId)
  if (execution?.status !== 'running') return null
  const foreground = state.foregrounds?.find(
    (entry) => entry.executionId === executionId
  )?.foreground
  if (foreground === undefined) return null
  return { ...foreground, executionId }
}

function projectReply(state: PiSessionState): HarnessBartPresentation['reply'] {
  for (let index = state.executions.length - 1; index >= 0; index -= 1) {
    const execution = state.executions[index]!
    if (execution.status !== 'completed') continue
    const message = state.messages.findLast(
      (entry) =>
        entry.executionId === execution.executionId &&
        entry.role === 'assistant' &&
        entry.text.trim().length > 0
    )
    // An execution that never produced an answer is not a reminder of its own;
    // an earlier unread answer must not be hidden behind it.
    if (message === undefined) continue
    return {
      id: JSON.stringify([execution.executionId, message.id]),
      executionId: execution.executionId,
      excerpt: headPoints(message.text.trim(), MAX_BART_REPLY_EXCERPT_POINTS),
      target: { executionId: execution.executionId, messageId: message.id }
    }
  }
  return null
}
