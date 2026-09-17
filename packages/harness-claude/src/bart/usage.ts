import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
type FetchResponse = Pick<Response, 'ok' | 'status' | 'json'>
type FetchBalance = (
  input: string | URL,
  init?: RequestInit
) => Promise<FetchResponse>

export const CLAUDE_USAGE_SOURCE = 'Claude Code get_usage'
export const CLAUDE_DEEPSEEK_BALANCE_SOURCE = 'DeepSeek GET /user/balance'

const DEEPSEEK_API_HOST = 'api.deepseek.com'
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

/**
 * Read the backend actually configured for Claude Code. Official DeepSeek
 * balance is used only for its exact HTTPS host; otherwise Claude get_usage is
 * the native authority.
 */
export async function readClaudeBartTelemetry(input: {
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  readonly readNativeUsage: (signal: AbortSignal) => Promise<unknown>
  readonly signal: AbortSignal
  readonly now?: number
  readonly fetchBalance?: FetchBalance
  readonly homeDirectory?: string
}): Promise<BartTelemetrySnapshot> {
  throwIfAborted(input.signal)
  const observedAt = input.now ?? Date.now()
  const deepSeek = await readClaudeDeepSeekBalance({
    cwd: input.cwd,
    environment: input.environment,
    signal: input.signal,
    observedAt,
    ...(input.fetchBalance ? { fetchBalance: input.fetchBalance } : {}),
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {})
  })
  throwIfAborted(input.signal)
  if (deepSeek) return deepSeek
  const response = await input.readNativeUsage(input.signal)
  throwIfAborted(input.signal)
  return normalizeClaudeBartTelemetry(response, observedAt)
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

export function normalizeDeepSeekBalanceTelemetry(
  payload: unknown,
  observedAt = Date.now()
): BartTelemetrySnapshot {
  if (!isRecord(payload) || typeof payload.is_available !== 'boolean') {
    throw new Error('DeepSeek 余额响应缺少 is_available')
  }
  if (!Array.isArray(payload.balance_infos)) {
    throw new Error('DeepSeek 余额响应缺少 balance_infos')
  }
  const balances = payload.balance_infos.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`DeepSeek balance_infos[${index}] 不是对象`)
    }
    return {
      currency: requiredString(value.currency, `balance_infos[${index}].currency`),
      total: decimalString(value.total_balance, `balance_infos[${index}].total_balance`),
      granted: decimalString(
        value.granted_balance,
        `balance_infos[${index}].granted_balance`
      ),
      toppedUp: decimalString(
        value.topped_up_balance,
        `balance_infos[${index}].topped_up_balance`
      )
    }
  })
  return {
    source: CLAUDE_DEEPSEEK_BALANCE_SOURCE,
    observedAt,
    availability: 'available',
    limitReached: payload.is_available ? false : true,
    windows: [],
    balances,
    note: payload.is_available
      ? 'Claude Code is configured for the official DeepSeek backend; balance is the routing authority.'
      : 'DeepSeek reports this account unavailable for requests.'
  }
}

async function readClaudeDeepSeekBalance(input: {
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  readonly signal: AbortSignal
  readonly observedAt: number
  readonly fetchBalance?: FetchBalance
  readonly homeDirectory?: string
}): Promise<BartTelemetrySnapshot | null> {
  const launchBaseUrl = input.environment.ANTHROPIC_BASE_URL
  const launchDeepSeekBaseUrl = officialDeepSeekBaseUrl(launchBaseUrl)
  if (launchBaseUrl !== undefined && !launchDeepSeekBaseUrl) return null

  const hasLaunchToken = firstNonEmpty(
    input.environment.ANTHROPIC_AUTH_TOKEN,
    input.environment.ANTHROPIC_API_KEY
  ) !== null
  const effectiveEnvironment = launchDeepSeekBaseUrl && hasLaunchToken
    ? input.environment
    : await claudeSettingsEnvironment(
        input.cwd,
        input.environment,
        input.homeDirectory ?? homedir()
      )
  throwIfAborted(input.signal)
  const baseUrl = officialDeepSeekBaseUrl(effectiveEnvironment.ANTHROPIC_BASE_URL)
  if (!baseUrl) return null
  const token = firstNonEmpty(
    effectiveEnvironment.ANTHROPIC_AUTH_TOKEN,
    effectiveEnvironment.ANTHROPIC_API_KEY
  )
  if (!token) {
    throw new Error('Claude Code 已指向 DeepSeek，但未找到可用于查询余额的 API token')
  }

  const response = await (input.fetchBalance ?? fetch)(new URL('/user/balance', baseUrl), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    },
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(7_500)])
  })
  throwIfAborted(input.signal)
  if (!response.ok) {
    throw new Error(`DeepSeek 余额查询返回 HTTP ${response.status}`)
  }
  return normalizeDeepSeekBalanceTelemetry(await response.json(), input.observedAt)
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
    note: 'Claude live quota or configured backend balance could not be read; route as unknown capacity rather than unlimited capacity.'
  }
}

async function claudeSettingsEnvironment(
  cwd: string,
  inherited: NodeJS.ProcessEnv,
  homeDirectory: string
): Promise<NodeJS.ProcessEnv> {
  const settingsPaths = [
    join(homeDirectory, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json')
  ]
  const effective: NodeJS.ProcessEnv = {}
  for (const path of settingsPaths) {
    Object.assign(effective, await readSettingsEnvironment(path))
  }
  return { ...effective, ...inherited }
}

async function readSettingsEnvironment(path: string): Promise<NodeJS.ProcessEnv> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return {}
    throw new Error(`无法读取 Claude Code 设置：${telemetryErrorText(error)}`)
  }
  let settings: unknown
  try {
    settings = JSON.parse(source)
  } catch (error) {
    throw new Error(`Claude Code 设置不是有效 JSON：${telemetryErrorText(error)}`)
  }
  if (!isRecord(settings) || !isRecord(settings.env)) return {}
  return Object.fromEntries(
    Object.entries(settings.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
}

function officialDeepSeekBaseUrl(value: string | undefined): URL | null {
  if (!value?.trim()) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== DEEPSEEK_API_HOST ||
      url.port ||
      url.username ||
      url.password
    ) return null
    return url
  } catch {
    return null
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

function decimalString(value: unknown, field: string): string {
  const result = requiredString(value, field)
  if (!/^-?\d+(?:\.\d+)?$/.test(result)) {
    throw new Error(`DeepSeek ${field} 不是十进制金额`)
  }
  return result
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`DeepSeek ${field} 缺失`)
  }
  return value
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (value?.trim()) return value.trim()
  }
  return null
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
