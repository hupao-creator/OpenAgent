import type { HarnessRendererPluginModule } from '@openagent/contracts/renderer'
import { codexDescriptor } from '../shared/descriptor.js'
import type {
  CodexHarnessSettings,
  CodexSettingsPresentationData,
  CodexThreadSettingsUpdate
} from '../shared/types.js'
import { codexRendererPlugin } from './index.js'
import type { CodexOverviewView } from './overview.js'

export const codexRendererPluginModule: HarnessRendererPluginModule<
  'codex',
  CodexOverviewView,
  CodexThreadSettingsUpdate,
  CodexHarnessSettings,
  CodexSettingsPresentationData
> = {
  id: 'codex',
  descriptor: codexDescriptor,
  plugin: codexRendererPlugin
}
