import { useMemo, useRef } from 'react'

/**
 * Native decoders receive cloned IPC data. Restore identity for equal subtrees
 * of their plain snapshot DTOs so historical turns can skip React rendering.
 * Compare actual fields, not timestamps: more than one update can share a clock
 * tick. Nothing is mutated and only the latest snapshot is retained.
 */
export function useReconciledSnapshot<Value>(snapshot: Value): Value {
  const previous = useRef(snapshot)
  return useMemo(() => {
    const shared = shareSnapshot(previous.current, snapshot)
    previous.current = shared
    return shared
  }, [snapshot])
}

function shareSnapshot<Value>(previous: Value, next: Value): Value {
  if (Object.is(previous, next)) return previous
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next
  if (Array.isArray(previous) !== Array.isArray(next)) return next
  const before = previous as Record<string, unknown>
  const after = next as Record<string, unknown>
  const keys = Object.keys(after)
  const copyNext = (): Record<string, unknown> => Array.isArray(next)
    ? [...next] as unknown as Record<string, unknown>
    : { ...after }
  let result = Object.keys(before).length === keys.length ? undefined : copyNext()
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!
    const owned = Object.hasOwn(before, key)
    const shared = owned ? shareSnapshot(before[key], after[key]) : after[key]
    if (!result && (!owned || !Object.is(shared, before[key]))) {
      // Most objects are unchanged history. Allocate only when a field differs;
      // all preceding fields have already been proven equal to the old values.
      result = copyNext()
      for (let earlier = 0; earlier < index; earlier += 1) {
        const previousKey = keys[earlier]!
        defineValue(result, previousKey, before[previousKey])
      }
    }
    if (result) defineValue(result, key, shared)
  }
  return result ? result as Value : previous
}

function defineValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}
