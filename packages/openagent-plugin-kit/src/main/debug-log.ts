import {
  chmodSync,
  createWriteStream,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type WriteStream
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'

/**
 * Local diagnostic logging is process-local and append-only. It is intended
 * for development investigations, rather than user-visible telemetry. Values
 * are not redacted; the only automatic size limit is the per-event byte cap
 * described in docs/local-debug-log.md.
 */

export type DebugLogMode = 'off' | 'summary' | 'detail'

export type DebugContext = {
  traceId?: string
  spanId?: string
  parentSpanId?: string
  threadId?: string
  executionId?: string
  nativeSessionId?: string
  harnessId?: string
}

export interface DebugLogInitOptions {
  /** Electron's effective packaged-runtime result. */
  readonly packaged?: boolean
}

const SCHEMA_VERSION = 1
const MAX_EVENT_BYTES = 256 * 1024
const MAX_QUEUE_BYTES = 8 * 1024 * 1024
const CRITICAL_QUEUE_RESERVE_BYTES = 512 * 1024
const DEFAULT_ROTATION_BYTES = 20 * 1024 * 1024
const DEFAULT_RETENTION_DAYS = 7
const DEFAULT_RETENTION_BYTES = 1024 * 1024 * 1024
const LOG_FILE_PREFIX = 'openagent-'
const LOG_FILE_SUFFIX = '.jsonl'
const DEFAULT_MODULE = 'main'
const BATCH_MAX_EVENTS = 64
const BATCH_MAX_BYTES = 512 * 1024
const CONTEXT_KEYS: readonly (keyof DebugContext)[] = [
  'traceId',
  'spanId',
  'parentSpanId',
  'threadId',
  'executionId',
  'nativeSessionId',
  'harnessId'
]
const ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'ts',
  'seq',
  'pid',
  'bootId',
  'level',
  'module',
  'evt',
  ...CONTEXT_KEYS
])

type DebugLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

interface QueueEntry {
  readonly data: Buffer
  readonly critical: boolean
}

interface FlushWaiter {
  readonly resolve: () => void
  timer: NodeJS.Timeout | undefined
}

const contextStorage = new AsyncLocalStorage<DebugContext>()
const bootId = createId()

let sequence = 0
let packagedRuntime: boolean | undefined
let logDirectory: string | undefined
let logStream: WriteStream | undefined
let logPath: string | undefined
let logPart = 0
let currentFileBytes = 0
let loggingInitialized = false
let loggingDisabled = false
let rotating = false
let pumpScheduled = false
let writing = false
let inFlightBytes = 0
let queueBytes = 0
let droppedEvents = 0
let diskFailureReported = false
let queue: QueueEntry[] = []
let flushWaiters: FlushWaiter[] = []

