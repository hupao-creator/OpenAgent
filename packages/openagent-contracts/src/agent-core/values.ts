type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueWithAncestors(value, new Set<object>())
}

function isJsonValueWithAncestors(
  value: unknown,
  ancestors: Set<object>
): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || ancestors.has(value)) return false
    // Array#every skips holes, while JSON.stringify silently writes them as
    // null. Reject both holes and non-index own properties so the accepted
    // value survives an exact JSON round trip.
    if (
      Object.keys(value).length !== value.length ||
      Reflect.ownKeys(value).length !== value.length + 1
    ) return false
    ancestors.add(value)
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
          !isJsonValueWithAncestors(descriptor.value, ancestors)) {
        ancestors.delete(value)
        return false
      }
    }
    ancestors.delete(value)
    return true
  }
  return isJsonObjectWithAncestors(value, ancestors)
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isJsonObjectWithAncestors(value, new Set<object>())
}

function isJsonObjectWithAncestors(
  value: unknown,
  ancestors: Set<object>
): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if ((prototype !== Object.prototype && prototype !== null) || ancestors.has(value)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => (
    typeof key !== 'string' ||
    !descriptors[key]?.enumerable ||
    !Object.hasOwn(descriptors[key], 'value')
  ))) return false
  ancestors.add(value)
  for (const descriptor of Object.values(descriptors)) {
    if (!isJsonValueWithAncestors(descriptor.value, ancestors)) {
      ancestors.delete(value)
      return false
    }
  }
  ancestors.delete(value)
  return true
}
