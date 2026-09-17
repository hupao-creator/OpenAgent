/**
 * Provider-neutral telemetry facts that a Harness Plugin may expose to Bart.
 * Native provider payloads must be parsed inside the owning Plugin before they
 * cross this boundary.
 */
export type BartTelemetryAvailability =
  | 'available'
  | 'not_applicable'
  | 'unknown'
  | 'error'

export type BartTelemetryScope =
  | 'provider'
  | 'model'
  | 'feature'
  | 'account'
  | 'unknown'

export type BartTelemetryMetering =
  | 'token'
  | 'request'
  | 'monetary'
  | 'credit'

export type BartTelemetryPaceStage =
  | 'far_over_pace'
  | 'over_pace'
  | 'slightly_over_pace'
  | 'on_pace'
  | 'slightly_under_pace'
  | 'under_pace'
  | 'far_under_pace'

export interface BartTelemetryPace {
  readonly expectedUsedPercent: number
  readonly deltaPercent: number
  readonly stage: BartTelemetryPaceStage
  readonly willLastToReset: boolean
  readonly etaSeconds: number | null
  readonly projectedExhaustionAt: string | null
  readonly sustainableRateMultiplier: number | null
}

export interface BartTelemetryLedgerModelTotals {
  readonly model: string
  readonly usageEvents: number
  /** Provider-raw input fallback, omitted when uncached input is available. */
  readonly inputTokens?: number
  readonly uncachedInputTokens?: number
  readonly cachedReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly outputTokens?: number
  readonly reasoningTokens?: number
  readonly costUsd?: number
}

export interface BartTelemetryLedgerReading {
  readonly at: string
  readonly usedPercent: number | null
  readonly usedUnits?: number
  readonly limitUnits?: number
}

export interface BartTelemetryLedgerCycle {
  readonly firstReading: BartTelemetryLedgerReading
  readonly latestReading: BartTelemetryLedgerReading
  readonly byModel: readonly BartTelemetryLedgerModelTotals[]
}

export interface BartTelemetryWindowLedger {
  readonly currentCycle: BartTelemetryLedgerCycle
  readonly completedCycles: readonly BartTelemetryLedgerCycle[]
}

export interface BartTelemetryLedgerSnapshot {
  readonly windows: readonly {
    readonly id: string
    readonly metering: BartTelemetryMetering
    readonly ledger: BartTelemetryWindowLedger
  }[]
}

export interface BartTelemetryExecutionUsageSample {
  readonly type: 'execution-usage'
  /** Stable opaque idempotency token derived inside the owning Plugin. */
  readonly sampleId: string
  readonly executionId: string
  readonly observedAt: number
  readonly model: string
  /** Context snapshots are non-additive; summary may carry cost only. */
  readonly usageKind: 'generation' | 'summary' | 'context'
  readonly inputTokens?: number
  readonly uncachedInputTokens?: number
  readonly cachedReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly outputTokens?: number
  readonly reasoningTokens?: number
  readonly costUsd?: number
}

export interface BartTelemetryWindowReadingSample {
  readonly type: 'window-reading'
  readonly observedAt: number
  readonly windows: readonly {
    readonly id: string
    readonly metering: BartTelemetryMetering
    readonly usedPercent: number | null
    readonly usedUnits?: number
    readonly limitUnits?: number
    readonly resetsAt: string | null
    readonly durationMinutes?: number
  }[]
}

export type BartTelemetryLedgerSample =
  | BartTelemetryExecutionUsageSample
  | BartTelemetryWindowReadingSample

/**
 * Core-owned, provider-neutral and pre-scoped by composition. A Plugin never
 * supplies or observes another Plugin's identity through this capability.
 */
export interface BartTelemetryLedgerCapability {
  record(sample: BartTelemetryLedgerSample): Promise<void>
  read(): BartTelemetryLedgerSnapshot
}

export interface BartTelemetryWindow {
  readonly id: string
  readonly label: string
  readonly scope: BartTelemetryScope
  readonly selector?: string
  readonly usedPercent: number | null
  readonly remainingPercent: number | null
  readonly resetsAt: string | null
  readonly durationMinutes?: number
  readonly exhausted: boolean | null
  readonly quality?: 'exact' | 'estimated'
  readonly confidence?: 'low' | 'medium' | 'high'
  readonly metering?: BartTelemetryMetering
  readonly usedUnits?: number
  readonly limitUnits?: number
  readonly pace?: BartTelemetryPace
  readonly ledger?: BartTelemetryWindowLedger
}

export interface BartTelemetryBalance {
  readonly currency: string
  /** Decimal text is retained to avoid imposing a shared rounding policy. */
  readonly total: string
  readonly granted?: string
  readonly toppedUp?: string
}

export interface BartTelemetrySnapshot {
  readonly source: string
  readonly observedAt: number
  readonly availability: BartTelemetryAvailability
  readonly plan?: string | null
  /** Provider-wide exhaustion only; selector-scoped windows remain per-window. */
  readonly limitReached?: boolean | null
  readonly windows?: readonly BartTelemetryWindow[]
  readonly balances?: readonly BartTelemetryBalance[]
  readonly note?: string
  readonly error?: string
}
