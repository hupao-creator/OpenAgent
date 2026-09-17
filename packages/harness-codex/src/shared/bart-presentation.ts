import {
  headPoints,
  MAX_BART_REPLY_EXCERPT_POINTS,
  readBartReplyTarget,
  type HarnessBartPresentation
} from '@openagent/contracts/renderer'
import type { JsonValue } from '@openagent/contracts'
import type { CodexHarnessState, CodexTurn } from './types.js'

export function projectCodexBartPresentation(
  state: CodexHarnessState
): HarnessBartPresentation {
  return { activity: projectActivity(state), reply: projectReply(state) }
}

/**
 * Resolves the opaque target this Plugin produced back to the timeline row the
 * reader should stop at. A stale, foreign or malformed target resolves to
 * nothing, so the navigation still opens the turn it was given.
 */
export function codexBartReplyAnchor(
  state: CodexHarnessState,
  message: JsonValue | undefined
): string | undefined {
  const target = readBartReplyTarget(message, ['executionId', 'itemId'] as const)
  if (!target) return undefined
  const turn = state.turns.find((entry) => entry.executionId === target.executionId)
  const item = turn?.timeline.find(
    (entry) => entry.kind === 'assistant' && entry.itemId === target.itemId
  )
  return item?.id
}

function projectActivity(state: CodexHarnessState): HarnessBartPresentation['activity'] {
  const turn = state.turns.at(-1)
  if (turn === undefined || turn.status !== 'running' || turn.foreground === undefined) {
    return null
  }
  return { ...turn.foreground, executionId: turn.executionId }
}

function projectReply(state: CodexHarnessState): HarnessBartPresentation['reply'] {
  for (let index = state.turns.length - 1; index >= 0; index -= 1) {
    const turn = state.turns[index] as CodexTurn
    if (turn.status !== 'completed') continue
    const message = turn.timeline.findLast(
      (item) => item.kind === 'assistant' && item.content.trim().length > 0
    )
    // A turn that never produced an answer is not a reminder of its own; an
    // earlier unread answer must not be hidden behind it.
    if (message?.kind !== 'assistant') continue
    return {
      id: JSON.stringify([turn.executionId, message.id]),
      executionId: turn.executionId,
      excerpt: headPoints(message.content.trim(), MAX_BART_REPLY_EXCERPT_POINTS),
      target: { executionId: turn.executionId, itemId: message.itemId }
    }
  }
  return null
}
