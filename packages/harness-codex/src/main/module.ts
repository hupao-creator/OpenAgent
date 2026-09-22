import { homedir } from 'node:os'
import { join } from 'node:path'
import { cliResolverWithInstallPath } from '@openagent/plugin-kit/main'
import type {
  HarnessMainPluginModule,
  HarnessPluginHostContext
} from '@openagent/contracts'
import { codexDescriptor } from '../shared/descriptor.js'
import type {
  CodexHarnessSettings,
  CodexPromptSettings,
  CodexSettingsPresentationData,
  CodexThreadSettings,
  CodexThreadSettingsRequest,
  CodexThreadSettingsUpdate
} from '../shared/types.js'
import { createCodexMainPlugin, type CodexMainPluginBundle } from './index.js'

/**
 * Plugin-owned bootstrap settings, supplied by the Host when the persisted
 * Codex Harness settings slice is empty.
 */
const DEFAULT_CODEX_HARNESS_SETTINGS: CodexHarnessSettings = {
  threadSettings: {}
}

export const codexMainPluginModule: HarnessMainPluginModule<
  'codex',
  CodexHarnessSettings,
  CodexThreadSettings,
  CodexThreadSettingsRequest,
  CodexThreadSettingsUpdate,
  CodexPromptSettings,
  CodexSettingsPresentationData
> = {
  id: 'codex',
  providerSupport: { format: 'codex-config-v1', scopes: ['harness'] },
  descriptor: codexDescriptor,
  defaultHarnessSettings: DEFAULT_CODEX_HARNESS_SETTINGS,
  createMainPlugin(context: HarnessPluginHostContext): CodexMainPluginBundle {
    return createCodexMainPlugin({
      resolveExecutable: cliResolverWithInstallPath(
        (cwd, configuredPath) => context.resolveExecutable('codex', cwd, configuredPath),
        join(process.env.CODEX_INSTALL_DIR || (process.platform === 'win32'
          ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin')
          : join(homedir(), '.local', 'bin')), process.platform === 'win32' ? 'codex.exe' : 'codex')
      ),
      environment: () => context.environment(),
      providers: context.providers,
      dataRoot: context.harnessDataRoot,
      temporaryWorkspaceRoot: context.temporaryWorkspaceRoot
    })
  }
}
