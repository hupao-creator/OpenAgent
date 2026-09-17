import fc from 'fast-check'
import { expect, it } from 'vitest'
import type { BartTelemetrySnapshot } from '@openagent/contracts'
import {
  CODEX_USAGE_SOURCE,
  createCodexBartTelemetryContributor,
  normalizeCodexBartTelemetry
} from '../../../../packages/harness-codex/src/bart/usage'
import { checkAsync } from './check'

const timeout = process.env.FC_EXPLORE ? 130_000 : 35_000
const budgetMs = process.env.FC_EXPLORE ? 120_000 : 10_000
// Pure in-memory normalization, so the pure sample budget applies.
const samples = { normal: 100, explore: 1000 }

/** Drop keys carrying undefined so generated payloads stay plain JSON records. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T
}

const opt = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.option(arb, { nil: undefined })

// Dictionary ids live in the 'd*' range and may also collide with the primary
// limit id: real Codex payloads carry the same primary id in `rateLimits` and in
// `rateLimitsByLimitId`, and the primary bucket is insert-only, so an
// overlapping dictionary bucket stays authoritative for that id while an
// unconditional overwrite would replace the dictionary quota with it.
const providerLimitId = fc.constantFrom('p0', 'p1', 'p2', 'p3', 'p4', 'p5')
const modelLimitId = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 500 }).map(value => `d${value}`) },
  { weight: 1, arbitrary: providerLimitId }
)
const windowName = opt(fc.integer({ min: 0, max: 99_999 }).map(value => `name${value}`))

/**
 * Used percentages include exact boundary values, values far above 100 and
 * invalid negatives: percentValue accepts every finite non-negative number
 * (no upper clamp) and rejects negatives to null, so the honest invariant is
 * the documented rounding plus rejection, not a [0, 100] range.
 */
const percentArb = fc.oneof(
  fc.nat(12_000).map(value => value / 100),
  fc.constantFrom(0, 99.999, 100, 100.005, 1e9, -0.5, -1e9)
)
const resetsAtArb = fc.oneof(
  fc.constantFrom<unknown>('2026-09-12T00:00:00.000Z', 'not-a-timestamp', 42, ''),
  fc.integer({ min: 0, max: 4_000_000_000 }),
  fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 })
)
const windowArb = fc.record({
  usedPercent: opt(percentArb),
  windowDurationMins: opt(fc.oneof(
    fc.integer({ min: 1, max: 20_160 }),
    fc.constantFrom<number>(0, -1, Number.NaN, Number.POSITIVE_INFINITY)
  )),
  resetsAt: opt(resetsAtArb)
}).map(compact)

const bucketArbFor = (limitId: fc.Arbitrary<string | undefined>): fc.Arbitrary<Record<string, unknown>> =>
  fc.record({
    limitId,
    limitName: windowName,
    planType: windowName,
    spendControlReached: fc.boolean(),
    rateLimitReachedType: opt(modelLimitId),
    primary: opt(windowArb),
    secondary: opt(windowArb)
  }).map(compact)

const modelBucketArb = bucketArbFor(opt(modelLimitId))
const primaryBucketArb = bucketArbFor(opt(providerLimitId))

const payloadArb = fc.oneof(
  { weight: 4, arbitrary: fc.record({
    rateLimits: opt(primaryBucketArb),
    // Dictionary values may be undefined: the normalizer must skip them.
    rateLimitsByLimitId: fc.dictionary(modelLimitId, opt(modelBucketArb), { maxKeys: 3 })
  }) },
  { weight: 1, arbitrary: fc.constantFrom<unknown>(
    null, 42, 'x', [], { rateLimits: 'nope' }, { rateLimitsByLimitId: [] }, {}
  ) }
)

const roundPercent = (value: number): number => Math.round(value * 100) / 100

const nonEmptyText = (value: unknown): boolean =>
  typeof value === 'string' && Boolean(value.trim())

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

interface ResolvedLimits {
  readonly buckets: Map<string, Record<string, unknown>>
  /** The frame's own primary limit id, or null when it names none (no fallback). */
  readonly primaryId: string | null
}

/**
 * Mirrors the normalizer's bucket map: dictionary buckets are later-wins, the
 * primary bucket is inserted only when its id is still free, and the frame's
 * primary id is the raw `rateLimits.limitId` with no 'codex' fallback.
 */
function resolveLimits(payload: unknown): ResolvedLimits {
  const root = asRecord(payload)
  const buckets = new Map<string, Record<string, unknown>>()
  for (const [fallbackId, rawBucket] of Object.entries(asRecord(root.rateLimitsByLimitId))) {
    if (typeof rawBucket !== 'object' || rawBucket === null || Array.isArray(rawBucket)) continue
    const raw = rawBucket as Record<string, unknown>
    const id = nonEmptyText(raw.limitId) ? (raw.limitId as string).trim() : fallbackId
    buckets.set(id, raw)
  }
  const primary = asRecord(root.rateLimits)
  const rawId = primary.limitId
  const primaryId = nonEmptyText(rawId) ? (rawId as string).trim() : null
  if (Object.keys(primary).length && !buckets.has(primaryId ?? 'codex')) {
    buckets.set(primaryId ?? 'codex', primary)
  }
  return { buckets, primaryId }
}

