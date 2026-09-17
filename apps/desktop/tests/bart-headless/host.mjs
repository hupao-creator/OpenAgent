import assert from 'node:assert/strict'
import { check } from './invariant.mjs'
import { randomBytes } from 'node:crypto'
import { nativeAdapter, providerProfile } from './providers.mjs'
import { bartThread, bounded } from './support.mjs'

/** Only the isolated worker's normal product settings are changed. */
export async function configureHost(client, requestedHost, config) {
  const before = await client.loadState()
  const routingSecret = randomBytes(24).toString('hex')
  const harnesses = { ...before.settings.harnesses }
  for (const id of Object.keys(config.providers ?? {})) {
    harnesses[id] = providerProfile(id, config)
  }
  const hostIds = requestedHost === 'auto'
    ? Object.keys(harnesses) : [requestedHost]
  for (const id of hostIds) {
    if (requestedHost !== 'auto' || config.hostProfiles?.[id]) {
      harnesses[id] = providerProfile(id, config, 'host')
    }
  }
  await client.invoke('app:update-settings', {
    ...before.settings,
    harnesses,
    bart: {
      ...before.settings.bart,
      hostHarnessPreference: requestedHost,
      autoIntervention: false,
      routingGuidance: [
        `The headless host injection receipt is ${routingSecret}.`,
        'When an acceptance directive asks for the host injection receipt, use this exact value.',
        'The receipt is supplied by Thread instructions, not by the user directive.'
      ].join('\n')
    }
  })
  const state = await client.loadState()
  const thread = bartThread(state)
  assert.ok(thread, 'headless settings did not create a Bart Thread')
  if (requestedHost !== 'auto') {
    assert.equal(thread.harnessId, requestedHost,
      `requested host was not selected: ${bounded(thread)}`)
  }
  return { requestedHost, actualHost: thread.harnessId, routingSecret }
}

export function hostEvidence(state, requestedHost, interactions = []) {
  const thread = bartThread(state)
  assert.ok(thread, 'Bart host evidence is missing')
  if (requestedHost !== 'auto') assert.equal(thread.harnessId, requestedHost)
  return {
    requestedHarnessId: requestedHost,
    harnessId: thread.harnessId,
    threadId: thread.id,
    effectiveSettings: thread.settings,
    nativeSessionId: thread.sessionState?.primarySessionId ??
      thread.sessionState?.sessionId ?? thread.sessionState?.sessionFile ?? null,
    nativeModels: nativeModels(thread),
    interactions: structuredClone(interactions)
  }
}

/** Acceptance may inspect provider facts; application Core must not. */
export function nativeModels(thread) {
  return nativeAdapter(thread.harnessId).sessionModelEvidence(thread.sessionState)
}

export function assertProviderModel(thread, override, scope = 'target') {
  if (!override || (scope !== 'host' && !thread.observation?.latestExecution)) return
  const observed = nativeModels(thread)
  const expected = nativeAdapter(thread.harnessId).qualifyRequestedModel({ model: override.model, provider: override.provider })
  check.ok(`native-model.${scope}.present`, observed.length, `${thread.harnessId} emitted no native model evidence`)
  check.ok(`native-model.${scope}.matches`, observed.every(model => model === expected),
    `${thread.harnessId} expected ${expected}; observed ${bounded(observed)}`)
}
