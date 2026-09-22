import type { ProviderInjection } from '@openagent/contracts'

export function codexProviderInjectionConfig(injection: ProviderInjection, catalogPath: string): string {
  if (injection.format !== 'codex-config-v1') throw new Error('Unsupported Codex injection format')
  return Object.entries({ ...record(injection.configuration.config), model_catalog_json: catalogPath })
    .map(([key, value]) => `${JSON.stringify(key)} = ${tomlValue(value)}`).join('\n') + '\n'
}

export function codexProviderInjectionCatalog(catalog: Record<string, unknown>, injection: ProviderInjection): Record<string, unknown> {
  if (injection.format !== 'codex-config-v1') throw new Error('Unsupported Codex injection format')
  const template = Array.isArray(catalog.models) ? catalog.models[0] : undefined
  if (!template || typeof template !== 'object' || Array.isArray(template)) throw new Error('Codex bundled model catalog is empty')
  return { ...catalog, models: [{ ...template, ...record(injection.configuration.model) }] }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex injection configuration')
  return value as Record<string, unknown>
}
function tomlValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`
  return `{ ${Object.entries(record(value)).filter(([, v]) => v !== null).map(([key, v]) => `${JSON.stringify(key)} = ${tomlValue(v)}`).join(', ')} }`
}
