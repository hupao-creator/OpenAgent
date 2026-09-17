import { randomUUID } from 'node:crypto'
import { readFile, rename, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  AgentInput,
  AgentInputPart
} from '@openagent/contracts'
import type { JsonValue } from '@openagent/contracts'
import { isHarnessId, type HarnessId } from '../shared/harnesses'
import type { WorktreeOptions } from '@openagent/contracts'
import { cloneBoundedJsonValue } from './bart-v1/json'
import { writePrivateFileAtomically } from './services/atomic-file'

export const SCHEDULED_DISPATCH_GRACE_MS = 60_000
export const MAX_PENDING_SCHEDULED_DISPATCHES = 256
export const MAX_SCHEDULED_DISPATCH_FILE_BYTES = 20 * 1024 * 1024

const MAX_AGENT_INPUT_BYTES = 8 * 1024 * 1024
const MAX_THREAD_SETTINGS_BYTES = 256 * 1024
const MAX_TARGET_ACKNOWLEDGEMENT_BYTES = 64 * 1024
const MAX_TIMESTAMP = 8.64e15

/**
 * Everything needed by the ordinary Thread start path, frozen before the
 * schedule is persisted. A pending dispatch deliberately has no Thread ID or
 * native session identity.
 */
export interface ScheduledDispatchRequest {
  readonly input: AgentInput
  readonly cwd?: string
  readonly worktree?: WorktreeOptions
  readonly harnessId: HarnessId
  /** Fully resolved Harness-owned Thread settings. Core only persists them. */
  readonly threadSettings: JsonValue
  /** Effective native Thread settings acknowledged when the schedule was created. */
  readonly targetAcknowledgement: JsonValue
}

export interface ScheduledDispatch {
  readonly id: string
  readonly executeAt: number
  readonly createdAt: number
  readonly request: ScheduledDispatchRequest
}

export interface ScheduledDispatchSummary {
  readonly scheduleId: string
  readonly executeAt: string
  readonly createdAt: string
  readonly harnessId: HarnessId
  readonly targetAcknowledgement: JsonValue
  readonly promptPreview: string
  readonly cwd?: string
  readonly worktree: boolean
}

/** Current-only sidecar colocated with ThreadStateStore's v4 state file. */
export class ScheduledDispatchStore {
  readonly path: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'openagent-state-v4', 'scheduled-dispatches.json')
  }

  async load(): Promise<ScheduledDispatch[]> {
    let serialized: string
    try {
      const metadata = await stat(this.path)
      if (metadata.size > MAX_SCHEDULED_DISPATCH_FILE_BYTES) {
        return this.recoverCurrentFile([], scheduledDispatchFileTooLargeError())
      }
      serialized = await readFile(this.path, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }

    if (Buffer.byteLength(serialized, 'utf8') > MAX_SCHEDULED_DISPATCH_FILE_BYTES) {
      return this.recoverCurrentFile([], scheduledDispatchFileTooLargeError())
    }

    let value: unknown
    try {
      value = JSON.parse(serialized) as unknown
    } catch (error) {
      return this.recoverCurrentFile(
        [],
        new Error('计划派发数据不是合法 JSON', { cause: error })
      )
    }
    try {
      return parseScheduledDispatches(value)
    } catch (error) {
      const salvaged = salvageCurrentScheduledDispatches(value)
      return this.recoverCurrentFile(salvaged, error)
    }
  }

  save(value: readonly ScheduledDispatch[]): Promise<void> {
    const dispatches = parseScheduledDispatches(value)
    const serialized = JSON.stringify(dispatches)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SCHEDULED_DISPATCH_FILE_BYTES) {
      throw scheduledDispatchFileTooLargeError()
    }

    const operation = this.writeQueue
      .catch(() => undefined)
      .then(() => writePrivateFileAtomically(this.path, serialized))
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async recoverCurrentFile(
    salvaged: readonly ScheduledDispatch[],
    cause: unknown
  ): Promise<ScheduledDispatch[]> {
    const current = [...salvaged]
    const quarantinePath = `${this.path}.corrupt-${Date.now()}-${randomUUID()}`
    try {
      await rename(this.path, quarantinePath)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        console.warn('计划派发损坏文件隔离失败，将尝试原位重置', error)
      }
    }
    try {
      await this.save(current)
    } catch (error) {
      // Current-format corruption must not prevent application startup. Keep
      // the bounded salvaged rows in memory even if this filesystem is not
      // currently writable; a later ordinary mutation can persist them.
      console.warn('计划派发损坏文件重置失败', error)
    }
    console.warn('已隔离并恢复损坏的当前计划派发文件', cause)
    return current
  }
}

