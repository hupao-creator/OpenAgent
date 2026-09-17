import type { AgentInput } from '@openagent/contracts'
import { isJsonValue } from '@openagent/contracts'
import {
  advanceBartForeground,
  advanceBartReasoning,
  headPoints,
  MAX_BART_TOOL_NAME_POINTS,
  type HarnessBartForeground
} from '@openagent/contracts/renderer'
import { joinCodexAssistantTexts } from './assistant-text.js'
import { isCodexAgentMessageId } from './native-identity.js'
import type {
  CodexActivity,
  CodexAttachment,
  CodexBackgroundTerminal,
  CodexHarnessState,
  CodexInteraction,
  CodexMessage,
  CodexNativeActivity,
  CodexNativeEvent,
  CodexPlanStep,
  CodexTimelineItem,
  CodexTimelineTextStatus,
  CodexTurn,
  CodexUsage
} from './types.js'

export const CODEX_THREAD_STATE_SCHEMA = 'openagent.harness.codex.thread.v1' as const

const MAX_TURNS = 200
const MAX_BACKGROUND_TERMINALS = 2_000
const MAX_ANSWER = 256 * 1024
const MAX_REASONING = 64 * 1024
const MAX_DETAIL = 32 * 1024
const MAX_NOTICE = 16 * 1024
const MAX_PERSISTED_TEXT = 8 * 1024 * 1024
const MAX_TOOL_NAME = 1_024

export function createEmptyCodexState(at = 0): CodexHarnessState {
  return {
    schema: CODEX_THREAD_STATE_SCHEMA,
    updatedAt: at,
    backgroundTerminals: [],
    turns: []
  }
}

export function decodeCodexState(value: unknown): CodexHarnessState {
  if (!isCodexState(value)) throw new Error('Codex sessionState 无效')
  return structuredClone(value)
}

/** Check native interaction admission against the same shape accepted on load. */
export function assertCodexInteraction(value: unknown): asserts value is CodexInteraction {
  if (!isInteraction(value)) throw new Error('Codex interaction 无效')
}

export function bindCodexPrimarySession(
  state: CodexHarnessState,
  sessionId: string,
  at: number
): CodexHarnessState {
  const nativeId = canonicalString(sessionId, 1_024)
  if (!nativeId) throw new Error('Codex Primary Native Session ID 无效')
  if (state.primarySessionId && state.primarySessionId !== nativeId) {
    throw new Error('Codex Thread 已绑定另一 Primary Native Session')
  }
  if (state.primarySessionId === nativeId) return state
  return { ...state, primarySessionId: nativeId, updatedAt: nextAt(state, at) }
}

export function stageCodexExecution(
  state: CodexHarnessState,
  executionId: string,
  input: AgentInput,
  at: number,
  messageId: string
): CodexHarnessState {
  if (state.turns.some((turn) => activeTurnStatus(turn.status))) {
    throw new Error('Codex Thread 已有 active Execution')
  }
  const timestamp = nextAt(state, at)
  const turn: CodexTurn = {
    executionId,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'running',
    statusLabel: '正在连接 Codex',
    messages: [messageFromInput(input, messageId, 'prompt', timestamp)],
    timeline: [{
      id: `tl:${timestamp}:user-message:0`,
      kind: 'user-message',
      createdAt: timestamp,
      messageId
    }],
    answer: '',
    reasoning: '',
    plan: [],
    activities: [],
    interactions: [],
    notices: []
  }
  return {
    ...state,
    updatedAt: timestamp,
    turns: [...state.turns, turn].slice(-MAX_TURNS)
  }
}

export function appendCodexFollowUp(
  state: CodexHarnessState,
  executionId: string,
  input: AgentInput,
  at: number,
  messageId: string
): CodexHarnessState {
  const timestamp = nextAt(state, at)
  return mapActiveTurn(state, executionId, timestamp, (turn) => ({
    ...turn,
    updatedAt: timestamp,
    statusLabel: '已追加指令',
    messages: [
      ...turn.messages,
      messageFromInput(input, messageId, 'follow-up', timestamp)
    ],
    timeline: appendTimelineReference(
      turn.timeline,
      'user-message',
      messageId,
      timestamp
    )
  }))
}

export function rejectCodexFollowUp(
  state: CodexHarnessState,
  executionId: string,
  message: string,
  at: number,
  noticeId: string
): CodexHarnessState {
  const timestamp = nextAt(state, at)
  return mapActiveTurn(state, executionId, timestamp, (turn) => ({
    ...turn,
    updatedAt: timestamp,
    notices: [
      ...turn.notices,
      { id: noticeId, level: 'error', message: tail(message, MAX_NOTICE) }
    ],
    timeline: appendTimelineReference(turn.timeline, 'notice', noticeId, timestamp)
  }))
}

