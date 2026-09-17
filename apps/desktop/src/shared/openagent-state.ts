import { isJsonValue, isThreadEmoji, isThreadPublicObservation, type JsonValue } from '@openagent/contracts'
import {
  type AgentThreadRecord,
  type BartMessage,
  type BartThreadRecord,
  type BartTranscriptItem,
  type ThreadPublicObservation,
  type PublicExecution,
  type ThreadRecord
} from '@openagent/contracts'
import { isHarnessId, type HarnessId } from './harnesses'
import {
  assertOpenAgentSettingsShell,
  type OpenAgentSettings
} from './openagent-settings'
import {
  MAX_REPORT_HTML_CHARACTERS,
  exceedsUnicodeLength,
  MAX_REPORT_RELATED_THREADS,
  MAX_REPORT_TITLE_LENGTH,
  type ReportThreadRecord,
  type ReportExecutionReference
} from './report-thread'
import { threadTagKey } from '@openagent/contracts'

const MAX_IDENTIFIER_LENGTH = 128
const MAX_THREAD_TITLE_LENGTH = 60
const MAX_TAG_LENGTH = 32
const MAX_TAG_DESCRIPTION_LENGTH = 120
const MAX_CWD_LENGTH = 4096
export const MAX_TAG_POOL_SIZE = 30
const STALE_BART_TOOL_RESULT = {
  error: 'Bart execution was interrupted during restart'
} as const
const TERMINATED_BART_TOOL_RESULT = {
  error: 'Bart execution terminated before tool completion'
} as const

export interface OpenAgentTagPoolEntry {
  readonly name: string
  readonly description: string
}

/**
 * Current-only application state for the Harness Plugin architecture.
 *
 * The main persistence adapter owns the current `openagent-state-v6` SQLite
 * partitioned layout. This module defines the logical state without an
 * older-shape parser or migration path.
 */
export interface OpenAgentState {
  readonly threads: readonly ThreadRecord[]
  readonly reports: readonly ReportThreadRecord[]
  readonly tagPool: readonly OpenAgentTagPoolEntry[]
  readonly selectedThreadId: string | null
  readonly settings: OpenAgentSettings
}

export type OpenAgentStateMutation =
  | {
      readonly type: 'add-agent-thread'
      readonly thread: AgentThreadRecord
    }
  | {
      /** One revision-guarded durable lifecycle boundary used by Thread fork. */
      readonly type: 'add-and-select-agent-thread'
      readonly sourceThreadId: string
      readonly expectedSourceRevision: number
      readonly thread: AgentThreadRecord
    }
  | {
      readonly type: 'replace-agent-thread'
      readonly threadId: string
      readonly expectedRevision: number
      readonly thread: AgentThreadRecord
    }
  | {
      /** Apply classifier-owned fields against the current Thread, independent of streaming revisions. */
      readonly type: 'update-agent-thread-metadata'
      readonly threadId: string
      readonly title: string
      readonly emoji: string
      readonly tags: readonly string[]
      readonly onlyIfPending?: boolean
      readonly updatedAt: number
    }
  | {
      readonly type: 'set-agent-thread-archived'
      readonly threadId: string
      readonly archived: boolean
    }
  | {
      readonly type: 'update-agent-thread-settings'
      readonly threadId: string
      readonly expectedSource: string
      readonly settings: JsonValue
      readonly updatedAt: number
    }
  | {
      /** Atomic Plugin state and its derived public observation. */
      readonly type: 'replace-thread-session-state'
      readonly threadId: string
      readonly expectedRevision: number
      readonly sessionState: JsonValue
      readonly observation: ThreadPublicObservation
      readonly updatedAt: number
    }
  | {
      readonly type: 'replace-thread-settings'
      readonly threadId: string
      readonly expectedRevision: number
      readonly settings: JsonValue
      readonly updatedAt: number
    }
  | {
      readonly type: 'delete-agent-thread'
      readonly threadId: string
    }
  | {
      readonly type: 'replace-bart-thread'
      readonly expectedThreadId: string
      readonly threadId: string
      /** Concrete Harness selected from the current host preference. */
      readonly hostHarnessId: HarnessId
      readonly settings: OpenAgentSettings
      readonly threadSettings: JsonValue
      readonly cwd: string
      readonly createdAt: number
    }
  | {
      readonly type: 'append-bart-transcript-item'
      readonly threadId: string
      readonly item: BartTranscriptItem
      readonly updatedAt: number
    }
  | {
      readonly type: 'finish-bart-execution'
      readonly threadId: string
      readonly executionId: string
      readonly outcome: Extract<
        PublicExecution,
        { readonly finishedAt: number }
      >['status']
      readonly updatedAt: number
    }
  | {
      readonly type: 'complete-bart-tool-operation'
      readonly threadId: string
      readonly executionId: string
      readonly callId: string
      readonly result: JsonValue
      readonly isError?: boolean
      readonly completedAt: number
      readonly updatedAt: number
    }
  | {
      readonly type: 'settle-stale-bart-runtime'
      readonly threadId: string
      readonly updatedAt: number
    }
  | {
      /** Archive the Report and Agents whose references still match latest, in one durable command. */
      readonly type: 'archive-report'
      readonly reportId: string
      /** Scope snapshot only; the reducer checks current references and public observations. */
      readonly relatedThreadIds: readonly string[]
    }
  | {
      readonly type: 'replace-reports'
      readonly reports: readonly ReportThreadRecord[]
      /** Commit preconditions only, never persisted; omitted for ordinary report edits. */
      readonly relatedExecutionChecks?: readonly ReportExecutionReference[]
    }
  | {
      readonly type: 'replace-tag-pool'
      readonly tagPool: readonly OpenAgentTagPoolEntry[]
    }
  | {
      readonly type: 'select-thread'
      readonly threadId: string | null
    }
  | {
      readonly type: 'replace-settings'
      readonly settings: OpenAgentSettings
    }