export function parseScheduledDispatches(value: unknown): ScheduledDispatch[] {
  const cloned = cloneBoundedJsonValue(
    value,
    'Scheduled dispatch data',
    MAX_SCHEDULED_DISPATCH_FILE_BYTES
  )
  if (!Array.isArray(cloned)) {
    throw new Error('计划派发数据必须是数组')
  }
  if (cloned.length > MAX_PENDING_SCHEDULED_DISPATCHES) {
    throw new Error(`待执行计划数量不能超过 ${MAX_PENDING_SCHEDULED_DISPATCHES}`)
  }

  const dispatches = cloned.map(parseScheduledDispatch)
  if (new Set(dispatches.map((dispatch) => dispatch.id)).size !== dispatches.length) {
    throw new Error('计划派发 id 不能重复')
  }
  if (dispatches.some((dispatch, index) => (
    index > 0 && compareScheduledDispatches(dispatches[index - 1], dispatch) > 0
  ))) {
    throw new Error('计划派发数据顺序无效')
  }
  return dispatches
}

function salvageCurrentScheduledDispatches(value: unknown): ScheduledDispatch[] {
  if (!Array.isArray(value)) return []
  const seenIds = new Set<string>()
  const valid: ScheduledDispatch[] = []
  for (const candidate of value) {
    let parsed: ScheduledDispatch
    try {
      parsed = parseScheduledDispatch(candidate as JsonValue)
    } catch {
      continue
    }
    // File order owns duplicate identity. This is deterministic and avoids
    // guessing which conflicting payload was intended.
    if (seenIds.has(parsed.id)) continue
    seenIds.add(parsed.id)
    valid.push(parsed)
  }
  return valid
    .sort(compareScheduledDispatches)
    .slice(0, MAX_PENDING_SCHEDULED_DISPATCHES)
}

export function scheduledDispatchSummary(
  dispatch: ScheduledDispatch
): ScheduledDispatchSummary {
  return {
    scheduleId: dispatch.id,
    executeAt: new Date(dispatch.executeAt).toISOString(),
    createdAt: new Date(dispatch.createdAt).toISOString(),
    harnessId: dispatch.request.harnessId,
    targetAcknowledgement: cloneBoundedJsonValue(
      dispatch.request.targetAcknowledgement,
      'Scheduled dispatch target acknowledgement',
      MAX_TARGET_ACKNOWLEDGEMENT_BYTES
    ),
    promptPreview: truncate(inputPreview(dispatch.request.input), 320),
    ...(dispatch.request.cwd === undefined ? {} : { cwd: dispatch.request.cwd }),
    worktree: dispatch.request.worktree?.enabled === true
  }
}

export function compareScheduledDispatches(
  left: ScheduledDispatch,
  right: ScheduledDispatch
): number {
  return compareNumbers(left.executeAt, right.executeAt) ||
    compareNumbers(left.createdAt, right.createdAt) ||
    left.id.localeCompare(right.id)
}

/** True only for a due dispatch still inside the at-most-once execution window. */
export function shouldExecuteScheduledDispatch(
  dispatch: ScheduledDispatch,
  now: number
): boolean {
  assertTimestamp(now, '当前时间')
  return dispatch.executeAt <= now && now - dispatch.executeAt <= SCHEDULED_DISPATCH_GRACE_MS
}

function parseScheduledDispatch(value: JsonValue): ScheduledDispatch {
  const record = requiredRecord(value, '计划派发')
  assertExactKeys(record, ['id', 'executeAt', 'createdAt', 'request'], '计划派发')

  const id = parseIdentifier(record.id, '计划派发 id')
  const executeAt = parseTimestamp(record.executeAt, '计划派发 executeAt')
  const createdAt = parseTimestamp(record.createdAt, '计划派发 createdAt')
  if (executeAt <= createdAt) {
    throw new Error('计划派发 executeAt 必须晚于 createdAt')
  }

  return {
    id,
    executeAt,
    createdAt,
    request: parseScheduledDispatchRequest(record.request)
  }
}