export function reduceCodexEvent(
  state: CodexHarnessState,
  executionId: string,
  event: CodexNativeEvent,
  at: number,
  generatedId: string
): CodexHarnessState {
  if (event.type === 'session') return bindCodexPrimarySession(state, event.sessionId, at)
  const timestamp = nextAt(state, at)
  return mapActiveTurn(state, executionId, timestamp, (turn) => {
    switch (event.type) {
      case 'status':
        return optional({ ...turn, updatedAt: timestamp }, 'statusLabel', event.label)
      case 'runtime-model':
        return { ...turn, updatedAt: timestamp, runtimeModel: event.model }
      case 'text-delta': {
        const timeline = appendTimelineTextDelta(
          turn.timeline, event.itemId, event.delta, timestamp
        )
        return {
          ...turn,
          updatedAt: timestamp,
          answer: timelineAnswer(timeline),
          timeline,
          // A delta the settled item refused leaves the answer untouched, so it
          // must not claim Bart's body either.
          ...(event.delta.length === 0 || timeline === turn.timeline
            ? {}
            : { foreground: advanceBartForeground(turn.foreground, { kind: 'assistant-text' }) })
        }
      }
      case 'text-final': {
        const timeline = finalizeTimelineText(
          turn.timeline, event.itemId, event.text, timestamp
        )
        return {
          ...turn,
          updatedAt: timestamp,
          answer: timelineAnswer(timeline),
          timeline
        }
      }
      case 'reasoning-delta': {
        const timeline = appendTimelineReasoningDelta(turn.timeline, event.delta, timestamp)
        return {
          ...turn,
          updatedAt: timestamp,
          reasoning: tail(turn.reasoning + event.delta, MAX_REASONING),
          timeline,
          ...(event.delta.length === 0
            ? {}
            : {
                // The break a delta ends is spent by that delta; an empty one
                // carries no reasoning and leaves it standing.
                ...(turn.reasoningBreak ? { reasoningBreak: false } : {}),
                foreground: advanceBartReasoning(
                  turn.foreground,
                  event.delta,
                  // The timeline grows when something landed after the previous
                  // reasoning item, and a marker the timeline deduped landed
                  // all the same. Either way the delta opens a new segment
                  // instead of extending what was showing.
                  timeline.length === turn.timeline.length && turn.reasoningBreak !== true
                )
              })
        }
      }
      case 'plan': {
        const { planExplanation: _previousExplanation, ...withoutExplanation } = turn
        return optional(
          {
            ...withoutExplanation,
            updatedAt: timestamp,
            plan: event.steps.slice(0, 200),
            reasoningBreak: true,
            timeline: appendTimelineMarker(turn.timeline, 'plan', timestamp)
          },
          'planExplanation',
          event.explanation ? tail(event.explanation, MAX_DETAIL) : undefined
        )
      }
      case 'diff':
        return {
          ...turn,
          updatedAt: timestamp,
          diff: tail(event.diff, MAX_ANSWER),
          reasoningBreak: true,
          timeline: appendTimelineMarker(turn.timeline, 'diff', timestamp)
        }
      case 'review':
        return {
          ...turn,
          updatedAt: timestamp,
          review: tail(event.review, MAX_ANSWER),
          reasoningBreak: true,
          timeline: appendTimelineMarker(turn.timeline, 'review', timestamp)
        }
      case 'context-compacted':
        return {
          ...turn,
          updatedAt: timestamp,
          contextCompacted: true,
          timeline: appendTimelineMarker(
            turn.timeline,
            'context-compaction',
            timestamp,
            true
          )
        }
      case 'activity-start': {
        const exists = turn.activities.some((activity) => activity.id === event.activity.id)
        const activity: CodexActivity = {
          id: event.activity.id,
          kind: event.activity.kind,
          label: tail(event.activity.label, MAX_DETAIL),
          status: exists
            ? turn.activities.find((candidate) => candidate.id === event.activity.id)!.status
            : 'running',
          ...(event.activity.kind !== 'tool' || event.activity.toolName === undefined
            ? {}
            : { toolName: tail(event.activity.toolName, MAX_TOOL_NAME) })
        }
        const toolName =
          event.activity.kind === 'tool' ? event.activity.toolName : undefined
        return {
          ...turn,
          updatedAt: timestamp,
          activities: upsertActivity(turn.activities, activity),
          timeline: exists
            ? turn.timeline
            : appendTimelineReference(
                turn.timeline,
                'activity',
                event.activity.id,
                timestamp
              ),
          // A replay of a call the turn already knows — a parser re-reading its
          // own timeline — is not a new semantic event, so it must not reclaim
          // the foreground from whatever ran since.
          ...(toolName === undefined || exists
            ? {}
            : {
                foreground: advanceBartForeground(turn.foreground, {
                  kind: 'tool-call',
                  callId: event.activity.id,
                  toolName: headPoints(toolName, MAX_BART_TOOL_NAME_POINTS)
                })
              })
        }
      }
      case 'activity-update':
        // Native progress mixes raw tool input with user-visible progress.
        // Historical Codex surfaces persisted only terminal command output.
        return { ...turn, updatedAt: timestamp }
      case 'activity-end':
        return {
          ...turn,
          updatedAt: timestamp,
          activities: turn.activities.map((activity) =>
            activity.id === event.activityId
              ? (() => {
                  const { detail: _detail, ...withoutDetail } = activity
                  return optional(
                    { ...withoutDetail, status: event.status },
                    'detail',
                    activity.kind === 'command' && event.detail
                      ? tail(event.detail, MAX_DETAIL)
                      : undefined
                  )
                })()
              : activity
          )
        }
      case 'interaction-opened':
        return {
          ...turn,
          updatedAt: timestamp,
          ...(event.interaction.blocksTurn
            ? { status: 'waiting-input' as const, statusLabel: '等待你的输入' }
            : {}),
          interactions: upsertInteraction(turn.interactions, event.interaction),
          timeline: turn.interactions.some(
            (interaction) => interaction.id === event.interaction.id
          )
            ? turn.timeline
            : appendTimelineReference(
                turn.timeline,
                'interaction',
                event.interaction.id,
                timestamp
              )
        }
      case 'interaction-closed':
        return (() => {
          const interactions = turn.interactions.map((interaction) =>
            interaction.id === event.interactionId
              ? {
                  ...interaction,
                  status: interactionStatus(event.resolution),
                  resolution: tail(event.resolution, 1_000)
                }
              : interaction
          )
          const waiting = interactions.some(
            (interaction) => interaction.status === 'pending' && interaction.blocksTurn
          )
          return {
          ...turn,
          updatedAt: timestamp,
            ...(turn.status === 'waiting-input'
              ? {
                  status: waiting ? 'waiting-input' as const : 'running' as const,
                  statusLabel: waiting ? '等待你的输入' : '正在工作'
                }
              : {}),
            interactions
          }
        })()
      case 'usage':
        return { ...turn, updatedAt: timestamp, usage: event.usage }
      case 'generation-usage':
        // This telemetry-only event is consumed by the Thread controller and
        // must never enter Plugin persistence or the public observation.
        return turn
      case 'warning':
        return {
          ...turn,
          updatedAt: timestamp,
          notices: [
            ...turn.notices,
            { id: generatedId, level: 'warning', message: tail(event.message, MAX_NOTICE) }
          ],
          timeline: appendTimelineReference(turn.timeline, 'notice', generatedId, timestamp)
        }
      case 'error':
        return {
          ...turn,
          updatedAt: timestamp,
          error: tail(event.message, MAX_NOTICE),
          notices: [
            ...turn.notices,
            { id: generatedId, level: 'error', message: tail(event.message, MAX_NOTICE) }
          ],
          timeline: appendTimelineMarker(
            appendTimelineReference(turn.timeline, 'notice', generatedId, timestamp),
            'error',
            timestamp
          )
        }
      case 'done':
        return {
          ...turn,
          updatedAt: timestamp,
          finishedAt: Math.max(turn.createdAt, Math.trunc(at)),
          status: event.outcome,
          timeline: settleTimelineText(
            turn.timeline,
            event.outcome === 'completed'
              ? 'complete'
              : event.outcome === 'failed'
                ? 'failed'
                : 'cancelled'
          ),
          interactions: turn.interactions.map((interaction) =>
            interaction.status === 'pending'
              ? { ...interaction, status: 'cancelled' as const }
              : interaction
          ),
          ...('statusLabel' in turn ? { statusLabel: terminalLabel(event.outcome) } : {})
        }
    }
  })
}

