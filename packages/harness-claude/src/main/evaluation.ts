import { claudeBackend } from './backend.js'
import type { ClaudeMainContext } from './types.js'
import {
  createBartEvaluationContext,
  type BartEvaluationSource
} from '@openagent/plugin-kit/bart/main'
import {
  defaultClaudeThreadSettings,
  type ClaudeHarnessSettings
} from '../shared/settings.js'
import type { ClaudeCatalogSource } from './catalog.js'

export function createClaudeEvaluationContext(
  catalogSource: ClaudeCatalogSource,
  source: BartEvaluationSource,
  context: ClaudeMainContext
) {
  return createBartEvaluationContext<ClaudeHarnessSettings>({
    source,
    loadBackend: async ({ cwd, signal }) => claudeBackend({ cwd, signal, providers: context.providers, environment: await context.environment() }),
    loadIdentities: async (input) => {
      const defaults = defaultClaudeThreadSettings(input.settings)
      const catalog = await catalogSource.load({
        executablePath: defaults.executablePath,
        cwd: input.cwd,
        signal: input.signal
      })
      return catalog.cli.status === 'available'
        ? catalog.models.map(model => ({
            selector: model.value,
            displayName: model.displayName
          }))
        : []
    }
  })
}