export interface CreateOpenAgentStateInput {
  readonly bartThreadId: string
  readonly hostHarnessId: HarnessId
  readonly bartThreadSettings: JsonValue
  readonly bartCwd: string
  readonly createdAt: number
  readonly selectedThreadId: string | null
  readonly settings: OpenAgentSettings
}

export function createOpenAgentState(
  input: CreateOpenAgentStateInput
): OpenAgentState {
  assertIdentifier(input.bartThreadId, 'Bart Thread ID')
  assertTimestamp(input.createdAt, 'Bart createdAt')
  if (!isHarnessId(input.hostHarnessId)) throw new Error('未知 Harness ID')
  if (!isJson(input.bartThreadSettings)) throw new Error('Bart Thread settings 必须是 JSON')
  if (!boundedString(input.bartCwd, MAX_CWD_LENGTH, false) || input.bartCwd.includes('\0')) {
    throw new Error('Bart Thread cwd 无效')
  }
  assertSettings(input.settings)
  assertBartHostMatchesPreference(input.settings, input.hostHarnessId)
  if (input.selectedThreadId !== null && input.selectedThreadId !== input.bartThreadId) {
    throw new Error('初始 selectedThreadId 必须是 Bart 或 null')
  }
  const bart: BartThreadRecord = {
    id: input.bartThreadId,
    bart: true,
    harnessId: input.hostHarnessId,
    revision: 0,
    sessionState: null,
    observation: { latestExecution: null, backgroundWork: null },
    title: 'Bart',
    tags: [],
    cwd: input.bartCwd,
    settings: immutable(input.bartThreadSettings),
    transcript: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  }
  return immutable({
    threads: [bart],
    reports: [],
    tagPool: [],
    selectedThreadId: input.selectedThreadId,
    settings: immutable(input.settings)
  })
}

export function parseOpenAgentState(value: unknown): OpenAgentState | null {
  if (!isOpenAgentState(value)) return null
  return immutable(value)
}

export function isOpenAgentState(value: unknown): value is OpenAgentState {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'threads', 'reports', 'tagPool', 'selectedThreadId', 'settings'
  ])) return false
  if (!Array.isArray(value.threads) || !Array.isArray(value.reports) ||
      !Array.isArray(value.tagPool)) return false
  if (!value.threads.every(isThreadRecord) || !unique(value.threads.map(thread => thread.id))) {
    return false
  }
  const barts = value.threads.filter(isBartThreadRecord)
  if (barts.length !== 1) return false
  if (!value.reports.every(isReportThreadRecord) ||
      !unique(value.reports.map(report => report.id))) return false
  if (value.tagPool.length > MAX_TAG_POOL_SIZE ||
      !value.tagPool.every(isTagPoolEntry) ||
      !unique(value.tagPool.map(entry => threadTagKey(entry.name)))) return false
  if (!isSettings(value.settings)) return false
  if (!bartHostMatchesPreference(value.settings, barts[0].harnessId)) return false
  return value.selectedThreadId === null || (
    typeof value.selectedThreadId === 'string' &&
    value.threads.some(thread => thread.id === value.selectedThreadId)
  )
}

export function reduceOpenAgentState(
  state: OpenAgentState,
  mutation: OpenAgentStateMutation
): OpenAgentState {
  switch (mutation.type) {
    case 'add-agent-thread':
      return addAgentThread(state, mutation.thread)
    case 'add-and-select-agent-thread':
      return addAndSelectForkedAgentThread(state, mutation)
    case 'replace-agent-thread':
      return replaceAgentThread(state, mutation)
    case 'update-agent-thread-metadata':
      return updateAgentThreadMetadata(state, mutation)
    case 'set-agent-thread-archived': {
      const current = readAgentThread(state, mutation.threadId)
      if (typeof mutation.archived !== 'boolean') throw new Error('archived 必须是 boolean')
      if (current.archived === mutation.archived) return state
      return replaceAgentThread(state, { type: 'replace-agent-thread', threadId: current.id,
        expectedRevision: current.revision,
        thread: { ...current, archived: mutation.archived, revision: current.revision + 1 } })
    }
    case 'update-agent-thread-settings':
      return updateAgentThreadSettings(state, mutation)
    case 'replace-thread-session-state':
      return replaceThreadSessionState(state, mutation)
    case 'replace-thread-settings':
      return replaceThreadSettings(state, mutation)
    case 'delete-agent-thread':
      return deleteAgentThread(state, mutation.threadId)
    case 'replace-bart-thread':
      return replaceBartThread(state, mutation)
    case 'append-bart-transcript-item':
      return appendBartTranscriptItem(state, mutation)
    case 'finish-bart-execution':
      return finishBartExecution(state, mutation)
    case 'complete-bart-tool-operation':
      return completeBartToolOperation(state, mutation)
    case 'settle-stale-bart-runtime':
      return settleStaleBartRuntime(state, mutation)
    case 'archive-report':
      return archiveReport(state, mutation)
    case 'replace-reports':
      return replaceReports(state, mutation.reports)
    case 'replace-tag-pool':
      return replaceTagPool(state, mutation.tagPool)
    case 'select-thread':
      return selectThread(state, mutation.threadId)
    case 'replace-settings':
      return replaceSettings(state, mutation.settings)
  }
}