export function settleCodexExecution(
  state: CodexHarnessState,
  executionId: string,
  outcome: 'completed' | 'failed' | 'interrupted',
  at: number,
  error?: string
): CodexHarnessState {
  const timestamp = nextAt(state, at)
  const backgroundActivityIds = new Set(
    state.backgroundTerminals.map((terminal) => terminal.id)
  )
  const settled = mapActiveTurn(state, executionId, timestamp, (turn) => {
    const { error: previousError, ...rest } = turn
    const terminalError = error || previousError
    return {
      ...rest,
      updatedAt: timestamp,
      finishedAt: Math.max(turn.createdAt, Math.trunc(at)),
      status: outcome,
      statusLabel: terminalLabel(outcome),
      timeline: settleTimelineText(
        turn.timeline,
        outcome === 'completed' ? 'complete' : outcome === 'failed' ? 'failed' : 'cancelled'
      ),
      activities: turn.activities.map((activity) =>
        activity.status === 'running' && !backgroundActivityIds.has(activity.id)
          ? {
              ...activity,
              status: outcome === 'failed' ? 'failed' as const : 'cancelled' as const
            }
          : activity
      ),
      interactions: turn.interactions.map((interaction) =>
        interaction.status === 'pending'
          ? { ...interaction, status: 'cancelled' as const }
          : interaction
      ),
      ...(outcome === 'failed' && terminalError
        ? { error: tail(terminalError, MAX_NOTICE) }
        : {})
    }
  })
  // A retry must not clear Session status received after this terminal fact.
  if (!settled.nativeActivity || settled.nativeActivity.updatedAt > at) return settled
  const { nativeActivity: _nativeActivity, ...withoutNativeActivity } = settled
  return withoutNativeActivity
}

export function settleCodexOrphanedExecutions(
  state: CodexHarnessState,
  at: number,
  error: string
): CodexHarnessState {
  let next = state
  for (const turn of state.turns) {
    if (!activeTurnStatus(turn.status)) continue
    next = settleCodexExecution(next, turn.executionId, 'interrupted', at, error)
  }
  return next
}

export function updateCodexNativeActivity(
  state: CodexHarnessState,
  status: string,
  detail: string | undefined,
  at: number
): CodexHarnessState {
  const timestamp = nextAt(state, at)
  return {
    ...state,
    updatedAt: timestamp,
    nativeActivity: optional(
      { status: tail(status, 256), updatedAt: timestamp },
      'detail',
      detail ? tail(detail, MAX_DETAIL) : undefined
    )
  }
}

