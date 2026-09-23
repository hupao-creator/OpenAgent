import {
  OpenAgentSettingsShellSchema,
  UpdateThreadSettingsRequestSchema as PublicUpdateThreadSettingsRequestSchema,
  HarnessSettingsPresentationRequestSchema as PublicHarnessSettingsPresentationRequestSchema,
  parseCommand, type JsonObject, type JsonValue
} from '@openagent/contracts'
import { z } from 'zod'
import type { HarnessInstallation } from '@openagent/contracts'
import { HARNESS_IDS, isHarnessId, type HarnessId } from './harnesses'

export {
  OPENAGENT_APPEARANCES, OPENAGENT_LOCALES, MAX_BART_ROUTING_GUIDANCE_LENGTH,
  normalizeBartRoutingGuidance, bartRoutingGuidanceError
} from '@openagent/contracts'
type Settings = z.infer<typeof OpenAgentSettingsSchema>
export type OpenAgentSettings = Readonly<Omit<Settings, 'bart'> & { bart: Readonly<Settings['bart']> }>
export type OpenAgentLocale = OpenAgentSettings['locale']
export type OpenAgentAppearance = OpenAgentSettings['appearance']
export type BartHostHarnessPreference = 'auto' | HarnessId

export type HarnessSettingsMap = {
  /** Keyed by registered Harness id; a slice is absent until first persisted. */
  readonly [id: string]: JsonObject | undefined
}

/** Provider-neutral result exposed by the Settings installation probe. */
export type HarnessInstallationResult = HarnessInstallation | {
  readonly status: 'error'
  readonly message: string
} | {
  readonly status: 'installing'
}

export type HarnessInstallationMap = Record<string, HarnessInstallationResult>

/**
 * The application owns only product-level settings and the registry-shaped
 * set of Harness-owned settings slices. The key set follows the generated
 * Harness registry rather than a closed union: slices for unregistered ids
 * are inert, and a newly registered Harness starts from its Plugin-owned
 * defaults until its slice is first persisted. Each concrete Main plugin
 * still performs its own normalization and native safety checks.
 */
export function createDefaultOpenAgentSettings(): OpenAgentSettings {
  const harnesses = Object.fromEntries(
    HARNESS_IDS.map((harnessId) => [harnessId, {}])
  ) as HarnessSettingsMap
  return {
    locale: 'zh-CN',
    appearance: 'system',
    bart: {
      hostHarnessPreference: 'auto',
      targetHarnessIds: [...HARNESS_IDS],
      autoIntervention: true,
      routingGuidance: null
    },
    harnesses
  }
}

/** Composition refines provider-neutral schemas to the installed Harness registry. */
const registeredHarness = z.custom<HarnessId>(isHarnessId, '未知 Harness ID')
export const OpenAgentSettingsSchema = OpenAgentSettingsShellSchema.transform((settings) => {
  const preference = settings.bart.hostHarnessPreference
  if (preference !== 'auto' && !isHarnessId(preference)) {
    throw new Error('OpenAgent Bart Host Harness preference 无效')
  }
  if (!settings.bart.targetHarnessIds.every(isHarnessId)) {
    throw new Error('OpenAgent Bart Target Harness 集合无效')
  }
  for (const harnessId of Object.keys(settings.harnesses)) {
    if (!isHarnessId(harnessId)) throw new Error(`未注册的 Harness settings: ${harnessId}`)
  }
  return { ...settings, bart: { ...settings.bart,
    hostHarnessPreference: preference as BartHostHarnessPreference,
    targetHarnessIds: settings.bart.targetHarnessIds as readonly HarnessId[]
  }, harnesses: settings.harnesses as HarnessSettingsMap }
})
export function assertOpenAgentSettingsShell(value: unknown): asserts value is OpenAgentSettings {
  parseOpenAgentSettings(value)
}
export function parseOpenAgentSettings(value: unknown): OpenAgentSettings {
  return parseCommand(OpenAgentSettingsSchema, value)
}
export const UpdateThreadSettingsRequestSchema = PublicUpdateThreadSettingsRequestSchema.transform(value => ({
  ...value, harnessId: parseCommand(registeredHarness, value.harnessId)
}))
export const HarnessSettingsPresentationRequestSchema = PublicHarnessSettingsPresentationRequestSchema.transform(value =>
  value.scope === 'global' ? { ...value, harnessId: parseCommand(registeredHarness, value.harnessId) } : value)
export type UpdateThreadSettingsRequest = Readonly<z.infer<typeof UpdateThreadSettingsRequestSchema>>
export type HarnessSettingsPresentationRequest = Readonly<z.infer<typeof HarnessSettingsPresentationRequestSchema>>
export type { OpenAgentUiStateUpdate } from '@openagent/contracts'
export type GlobalHarnessSettingsPresentationRequest = Extract<HarnessSettingsPresentationRequest, { scope: 'global' }>
export type ThreadHarnessSettingsPresentationRequest = Extract<HarnessSettingsPresentationRequest, { scope: 'thread' }>

export interface GlobalHarnessSettingsPresentationResult {
  readonly scope: 'global'
  readonly harnessId: HarnessId
  readonly value: JsonValue
}

export interface ThreadHarnessSettingsPresentationResult {
  readonly scope: 'thread'
  readonly threadId: string
  readonly harnessId: string
  readonly value: JsonValue
}

export type HarnessSettingsPresentationResult =
  | GlobalHarnessSettingsPresentationResult
  | ThreadHarnessSettingsPresentationResult
