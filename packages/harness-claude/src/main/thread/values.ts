import { isJsonValue, type JsonValue } from '@openagent/contracts'

export function encodeJsonState(value: unknown, label: string): JsonValue {
  if (!isJsonValue(value)) throw new Error(`${label} 不是有效 JSON`)
  return value
}

export function truncate(value: string, max: number): string {
  const sanitized = value.replaceAll('\0', '')
  return sanitized.length <= max
    ? sanitized
    : `${sanitized.slice(0, max - 1)}…`
}

export function appendBounded(
  previous: string | undefined,
  next: string,
  max: number
): string {
  const value = `${previous || ''}${next.replaceAll('\0', '')}`
  return value.length <= max ? value : value.slice(-max)
}

export function trimSet<T>(values: Set<T>, maximum: number): void {
  while (values.size > maximum) {
    const oldest = values.values().next()
    if (oldest.done) return
    values.delete(oldest.value)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