export function clearCodexNativeActivity(
  state: CodexHarnessState,
  at: number
): CodexHarnessState {
  if (!state.nativeActivity) return state
  const { nativeActivity: _nativeActivity, ...withoutNativeActivity } = state
  return {
    ...withoutNativeActivity,
    updatedAt: nextAt(state, at)
  }
}

export function updateCodexBackgroundTerminals(
  state: CodexHarnessState,
  terminals: readonly CodexBackgroundTerminal[],
  at: number
): CodexHarnessState {
  const timestamp = nextAt(state, at)
  return {
    ...state,
    updatedAt: timestamp,
    backgroundTerminals: terminals.map((terminal) => ({ ...terminal }))
  }
}

export function completeCodexBackgroundActivity(
  state: CodexHarnessState,
  activityId: string,
  status: 'completed' | 'failed' | 'cancelled',
  detail: string | undefined,
  at: number
): CodexHarnessState {
  const turnIndex = state.turns.findLastIndex(turn =>
    turn.activities.some(activity => activity.id === activityId &&
      (activity.status === 'running' || activity.status === 'cancelled'))
  )
  if (turnIndex < 0) return state
  const timestamp = nextAt(state, at)
  return {
    ...state,
    updatedAt: timestamp,
    turns: state.turns.map((turn, index) => index === turnIndex
      ? {
          ...turn,
          updatedAt: timestamp,
          activities: turn.activities.map(activity => activity.id === activityId
            ? {
                ...activity,
                status,
                ...(detail ? { detail: tail(detail, MAX_DETAIL) } : {})
              }
            : activity)
        }
      : turn)
  }
}

/** Native terminal liveness is process-local and cannot survive a desktop restart. */
export function retireCodexBackgroundTerminals(
  state: CodexHarnessState,
  at: number
): CodexHarnessState {
  if (!state.backgroundTerminals.length && !state.turns.some(turn =>
    turn.status !== 'running' && turn.status !== 'waiting-input' &&
    turn.activities.some(activity => activity.status === 'running')
  )) return state
  const timestamp = nextAt(state, at)
  return {
    ...state,
    updatedAt: timestamp,
    backgroundTerminals: [],
    turns: state.turns.map(turn =>
      turn.status === 'running' || turn.status === 'waiting-input'
        ? turn
        : {
            ...turn,
            activities: turn.activities.map(activity =>
              activity.status === 'running'
                ? { ...activity, status: 'cancelled' as const }
                : activity)
          })
  }
}

export function latestCodexTurn(state: CodexHarnessState): CodexTurn | undefined {
  return state.turns.at(-1)
}

export function isCodexState(value: unknown): value is CodexHarnessState {
  if (!isRecord(value) || !isJsonValue(value) ||
    value.schema !== CODEX_THREAD_STATE_SCHEMA ||
    !hasOnlyKeys(value, [
      'schema',
      'primarySessionId',
      'nativeToolConfiguration',
      'nativeToolMode',
      'nativeHistorySeed',
      'updatedAt',
      'nativeActivity',
      'backgroundTerminals',
      'turns'
    ]) ||
    !finiteTimestamp(value.updatedAt) ||
    !Array.isArray(value.turns) ||
    !Array.isArray(value.backgroundTerminals) ||
    value.backgroundTerminals.length > MAX_BACKGROUND_TERMINALS ||
    !value.backgroundTerminals.every(isBackgroundTerminal)) return false
  if (value.primarySessionId !== undefined && !canonicalString(value.primarySessionId, 1_024)) {
    return false
  }
  if (value.nativeToolConfiguration !== undefined &&
    (typeof value.nativeToolConfiguration !== 'string' || !/^[a-f0-9]{64}$/.test(value.nativeToolConfiguration))) return false
  if (value.nativeToolMode !== undefined && value.nativeToolMode !== 'extend' && value.nativeToolMode !== 'exclusive') return false
  if (value.nativeHistorySeed !== undefined && !boundedString(value.nativeHistorySeed, MAX_PERSISTED_TEXT)) return false
  const stateUpdatedAt = value.updatedAt
  if (value.nativeActivity !== undefined &&
    !isNativeActivity(value.nativeActivity, stateUpdatedAt)) return false
  return value.turns.length <= MAX_TURNS &&
    value.turns.every((turn) => isTurn(turn, stateUpdatedAt))
}

function isBackgroundTerminal(value: unknown): value is CodexBackgroundTerminal {
  return isRecord(value) &&
    hasOnlyKeys(value, ['id', 'command', 'cwd']) &&
    Boolean(canonicalString(value.id, 1_024)) &&
    boundedString(value.command, MAX_DETAIL) &&
    boundedString(value.cwd, MAX_DETAIL)
}

function isNativeActivity(
  value: unknown,
  stateUpdatedAt: number
): value is CodexNativeActivity {
  return isRecord(value) &&
    hasOnlyKeys(value, ['status', 'detail', 'updatedAt']) &&
    boundedString(value.status, 256) &&
    (value.detail === undefined || boundedString(value.detail, MAX_DETAIL)) &&
    finiteTimestamp(value.updatedAt) &&
    value.updatedAt <= stateUpdatedAt
}

