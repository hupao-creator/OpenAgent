import {
  headPoints,
  MAX_BART_REPLY_EXCERPT_POINTS,
  readBartReplyTarget,
  type HarnessBartPresentation
} from '@openagent/contracts/renderer'
import type { JsonValue } from '@openagent/contracts'
import type { ClaudeThreadState, ClaudeTurn } from './state.js'

export function projectClaudeBartPresentation(
  state: ClaudeThreadState
): HarnessBartPresentation {
  return { activity: projectActivity(state), reply: projectReply(state) }
}

/**
 * Resolves the opaque target back to the first timeline row of that native
 * assistant message: the segments of one answer share its `messageId`, and only
 * the last of them renders as an answer row — the earlier ones live behind the
 * work disclosure — so the reader stops at the visible end of the answer. A
 * stale, foreign or malformed target resolves to nothing and the navigation
 * still opens the turn it was given.
 */
export function claudeBartReplyAnchor(
  state: ClaudeThreadState,
  message: JsonValue | undefined
): string | undefined {
  const target = readBartReplyTarget(message, ['executionId', 'messageId'] as const)
  if (!target) return undefined
  const turn = state.turns.find((entry) => entry.executionId === target.executionId)
  const item = turn?.timeline.findLast(
    (entry) => entry.kind === 'assistant' &&
      (entry.messageId ?? entry.id) === target.messageId
  )
  return item?.id
}

function projectActivity(state: ClaudeThreadState): HarnessBartPresentation['activity'] {
  const turn = state.turns.at(-1)
  if (turn === undefined || turn.status !== 'running' || turn.foreground === undefined) {
    return null
  }
  return { ...turn.foreground, executionId: turn.executionId }
}

function projectReply(state: ClaudeThreadState): HarnessBartPresentation['reply'] {
  for (let index = state.turns.length - 1; index >= 0; index -= 1) {
    const turn = state.turns[index] as ClaudeTurn
    if (turn.status !== 'completed') continue
    const message = turn.timeline.findLast(
      (item) => item.kind === 'assistant' && item.content.trim().length > 0
    )
    // A turn that never produced an answer is not a reminder of its own; an
    // earlier unread answer must not be hidden behind it.
    if (message?.kind !== 'assistant') continue
    // Same stable identity the retired Dock-message projection used: one
    // aggregate per native assistant message, id keyed by execution + message.
    const identity = message.messageId || message.id
    const content = message.messageId
      ? turn.timeline
          .flatMap((item) =>
            item.kind === 'assistant' && item.messageId === message.messageId
              ? [item.content]
              : []
          )
          .join('')
      : message.content
    return {
      id: JSON.stringify([turn.executionId, identity]),
      executionId: turn.executionId,
      excerpt: headPoints(content.trim(), MAX_BART_REPLY_EXCERPT_POINTS),
      target: { executionId: turn.executionId, messageId: identity }
    }
  }
  return null
}
