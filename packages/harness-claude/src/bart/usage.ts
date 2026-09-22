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
export const CLAUDE_USAGE_SOURCE = 'Claude Code get_usage'

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour shared window',
  seven_day: '7-day shared window',
  seven_day_oauth_apps: '7-day OAuth apps window',
  seven_day_opus: '7-day Opus window',
  seven_day_sonnet: '7-day Sonnet window',
  seven_day_overage_included: '7-day overage-included window'
}

export function createClaudeBartTelemetryContributor(input: {
  readonly readUsage: (signal: AbortSignal) => Promise<BartTelemetrySnapshot>
  readonly telemetryLedger?: BartTelemetryLedgerCapability
  readonly now?: () => number
}): BartContextContributor {
  return async ({ signal }) => {
    throwIfAborted(signal)
    try {
      const snapshot = await input.readUsage(signal)
      throwIfAborted(signal)
      const withLedger = input.telemetryLedger
        ? await recordAndAttachBartTelemetryLedger(
            snapshot,
            input.telemetryLedger
          )
        : snapshot
      return formatBartTelemetry('claude', withLedger)
    } catch (error) {
      throwIfAborted(signal)
      return formatBartTelemetry(
        'claude',
        claudeTelemetryError(error, input.now?.() ?? Date.now())
      )
    }
  }
}

/** Parse only Claude Code's native get_usage response. */
export function normalizeClaudeBartTelemetry(
  response: unknown,
  observedAt = Date.now()
): BartTelemetrySnapshot {
  const root = asRecord(response)
  const rateLimitsAvailable = root.rate_limits_available
  const rawRateLimits = asRecord(root.rate_limits)
  const plan = stringValue(root.subscription_type)

  if (rateLimitsAvailable === false) {
    return {
      source: CLAUDE_USAGE_SOURCE,
      observedAt,
      availability: 'not_applicable',
      plan,
      limitReached: null,
      windows: [],
      note: 'Claude plan windows are not exposed for this API-key, third-party, Bedrock, Vertex, or otherwise non-plan session. This does not prove unlimited capacity.'
    }
  }

  if (!Object.keys(rawRateLimits).length) {
    return {
      source: CLAUDE_USAGE_SOURCE,
      observedAt,
      availability: 'unknown',
      plan,
      limitReached: null,
      windows: [],
      note: 'Claude returned no recognizable plan usage windows; do not assume Claude has unlimited capacity.'
    }
  }

  const windows: BartTelemetryWindow[] = []
  for (const [windowId, rawWindow] of Object.entries(rawRateLimits)) {
    if (windowId === 'model_scoped' || windowId === 'extra_usage') continue
    if (!isRecord(rawWindow)) continue
    const usedPercent = percentValue(rawWindow.utilization)
    const resetsAt = telemetryIsoTimestamp(rawWindow.resets_at)
    if (usedPercent === null && resetsAt === null) continue
    const scope = claudeWindowScope(windowId)
    const durationMinutes = claudeWindowDurationMinutes(windowId)
    const pace = calculateBartTelemetryPace(
      usedPercent,
      durationMinutes,
      resetsAt,
      observedAt
    )
    windows.push({
      id: windowId,
      label: CLAUDE_WINDOW_LABELS[windowId] || humanizeIdentifier(windowId),
      scope,
      ...(scope === 'provider' ? {} : { selector: claudeWindowSubject(windowId) }),
      usedPercent,
      remainingPercent: telemetryRemainingPercent(usedPercent),
      resetsAt,
      ...(durationMinutes === null ? {} : { durationMinutes }),
      exhausted: telemetryExhausted(usedPercent),
      metering: 'token',
      ...(pace ? { pace } : {})
    })
  }

  const modelScoped = Array.isArray(rawRateLimits.model_scoped)
    ? rawRateLimits.model_scoped
    : []
  for (const rawWindow of modelScoped) {
    if (!isRecord(rawWindow)) continue
    const displayName = stringValue(rawWindow.display_name)
    if (!displayName) continue
    const identifier = normalizeIdentifier(displayName)
    if (!identifier) continue
    const usedPercent = percentValue(rawWindow.utilization)
    const resetsAt = telemetryIsoTimestamp(rawWindow.resets_at)
    if (usedPercent === null && resetsAt === null) continue
    const durationMinutes = 7 * 24 * 60
    const pace = calculateBartTelemetryPace(
      usedPercent,
      durationMinutes,
      resetsAt,
      observedAt
    )
    windows.push({
      id: `model_scoped:${identifier}`,
      label: `${displayName} 7-day model window`,
      scope: 'model',
      selector: displayName,
      usedPercent,
      remainingPercent: telemetryRemainingPercent(usedPercent),
      resetsAt,
      durationMinutes,
      exhausted: telemetryExhausted(usedPercent),
      metering: 'token',
      ...(pace ? { pace } : {})
    })
  }

  if (!windows.length) {
    return {
      source: CLAUDE_USAGE_SOURCE,
      observedAt,
      availability: 'unknown',
      plan,
      limitReached: null,
      windows: [],
      note: 'Claude reported plan telemetry without recognizable usage windows; do not assume Claude has unlimited capacity.'
    }
  }

  return {
    source: CLAUDE_USAGE_SOURCE,
    observedAt,
    availability: 'available',
    plan,
    limitReached: telemetryLimitReached(
      windows.filter((window) => window.scope === 'provider')
    ),
    windows
  }
}

function claudeTelemetryError(
  error: unknown,
  observedAt: number
): BartTelemetrySnapshot {
  return {
    source: CLAUDE_USAGE_SOURCE,
    observedAt,
    availability: 'error',
    plan: null,
    limitReached: null,
    windows: [],
    error: telemetryErrorText(error),
    note: 'Claude native subscription quota could not be read; route as unknown capacity rather than unlimited capacity.'
  }
}

function claudeWindowScope(windowId: string): BartTelemetryScope {
  if (/(?:opus|sonnet|haiku|fable|model)/i.test(windowId)) return 'model'
  if (/(?:oauth|app|overage|extra)/i.test(windowId)) return 'feature'
  return 'provider'
}

function claudeWindowDurationMinutes(windowId: string): number | null {
  if (/(?:^|_)five_hour(?:_|$)/i.test(windowId)) return 5 * 60
  if (/(?:^|_)seven_day(?:_|$)/i.test(windowId)) return 7 * 24 * 60
  return null
}

function claudeWindowSubject(windowId: string): string {
  return humanizeIdentifier(
    windowId.replace(/^seven_day_/, '').replace(/^five_hour_/, '')
  )
}

function humanizeIdentifier(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'usage window'
}

function normalizeIdentifier(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function percentValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? roundTelemetryPercent(value)
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
