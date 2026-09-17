import { readFile, rename, stat } from 'node:fs/promises'
import {
  type BartTelemetryExecutionUsageSample,
  type BartTelemetryLedgerCapability,
  type BartTelemetryLedgerCycle,
  type BartTelemetryLedgerModelTotals,
  type BartTelemetryLedgerReading,
  type BartTelemetryLedgerSample,
  type BartTelemetryLedgerSnapshot,
  type BartTelemetryMetering,
  type BartTelemetryWindowReadingSample
} from '@openagent/contracts'
import { writePrivateFileAtomically } from './atomic-file'

const CURRENT_SCHEMA_VERSION = 1
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_COMPLETED_CYCLES = 3
const MAX_MODEL_ROWS = 32
const MAX_WINDOWS = 256
const MAX_RECENT_SAMPLE_IDS = 4_096
const MAX_PENDING_EXECUTION_SAMPLES = 4_096
const MAX_MODEL_LENGTH = 256
const MAX_ID_LENGTH = 512
const MAX_SAMPLE_ID_LENGTH = 512
const OVERFLOW_MODEL = '(other models)'
const FLUSH_DEBOUNCE_MS = 15_000
const RESET_DROP_PERCENT = 30
const ABSOLUTE_RESET_DROP_PERCENT = 1
const ADDITIVE_TOKEN_FIELDS = [
  'inputTokens',
  'uncachedInputTokens',
  'cachedReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens'
] as const
const TOTAL_NUMBER_FIELDS = [...ADDITIVE_TOKEN_FIELDS, 'costUsd'] as const
const METERINGS: readonly BartTelemetryMetering[] = [
  'token',
  'request',
  'monetary',
  'credit'
]

type SnapshotWriter = (path: string, serialized: string) => Promise<void>
type MutableModelTotals = {
  -readonly [Key in keyof BartTelemetryLedgerModelTotals]:
    BartTelemetryLedgerModelTotals[Key]
}

interface LedgerReading {
  observedAt: number
  usedPercent: number | null
  usedUnits?: number
  limitUnits?: number
}

interface LedgerCycle {
  first: LedgerReading
  latest: LedgerReading
  /** Boundary captured when this cycle opened. */
  closesAt?: number
  byModel: MutableModelTotals[]
}

interface WindowState {
  id: string
  metering: Exclude<BartTelemetryMetering, 'request'>
  current: LedgerCycle
  /** Most recent first. */
  completed: LedgerCycle[]
}

/**
 * Provider-neutral replay fact retained only until the first attributable
 * window generation arrives. Public execution identity is intentionally not
 * persisted because it is neither needed for attribution nor stable across a
 * Thread reclaim.
 */
interface PendingExecutionUsageSample {
  sampleId: string
  observedAt: number
  model: string
  usageKind: 'generation' | 'summary'
  inputTokens?: number
  uncachedInputTokens?: number
  cachedReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  costUsd?: number
}

interface PersistedSnapshot {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION
  generatedAt: number
  windows: WindowState[]
  /** Oldest to newest; values are opaque and compared only by exact equality. */
  recentSampleIds: string[]
  /** Oldest to newest; native payloads never cross this generic schema. */
  pendingExecutionSamples: PendingExecutionUsageSample[]
}

interface LoadedSnapshot {
  windows: WindowState[]
  recentSampleIds: string[]
  pendingExecutionSamples: PendingExecutionUsageSample[]
}

export interface BartTelemetryLedgerOptions {
  /** Test seam; production uses the owner-only atomic writer. */
  readonly writeSnapshot?: SnapshotWriter
  /** Test seam used for quarantine names and generatedAt. */
  readonly now?: () => number
  /** Observes timer-driven failures while retaining the dirty snapshot. */
  readonly onBackgroundPersistenceError?: (error: unknown) => void
}

/**
 * Current-format, provider-neutral Bart telemetry ledger.
 *
 * A composition root gives each Harness its own instance/path. Consequently
 * neither the persisted schema nor this capability carries a provider ID, and
 * a Plugin cannot address or observe another Plugin's facts.
 */