function parseScheduledDispatchRequest(value: JsonValue): ScheduledDispatchRequest {
  const record = requiredRecord(value, '计划派发请求')
  assertExactKeys(
    record,
    [
      'input',
      'cwd',
      'worktree',
      'harnessId',
      'threadSettings',
      'targetAcknowledgement'
    ],
    '计划派发请求',
    ['cwd', 'worktree']
  )

  if (!isHarnessId(record.harnessId)) throw new Error('计划派发 Harness ID 无效')
  const cwd = record.cwd === undefined
    ? undefined
    : parseAbsolutePath(record.cwd, '计划派发 cwd', 4_096)
  const worktree = record.worktree === undefined
    ? undefined
    : parseWorktreeOptions(record.worktree)
  if (worktree && cwd === undefined) {
    throw new Error('计划派发启用 worktree 时必须提供 cwd')
  }

  return {
    input: parseAgentInput(record.input),
    ...(cwd === undefined ? {} : { cwd }),
    ...(worktree === undefined ? {} : { worktree }),
    harnessId: record.harnessId,
    threadSettings: cloneBoundedJsonValue(
      record.threadSettings,
      'Scheduled dispatch Thread settings',
      MAX_THREAD_SETTINGS_BYTES
    ),
    targetAcknowledgement: cloneBoundedJsonValue(
      record.targetAcknowledgement,
      'Scheduled dispatch target acknowledgement',
      MAX_TARGET_ACKNOWLEDGEMENT_BYTES
    )
  }
}

function parseAgentInput(value: JsonValue): AgentInput {
  cloneBoundedJsonValue(value, 'Scheduled dispatch Agent input', MAX_AGENT_INPUT_BYTES)
  const record = requiredRecord(value, '计划派发 Agent input')
  assertExactKeys(record, ['parts', 'presentation'], '计划派发 Agent input', ['presentation'])
  if (!Array.isArray(record.parts) || record.parts.length < 1 || record.parts.length > 128) {
    throw new Error('计划派发 Agent input parts 数量必须在 1 到 128 之间')
  }
  if (
    record.presentation !== undefined &&
    record.presentation !== 'visible' &&
    record.presentation !== 'internal'
  ) {
    throw new Error('计划派发 Agent input presentation 无效')
  }

  const parts = record.parts.map((part, index) => parseAgentInputPart(part, index))
  if (!parts.some((part) => part.kind !== 'text' || Boolean(part.text.trim()))) {
    throw new Error('计划派发 Agent input 不能为空')
  }
  return {
    parts,
    ...(record.presentation === undefined
      ? {}
      : { presentation: record.presentation })
  }
}

function parseAgentInputPart(value: JsonValue, index: number): AgentInputPart {
  const label = `计划派发 Agent input part ${index}`
  const record = requiredRecord(value, label)
  if (typeof record.kind !== 'string') throw new Error(`${label} kind 无效`)

  switch (record.kind) {
    case 'text':
      assertExactKeys(record, ['kind', 'text'], label)
      return {
        kind: 'text',
        text: parseBoundedString(record.text, `${label}.text`, 1_000_000, true)
      }
    case 'local-file':
    case 'audio':
      assertExactKeys(record, ['kind', 'file'], label)
      return { kind: record.kind, file: parseLocalFile(record.file, label) }
    case 'image': {
      assertExactKeys(record, ['kind', 'file', 'detail'], label, ['detail'])
      const detail = parseImageDetail(record.detail, label)
      return {
        kind: 'image',
        file: parseLocalFile(record.file, label),
        ...(detail === undefined ? {} : { detail })
      }
    }
    case 'image-url': {
      assertExactKeys(record, ['kind', 'url', 'detail'], label, ['detail'])
      const detail = parseImageDetail(record.detail, label)
      return {
        kind: 'image-url',
        url: parseMediaUrl(record.url, label),
        ...(detail === undefined ? {} : { detail })
      }
    }
    case 'audio-url':
      assertExactKeys(record, ['kind', 'url'], label)
      return { kind: 'audio-url', url: parseMediaUrl(record.url, label) }
    case 'mention':
    case 'skill':
      assertExactKeys(record, ['kind', 'name', 'path'], label)
      return {
        kind: record.kind,
        name: parseBoundedString(record.name, `${label}.name`, 1_024),
        path: parseAbsolutePath(record.path, `${label}.path`, 4_096)
      }
    default:
      throw new Error(`${label} kind 无效`)
  }
}

