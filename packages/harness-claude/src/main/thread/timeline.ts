import { randomUUID } from 'node:crypto'
import {
  CLAUDE_STATE_LIMITS,
  type ClaudeActivity,
  type ClaudeActivityStatus,
  type ClaudeInteraction,
  type ClaudeNotice,
  type ClaudeTurn,
  type ClaudeUsage
} from '../../shared/state.js'
import { appendBounded, trimSet, truncate } from './values.js'

/** Native delta usage is cumulative per generation, so the visible total is a projection. */
export interface ClaudeUsageProjection {
  settled: ClaudeUsage | undefined
  pending: Map<string, ClaudeUsage>
}

export interface ClaudeUsageSample {
  /** Deduplication key derived from the native session and generation identity. */
  readonly key: string
  readonly usage: ClaudeUsage
  readonly usageKind: 'generation' | 'summary'
  /** Absent means settled, mirroring the optional native flag. */
  readonly provisional: boolean | undefined
}

export function nextClaudeTurnTimestamp(turn: ClaudeTurn): number {
  const at = Math.max(Date.now(), turn.updatedAt)
  turn.updatedAt = at
  return at
}

export function timelineItemId(kind: string, at: number, index: number): string {
  // The retained length stops increasing at the history limit. Settlement can
  // append several snapshots in the same millisecond even at that limit.
  return `tl:${at}:${index}:${kind}:${randomUUID()}`
}

export function appendTimelineUserMessage(
  turn: ClaudeTurn,
  promptIndex: number,
  at: number,
  checkpointId?: string
): void {
  appendTimelineItem(turn, {
    id: timelineItemId('user-message', at, turn.timeline.length),
    kind: 'user-message',
    createdAt: at,
    promptIndex,
    ...(checkpointId ? { checkpointId } : {})
  })
}

export function appendTimelineText(
  turn: ClaudeTurn,
  kind: 'assistant' | 'reasoning',
  delta: string,
  at: number,
  messageId?: string
): void {
  const sanitized = delta.replaceAll('\0', '')
  if (!sanitized) return
  const previous = turn.timeline.at(-1)
  if (previous?.kind === kind &&
      (previous.kind !== 'assistant' || previous.messageId === messageId)) {
    previous.content = appendBounded(
      previous.content,
      sanitized,
      kind === 'assistant'
        ? CLAUDE_STATE_LIMITS.textCharacters
        : CLAUDE_STATE_LIMITS.reasoningCharacters
    )
    if (kind === 'assistant' && previous.kind === 'assistant') {
      previous.status = 'streaming'
    }
  } else if (kind === 'assistant') {
    appendTimelineItem(turn, {
      id: timelineItemId(kind, at, turn.timeline.length),
      kind,
      createdAt: at,
      content: truncate(sanitized, CLAUDE_STATE_LIMITS.textCharacters),
      status: 'streaming',
      ...(messageId ? { messageId } : {})
    })
  } else {
    appendTimelineItem(turn, {
      id: timelineItemId(kind, at, turn.timeline.length),
      kind,
      createdAt: at,
      content: truncate(sanitized, CLAUDE_STATE_LIMITS.reasoningCharacters)
    })
  }
  trimTimelineContent(turn)
}

/** Commit the current entity and an immutable checkpoint-history snapshot together. */
export function recordClaudeActivity(
  turn: ClaudeTurn,
  activity: ClaudeActivity,
  at: number,
  snapshotId = timelineItemId('activity', at, turn.timeline.length)
): void {
  const index = turn.activities.findIndex(({ id }) => id === activity.id)
  if (index < 0) turn.activities.push(activity)
  else turn.activities[index] = activity
  appendTimelineItem(turn, {
    id: snapshotId,
    kind: 'activity',
    createdAt: at,
    activity: structuredClone(activity)
  })
  if (turn.activities.length > CLAUDE_STATE_LIMITS.activitiesPerTurn) {
    const removed = turn.activities.splice(
      0,
      turn.activities.length - CLAUDE_STATE_LIMITS.activitiesPerTurn
    )
    const removedIds = new Set(removed.map(({ id }) => id))
    turn.timeline = turn.timeline.filter(
      (item) => item.kind !== 'activity' || !removedIds.has(item.activity.id)
    )
  }
}

/** Current interaction state never comes from a timeline snapshot. */
export function recordClaudeInteraction(
  turn: ClaudeTurn,
  interaction: ClaudeInteraction,
  at: number,
  snapshotId = timelineItemId('interaction', at, turn.timeline.length)
): void {
  const index = turn.interactions.findIndex(({ id }) => id === interaction.id)
  if (index < 0) turn.interactions.push(interaction)
  else turn.interactions[index] = interaction
  appendTimelineItem(turn, {
    id: snapshotId,
    kind: 'interaction',
    createdAt: at,
    interaction: structuredClone(interaction)
  })
}

export function appendTimelinePlan(turn: ClaudeTurn, at: number): void {
  appendTimelineItem(turn, {
    id: timelineItemId('plan', at, turn.timeline.length),
    kind: 'plan',
    createdAt: at,
    plan: turn.plan.map((step) => ({ ...step })),
    ...(turn.planExplanation === undefined
      ? {}
      : { explanation: turn.planExplanation })
  })
}

export function appendTimelineError(turn: ClaudeTurn, message: string, at: number): void {
  const previous = turn.timeline.at(-1)
  if (previous?.kind === 'error' && previous.message === message) return
  appendTimelineItem(turn, {
    id: timelineItemId('error', at, turn.timeline.length),
    kind: 'error',
    createdAt: at,
    message
  })
}

