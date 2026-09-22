import { createHash } from 'node:crypto'
import type { HarnessPluginHostContext, ProviderInjection } from '@openagent/contracts'
import type { PiThreadSettings } from '../../shared/types.js'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Keep provider selection session-local, including discovery and metadata prompts. */
export function piProviderSettings(settings: Readonly<PiThreadSettings>, override?: ProviderInjection): PiThreadSettings {
  if (!override) return { ...settings }
  const provider = override.configuration.provider
  if (typeof provider !== 'string') throw new Error('Invalid Pi provider injection')
  if (settings.provider && settings.provider !== provider) throw new Error('Pi provider conflicts with Provider connection')
  return { ...settings, provider, model: settings.model ?? override.model }
}

export async function piEnvironment(host: HarnessPluginHostContext): Promise<NodeJS.ProcessEnv> {
  const environment = await host.environment()
  const override = host.providers?.explicit?.injection
  if (!override) return environment
  if (override.format !== 'pi-models-v1') throw new Error('Unsupported Pi injection format')
  const directory = join(host.harnessDataRoot, 'provider-config', createHash('sha256').update(JSON.stringify(override)).digest('hex'))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `models-${randomUUID()}.json`)
  await writeFile(temporary, JSON.stringify(override.configuration.models), { mode: 0o600 })
  await rename(temporary, join(directory, 'models.json'))
  return { ...environment, PI_CODING_AGENT_DIR: directory, ...override.environment }
}
