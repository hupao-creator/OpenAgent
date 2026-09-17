import type { JsonValue } from '@openagent/contracts'
import type { HarnessBartForeground } from '@openagent/contracts/renderer'

export type ClaudeTurnStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'

export type ClaudeActivityStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ClaudeActivityKind =
  | 'command'
  | 'file'
  | 'tool'
  | 'search'
  | 'thinking'
  | 'agent'
  | 'task'
  | 'hook'
  | 'review'
  | 'subagent'

export interface ClaudeActivity {
  id: string
  kind: ClaudeActivityKind
  label: string
  status: ClaudeActivityStatus
  /** Canonical native tool name, present on tool-kind activities. */
  toolName?: string
  /** Only command output and the bounded Workflow phase projection are persisted. */
  detail?: string
  parentId?: string
  taskId?: string
}

export interface ClaudePlanStep {
  step: string
  status: 'pending' | 'inProgress' | 'completed'
}

export interface ClaudeUsage {
  /** Anthropic input_tokens excludes cache reads and cache creation. */
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  contextTokens?: number
  contextWindow?: number
  costUsd?: number
}

export type ClaudeInteractionStatus =
  | 'pending'
  | 'allowed'
  | 'denied'
  | 'submitted'
  | 'cancelled'
  | 'resolved'

export interface ClaudeInteraction {
  id: string
  kind: 'permission' | 'question' | 'elicitation' | 'dialog'
  title: string
  description?: string
  toolName?: string
  /** Native permission suggestions are the only authority for session-wide approval. */
  canRemember?: boolean
  input?: JsonValue
  schema?: JsonValue
  /** Claude MCP elicitation wire mode. URL mode is not a JSON form. */
  elicitationMode?: 'form' | 'url'
  url?: string
  elicitationId?: string
  serverName?: string
  status: ClaudeInteractionStatus
  questions?: Array<{
    question: string
    header?: string
    multiSelect: boolean
    options: Array<{ label: string; description?: string }>
  }>
}

export interface ClaudeNotice {
  id: string
  level: 'info' | 'warning' | 'error'
  message: string
}

/** Provider-private projection of one submitted AgentInput attachment. */
export interface ClaudeInputAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  kind: 'image' | 'audio' | 'file'
}

export type ClaudeTimelineTextStatus =
  | 'complete'
  | 'streaming'
  | 'failed'
  | 'cancelled'

interface ClaudeTimelineItemBase {
  id: string
  createdAt: number
}

/**
 * Claude-private chronological history, including immutable activity/interaction
 * snapshots for checkpoint forks. Current entity state belongs to the Turn's
 * activities/interactions collections, never to these historical snapshots.
 */
export type ClaudeTimelineItem =
  | (ClaudeTimelineItemBase & {
      kind: 'user-message'
      promptIndex: number
      /** Claude native user-message UUID used by rewind/fork controls. */
      checkpointId?: string
    })
  | (ClaudeTimelineItemBase & {
      kind: 'assistant'
      /** Native assistant identity shared by text segments interrupted by other timeline items. */
      messageId?: string
      content: string
      status: ClaudeTimelineTextStatus
    })
  | (ClaudeTimelineItemBase & { kind: 'reasoning'; content: string })
  | (ClaudeTimelineItemBase & { kind: 'activity'; activity: ClaudeActivity })
  | (ClaudeTimelineItemBase & {
      kind: 'interaction'
      interaction: ClaudeInteraction
    })
  | (ClaudeTimelineItemBase & { kind: 'notice'; notice: ClaudeNotice })
  | (ClaudeTimelineItemBase & {
      kind: 'plan'
      plan: ClaudePlanStep[]
      explanation?: string
    })
  | (ClaudeTimelineItemBase & { kind: 'error'; message: string })
  | (ClaudeTimelineItemBase & { kind: 'usage'; usage: ClaudeUsage })
  | (ClaudeTimelineItemBase & { kind: 'diff'; content: string })
  | (ClaudeTimelineItemBase & { kind: 'review'; content: string })
  | (ClaudeTimelineItemBase & { kind: 'context-compaction' })

export interface ClaudeTurn {
  executionId: string
  createdAt: number
  updatedAt: number
  /** Immutable foreground completion; Session background work may update updatedAt later. */
  finishedAt?: number
  prompts: string[]
  /** Exact positional companion to prompts; current v1 never infers old shapes. */
  promptAttachments: ClaudeInputAttachment[][]
  internalPromptIndexes?: number[]
  text: string
  reasoning: string
  status: ClaudeTurnStatus
  statusLabel?: string
  /**
   * Foreground semantic activity, maintained where native events are accepted.
   * Absent until the first such event; a new Turn therefore starts clean.
   */
  foreground?: HarnessBartForeground
  error?: string
  plan: ClaudePlanStep[]
  planExplanation?: string
  /** Authority for current activity state, including terminal and background updates. */
  activities: ClaudeActivity[]
  /** Authority for current interaction state; timeline snapshots are historical only. */
  interactions: ClaudeInteraction[]
  notices: ClaudeNotice[]
  timeline: ClaudeTimelineItem[]
  usage?: ClaudeUsage
  diff?: string
  review?: string
  compacted?: true
}

export interface ClaudeBackgroundTask {
  id: string
  type?: string
  description: string
  status: string
}

export interface ClaudeRuntimeModelInfo {
  value: string
  displayName: string
  description?: string
  resolvedModel?: string
}

export interface ClaudeRuntimeAgentInfo {
  name: string
  description: string
  model?: string
}

export interface ClaudeRuntimeCommandInfo {
  name: string
  description?: string
  argumentHint?: string
}

export interface ClaudeRuntimeMcpServerInfo {
  name: string
  status: string
  serverInfo?: string
}

export interface ClaudeRemoteControlState {
  enabled: boolean
  sessionUrl?: string
  connectUrl?: string
  environmentId?: string
}

export interface ClaudeRuntimeState {
  model?: string
  cwd?: string
  claudeVersion?: string
  permissionMode?: string
  effort?: string
  capabilities?: string[]
  models?: ClaudeRuntimeModelInfo[]
  agents?: ClaudeRuntimeAgentInfo[]
  commands?: ClaudeRuntimeCommandInfo[]
  skills?: string[]
  plugins?: Array<{ name: string; path?: string; version?: string }>
  mcpServers?: ClaudeRuntimeMcpServerInfo[]
  backgroundTasks?: ClaudeBackgroundTask[]
  remoteControl?: ClaudeRemoteControlState
}

export interface ClaudePendingFork {
  sourceSessionId: string
  checkpointId?: string
}

export interface ClaudeForkHistoryActivity {
  kind: ClaudeActivityKind
  label: string
  status: Exclude<ClaudeActivityStatus, 'running'>
  detail?: string
}

export interface ClaudeForkHistoryInteraction {
  kind: ClaudeInteraction['kind']
  title: string
  description?: string
  toolName?: string
  questions?: ClaudeInteraction['questions']
  status: Exclude<ClaudeInteractionStatus, 'pending'>
}

/**
 * Immutable, read-only provider projection used by a fork target. Native
 * control identifiers and Core execution identities are deliberately absent.
 */