function isTurn(value: unknown, stateUpdatedAt: number): value is CodexTurn {
  if (!isRecord(value)) return false
  if (!hasOnlyKeys(value, [
    'executionId',
    'createdAt',
    'updatedAt',
    'finishedAt',
    'status',
    'statusLabel',
    'foreground',
    'reasoningBreak',
    'runtimeModel',
    'messages',
    'timeline',
    'answer',
    'reasoning',
    'plan',
    'planExplanation',
    'activities',
    'interactions',
    'notices',
    'usage',
    'diff',
    'review',
    'contextCompacted',
    'error'
  ]) ||
    !canonicalString(value.executionId, 1_024) ||
    !finiteTimestamp(value.createdAt) ||
    !finiteTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    value.updatedAt > stateUpdatedAt ||
    !['running', 'waiting-input', 'completed', 'failed', 'interrupted'].includes(
      String(value.status)
    ) ||
    (value.status === 'running' || value.status === 'waiting-input'
      ? value.finishedAt !== undefined
      : !timestampWithin(value.finishedAt, value.createdAt, value.updatedAt)) ||
    (value.statusLabel !== undefined &&
      !boundedString(value.statusLabel, MAX_PERSISTED_TEXT)) ||
    (value.foreground !== undefined && !isForeground(value.foreground)) ||
    (value.reasoningBreak !== undefined && typeof value.reasoningBreak !== 'boolean') ||
    (value.runtimeModel !== undefined &&
      !boundedString(value.runtimeModel, MAX_PERSISTED_TEXT)) ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.timeline) ||
    !boundedString(value.answer, MAX_ANSWER) ||
    !boundedString(value.reasoning, MAX_REASONING) ||
    !Array.isArray(value.plan) ||
    value.plan.length > 200 ||
    !Array.isArray(value.activities) ||
    !Array.isArray(value.interactions) ||
    !Array.isArray(value.notices) ||
    (value.planExplanation !== undefined &&
      !boundedString(value.planExplanation, MAX_DETAIL)) ||
    (value.usage !== undefined && !isUsage(value.usage)) ||
    (value.diff !== undefined && !boundedString(value.diff, MAX_ANSWER)) ||
    (value.review !== undefined && !boundedString(value.review, MAX_ANSWER)) ||
    (value.contextCompacted !== undefined && typeof value.contextCompacted !== 'boolean') ||
    (value.error !== undefined && !boundedString(value.error, MAX_NOTICE))) return false

  return value.messages.every((message) =>
    isMessage(message, value.createdAt as number, value.updatedAt as number)
  ) && value.timeline.every((item) =>
    isTimelineItem(item, value.createdAt as number, value.updatedAt as number)
  ) && value.plan.every(isPlanStep) &&
    value.activities.every(isActivity) &&
    value.interactions.every(isInteraction) &&
    value.notices.every(isNotice)
}

function isMessage(
  value: unknown,
  turnCreatedAt: number,
  turnUpdatedAt: number
): value is CodexMessage {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      'id',
      'role',
      'kind',
      'content',
      'createdAt',
      'attachments',
      'internal'
    ]) &&
    Boolean(canonicalString(value.id, 1_024)) &&
    (value.role === 'user' || value.role === 'assistant') &&
    ['prompt', 'follow-up', 'answer'].includes(String(value.kind)) &&
    boundedString(value.content, MAX_PERSISTED_TEXT) &&
    timestampWithin(value.createdAt, turnCreatedAt, turnUpdatedAt) &&
    Array.isArray(value.attachments) &&
    value.attachments.length <= 128 &&
    value.attachments.every(isAttachment) &&
    (value.internal === undefined || value.internal === true)
}

function isAttachment(value: unknown): value is CodexAttachment {
  return isRecord(value) &&
    hasOnlyKeys(value, ['id', 'name', 'mimeType', 'size', 'kind']) &&
    nonEmptyBoundedString(value.id, 1_024) &&
    boundedString(value.name, 4 * 1024 * 1024) &&
    boundedString(value.mimeType, 256) &&
    Number.isSafeInteger(value.size) && Number(value.size) >= 0 &&
    ['image', 'audio', 'file'].includes(String(value.kind))
}

function isTimelineItem(
  value: unknown,
  turnCreatedAt: number,
  turnUpdatedAt: number
): value is CodexTimelineItem {
  if (!isRecord(value) || !canonicalString(value.id, 1_024) ||
    !timestampWithin(value.createdAt, turnCreatedAt, turnUpdatedAt)) return false
  if (value.kind === 'user-message') {
    return hasOnlyKeys(value, ['id', 'kind', 'createdAt', 'messageId']) &&
      Boolean(canonicalString(value.messageId, 1_024))
  }
  if (value.kind === 'activity') {
    return hasOnlyKeys(value, ['id', 'kind', 'createdAt', 'activityId']) &&
      Boolean(canonicalString(value.activityId, 1_024))
  }
  if (value.kind === 'interaction') {
    return hasOnlyKeys(value, ['id', 'kind', 'createdAt', 'interactionId']) &&
      Boolean(canonicalString(value.interactionId, 1_024))
  }
  if (value.kind === 'notice') {
    return hasOnlyKeys(value, ['id', 'kind', 'createdAt', 'noticeId']) &&
      Boolean(canonicalString(value.noticeId, 1_024))
  }
  if (value.kind === 'assistant') {
    return hasOnlyKeys(value, ['id', 'kind', 'createdAt', 'itemId', 'content', 'status']) &&
      isCodexAgentMessageId(value.itemId) &&
      boundedString(value.content, MAX_ANSWER) &&
      ['complete', 'streaming', 'failed', 'cancelled'].includes(String(value.status))
  }
  if (value.kind === 'reasoning') {
    return hasOnlyKeys(value, ['id', 'kind', 'createdAt', 'content']) &&
      boundedString(value.content, MAX_REASONING)
  }
  return hasOnlyKeys(value, ['id', 'kind', 'createdAt']) &&
    ['plan', 'diff', 'review', 'context-compaction', 'error'].includes(
      String(value.kind)
    )
}