export function readThread(
  state: OpenAgentState,
  threadId: string
): ThreadRecord {
  const thread = state.threads.find(candidate => candidate.id === threadId)
  if (!thread) throw new Error(`Thread 不存在: ${threadId}`)
  return thread
}

export function readAgentThread(
  state: OpenAgentState,
  threadId: string
): AgentThreadRecord {
  const thread = readThread(state, threadId)
  if (isBartThreadRecord(thread)) throw new Error('Bart 不是 Agent Thread')
  return thread
}

export function readBartThread(state: OpenAgentState): BartThreadRecord {
  const thread = state.threads.find(isBartThreadRecord)
  if (!thread) throw new Error('缺少 Bart Thread')
  return thread
}

export function readHarnessThread(
  state: OpenAgentState,
  threadId: string
): ThreadRecord {
  return readThread(state, threadId)
}

export function isBartThreadRecord(
  value: ThreadRecord | unknown
): value is BartThreadRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'bart', 'harnessId', 'revision', 'sessionState', 'observation',
    'title', 'titlePending', 'emoji', 'tags', 'cwd', 'worktree', 'settings', 'transcript',
    'createdAt', 'updatedAt'
  ])) return false
  if (value.bart !== true || !validIdentifier(value.id) ||
      !isHarnessThreadFields(value) ||
      !Array.isArray(value.transcript) ||
      !value.transcript.every(isBartTranscriptItem) ||
      !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)) {
    return false
  }

  const transcript = value.transcript
  const createdAt = value.createdAt
  const updatedAt = value.updatedAt
  const toolCallIds: string[] = []
  for (const item of transcript) {
    if (item.type === 'tool-operation') toolCallIds.push(item.callId)
  }

  return unique(transcript.map(item => item.id)) &&
    unique(toolCallIds) && orderedByCreatedAt(transcript) &&
    updatedAt >= createdAt && transcript.every(item => (
      item.createdAt <= updatedAt && (
        item.type !== 'tool-operation' || item.completedAt === undefined ||
        item.completedAt <= updatedAt
      )
    ))
}

export function isAgentThreadRecord(value: unknown): value is AgentThreadRecord {
  if (!isRecord(value) || Object.hasOwn(value, 'bart') || !hasOnlyKeys(value, [
    'id', 'harnessId', 'revision', 'sessionState', 'observation', 'title', 'titlePending',
    'emoji', 'tags', 'cwd', 'worktree', 'settings', 'createdAt', 'updatedAt', 'archived'
  ])) return false
  if (typeof value.archived !== 'boolean') return false
  if (!validIdentifier(value.id)) return false
  return isHarnessThreadFields(value)
}

function isHarnessThreadFields(value: Record<string, unknown>): boolean {
  if (!isHarnessId(value.harnessId)) return false
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return false
  if (!isJson(value.sessionState) || !isThreadPublicObservation(value.observation)) return false
  if (!singleLine(value.title, MAX_THREAD_TITLE_LENGTH, false)) return false
  if (value.titlePending !== undefined && value.titlePending !== true) return false
  if (value.emoji !== undefined && !isThreadEmoji(value.emoji)) return false
  if (!isStringArray(value.tags) || !value.tags.every(tag => singleLine(tag, MAX_TAG_LENGTH)) ||
      !unique(value.tags.map(threadTagKey))) return false
  if (!boundedString(value.cwd, MAX_CWD_LENGTH, false) || value.cwd.includes('\0')) return false
  if (value.worktree !== undefined && !isWorktree(value.worktree)) return false
  if (!isJson(value.settings)) return false
  return validTimestamp(value.createdAt) && validTimestamp(value.updatedAt) &&
    Number(value.updatedAt) >= Number(value.createdAt)
}

function isThreadRecord(value: unknown): value is ThreadRecord {
  return isBartThreadRecord(value) || isAgentThreadRecord(value)
}

function addAgentThread(
  state: OpenAgentState,
  input: AgentThreadRecord
): OpenAgentState {
  if (!isAgentThreadRecord(input)) throw new Error('Agent Thread 不符合当前格式')
  if (input.revision !== 0) throw new Error('新 Agent Thread revision 必须为 0')
  if (state.threads.some(thread => thread.id === input.id)) {
    throw new Error(`Thread ID 已存在: ${input.id}`)
  }
  return shallowState(state, { threads: [...state.threads, immutable(input)] })
}