export type ClaudeForkHistoryItem =
  | (ClaudeTimelineItemBase & {
      kind: 'user-message'
      content: string
      attachments?: ClaudeInputAttachment[]
      checkpointId?: string
    })
  | (ClaudeTimelineItemBase & {
      kind: 'assistant'
      content: string
      status: Exclude<ClaudeTimelineTextStatus, 'streaming'>
    })
  | (ClaudeTimelineItemBase & { kind: 'reasoning'; content: string })
  | (ClaudeTimelineItemBase & {
      kind: 'activity'
      activity: ClaudeForkHistoryActivity
    })
  | (ClaudeTimelineItemBase & {
      kind: 'interaction'
      interaction: ClaudeForkHistoryInteraction
    })
  | (ClaudeTimelineItemBase & { kind: 'notice'; notice: Omit<ClaudeNotice, 'id'> })
  | (ClaudeTimelineItemBase & {
      kind: 'plan'
      plan: ClaudePlanStep[]
      explanation?: string
    })
  | (ClaudeTimelineItemBase & { kind: 'error'; message: string })
  | (ClaudeTimelineItemBase & { kind: 'usage'; usage: ClaudeUsage })
  | (ClaudeTimelineItemBase & { kind: 'diff'; content: string })
  | (ClaudeTimelineItemBase & { kind: 'review'; content: string })
  | (ClaudeTimelineItemBase & { kind: 'context-compaction' })

export interface ClaudeForkHistory {
  /** Durable native provenance retained after the one-shot fork is consumed. */
  sourceSessionId: string
  checkpointId?: string
  items: ClaudeForkHistoryItem[]
}

export interface ClaudeThreadState {
  version: 1
  /** Permanent OpenAgent Thread -> Claude native session binding. */
  primarySessionId?: string
  /** One-shot native fork intent consumed when this Thread creates its own session. */
  pendingFork?: ClaudePendingFork
  /** Visible source transcript copied without any Core execution identity. */
  forkHistory?: ClaudeForkHistory
  /**
   * Durable admission marker for a fresh goal-mode session. It remains set
   * until the first `/goal` user frame has been written to the native stream.
   */
  goalPromptPending?: true
  runtime?: ClaudeRuntimeState
  turns: ClaudeTurn[]
  nativeNotifications: Array<{ summary: string; status?: string }>
}

export const CLAUDE_STATE_LIMITS = {
  turns: 2_000,
  promptsPerTurn: 200,
  attachmentsPerPrompt: 128,
  attachmentIdCharacters: 512,
  attachmentNameCharacters: 8_192,
  attachmentMimeTypeCharacters: 256,
  promptCharacters: 2_000_000,
  textCharacters: 4_000_000,
  reasoningCharacters: 4_000_000,
  timelineItemsPerTurn: 50_000,
  timelineContentCharacters: 4_000_000,
  errorCharacters: 100_000,
  planStepsPerTurn: 2_000,
  planStepCharacters: 32_000,
  planExplanationCharacters: 32_000,
  diffCharacters: 500_000,
  reviewCharacters: 500_000,
  activitiesPerTurn: 2_000,
  activityLabelCharacters: 2_000,
  activityToolNameCharacters: 512,
  activityDetailCharacters: 100_000,
  foregroundToolNameCharacters: 1_024,
  interactionsPerTurn: 500,
  noticesPerTurn: 500,
  noticeCharacters: 20_000,
  nativeNotifications: 200,
  nativeNotificationCharacters: 20_000,
  nativeNotificationStatusCharacters: 256,
  backgroundTasks: 512,
  runtimeModels: 512,
  runtimeAgents: 512,
  runtimeCommands: 2_000,
  runtimeSkills: 2_000,
  runtimePlugins: 512,
  runtimeMcpServers: 512,
  runtimeCapabilities: 512,
  forkHistoryMessages: 4_000,
  forkHistoryCharacters: 4_000_000,
  interactionJsonCharacters: 100_000,
  interactionJsonNodes: 10_000,
  interactionJsonDepth: 32
} as const

export function emptyClaudeThreadState(): ClaudeThreadState {
  return { version: 1, turns: [], nativeNotifications: [] }
}

export function parseClaudeThreadState(value: unknown): ClaudeThreadState {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('Claude sessionState 无效')
  }
  assertOnlyKeys(value, [
    'version',
    'primarySessionId',
    'pendingFork',
    'forkHistory',
    'goalPromptPending',
    'runtime',
    'turns',
    'nativeNotifications'
  ], 'Claude sessionState')
  if (
    value.primarySessionId !== undefined &&
    !isNonEmptyBoundedString(value.primarySessionId, 512)
  ) {
    throw new Error('Claude primarySessionId 无效')
  }
  if (value.goalPromptPending !== undefined && value.goalPromptPending !== true) {
    throw new Error('Claude goalPromptPending 无效')
  }
  const pendingFork = parsePendingFork(value.pendingFork)
  const forkHistory = parseForkHistory(value.forkHistory)
  if (value.primarySessionId !== undefined && pendingFork !== undefined) {
    throw new Error('Claude primarySessionId 与 pendingFork 不能同时存在')
  }
  if (!Array.isArray(value.turns) || value.turns.length > CLAUDE_STATE_LIMITS.turns) {
    throw new Error('Claude turns 无效')
  }
  if (
    !Array.isArray(value.nativeNotifications) ||
    value.nativeNotifications.length > CLAUDE_STATE_LIMITS.nativeNotifications
  ) {
    throw new Error('Claude nativeNotifications 无效')
  }
  const runtime = parseClaudeRuntimeState(value.runtime)
  return {
    version: 1,
    ...(value.primarySessionId === undefined
      ? {}
      : { primarySessionId: value.primarySessionId }),
    ...(pendingFork === undefined ? {} : { pendingFork }),
    ...(forkHistory === undefined ? {} : { forkHistory }),
    ...(value.goalPromptPending === true ? { goalPromptPending: true as const } : {}),
    ...(runtime === undefined ? {} : { runtime }),
    turns: value.turns.map(parseTurn),
    nativeNotifications: value.nativeNotifications.map((entry) => {
      if (
        !isRecord(entry) ||
        !isBoundedString(
          entry.summary,
          CLAUDE_STATE_LIMITS.nativeNotificationCharacters
        )
      ) {
        throw new Error('Claude native notification 无效')
      }
      assertOnlyKeys(entry, ['summary', 'status'], 'Claude native notification')
      if (
        entry.status !== undefined &&
        !isBoundedString(
          entry.status,
          CLAUDE_STATE_LIMITS.nativeNotificationStatusCharacters
        )
      ) {
        throw new Error('Claude native notification status 无效')
      }
      return {
        summary: entry.summary,
        ...(entry.status === undefined ? {} : { status: entry.status })
      }
    })
  }
}

function parsePendingFork(value: unknown): ClaudePendingFork | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('Claude pendingFork 无效')
  assertOnlyKeys(value, ['sourceSessionId', 'checkpointId'], 'Claude pendingFork')
  if (
    !isNonEmptyBoundedString(value.sourceSessionId, 512) ||
    (value.checkpointId !== undefined &&
      !isNonEmptyBoundedString(value.checkpointId, 512))
  ) {
    throw new Error('Claude pendingFork 无效')
  }
  return {
    sourceSessionId: value.sourceSessionId,
    ...(value.checkpointId === undefined
      ? {}
      : { checkpointId: value.checkpointId })
  }
}

