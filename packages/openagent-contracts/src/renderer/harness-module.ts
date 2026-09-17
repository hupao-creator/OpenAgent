import type { HarnessId, HarnessPluginDescriptor } from '../harness-descriptor.js'
import type { HarnessRendererPlugin } from './harness-plugin.js'

/**
 * Self-registration unit for one Renderer Harness Plugin. The Renderer Host
 * aggregates modules from its dependency set and dispatches through the
 * Plugin's own components. OverviewView and SettingsPresentationData stay
 * Plugin-private: the Host erases them at the module collection and re-enters
 * them only through its JSON settings-presentation resource boundary.
 */
export interface HarnessRendererPluginModule<
  Id extends HarnessId,
  OverviewView,
  ThreadSettingsUpdate,
  HarnessSettings,
  SettingsPresentationData
> {
  readonly id: Id
  readonly descriptor: HarnessPluginDescriptor<Id>
  readonly plugin: HarnessRendererPlugin<
    OverviewView,
    ThreadSettingsUpdate,
    HarnessSettings,
    SettingsPresentationData
  >
}

/**
 * Type-erased module for the Renderer Host aggregation boundary; the Host
 * dispatches only through provider-neutral props and resources.
 */
export type ErasedHarnessRendererPluginModule = HarnessRendererPluginModule<
  string,
  any,
  any,
  any,
  any
>
