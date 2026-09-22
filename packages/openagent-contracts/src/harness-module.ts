import type { HarnessId, HarnessPluginDescriptor } from './harness-descriptor.js'
import type {
  DeepReadonly,
  HarnessMainPlugin
} from './harness-plugin.js'

/**
 * Process environment snapshot crossing the Host/Plugin boundary as plain
 * data. Structurally identical to NodeJS.ProcessEnv, so a Node Host supplies
 * its snapshot directly without this contract importing Node types.
 */
export type HarnessProcessEnvironment = {
  [key: string]: string | undefined
}

/**
 * Host capabilities scoped to one Main Plugin module at composition time. The
 * Plugin supplies its executable command explicitly; harnessDataRoot is its
 * own directory below the Host-wide Harness data root. A Plugin never picks or observes
 * another module's root.
 */
export interface HarnessPluginHostContext {
  readonly providers?: import('./provider-plugin.js').HarnessProviderAccess
  /** Configured relative paths resolve against cwd; bare names search the Host environment. */
  resolveExecutable(command: string, cwd: string, configuredPath?: string): Promise<string>
  environment(): Promise<HarnessProcessEnvironment>
  readonly harnessDataRoot: string
  readonly temporaryWorkspaceRoot: string
}

/** Provider-neutral execution availability, independent of settings presentation. */
export interface HarnessAvailability {
  readonly available: boolean
  readonly reason?: string
}

export interface HarnessAvailabilityProbe<HarnessSettings> {
  probe(input: {
    readonly settings: DeepReadonly<HarnessSettings>
    readonly cwd: string
    readonly signal: AbortSignal
  }): Promise<HarnessAvailability>
}

/**
 * One module's complete Main-process surface. Core composes product roles
 * using the generic Thread capabilities declared in its descriptor.
 */
export interface HarnessMainPluginBundle<
  Id extends HarnessId,
  HarnessSettings,
  ThreadSettings,
  ThreadSettingsRequest,
  ThreadSettingsUpdate,
  PromptSettings,
  SettingsPresentationData
> extends HarnessMainPlugin<
    Id,
    HarnessSettings,
    ThreadSettings,
    ThreadSettingsRequest,
    ThreadSettingsUpdate,
    PromptSettings,
    SettingsPresentationData
  > {
  readonly availability: HarnessAvailabilityProbe<HarnessSettings>
}

/**
 * Self-registration unit for one Main-process Harness Plugin. The Host
 * aggregates modules from its dependency set; adding a Harness means adding
 * a module, never editing a Host-owned provider list.
 *
 * The members carrying provider-specific composition policy:
 * - defaultHarnessSettings: Plugin-owned settings supplied when the persisted
 *   Harness settings slice is empty. The Host clones it and never mutates it.
 * - The Plugin bundle owns a lightweight availability probe, separately from
 *   catalog and settings presentation loading.
 */
export interface HarnessMainPluginModule<
  Id extends HarnessId,
  HarnessSettings,
  ThreadSettings,
  ThreadSettingsRequest,
  ThreadSettingsUpdate,
  PromptSettings,
  SettingsPresentationData
> {
  readonly id: Id
  readonly providerSupport?: Omit<import('./provider-plugin.js').ProviderHarnessTarget, 'harnessId'>
  readonly descriptor: HarnessPluginDescriptor<Id>
  readonly defaultHarnessSettings: HarnessSettings
  createMainPlugin(
    context: HarnessPluginHostContext
  ): HarnessMainPluginBundle<
    Id,
    HarnessSettings,
    ThreadSettings,
    ThreadSettingsRequest,
    ThreadSettingsUpdate,
    PromptSettings,
    SettingsPresentationData
  >
}

/**
 * Type-erased module for the Host aggregation boundary. Concrete generic
 * parameters stay inside the owning package; the Host re-enters them only at
 * the provider-neutral JSON boundary.
 */
export type ErasedHarnessMainPluginModule = HarnessMainPluginModule<
  string,
  any,
  any,
  any,
  any,
  any,
  any
>
