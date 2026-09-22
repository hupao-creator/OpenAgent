import type { HarnessMainPlugin } from '@openagent/contracts'
import type { ClaudeTransportOptions } from './runtime/transport.js'
import type {
  ClaudeHarnessSettings,
  ClaudePromptSettings,
  ClaudeSettingsPresentationData,
  ClaudeThreadSettings,
  ClaudeThreadSettingsRequest,
  ClaudeThreadSettingsUpdate
} from '../shared/settings.js'
import type { ClaudeCatalogSource } from './catalog.js'

export interface ClaudeMainContext {
  resolveExecutable(cwd: string, configuredPath?: string): Promise<string>
  readonly providers?: import('@openagent/contracts').HarnessProviderAccess
  environment(): Promise<NodeJS.ProcessEnv>
  temporaryWorkspaceRoot?: string
  interruptTimeouts?: ClaudeTransportOptions['interruptTimeouts']
}

export type ClaudeMainPlugin = HarnessMainPlugin<
  'claude',
  ClaudeHarnessSettings,
  ClaudeThreadSettings,
  ClaudeThreadSettingsRequest,
  ClaudeThreadSettingsUpdate,
  ClaudePromptSettings,
  ClaudeSettingsPresentationData
>

export type ClaudeMainPluginBundle = ClaudeMainPlugin & {
  readonly availability: import('@openagent/contracts').HarnessAvailabilityProbe<ClaudeHarnessSettings>
  readonly catalogSource: ClaudeCatalogSource
}