function parseForkHistory(value: unknown): ClaudeForkHistory | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('Claude forkHistory 无效')
  assertOnlyKeys(
    value,
    ['sourceSessionId', 'checkpointId', 'items'],
    'Claude forkHistory'
  )
  if (
    !isNonEmptyBoundedString(value.sourceSessionId, 512) ||
    (value.checkpointId !== undefined &&
      !isNonEmptyBoundedString(value.checkpointId, 512)) ||
    !Array.isArray(value.items) ||
    value.items.length > CLAUDE_STATE_LIMITS.forkHistoryMessages
  ) {
    throw new Error('Claude forkHistory 无效')
  }
  const items = value.items.map(parseForkHistoryItem)
  if (
    items.reduce((total, item) => total + forkHistoryItemCharacters(item), 0) >
    CLAUDE_STATE_LIMITS.forkHistoryCharacters
  ) {
    throw new Error('Claude forkHistory 内容超限')
  }
  if (new Set(items.map(({ id }) => id)).size !== items.length) {
    throw new Error('Claude forkHistory item id 重复')
  }
  if (items.some((item, index) =>
    index > 0 && item.createdAt < items[index - 1]!.createdAt
  )) {
    throw new Error('Claude forkHistory item 顺序无效')
  }
  if (
    value.checkpointId !== undefined &&
    items.filter((item) =>
      item.kind === 'user-message' && item.checkpointId === value.checkpointId
    ).length !== 1
  ) {
    throw new Error('Claude forkHistory checkpoint provenance 无效')
  }
  return {
    sourceSessionId: value.sourceSessionId,
    ...(value.checkpointId === undefined
      ? {}
      : { checkpointId: value.checkpointId }),
    items
  }
}

function parseForkHistoryItem(value: unknown): ClaudeForkHistoryItem {
  if (
    !isRecord(value) ||
    !isNonEmptyBoundedString(value.id, 512) ||
    !isTimestamp(value.createdAt)
  ) {
    throw new Error('Claude forkHistory item 无效')
  }
  const base = { id: value.id, createdAt: value.createdAt }
  if (value.kind === 'user-message') {
    assertOnlyKeys(
      value,
      ['id', 'kind', 'createdAt', 'content', 'attachments', 'checkpointId'],
      'Claude forkHistory user item'
    )
    if (
      !isBoundedString(value.content, CLAUDE_STATE_LIMITS.promptCharacters) ||
      (value.checkpointId !== undefined &&
        !isNonEmptyBoundedString(value.checkpointId, 512))
    ) {
      throw new Error('Claude forkHistory user item 无效')
    }
    const attachments = parseForkAttachments(value.attachments)
    return {
      ...base,
      kind: value.kind,
      content: value.content,
      ...(attachments === undefined ? {} : { attachments }),
      ...(value.checkpointId === undefined
        ? {}
        : { checkpointId: value.checkpointId })
    }
  }
  if (value.kind === 'assistant') {
    assertOnlyKeys(
      value,
      ['id', 'kind', 'createdAt', 'content', 'status'],
      'Claude forkHistory assistant item'
    )
    if (
      !isBoundedString(value.content, CLAUDE_STATE_LIMITS.textCharacters) ||
      !['complete', 'failed', 'cancelled'].includes(String(value.status))
    ) {
      throw new Error('Claude forkHistory assistant item 无效')
    }
    return {
      ...base,
      kind: value.kind,
      content: value.content,
      status: value.status as Exclude<ClaudeTimelineTextStatus, 'streaming'>
    }
  }
  if (value.kind === 'reasoning') {
    assertOnlyKeys(value, ['id', 'kind', 'createdAt', 'content'], 'Claude forkHistory reasoning item')
    if (!isBoundedString(value.content, CLAUDE_STATE_LIMITS.reasoningCharacters)) {
      throw new Error('Claude forkHistory reasoning item 无效')
    }
    return { ...base, kind: value.kind, content: value.content }
  }
  if (value.kind === 'activity') {
    assertOnlyKeys(value, ['id', 'kind', 'createdAt', 'activity'], 'Claude forkHistory activity item')
    return { ...base, kind: value.kind, activity: parseForkHistoryActivity(value.activity) }
  }
  if (value.kind === 'interaction') {
    assertOnlyKeys(value, ['id', 'kind', 'createdAt', 'interaction'], 'Claude forkHistory interaction item')
    return {
      ...base,
      kind: value.kind,
      interaction: parseForkHistoryInteraction(value.interaction)
    }
  }
  if (value.kind === 'notice') {
    assertOnlyKeys(value, ['id', 'kind', 'createdAt', 'notice'], 'Claude forkHistory notice item')
    const rawNotice = recordValue(value.notice)
    assertOnlyKeys(rawNotice, ['level', 'message'], 'Claude forkHistory notice')
    const notice = parseNotice({ id: 'fork-history-notice', ...rawNotice })
    return {
      ...base,
      kind: value.kind,
      notice: { level: notice.level, message: notice.message }
    }
  }
  if (value.kind === 'plan') {
    assertOnlyKeys(value, ['id', 'kind', 'createdAt', 'plan', 'explanation'], 'Claude forkHistory plan item')
    if (
      !Array.isArray(value.plan) ||
      value.plan.length > CLAUDE_STATE_LIMITS.planStepsPerTurn ||
      (value.explanation !== undefined &&
        !isBoundedString(value.explanation, CLAUDE_STATE_LIMITS.planExplanationCharacters))
    ) {
      throw new Error('Claude forkHistory plan item 无效')
    }
    return {
      ...base,
      kind: value.kind,
      plan: value.plan.map(parsePlanStep),
      ...(value.explanation === undefined ? {} : { explanation: value.explanation })
    }
  }
  if (value.kind === 'error') {
    assertOnlyKeys(value, ['id', 'kind', 'createdAt', 'message'], 'Claude forkHistory error item')
    if (!isBoundedString(value.message, CLAUDE_STATE_LIMITS.errorCharacters)) {
      throw new Error('Claude forkHistory error item 无效')
    }
    return { ...base, kind: value.kind, message: value.message }
  }
  if (value.kind === 'usage') {
    assertOnlyKeys(value, ['id', 'kind', 'createdAt', 'usage'], 'Claude forkHistory usage item')
    return { ...base, kind: value.kind, usage: parseUsage(value.usage) }
  }
  if (value.kind === 'diff' || value.kind === 'review') {
    assertOnlyKeys(value, ['id', 'kind', 'createdAt', 'content'], `Claude forkHistory ${value.kind} item`)
    const maximum = value.kind === 'diff'
      ? CLAUDE_STATE_LIMITS.diffCharacters
      : CLAUDE_STATE_LIMITS.reviewCharacters
    if (!isBoundedString(value.content, maximum)) {
      throw new Error(`Claude forkHistory ${value.kind} item 无效`)
    }
    return { ...base, kind: value.kind, content: value.content }
  }
  if (value.kind === 'context-compaction') {
    assertOnlyKeys(value, ['id', 'kind', 'createdAt'], 'Claude forkHistory context compaction item')
    return { ...base, kind: value.kind }
  }
  throw new Error('Claude forkHistory item kind 无效')
}

function parseForkAttachments(value: unknown): ClaudeInputAttachment[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length > CLAUDE_STATE_LIMITS.attachmentsPerPrompt ||
    !value.every(isClaudeInputAttachment) ||
    new Set(value.map((attachment) => attachment.id)).size !== value.length
  ) {
    throw new Error('Claude forkHistory attachments 无效')
  }
  return value.map((attachment) => ({ ...attachment }))
}