function parseLocalFile(
  value: JsonValue | undefined,
  label: string
): Extract<AgentInputPart, { kind: 'local-file' }>['file'] {
  const record = requiredRecord(value, `${label}.file`)
  assertExactKeys(record, ['id', 'path', 'name', 'mimeType', 'size'], `${label}.file`)
  if (
    typeof record.size !== 'number' ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0 ||
    record.size > 100 * 1024 * 1024
  ) {
    throw new Error(`${label}.file.size 无效`)
  }
  return {
    id: parseBoundedString(record.id, `${label}.file.id`, 128),
    path: parseAbsolutePath(record.path, `${label}.file.path`, 4_096),
    name: parseBoundedString(record.name, `${label}.file.name`, 1_024),
    mimeType: parseBoundedString(record.mimeType, `${label}.file.mimeType`, 256),
    size: record.size
  }
}

function parseImageDetail(
  value: JsonValue | undefined,
  label: string
): 'auto' | 'low' | 'high' | 'original' | undefined {
  if (value === undefined) return undefined
  if (value !== 'auto' && value !== 'low' && value !== 'high' && value !== 'original') {
    throw new Error(`${label}.detail 无效`)
  }
  return value
}

function parseMediaUrl(value: JsonValue | undefined, label: string): string {
  const raw = parseBoundedString(value, `${label}.url`, 4_000_000)
  let url: URL
  try {
    url = new URL(raw)
  } catch (error) {
    throw new Error(`${label}.url 无效`, { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'data:') {
    throw new Error(`${label}.url 协议无效`)
  }
  return raw
}

function parseWorktreeOptions(value: JsonValue): WorktreeOptions {
  const record = requiredRecord(value, '计划派发 worktree')
  assertExactKeys(record, ['enabled', 'name'], '计划派发 worktree', ['name'])
  if (record.enabled !== true) throw new Error('计划派发 worktree.enabled 必须为 true')
  if (record.name === undefined) return { enabled: true }

  const name = parseBoundedString(record.name, '计划派发 worktree.name', 64)
  if (!/^[\p{L}\p{N}._-]+$/u.test(name)) {
    throw new Error('计划派发 worktree.name 只能包含字母、数字、点、下划线和连字符')
  }
  return { enabled: true, name }
}

function inputPreview(input: AgentInput): string {
  return input.parts.map((part): string => {
    if (part.kind === 'text') return part.text
    if (part.kind === 'mention' || part.kind === 'skill') return `@${part.name}`
    if (part.kind === 'image-url' || part.kind === 'audio-url') return part.url
    return part.file.name
  }).join('\n\n')
}

function truncate(value: string, limit: number): string {
  const text = value.trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function requiredRecord(
  value: JsonValue | undefined,
  label: string
): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  return value
}

function assertExactKeys(
  value: Record<string, JsonValue>,
  keys: readonly string[],
  label: string,
  optional: readonly string[] = []
): void {
  const allowed = new Set(keys)
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
  if (unexpected.length > 0) {
    throw new Error(`${label} 包含未支持字段：${unexpected.join(', ')}`)
  }
  const optionalKeys = new Set(optional)
  const missing = keys.filter((key) => !optionalKeys.has(key) && !Object.hasOwn(value, key))
  if (missing.length > 0) throw new Error(`${label} 缺少字段：${missing.join(', ')}`)
}

function parseIdentifier(value: JsonValue | undefined, label: string): string {
  const id = parseBoundedString(value, label, 128)
  if (/\s/.test(id)) throw new Error(`${label} 不能包含空白字符`)
  return id
}

function parseAbsolutePath(
  value: JsonValue | undefined,
  label: string,
  maxLength: number
): string {
  const path = parseBoundedString(value, label, maxLength)
  if (!isAbsolute(path)) throw new Error(`${label} 必须是绝对路径`)
  return path
}

function parseBoundedString(
  value: JsonValue | undefined,
  label: string,
  maxLength: number,
  allowEmpty = false
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxLength ||
    value.includes('\0')
  ) {
    throw new Error(`${label} 无效`)
  }
  return value
}

function parseTimestamp(value: JsonValue | undefined, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP
  ) {
    throw new Error(`${label} 无效`)
  }
  return value
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) {
    throw new Error(`${label} 无效`)
  }
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function scheduledDispatchFileTooLargeError(): Error {
  return new Error('计划派发数据超过 20 MB，无法读写')
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}