function createId(): string {
  try {
    return randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

function configuredMode(): DebugLogMode | undefined {
  const value = process.env.OPENAGENT_DEBUG_LOG?.trim().toLowerCase()
  return value === 'off' || value === 'summary' || value === 'detail' ? value : undefined
}

function resolveMode(): DebugLogMode {
  const explicit = configuredMode()
  if (explicit) return explicit
  if (packagedRuntime === true) return 'off'
  return 'detail'
}

/** Returns the effective local debug-log mode. */
export function getDebugLogMode(): DebugLogMode {
  return resolveMode()
}

function setMode(options?: DebugLogInitOptions): DebugLogMode {
  if (options && typeof options.packaged === 'boolean') packagedRuntime = options.packaged
  return resolveMode()
}

function retentionDays(): number {
  return readNonNegativeNumber(
    process.env.OPENAGENT_DEBUG_LOG_RETENTION_DAYS ?? process.env.OPENAGENT_DEBUG_LOG_MAX_AGE_DAYS,
    DEFAULT_RETENTION_DAYS
  )
}

function retentionBytes(): number {
  return readNonNegativeNumber(
    process.env.OPENAGENT_DEBUG_LOG_RETENTION_BYTES ?? process.env.OPENAGENT_DEBUG_LOG_MAX_TOTAL_BYTES,
    DEFAULT_RETENTION_BYTES
  )
}

function rotationBytes(): number {
  return readNonNegativeNumber(
    process.env.OPENAGENT_DEBUG_LOG_ROTATION_BYTES ?? process.env.OPENAGENT_DEBUG_LOG_MAX_FILE_BYTES,
    DEFAULT_ROTATION_BYTES
  )
}

function readNonNegativeNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * Starts one unique process/boot log file. The one-argument signature remains
 * compatible with the original logger; the optional second argument lets the
 * Electron entrypoint supply the effective packaged-runtime decision.
 */
export function initDebugLog(
  directory: string,
  options?: DebugLogInitOptions
): string | undefined {
  const mode = setMode(options)
  loggingInitialized = true
  logDirectory = directory
  loggingDisabled = false
  diskFailureReported = false
  droppedEvents = 0
  queue = []
  queueBytes = 0
  writing = false
  inFlightBytes = 0
  rotating = false
  pumpScheduled = false
  currentFileBytes = 0

  const previous = logStream
  logStream = undefined
  logPath = undefined
  if (previous) {
    try {
      previous.destroy()
    } catch {
      // Diagnostics must never make initialization fail.
    }
  }

  if (mode === 'off') return undefined

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (typeof chmodSync === 'function') chmodSync(directory, 0o700)
    // Reserve one full future part so retention remains within budget after
    // the newly opened active file grows to its rotation threshold.
    pruneOldLogFiles(directory, rotationBytes())
    const path = createLogPath(directory)
    // Pre-create so the permission is deterministic even when the process
    // umask is permissive. Every record is still written asynchronously.
    writeFileSync(path, '', { flag: 'a', mode: 0o600 })
    if (typeof chmodSync === 'function') chmodSync(path, 0o600)
    logPath = path
    logStream = openStream(path)
    return path
  } catch (error) {
    reportDiskFailure(error)
    logStream = undefined
    logPath = undefined
    return undefined
  }
}

function createLogPath(directory: string): string {
  logPart += 1
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(directory, `${LOG_FILE_PREFIX}${stamp}-pid${process.pid}-boot${bootId}-part${logPart}${LOG_FILE_SUFFIX}`)
}

function openStream(path: string): WriteStream {
  const stream = createWriteStream(path, { flags: 'a', mode: 0o600 })
  stream.on('error', (error) => {
    reportDiskFailure(error)
    disableLogging()
  })
  stream.on('close', () => {
    if (logStream === stream && loggingDisabled) logStream = undefined
  })
  return stream
}

function disableLogging(): void {
  loggingDisabled = true
  const stream = logStream
  logStream = undefined
  logPath = undefined
  queue = []
  queueBytes = 0
  writing = false
  inFlightBytes = 0
  rotating = false
  notifyFlushWaiters()
  if (!stream) return
  try {
    stream.destroy()
  } catch {
    // no-op
  }
}

function reportDiskFailure(error: unknown): void {
  if (diskFailureReported) return
  diskFailureReported = true
  try {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    process.stderr.write(`[openagent debug-log] disabled after disk failure: ${reason}\n`)
  } catch {
    // A broken stderr must not become an application error.
  }
}

function isDetailLevel(level: DebugLogLevel): boolean {
  return level === 'debug'
}

function normalizeLevel(value: unknown, fallback: DebugLogLevel): DebugLogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' ||
    value === 'error' || value === 'fatal' ? value : fallback
}

function contextFromFields(fields: Record<string, unknown>): DebugContext {
  const inherited = getDebugContext()
  const context: DebugContext = { ...inherited }
  for (const key of CONTEXT_KEYS) {
    const value = fields[key]
    if (typeof value === 'string' && value.length > 0) context[key] = value
  }
  return context
}

function readFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {}
  const result: Record<string, unknown> = {}
  try {
    for (const key of Object.keys(fields)) {
      try {
        result[key] = fields[key]
      } catch (error) {
        result[key] = `[unreadable field: ${String(error)}]`
      }
    }
  } catch (error) {
    result.fieldsReadError = String(error)
  }
  return result
}

function serializeError(error: unknown): unknown {
  return safeValue(error)
}

function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return '[unreadable field]'
  }
}

function safeErrorValue(
  error: Error,
  seen: WeakSet<object>,
  depth: number
): unknown {
  if (seen.has(error)) return '[Circular]'
  seen.add(error)
  const result: Record<string, unknown> = {
    name: readProperty(error, 'name'),
    message: readProperty(error, 'message'),
    stack: readProperty(error, 'stack')
  }
  try {
    for (const key of Object.keys(error)) {
      result[key] = safeValue(readProperty(error, key), seen, depth + 1)
    }
  } catch {
    // Standard Error fields above are still useful if custom fields throw.
  }
  // `cause` and AggregateError.errors are non-enumerable in common runtimes.
  for (const key of ['cause', 'errors']) {
    try {
      if (key in error && !(key in result)) {
        result[key] = safeValue(readProperty(error, key), seen, depth + 1)
      }
    } catch {
      // Keep the serializable Error envelope if an exotic proxy throws.
    }
  }
  seen.delete(error)
  return result
}