/** A bucket is provider-scoped only when it carries the frame's own limit id. */
function isProviderScope(limits: ResolvedLimits, limitId: string): boolean {
  return limitId === limits.primaryId || (limits.primaryId === null && limitId === 'codex')
}

/**
 * The explicit reach flag the normalizer folds out of every provider-scoped
 * bucket. It reads the resolved bucket, not the raw `rateLimits` object, so a
 * dictionary bucket that shadowed the primary id contributes its own flags.
 */
function explicitlyReached(limits: ResolvedLimits): boolean {
  for (const [limitId, bucket] of limits.buckets) {
    if (!isProviderScope(limits, limitId)) continue
    if (bucket.spendControlReached === true || nonEmptyText(bucket.rateLimitReachedType)) return true
  }
  return false
}

interface ExpectedWindow {
  readonly usedPercent: number | null
  readonly durationMinutes: number | null
  readonly resetsAt: string | null
}

/** The ISO timestamp the raw reset field asks for, or null when it names none. */
function expectedResetsAt(value: unknown): string | null {
  let milliseconds: number
  if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value
  } else if (typeof value === 'string' && value.trim()) {
    milliseconds = Date.parse(value)
  } else {
    return null
  }
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null
}

/**
 * Independently derive every field the payload asks each window to carry: a
 * window exists exactly when its raw entry is a non-empty object, an absent or
 * negative percentage stays null, a duration is kept only when it is positive
 * and finite, and the reset timestamp is the ISO form of the raw reset.
 * Comparing the normalized output with this map ties every emitted value back
 * to the generated input, so a normalizer that returned a constant or dropped
 * the reset would fail here rather than satisfy its own downstream arithmetic.
 */
function expectedWindows(limits: ResolvedLimits): Map<string, ExpectedWindow> {
  const expected = new Map<string, ExpectedWindow>()
  for (const [limitId, bucket] of limits.buckets) {
    for (const name of ['primary', 'secondary'] as const) {
      const raw = asRecord(bucket[name])
      if (!Object.keys(raw).length) continue
      const value = raw.usedPercent
      const duration = raw.windowDurationMins
      expected.set(`${limitId}:${name}`, {
        usedPercent: typeof value === 'number' && Number.isFinite(value) && value >= 0 ? roundPercent(value) : null,
        durationMinutes: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null,
        resetsAt: expectedResetsAt(raw.resetsAt)
      })
    }
  }
  return expected
}

type WindowRow = readonly [string, number | null, number | null, string | null]

const sortedEntries = (entries: Iterable<WindowRow>): readonly WindowRow[] =>
  [...entries].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))

// Mandatory probe: one limit id carried by both the dictionary and the primary
// bucket with distinguishable quotas. The primary bucket is insert-only, so the
// dictionary value must survive; an unconditional overwrite reports 88 and fails
// on every run rather than only when a generated draw happens to overlap.
const overlapExample = {
  payload: {
    rateLimits: { limitId: 'p3', primary: { usedPercent: 88 } },
    rateLimitsByLimitId: { p3: { limitId: 'p3', primary: { usedPercent: 11 } } }
  },
  observedAt: 1_000
}

// Mandatory probe: a dictionary bucket that shadows the frame's primary id and
// carries the reach flag, with no recognizable window anywhere. The frame reports
// the explicit reach, not the tri-state fold over an empty provider window list.
const reachedWithoutWindowsExample = {
  payload: {
    rateLimits: { limitId: 'p4' },
    rateLimitsByLimitId: { p4: { limitId: 'p4', rateLimitReachedType: 'p4' } }
  },
  observedAt: 2_000
}

// Both named and unnamed model buckets must keep their input-derived selector.
const modelScopeExample = {
  payload: {
    rateLimitsByLimitId: {
      d0: { limitName: 'model-name', primary: { usedPercent: 10 } },
      d1: { secondary: { usedPercent: 20 } }
    }
  },
  observedAt: 3_000
}

/** Mirrors telemetryLimitReached over the snapshot's own provider windows. */
function expectedLimitReached(reached: boolean, providerWindows: NonNullable<BartTelemetrySnapshot['windows']>): boolean | null {
  if (reached || providerWindows.some(window => window.exhausted === true)) return true
  if (!providerWindows.length) return null
  return providerWindows.some(window => window.exhausted === null) ? null : false
}