export class BartTelemetryLedger implements BartTelemetryLedgerCapability {
  readonly path: string
  private windows: WindowState[] = []
  private recentSampleIds: string[] = []
  private recentSampleIdSet = new Set<string>()
  private pendingExecutionSamples: PendingExecutionUsageSample[] = []
  private pendingExecutionSampleIdSet = new Set<string>()
  private dirty = false
  private flushTimer: NodeJS.Timeout | undefined
  private flushTail: Promise<void> = Promise.resolve()
  private disposePromise: Promise<void> | undefined
  private disposed = false
  private readonly writeSnapshot: SnapshotWriter
  private readonly now: () => number
  private readonly onBackgroundPersistenceError: (error: unknown) => void

  private constructor(path: string, options: BartTelemetryLedgerOptions) {
    this.path = path
    this.writeSnapshot = options.writeSnapshot ?? writePrivateFileAtomically
    this.now = options.now ?? Date.now
    this.onBackgroundPersistenceError = options.onBackgroundPersistenceError ?? (() => undefined)
  }

  static async open(
    path: string,
    options: BartTelemetryLedgerOptions = {}
  ): Promise<BartTelemetryLedger> {
    const ledger = new BartTelemetryLedger(path, options)
    const loaded = await loadCurrentSnapshot(path, ledger.now)
    ledger.windows = loaded.windows
    ledger.recentSampleIds = loaded.recentSampleIds
    ledger.recentSampleIdSet = new Set(loaded.recentSampleIds)
    ledger.pendingExecutionSamples = loaded.pendingExecutionSamples
    ledger.pendingExecutionSampleIdSet = new Set(
      loaded.pendingExecutionSamples.map(({ sampleId }) => sampleId)
    )
    return ledger
  }

  async record(sample: BartTelemetryLedgerSample): Promise<void> {
    if (this.disposed) throw new Error('Bart telemetry ledger 已关闭')
    let changed: boolean
    if (sample.type === 'execution-usage') {
      if (
        !validSampleId(sample.sampleId) ||
        this.recentSampleIdSet.has(sample.sampleId) ||
        this.pendingExecutionSampleIdSet.has(sample.sampleId)
      ) return
      const normalized = normalizeExecutionUsageSample(sample)
      if (!normalized) return
      if (this.windows.length === 0) {
        this.rememberPendingExecutionSample(normalized)
      } else {
        this.applyExecutionUsage(normalized)
        // Once at least one real ledger window exists, a substantive sample is
        // consumed even when every current window is inapplicable. Keeping it
        // pending could otherwise grow an unbounded retry queue.
        this.rememberSampleId(normalized.sampleId)
      }
      changed = true
    } else {
      changed = this.recordWindowReading(sample)
    }
    if (changed) this.markDirty()
  }

  read(): BartTelemetryLedgerSnapshot {
    return {
      windows: this.windows.map((window) => ({
        id: window.id,
        metering: window.metering,
        ledger: {
          currentCycle: publicCycle(window.current),
          completedCycles: window.completed.map(publicCycle)
        }
      }))
    }
  }

  /** Persists every mutation visible when, or while, this flush is running. */
  flush(): Promise<void> {
    this.clearFlushTimer()
    const operation = this.flushTail.catch(() => undefined).then(async () => {
      while (this.dirty) {
        const snapshot = structuredClone(this.windows)
        const recentSampleIds = [...this.recentSampleIds]
        const pendingExecutionSamples = structuredClone(this.pendingExecutionSamples)
        this.dirty = false
        try {
          await persistCurrentSnapshot(
            this.path,
            snapshot,
            recentSampleIds,
            pendingExecutionSamples,
            this.now(),
            this.writeSnapshot
          )
        } catch (error) {
          // Explicit or timer-driven callers may retry the exact authoritative
          // in-memory state. A failed write never clears the durability debt.
          this.dirty = true
          throw error
        }
      }
    })
    this.flushTail = operation
    return operation
  }

  /** Shutdown alias for owners that describe persistence as queue draining. */
  drain(): Promise<void> {
    return this.flush()
  }

