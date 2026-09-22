import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessBackend, HarnessPluginHostContext } from '@openagent/contracts'

/** Pi exposes the actual model endpoint in its native state; credentials remain Main-only. */
export async function piBackend(host: HarnessPluginHostContext, nativeModel: Record<string, unknown>): Promise<HarnessBackend> {
  if (host.providers?.explicit) return host.providers.explicit
  if (typeof nativeModel.provider !== 'string' || typeof nativeModel.baseUrl !== 'string') return { kind: 'unknown' }
  const environment = await host.environment()
  const directory = environment.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  const provider = nativeModel.provider
  let apiKey = environment[provider.toUpperCase().replaceAll('-', '_') + '_API_KEY']
  try {
    const auth = record((await json(join(directory, 'auth.json')))[provider])
    if (auth.type !== undefined) {
      apiKey = auth.type === 'api_key' && typeof auth.key === 'string'
        ? configValue(auth.key, { ...environment, ...record(auth.env) }) : undefined
    } else {
      const models = await json(join(directory, 'models.json'))
      const key = record(record(models.providers)[provider]).apiKey
      // Stored native credentials take precedence over configured keys in Pi.
      // Shell key commands are deliberately not executed by discovery.
      if (typeof key === 'string') apiKey = configValue(key, environment)
    }
  } catch { return { kind: 'unknown' } }
  return host.providers?.resolve({ kind: 'external', baseUrl: nativeModel.baseUrl, apiKey,
    model: typeof nativeModel.id === 'string' ? nativeModel.id : undefined }) ?? { kind: 'unknown' }
}

async function json(path: string): Promise<Record<string, unknown>> {
  try { return record(JSON.parse(await readFile(path, 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

/** Pi interpolates $NAME / ${NAME}; discovery never runs its !shell commands. */
function configValue(value: string, environment: Record<string, unknown>): string | undefined {
  if (value.startsWith('!')) return undefined
  let missing = false
  const resolved = value.replace(/\$(\$|!|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, (_, reference: string) => {
    if (reference === '$' || reference === '!') return reference
    const name = reference.startsWith('{') ? reference.slice(1, -1) : reference
    const found = environment[name]
    if (typeof found !== 'string' || !found) { missing = true; return '' }
    return found
  })
  return missing ? undefined : resolved
}
