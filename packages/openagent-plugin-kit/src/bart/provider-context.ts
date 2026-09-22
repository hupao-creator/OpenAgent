import type { BartTelemetrySnapshot, HarnessBackend } from '@openagent/contracts'
import { formatBartTelemetry } from './telemetry-policy.js'

export function unknownBackendTelemetry(now = Date.now()): BartTelemetrySnapshot {
  return { source: 'Unresolved external model service', observedAt: now,
    availability: 'unknown', windows: [], limitReached: null,
    note: 'Account capacity is unknown. Do not substitute a Harness subscription quota.' }
}

/** Undefined delegates only to the Harness-owned native authority. */
export async function providerTelemetryContext(backend: HarnessBackend, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted()
  if (backend.kind === 'native') return undefined
  if (backend.kind === 'unknown') return formatBartTelemetry('external-provider', unknownBackendTelemetry())
  const snapshot = await backend.readTelemetry(signal)
  signal.throwIfAborted()
  return JSON.stringify({ ...JSON.parse(formatBartTelemetry(backend.providerId, snapshot)),
    connectionId: backend.connectionId,
    authority: 'independent-provider',
    scopeMeaning: 'Reports with the same connectionId share one account capacity pool.' })
}
