import type { JsonObject, JsonValue } from '@openagent/contracts'

export function cloneBoundedJsonValue(
  value: unknown,
  label: string,
  maxBytes: number
): JsonValue {
  if (!isStrictJsonValue(value, new Set())) {
    throw new Error(`${label} must be a JSON value`)
  }

  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new Error(`${label} could not be serialized`, { cause: error })
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`)
  }
  return JSON.parse(serialized) as JsonValue
}

export function cloneBoundedJsonObject(
  value: unknown,
  label: string,
  maxBytes: number
): JsonObject {
  const cloned = cloneBoundedJsonValue(value, label, maxBytes)
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return cloned
}

function isStrictJsonValue(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false

  if (ancestors.has(value)) return false
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isStrictJsonValue(item, ancestors))
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    if (Object.getOwnPropertySymbols(value).length > 0) return false

    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) return false
      if (!isStrictJsonValue(descriptor.value, ancestors)) return false
    }
    return true
  } finally {
    ancestors.delete(value)
  }
}
