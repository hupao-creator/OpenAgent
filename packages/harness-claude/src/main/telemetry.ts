import { randomUUID } from 'node:crypto'
import type { DeepReadonly } from '@openagent/contracts'
import { defaultClaudeThreadSettings, type ClaudeHarnessSettings } from '../shared/settings.js'
import { ClaudeTransport } from './runtime/transport.js'
import { createClaudeBartTelemetryContributor, readClaudeBartTelemetry } from '../bart/usage.js'
import { type ClaudeMainContext } from './types.js'
import { throwIfAborted } from './runtime/cancellation.js'

export function createClaudeTelemetryContext(mainContext: ClaudeMainContext) {
  return async (input: {
    readonly settings: DeepReadonly<ClaudeHarnessSettings>
    readonly cwd: string
    readonly telemetryLedger: import('@openagent/contracts').BartTelemetryLedgerCapability
    readonly signal: AbortSignal
  }) => {
    return createClaudeBartTelemetryContributor({
      telemetryLedger: input.telemetryLedger,
      readUsage: async (signal) => {
        const environment = await mainContext.environment()
        throwIfAborted(signal)
        return readClaudeBartTelemetry({
          cwd: input.cwd,
          environment,
          signal,
          readNativeUsage: async (nativeSignal) => {
            const executablePath = defaultClaudeThreadSettings(input.settings).executablePath
            const executable = await mainContext.resolveExecutable(
              input.cwd,
              executablePath
            )
            throwIfAborted(nativeSignal)
            const transport = new ClaudeTransport({
              executable,
              cwd: input.cwd,
              environment,
              providerOverride: mainContext.providerOverride,
              sessionId: randomUUID(),
              resume: false,
              settings: {
                executablePath
              },
              interactive: false,
              persistSession: false,
              applicationToolsOnly: true,
              debugPurpose: 'usage',
              onEvent: () => undefined
            })
            try {
              return await transport.readUsage(nativeSignal)
            } finally {
              await transport.dispose()
            }
          }
        })
      }
    })({ signal: input.signal })
  }
}