export function appendTimelineUsage(turn: ClaudeTurn, at: number): void {
  if (!turn.usage) return
  appendTimelineItem(turn, {
    id: timelineItemId('usage', at, turn.timeline.length),
    kind: 'usage',
    createdAt: at,
    usage: { ...turn.usage }
  })
}

export function appendTurnNotice(turn: ClaudeTurn, notice: ClaudeNotice, at: number): void {
  turn.notices.push(notice)
  appendTimelineItem(turn, {
    id: timelineItemId('notice', at, turn.timeline.length),
    kind: 'notice',
    createdAt: at,
    notice: { ...notice }
  })
  if (turn.notices.length <= CLAUDE_STATE_LIMITS.noticesPerTurn) return
  const removed = turn.notices.shift()
  if (!removed) return
  turn.timeline = turn.timeline.filter(
    (item) => item.kind !== 'notice' || item.notice.id !== removed.id
  )
}

export function turnNoticeId(turn: ClaudeTurn, at: number): string {
  return `notice:${at}:${turn.notices.length}`
}

export function appendTimelineItem(
  turn: ClaudeTurn,
  item: ClaudeTurn['timeline'][number]
): void {
  turn.timeline.push(item)
  if (turn.timeline.length > CLAUDE_STATE_LIMITS.timelineItemsPerTurn) {
    turn.timeline.splice(
      0,
      turn.timeline.length - CLAUDE_STATE_LIMITS.timelineItemsPerTurn
    )
  }
}

function trimTimelineContent(turn: ClaudeTurn): void {
  const textItems = turn.timeline.filter(
    (item) => item.kind === 'assistant' || item.kind === 'reasoning'
  )
  let overflow = textItems.reduce((total, item) => total + item.content.length, 0) -
    CLAUDE_STATE_LIMITS.timelineContentCharacters
  for (const item of textItems) {
    if (overflow <= 0) break
    const removed = Math.min(overflow, item.content.length)
    item.content = item.content.slice(removed)
    overflow -= removed
  }
}

export function settleClaudeTurn(
  turn: ClaudeTurn,
  outcome: 'completed' | 'failed' | 'interrupted',
  backgroundTaskIds: ReadonlySet<string> = new Set(),
  finishedAt = turn.updatedAt
): void {
  if (turn.finishedAt !== undefined) return
  turn.finishedAt = finishedAt
  turn.status = outcome
  turn.statusLabel = undefined
  const activityStatus: ClaudeActivityStatus = outcome === 'completed'
    ? 'completed'
    : outcome === 'failed'
      ? 'failed'
      : 'cancelled'
  for (const [index, activity] of turn.activities.entries()) {
    if (activity.status === 'running' &&
        !backgroundTaskIds.has(activity.taskId || activity.id)) {
      recordClaudeActivity(turn, { ...activity, status: activityStatus }, turn.updatedAt,
        `settled:${finishedAt}:activity:${index}`)
    }
  }
  for (const [index, interaction] of turn.interactions.entries()) {
    if (interaction.status === 'pending') {
      recordClaudeInteraction(turn, { ...interaction, status: 'cancelled' }, turn.updatedAt,
        `settled:${finishedAt}:interaction:${index}`)
    }
  }
  for (const item of turn.timeline) {
    if (item.kind !== 'assistant' || item.status !== 'streaming') continue
    item.status = outcome === 'completed'
      ? 'complete'
      : outcome === 'failed'
        ? 'failed'
        : 'cancelled'
  }
}

export function mergeClaudeTurnUsage(
  current: ClaudeUsage | undefined,
  next: ClaudeUsage,
  kind: 'generation' | 'summary'
): ClaudeUsage {
  const merged: ClaudeUsage = { ...current }
  const additive: ReadonlyArray<keyof ClaudeUsage> = kind === 'generation'
    ? [
        'inputTokens',
        'outputTokens',
        'reasoningTokens',
        'cachedTokens',
        'cacheWriteTokens',
        'totalTokens',
        'contextTokens'
      ]
    : ['costUsd']
  for (const key of additive) {
    const value = next[key]
    if (value !== undefined) merged[key] = (merged[key] || 0) + value
  }
  if (next.contextWindow !== undefined) merged.contextWindow = next.contextWindow
  return merged
}

/**
 * Folds one native usage sample into the turn's visible total. Returns whether
 * the sample is a newly recorded generation — the caller's signal to publish a
 * telemetry ledger entry. Deduplication, the provisional/settled split and the
 * in-flight projection are the executable accounting contract; keeping them
 * here rather than in the controller makes them drivable in isolation.
 */
export function applyClaudeUsageSample(
  turn: ClaudeTurn,
  recorded: Set<string>,
  projection: ClaudeUsageProjection,
  sample: ClaudeUsageSample,
  at: number
): boolean {
  if (recorded.has(sample.key)) return false
  if (sample.provisional) {
    projection.pending.set(sample.key, sample.usage)
  } else {
    projection.pending.delete(sample.key)
    projection.settled = mergeClaudeTurnUsage(projection.settled, sample.usage, sample.usageKind)
  }
  // Rebuild the visible total from settled usage plus the latest snapshot of
  // each in-flight generation; native deltas are cumulative, not additive.
  turn.usage = [...projection.pending.values()].reduce(
    (total, usage) => mergeClaudeTurnUsage(total, usage, 'generation'),
    { ...projection.settled }
  )
  if (sample.provisional) return false
  recorded.add(sample.key)
  trimSet(recorded, 4_096)
  appendTimelineUsage(turn, at)
  return true
}
