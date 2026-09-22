import { claudeBackend } from './backend.js'
import { providerTelemetryContext } from '@openagent/plugin-kit/bart/main'
import { randomUUID } from 'node:crypto'
import type { DeepReadonly, HarnessBackend } from '@openagent/contracts'
import { defaultClaudeThreadSettings, type ClaudeHarnessSettings } from '../shared/settings.js'
import { ClaudeTransport } from './runtime/transport.js'
import { createClaudeBartTelemetryContributor, normalizeClaudeBartTelemetry } from '../bart/usage.js'
import { type ClaudeMainContext } from './types.js'
import { throwIfAborted } from './runtime/cancellation.js'

export function createClaudeTelemetryContext(mainContext: ClaudeMainContext) {
  return async (input: {
    readonly settings: DeepReadonly<ClaudeHarnessSettings>
    readonly cwd: string
    readonly telemetryLedger: import('@openagent/contracts').BartTelemetryLedgerCapability
    readonly signal: AbortSignal
  }) => {
    let environment: NodeJS.ProcessEnv = {}
    let backend: HarnessBackend
    try {
      if (mainContext.providers?.explicit) backend = mainContext.providers.explicit
      else {
        environment = await mainContext.environment()
        backend = await claudeBackend({ cwd: input.cwd, environment, providers: mainContext.providers, signal: input.signal })
      }
    } catch {
      input.signal.throwIfAborted()
      backend = { kind: 'unknown' }
    }
    const providerContext = await providerTelemetryContext(backend, input.signal)
    if (providerContext !== undefined) return providerContext
    return createClaudeBartTelemetryContributor({
      telemetryLedger: input.telemetryLedger,
      readUsage: async (signal) => {
        throwIfAborted(signal)
        const executablePath = defaultClaudeThreadSettings(input.settings).executablePath
        const executable = await mainContext.resolveExecutable(
          input.cwd,
          executablePath
        )
        throwIfAborted(signal)
        const transport = new ClaudeTransport({
          executable,
          cwd: input.cwd,
          environment,
          providerInjection: mainContext.providers?.explicit?.injection,
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
          return normalizeClaudeBartTelemetry(await transport.readUsage(signal))
        } finally {
          await transport.dispose()
        }
      }
    })({ signal: input.signal })
  }
}