/** Converts arbitrary application values to JSON-safe values without throws. */
function safeValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
    return value
  }
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value === 'undefined') return undefined
  if (typeof value === 'symbol') return String(value)
  if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ''}]`
  if (depth >= 32) return '[MaxDepth]'
  if (typeof value !== 'object') return String(value)
  let addedToSeen = false
  try {
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Error) return safeErrorValue(value, seen, depth)
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    addedToSeen = true
    if (Array.isArray(value)) {
      return value.map(item => {
        try {
          return safeValue(item, seen, depth + 1)
        } catch (error) {
          return `[unreadable array item: ${String(error)}]`
        }
      })
    }
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      try {
        result[key] = safeValue((value as Record<string, unknown>)[key], seen, depth + 1)
      } catch (error) {
        result[key] = `[unreadable field: ${String(error)}]`
      }
    }
    return result
  } catch (error) {
    return `[unreadable value: ${String(error)}]`
  } finally {
    if (addedToSeen) seen.delete(value)
  }
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? 'null' : serialized
  } catch (error) {
    return JSON.stringify(`[unserializable: ${String(error)}]`)
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function utf8PrefixLength(encoded: Buffer, maxBytes: number): number {
  let length = Math.min(encoded.byteLength, Math.max(0, Math.floor(maxBytes)))
  // Buffer#toString replaces an incomplete trailing code point with U+FFFD.
  // Move the boundary back to the beginning of that code point instead.
  while (length > 0 && length < encoded.byteLength &&
    (encoded[length] & 0xc0) === 0x80) {
    length -= 1
  }
  return length
}

function truncateEncodedString(encoded: Buffer, maxBytes: number): string {
  return encoded.subarray(0, utf8PrefixLength(encoded, maxBytes)).toString('utf8')
}

function truncateStringToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return value
  return truncateEncodedString(bytes, maxBytes)
}

function truncatedValue(value: unknown, maxEncodedBytes: number): unknown {
  if (typeof value === 'string') {
    // Keep one UTF-8 encoding for the whole search. The previous implementation
    // rebuilt a full-size Buffer for every binary-search candidate, which made a
    // single multi-megabyte string block the main process for hundreds of ms.
    const encodedValue = Buffer.from(value, 'utf8')
    const valueBytes = encodedValue.byteLength
    const encodedLimit = Math.max(0, Math.floor(maxEncodedBytes))
    if (valueBytes <= encodedLimit) {
      const original = safeJson(value)
      if (byteLength(original) <= encodedLimit) return value
    }
    const suffixFor = (prefix: string, prefixBytes: number): string =>
      `${prefix}…(${Math.max(0, valueBytes - prefixBytes)} bytes omitted)`
    let low = 0
    // A prefix longer than the event's available byte budget cannot fit in the
    // candidate JSON. Bounding this search also bounds each candidate's
    // serialization when the original string is very large.
    let high = Math.min(valueBytes, encodedLimit)
    let best = '…(0 bytes omitted)'
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const prefixBytes = utf8PrefixLength(encodedValue, middle)
      const prefix = encodedValue.subarray(0, prefixBytes).toString('utf8')
      const candidate = suffixFor(prefix, prefixBytes)
      if (byteLength(JSON.stringify(candidate)) <= encodedLimit) {
        best = candidate
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return best
  }
  const original = safeJson(value)
  const originalBytes = byteLength(original)
  if (originalBytes <= maxEncodedBytes) return value
  const marker = { truncated: true, originalBytes }
  if (byteLength(safeJson(marker)) <= maxEncodedBytes) return marker
  return '[truncated]'
}

function eventBuffer(record: Record<string, unknown>): Buffer {
  const full = safeJson(record)
  const fullBytes = byteLength(full)
  if (fullBytes < MAX_EVENT_BYTES - 1) return Buffer.from(`${full}\n`, 'utf8')

  const candidate: Record<string, unknown> = {
    ...record,
    truncated: true,
    originalBytes: fullBytes
  }
  // Context identifiers are normally short, but they are caller supplied and
  // must not defeat the event limit themselves.
  for (const key of ENVELOPE_KEYS) {
    if (typeof candidate[key] === 'string') {
      candidate[key] = truncateStringToBytes(candidate[key] as string, 4 * 1024)
    }
  }
  const nonEnvelopeKeys = Object.keys(candidate)
    .filter(key => !ENVELOPE_KEYS.has(key) && key !== 'truncated' && key !== 'originalBytes')
    .sort((left, right) => byteLength(safeJson(candidate[right])) - byteLength(safeJson(candidate[left])))

  for (const key of nonEnvelopeKeys) {
    const current = byteLength(safeJson(candidate))
    if (current < MAX_EVENT_BYTES - 1) break
    const withoutValue = { ...candidate }
    delete withoutValue[key]
    // Leave room for commas, the NDJSON newline, and the marker fields. A
    // tight exact fit would trigger the minimal-envelope fallback and lose
    // the useful prefix entirely.
    const availableForValue = MAX_EVENT_BYTES - 1 - byteLength(safeJson(withoutValue)) - 1_024
    if (availableForValue > 16) candidate[key] = truncatedValue(candidate[key], availableForValue)
    else delete candidate[key]
  }

  let serialized = safeJson(candidate)
  if (byteLength(serialized) >= MAX_EVENT_BYTES - 1) {
    // Keep the stable envelope when even the first truncation pass cannot fit.
    const minimal: Record<string, unknown> = {}
    for (const key of ENVELOPE_KEYS) {
      if (key in record) minimal[key] = record[key]
    }
    minimal.truncated = true
    minimal.originalBytes = fullBytes
    serialized = safeJson(minimal)
  }
  // Envelope fields are bounded in practice, but keep a final hard guard if a
  // caller supplied an unusually long context identifier or event name.
  if (byteLength(serialized) >= MAX_EVENT_BYTES - 1) {
    serialized = safeJson({
      schemaVersion: SCHEMA_VERSION,
      ts: new Date().toISOString(),
      seq: record.seq,
      pid: process.pid,
      bootId: truncateStringToBytes(bootId, 128),
      level: record.level,
      module: truncateStringToBytes(String(record.module), 512),
      evt: truncateStringToBytes(String(record.evt), 512),
      truncated: true,
      originalBytes: fullBytes
    })
  }
  return Buffer.from(`${serialized}\n`, 'utf8')
}

function shouldWrite(level: DebugLogLevel): boolean {
  // Read the environment at call time so test harnesses and local launchers
  // can switch modes before reinitializing the stream.
  const mode = resolveMode()
  if (mode === 'off') return false
  return mode === 'detail' || !isDetailLevel(level)
}

function isCritical(level: DebugLogLevel, evt: string): boolean {
  // Summary records are the reserved portion of the queue. Detail records
  // can be discarded first when a critical/summary record needs space.
  return !isDetailLevel(level) || evt === 'debug-log.dropped'
}

function removeOldestNonCritical(): boolean {
  const index = queue.findIndex(entry => !entry.critical)
  if (index < 0) return false
  const [removed] = queue.splice(index, 1)
  if (removed) {
    queueBytes -= removed.data.byteLength
    droppedEvents += 1
    return true
  }
  return false
}

function enqueue(data: Buffer, critical: boolean): void {
  const pendingBytes = queueBytes + inFlightBytes
  if (!critical && pendingBytes + data.byteLength > MAX_QUEUE_BYTES - CRITICAL_QUEUE_RESERVE_BYTES) {
    droppedEvents += 1
    return
  }
  if (critical) {
    while (queueBytes + inFlightBytes + data.byteLength > MAX_QUEUE_BYTES && removeOldestNonCritical()) {
      // Reserve space by evicting queued summary/detail records first.
    }
    if (queueBytes + inFlightBytes + data.byteLength > MAX_QUEUE_BYTES) {
      droppedEvents += 1
      return
    }
  }
  queue.push({ data, critical })
  queueBytes += data.byteLength
  schedulePump()
}

function enqueueDropSummaryIfPossible(): void {
  if (droppedEvents === 0 || loggingDisabled) return
  // Make room for the marker by evicting detail records. If the queue is made
  // entirely of summary records, retain the counter and try again next batch.
  const reservation = 256
  while (queueBytes + inFlightBytes + reservation > MAX_QUEUE_BYTES && removeOldestNonCritical()) {
    // removeOldestNonCritical accounts for each additional dropped record.
  }
  const count = droppedEvents
  const event = contextStorage.run({}, () =>
    buildEvent('debug-log.dropped', { droppedEvents: count }, 'warn')
  )
  if (!event) return
  if (queueBytes + inFlightBytes + event.data.byteLength > MAX_QUEUE_BYTES) return
  droppedEvents = 0
  queue.push(event)
  queueBytes += event.data.byteLength
}

function schedulePump(): void {
  if (pumpScheduled || writing || rotating || loggingDisabled ||
    (queue.length === 0 && droppedEvents === 0)) {
    notifyFlushWaiters()
    return
  }
  pumpScheduled = true
  setImmediate(() => {
    pumpScheduled = false
    pumpQueue()
  })
}

function pumpQueue(): void {
  if (writing || rotating || loggingDisabled) {
    notifyFlushWaiters()
    return
  }
  const stream = logStream
  if (!stream) {
    if (loggingInitialized) reportDiskFailure(new Error('log stream unavailable'))
    disableLogging()
    return
  }
  enqueueDropSummaryIfPossible()
  if (queue.length === 0) {
    notifyFlushWaiters()
    return
  }

  const batch: QueueEntry[] = []
  let batchBytes = 0
  while (queue.length > 0 && batch.length < BATCH_MAX_EVENTS) {
    const entry = queue[0]
    if (!entry) break
    if (batch.length > 0 && batchBytes + entry.data.byteLength > BATCH_MAX_BYTES) break
    queue.shift()
    queueBytes -= entry.data.byteLength
    batch.push(entry)
    batchBytes += entry.data.byteLength
  }
  if (batch.length === 0) {
    notifyFlushWaiters()
    return
  }
  if (currentFileBytes > 0 && currentFileBytes + batchBytes > rotationBytes()) {
    // The prior batch has completed before pumpQueue runs, so rotation cannot
    // race an in-flight stream write.
    queue = [...batch, ...queue]
    queueBytes += batchBytes
    rotateLogFile()
    return
  }

  writing = true
  inFlightBytes = batchBytes
  const data = Buffer.concat(batch.map(entry => entry.data), batchBytes)
  try {
    stream.write(data, () => {
      writing = false
      inFlightBytes = 0
      currentFileBytes += batchBytes
      schedulePump()
      notifyFlushWaiters()
    })
  } catch (error) {
    writing = false
    inFlightBytes = 0
    reportDiskFailure(error)
    disableLogging()
  }
}

function rotateLogFile(): void {
  if (rotating || loggingDisabled) return
  const oldStream = logStream
  const directory = logDirectory
  if (!oldStream || !directory) {
    disableLogging()
    return
  }
  rotating = true
  logStream = undefined
  try {
    oldStream.end(() => {
      if (loggingDisabled) {
        rotating = false
        notifyFlushWaiters()
        return
      }
      try {
        // The old active part is closed now. Retain room for the new part's
        // full rotation threshold before opening it; this avoids synchronous
        // directory scans on every ordinary event write.
        pruneOldLogFiles(directory, rotationBytes())
        const path = createLogPath(directory)
        writeFileSync(path, '', { flag: 'a', mode: 0o600 })
        if (typeof chmodSync === 'function') chmodSync(path, 0o600)
        logPath = path
        currentFileBytes = 0
        logStream = openStream(path)
        rotating = false
        schedulePump()
        notifyFlushWaiters()
      } catch (error) {
        rotating = false
        reportDiskFailure(error)
        disableLogging()
      }
    })
  } catch (error) {
    rotating = false
    reportDiskFailure(error)
    disableLogging()
  }
}

function isIdle(): boolean {
  return queue.length === 0 && droppedEvents === 0 && !writing && !pumpScheduled && !rotating
}

function notifyFlushWaiters(): void {
  if (!isIdle() && !loggingDisabled) return
  const waiters = flushWaiters
  flushWaiters = []
  for (const waiter of waiters) {
    if (waiter.timer) clearTimeout(waiter.timer)
    try {
      waiter.resolve()
    } catch {
      // Promise resolution itself is not expected to throw, but diagnostics
      // should still be harmless if an exotic thenable is involved.
    }
  }
}

/** Flushes queued records for at most timeoutMs milliseconds. */
export function flushDebugLog(timeoutMs = 1_000): Promise<void> {
  if (!loggingInitialized || loggingDisabled || isIdle()) return Promise.resolve()
  const boundedTimeout = Math.max(0, timeoutMs)
  return new Promise(resolve => {
    const waiter: FlushWaiter = { resolve, timer: undefined }
    waiter.timer = setTimeout(() => {
      const index = flushWaiters.indexOf(waiter)
      if (index >= 0) flushWaiters.splice(index, 1)
      resolve()
    }, boundedTimeout)
    flushWaiters.push(waiter)
    schedulePump()
    notifyFlushWaiters()
  })
}

/** Returns the current async-local debug context, or an empty context. */
export function getDebugContext(): DebugContext {
  return { ...contextStorage.getStore() }
}

/** Starts a new trace while carrying forward useful local correlation IDs. */
export function createDebugTrace(fields: DebugContext = {}): DebugContext {
  const current = getDebugContext()
  const context: DebugContext = { ...current, ...fields, traceId: createId() }
  if (!Object.hasOwn(fields, 'spanId')) delete context.spanId
  if (!Object.hasOwn(fields, 'parentSpanId') && current.spanId) context.parentSpanId = current.spanId
  return context
}

/** Runs fn with fields merged into the current async-local context. */
export function withDebugContext<T>(context: DebugContext, fn: () => T): T {
  const merged: DebugContext = { ...getDebugContext(), ...context }
  return contextStorage.run(merged, fn)
}

interface BuiltEvent {
  readonly data: Buffer
  readonly critical: boolean
}

function buildEvent(
  evt: string,
  fields: Record<string, unknown> | undefined,
  defaultLevel: DebugLogLevel
): BuiltEvent | undefined {
  try {
    if (!loggingInitialized || loggingDisabled) return undefined
    const input = readFields(fields)
    const level = normalizeLevel(input.level, defaultLevel)
    if (!shouldWrite(level)) return undefined
    const module = typeof input.module === 'string' && input.module.length > 0
      ? input.module
      : (evt.split('.', 1)[0] || DEFAULT_MODULE)
    const inherited = contextFromFields(input)
    const payload: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      if (key === 'level' || key === 'module' || CONTEXT_KEYS.includes(key as keyof DebugContext)) continue
      payload[key] = safeValue(value)
    }
    const record: Record<string, unknown> = {
      ...payload,
      schemaVersion: SCHEMA_VERSION,
      ts: new Date().toISOString(),
      seq: ++sequence,
      pid: process.pid,
      bootId,
      level,
      module,
      evt
    }
    for (const key of CONTEXT_KEYS) {
      const value = inherited[key]
      if (typeof value === 'string' && value.length > 0) record[key] = value
    }
    const data = eventBuffer(record)
    return { data, critical: isCritical(level, evt) }
  } catch {
    // Logging must never throw into business code, including for hostile
    // getters, proxies, circular values, or an unavailable stream.
    return undefined
  }
}

function writeEvent(
  evt: string,
  fields: Record<string, unknown> | undefined,
  defaultLevel: DebugLogLevel
): void {
  try {
    const event = buildEvent(evt, fields, defaultLevel)
    if (event) enqueue(event.data, event.critical)
  } catch {
    // Queue scheduling and allocation are diagnostic work too; never surface
    // their failures to the caller's business path.
  }
}

/** Writes a summary event (and a detail event when detail mode is enabled). */
export function debugLog(evt: string, fields: Record<string, unknown> = {}): void {
  writeEvent(evt, fields, 'info')
}

/** Writes a detail-only event. */
export function debugDetail(evt: string, fields: Record<string, unknown> = {}): void {
  if (!loggingInitialized || loggingDisabled || getDebugLogMode() !== 'detail') return
  writeEvent(evt, { ...readFields(fields), level: 'debug' }, 'debug')
}

/** Writes an error event with structured error information. */
export function debugError(
  evt: string,
  error: unknown,
  fields: Record<string, unknown> = {}
): void {
  if (!loggingInitialized || loggingDisabled || getDebugLogMode() === 'off') return
  const input = readFields(fields)
  input.error = serializeError(error)
  // Errors are always summary-visible. Callers may opt into `fatal`, but a
  // stray debug/detail level must not hide a failure record in summary mode.
  const level: DebugLogLevel = input.level === 'fatal' ? 'fatal' : 'error'
  input.level = level
  writeEvent(evt, input, level)
}

export interface DebugSpan {
  readonly context: DebugContext
  end(fields?: Record<string, unknown>): void
  fail(error: unknown, fields?: Record<string, unknown>): void
}

/** Starts a span and emits its started/completed/failed lifecycle events. */
export function startDebugSpan(
  evt: string,
  fields: Record<string, unknown> = {}
): DebugSpan {
  const parent = getDebugContext()
  const input = readFields(fields)
  const explicitContext = contextFromFields(input)
  const context: DebugContext = {
    ...parent,
    ...explicitContext,
    traceId: explicitContext.traceId ?? createId(),
    spanId: createId()
  }
  if (explicitContext.spanId) context.parentSpanId = explicitContext.spanId
  else if (explicitContext.parentSpanId) context.parentSpanId = explicitContext.parentSpanId
  else delete context.parentSpanId
  const startedAt = process.hrtime.bigint()
  let completed = false

  withDebugContext(context, () => {
    writeEvent(`${evt}.started`, { ...input, ...context, durationMs: 0 }, 'info')
  })

  const spanIdentity = {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId
  }

  const elapsedMilliseconds = (): number => Number(process.hrtime.bigint() - startedAt) / 1_000_000
  const end = (extra: Record<string, unknown> = {}): void => {
    if (completed) return
    completed = true
    withDebugContext(context, () => {
      writeEvent(`${evt}.completed`, {
        ...readFields(extra), ...spanIdentity, durationMs: elapsedMilliseconds()
      }, 'info')
    })
  }
  const fail = (error: unknown, extra: Record<string, unknown> = {}): void => {
    if (completed) return
    completed = true
    withDebugContext(context, () => {
      debugError(`${evt}.failed`, error, {
        ...readFields(extra), ...spanIdentity, durationMs: elapsedMilliseconds()
      })
    })
  }
  return { context, end, fail }
}

function pruneOldLogFiles(directory: string, reserveBytes = 0): void {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return
  }
  const now = Date.now()
  const ageLimit = retentionDays() * 24 * 60 * 60 * 1_000
  const files = names.flatMap(name => {
    if (!name.startsWith(LOG_FILE_PREFIX) || !name.endsWith(LOG_FILE_SUFFIX)) return []
    const path = join(directory, name)
    try {
      const stats = statSync(path)
      return [{ name, path, bytes: stats.size, modifiedAt: stats.mtimeMs }]
    } catch {
      return []
    }
  }).sort((left, right) => left.modifiedAt - right.modifiedAt)

  const ownPath = logPath
  const liveActivePaths = activeLiveLogPaths(files)
  const budget = Math.max(0, retentionBytes() - reserveBytes)
  let totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  for (const file of files) {
    if (file.path === ownPath || liveActivePaths.has(file.path)) continue
    const tooOld = ageLimit === 0 || now - file.modifiedAt > ageLimit
    const overBudget = totalBytes > budget
    if (!tooOld && !overBudget) continue
    try {
      // Recheck the current file path before removing it: a process can rotate
      // while another process is pruning the directory.
      if (file.path === logPath || activeLiveLogPaths(files).has(file.path)) continue
      unlinkSync(file.path)
      totalBytes -= file.bytes
    } catch {
      // Retention is best effort and must not disable active logging.
    }
  }
}

interface ParsedLogName {
  readonly pid: number
  readonly boot: string
  readonly part: number
}

function parseLogName(name: string): ParsedLogName | undefined {
  const current = name.match(/^openagent-.*-pid(\d+)-boot(.+)-part(\d+)\.jsonl$/)
  if (current) {
    return { pid: Number(current[1]), boot: current[2], part: Number(current[3]) }
  }
  const legacy = name.match(/^openagent-.*-(\d+)\.jsonl$/)
  if (legacy) return { pid: Number(legacy[1]), boot: 'legacy', part: 1 }
  return undefined
}

function isLivePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error &&
      (error as { code?: string }).code === 'EPERM'
  }
}

function activeLiveLogPaths(
  files: readonly { name: string; path: string }[]
): Set<string> {
  const highestByProcessBoot = new Map<string, { path: string; part: number }>()
  for (const file of files) {
    const parsed = parseLogName(file.name)
    if (!parsed || !isLivePid(parsed.pid)) continue
    const key = `${parsed.pid}:${parsed.boot}`
    const existing = highestByProcessBoot.get(key)
    if (!existing || parsed.part > existing.part) {
      highestByProcessBoot.set(key, { path: file.path, part: parsed.part })
    }
  }
  return new Set([...highestByProcessBoot.values()].map(value => value.path))
}