function addAndSelectForkedAgentThread(
  state: OpenAgentState,
  mutation: Extract<OpenAgentStateMutation, { type: 'add-and-select-agent-thread' }>
): OpenAgentState {
  const source = readAgentThread(state, mutation.sourceThreadId)
  assertRevision(source, mutation.expectedSourceRevision)
  if (mutation.thread.id === source.id) {
    throw new Error('Forked Agent Thread 必须使用新的 identity')
  }
  return selectThread(
    addAgentThread(state, mutation.thread),
    mutation.thread.id
  )
}

function replaceAgentThread(
  state: OpenAgentState,
  mutation: Extract<OpenAgentStateMutation, { type: 'replace-agent-thread' }>
): OpenAgentState {
  const current = readAgentThread(state, mutation.threadId)
  assertRevision(current, mutation.expectedRevision)
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error('Thread revision 已达到安全整数上限')
  }
  if (!isAgentThreadRecord(mutation.thread)) throw new Error('Agent Thread 不符合当前格式')
  if (mutation.thread.id !== current.id || mutation.thread.harnessId !== current.harnessId ||
      mutation.thread.createdAt !== current.createdAt || mutation.thread.cwd !== current.cwd ||
      !sameWorktree(mutation.thread.worktree, current.worktree)) {
    throw new Error('Agent Thread 身份字段不可替换')
  }
  if (mutation.thread.revision !== current.revision + 1) {
    throw new Error('Agent Thread revision 必须恰好递增 1')
  }
  if (mutation.thread.updatedAt < current.updatedAt) {
    throw new Error('Agent Thread updatedAt 不得倒退')
  }
  return replaceThreadAt(state, current.id, immutable(mutation.thread))
}

/** Configuration/workspace identity deliberately excludes presentation and streaming state. */
export function threadSettingsSourceFingerprint(
  thread: Pick<AgentThreadRecord, 'harnessId' | 'cwd' | 'worktree' | 'settings'>
): string {
  return JSON.stringify([thread.harnessId, thread.cwd, thread.worktree ?? null, thread.settings])
}

function updateAgentThreadMetadata(
  state: OpenAgentState,
  mutation: Extract<OpenAgentStateMutation, { type: 'update-agent-thread-metadata' }>
): OpenAgentState {
  const current = readAgentThread(state, mutation.threadId)
  if (mutation.onlyIfPending && current.titlePending !== true) return state
  const { titlePending: _pending, ...retained } = current
  return replaceAgentThread(state, {
    type: 'replace-agent-thread',
    threadId: current.id,
    expectedRevision: current.revision,
    thread: {
      ...retained,
      revision: current.revision + 1,
      title: current.titlePending ? mutation.title : current.title,
      emoji: current.titlePending ? mutation.emoji : current.emoji ?? mutation.emoji,
      tags: [...mutation.tags],
      updatedAt: Math.max(mutation.updatedAt, current.updatedAt)
    }
  })
}

function updateAgentThreadSettings(
  state: OpenAgentState,
  mutation: Extract<OpenAgentStateMutation, { type: 'update-agent-thread-settings' }>
): OpenAgentState {
  const current = readAgentThread(state, mutation.threadId)
  if (threadSettingsSourceFingerprint(current) !== mutation.expectedSource) {
    throw new Error(`Thread settings source conflict: ${current.id}`)
  }
  return replaceThreadSettings(state, {
    type: 'replace-thread-settings',
    threadId: current.id,
    expectedRevision: current.revision,
    settings: mutation.settings,
    updatedAt: Math.max(mutation.updatedAt, current.updatedAt)
  })
}

/**
 * A failed latest Execution archives an unarchived Agent Thread in the same
 * state commit that publishes the failure, so persistence never observes one
 * without the other. The same failed Execution archives once: a repeated
 * observation, a restart replay or a late notification for a superseded
 * Execution leaves the Thread where the user put it. A later Execution that
 * fails archives again.
 */
export function shouldAutoArchiveFailedExecution(
  previous: ThreadPublicObservation,
  next: ThreadPublicObservation
): boolean {
  const failed = next.latestExecution
  if (failed?.status !== 'failed') return false
  const observed = previous.latestExecution
  if (!observed) return true
  if (observed.executionId === failed.executionId) return observed.status !== 'failed'
  // A distinct Execution ID is a new failure only if it started after the
  // committed latest. A late notification for an older Execution — or one whose
  // timestamp ties, which cannot be ordered — must not archive.
  return failed.startedAt > observed.startedAt
}

function replaceThreadSessionState(
  state: OpenAgentState,
  mutation: Extract<OpenAgentStateMutation, { type: 'replace-thread-session-state' }>
): OpenAgentState {
  const current = readHarnessThread(state, mutation.threadId)
  assertRevision(current, mutation.expectedRevision)
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error('Agent Thread revision 已达到安全整数上限')
  }
  if (!isJson(mutation.sessionState)) throw new Error('sessionState 必须是 JSON value')
  if (!isThreadPublicObservation(mutation.observation)) {
    throw new Error('Thread public observation 不符合当前格式')
  }
  assertMonotonicTimestamp(mutation.updatedAt, current.updatedAt, 'Thread updatedAt')
  const observation = immutable(mutation.observation)
  const autoArchive = isAgentThreadRecord(current) && !current.archived &&
    shouldAutoArchiveFailedExecution(current.observation, observation)
  const next: ThreadRecord = immutable({
    ...current,
    revision: current.revision + 1,
    sessionState: immutable(mutation.sessionState),
    observation,
    ...(autoArchive ? { archived: true } : {}),
    updatedAt: mutation.updatedAt
  })
  return replaceThreadAt(state, current.id, next)
}

