import type { HarnessPluginHostContext, HarnessProviderOverride } from '@openagent/contracts'
import type { PiThreadSettings } from '../../shared/types.js'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Keep provider selection session-local, including discovery and metadata prompts. */
export function piProviderSettings(settings: Readonly<PiThreadSettings>, override?: HarnessProviderOverride): PiThreadSettings {
  if (!override) return { ...settings }
  if (settings.provider && settings.provider !== override.provider) throw new Error('Pi provider conflicts with host providerOverride')
  return { ...settings, provider: override.provider, model: settings.model ?? override.model }
}

export async function piEnvironment(host: HarnessPluginHostContext): Promise<NodeJS.ProcessEnv> {
  const environment = await host.environment()
  if (!host.providerOverride) return environment
  const override = host.providerOverride
  const directory = join(host.harnessDataRoot, 'provider-config')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `models-${randomUUID()}.json`)
  await writeFile(temporary, JSON.stringify({ providers: {
    [override.provider]: {
      baseUrl: override.baseUrl + '/v1', api: 'openai-completions', apiKey: 'OPENAGENT_PROVIDER_API_KEY',
      models: [{ id: override.model, name: override.model, reasoning: false, input: ['text'],
        contextWindow: 1_048_576, maxTokens: 16_384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
    }
  } }), { mode: 0o600 })
  await rename(temporary, join(directory, 'models.json'))
  return { ...environment, PI_CODING_AGENT_DIR: directory, OPENAGENT_PROVIDER_API_KEY: override.apiKey }
}
