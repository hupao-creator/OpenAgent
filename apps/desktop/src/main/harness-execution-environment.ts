import type { HarnessProcessEnvironment } from '@openagent/contracts'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ProviderConnections } from '@openagent/plugin-kit/main'
import { providerPluginModules } from '../generated/provider-registry.main'

/** Internal configuration entry point; credentials are resolved only in Main. */
export async function loadProviderConnections(input: {
  readonly environment: HarnessProcessEnvironment
  readonly cwd: string
  readonly headless: boolean
}) {
  const mock = await loadHeadlessProviderConfiguration(input)
  if (mock) {
    if (!input.headless) throw new Error('Mock Provider is available only in headless tests')
    const plugin = providerPluginModules.find(value => value.descriptor.id === mock.provider && value.descriptor.testOnly)
    if (!plugin) throw new Error('Headless test Provider is not registered')
    return {
      connections: new ProviderConnections([plugin], [{ id: 'headless-mock', providerId: mock.provider,
        apiKey: mock.apiKey, model: mock.model, baseUrl: mock.baseUrl }]),
      bindings: Object.fromEntries(plugin.descriptor.harnesses.map(target => [target.harnessId, 'headless-mock']))
    }
  }
  const path = input.environment.OPENAGENT_PROVIDER_CONFIG
  const configuration: unknown = path ? JSON.parse(await readFile(resolve(input.cwd, path), 'utf8')) : { connections: [], bindings: {} }
  if (!record(configuration) || !Array.isArray(configuration.connections) || !record(configuration.bindings)) {
    throw new Error('Provider configuration requires connections and bindings')
  }
  const connections = configuration.connections.map(value => {
    if (!record(value) || typeof value.id !== 'string' || typeof value.providerId !== 'string' || typeof value.apiKeyEnv !== 'string' ||
      (value.model !== undefined && typeof value.model !== 'string') || (value.baseUrl !== undefined && typeof value.baseUrl !== 'string') ||
      (value.scope !== undefined && value.scope !== 'harness' && value.scope !== 'thread')) throw new Error('Invalid Provider connection configuration')
    const apiKey = input.environment[value.apiKeyEnv]
    if (!apiKey?.trim()) throw new Error('Provider credential environment variable is unavailable')
    return { id: value.id, providerId: value.providerId, apiKey,
      ...(typeof value.model === 'string' ? { model: value.model } : {}),
      ...(typeof value.baseUrl === 'string' ? { baseUrl: value.baseUrl } : {}),
      ...(value.scope ? { scope: value.scope as 'harness' | 'thread' } : {}) }
  })
  const bindings = Object.fromEntries(Object.entries(configuration.bindings).map(([harnessId, id]) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid Provider binding')
    return [harnessId, id]
  }))
  return { connections: new ProviderConnections(providerPluginModules.filter(plugin => !plugin.descriptor.testOnly), connections), bindings }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

/** The headless test endpoint is local and never reads credentials or dotenv. */
export async function loadHeadlessProviderConfiguration(input: {
  readonly environment: HarnessProcessEnvironment
  readonly cwd: string
}): Promise<{ provider: string; model: string; apiKey: string; baseUrl: string } | undefined> {
  const provider = input.environment.OPENAGENT_BART_HEADLESS_PROVIDER?.trim()
  if (!provider) return undefined
  if (provider !== 'mock') throw new Error('Headless tests require the local mock provider')
  const url = new URL(input.environment.OPENAGENT_MOCK_LLM_URL ?? '')
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('OPENAGENT_MOCK_LLM_URL must be an HTTP loopback origin with an explicit port')
  }
  return Object.freeze({ provider, model: 'mock-model', apiKey: 'openagent-mock-key', baseUrl: url.origin })
}
