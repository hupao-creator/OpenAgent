import { homedir } from 'node:os'
import { join } from 'node:path'
import { cliResolverWithInstallPath } from '@openagent/plugin-kit/main'
import type {
  HarnessMainPluginModule,
  HarnessPluginHostContext
} from '@openagent/contracts'
import { claudeDescriptor } from '../shared/descriptor.js'
import {
  DEFAULT_CLAUDE_HARNESS_SETTINGS,
  type ClaudeHarnessSettings,
  type ClaudePromptSettings,
  type ClaudeSettingsPresentationData,
  type ClaudeThreadSettings,
  type ClaudeThreadSettingsRequest,
  type ClaudeThreadSettingsUpdate
} from '../shared/settings.js'
import { createClaudeMainPlugin, type ClaudeMainPluginBundle } from './index.js'

export const claudeMainPluginModule: HarnessMainPluginModule<
  'claude',
  ClaudeHarnessSettings,
  ClaudeThreadSettings,
  ClaudeThreadSettingsRequest,
  ClaudeThreadSettingsUpdate,
  ClaudePromptSettings,
  ClaudeSettingsPresentationData
> = {
  id: 'claude',
  descriptor: claudeDescriptor,
  defaultHarnessSettings: DEFAULT_CLAUDE_HARNESS_SETTINGS,
  createMainPlugin(context: HarnessPluginHostContext): ClaudeMainPluginBundle {
    return createClaudeMainPlugin({
      resolveExecutable: cliResolverWithInstallPath(
        (cwd, configuredPath) => context.resolveExecutable('claude', cwd, configuredPath),
        join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
        // Claude's defaults name the command rather than a path, so they must
        // reach the same auto-detection a Thread without a pinned binary does.
        'claude'
      ),
      environment: () => context.environment(),
      providerOverride: context.providerOverride,
      temporaryWorkspaceRoot: context.temporaryWorkspaceRoot
    })
  }
}