function replaceThreadSettings(
  state: OpenAgentState,
  mutation: Extract<OpenAgentStateMutation, { type: 'replace-thread-settings' }>
): OpenAgentState {
  const current = readHarnessThread(state, mutation.threadId)
  assertRevision(current, mutation.expectedRevision)
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error('Thread revision 已达到安全整数上限')
  }
  if (!isJson(mutation.settings)) throw new Error('Thread settings 必须是 JSON value')
  assertMonotonicTimestamp(mutation.updatedAt, current.updatedAt, 'Thread updatedAt')
  return replaceThreadAt(state, current.id, immutable({
    ...current,
    revision: current.revision + 1,
    settings: immutable(mutation.settings),
    updatedAt: mutation.updatedAt
  }))
}

function deleteAgentThread(state: OpenAgentState, threadId: string): OpenAgentState {
  readAgentThread(state, threadId)
  return shallowState(state, {
    threads: state.threads.filter(thread => thread.id !== threadId),
    selectedThreadId: state.selectedThreadId === threadId ? null : state.selectedThreadId
  })
}

function replaceBartThread(
  state: OpenAgentState,
  mutation: Extract<OpenAgentStateMutation, { type: 'replace-bart-thread' }>
): OpenAgentState {
  const current = readBartThread(state)
  if (current.id !== mutation.expectedThreadId) {
    throw new Error(
      `Bart Thread 已替换: expected ${mutation.expectedThreadId}, actual ${current.id}`
    )
  }
  assertIdentifier(mutation.threadId, 'Bart Thread ID')
  if (mutation.threadId === current.id || state.threads.some(thread => thread.id === mutation.threadId)) {
    throw new Error('新 Bart Thread ID 必须唯一')
  }
  assertSettings(mutation.settings)
  if (!isHarnessId(mutation.hostHarnessId)) throw new Error('未知 Harness ID')
  assertBartHostMatchesPreference(mutation.settings, mutation.hostHarnessId)
  if (!isJson(mutation.threadSettings)) throw new Error('Bart Thread settings 必须是 JSON')
  if (!boundedString(mutation.cwd, MAX_CWD_LENGTH, false) || mutation.cwd.includes('\0')) {
    throw new Error('Bart Thread cwd 无效')
  }
  assertTimestamp(mutation.createdAt, 'Bart createdAt')
  const next: BartThreadRecord = immutable({
    id: mutation.threadId,
    bart: true,
    harnessId: mutation.hostHarnessId,
    revision: 0,
    sessionState: null,
    observation: { latestExecution: null, backgroundWork: null },
    title: 'Bart',
    tags: [],
    cwd: mutation.cwd,
    settings: immutable(mutation.threadSettings),
    transcript: [],
    createdAt: mutation.createdAt,
    updatedAt: mutation.createdAt
  })
  const replaced = replaceThreadAt(state, current.id, next)
  return shallowState(replaced, {
    settings: immutable(mutation.settings),
    selectedThreadId: state.selectedThreadId === current.id
      ? next.id
      : state.selectedThreadId
  })
}

function appendBartTranscriptItem(
  state: OpenAgentState,
  mutation: Extract<OpenAgentStateMutation, { type: 'append-bart-transcript-item' }>
): OpenAgentState {
  const current = readBartThread(state)
  assertBartThread(current, mutation.threadId)
  if (!isBartTranscriptItem(mutation.item)) {
    throw new Error('Bart transcript item 不符合当前格式')
  }
  if (current.transcript.some(item => item.id === mutation.item.id)) {
    throw new Error(`Bart transcript item ID 已存在: ${mutation.item.id}`)
  }
  if (mutation.item.type === 'tool-operation') {
    const callId = mutation.item.callId
    if (current.transcript.some(item => {
      if (item.type !== 'tool-operation') return false
      return item.callId === callId
    })) {
      throw new Error(`Bart tool call ID 已存在: ${callId}`)
    }
  }
  const previous = current.transcript.at(-1)
  if (previous && mutation.item.createdAt < previous.createdAt) {
    throw new Error('Bart transcript 必须按 createdAt 有序追加')
  }
  assertMonotonicTimestamp(mutation.updatedAt, current.updatedAt, 'Bart updatedAt')
  if (mutation.updatedAt < mutation.item.createdAt) {
    throw new Error('Bart updatedAt 不得早于 transcript item createdAt')
  }
  if (mutation.item.type === 'tool-operation' &&
      mutation.item.completedAt !== undefined &&
      mutation.updatedAt < mutation.item.completedAt) {
    throw new Error('Bart updatedAt 不得早于 tool completedAt')
  }
  return replaceThreadAt(state, current.id, immutable({
    ...current,
    revision: nextThreadRevision(current),
    transcript: [...current.transcript, immutable(mutation.item)],
    updatedAt: mutation.updatedAt
  }))
}

