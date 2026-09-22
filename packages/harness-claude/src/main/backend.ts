import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessBackend, HarnessBackendObservation, HarnessProviderAccess } from '@openagent/contracts'

/** Read the native effective configuration without changing it or inferring a vendor from model names. */
export async function claudeBackend(input: {
  cwd: string; environment: NodeJS.ProcessEnv; providers?: HarnessProviderAccess;
  signal: AbortSignal; homeDirectory?: string
}): Promise<HarnessBackend> {
  if (input.providers?.explicit) return input.providers.explicit
  input.signal.throwIfAborted()
  const settingsEnvironment: NodeJS.ProcessEnv = {}
  const root = input.environment.CLAUDE_CONFIG_DIR || join(input.homeDirectory ?? homedir(), '.claude')
  for (const path of [join(root, 'settings.json'), join(input.cwd, '.claude', 'settings.json'), join(input.cwd, '.claude', 'settings.local.json')]) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (record(parsed) && record(parsed.env)) {
        for (const [key, value] of Object.entries(parsed.env)) if (typeof value === 'string') settingsEnvironment[key] = value
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unknown' }
    }
  }
  input.signal.throwIfAborted()
  const env = { ...settingsEnvironment, ...input.environment }
  const external = (env.ANTHROPIC_BASE_URL && !nativeBase(env.ANTHROPIC_BASE_URL)) || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ||
    env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_VERTEX === '1' || env.CLAUDE_CODE_USE_FOUNDRY === '1'
  const aliases: Record<string, string> = {}
  for (const name of ['OPUS', 'SONNET', 'HAIKU']) {
    const model = env[`ANTHROPIC_DEFAULT_${name}_MODEL`]
    if (model) { aliases[name.toLowerCase()] = model; aliases[name.toLowerCase() + '[1m]'] = model }
  }
  const observation: HarnessBackendObservation = external ? {
    kind: 'external', baseUrl: env.ANTHROPIC_BASE_URL,
    apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL, modelAliases: aliases
  } : { kind: 'native' }
  return input.providers?.resolve(observation) ?? (external ? { kind: 'unknown' } : { kind: 'native' })
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function nativeBase(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === 'https://api.anthropic.com' && !url.username && !url.password && !url.search && !url.hash &&
      ['/', '/v1', '/v1/'].includes(url.pathname)
  } catch { return false }
}
