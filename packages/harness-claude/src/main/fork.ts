import type {
  HarnessThreadForkRequest,
  HarnessThreadForkResult
} from '@openagent/contracts'
import { isJsonValue, type JsonObject } from '@openagent/contracts'
import {
  CLAUDE_STATE_LIMITS,
  parseClaudeThreadState,
  type ClaudeForkHistoryItem,
  type ClaudeTimelineItem,
  type ClaudeThreadState
} from '../shared/state.js'
import type { ClaudeThreadSettings } from '../shared/settings.js'

interface ClaudeForkRequest {
  readonly checkpointId?: string
}

/**
 * Derive a fresh Claude Plugin state without copying Core execution identity or
 * public history. The one-shot native intent is consumed by the first send.
 */
export function forkClaudeThread(
  input: HarnessThreadForkRequest<'claude', ClaudeThreadSettings>
): HarnessThreadForkResult<ClaudeThreadSettings> {
  input.signal.throwIfAborted()
  const source = parseClaudeThreadState(input.source.sessionState)
  if (!source.primarySessionId) {
    throw new Error('Claude source Thread 尚未绑定 Primary Native Session')
  }
  const request = parseClaudeForkRequest(input.request)
  if (
    request.checkpointId !== undefined &&
    !hasClaudeCheckpoint(source, request.checkpointId)
  ) {
    throw new Error(`Claude checkpoint 不属于 source Thread：${request.checkpointId}`)
  }
  input.signal.throwIfAborted()
  const pendingFork: JsonObject = {
    sourceSessionId: source.primarySessionId,
    ...(request.checkpointId === undefined
      ? {}
      : { checkpointId: request.checkpointId })
  }
  const items = forkHistoryItems(source, request.checkpointId)
  const forkHistory: JsonObject = {
    sourceSessionId: source.primarySessionId,
    ...(request.checkpointId === undefined
      ? {}
      : { checkpointId: request.checkpointId }),
    items
  }
  const sessionState: JsonObject = {
    version: 1,
    pendingFork,
    forkHistory,
    turns: [],
    nativeNotifications: []
  }
  return {
    sessionState,
    title: forkTitle(input.source.title)
  }
}

function forkHistoryItems(
  state: ClaudeThreadState,
  checkpointId: string | undefined
): JsonObject[] {
  const visible: ClaudeForkHistoryItem[] = []
  let checkpointFound = checkpointId === undefined
  for (const turn of state.turns) {
    let selectedTimeline = turn.timeline
    if (checkpointId !== undefined) {
      const checkpointIndex = turn.timeline.findIndex(
        (item) =>
          item.kind === 'user-message' &&
          item.checkpointId === checkpointId &&
          !(turn.internalPromptIndexes || []).includes(item.promptIndex)
      )
      if (checkpointIndex >= 0) {
        const assistantIndex = turn.timeline.findIndex(
          (item, index) => index > checkpointIndex && item.kind === 'assistant'
        )
        selectedTimeline = turn.timeline.slice(
          0,
          (assistantIndex >= 0 ? assistantIndex : checkpointIndex) + 1
        )
        checkpointFound = true
      } else if (checkpointFound) {
        break
      }
    }
    const internalPrompts = new Set(turn.internalPromptIndexes || [])
    const latestActivities = latestTimelineSnapshots(
      selectedTimeline,
      'activity',
      (item) => item.activity.id
    )
    const latestInteractions = latestTimelineSnapshots(
      selectedTimeline,
      'interaction',
      (item) => item.interaction.id
    )
    const emittedActivities = new Set<string>()
    const emittedInteractions = new Set<string>()
    const latestReplaceIndex = new Map<string, number>()
    selectedTimeline.forEach((item, index) => {
      if (isReplaceTimelineKind(item.kind)) latestReplaceIndex.set(item.kind, index)
    })
    for (const [timelineIndex, item] of selectedTimeline.entries()) {
      if (
        isReplaceTimelineKind(item.kind) &&
        latestReplaceIndex.get(item.kind) !== timelineIndex
      ) {
        continue
      }
      if (item.kind === 'user-message') {
        if (internalPrompts.has(item.promptIndex)) continue
        const content = turn.prompts[item.promptIndex]
        const attachments = turn.promptAttachments[item.promptIndex]
        if (content === undefined || attachments === undefined) {
          throw new Error('Claude source Thread 的 user-message timeline 引用无效')
        }
        visible.push({
          id: `fork-history:${String(visible.length)}`,
          kind: 'user-message',
          content,
          createdAt: item.createdAt,
          ...(attachments.length
            ? { attachments: attachments.map((attachment) => ({ ...attachment })) }
            : {}),
          ...(item.checkpointId ? { checkpointId: item.checkpointId } : {})
        })
      } else if (item.kind === 'assistant') {
        visible.push({
          id: `fork-history:${String(visible.length)}`,
          kind: 'assistant',
          content: item.content,
          createdAt: item.createdAt,
          status: item.status === 'streaming' ? 'cancelled' : item.status
        })
      } else if (item.kind === 'reasoning') {
        visible.push(historyItem(visible, item, { content: item.content }))
      } else if (item.kind === 'activity') {
        if (emittedActivities.has(item.activity.id)) continue
        emittedActivities.add(item.activity.id)
        const activity = latestActivities.get(item.activity.id)?.activity || item.activity
        visible.push(historyItem(visible, item, {
          activity: {
            kind: activity.kind,
            label: activity.label,
            status: activity.status === 'running' ? 'cancelled' : activity.status,
            ...(activity.detail === undefined ? {} : { detail: activity.detail })
          }
        }))
      } else if (item.kind === 'interaction') {
        if (emittedInteractions.has(item.interaction.id)) continue
        emittedInteractions.add(item.interaction.id)
        const interaction = latestInteractions.get(item.interaction.id)?.interaction ||
          item.interaction
        visible.push(historyItem(visible, item, {
          interaction: {
            kind: interaction.kind,
            title: interaction.title,
            ...(interaction.description === undefined
              ? {}
              : { description: interaction.description }),
            ...(interaction.toolName === undefined
              ? {}
              : { toolName: interaction.toolName }),
            ...(interaction.questions === undefined
              ? {}
              : { questions: structuredClone(interaction.questions) }),
            status: interaction.status === 'pending'
              ? 'cancelled'
              : interaction.status
          }
        }))
      } else if (item.kind === 'notice') {
        visible.push(historyItem(visible, item, {
          notice: { level: item.notice.level, message: item.notice.message }
        }))
      } else if (item.kind === 'plan') {
        visible.push(historyItem(visible, item, {
          plan: item.plan.map((step) => ({ ...step })),
          ...(item.explanation === undefined
            ? {}
            : { explanation: item.explanation })
        }))
      } else if (item.kind === 'error') {
        visible.push(historyItem(visible, item, { message: item.message }))
      } else if (item.kind === 'usage') {
        visible.push(historyItem(visible, item, { usage: { ...item.usage } }))
      } else if (item.kind === 'diff' || item.kind === 'review') {
        visible.push(historyItem(visible, item, { content: item.content }))
      } else if (item.kind === 'context-compaction') {
        visible.push(historyItem(visible, item, {}))
      }
    }
    if (checkpointId !== undefined && checkpointFound) break
  }
  if (!checkpointFound) {
    throw new Error(`Claude checkpoint 不属于 source Thread：${checkpointId}`)
  }
  if (visible.length > CLAUDE_STATE_LIMITS.forkHistoryMessages) {
    throw new Error('Claude source Thread 的可见 fork history 超限')
  }
  if (JSON.stringify(visible).length > CLAUDE_STATE_LIMITS.forkHistoryCharacters) {
    throw new Error('Claude source Thread 的可见 fork history 内容超限')
  }
  return visible.map((item): JsonObject => checkedHistoryJson(item))
}