function finishBartExecution(
  state: OpenAgentState,
  mutation: Extract<OpenAgentStateMutation, { type: 'finish-bart-execution' }>
): OpenAgentState {
  const current = readBartThread(state)
  assertBartThread(current, mutation.threadId)
  assertIdentifier(mutation.executionId, 'Bart execution ID')
  assertMonotonicTimestamp(mutation.updatedAt, current.updatedAt, 'Bart updatedAt')
  const status = terminalMessageStatus(mutation.outcome)
  const transcript = current.transcript.map(item => {
    if (item.type === 'message' && item.role === 'assistant' &&
        item.executionId === mutation.executionId && item.status === 'streaming') {
      return immutable({ ...item, status })
    }
    if (item.type === 'tool-operation' &&
        item.executionId === mutation.executionId &&
        item.completedAt === undefined) {
      return immutable({
        ...item,
        result: TERMINATED_BART_TOOL_RESULT,
        isError: true,
        completedAt: mutation.updatedAt
      })
    }
    return item
  })
  return replaceThreadAt(state, current.id, immutable({
    ...current,
    revision: nextThreadRevision(current),
    transcript,
    updatedAt: mutation.updatedAt
  }))
}

function completeBartToolOperation(
  state: OpenAgentState,
  mutation: Extract<OpenAgentStateMutation, { type: 'complete-bart-tool-operation' }>
): OpenAgentState {
  const current = readBartThread(state)
  assertBartThread(current, mutation.threadId)
  assertIdentifier(mutation.executionId, 'Bart execution ID')
  assertIdentifier(mutation.callId, 'Bart tool call ID')
  if (!isJson(mutation.result)) throw new Error('Bart tool result 必须是 JSON value')
  if (mutation.isError !== undefined && typeof mutation.isError !== 'boolean') {
    throw new Error('Bart tool isError 必须是 boolean')
  }
  assertTimestamp(mutation.completedAt, 'Bart tool completedAt')
  assertMonotonicTimestamp(mutation.updatedAt, current.updatedAt, 'Bart updatedAt')
  if (mutation.updatedAt < mutation.completedAt) {
    throw new Error('Bart updatedAt 不得早于 tool completedAt')
  }
  const matches = current.transcript
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (
      item.type === 'tool-operation' && item.executionId === mutation.executionId &&
      item.callId === mutation.callId
    ))
  if (matches.length !== 1) {
    throw new Error(`Bart pending tool operation 不唯一或不存在: ${mutation.callId}`)
  }
  const { item, index } = matches[0]
  if (item.type !== 'tool-operation' || item.completedAt !== undefined ||
      item.result !== undefined || item.isError !== undefined) {
    throw new Error(`Bart tool operation 已完成: ${mutation.callId}`)
  }
  if (mutation.completedAt < item.createdAt) {
    throw new Error('Bart tool completedAt 不得早于 createdAt')
  }
  const transcript = [...current.transcript]
  transcript[index] = immutable({
    ...item,
    result: immutable(mutation.result),
    ...(mutation.isError === undefined ? {} : { isError: mutation.isError }),
    completedAt: mutation.completedAt
  })
  return replaceThreadAt(state, current.id, immutable({
    ...current,
    revision: nextThreadRevision(current),
    transcript,
    updatedAt: mutation.updatedAt
  }))
}

function settleStaleBartRuntime(
  state: OpenAgentState,
  mutation: Extract<OpenAgentStateMutation, { type: 'settle-stale-bart-runtime' }>
): OpenAgentState {
  const current = readBartThread(state)
  assertBartThread(current, mutation.threadId)
  assertMonotonicTimestamp(mutation.updatedAt, current.updatedAt, 'Bart updatedAt')
  let changed = false
  const transcript = current.transcript.map((item): BartTranscriptItem => {
    if (item.type === 'message' && item.role === 'assistant' &&
        item.status === 'streaming') {
      changed = true
      const settled = { ...item, status: 'cancelled' as const }
      delete settled.statusLabel
      return immutable(settled)
    }
    if (item.type === 'tool-operation' && item.completedAt === undefined) {
      changed = true
      return immutable({
        ...item,
        result: STALE_BART_TOOL_RESULT,
        isError: true,
        completedAt: mutation.updatedAt
      })
    }
    return item
  })
  if (!changed) return state
  return replaceThreadAt(state, current.id, immutable({
    ...current,
    revision: nextThreadRevision(current),
    transcript,
    updatedAt: mutation.updatedAt
  }))
}

function archiveReport(
  state: OpenAgentState,
  mutation: Extract<OpenAgentStateMutation, { type: 'archive-report' }>
): OpenAgentState {
  const report = state.reports.find(candidate => candidate.id === mutation.reportId)
  if (!report) throw new Error(`Report Thread 不存在: ${mutation.reportId}`)
  const lockedIds = new Set(mutation.relatedThreadIds)
  if (lockedIds.size !== report.relatedExecutions.length ||
      report.relatedExecutions.some(reference => !lockedIds.has(reference.threadId))) {
    throw new Error('Report Thread 关联已变化，请重试归档')
  }
  let next = state
  for (const reference of report.relatedExecutions) {
    const thread = next.threads.find(candidate => candidate.id === reference.threadId)
    if (!thread || !isAgentThreadRecord(thread) ||
        thread.observation.latestExecution?.executionId !== reference.executionId) continue
    next = reduceOpenAgentState(next, { type: 'set-agent-thread-archived', threadId: thread.id, archived: true })
  }
  return report.archived ? next : shallowState(next, {
    reports: Object.freeze(next.reports.map(candidate => candidate.id === report.id
      ? Object.freeze({ ...candidate, archived: true }) : candidate))
  })
}