function isPlanStep(value: unknown): value is CodexPlanStep {
  return isRecord(value) &&
    hasOnlyKeys(value, ['step', 'status']) &&
    boundedString(value.step, MAX_PERSISTED_TEXT) &&
    ['pending', 'inProgress', 'completed'].includes(String(value.status))
}

function isActivity(value: unknown): value is CodexActivity {
  return isRecord(value) &&
    hasOnlyKeys(value, ['id', 'kind', 'label', 'status', 'detail', 'toolName']) &&
    Boolean(canonicalString(value.id, 1_024)) &&
    [
      'command',
      'file',
      'tool',
      'search',
      'agent',
      'subagent',
      'review',
      'hook'
    ].includes(String(value.kind)) &&
    boundedString(value.label, MAX_DETAIL) &&
    ['running', 'completed', 'failed', 'cancelled'].includes(String(value.status)) &&
    (value.detail === undefined || boundedString(value.detail, MAX_DETAIL)) &&
    (value.toolName === undefined || nonEmptyBoundedString(value.toolName, MAX_TOOL_NAME))
}

function isForeground(value: unknown): value is HarnessBartForeground {
  if (!isRecord(value) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) {
    return false
  }
  if (value.kind === 'assistant-text') {
    return hasOnlyKeys(value, ['sequence', 'kind'])
  }
  if (value.kind === 'reasoning') {
    // A provider signal with no displayable text still keeps the thinking eye
    // and blue dot; only the arc text is omitted, never invented.
    return hasOnlyKeys(value, ['sequence', 'kind', 'text']) &&
      boundedString(value.text, MAX_REASONING)
  }
  if (value.kind === 'tool-call') {
    return hasOnlyKeys(value, ['sequence', 'kind', 'callId', 'toolName']) &&
      Boolean(canonicalString(value.callId, 1_024)) &&
      nonEmptyBoundedString(value.toolName, MAX_TOOL_NAME)
  }
  return false
}

function isInteraction(value: unknown): value is CodexInteraction {
  if (!isRecord(value) ||
    !hasOnlyKeys(value, [
      'id',
      'kind',
      'title',
      'detail',
      'blocksTurn',
      'status',
      'resolution',
      'actions',
      'questions',
      ...(value.kind === 'mcp-elicitation' ? ['elicitation'] : [])
    ]) ||
    !canonicalString(value.id, 1_024) ||
    !['command-approval', 'file-approval', 'permissions', 'user-input', 'mcp-elicitation'].includes(
      String(value.kind)
    ) ||
    !boundedString(value.title, MAX_PERSISTED_TEXT) ||
    (value.detail !== undefined && !boundedString(value.detail, MAX_PERSISTED_TEXT)) ||
    typeof value.blocksTurn !== 'boolean' ||
    !['pending', 'allowed', 'denied', 'submitted', 'cancelled', 'resolved'].includes(
      String(value.status)
    ) ||
    (value.resolution !== undefined && !boundedString(value.resolution, 1_000)) ||
    !Array.isArray(value.actions) ||
    !Array.isArray(value.questions)) return false
  if (!value.actions.every(isInteractionAction) ||
    !value.questions.every(isInteractionQuestion)) return false
  if (value.kind !== 'mcp-elicitation') return true
  const elicitation = value.elicitation
  if (!isRecord(elicitation)) return false
  if (elicitation.mode === 'url') {
    return hasOnlyKeys(elicitation, ['mode', 'url']) &&
      nonEmptyBoundedString(elicitation.url, MAX_PERSISTED_TEXT) &&
      value.questions.length === 0
  }
  return elicitation.mode === 'form' &&
    hasOnlyKeys(elicitation, ['mode', 'requestedSchema', 'questionId']) &&
    isRecord(elicitation.requestedSchema) && isJsonValue(elicitation.requestedSchema) &&
    nonEmptyBoundedString(elicitation.questionId, MAX_PERSISTED_TEXT) &&
    value.questions.length === 1 && value.questions[0].id === elicitation.questionId
}

function isInteractionAction(
  value: unknown
): value is CodexInteraction['actions'][number] {
  return isRecord(value) &&
    hasOnlyKeys(value, ['id', 'intent', 'label']) &&
    ['allow-once', 'allow-session', 'deny', 'cancel', 'submit'].includes(
      String(value.id)
    ) &&
    ['allow', 'deny', 'cancel', 'submit'].includes(String(value.intent)) &&
    boundedString(value.label, MAX_PERSISTED_TEXT)
}