function isReplaceTimelineKind(kind: ClaudeTimelineItem['kind']): boolean {
  return [
    'plan',
    'usage',
    'diff',
    'review'
  ].includes(kind)
}

function latestTimelineSnapshots<Kind extends 'activity' | 'interaction'>(
  timeline: readonly ClaudeTimelineItem[],
  kind: Kind,
  identity: (
    item: Extract<ClaudeTimelineItem, { kind: Kind }>
  ) => string
): Map<string, Extract<ClaudeTimelineItem, { kind: Kind }>> {
  const result = new Map<string, Extract<ClaudeTimelineItem, { kind: Kind }>>()
  for (const raw of timeline) {
    if (raw.kind !== kind) continue
    const item = raw as Extract<ClaudeTimelineItem, { kind: Kind }>
    result.set(identity(item), item)
  }
  return result
}

function historyItem(
  current: readonly ClaudeForkHistoryItem[],
  source: Exclude<ClaudeTimelineItem,
    { kind: 'user-message' } | { kind: 'assistant' }>,
  fields: JsonObject
): ClaudeForkHistoryItem {
  const value = {
    id: `fork-history:${String(current.length)}`,
    kind: source.kind,
    createdAt: source.createdAt,
    ...fields
  }
  if (!isJsonValue(value)) throw new Error('Claude fork history item 无效')
  return value as ClaudeForkHistoryItem
}

function checkedHistoryJson(item: ClaudeForkHistoryItem): JsonObject {
  if (!isJsonValue(item) || Array.isArray(item) || item === null) {
    throw new Error('Claude fork history item 不是 JSON object')
  }
  return structuredClone(item) as JsonObject
}

function parseClaudeForkRequest(value: unknown): ClaudeForkRequest {
  if (!isJsonObject(value)) throw new Error('Claude fork request 必须是 object')
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'checkpointId')) {
    throw new Error('Claude fork request 包含未知字段')
  }
  if (
    value.checkpointId !== undefined &&
    (typeof value.checkpointId !== 'string' ||
      !value.checkpointId.trim() ||
      value.checkpointId.length > 512)
  ) {
    throw new Error('Claude fork checkpointId 无效')
  }
  return value.checkpointId === undefined
    ? {}
    : { checkpointId: value.checkpointId }
}

function hasClaudeCheckpoint(
  state: ClaudeThreadState,
  checkpointId: string
): boolean {
  return state.turns.some((turn) => {
    const internalPrompts = new Set(turn.internalPromptIndexes || [])
    return turn.timeline.some(
      (item) =>
        item.kind === 'user-message' &&
        item.checkpointId === checkpointId &&
        !internalPrompts.has(item.promptIndex)
    )
  })
}

function forkTitle(sourceTitle: string): string {
  const normalized = sourceTitle.trim()
  if (!normalized) return 'Claude Fork'
  const suffix = ' (Fork)'
  const base = Array.from(normalized)
    .slice(0, 60 - Array.from(suffix).length)
    .join('')
  return `${base}${suffix}`
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