function replaceReports(
  state: OpenAgentState,
  reports: readonly ReportThreadRecord[]
): OpenAgentState {
  if (!Array.isArray(reports) || !reports.every(isReportThreadRecord) ||
      !unique(reports.map(report => report.id))) {
    throw new Error('Report Thread 集合不符合当前格式')
  }
  return shallowState(state, { reports: immutable(reports) })
}

function replaceTagPool(
  state: OpenAgentState,
  tagPool: readonly OpenAgentTagPoolEntry[]
): OpenAgentState {
  if (!Array.isArray(tagPool) || tagPool.length > MAX_TAG_POOL_SIZE ||
      !tagPool.every(isTagPoolEntry) ||
      !unique(tagPool.map(entry => threadTagKey(entry.name)))) {
    throw new Error('Tag pool 不符合当前格式')
  }
  return shallowState(state, { tagPool: immutable(tagPool) })
}

function selectThread(state: OpenAgentState, threadId: string | null): OpenAgentState {
  if (threadId !== null && !state.threads.some(thread => thread.id === threadId)) {
    throw new Error(`Thread 不存在: ${threadId}`)
  }
  return shallowState(state, { selectedThreadId: threadId })
}

function replaceSettings(
  state: OpenAgentState,
  settings: OpenAgentSettings
): OpenAgentState {
  assertSettings(settings)
  if (!bartHostMatchesPreference(settings, readBartThread(state).harnessId)) {
    throw new Error('切换 Bart Host 必须同时替换 Bart Thread')
  }
  return shallowState(state, { settings: immutable(settings) })
}

function assertBartHostMatchesPreference(
  settings: OpenAgentSettings,
  hostHarnessId: HarnessId
): void {
  if (!bartHostMatchesPreference(settings, hostHarnessId)) {
    throw new Error('Bart record Host 必须与 OpenAgent settings preference 一致')
  }
}

function bartHostMatchesPreference(
  settings: OpenAgentSettings,
  hostHarnessId: string
): boolean {
  const preference = settings.bart.hostHarnessPreference
  return preference === 'auto' || preference === hostHarnessId
}

function replaceThreadAt(
  state: OpenAgentState,
  threadId: string,
  replacement: ThreadRecord
): OpenAgentState {
  const index = state.threads.findIndex(thread => thread.id === threadId)
  if (index < 0) throw new Error(`Thread 不存在: ${threadId}`)
  const threads = [...state.threads]
  threads[index] = replacement
  return shallowState(state, { threads })
}

function shallowState(
  state: OpenAgentState,
  replacement: Partial<OpenAgentState>
): OpenAgentState {
  for (const value of Object.values(replacement)) {
    if (Array.isArray(value) && !Object.isFrozen(value)) Object.freeze(value)
  }
  return Object.freeze({ ...state, ...replacement })
}

function terminalMessageStatus(
  outcome: Extract<PublicExecution, { readonly finishedAt: number }>['status']
): BartMessage['status'] {
  switch (outcome) {
    case 'completed': return 'complete'
    case 'failed': return 'failed'
    case 'interrupted': return 'cancelled'
    default: throw new Error('Bart terminal outcome 不符合当前格式')
  }
}

function assertRevision(thread: ThreadRecord, expected: number): void {
  if (thread.revision !== expected) {
    throw new Error(
      `Thread revision 已变化: expected ${expected}, actual ${thread.revision}`
    )
  }
}

function nextThreadRevision(thread: ThreadRecord): number {
  if (thread.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error('Thread revision 已达到安全整数上限')
  }
  return thread.revision + 1
}

function assertBartThread(thread: BartThreadRecord, threadId: string): void {
  if (thread.id !== threadId) {
    throw new Error(
      `Bart Thread 已替换: expected ${threadId}, actual ${thread.id}`
    )
  }
}

