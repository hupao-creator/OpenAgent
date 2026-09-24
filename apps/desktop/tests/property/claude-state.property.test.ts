import fc from 'fast-check'
import { expect, it } from 'vitest'
import { boundedRuntime } from '../../../../packages/harness-claude/src/main/thread/state'
import { appendBounded, truncate } from '../../../../packages/harness-claude/src/main/thread/values'
import { check } from './check'

it('appendBounded tail retention and truncate marker holds for generated strings', () => {
  const assertBounded = (previous: string | undefined, next: string, max: number): void => {
    const value = `${previous || ''}${next.replaceAll('\0', '')}`
    const expectedAppend = value.length <= max ? value : value.slice(-max)
    expect(appendBounded(previous, next, max)).toBe(expectedAppend)
    const sanitized = next.replaceAll('\0', '')
    const expectedTruncate = sanitized.length <= max ? sanitized : `${sanitized.slice(0, max - 1)}…`
    expect(truncate(next, max)).toBe(expectedTruncate)
  }
  check('appendBounded tail retention and truncate marker holds for generated strings', fc.property(
    fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
    fc.oneof(fc.string({ maxLength: 20 }), fc.string({ maxLength: 18 }).map(value => `a\0${value}b`)),
    fc.integer({ min: 1, max: 30 }),
    assertBounded
  ))
})

it('claude runtime capability overflow keeps exactly the first 512 entries', () => {
  check('claude runtime capability overflow keeps exactly the first 512 entries', fc.property(
    fc.integer({ min: 1, max: 24 }),
    extra => {
      const capabilities = Array.from({ length: 512 + extra }, (_, index) => `capability-${index}`)
      const runtime = boundedRuntime({ capabilities })
      expect(runtime.capabilities).toHaveLength(512)
      expect(runtime.capabilities).toEqual(capabilities.slice(0, 512))
    }
  ))
})