function parseForkHistoryActivity(value: unknown): ClaudeForkHistoryActivity {
  if (!isRecord(value)) throw new Error('Claude forkHistory activity 无效')
  assertOnlyKeys(value, ['kind', 'label', 'status', 'detail'], 'Claude forkHistory activity')
  if (
    !isActivityKind(value.kind) ||
    !isBoundedString(value.label, CLAUDE_STATE_LIMITS.activityLabelCharacters) ||
    !['completed', 'failed', 'cancelled'].includes(String(value.status)) ||
    (value.detail !== undefined &&
      !isBoundedString(value.detail, CLAUDE_STATE_LIMITS.activityDetailCharacters))
  ) {
    throw new Error('Claude forkHistory activity 无效')
  }
  return {
    kind: value.kind,
    label: value.label,
    status: value.status as ClaudeForkHistoryActivity['status'],
    ...(value.detail === undefined ? {} : { detail: value.detail })
  }
}

function parseForkHistoryInteraction(value: unknown): ClaudeForkHistoryInteraction {
  if (!isRecord(value)) throw new Error('Claude forkHistory interaction 无效')
  assertOnlyKeys(
    value,
    ['kind', 'title', 'description', 'toolName', 'questions', 'status'],
    'Claude forkHistory interaction'
  )
  if (
    !['permission', 'question', 'elicitation', 'dialog'].includes(String(value.kind)) ||
    !isBoundedString(value.title, 2_000) ||
    (value.description !== undefined && !isBoundedString(value.description, 20_000)) ||
    (value.toolName !== undefined && !isBoundedString(value.toolName, 512)) ||
    !['allowed', 'denied', 'submitted', 'cancelled', 'resolved'].includes(
      String(value.status)
    ) ||
    (value.questions !== undefined &&
      (!Array.isArray(value.questions) || value.questions.length > 32))
  ) {
    throw new Error('Claude forkHistory interaction 无效')
  }
  return {
    kind: value.kind as ClaudeInteraction['kind'],
    title: value.title,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.toolName === undefined ? {} : { toolName: value.toolName }),
    ...(value.questions === undefined
      ? {}
      : { questions: value.questions.map(parseInteractionQuestion) }),
    status: value.status as ClaudeForkHistoryInteraction['status']
  }
}

function forkHistoryItemCharacters(item: ClaudeForkHistoryItem): number {
  if ('content' in item) return item.content.length
  if ('message' in item) return item.message.length
  return JSON.stringify(item).length
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Claude forkHistory value 无效')
  return value
}

export function currentClaudeTurn(
  state: ClaudeThreadState
): ClaudeTurn | undefined {
  return state.turns.at(-1)
}

export function pendingClaudeInteraction(
  turn: ClaudeTurn | undefined
): ClaudeInteraction | undefined {
  return turn?.interactions.find(({ status }) => status === 'pending')
}

export function cloneClaudeThreadState(state: ClaudeThreadState): ClaudeThreadState {
  return structuredClone(state)
}

export function summarizeClaudeState(state: ClaudeThreadState, max = 600): string {
  const turn = currentClaudeTurn(state)
  const source = turn?.text.trim() || turn?.error || latestVisibleClaudePrompt(turn) || ''
  return truncate(source.replace(/\s+/g, ' ').trim(), max)
}

export function latestVisibleClaudePrompt(turn: ClaudeTurn | undefined): string | undefined {
  if (!turn) return undefined
  const internal = new Set(turn.internalPromptIndexes || [])
  for (let index = turn.prompts.length - 1; index >= 0; index -= 1) {
    if (!internal.has(index)) return turn.prompts[index]
  }
  return undefined
}

export function parseClaudeRuntimeState(
  value: unknown
): ClaudeThreadState['runtime'] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('Claude runtime 无效')
  assertOnlyKeys(value, [
    'model',
    'cwd',
    'claudeVersion',
    'permissionMode',
    'effort',
    'capabilities',
    'models',
    'agents',
    'commands',
    'skills',
    'plugins',
    'mcpServers',
    'backgroundTasks',
    'remoteControl'
  ], 'Claude runtime')
  const result: NonNullable<ClaudeThreadState['runtime']> = {}
  for (const key of [
    'model',
    'cwd',
    'claudeVersion',
    'permissionMode',
    'effort'
  ] as const) {
    const item = value[key]
    if (item !== undefined) {
      if (!isBoundedString(item, key === 'cwd' ? 4_096 : 512)) {
        throw new Error(`Claude runtime.${key} 无效`)
      }
      result[key] = item
    }
  }
  result.capabilities = parseOptionalStringArray(
    value.capabilities,
    CLAUDE_STATE_LIMITS.runtimeCapabilities,
    2_000,
    'Claude runtime.capabilities'
  )
  result.skills = parseOptionalStringArray(
    value.skills,
    CLAUDE_STATE_LIMITS.runtimeSkills,
    2_000,
    'Claude runtime.skills'
  )
  if (value.models !== undefined) {
    result.models = parseRuntimeCollection(
      value.models,
      CLAUDE_STATE_LIMITS.runtimeModels,
      parseRuntimeModel,
      'Claude runtime.models'
    )
  }
  if (value.agents !== undefined) {
    result.agents = parseRuntimeCollection(
      value.agents,
      CLAUDE_STATE_LIMITS.runtimeAgents,
      parseRuntimeAgent,
      'Claude runtime.agents'
    )
  }
  if (value.commands !== undefined) {
    result.commands = parseRuntimeCollection(
      value.commands,
      CLAUDE_STATE_LIMITS.runtimeCommands,
      parseRuntimeCommand,
      'Claude runtime.commands'
    )
  }
  if (value.plugins !== undefined) {
    result.plugins = parseRuntimeCollection(
      value.plugins,
      CLAUDE_STATE_LIMITS.runtimePlugins,
      parseRuntimePlugin,
      'Claude runtime.plugins'
    )
  }
  if (value.mcpServers !== undefined) {
    result.mcpServers = parseRuntimeCollection(
      value.mcpServers,
      CLAUDE_STATE_LIMITS.runtimeMcpServers,
      parseRuntimeMcpServer,
      'Claude runtime.mcpServers'
    )
  }
  if (value.backgroundTasks !== undefined) {
    if (
      !Array.isArray(value.backgroundTasks) ||
      value.backgroundTasks.length > CLAUDE_STATE_LIMITS.backgroundTasks
    ) {
      throw new Error('Claude runtime.backgroundTasks 无效')
    }
    result.backgroundTasks = value.backgroundTasks.map(parseBackgroundTask)
  }
  if (value.remoteControl !== undefined) {
    result.remoteControl = parseRemoteControl(value.remoteControl)
  }
  if (result.capabilities === undefined) delete result.capabilities
  if (result.skills === undefined) delete result.skills
  return result
}