  /** Prevents new samples, cancels the debounce timer and drains persistence. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.disposePromise = this.flush()
    return this.disposePromise
  }

  private applyExecutionUsage(sample: PendingExecutionUsageSample): void {
    const additive = sample.usageKind === 'generation'
    const hasUncachedInput = nonnegativeFinite(sample.uncachedInputTokens) !== undefined
    const hasTokenConsumption = additive && ADDITIVE_TOKEN_FIELDS.some((field) => {
      if (field === 'inputTokens' && hasUncachedInput) return false
      return positiveFinite(sample[field]) !== undefined
    })
    const costUsd = positiveFinite(sample.costUsd)

    for (const window of this.windows) {
      if (
        window.current.closesAt !== undefined &&
        sample.observedAt > window.current.closesAt
      ) {
        // Do not attribute consumption beyond a known reset until a fresh
        // reading establishes the new cycle.
        continue
      }
      if (window.metering === 'monetary' && costUsd === undefined) continue

      const row = modelRow(window.current, sample.model)
      if (additive) row.usageEvents = boundedSum(row.usageEvents, 1)
      if (window.metering !== 'monetary' && hasTokenConsumption) {
        for (const field of ADDITIVE_TOKEN_FIELDS) {
          // Provider-raw input is only a fallback. A disjoint uncached input
          // fact in the same observation must not be counted a second time.
          if (field === 'inputTokens' && hasUncachedInput) continue
          const value = positiveFinite(sample[field])
          if (value !== undefined) row[field] = boundedSum(row[field] ?? 0, value)
        }
      }
      if (costUsd !== undefined) row.costUsd = boundedSum(row.costUsd ?? 0, costUsd)
    }
  }

  private recordWindowReading(sample: BartTelemetryWindowReadingSample): boolean {
    if (!validTimestamp(sample.observedAt)) return false
    let changed = false
    for (const candidate of sample.windows) {
      const id = normalizedIdentifier(candidate.id)
      if (!id || !isMetering(candidate.metering)) continue

      const existingIndex = this.windows.findIndex((window) => window.id === id)
      if (candidate.metering === 'request') {
        // Request windows already carry native absolute counts and must never
        // expose a locally inferred ledger.
        if (existingIndex >= 0) {
          this.windows.splice(existingIndex, 1)
          changed = true
        }
        continue
      }

      const reading = normalizedReading(sample.observedAt, candidate)
      const closesAt = cycleBoundary(sample.observedAt, candidate)
      const state = existingIndex >= 0 ? this.windows[existingIndex] : undefined
      if (!state || state.metering !== candidate.metering) {
        if (state) this.windows.splice(existingIndex, 1)
        this.windows.push({
          id,
          metering: candidate.metering,
          current: newCycle(reading, closesAt),
          completed: []
        })
        while (this.windows.length > MAX_WINDOWS) dropStalestWindow(this.windows)
        sortWindows(this.windows)
        changed = true
        continue
      }
      if (reading.observedAt < state.current.latest.observedAt) continue

      if (cycleClosed(state.current, reading)) {
        if (state.current.byModel.length) {
          state.completed = [state.current, ...state.completed].slice(0, MAX_COMPLETED_CYCLES)
        }
        state.current = newCycle(reading, closesAt)
      } else {
        state.current.latest = reading
      }
      changed = true
    }
    if (this.windows.length > 0 && this.pendingExecutionSamples.length > 0) {
      const pending = this.pendingExecutionSamples
      this.pendingExecutionSamples = []
      this.pendingExecutionSampleIdSet.clear()
      for (const replay of pending) {
        this.applyExecutionUsage(replay)
        this.rememberSampleId(replay.sampleId)
      }
      changed = true
    }
    return changed
  }

  private rememberPendingExecutionSample(sample: PendingExecutionUsageSample): void {
    this.pendingExecutionSamples.push(sample)
    this.pendingExecutionSampleIdSet.add(sample.sampleId)
    while (this.pendingExecutionSamples.length > MAX_PENDING_EXECUTION_SAMPLES) {
      const expired = this.pendingExecutionSamples.shift()
      if (!expired) continue
      this.pendingExecutionSampleIdSet.delete(expired.sampleId)
      // Bounded overflow is a deliberate consume/drop decision. Retaining the
      // opaque id prevents an evicted native replay from being charged later.
      this.rememberSampleId(expired.sampleId)
    }
  }

  private rememberSampleId(sampleId: string): void {
    this.recentSampleIds.push(sampleId)
    this.recentSampleIdSet.add(sampleId)
    while (this.recentSampleIds.length > MAX_RECENT_SAMPLE_IDS) {
      const expired = this.recentSampleIds.shift()
      if (expired !== undefined) this.recentSampleIdSet.delete(expired)
    }
  }

  private markDirty(): void {
    this.dirty = true
    this.clearFlushTimer()
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush().catch(error => {
        try {
          this.onBackgroundPersistenceError(error)
        } catch {
          // Telemetry error reporting cannot be allowed to crash Main.
        }
      })
    }, FLUSH_DEBOUNCE_MS)
    this.flushTimer.unref()
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
  }
}

function newCycle(reading: LedgerReading, closesAt: number | undefined): LedgerCycle {
  return {
    first: reading,
    latest: reading,
    ...(closesAt === undefined ? {} : { closesAt }),
    byModel: []
  }
}

function cycleClosed(cycle: LedgerCycle, reading: LedgerReading): boolean {
  if (cycle.closesAt !== undefined && reading.observedAt > cycle.closesAt) return true
  if (
    cycle.latest.usedPercent !== null &&
    reading.usedPercent !== null &&
    cycle.latest.usedPercent - reading.usedPercent >= RESET_DROP_PERCENT
  ) {
    return true
  }
  return cycle.latest.usedUnits !== undefined &&
    reading.usedUnits !== undefined &&
    reading.usedUnits < cycle.latest.usedUnits &&
    cycle.latest.usedPercent !== null &&
    reading.usedPercent !== null &&
    cycle.latest.usedPercent - reading.usedPercent >= ABSOLUTE_RESET_DROP_PERCENT
}

function cycleBoundary(
  observedAt: number,
  value: BartTelemetryWindowReadingSample['windows'][number]
): number | undefined {
  if (value.resetsAt !== null) {
    const parsed = Date.parse(value.resetsAt)
    if (validTimestamp(parsed) && parsed >= observedAt) return parsed
  }
  const durationMinutes = positiveFinite(value.durationMinutes)
  if (durationMinutes === undefined) return undefined
  const boundary = observedAt + durationMinutes * 60_000
  return validTimestamp(boundary) ? boundary : undefined
}

function normalizedReading(
  observedAt: number,
  value: BartTelemetryWindowReadingSample['windows'][number]
): LedgerReading {
  const usedPercent = value.usedPercent === null
    ? null
    : finite(value.usedPercent) ?? null
  const usedUnits = nonnegativeFinite(value.usedUnits)
  const limitUnits = nonnegativeFinite(value.limitUnits)
  return {
    observedAt,
    usedPercent,
    ...(usedUnits === undefined ? {} : { usedUnits }),
    ...(limitUnits === undefined ? {} : { limitUnits })
  }
}

function modelRow(cycle: LedgerCycle, model: string): MutableModelTotals {
  const existing = cycle.byModel.find((row) => row.model === model)
  if (existing) return existing
  const concreteRows = cycle.byModel.filter((row) => row.model !== OVERFLOW_MODEL)
  const targetModel = model === OVERFLOW_MODEL || concreteRows.length >= MAX_MODEL_ROWS - 1
    ? OVERFLOW_MODEL
    : model
  const overflow = cycle.byModel.find((row) => row.model === targetModel)
  if (overflow) return overflow
  const row: MutableModelTotals = { model: targetModel, usageEvents: 0 }
  cycle.byModel.push(row)
  cycle.byModel.sort(compareModelRows)
  return row
}

function publicCycle(cycle: LedgerCycle): BartTelemetryLedgerCycle {
  return {
    firstReading: publicReading(cycle.first),
    latestReading: publicReading(cycle.latest),
    byModel: cycle.byModel.map((row) => ({ ...row }))
  }
}

function publicReading(reading: LedgerReading): BartTelemetryLedgerReading {
  return {
    at: new Date(reading.observedAt).toISOString(),
    usedPercent: reading.usedPercent,
    ...(reading.usedUnits === undefined ? {} : { usedUnits: reading.usedUnits }),
    ...(reading.limitUnits === undefined ? {} : { limitUnits: reading.limitUnits })
  }
}

async function loadCurrentSnapshot(
  path: string,
  now: () => number
): Promise<LoadedSnapshot> {
  try {
    const metadata = await stat(path)
    if (metadata.size > MAX_FILE_BYTES) throw new Error('ledger exceeds hard file bound')
    const serialized = await readFile(path, 'utf8')
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) {
      throw new Error('ledger exceeds hard file bound')
    }
    const value = JSON.parse(serialized) as unknown
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, [
        'schemaVersion',
        'generatedAt',
        'windows',
        'recentSampleIds',
        'pendingExecutionSamples'
      ]) ||
      value.schemaVersion !== CURRENT_SCHEMA_VERSION ||
      !validTimestamp(value.generatedAt) ||
      !Array.isArray(value.windows) ||
      !Array.isArray(value.recentSampleIds) ||
      !Array.isArray(value.pendingExecutionSamples)
    ) {
      throw new Error('invalid current Bart telemetry ledger schema')
    }
    const windows = normalizeWindows(value.windows)
    if (windows.length !== value.windows.length) {
      throw new Error('invalid current Bart telemetry ledger window')
    }
    const recentSampleIds = normalizeRecentSampleIds(value.recentSampleIds)
    if (!recentSampleIds) {
      throw new Error('invalid current Bart telemetry ledger sample ids')
    }
    const pendingExecutionSamples = normalizePendingExecutionSamples(
      value.pendingExecutionSamples
    )
    if (!pendingExecutionSamples) {
      throw new Error('invalid current Bart telemetry ledger pending samples')
    }
    const recentSet = new Set(recentSampleIds)
    if (pendingExecutionSamples.some(({ sampleId }) => recentSet.has(sampleId))) {
      throw new Error('overlapping current Bart telemetry ledger sample ids')
    }
    return { windows, recentSampleIds, pendingExecutionSamples }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { windows: [], recentSampleIds: [], pendingExecutionSamples: [] }
    }
    await rename(path, `${path}.corrupt-${now()}`).catch(() => undefined)
    return { windows: [], recentSampleIds: [], pendingExecutionSamples: [] }
  }
}

async function persistCurrentSnapshot(
  path: string,
  windows: readonly WindowState[],
  recentSampleIds: readonly string[],
  pendingExecutionSamples: readonly PendingExecutionUsageSample[],
  generatedAt: number,
  writeSnapshot: SnapshotWriter
): Promise<void> {
  const normalizedPending = normalizePendingExecutionSamples(pendingExecutionSamples)
  if (!normalizedPending) {
    throw new Error('invalid in-memory Bart telemetry ledger pending samples')
  }
  const snapshot: PersistedSnapshot = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generatedAt: validTimestamp(generatedAt) ? generatedAt : Date.now(),
    windows: normalizeWindows(windows),
    recentSampleIds: normalizeRecentSampleIds(recentSampleIds) ?? [],
    pendingExecutionSamples: normalizedPending
  }
  let serialized = JSON.stringify(snapshot)
  while (
    Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES &&
    dropOldestCompletedCycle(snapshot.windows)
  ) {
    serialized = JSON.stringify(snapshot)
  }
  while (
    Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES &&
    dropStalestWindow(snapshot.windows)
  ) {
    serialized = JSON.stringify(snapshot)
  }
  while (
    Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES &&
    snapshot.recentSampleIds.length > 0
  ) {
    snapshot.recentSampleIds.shift()
    serialized = JSON.stringify(snapshot)
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) {
    // Pending samples must never be truncated independently from their opaque
    // exact-once identities. Retain dirty state and retry after a window drains
    // them instead of writing a snapshot that can double-charge after restart.
    throw new Error('Bart telemetry ledger exceeds hard file bound')
  }
  await writeSnapshot(path, serialized)
}

function normalizeRecentSampleIds(values: readonly unknown[]): string[] | undefined {
  if (values.length > MAX_RECENT_SAMPLE_IDS) return undefined
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!validSampleId(value) || seen.has(value)) return undefined
    seen.add(value)
    result.push(value)
  }
  return result
}

function normalizePendingExecutionSamples(
  values: readonly unknown[]
): PendingExecutionUsageSample[] | undefined {
  if (values.length > MAX_PENDING_EXECUTION_SAMPLES) return undefined
  const result: PendingExecutionUsageSample[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const parsed = normalizePersistedExecutionUsageSample(value)
    if (!parsed || seen.has(parsed.sampleId)) return undefined
    seen.add(parsed.sampleId)
    result.push(parsed)
  }
  return result
}

function normalizeExecutionUsageSample(
  sample: BartTelemetryExecutionUsageSample
): PendingExecutionUsageSample | undefined {
  if (!validSampleId(sample.sampleId) || !validTimestamp(sample.observedAt)) {
    return undefined
  }
  if (sample.usageKind === 'context') return undefined
  const hasUncachedInput = cappedNonnegativeFinite(sample.uncachedInputTokens) !== undefined
  const hasTokenConsumption = sample.usageKind === 'generation' &&
    ADDITIVE_TOKEN_FIELDS.some((field) => {
      if (field === 'inputTokens' && hasUncachedInput) return false
      return cappedPositiveFinite(sample[field]) !== undefined
    })
  const costUsd = cappedPositiveFinite(sample.costUsd)
  if (!hasTokenConsumption && costUsd === undefined) return undefined

  const normalized: PendingExecutionUsageSample = {
    sampleId: sample.sampleId,
    observedAt: sample.observedAt,
    model: normalizedModel(sample.model),
    usageKind: sample.usageKind
  }
  if (sample.usageKind === 'generation') {
    for (const field of ADDITIVE_TOKEN_FIELDS) {
      const value = cappedNonnegativeFinite(sample[field])
      if (value !== undefined) normalized[field] = value
    }
  }
  if (costUsd !== undefined) normalized.costUsd = costUsd
  return normalized
}

function normalizePersistedExecutionUsageSample(
  value: unknown
): PendingExecutionUsageSample | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['sampleId', 'observedAt', 'model', 'usageKind'],
    TOTAL_NUMBER_FIELDS
  )) return undefined
  if (
    !validSampleId(value.sampleId) ||
    !validTimestamp(value.observedAt) ||
    (value.usageKind !== 'generation' && value.usageKind !== 'summary')
  ) return undefined
  const model = normalizedPersistedModel(value.model)
  if (!model) return undefined
  if (
    value.usageKind === 'summary' &&
    ADDITIVE_TOKEN_FIELDS.some((field) => Object.hasOwn(value, field))
  ) return undefined

  const normalized: PendingExecutionUsageSample = {
    sampleId: value.sampleId,
    observedAt: value.observedAt,
    model,
    usageKind: value.usageKind
  }
  if (value.usageKind === 'generation') {
    for (const field of ADDITIVE_TOKEN_FIELDS) {
      if (!Object.hasOwn(value, field)) continue
      const parsed = persistedNonnegativeFinite(value[field])
      if (parsed === undefined) return undefined
      normalized[field] = parsed
    }
  }
  if (Object.hasOwn(value, 'costUsd')) {
    const parsed = persistedPositiveFinite(value.costUsd)
    if (parsed === undefined) return undefined
    normalized.costUsd = parsed
  }

  const hasUncachedInput = normalized.uncachedInputTokens !== undefined
  const hasTokenConsumption = normalized.usageKind === 'generation' &&
    ADDITIVE_TOKEN_FIELDS.some((field) => {
      if (field === 'inputTokens' && hasUncachedInput) return false
      return positiveFinite(normalized[field]) !== undefined
    })
  return hasTokenConsumption || normalized.costUsd !== undefined
    ? normalized
    : undefined
}

function normalizeWindows(values: readonly unknown[]): WindowState[] {
  const windows: WindowState[] = []
  for (const value of values) {
    const parsed = normalizeWindow(value)
    if (!parsed) continue
    const existing = windows.find((candidate) => candidate.id === parsed.id)
    if (!existing) {
      windows.push(parsed)
      continue
    }
    // One scope has one authoritative row per public window id. On malformed
    // duplicate input retain the most recently observed current cycle.
    if (parsed.current.latest.observedAt >= existing.current.latest.observedAt) {
      windows.splice(windows.indexOf(existing), 1, parsed)
    }
  }
  while (windows.length > MAX_WINDOWS) dropStalestWindow(windows)
  sortWindows(windows)
  return windows
}

function normalizeWindow(value: unknown): WindowState | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'metering', 'current', 'completed'])) {
    return undefined
  }
  const id = normalizedIdentifier(value.id)
  const metering = value.metering === 'token' ||
    value.metering === 'monetary' ||
    value.metering === 'credit'
    ? value.metering
    : undefined
  const current = normalizeCycle(value.current)
  if (!id || !metering || !current) return undefined
  const completed = Array.isArray(value.completed)
    ? value.completed.flatMap((cycle) => normalizeCycle(cycle) ?? [])
      .slice(0, MAX_COMPLETED_CYCLES)
    : []
  return { id, metering, current, completed }
}

function normalizeCycle(value: unknown): LedgerCycle | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['first', 'latest', 'byModel'],
    ['closesAt']
  )) return undefined
  const first = normalizePersistedReading(value.first)
  const latest = normalizePersistedReading(value.latest)
  if (!first || !latest || latest.observedAt < first.observedAt) return undefined
  const closesAt = validTimestamp(value.closesAt) ? value.closesAt : undefined
  const byModel = compactModelRows(Array.isArray(value.byModel) ? value.byModel : [])
  return {
    first,
    latest,
    ...(closesAt === undefined ? {} : { closesAt }),
    byModel
  }
}

function normalizePersistedReading(value: unknown): LedgerReading | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['observedAt', 'usedPercent'], ['usedUnits', 'limitUnits']) ||
    !validTimestamp(value.observedAt)
  ) return undefined
  const usedPercent = value.usedPercent === null
    ? null
    : finite(value.usedPercent)
  if (usedPercent === undefined) return undefined
  const usedUnits = nonnegativeFinite(value.usedUnits)
  const limitUnits = nonnegativeFinite(value.limitUnits)
  return {
    observedAt: value.observedAt,
    usedPercent,
    ...(usedUnits === undefined ? {} : { usedUnits }),
    ...(limitUnits === undefined ? {} : { limitUnits })
  }
}

function compactModelRows(values: readonly unknown[]): MutableModelTotals[] {
  const rows: MutableModelTotals[] = []
  for (const value of values) {
    const parsed = normalizeModelTotals(value)
    if (!parsed) continue
    const existing = rows.find((row) => row.model === parsed.model)
    const concreteRows = rows.filter((row) => row.model !== OVERFLOW_MODEL)
    const targetModel = existing
      ? parsed.model
      : parsed.model === OVERFLOW_MODEL || concreteRows.length >= MAX_MODEL_ROWS - 1
        ? OVERFLOW_MODEL
        : parsed.model
    const target = existing ?? rows.find((row) => row.model === targetModel) ?? (() => {
      const created: MutableModelTotals = { model: targetModel, usageEvents: 0 }
      rows.push(created)
      return created
    })()
    mergeModelTotals(target, parsed)
  }
  return rows.sort(compareModelRows)
}

function normalizeModelTotals(value: unknown): MutableModelTotals | undefined {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['model', 'usageEvents'],
    TOTAL_NUMBER_FIELDS
  )) return undefined
  const model = normalizedPersistedModel(value.model)
  const usageEvents = nonnegativeFinite(value.usageEvents)
  if (!model || usageEvents === undefined) return undefined
  const totals: MutableModelTotals = { model, usageEvents }
  for (const field of TOTAL_NUMBER_FIELDS) {
    const parsed = nonnegativeFinite(value[field])
    if (parsed !== undefined) totals[field] = parsed
  }
  return usageEvents > 0 || TOTAL_NUMBER_FIELDS.some((field) => (totals[field] ?? 0) > 0)
    ? totals
    : undefined
}

function mergeModelTotals(
  target: MutableModelTotals,
  source: MutableModelTotals
): void {
  target.usageEvents = boundedSum(target.usageEvents, source.usageEvents)
  for (const field of TOTAL_NUMBER_FIELDS) {
    const value = source[field]
    if (value !== undefined) target[field] = boundedSum(target[field] ?? 0, value)
  }
}

function dropOldestCompletedCycle(windows: WindowState[]): boolean {
  let selected: WindowState | undefined
  let oldest = Number.POSITIVE_INFINITY
  for (const window of windows) {
    const cycle = window.completed.at(-1)
    if (cycle && cycle.latest.observedAt < oldest) {
      selected = window
      oldest = cycle.latest.observedAt
    }
  }
  if (!selected) return false
  selected.completed.pop()
  return true
}

function dropStalestWindow(windows: WindowState[]): boolean {
  if (!windows.length) return false
  let selected = 0
  for (let index = 1; index < windows.length; index += 1) {
    if (windows[index].current.latest.observedAt < windows[selected].current.latest.observedAt) {
      selected = index
    }
  }
  windows.splice(selected, 1)
  return true
}

function sortWindows(windows: WindowState[]): void {
  windows.sort((left, right) => left.id.localeCompare(right.id))
}

function compareModelRows(
  left: BartTelemetryLedgerModelTotals,
  right: BartTelemetryLedgerModelTotals
): number {
  if (left.model === OVERFLOW_MODEL && right.model === OVERFLOW_MODEL) return 0
  if (left.model === OVERFLOW_MODEL) return 1
  if (right.model === OVERFLOW_MODEL) return -1
  return left.model.localeCompare(right.model)
}

function normalizedIdentifier(value: unknown): string {
  const parsed = typeof value === 'string' ? value.trim() : ''
  return parsed && parsed.length <= MAX_ID_LENGTH ? parsed : ''
}

function normalizedModel(value: unknown): string {
  const parsed = typeof value === 'string' ? value.trim() : ''
  return (parsed || 'unknown').slice(0, MAX_MODEL_LENGTH)
}

function normalizedPersistedModel(value: unknown): string {
  const parsed = typeof value === 'string' ? value.trim() : ''
  return parsed.slice(0, MAX_MODEL_LENGTH)
}

function boundedSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function positiveFinite(value: unknown): number | undefined {
  const parsed = finite(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

function cappedPositiveFinite(value: unknown): number | undefined {
  const parsed = positiveFinite(value)
  return parsed === undefined ? undefined : Math.min(Number.MAX_SAFE_INTEGER, parsed)
}

function nonnegativeFinite(value: unknown): number | undefined {
  const parsed = finite(value)
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

function cappedNonnegativeFinite(value: unknown): number | undefined {
  const parsed = nonnegativeFinite(value)
  return parsed === undefined ? undefined : Math.min(Number.MAX_SAFE_INTEGER, parsed)
}

function persistedPositiveFinite(value: unknown): number | undefined {
  const parsed = positiveFinite(value)
  return parsed !== undefined && parsed <= Number.MAX_SAFE_INTEGER
    ? parsed
    : undefined
}

function persistedNonnegativeFinite(value: unknown): number | undefined {
  const parsed = nonnegativeFinite(value)
  return parsed !== undefined && parsed <= Number.MAX_SAFE_INTEGER
    ? parsed
    : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
}

function validSampleId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SAMPLE_ID_LENGTH
}

function isMetering(value: unknown): value is BartTelemetryMetering {
  return METERINGS.includes(value as BartTelemetryMetering)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}