function isInteractionQuestion(
  value: unknown
): value is CodexInteraction['questions'][number] {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      'id',
      'header',
      'prompt',
      'secret',
      'allowOther',
      'options'
    ]) &&
    nonEmptyBoundedString(value.id, MAX_PERSISTED_TEXT) &&
    (value.header === undefined || boundedString(value.header, MAX_PERSISTED_TEXT)) &&
    boundedString(value.prompt, MAX_PERSISTED_TEXT) &&
    typeof value.secret === 'boolean' &&
    typeof value.allowOther === 'boolean' &&
    Array.isArray(value.options) &&
    value.options.every(isInteractionQuestionOption)
}

function isInteractionQuestionOption(
  value: unknown
): value is CodexInteraction['questions'][number]['options'][number] {
  return isRecord(value) &&
    hasOnlyKeys(value, ['id', 'label', 'description']) &&
    nonEmptyBoundedString(value.id, MAX_PERSISTED_TEXT) &&
    boundedString(value.label, MAX_PERSISTED_TEXT) &&
    (value.description === undefined ||
      boundedString(value.description, MAX_PERSISTED_TEXT))
}

function isNotice(value: unknown): value is CodexTurn['notices'][number] {
  return isRecord(value) &&
    hasOnlyKeys(value, ['id', 'level', 'message']) &&
    Boolean(canonicalString(value.id, 1_024)) &&
    ['info', 'warning', 'error'].includes(String(value.level)) &&
    boundedString(value.message, MAX_NOTICE)
}

function isUsage(value: unknown): value is CodexUsage {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      'inputTokens',
      'cachedInputTokens',
      'outputTokens',
      'reasoningTokens',
      'contextWindow'
    ]) &&
    Object.values(value).every(finiteNumber)
}

function messageFromInput(
  input: AgentInput,
  id: string,
  kind: 'prompt' | 'follow-up',
  createdAt: number
) {
  const texts: string[] = []
  const attachments: CodexAttachment[] = []
  for (const part of input.parts) {
    if (part.kind === 'text') texts.push(part.text)
    else if (part.kind === 'mention') texts.push(`@${part.name}`)
    else if (part.kind === 'skill') texts.push(`$${part.name}`)
    else if (part.kind === 'image' || part.kind === 'audio' || part.kind === 'local-file') {
      attachments.push({
        id: part.file.id,
        name: part.file.name,
        mimeType: part.file.mimeType,
        size: part.file.size,
        kind: part.kind === 'image' ? 'image' : part.kind === 'audio' ? 'audio' : 'file'
      })
    } else if (part.kind === 'image-url') {
      attachments.push({
        id: `image-url:${attachments.length}`,
        name: part.url,
        mimeType: 'image/*',
        size: 0,
        kind: 'image'
      })
    } else if (part.kind === 'audio-url') {
      attachments.push({
        id: `audio-url:${attachments.length}`,
        name: part.url,
        mimeType: 'audio/*',
        size: 0,
        kind: 'audio'
      })
    }
  }
  return {
    id,
    role: 'user' as const,
    kind,
    content: texts.join('\n'),
    createdAt,
    attachments,
    ...(input.presentation === 'internal' ? { internal: true as const } : {})
  }
}

function mapActiveTurn(
  state: CodexHarnessState,
  executionId: string,
  at: number,
  map: (turn: CodexTurn) => CodexTurn
): CodexHarnessState {
  const index = state.turns.findIndex(
    (turn) => turn.executionId === executionId && activeTurnStatus(turn.status)
  )
  if (index < 0) throw new Error(`Codex Execution 不再活动：${executionId}`)
  const turns = state.turns.slice()
  turns[index] = map(turns[index]!)
  return { ...state, updatedAt: at, turns }
}

function upsertActivity(
  activities: readonly CodexActivity[],
  activity: CodexActivity
): readonly CodexActivity[] {
  const index = activities.findIndex((candidate) => candidate.id === activity.id)
  if (index < 0) return [...activities, activity]
  return activities.map((candidate, candidateIndex) =>
    candidateIndex === index ? activity : candidate
  )
}

function upsertInteraction(
  interactions: readonly CodexInteraction[],
  interaction: CodexInteraction
): readonly CodexInteraction[] {
  const index = interactions.findIndex((candidate) => candidate.id === interaction.id)
  if (index < 0) return [...interactions, interaction]
  return interactions.map((candidate, candidateIndex) =>
    candidateIndex === index ? interaction : candidate
  )
}

function appendTimelineReference(
  timeline: readonly CodexTimelineItem[],
  kind: 'user-message' | 'activity' | 'interaction' | 'notice',
  referenceId: string,
  at: number
): readonly CodexTimelineItem[] {
  const duplicate = timeline.some((item) => {
    if (item.kind !== kind) return false
    if (kind === 'user-message' && item.kind === 'user-message') {
      return item.messageId === referenceId
    }
    if (kind === 'activity' && item.kind === 'activity') return item.activityId === referenceId
    if (kind === 'interaction' && item.kind === 'interaction') {
      return item.interactionId === referenceId
    }
    return kind === 'notice' && item.kind === 'notice' && item.noticeId === referenceId
  })
  if (duplicate) return timeline
  const base = { id: timelineId(timeline, kind, at), kind, createdAt: at }
  if (kind === 'user-message') return [...timeline, { ...base, kind, messageId: referenceId }]
  if (kind === 'activity') return [...timeline, { ...base, kind, activityId: referenceId }]
  if (kind === 'interaction') {
    return [...timeline, { ...base, kind, interactionId: referenceId }]
  }
  return [...timeline, { ...base, kind, noticeId: referenceId }]
}