function parseRuntimeCollection<Result>(
  value: unknown,
  maximum: number,
  parse: (item: unknown) => Result,
  label: string
): Result[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} 无效`)
  }
  return value.map(parse)
}

function parseOptionalStringArray(
  value: unknown,
  maximum: number,
  maximumCharacters: number,
  label: string
): string[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    !value.every((item) => isNonEmptyBoundedString(item, maximumCharacters))
  ) {
    throw new Error(`${label} 无效`)
  }
  return [...value]
}

function parseRuntimeModel(value: unknown): ClaudeRuntimeModelInfo {
  if (!isRecord(value)) throw new Error('Claude runtime model 无效')
  assertOnlyKeys(
    value,
    ['value', 'displayName', 'description', 'resolvedModel'],
    'Claude runtime model'
  )
  if (
    !isNonEmptyBoundedString(value.value, 512) ||
    !isNonEmptyBoundedString(value.displayName, 1_000) ||
    (value.description !== undefined && !isBoundedString(value.description, 8_000)) ||
    (value.resolvedModel !== undefined &&
      !isNonEmptyBoundedString(value.resolvedModel, 512))
  ) {
    throw new Error('Claude runtime model 无效')
  }
  return {
    value: value.value,
    displayName: value.displayName,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.resolvedModel === undefined ? {} : { resolvedModel: value.resolvedModel })
  }
}

function parseRuntimeAgent(value: unknown): ClaudeRuntimeAgentInfo {
  if (!isRecord(value)) throw new Error('Claude runtime agent 无效')
  assertOnlyKeys(value, ['name', 'description', 'model'], 'Claude runtime agent')
  if (
    !isNonEmptyBoundedString(value.name, 1_000) ||
    !isBoundedString(value.description, 8_000) ||
    (value.model !== undefined && !isNonEmptyBoundedString(value.model, 512))
  ) {
    throw new Error('Claude runtime agent 无效')
  }
  return {
    name: value.name,
    description: value.description,
    ...(value.model === undefined ? {} : { model: value.model })
  }
}

function parseRuntimeCommand(value: unknown): ClaudeRuntimeCommandInfo {
  if (!isRecord(value)) throw new Error('Claude runtime command 无效')
  assertOnlyKeys(
    value,
    ['name', 'description', 'argumentHint'],
    'Claude runtime command'
  )
  if (
    !isNonEmptyBoundedString(value.name, 1_000) ||
    (value.description !== undefined && !isBoundedString(value.description, 8_000)) ||
    (value.argumentHint !== undefined && !isBoundedString(value.argumentHint, 2_000))
  ) {
    throw new Error('Claude runtime command 无效')
  }
  return {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.argumentHint === undefined ? {} : { argumentHint: value.argumentHint })
  }
}

function parseRuntimePlugin(
  value: unknown
): NonNullable<ClaudeRuntimeState['plugins']>[number] {
  if (!isRecord(value)) throw new Error('Claude runtime plugin 无效')
  assertOnlyKeys(value, ['name', 'path', 'version'], 'Claude runtime plugin')
  if (
    !isNonEmptyBoundedString(value.name, 1_000) ||
    (value.path !== undefined && !isBoundedString(value.path, 4_096)) ||
    (value.version !== undefined && !isBoundedString(value.version, 256))
  ) {
    throw new Error('Claude runtime plugin 无效')
  }
  return {
    name: value.name,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.version === undefined ? {} : { version: value.version })
  }
}

function parseRuntimeMcpServer(value: unknown): ClaudeRuntimeMcpServerInfo {
  if (!isRecord(value)) throw new Error('Claude runtime MCP server 无效')
  assertOnlyKeys(value, ['name', 'status', 'serverInfo'], 'Claude runtime MCP server')
  if (
    !isNonEmptyBoundedString(value.name, 1_000) ||
    !isNonEmptyBoundedString(value.status, 256) ||
    (value.serverInfo !== undefined && !isBoundedString(value.serverInfo, 8_000))
  ) {
    throw new Error('Claude runtime MCP server 无效')
  }
  return {
    name: value.name,
    status: value.status,
    ...(value.serverInfo === undefined ? {} : { serverInfo: value.serverInfo })
  }
}

function parseRemoteControl(value: unknown): ClaudeRemoteControlState {
  if (!isRecord(value)) throw new Error('Claude remoteControl 无效')
  assertOnlyKeys(
    value,
    ['enabled', 'sessionUrl', 'connectUrl', 'environmentId'],
    'Claude remoteControl'
  )
  if (typeof value.enabled !== 'boolean') throw new Error('Claude remoteControl 无效')
  for (const key of ['sessionUrl', 'connectUrl', 'environmentId'] as const) {
    if (value[key] !== undefined && !isNonEmptyBoundedString(value[key], 8_192)) {
      throw new Error(`Claude remoteControl.${key} 无效`)
    }
  }
  return {
    enabled: value.enabled,
    ...(value.sessionUrl === undefined
      ? {}
      : { sessionUrl: value.sessionUrl as string }),
    ...(value.connectUrl === undefined
      ? {}
      : { connectUrl: value.connectUrl as string }),
    ...(value.environmentId === undefined
      ? {}
      : { environmentId: value.environmentId as string })
  }
}

function parseBackgroundTask(value: unknown): ClaudeBackgroundTask {
  if (
    !isRecord(value) ||
    !isNonEmptyBoundedString(value.id, 512) ||
    (value.type !== undefined && !isBoundedString(value.type, 256)) ||
    !isNonEmptyBoundedString(value.description, 8_000) ||
    !isNonEmptyBoundedString(value.status, 256)
  ) {
    throw new Error('Claude background task 无效')
  }
  assertOnlyKeys(value, ['id', 'type', 'description', 'status'], 'Claude background task')
  return {
    id: value.id,
    ...(value.type === undefined ? {} : { type: value.type }),
    description: value.description,
    status: value.status
  }
}

function parseTurn(value: unknown): ClaudeTurn {
  if (
    !isRecord(value) ||
    !isNonEmptyBoundedString(value.executionId, 512) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    throw new Error('Claude turn 无效')
  }
  assertOnlyKeys(value, [
    'executionId',
    'createdAt',
    'updatedAt',
    'finishedAt',
    'prompts',
    'promptAttachments',
    'internalPromptIndexes',
    'text',
    'reasoning',
    'status',
    'statusLabel',
    'foreground',
    'error',
    'plan',
    'planExplanation',
    'activities',
    'interactions',
    'notices',
    'timeline',
    'usage',
    'diff',
    'review',
    'compacted'
  ], 'Claude turn')
  if (
    !Array.isArray(value.prompts) ||
    value.prompts.length > CLAUDE_STATE_LIMITS.promptsPerTurn ||
    !value.prompts.every((entry) =>
      isBoundedString(entry, CLAUDE_STATE_LIMITS.promptCharacters)
    ) ||
    !Array.isArray(value.promptAttachments) ||
    value.promptAttachments.length !== value.prompts.length ||
    !value.promptAttachments.every((attachments) =>
      Array.isArray(attachments) &&
      attachments.length <= CLAUDE_STATE_LIMITS.attachmentsPerPrompt &&
      attachments.every(isClaudeInputAttachment) &&
      new Set(attachments.map((attachment) => attachment.id)).size === attachments.length
    ) ||
    !isBoundedString(value.text, CLAUDE_STATE_LIMITS.textCharacters) ||
    !isBoundedString(value.reasoning, CLAUDE_STATE_LIMITS.reasoningCharacters) ||
    !isTurnStatus(value.status)
  ) {
    throw new Error('Claude turn content 无效')
  }
  if (value.status === 'running'
    ? value.finishedAt !== undefined
    : !isTimestamp(value.finishedAt) || value.finishedAt < value.createdAt || value.finishedAt > value.updatedAt
  ) {
    throw new Error('Claude turn finishedAt 无效')
  }
  const promptCount = value.prompts.length
  if (
    value.internalPromptIndexes !== undefined && (
      !Array.isArray(value.internalPromptIndexes) ||
      value.internalPromptIndexes.length > promptCount ||
      !value.internalPromptIndexes.every((entry) =>
        Number.isSafeInteger(entry) && Number(entry) >= 0 && Number(entry) < promptCount
      ) ||
      new Set(value.internalPromptIndexes).size !== value.internalPromptIndexes.length
    )
  ) {
    throw new Error('Claude internal prompt indexes 无效')
  }
  if (value.statusLabel !== undefined && !isBoundedString(value.statusLabel, 512)) {
    throw new Error('Claude turn statusLabel 无效')
  }
  const foreground =
    value.foreground === undefined ? undefined : parseForeground(value.foreground)
  if (
    value.error !== undefined &&
    !isBoundedString(value.error, CLAUDE_STATE_LIMITS.errorCharacters)
  ) {
    throw new Error('Claude turn error 无效')
  }
  if (
    (value.diff !== undefined &&
      !isBoundedString(value.diff, CLAUDE_STATE_LIMITS.diffCharacters)) ||
    (value.review !== undefined &&
      !isBoundedString(value.review, CLAUDE_STATE_LIMITS.reviewCharacters)) ||
    (value.compacted !== undefined && value.compacted !== true)
  ) {
    throw new Error('Claude turn extended surface 无效')
  }
  if (
    !Array.isArray(value.plan) ||
    value.plan.length > CLAUDE_STATE_LIMITS.planStepsPerTurn
  ) {
    throw new Error('Claude plan 无效')
  }
  if (
    value.planExplanation !== undefined &&
    !isBoundedString(
      value.planExplanation,
      CLAUDE_STATE_LIMITS.planExplanationCharacters
    )
  ) {
    throw new Error('Claude planExplanation 无效')
  }
  if (
    !Array.isArray(value.activities) ||
    value.activities.length > CLAUDE_STATE_LIMITS.activitiesPerTurn ||
    !Array.isArray(value.interactions) ||
    value.interactions.length > CLAUDE_STATE_LIMITS.interactionsPerTurn ||
    !Array.isArray(value.notices) ||
    value.notices.length > CLAUDE_STATE_LIMITS.noticesPerTurn ||
    !Array.isArray(value.timeline) ||
    value.timeline.length > CLAUDE_STATE_LIMITS.timelineItemsPerTurn
  ) {
    throw new Error('Claude turn collections 无效')
  }
  const promptAttachments = value.promptAttachments as ClaudeInputAttachment[][]
  const turn: ClaudeTurn = {
    executionId: value.executionId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt as number }),
    prompts: [...value.prompts],
    promptAttachments: promptAttachments.map((attachments) =>
      attachments.map((attachment) => ({ ...attachment }))
    ),
    ...(value.internalPromptIndexes === undefined
      ? {}
      : { internalPromptIndexes: [...value.internalPromptIndexes] as number[] }),
    text: value.text,
    reasoning: value.reasoning,
    status: value.status,
    ...(value.statusLabel === undefined ? {} : { statusLabel: value.statusLabel }),
    ...(foreground === undefined ? {} : { foreground }),
    ...(value.error === undefined ? {} : { error: value.error }),
    plan: value.plan.map(parsePlanStep),
    ...(value.planExplanation === undefined
      ? {}
      : { planExplanation: value.planExplanation }),
    activities: value.activities.map(parseActivity),
    interactions: value.interactions.map(parseInteraction),
    notices: value.notices.map(parseNotice),
    timeline: value.timeline.map((item) =>
      parseTimelineItem(item, value.updatedAt as number)
    ),
    ...(value.usage === undefined ? {} : { usage: parseUsage(value.usage) }),
    ...(value.diff === undefined ? {} : { diff: value.diff }),
    ...(value.review === undefined ? {} : { review: value.review }),
    ...(value.compacted === true ? { compacted: true as const } : {})
  }
  validateTurnReferences(turn)
  return turn
}

function isClaudeInputAttachment(value: unknown): value is ClaudeInputAttachment {
  if (!isRecord(value)) return false
  const allowed = new Set(['id', 'name', 'mimeType', 'size', 'kind'])
  return (
    !Object.keys(value).some((key) => !allowed.has(key)) &&
    isNonEmptyBoundedString(
      value.id,
      CLAUDE_STATE_LIMITS.attachmentIdCharacters
    ) &&
    isNonEmptyBoundedString(
      value.name,
      CLAUDE_STATE_LIMITS.attachmentNameCharacters
    ) &&
    isNonEmptyBoundedString(
      value.mimeType,
      CLAUDE_STATE_LIMITS.attachmentMimeTypeCharacters
    ) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0 &&
    ['image', 'audio', 'file'].includes(String(value.kind))
  )
}

function parsePlanStep(value: unknown): ClaudePlanStep {
  if (
    !isRecord(value) ||
    !isNonEmptyBoundedString(value.step, CLAUDE_STATE_LIMITS.planStepCharacters) ||
    !['pending', 'inProgress', 'completed'].includes(String(value.status))
  ) {
    throw new Error('Claude plan step 无效')
  }
  assertOnlyKeys(value, ['step', 'status'], 'Claude plan step')
  return { step: value.step, status: value.status as ClaudePlanStep['status'] }
}

function parseForeground(value: unknown): HarnessBartForeground {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1
  ) {
    throw new Error('Claude turn foreground 无效')
  }
  const sequence = Number(value.sequence)
  if (value.kind === 'assistant-text') {
    assertOnlyKeys(value, ['sequence', 'kind'], 'Claude turn foreground')
    return { kind: 'assistant-text', sequence }
  }
  if (value.kind === 'reasoning') {
    assertOnlyKeys(value, ['sequence', 'kind', 'text'], 'Claude turn foreground')
    if (!isNonEmptyBoundedString(value.text, CLAUDE_STATE_LIMITS.reasoningCharacters)) {
      throw new Error('Claude turn foreground reasoning 无效')
    }
    return { kind: 'reasoning', sequence, text: value.text }
  }
  if (value.kind === 'tool-call') {
    assertOnlyKeys(value, ['sequence', 'kind', 'callId', 'toolName'], 'Claude turn foreground')
    if (
      !isNonEmptyBoundedString(value.callId, 1_024) ||
      !isNonEmptyBoundedString(
        value.toolName,
        CLAUDE_STATE_LIMITS.foregroundToolNameCharacters
      )
    ) {
      throw new Error('Claude turn foreground tool-call 无效')
    }
    return { kind: 'tool-call', sequence, callId: value.callId, toolName: value.toolName }
  }
  throw new Error('Claude turn foreground kind 无效')
}

function parseActivity(value: unknown): ClaudeActivity {
  if (
    !isRecord(value) ||
    !isNonEmptyBoundedString(value.id, 512) ||
    !isActivityKind(value.kind) ||
    !isBoundedString(value.label, CLAUDE_STATE_LIMITS.activityLabelCharacters) ||
    !isActivityStatus(value.status) ||
    (value.toolName !== undefined &&
      !isNonEmptyBoundedString(
        value.toolName,
        CLAUDE_STATE_LIMITS.activityToolNameCharacters
      )) ||
    (value.detail !== undefined &&
      !isBoundedString(value.detail, CLAUDE_STATE_LIMITS.activityDetailCharacters)) ||
    (value.parentId !== undefined && !isBoundedString(value.parentId, 512)) ||
    (value.taskId !== undefined && !isBoundedString(value.taskId, 512))
  ) {
    throw new Error('Claude activity 无效')
  }
  assertOnlyKeys(
    value,
    ['id', 'kind', 'label', 'status', 'toolName', 'detail', 'parentId', 'taskId'],
    'Claude activity'
  )
  return {
    id: value.id,
    kind: value.kind,
    label: value.label,
    status: value.status,
    ...(value.toolName === undefined ? {} : { toolName: value.toolName }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.parentId === undefined ? {} : { parentId: value.parentId }),
    ...(value.taskId === undefined ? {} : { taskId: value.taskId })
  }
}

function parseInteraction(value: unknown): ClaudeInteraction {
  if (
    !isRecord(value) ||
    !isNonEmptyBoundedString(value.id, 512) ||
    !['permission', 'question', 'elicitation', 'dialog'].includes(String(value.kind)) ||
    !isBoundedString(value.title, 2_000) ||
    !isInteractionStatus(value.status)
  ) {
    throw new Error('Claude interaction 无效')
  }
  assertOnlyKeys(value, [
    'id',
    'kind',
    'title',
    'description',
    'toolName',
    'canRemember',
    'input',
    'schema',
    'elicitationMode',
    'url',
    'elicitationId',
    'serverName',
    'status',
    'questions'
  ], 'Claude interaction')
  if (
    value.description !== undefined &&
    !isBoundedString(value.description, 20_000)
  ) {
    throw new Error('Claude interaction description 无效')
  }
  if (value.toolName !== undefined && !isBoundedString(value.toolName, 512)) {
    throw new Error('Claude interaction toolName 无效')
  }
  if (value.canRemember !== undefined && typeof value.canRemember !== 'boolean') {
    throw new Error('Claude interaction canRemember 无效')
  }
  if (value.input !== undefined && !isBoundedInteractionJson(value.input)) {
    throw new Error('Claude interaction input 无效')
  }
  if (value.schema !== undefined && !isBoundedInteractionJson(value.schema)) {
    throw new Error('Claude interaction schema 无效')
  }
  if (
    value.elicitationMode !== undefined &&
    !['form', 'url'].includes(String(value.elicitationMode))
  ) {
    throw new Error('Claude interaction elicitationMode 无效')
  }
  for (const [key, limit] of [
    ['url', 8_192],
    ['elicitationId', 512],
    ['serverName', 2_000]
  ] as const) {
    if (value[key] !== undefined && !isBoundedString(value[key], limit)) {
      throw new Error(`Claude interaction ${key} 无效`)
    }
  }
  if (
    value.kind !== 'elicitation' &&
    (value.elicitationMode !== undefined || value.url !== undefined ||
      value.elicitationId !== undefined || value.serverName !== undefined)
  ) {
    throw new Error('非 elicitation interaction 含原生 elicitation 字段')
  }
  if (
    value.questions !== undefined &&
    (!Array.isArray(value.questions) || value.questions.length > 32)
  ) {
    throw new Error('Claude interaction questions 无效')
  }
  return {
    id: value.id,
    kind: value.kind as ClaudeInteraction['kind'],
    title: value.title,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.toolName === undefined ? {} : { toolName: value.toolName }),
    ...(value.canRemember === undefined ? {} : { canRemember: value.canRemember }),
    ...(value.input === undefined ? {} : { input: structuredClone(value.input) }),
    ...(value.schema === undefined ? {} : { schema: structuredClone(value.schema) }),
    ...(value.elicitationMode === undefined
      ? {}
      : { elicitationMode: value.elicitationMode as 'form' | 'url' }),
    ...(value.url === undefined ? {} : { url: value.url as string }),
    ...(value.elicitationId === undefined
      ? {}
      : { elicitationId: value.elicitationId as string }),
    ...(value.serverName === undefined
      ? {}
      : { serverName: value.serverName as string }),
    status: value.status,
    ...(value.questions === undefined
      ? {}
      : { questions: value.questions.map(parseInteractionQuestion) })
  }
}

function parseInteractionQuestion(value: unknown): NonNullable<ClaudeInteraction['questions']>[number] {
  if (
    !isRecord(value) ||
    !isBoundedString(value.question, 10_000) ||
    (value.header !== undefined && !isBoundedString(value.header, 1_000)) ||
    typeof value.multiSelect !== 'boolean' ||
    !Array.isArray(value.options) ||
    value.options.length > 32
  ) {
    throw new Error('Claude interaction question 无效')
  }
  assertOnlyKeys(
    value,
    ['question', 'header', 'multiSelect', 'options'],
    'Claude interaction question'
  )
  return {
    question: value.question,
    ...(value.header === undefined ? {} : { header: value.header }),
    multiSelect: value.multiSelect,
    options: value.options.map((option) => {
      if (
        !isRecord(option) ||
        !isBoundedString(option.label, 2_000) ||
        (option.description !== undefined &&
          !isBoundedString(option.description, 10_000))
      ) {
        throw new Error('Claude interaction option 无效')
      }
      assertOnlyKeys(
        option,
        ['label', 'description'],
        'Claude interaction option'
      )
      return {
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description })
      }
    })
  }
}

function parseNotice(value: unknown): ClaudeNotice {
  if (
    !isRecord(value) ||
    !isNonEmptyBoundedString(value.id, 512) ||
    !['info', 'warning', 'error'].includes(String(value.level)) ||
    !isBoundedString(value.message, CLAUDE_STATE_LIMITS.noticeCharacters)
  ) {
    throw new Error('Claude notice 无效')
  }
  assertOnlyKeys(value, ['id', 'level', 'message'], 'Claude notice')
  return {
    id: value.id,
    level: value.level as ClaudeNotice['level'],
    message: value.message
  }
}

function parseUsage(value: unknown): ClaudeUsage {
  if (!isRecord(value) || !Object.values(value).every(isNonNegativeNumber)) {
    throw new Error('Claude usage 无效')
  }
  const allowed = new Set<keyof ClaudeUsage>([
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cachedTokens',
    'cacheWriteTokens',
    'totalTokens',
    'contextTokens',
    'contextWindow',
    'costUsd'
  ])
  if (Object.keys(value).some((key) => !allowed.has(key as keyof ClaudeUsage))) {
    throw new Error('Claude usage 包含未知字段')
  }
  return { ...value } as ClaudeUsage
}

function parseTimelineItem(value: unknown, updatedAt: number): ClaudeTimelineItem {
  if (
    !isRecord(value) ||
    !isNonEmptyBoundedString(value.id, 512) ||
    !isTimestamp(value.createdAt) ||
    value.createdAt > updatedAt
  ) {
    throw new Error('Claude timeline item 无效')
  }
  const base = { id: value.id, createdAt: value.createdAt }
  if (value.kind === 'user-message' && Number.isSafeInteger(value.promptIndex) && Number(value.promptIndex) >= 0) {
    assertOnlyKeys(
      value,
      ['id', 'kind', 'createdAt', 'promptIndex', 'checkpointId'],
      'Claude user-message timeline item'
    )
    if (
      value.checkpointId !== undefined &&
      !isNonEmptyBoundedString(value.checkpointId, 512)
    ) {
      throw new Error('Claude timeline checkpointId 无效')
    }
    return {
      ...base,
      kind: value.kind,
      promptIndex: Number(value.promptIndex),
      ...(value.checkpointId === undefined
        ? {}
        : { checkpointId: value.checkpointId })
    }
  }
  if (
    value.kind === 'assistant' &&
    isBoundedString(value.content, CLAUDE_STATE_LIMITS.textCharacters) &&
    ['complete', 'streaming', 'failed', 'cancelled'].includes(String(value.status))
  ) {
    assertOnlyKeys(
      value,
      ['id', 'kind', 'createdAt', 'content', 'status', 'messageId'],
      'Claude assistant timeline item'
    )
    if (value.messageId !== undefined && !isNonEmptyBoundedString(value.messageId, 512)) {
      throw new Error('Claude timeline messageId 无效')
    }
    return {
      ...base,
      kind: value.kind,
      content: value.content,
      status: value.status as ClaudeTimelineTextStatus,
      ...(value.messageId === undefined ? {} : { messageId: value.messageId })
    }
  }
  if (
    value.kind === 'reasoning' &&
    isBoundedString(value.content, CLAUDE_STATE_LIMITS.reasoningCharacters)
  ) {
    assertOnlyKeys(
      value,
      ['id', 'kind', 'createdAt', 'content'],
      'Claude reasoning timeline item'
    )
    return { ...base, kind: value.kind, content: value.content }
  }
  if (value.kind === 'activity') {
    assertOnlyKeys(
      value,
      ['id', 'kind', 'createdAt', 'activity'],
      'Claude activity timeline item'
    )
    return { ...base, kind: value.kind, activity: parseActivity(value.activity) }
  }
  if (value.kind === 'interaction') {
    assertOnlyKeys(
      value,
      ['id', 'kind', 'createdAt', 'interaction'],
      'Claude interaction timeline item'
    )
    return {
      ...base,
      kind: value.kind,
      interaction: parseInteraction(value.interaction)
    }
  }
  if (value.kind === 'notice') {
    assertOnlyKeys(
      value,
      ['id', 'kind', 'createdAt', 'notice'],
      'Claude notice timeline item'
    )
    return { ...base, kind: value.kind, notice: parseNotice(value.notice) }
  }
  if (value.kind === 'plan') {
    assertOnlyKeys(
      value,
      ['id', 'kind', 'createdAt', 'plan', 'explanation'],
      'Claude plan timeline item'
    )
    if (
      !Array.isArray(value.plan) ||
      value.plan.length > CLAUDE_STATE_LIMITS.planStepsPerTurn ||
      (value.explanation !== undefined &&
        !isBoundedString(value.explanation, CLAUDE_STATE_LIMITS.planExplanationCharacters))
    ) {
      throw new Error('Claude plan timeline item 无效')
    }
    return {
      ...base,
      kind: value.kind,
      plan: value.plan.map(parsePlanStep),
      ...(value.explanation === undefined ? {} : { explanation: value.explanation })
    }
  }
  if (value.kind === 'error') {
    assertOnlyKeys(
      value,
      ['id', 'kind', 'createdAt', 'message'],
      'Claude error timeline item'
    )
    if (!isBoundedString(value.message, CLAUDE_STATE_LIMITS.errorCharacters)) {
      throw new Error('Claude error timeline item 无效')
    }
    return { ...base, kind: value.kind, message: value.message }
  }
  if (value.kind === 'usage') {
    assertOnlyKeys(
      value,
      ['id', 'kind', 'createdAt', 'usage'],
      'Claude usage timeline item'
    )
    return { ...base, kind: value.kind, usage: parseUsage(value.usage) }
  }
  if (value.kind === 'diff' || value.kind === 'review') {
    assertOnlyKeys(
      value,
      ['id', 'kind', 'createdAt', 'content'],
      `Claude ${value.kind} timeline item`
    )
    const maximum = value.kind === 'diff'
      ? CLAUDE_STATE_LIMITS.diffCharacters
      : CLAUDE_STATE_LIMITS.reviewCharacters
    if (!isBoundedString(value.content, maximum)) {
      throw new Error(`Claude ${value.kind} timeline item 无效`)
    }
    return { ...base, kind: value.kind, content: value.content }
  }
  if (value.kind === 'context-compaction') {
    assertOnlyKeys(
      value,
      ['id', 'kind', 'createdAt'],
      'Claude context compaction timeline item'
    )
    return { ...base, kind: value.kind }
  }
  throw new Error('Claude timeline item kind 无效')
}

function validateTurnReferences(turn: ClaudeTurn): void {
  if (!unique(turn.activities) || !unique(turn.interactions) || !unique(turn.notices)) {
    throw new Error('Claude turn id 重复')
  }
  const timelineIds = new Set<string>()
  let previousAt = turn.createdAt
  let contentCharacters = 0
  for (const item of turn.timeline) {
    if (timelineIds.has(item.id) || item.createdAt < previousAt) {
      throw new Error('Claude timeline 顺序无效')
    }
    timelineIds.add(item.id)
    previousAt = item.createdAt
    if (item.kind === 'user-message' && item.promptIndex >= turn.prompts.length) {
      throw new Error('Claude timeline prompt 引用无效')
    }
    if (
      item.kind === 'assistant' ||
      item.kind === 'reasoning' ||
      item.kind === 'diff' ||
      item.kind === 'review'
    ) {
      contentCharacters += item.content.length
    }
    if (item.kind === 'error') contentCharacters += item.message.length
  }
  if (contentCharacters > CLAUDE_STATE_LIMITS.timelineContentCharacters) {
    throw new Error('Claude timeline content 超限')
  }
}

function isTurnStatus(value: unknown): value is ClaudeTurnStatus {
  return ['running', 'completed', 'failed', 'interrupted'].includes(String(value))
}

function isActivityKind(value: unknown): value is ClaudeActivityKind {
  return [
    'command',
    'file',
    'tool',
    'search',
    'thinking',
    'agent',
    'task',
    'hook',
    'review',
    'subagent'
  ].includes(String(value))
}

function isActivityStatus(value: unknown): value is ClaudeActivityStatus {
  return ['running', 'completed', 'failed', 'cancelled'].includes(String(value))
}

function isInteractionStatus(value: unknown): value is ClaudeInteractionStatus {
  return ['pending', 'allowed', 'denied', 'submitted', 'cancelled', 'resolved'].includes(
    String(value)
  )
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
}

function isNonEmptyBoundedString(value: unknown, max: number): value is string {
  return isBoundedString(value, max) && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string
): void {
  const allowed = new Set(allowedKeys)
  const unexpected = Object.keys(value).find((key) => !allowed.has(key))
  if (unexpected) throw new Error(`${label} 包含未知字段：${unexpected}`)
}

function unique(values: readonly { id: string }[]): boolean {
  return new Set(values.map(({ id }) => id)).size === values.length
}

export function isBoundedInteractionJson(value: unknown): value is JsonValue {
  let characters = 0
  let nodes = 0
  const seen = new WeakSet<object>()
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 }
  ]
  while (pending.length > 0) {
    const item = pending.pop()!
    nodes += 1
    if (
      nodes > CLAUDE_STATE_LIMITS.interactionJsonNodes ||
      item.depth > CLAUDE_STATE_LIMITS.interactionJsonDepth
    ) {
      return false
    }
    if (item.value === null || typeof item.value === 'boolean') continue
    if (typeof item.value === 'number') {
      if (!Number.isFinite(item.value)) return false
      characters += 32
    } else if (typeof item.value === 'string') {
      if (item.value.includes('\0')) return false
      characters += item.value.length
    } else if (typeof item.value === 'object') {
      if (seen.has(item.value)) return false
      seen.add(item.value)
      if (Array.isArray(item.value)) {
        for (const child of item.value) {
          pending.push({ value: child, depth: item.depth + 1 })
        }
      } else {
        for (const [key, child] of Object.entries(item.value)) {
          if (key.includes('\0')) return false
          characters += key.length
          pending.push({ value: child, depth: item.depth + 1 })
        }
      }
    } else {
      return false
    }
    if (characters > CLAUDE_STATE_LIMITS.interactionJsonCharacters) return false
  }
  return true
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
