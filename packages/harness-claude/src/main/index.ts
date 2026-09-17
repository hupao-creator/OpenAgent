import { acquireBartEvaluationSource } from '@openagent/plugin-kit/bart/main'
import spawn from 'cross-spawn'
import { createCliAvailabilityProbe, runCliInstaller } from '@openagent/plugin-kit/main'
import { createClaudeSettings } from './settings.js'
import { createClaudeTelemetryContext } from './telemetry.js'
import type { ClaudeMainPlugin, ClaudeMainPluginBundle } from './types.js'

export type { ClaudeMainPluginBundle } from './types.js'

import type {
  HarnessPromptCompleteRequest,
  HarnessThreadHandle,
  HarnessThreadOpenContext
} from '@openagent/contracts'
import { HarnessExecutableNotFoundError } from '@openagent/contracts'
import { type ClaudeHarnessSettings, type ClaudePromptSettings, type ClaudeThreadSettings } from '../shared/settings.js'

import { createClaudeCatalogSource, type ClaudeCatalogSource } from './catalog.js'
import { createClaudeEvaluationContext } from './evaluation.js'

import { forkClaudeThread } from './fork.js'
import { startDebugSpan } from './debug.js'
import { type ClaudeMainContext } from './types.js'
import { throwIfAborted } from './runtime/cancellation.js'
import { openClaudeThread } from './thread/controller.js'
import { completeClaudePrompt } from './prompt.js'
import { claudeSessionStateAdapter } from './thread/observation.js'
export { type ClaudeMainContext } from './types.js'

export function createClaudeMainPlugin(
  mainContext: ClaudeMainContext,
  catalogSource: ClaudeCatalogSource = createClaudeCatalogSource(mainContext)
): ClaudeMainPluginBundle {
  const evaluationSource = acquireBartEvaluationSource()
  const plugin = {
    sessionState: claudeSessionStateAdapter,
    async install({ signal }: { readonly signal: AbortSignal }): Promise<void> {
      await runCliInstaller({
        unix: "curl -fsSL https://claude.ai/install.sh | bash",
        windows: "$ErrorActionPreference = 'Stop'; irm https://claude.ai/install.ps1 | iex",
        environment: await mainContext.environment(),
        signal
      })
    },
    async detectInstallation(input: {
      readonly cwd: string
      readonly signal: AbortSignal
    }) {
      throwIfAborted(input.signal)
      const span = startDebugSpan('claude.detect-installation', {
        harnessId: 'claude',
        purpose: 'installation',
        cwd: input.cwd
      })
      try {
        const executablePath = await mainContext.resolveExecutable(input.cwd)
        throwIfAborted(input.signal)
        span.end({ installed: true, executable: executablePath })
        return { status: 'installed' as const, executablePath }
      } catch (error) {
        if (input.signal.aborted) {
          span.fail(error)
          throwIfAborted(input.signal)
        }
        if (error instanceof HarnessExecutableNotFoundError) {
          span.end({ installed: false })
          return { status: 'missing' as const }
        }
        span.fail(error)
        throwIfAborted(input.signal)
        throw error
      }
    },
    openThread: async (
      context: HarnessThreadOpenContext<'claude', ClaudeThreadSettings>
    ): Promise<HarnessThreadHandle> => openClaudeThread(mainContext, context),

    prompt: {
      complete: (request: HarnessPromptCompleteRequest<ClaudePromptSettings>) =>
        completeClaudePrompt(mainContext, request)
    },

    ...createClaudeSettings(mainContext, catalogSource),

    forkThread: async (input) => forkClaudeThread(input)
  } satisfies ClaudeMainPlugin

  return {
    ...plugin,
    dispose: () => evaluationSource.dispose(),
    availability: createCliAvailabilityProbe<ClaudeHarnessSettings>(
      mainContext, spawn),
    catalogSource,
    bartContextEntries: {
      telemetry: createClaudeTelemetryContext(mainContext),
      evaluation: createClaudeEvaluationContext(catalogSource, evaluationSource)
    }
  }
}
