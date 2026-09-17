/**
 * Native capability registry, composed from each Harness's own test adapter
 * (`@openagent/harness-<id>/test-support`). The registered set is derived from
 * the Desktop dependency mechanism — the same source the registry generator
 * reads — so adding or removing a Harness package never edits this file. A
 * registered Harness without an adapter is a hard, named failure: generic
 * runners never silently skip it.
 *
 * Every entry describes real CLI behaviour only: no case may substitute a fake
 * Harness, fake transport, or simulated tool.
 *
 * `options` is the least-privilege target configuration used by observation
 * cases. `permissiveOptions` is the configuration a case must ask for when the
 * native agent has to touch the filesystem without a permission interaction.
 */
import { canHostBart, loadNativeTestAdapters } from '@openagent/test-kit'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const adapters = await loadNativeTestAdapters({ workspaceRoot: desktopRoot })

export const PROVIDERS = Object.fromEntries(Object.entries(adapters).map(([harnessId, adapter]) => [harnessId, {
  displayName: adapter.displayName,
  capabilities: [...adapter.scenarioCapabilities],
  options: structuredClone(adapter.observationThreadSettings),
  permissiveOptions: structuredClone(adapter.permissiveThreadSettings),
  ...(adapter.nativeTools.permission ? { permissionTool: adapter.nativeTools.permission } : {}),
  ...(adapter.nativeTools.question ? { questionTool: adapter.nativeTools.question } : {})
}]))

export const HARNESS_IDS = Object.freeze(Object.keys(PROVIDERS))

/**
 * The subset whose declared capabilities satisfy the ordinary-injection host
 * contract (instructions, Thread/send context, exclusive tools). Generic
 * runners use this for HOST selection; every adapter stays available as a
 * dispatch TARGET through HARNESS_IDS.
 */
export const HOST_HARNESS_IDS = Object.freeze(HARNESS_IDS.filter(harnessId =>
  canHostBart(adapters[harnessId].descriptor.threadCapabilities)))

export function provider(harnessId) {
  const found = PROVIDERS[harnessId]
  if (!found) throw new Error(`Unknown Harness: ${harnessId}`)
  return found
}

/**
 * Merges the case-selected native profile with explicit run configuration.
 * Ambient model settings must not change an isolated Mock LLM run.
 */
export function providerOptions(harnessId, config, overrides = {}) {
  const source = provider(harnessId)
  const base = structuredClone(source.options)
  const profile = providerProfile(harnessId, config)
  Object.assign(base, profile.threadSettings)
  Object.assign(base, structuredClone(overrides))
  return base
}

/** The same generic Harness profile that the GUI persists. */
export function providerProfile(harnessId, config, role = 'target') {
  provider(harnessId)
  const path = role === 'host' && config.hostProfiles?.[harnessId]
    ? 'hostProfiles' : 'providers'
  const configured = config[path]?.[harnessId] ?? { threadSettings: {} }
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error(`${path}.${harnessId} must be a Harness profile object`)
  }
  const unknown = Object.keys(configured)
    .filter(key => key !== 'threadSettings' && key !== 'useDefaultThreadSettings')
  if (unknown.length) {
    throw new Error(`${path}.${harnessId} has unsupported fields: ${unknown.join(', ')}; ` +
      'use { useDefaultThreadSettings: false, threadSettings: { ...native settings } }')
  }
  if (configured.useDefaultThreadSettings !== undefined &&
    typeof configured.useDefaultThreadSettings !== 'boolean') {
    throw new Error(`${path}.${harnessId}.useDefaultThreadSettings must be a boolean`)
  }
  const settings = configured.threadSettings ?? {}
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${path}.${harnessId}.threadSettings must be an object`)
  }
  const threadSettings = structuredClone(settings)
  // A Harness on its Agent defaults discards whatever the GUI stored, so a
  // profile carrying values must opt out of those defaults or normalization
  // silently drops the model override this suite was asked to exercise.
  const optedOut = configured.useDefaultThreadSettings === false ||
    Object.keys(threadSettings).length > 0
  return optedOut
    ? { useDefaultThreadSettings: false, threadSettings }
    : { threadSettings: {} }
}

/** Least-privilege options replaced by the native profile that can write. */
export function permissiveProviderOptions(harnessId, config) {
  return providerOptions(harnessId, config, provider(harnessId).permissiveOptions)
}

/** The owning Harness's native test adapter (protocol facts, recorder args, dialect). */
export function nativeAdapter(harnessId) {
  const adapter = adapters[harnessId]
  if (!adapter) throw new Error(`Unknown Harness: ${harnessId}`)
  return adapter
}
