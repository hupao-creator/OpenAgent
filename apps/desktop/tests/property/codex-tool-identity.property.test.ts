import fc from 'fast-check'
import { expect, it } from 'vitest'
import type { HarnessThreadInjection, JsonObject } from '@openagent/contracts'
import { canonicalJson, toolConfigurationIdentity } from '../../../../packages/harness-codex/src/main/thread/thread-handle'
import { checkAsync } from './check'

const timeout = process.env.FC_EXPLORE ? 130_000 : 35_000
const budgetMs = process.env.FC_EXPLORE ? 120_000 : 10_000
// Pure in-memory hashing, so the pure sample budget applies.
const samples = { normal: 100, explore: 1000 }

// Keys from a safe ASCII alphabet: canonicalJson orders keys with
// localeCompare, and the generated keys stay inside its strictly-ordered
// range, so a tie can never re-expose insertion order.
const keyArb = fc.integer({ min: 0, max: 29 }).map(value => `k${value.toString(36)}`)
const scalarArb: fc.Arbitrary<fc.JsonValue> = fc.oneof(
  fc.nat(1000),
  fc.constant(-0.5),
  fc.string({ maxLength: 8 }),
  fc.boolean(),
  fc.constant(null)
)

const jsonArb: fc.Arbitrary<fc.JsonValue> = fc.letrec(tie => ({
  value: fc.oneof(
    scalarArb,
    fc.array(tie('value') as fc.Arbitrary<fc.JsonValue>, { maxLength: 3 }),
    fc.dictionary(keyArb, tie('value') as fc.Arbitrary<fc.JsonValue>, { maxKeys: 3 })
  )
})).value

/** A concrete key permutation: reverse every object's entry order recursively. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([key, member]) => [key, reverseKeys(member)]))
}

it('codex canonicalJson is invariant under object key permutations', async () => {
  await checkAsync('codex canonicalJson is invariant under object key permutations', fc.asyncProperty(
    fc.record({ original: fc.dictionary(keyArb, jsonArb, { maxKeys: 4 }) }),
    async ({ original }) => {
      const permuted = reverseKeys(original)
      // The identity hash feeds on exactly this stringified form.
      expect(JSON.stringify(canonicalJson(permuted))).toBe(JSON.stringify(canonicalJson(original)))
      // Canonicalization preserves the value itself, only reordering keys.
      expect(canonicalJson(original)).toEqual(original)
      expect(canonicalJson(permuted)).toEqual(permuted)
    }
  ), 'generate a nested JSON value → deep-reverse every object key order → canonical forms stringify identically and stay value-equal', budgetMs, samples)
}, timeout)

const description = fc.string({ maxLength: 12 })
const schemaArb: fc.Arbitrary<JsonObject> = fc.dictionary(
  keyArb,
  fc.oneof(scalarArb, fc.dictionary(keyArb, scalarArb, { maxKeys: 2 })),
  { maxKeys: 4 }
) as fc.Arbitrary<JsonObject>
const bindingContentArb = fc.record({
  name: fc.integer({ min: 0, max: 63 }).map(value => `tool-${value}`),
  description,
  inputSchema: schemaArb
})

/** Fisher-Yates over generated swap keys; a short key list permutes a prefix. */
function shuffled<T>(values: readonly T[], keys: readonly number[]): T[] {
  const result = [...values]
  for (let index = 0; index < result.length - 1 && index < keys.length; index += 1) {
    const swap = index + (keys[index]! % (result.length - index))
    ;[result[index], result[swap]] = [result[swap]!, result[index]!]
  }
  return result
}

// toolConfigurationIdentity reads only name/description/inputSchema; execute is
// production wiring, so a minimal cast keeps the sample type honest.
const asInjection = (mode: 'extend' | 'exclusive', bindings: readonly {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
}[]): HarnessThreadInjection =>
  ({ tools: { mode, bindings } }) as unknown as HarnessThreadInjection

it('codex toolConfigurationIdentity ignores binding order and schema key order', async () => {
  await checkAsync('codex toolConfigurationIdentity ignores binding order and schema key order', fc.asyncProperty(
    fc.record({
      mode: fc.constantFrom('extend', 'exclusive' as const),
      // Distinct names: the identity sorts definitions by name, so equal
      // names keep their input order (stable sort) and are outside the claim.
      bindings: fc.uniqueArray(bindingContentArb, { selector: binding => binding.name, minLength: 1, maxLength: 5 }),
      swaps: fc.array(fc.nat(9), { minLength: 1, maxLength: 8 })
    }),
    async ({ mode, bindings, swaps }) => {
      const original = asInjection(mode, bindings)
      const permutedBindings = shuffled(
        bindings.map(binding => ({ ...binding, inputSchema: reverseKeys(binding.inputSchema) as JsonObject })),
        swaps
      )
      const permuted = asInjection(mode, permutedBindings)
      expect(toolConfigurationIdentity(permuted)).toBe(toolConfigurationIdentity(original))
      // Sanity: the identity still separates genuinely different tools.
      const renamed = asInjection(mode, permutedBindings.map((binding, index) =>
        ({ ...binding, name: index === 0 ? `${binding.name}-x` : binding.name })))
      expect(toolConfigurationIdentity(renamed)).not.toBe(toolConfigurationIdentity(original))
      // The tool mode is part of the hashed configuration.
      const flipped = asInjection(mode === 'extend' ? 'exclusive' : 'extend', bindings)
      expect(toolConfigurationIdentity(flipped)).not.toBe(toolConfigurationIdentity(original))
    }
  ), 'generate a tool injection → permute bindings and reverse every schema key order → the identity hash is unchanged, while renames and mode flips are detected', budgetMs, samples)
}, timeout)