function isBartTranscriptItem(value: unknown): value is BartTranscriptItem {
  if (!isRecord(value) || value.type !== 'message' && value.type !== 'tool-operation') {
    return false
  }
  if (value.type === 'tool-operation') {
    if (!hasOnlyKeys(value, [
      'type', 'id', 'executionId', 'callId', 'name', 'arguments', 'createdAt',
      'completedAt', 'result', 'isError'
    ])) return false
    if (!(validIdentifier(value.id) && validIdentifier(value.executionId) &&
      validIdentifier(value.callId) && boundedString(value.name, 256, false) &&
      isJson(value.arguments) && validTimestamp(value.createdAt) &&
      (value.completedAt === undefined || (
        validTimestamp(value.completedAt) && value.completedAt >= value.createdAt
      )) && (value.result === undefined || isJson(value.result)) &&
      (value.isError === undefined || typeof value.isError === 'boolean'))) return false
    const completed = value.completedAt !== undefined
    return completed
      ? value.result !== undefined
      : value.result === undefined && value.isError === undefined
  }
  if (!hasOnlyKeys(value, [
    'type', 'id', 'role', 'content', 'createdAt', 'status', 'executionId',
    'reasoning', 'statusLabel', 'error', 'attachments', 'systemEvent'
  ])) return false
  return validIdentifier(value.id) && (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' && validTimestamp(value.createdAt) &&
    (value.status === 'complete' || value.status === 'streaming' ||
      value.status === 'cancelled' || value.status === 'failed') &&
    (value.executionId === undefined || validIdentifier(value.executionId)) &&
    optionalString(value.reasoning) && optionalString(value.statusLabel) &&
    optionalString(value.error) &&
    (value.attachments === undefined || (
      Array.isArray(value.attachments) && value.attachments.every(isAttachment) &&
      unique(value.attachments.map(attachment => attachment.id))
    )) && (value.systemEvent === undefined || value.systemEvent === true)
}

function isAttachment(value: unknown): value is NonNullable<BartMessage['attachments']>[number] {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'path', 'name', 'mimeType', 'size', 'kind'
  ])) return false
  return validIdentifier(value.id) && boundedString(value.path, MAX_CWD_LENGTH, false) &&
    boundedString(value.name, 512, false) && boundedString(value.mimeType, 256, false) &&
    validTimestamp(value.size) &&
    (value.kind === 'image' || value.kind === 'document' || value.kind === 'file')
}

function isReportThreadRecord(value: unknown): value is ReportThreadRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'title', 'tags', 'createdAt', 'updatedAt', 'html',
    'relatedExecutions', 'archived'
  ])) return false
  return validIdentifier(value.id) &&
    singleLine(value.title, MAX_REPORT_TITLE_LENGTH, false) &&
    isStringArray(value.tags) && value.tags.every(tag => singleLine(tag, 4096)) &&
    unique(value.tags.map(threadTagKey)) &&
    validTimestamp(value.createdAt) && validTimestamp(value.updatedAt) &&
    value.updatedAt >= value.createdAt && typeof value.html === 'string' &&
    !exceedsUnicodeLength(value.html, MAX_REPORT_HTML_CHARACTERS) && Boolean(value.html.trim()) &&
    Array.isArray(value.relatedExecutions) &&
    value.relatedExecutions.length <= MAX_REPORT_RELATED_THREADS &&
    value.relatedExecutions.every(ref => isRecord(ref) && hasOnlyKeys(ref, ['threadId', 'executionId']) &&
      validIdentifier(ref.threadId) && validIdentifier(ref.executionId)) &&
    unique(value.relatedExecutions.map(ref => ref.threadId)) &&
    typeof value.archived === 'boolean'
}

function isTagPoolEntry(value: unknown): value is OpenAgentTagPoolEntry {
  return isRecord(value) && hasOnlyKeys(value, ['name', 'description']) &&
    singleLine(value.name, MAX_TAG_LENGTH) &&
    singleLine(value.description, MAX_TAG_DESCRIPTION_LENGTH, false)
}

function isWorktree(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'baseCwd', 'name', 'native', 'cwd'
  ])) return false
  return boundedString(value.baseCwd, MAX_CWD_LENGTH, false) &&
    !value.baseCwd.includes('\0') && optionalBoundedString(value.name, 256) &&
    typeof value.native === 'boolean' && optionalBoundedString(value.cwd, MAX_CWD_LENGTH)
}

function sameWorktree(
  left: AgentThreadRecord['worktree'],
  right: AgentThreadRecord['worktree']
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.baseCwd === right.baseCwd &&
    left.name === right.name &&
    left.native === right.native &&
    left.cwd === right.cwd
}

function isJson(value: unknown): value is JsonValue {
  // Keep the local alias so state validation has one semantic name while the
  // strict provider-neutral JSON gate remains shared with Runtime and IPC.
  return isJsonValue(value)
}

function isSettings(value: unknown): value is OpenAgentSettings {
  try {
    assertSettings(value)
    return true
  } catch {
    return false
  }
}

function assertSettings(value: unknown): asserts value is OpenAgentSettings {
  assertOpenAgentSettingsShell(value)
  if (!isJson(value)) throw new Error('OpenAgent settings 必须可 JSON 序列化')
}

function immutable<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every(key => allowedKeys.has(key))
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function orderedByCreatedAt(values: readonly { createdAt: number }[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1].createdAt <= value.createdAt)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function optionalBoundedString(value: unknown, maximum: number): boolean {
  return value === undefined || boundedString(value, maximum, false)
}

function boundedString(value: unknown, maximum: number, allowEmpty = true): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) &&
    value.length <= maximum && !value.includes('\0')
}

function singleLine(value: unknown, maximum: number, allowEmpty = true): value is string {
  return boundedString(value, maximum, allowEmpty) && value.trim() === value &&
    !value.includes('\n') && !value.includes('\r') && unicodeLength(value) <= maximum
}

function unicodeLength(value: string): number {
  return Array.from(value).length
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (!validIdentifier(value)) throw new Error(`${label} 不符合当前格式`)
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (!validTimestamp(value)) throw new Error(`${label} 不符合当前格式`)
}

function assertMonotonicTimestamp(value: unknown, current: number, label: string): void {
  assertTimestamp(value, label)
  if (value < current) throw new Error(`${label} 不得倒退`)
}
