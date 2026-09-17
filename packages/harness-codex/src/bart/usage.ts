import {
  type BartTelemetryScope,
  type BartTelemetryLedgerCapability,
  type BartTelemetrySnapshot,
  type BartTelemetryWindow
} from '@openagent/contracts'
import {
  calculateBartTelemetryPace,
  formatBartTelemetry,
  recordAndAttachBartTelemetryLedger,
  roundTelemetryPercent,
  telemetryErrorText,
  telemetryExhausted,
  telemetryIsoTimestamp,
  telemetryLimitReached,
  telemetryRemainingPercent
} from '@openagent/plugin-kit/bart'
import type { BartContextContributor } from '@openagent/contracts'

type UnknownRecord = Record<string, unknown>

export const CODEX_USAGE_SOURCE = 'Codex account/rateLimits/read'

export interface CodexBartUsageReader {
  (signal: AbortSignal): Promise<unknown>
}

export function createCodexBartTelemetryContributor(input: {
  readonly readUsage: CodexBartUsageReader
  readonly telemetryLedger?: BartTelemetryLedgerCapability
  readonly now?: () => number
}): BartContextContributor {
  return async ({ signal }) => {
    throwIfAborted(signal)
    const observedAt = input.now?.() ?? Date.now()
    try {
      const response = await input.readUsage(signal)
      throwIfAborted(signal)
      const normalized = normalizeCodexBartTelemetry(response, observedAt)
      const snapshot = input.telemetryLedger
        ? await recordAndAttachBartTelemetryLedger(
            normalized,
            input.telemetryLedger
          )
        : normalized
      return formatBartTelemetry('codex', snapshot)
    } catch (error) {
      throwIfAborted(signal)
      return formatBartTelemetry('codex', codexTelemetryError(error, observedAt))
    }
  }
}

/** Parse only Codex app-server's native account/rateLimits/read payload. */
export function normalizeCodexBartTelemetry(
  response: unknown,
  observedAt = Date.now()
): BartTelemetrySnapshot {
  const root = asRecord(response)
  const primaryLimit = asRecord(root.rateLimits)
  const limitsById = asRecord(root.rateLimitsByLimitId)
  const buckets = new Map<string, UnknownRecord>()

  for (const [fallbackId, rawBucket] of Object.entries(limitsById)) {
    if (!isRecord(rawBucket)) continue
    const id = stringValue(rawBucket.limitId) || fallbackId
    buckets.set(id, rawBucket)
  }
  if (Object.keys(primaryLimit).length) {
    const id = stringValue(primaryLimit.limitId) || 'codex'
    if (!buckets.has(id)) buckets.set(id, primaryLimit)
  }

  if (!buckets.size) {
    return {
      source: CODEX_USAGE_SOURCE,
      observedAt,
      availability: 'unknown',
      plan: null,
      limitReached: null,
      windows: [],
      note: 'Codex returned no recognizable usage windows; do not assume Codex has unlimited capacity.'
    }
  }

  const primaryId = stringValue(primaryLimit.limitId)
  const windows: BartTelemetryWindow[] = []
  let explicitlyReached = false
  for (const [limitId, bucket] of buckets) {
    const limitName = stringValue(bucket.limitName)
    const scope: BartTelemetryScope =
      limitId === primaryId || (!primaryId && limitId === 'codex')
        ? 'provider'
        : 'model'
    if (
      scope === 'provider' &&
      (bucket.spendControlReached === true ||
        Boolean(stringValue(bucket.rateLimitReachedType)))
    ) {
      explicitlyReached = true
    }
    for (const windowName of ['primary', 'secondary'] as const) {
      const rawWindow = asRecord(bucket[windowName])
      if (!Object.keys(rawWindow).length) continue
      const durationMinutes = positiveNumber(rawWindow.windowDurationMins)
      const usedPercent = percentValue(rawWindow.usedPercent)
      const resetsAt = telemetryIsoTimestamp(rawWindow.resetsAt)
      const pace = calculateBartTelemetryPace(
        usedPercent,
        durationMinutes,
        resetsAt,
        observedAt
      )
      windows.push({
        id: `${limitId}:${windowName}`,
        label: codexWindowLabel(limitName, durationMinutes, windowName),
        scope,
        ...(scope === 'model' ? { selector: limitName || limitId } : {}),
        usedPercent,
        remainingPercent: telemetryRemainingPercent(usedPercent),
        resetsAt,
        ...(durationMinutes === null ? {} : { durationMinutes }),
        exhausted: telemetryExhausted(usedPercent),
        metering: 'token',
        ...(pace ? { pace } : {})
      })
    }
  }

  if (!windows.length) {
    return {
      source: CODEX_USAGE_SOURCE,
      observedAt,
      availability: 'unknown',
      plan: stringValue(primaryLimit.planType),
      limitReached: explicitlyReached ? true : null,
      windows: [],
      note: 'Codex returned limit metadata without recognizable usage windows; do not assume Codex has unlimited capacity.'
    }
  }

  return {
    source: CODEX_USAGE_SOURCE,
    observedAt,
    availability: 'available',
    plan: stringValue(primaryLimit.planType),
    limitReached: telemetryLimitReached(
      windows.filter((window) => window.scope === 'provider'),
      explicitlyReached
    ),
    windows
  }
}

function codexTelemetryError(
  error: unknown,
  observedAt: number
): BartTelemetrySnapshot {
  return {
    source: CODEX_USAGE_SOURCE,
    observedAt,
    availability: 'error',
    plan: null,
    limitReached: null,
    windows: [],
    error: telemetryErrorText(error),
    note: 'Codex live quota could not be read; route as unknown capacity rather than unlimited capacity.'
  }
}

function codexWindowLabel(
  limitName: string | null,
  durationMinutes: number | null,
  fallback: 'primary' | 'secondary'
): string {
  const duration = durationMinutes === 300
    ? '5-hour window'
    : durationMinutes === 10_080
      ? '7-day window'
      : durationMinutes === null
        ? `${fallback} window`
        : `${durationMinutes}-minute window`
  return limitName ? `${limitName} ${duration}` : `Codex shared ${duration}`
}

function percentValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? roundTelemetryPercent(value)
    : null
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason || new DOMException('The operation was aborted', 'AbortError')
}
