import type { HarnessProcessEnvironment, HarnessProviderOverride } from '@openagent/contracts'

/** The headless test endpoint is local and never reads credentials or dotenv. */
export async function loadHarnessProviderOverride(input: {
  readonly environment: HarnessProcessEnvironment
  readonly cwd: string
}): Promise<HarnessProviderOverride | undefined> {
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
