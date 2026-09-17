/** Shared Bart telemetry presentation, pacing policy, and ledger orchestration. */
import type {
  BartTelemetryLedgerCapability,
  BartTelemetryLedgerSnapshot,
  BartTelemetryPace,
  BartTelemetryPaceStage,
  BartTelemetrySnapshot,
  BartTelemetryWindow,
  BartTelemetryWindowReadingSample
} from '@openagent/contracts'

const MINIMUM_PACE_EXPECTED_PERCENT = 3

/** Serialize normalized facts as opaque Plugin-authored context for Bart. */
export function formatBartTelemetry(
  namespace: string,
  snapshot: BartTelemetrySnapshot
): string {
  return JSON.stringify({
    namespace,
    source: snapshot.source,
    observedAt: requiredIsoTimestamp(snapshot.observedAt),
    availability: snapshot.availability,
    ...(snapshot.plan === undefined ? {} : { plan: snapshot.plan }),
    ...(snapshot.limitReached === undefined
      ? {}
      : { limitReached: snapshot.limitReached }),
    windows: snapshot.windows || [],
    ...(snapshot.balances?.length ? { balances: snapshot.balances } : {}),
    ...(snapshot.note ? { note: snapshot.note } : {}),
    ...(snapshot.error ? { error: snapshot.error } : {})
  })
}

export function telemetryRemainingPercent(
  usedPercent: number | null
): number | null {
  return usedPercent === null
    ? null
    : roundTelemetryPercent(Math.max(0, 100 - usedPercent))
}

export function telemetryExhausted(
  usedPercent: number | null
): boolean | null {
  return usedPercent === null ? null : usedPercent >= 100
}

export function telemetryLimitReached(
  windows: readonly BartTelemetryWindow[],
  explicitlyReached = false
): boolean | null {
  if (explicitlyReached || windows.some((window) => window.exhausted === true)) {
    return true
  }
  if (!windows.length) return null
  return windows.some((window) => window.exhausted === null) ? null : false
}

export function roundTelemetryPercent(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Linear burn projection. It is omitted when reset metadata is inconsistent
 * or during the noisy first 3% of a window.
 */
export function calculateBartTelemetryPace(
  usedPercent: number | null,
  durationMinutes: number | null,
  resetsAt: string | null,
  observedAt: number
): BartTelemetryPace | null {
  if (usedPercent === null || durationMinutes === null || resetsAt === null) {
    return null
  }

  const durationMs = durationMinutes * 60_000
  const resetMs = Date.parse(resetsAt)
  const timeUntilResetMs = resetMs - observedAt
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    !Number.isFinite(timeUntilResetMs) ||
    timeUntilResetMs <= 0 ||
    timeUntilResetMs > durationMs
  ) {
    return null
  }

  const elapsedMs = Math.max(0, Math.min(durationMs, durationMs - timeUntilResetMs))
  const expectedUsedPercent = elapsedMs / durationMs * 100
  if (expectedUsedPercent < MINIMUM_PACE_EXPECTED_PERCENT) return null

  const actualUsedPercent = Math.max(0, Math.min(100, usedPercent))
  const deltaPercent = actualUsedPercent - expectedUsedPercent
  const remainingCapacity = 100 - actualUsedPercent
  const projectedRemainingUsage = elapsedMs > 0
    ? actualUsedPercent * timeUntilResetMs / elapsedMs
    : 0
  const sustainableRateMultiplier = remainingCapacity > 0 && projectedRemainingUsage > 0
    ? finiteRounded(remainingCapacity / projectedRemainingUsage)
    : null

  let willLastToReset: boolean
  let etaSeconds: number | null = null
  if (actualUsedPercent >= 100) {
    willLastToReset = false
    etaSeconds = 0
  } else if (actualUsedPercent === 0) {
    willLastToReset = true
  } else {
    const ratePerMillisecond = actualUsedPercent / elapsedMs
    const candidateMs = remainingCapacity / ratePerMillisecond
    if (candidateMs >= timeUntilResetMs) {
      willLastToReset = true
    } else {
      willLastToReset = false
      etaSeconds = Math.max(0, Math.round(candidateMs / 1_000))
    }
  }

  return {
    expectedUsedPercent: roundTelemetryPercent(expectedUsedPercent),
    deltaPercent: roundTelemetryPercent(deltaPercent),
    stage: paceStage(deltaPercent),
    willLastToReset,
    etaSeconds,
    projectedExhaustionAt: etaSeconds === null
      ? null
      : requiredIsoTimestamp(observedAt + etaSeconds * 1_000),
    sustainableRateMultiplier
  }
}

export function telemetryIsoTimestamp(value: unknown): string | null {
  let milliseconds: number
  if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value
  } else if (typeof value === 'string' && value.trim()) {
    milliseconds = Date.parse(value)
  } else {
    return null
  }
  if (!Number.isFinite(milliseconds)) return null
  try {
    return new Date(milliseconds).toISOString()
  } catch {
    return null
  }
}

export function telemetryErrorText(error: unknown, maxLength = 500): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= maxLength
    ? message
    : `${message.slice(0, Math.max(0, maxLength - 1))}…`
}

export function telemetryWindowReadingSample(
  snapshot: BartTelemetrySnapshot
): BartTelemetryWindowReadingSample {
  return {
    type: 'window-reading',
    observedAt: snapshot.observedAt,
    windows: (snapshot.windows || []).flatMap((window) =>
      window.metering
        ? [{
            id: window.id,
            metering: window.metering,
            usedPercent: window.usedPercent,
            ...(window.usedUnits === undefined
              ? {}
              : { usedUnits: window.usedUnits }),
            ...(window.limitUnits === undefined
              ? {}
              : { limitUnits: window.limitUnits }),
            resetsAt: window.resetsAt,
            ...(window.durationMinutes === undefined
              ? {}
              : { durationMinutes: window.durationMinutes })
          }]
        : []
    )
  }
}

export function attachBartTelemetryLedger(
  snapshot: BartTelemetrySnapshot,
  ledger: BartTelemetryLedgerSnapshot
): BartTelemetrySnapshot {
  const byWindow = new Map(
    ledger.windows.map((window) => [window.id, window.ledger])
  )
  return {
    ...snapshot,
    ...(snapshot.windows
      ? {
          windows: snapshot.windows.map((window) => {
            const windowLedger = byWindow.get(window.id)
            return windowLedger ? { ...window, ledger: windowLedger } : window
          })
        }
      : {})
  }
}

/** Record the current normalized windows before exposing the scoped ledger. */
export async function recordAndAttachBartTelemetryLedger(
  snapshot: BartTelemetrySnapshot,
  capability: BartTelemetryLedgerCapability
): Promise<BartTelemetrySnapshot> {
  await capability.record(telemetryWindowReadingSample(snapshot))
  return attachBartTelemetryLedger(snapshot, capability.read())
}

function requiredIsoTimestamp(value: number): string {
  return telemetryIsoTimestamp(value) || new Date().toISOString()
}

function paceStage(deltaPercent: number): BartTelemetryPaceStage {
  const magnitude = Math.abs(deltaPercent)
  if (magnitude <= 2) return 'on_pace'
  if (magnitude <= 6) {
    return deltaPercent > 0 ? 'slightly_over_pace' : 'slightly_under_pace'
  }
  if (magnitude <= 12) return deltaPercent > 0 ? 'over_pace' : 'under_pace'
  return deltaPercent > 0 ? 'far_over_pace' : 'far_under_pace'
}

function finiteRounded(value: number): number | null {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : null
}
