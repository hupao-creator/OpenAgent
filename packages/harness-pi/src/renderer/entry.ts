import type { HarnessRendererPluginModule } from '@openagent/contracts/renderer'
import { piDescriptor } from '../shared/descriptor.js'
import { piState } from '../shared/state.js'
import { projectPiBartPresentation } from '../shared/bart-presentation.js'
import type { PiHarnessSettings as Settings, PiThreadSettingsUpdate, PiSettingsPresentation } from '../shared/types.js'
import { PiThreadView } from './ThreadView.js'
import { PiThreadSettings, PiHarnessSettings } from './Settings.js'
import { piOverviewCardModule, type PiOverviewView } from './OverviewCard.js'
import { piLogo } from './pi-logo.js'
import { piRendererTranslations } from './translations.js'
import './pi.css'
export const piRendererPluginModule: HarnessRendererPluginModule<'pi', PiOverviewView, PiThreadSettingsUpdate, Settings, PiSettingsPresentation> = {
  id: 'pi', descriptor: piDescriptor,
  plugin: {
    logoSource: piLogo, translations: piRendererTranslations, ThreadView: PiThreadView, ThreadSettings: PiThreadSettings, HarnessSettings: PiHarnessSettings, OverviewCard: piOverviewCardModule,
    projectBartDock({ thread }) {
      return projectPiBartPresentation(piState(thread.sessionState))
    }
  }
}
export default piRendererPluginModule