it('codex bart windows carry consistent percentages, unique ids and provider/model scopes', async () => {
  await checkAsync('codex bart windows carry consistent percentages, unique ids and provider/model scopes', fc.asyncProperty(
    fc.record({ payload: payloadArb, observedAt: fc.nat(2_000_000) }),
    async ({ payload, observedAt }) => {
      const snapshot: BartTelemetrySnapshot = normalizeCodexBartTelemetry(payload, observedAt)
      expect(snapshot.source).toBe(CODEX_USAGE_SOURCE)
      expect(snapshot.observedAt).toBe(observedAt)
      const windows = snapshot.windows ?? []
      // Availability is 'available' exactly when at least one window survived.
      expect(snapshot.availability === 'available').toBe(windows.length > 0)
      if (snapshot.availability === 'unknown') expect(snapshot.note).toBeTruthy()

      const ids = windows.map(window => window.id)
      expect(new Set(ids).size).toBe(ids.length)
      // Every emitted window, and only those, carries the percentage, duration
      // and reset timestamp the raw payload asked for: an all-zero normalizer
      // or one that dropped the reset fails on the first sample.
      const limits = resolveLimits(payload)
      const expected = [...expectedWindows(limits)].map(([id, window]) =>
        [id, window.usedPercent, window.durationMinutes, window.resetsAt] as const)
      expect(sortedEntries(windows.map(window =>
        [window.id, window.usedPercent, window.durationMinutes ?? null, window.resetsAt ?? null] as const)))
        .toEqual(sortedEntries(expected))
      const reached = explicitlyReached(limits)
      for (const window of windows) {
        expect(window.id).toMatch(/^[^:]*:(primary|secondary)$/)
        expect(window.label).toBeTruthy()
        expect(window.metering).toBe('token')
        const limitId = window.id.slice(0, window.id.lastIndexOf(':'))
        const scoped = isProviderScope(limits, limitId)
        expect(window.scope).toBe(scoped ? 'provider' : 'model')
        const limitName = limits.buckets.get(limitId)?.limitName
        const selector = nonEmptyText(limitName) ? (limitName as string).trim() : limitId
        expect(window.selector).toBe(scoped ? undefined : selector)
        if (window.durationMinutes !== undefined) expect(window.durationMinutes).toBeGreaterThan(0)

        const used = window.usedPercent
        if (used === null) {
          expect(window.remainingPercent).toBeNull()
          expect(window.exhausted).toBeNull()
          continue
        }
        // percentValue rounds to two decimals but never clamps: any finite
        // non-negative raw value must survive verbatim.
        expect(Number.isFinite(used)).toBe(true)
        expect(used).toBeGreaterThanOrEqual(0)
        expect(roundPercent(used)).toBe(used)
        expect(window.remainingPercent).toBe(roundPercent(Math.max(0, 100 - used)))
        expect(window.exhausted).toBe(used >= 100)
      }
      // Provider-wide exhaustion folds the provider windows and the explicit
      // reach flag into one tri-state; a frame with no recognizable window
      // reports an explicit provider-side reach instead of that fold.
      const providerWindows = windows.filter(window => window.scope === 'provider')
      const expectedLimit = windows.length
        ? expectedLimitReached(reached, providerWindows)
        : reached ? true : null
      expect(snapshot.limitReached ?? null).toBe(expectedLimit)
    }
  ), 'normalize each generated native rateLimits payload → assert availability, id uniqueness, scope/selector pairing, the percentage, duration and reset invariants and the limitReached fold on every window', budgetMs, samples, [[overlapExample], [reachedWithoutWindowsExample], [modelScopeExample]])
}, timeout)

it('codex bart telemetry fails closed on reader errors and unrecognizable payloads', async () => {
  await checkAsync('codex bart telemetry fails closed on reader errors and unrecognizable payloads', fc.asyncProperty(
    fc.record({
      garbage: fc.constantFrom<unknown>(null, 42, 'x', [], { unrelated: true }),
      failure: fc.constantFrom('throw', 'reject')
    }),
    async ({ garbage, failure }) => {
      const observedAt = 1_000
      const reader = async (): Promise<unknown> => {
        if (failure === 'throw') throw new Error('boom')
        return Promise.reject(new Error('async boom'))
      }
      const output = await createCodexBartTelemetryContributor({ readUsage: reader, now: () => observedAt })({
        signal: new AbortController().signal
      })
      expect(output).toBeDefined()
      const errored = JSON.parse(output!) as BartTelemetrySnapshot
      expect(errored.availability).toBe('error')
      expect(errored.windows).toEqual([])
      expect(errored.error ?? '').toContain('boom')

      const unavailable = normalizeCodexBartTelemetry(garbage, observedAt)
      // Garbage must never be reported as usable capacity.
      expect(unavailable.availability).not.toBe('available')
      expect(unavailable.windows ?? []).toEqual([])
      expect(unavailable.availability).toBe('unknown')
    }
  ), 'a rejecting usage reader → availability error with empty windows; a garbage payload → unknown, never available', budgetMs, samples)
}, timeout)