function appendTimelineMarker(
  timeline: readonly CodexTimelineItem[],
  kind: 'plan' | 'diff' | 'review' | 'context-compaction' | 'error',
  at: number,
  repeat = false
): readonly CodexTimelineItem[] {
  if (!repeat && timeline.some((item) => item.kind === kind)) return timeline
  return [...timeline, { id: timelineId(timeline, kind, at), kind, createdAt: at }]
}

function appendTimelineTextDelta(
  timeline: readonly CodexTimelineItem[],
  itemId: string,
  delta: string,
  at: number
): readonly CodexTimelineItem[] {
  const index = timeline.findIndex((item) => item.kind === 'assistant' && item.itemId === itemId)
  const item = timeline[index]
  if (item?.kind === 'assistant') {
    // A replayed late delta cannot change a finalized native message.
    if (item.status !== 'streaming') return timeline
    const next = timeline.slice()
    next[index] = {
      ...item,
      content: tail(item.content + delta, MAX_ANSWER)
    }
    return next
  }
  return [...timeline, {
    id: timelineId(timeline, 'assistant', at),
    kind: 'assistant',
    itemId,
    content: tail(delta, MAX_ANSWER),
    createdAt: at,
    status: 'streaming'
  }]
}

function finalizeTimelineText(
  timeline: readonly CodexTimelineItem[],
  itemId: string,
  text: string,
  at: number
): readonly CodexTimelineItem[] {
  const index = timeline.findIndex((item) => item.kind === 'assistant' && item.itemId === itemId)
  const latest = timeline[index]
  if (latest?.kind === 'assistant') {
    const next = timeline.slice()
    next[index] = { ...latest, content: tail(text, MAX_ANSWER), status: 'complete' }
    return next
  }
  return [...timeline, {
    id: timelineId(timeline, 'assistant', at),
    kind: 'assistant',
    itemId,
    content: tail(text, MAX_ANSWER),
    createdAt: at,
    status: 'complete'
  }]
}

function appendTimelineReasoningDelta(
  timeline: readonly CodexTimelineItem[],
  delta: string,
  at: number
): readonly CodexTimelineItem[] {
  const tailItem = timeline.at(-1)
  if (tailItem?.kind === 'reasoning') {
    const next = timeline.slice()
    next[next.length - 1] = {
      ...tailItem,
      content: tail(tailItem.content + delta, MAX_REASONING)
    }
    return next
  }
  return [...timeline, {
    id: timelineId(timeline, 'reasoning', at),
    kind: 'reasoning',
    content: tail(delta, MAX_REASONING),
    createdAt: at
  }]
}

function settleTimelineText(
  timeline: readonly CodexTimelineItem[],
  status: CodexTimelineTextStatus
): readonly CodexTimelineItem[] {
  let changed = false
  const next = timeline.map((item) => {
    if (item.kind !== 'assistant' || item.status !== 'streaming') return item
    changed = true
    return { ...item, status }
  })
  return changed ? next : timeline
}

function timelineAnswer(timeline: readonly CodexTimelineItem[]): string {
  return tail(joinCodexAssistantTexts(timeline.flatMap((item) =>
    item.kind === 'assistant' && item.content ? [item.content] : []
  )), MAX_ANSWER)
}

function timelineId(
  timeline: readonly CodexTimelineItem[],
  kind: CodexTimelineItem['kind'],
  at: number
): string {
  return `tl:${at}:${kind}:${timeline.length}`
}

function nextAt(state: CodexHarnessState, at: number): number {
  return Math.max(state.updatedAt + 1, Math.trunc(at))
}

function terminalLabel(outcome: 'completed' | 'failed' | 'interrupted'): string {
  return outcome === 'completed' ? '已完成' : outcome === 'failed' ? '失败' : '已中断'
}

function activeTurnStatus(status: CodexTurn['status']): boolean {
  return status === 'running' || status === 'waiting-input'
}

function interactionStatus(resolution: string): CodexInteraction['status'] {
  const normalized = resolution.trim()
  if (normalized === 'accept' || normalized === 'acceptForSession' || normalized === 'turn' ||
    normalized === 'session') return 'allowed'
  if (normalized === 'submit') return 'submitted'
  if (normalized === 'cancel') return 'cancelled'
  if (normalized === 'decline') return 'denied'
  return 'resolved'
}

function tail(value: string, max: number): string {
  return value.length > max ? `…\n${value.slice(-max + 2)}` : value
}

function optional<Base extends object, Key extends string, Value>(
  base: Base,
  key: Key,
  value: Value | undefined
): Base & Partial<Record<Key, Value>> {
  return value === undefined ? base : { ...base, [key]: value }
}

function canonicalString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    value.length <= max && !value.includes('\0')
    ? value
    : undefined
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
}

function nonEmptyBoundedString(value: unknown, max: number): value is string {
  return boundedString(value, max) && value.length > 0
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function timestampWithin(value: unknown, minimum: number, maximum: number): value is number {
  return finiteTimestamp(value) && value >= minimum && value <= maximum
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}
