import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DeepReadonly, JsonValue } from '@openagent/contracts'
import { parseClaudeThreadState } from '../shared/state.js'
import {
  applyClaudeThreadSettingsUpdate,
  claudePromptSettings,
  claudeThreadSettingsSchema,
  defaultClaudeThreadSettings,
  normalizeClaudeHarnessSettings,
  normalizeClaudeThreadSettings,
  validateClaudeThreadCreationOptions,
  type ClaudeHarnessSettings,
  type ClaudeSettingsPresentationData,
  type ClaudeThreadSettings
} from '../shared/settings.js'
import { validateClaudeCatalogSelection, type ClaudeCatalogSource } from './catalog.js'
import { type ClaudeMainContext } from './types.js'
import { throwIfAborted, abortable } from './runtime/cancellation.js'
import type { ClaudeMainPlugin } from './types.js'

export function createClaudeSettings(mainContext: ClaudeMainContext, catalogSource: ClaudeCatalogSource): Pick<ClaudeMainPlugin, 'settings' | 'settingsPresentation'> {
  return {
    settings: {
      normalizeHarnessSettings: normalizeClaudeHarnessSettings,

      defaultThreadSettings: defaultClaudeThreadSettings,

      describe: async (input) => {
        throwIfAborted(input.signal)
        const defaults = defaultClaudeThreadSettings(input.settings)
        const catalog = await catalogSource.load({
          executablePath: defaults.executablePath,
          cwd: input.cwd,
          signal: input.signal
        })
        throwIfAborted(input.signal)
        return claudeThreadSettingsSchema(catalog)
      },

      resolveThreadSettings: async (input): Promise<ClaudeThreadSettings> => {
        throwIfAborted(input.signal)
        if (input.requested !== undefined) validateClaudeThreadCreationOptions(input.requested)
        const resolved = normalizeClaudeThreadSettings(input.merged)
        if (
          input.requested &&
          Object.hasOwn(input.requested, 'model') &&
          !Object.hasOwn(input.requested, 'effort')
        ) {
          delete resolved.effort
        }
        if (hasClaudeThreadContent(input.sessionState) && input.existing !== undefined) {
          const existing = normalizeClaudeThreadSettings(input.existing)
          if (resolved.goalMode !== existing.goalMode) {
            throw new Error('已有 Claude Primary Native Session 不能切换 goal mode')
          }
          // Retained native sessions keep their executable and tool filters
          // when Host defaults refresh; only Claude interprets session content.
          resolved.executablePath = existing.executablePath
          for (const key of ['allowedTools', 'disallowedTools'] as const) {
            if (existing[key] === undefined) delete resolved[key]
            else resolved[key] = existing[key]
          }
        }
        await validateResolvedClaudeSettings(
          catalogSource,
          resolved,
          input.cwd,
          input.signal
        )
        return resolved
      },

      hasThreadContent: hasClaudeThreadContent,

      applyThreadSettingsUpdate: async (input): Promise<ClaudeThreadSettings> => {
        throwIfAborted(input.signal)
        const current = normalizeClaudeThreadSettings(input.current)
        const defaults = normalizeClaudeThreadSettings(input.defaults)
        const resolved = applyClaudeThreadSettingsUpdate({
          current: input.current,
          defaults: input.defaults,
          update: input.update,
          hasContent: input.hasContent
        })
        if (Object.hasOwn(input.update, 'model')) {
          if (input.update.model === null) {
            if (!Object.hasOwn(input.update, 'effort')) {
              if (defaults.effort === undefined) delete resolved.effort
              else resolved.effort = defaults.effort
            }
          } else if (
            resolved.model !== current.model &&
            !Object.hasOwn(input.update, 'effort')
          ) {
            delete resolved.effort
          }
        }
        await validateResolvedClaudeSettings(
          catalogSource,
          resolved,
          input.cwd,
          input.signal
        )
        return resolved
      },

      promptSettings: claudePromptSettings
    },
    settingsPresentation: {
      load: async (input): Promise<ClaudeSettingsPresentationData> => {
        throwIfAborted(input.signal)
        const normalized = normalizeClaudeHarnessSettings(
          input.settings as ClaudeHarnessSettings
        )
        const threadSettings = input.thread
          ? normalizeClaudeThreadSettings(
              input.thread.settings as DeepReadonly<ClaudeThreadSettings>
            )
          : undefined
        const presentation = await catalogSource.load({
          executablePath: threadSettings?.executablePath || defaultClaudeThreadSettings(normalized).executablePath,
          cwd: input.cwd,
          ...(input.refresh ? { refresh: true } : {}),
          signal: input.signal
        })
        throwIfAborted(input.signal)
        if (presentation.cli.status !== 'available' || presentation.cli.version) {
          return presentation
        }
        try {
          const environment = await abortable(mainContext.environment(), input.signal)
          throwIfAborted(input.signal)
          const { stdout } = await promisify(execFile)(presentation.cli.executablePath, ['--version'], {
            cwd: input.cwd,
            env: environment,
            signal: input.signal,
            timeout: 10_000
          })
          throwIfAborted(input.signal)
          return {
            ...presentation,
            cli: { ...presentation.cli, ...(stdout.trim() ? { version: stdout.trim() } : {}) }
          }
        } catch {
          throwIfAborted(input.signal)
          // Version is optional metadata; a failed probe must not hide the
          // capabilities already returned by native initialization.
          return presentation
        }
      }
    }
  }
}

async function validateResolvedClaudeSettings(
  catalogSource: ClaudeCatalogSource,
  settings: ClaudeThreadSettings,
  cwd: string,
  signal: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  if (!settings.model && !settings.effort) return
  const catalog = await catalogSource.load({
    executablePath: settings.executablePath,
    cwd,
    signal
  })
  throwIfAborted(signal)
  validateClaudeCatalogSelection(catalog, settings)
}

function hasClaudeThreadContent(sessionState: DeepReadonly<JsonValue>): boolean {
  if (sessionState === null) return false
  const state = parseClaudeThreadState(sessionState)
  return state.primarySessionId !== undefined || state.pendingFork !== undefined || state.turns.length > 0
}
