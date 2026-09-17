import { describe, expect, it } from 'vitest'
import { isJsonValue } from '@openagent/contracts'

describe('agent core JSON values', () => {
  it('rejects structured-clone objects that are not JSON objects', () => {
    class RecordLike {
      readonly enabled = true
    }

    expect(isJsonValue(new Date())).toBe(false)
    expect(isJsonValue(new Map([['enabled', true]]))).toBe(false)
    expect(isJsonValue(new Set(['enabled']))).toBe(false)
    expect(isJsonValue(new Uint8Array([1, 2, 3]))).toBe(false)
    expect(isJsonValue(new RecordLike())).toBe(false)
    expect(isJsonValue(Object.create(null, {
      enabled: { value: true, enumerable: true }
    }))).toBe(true)
  })

  it('revalidates reused objects and arrays after they change', () => {
    const nested: Record<string, unknown> = { valid: true }
    const value: unknown[] = [nested]

    expect(isJsonValue(value)).toBe(true)

    nested.invalid = undefined
    expect(isJsonValue(value)).toBe(false)
  })

  it('rejects values whose structured shape cannot survive an exact JSON round trip', () => {
    const sparse = Array.from({ length: 2 }) as unknown[]
    sparse[1] = 'present'
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const hidden = Object.create(null, {
      visible: { value: true, enumerable: true },
      hidden: { value: true, enumerable: false }
    })
    const arrayGetter: unknown[] = []
    Object.defineProperty(arrayGetter, '0', {
      enumerable: true,
      configurable: true,
      get: () => 'unstable'
    })
    arrayGetter.length = 1

    expect(isJsonValue({ optional: undefined })).toBe(false)
    expect(isJsonValue(sparse)).toBe(false)
    expect(isJsonValue(cyclic)).toBe(false)
    expect(isJsonValue(hidden)).toBe(false)
    expect(isJsonValue(arrayGetter)).toBe(false)

    const accepted = {
      execution: { status: 'running', summary: 'exact' },
      rows: [1, null, true, 'text']
    }
    expect(isJsonValue(accepted)).toBe(true)
    expect(JSON.parse(JSON.stringify(accepted))).toEqual(accepted)
  })
})
