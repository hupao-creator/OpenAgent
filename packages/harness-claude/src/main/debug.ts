import { performance } from 'node:perf_hooks'
import {
  debugDetail,
  debugError,
  debugLog,
  getDebugContext,
  getDebugLogMode,
  startDebugSpan,
  withDebugContext,
  type DebugContext
} from '@openagent/plugin-kit/main'

export {
  debugDetail,
  debugError,
  debugLog,
  getDebugContext,
  getDebugLogMode,
  startDebugSpan,
  withDebugContext
}
export type { DebugContext }

export type DebugSpan = ReturnType<typeof startDebugSpan>

/** Keep protocol diagnostics useful without copying base64 attachment bodies. */
export function debugFrame(value: unknown, binarySource = false): unknown {
  // Frame traversal is detail-only. In off/summary mode, avoid walking
  // protocol objects (which may be large or arrive once per token) before the
  // logger has a chance to discard the event.
  if (getDebugLogMode() !== 'detail') return undefined
  if (typeof value === 'string') {
    return binarySource
      ? `[binary data omitted; ${value.length} characters]`
      : value
  }
  if (Array.isArray(value)) {
    let changed = false
    const mapped = value.map((item) => {
      const next = debugFrame(item)
      changed ||= next !== item
      return next
    })
    return changed ? mapped : value
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const isBase64Source = record.type === 'base64' &&
      typeof record.data === 'string' &&
      typeof record.media_type === 'string'
    let changed = false
    const entries = Object.entries(record).map(([entryKey, entryValue]) => {
      const next = debugFrame(entryValue, isBase64Source && entryKey === 'data')
      changed ||= next !== entryValue
      return [entryKey, next] as const
    })
    return changed ? Object.fromEntries(entries) : value
  }
  return value
}

export function debugEnvironmentSummary(environment: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    environmentKeyCount: Object.keys(environment).length,
    hasHttpProxy: Boolean(
      environment.HTTP_PROXY || environment.http_proxy ||
      environment.HTTPS_PROXY || environment.https_proxy ||
      environment.ALL_PROXY || environment.all_proxy
    ),
    hasNoProxy: Boolean(environment.NO_PROXY || environment.no_proxy)
  }
}

export function debugNow(): number {
  return performance.now()
}

export function debugDuration(startedAt: number | undefined): number | null {
  return startedAt === undefined ? null : Math.max(0, debugNow() - startedAt)
}

export function inDebugContext<T>(
  context: DebugContext | undefined,
  operation: () => T
): T {
  return hasDebugContext(context) ? withDebugContext(context, operation) : operation()
}

export function hasDebugContext(
  context: DebugContext | undefined
): context is DebugContext {
  return Boolean(context?.traceId || context?.spanId)
}

export function effectiveDebugContext(
  primary: DebugContext | undefined,
  fallback: DebugContext | undefined
): DebugContext | undefined {
  return hasDebugContext(primary) ? primary : fallback
}
