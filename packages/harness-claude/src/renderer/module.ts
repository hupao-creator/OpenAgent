import type { HarnessRendererPluginModule } from '@openagent/contracts/renderer'
import { claudeDescriptor } from '../shared/descriptor.js'
import type {
  ClaudeHarnessSettings,
  ClaudeSettingsPresentationData,
  ClaudeThreadSettingsUpdate
} from '../shared/settings.js'
import { claudeRendererPlugin, type ClaudeOverviewView } from './index.js'

export const claudeRendererPluginModule: HarnessRendererPluginModule<
  'claude',
  ClaudeOverviewView,
  ClaudeThreadSettingsUpdate,
  ClaudeHarnessSettings,
  ClaudeSettingsPresentationData
> = {
  id: 'claude',
  descriptor: claudeDescriptor,
  plugin: claudeRendererPlugin
}
