/**
 * Open Harness identity at the contract layer. The Host composes its own
 * closed identity set from the aggregated module registry; a Plugin is
 * written against its own literal id and never enumerates other Harnesses.
 */
export type HarnessId = string

export interface HarnessPluginDescriptor<Id extends string> {
  readonly id: Id
  readonly displayName: string
  readonly threadCapabilities: HarnessThreadCapabilities
}

/** Native injection capabilities, independent of any Core role. */
export interface HarnessThreadCapabilities {
  readonly instructions: boolean
  readonly threadContext: boolean
  readonly sendContext: boolean
  readonly toolModes: readonly ('extend' | 'exclusive')[]
}

/**
 * Core's Bart host role requires every declared native injection capability.
 * The rule reads capabilities only: it holds for any registered Harness
 * combination and never names a concrete plugin identity.
 */
export function canHostBart(capabilities: HarnessThreadCapabilities): boolean {
  return capabilities.instructions && capabilities.threadContext && capabilities.sendContext &&
    capabilities.toolModes.includes('exclusive')
}
