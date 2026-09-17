import fc from 'fast-check'
import { expect, it } from 'vitest'
import type { BartTelemetrySnapshot } from '@openagent/contracts'
import { normalizeClaudeBartTelemetry } from '../../../../packages/harness-claude/src/bart/usage'
import { check } from './check'

// Pure normalization of a native get_usage payload, so this family keeps the pure
// sample budget (the synchronous `check` helper already defaults to it).
const observedAt = 1_760_000_000_000

// Tagged raw values: the oracle knows each draw's validity without re-implementing
// the ISO formatting, so "recognized window" is decided independently of the parser.
const resetsAtGen = fc.oneof(
  fc.nat(2_000_000_000).map(raw => ({ raw: raw as unknown, valid: true })),
  fc.nat(2_000_000_000_000).map(raw => ({ raw: raw as unknown, valid: true })),
  fc.constant({ raw: '2026-09-13T00:00:00.000Z' as unknown, valid: true }),
  fc.constant({ raw: 'not-a-date' as unknown, valid: false }),
  fc.constant({ raw: undefined as unknown, valid: false }),
  fc.constant({ raw: null as unknown, valid: false })
)
// Non-negative finite numbers round to two decimals; everything else yields null.
const utilizationGen = fc.oneof(
  fc.nat(15_000).map(n => ({ raw: (n / 100) as unknown, used: Math.round((n / 100) * 100) / 100 as number | null })),
  fc.constant({ raw: -3 as unknown, used: null }),
  fc.constant({ raw: 'high' as unknown, used: null }),
  fc.constant({ raw: undefined as unknown, used: null }),
  fc.constant({ raw: Number.NaN as unknown, used: null })
)

// The window ids Claude actually reports, plus a case-variant and unknown shapes.
const windowIdPool = [
  'five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet',
  'seven_day_oauth_apps', 'seven_day_overage_included',
  'extra_usage', 'model_scoped', 'bonus_window', 'Five_Hour'
] as const
const windowLabels: Record<string, string> = {
  five_hour: '5-hour shared window',
  seven_day: '7-day shared window',
  seven_day_oauth_apps: '7-day OAuth apps window',
  seven_day_opus: '7-day Opus window',
  seven_day_sonnet: '7-day Sonnet window',
  seven_day_overage_included: '7-day overage-included window'
}
const modelDisplayNames = ['Claude Opus 4', 'claude-haiku', '  ', '!!!'] as const

interface RawEntry {
  value: unknown
  used: number | null
  resetsValid: boolean
}
const planEntryGen: fc.Arbitrary<RawEntry> = fc.oneof(
  fc.record({ utilization: utilizationGen, resets_at: resetsAtGen })
    .map(({ utilization, resets_at }) => ({ value: { utilization: utilization.raw, resets_at: resets_at.raw } as unknown, used: utilization.used, resetsValid: resets_at.valid })),
  fc.constant({ value: 'garbage' as unknown, used: null, resetsValid: false })
)

function scopeOf(id: string): 'model' | 'feature' | 'provider' {
  if (/(?:opus|sonnet|haiku|fable|model)/i.test(id)) return 'model'
  if (/(?:oauth|app|overage|extra)/i.test(id)) return 'feature'
  return 'provider'
}
function durationOf(id: string): number | null {
  if (/(?:^|_)five_hour(?:_|$)/i.test(id)) return 5 * 60
  if (/(?:^|_)seven_day(?:_|$)/i.test(id)) return 7 * 24 * 60
  return null
}
function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'usage window'
}
function normalizeIdentifier(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
function rounded(value: number): number {
  return Math.round(value * 100) / 100
}

const responseGen = fc.record({
  subscriptionType: fc.option(fc.constantFrom('pro', '  max  ', 'enterprise'), { nil: undefined }),
  rateLimitsAvailable: fc.option(fc.boolean(), { nil: undefined }),
  windows: fc.array(fc.record({ id: fc.constantFrom(...windowIdPool), entry: planEntryGen }), { maxLength: 5 }),
  modelScoped: fc.array(fc.record({
    displayName: fc.option(fc.constantFrom(...modelDisplayNames), { nil: undefined }),
    utilization: utilizationGen,
    resets_at: resetsAtGen
  }), { maxLength: 3 })
})

it('claude bart telemetry window invariants hold for every normalized window', () => {
  check('claude bart telemetry window invariants hold for every normalized window', fc.property(
    responseGen,
    ({ subscriptionType, rateLimitsAvailable, windows, modelScoped }) => {
      const rateLimits: Record<string, unknown> = {}
      // Mirrors object semantics: a repeated id keeps its first position but the
      // last value, which is exactly how the parser will iterate it.
      const topLevel = new Map<string, RawEntry>()
      for (const { id, entry } of windows) {
        rateLimits[id] = entry.value
        topLevel.set(id, entry)
      }
      const scopedEntries = modelScoped.map(({ displayName, utilization, resets_at }) => ({
        displayName,
        value: { display_name: displayName, utilization: utilization.raw, resets_at: resets_at.raw } as unknown,
        used: utilization.used,
        resetsValid: resets_at.valid
      }))
      if (modelScoped.length > 0) rateLimits.model_scoped = scopedEntries.map(entry => entry.value)

      const expected: Array<{
        id: string; label: string; scope: 'model' | 'feature' | 'provider'; selector?: string
        used: number | null; resetsValid: boolean; duration: number | null
      }> = []
      for (const [id, entry] of topLevel) {
        if (id === 'model_scoped' || id === 'extra_usage') continue
        if (typeof entry.value !== 'object' || entry.value === null) continue
        if (entry.used === null && !entry.resetsValid) continue
        const scope = scopeOf(id)
        expected.push({
          id,
          label: windowLabels[id] ?? humanize(id),
          scope,
          ...(scope === 'provider' ? {} : { selector: humanize(id.replace(/^seven_day_/, '').replace(/^five_hour_/, '')) }),
          used: entry.used,
          resetsValid: entry.resetsValid,
          duration: durationOf(id)
        })
      }
      for (const entry of scopedEntries) {
        const name = typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName : null
        const identifier = name === null ? null : normalizeIdentifier(name)
        if (!identifier) continue
        if (entry.used === null && !entry.resetsValid) continue
        expected.push({
          id: `model_scoped:${identifier}`,
          label: `${name} 7-day model window`,
          scope: 'model',
          selector: name!,
          used: entry.used,
          resetsValid: entry.resetsValid,
          duration: 7 * 24 * 60
        })
      }

      const snapshot = normalizeClaudeBartTelemetry({
        subscription_type: subscriptionType,
        ...(rateLimitsAvailable === undefined ? {} : { rate_limits_available: rateLimitsAvailable }),
        rate_limits: rateLimits
      }, observedAt)
      expect(snapshot.source).toBe('Claude Code get_usage')
      expect(snapshot.observedAt).toBe(observedAt)
      expect(snapshot.plan).toBe(subscriptionType === undefined ? null : subscriptionType.trim())
      if (rateLimitsAvailable === false) {
        // An explicitly non-plan session is not_applicable regardless of payload shape.
        expect(snapshot.availability).toBe('not_applicable')
        expect(snapshot.windows).toEqual([])
        return
      }
      expect(snapshot.windows ?? []).toHaveLength(expected.length)
      expect(snapshot.availability).toBe(expected.length > 0 ? 'available' : 'unknown')
      const output = snapshot.windows ?? []
      output.forEach((window, index) => {
        const want = expected[index]!
        expect(window.id).toBe(want.id)
        expect(window.label).toBe(want.label)
        expect(window.scope).toBe(want.scope)
        if (want.scope === 'provider') expect(window.selector).toBeUndefined()
        else expect(window.selector).toBe(want.selector)
        expect(window.usedPercent).toBe(want.used)
        const remaining = want.used === null ? null : rounded(Math.max(0, 100 - want.used))
        expect(window.remainingPercent).toBe(remaining)
        if (want.used !== null && want.used <= 100) {
          expect(Math.abs((window.usedPercent ?? 0) + (window.remainingPercent ?? 0) - 100)).toBeLessThan(1e-9)
        }
        expect(window.exhausted).toBe(want.used === null ? null : want.used >= 100)
        if (want.duration === null) expect(window.durationMinutes).toBeUndefined()
        else expect(window.durationMinutes).toBe(want.duration)
        expect(window.metering).toBe('token')
        if (want.resetsValid) expect(window.resetsAt).toMatch(/Z$/)
        else expect(window.resetsAt).toBeNull()
        if (window.pace !== undefined) {
          expect(window.usedPercent).not.toBeNull()
          expect(window.durationMinutes).toBeDefined()
          expect(window.resetsAt).not.toBeNull()
        }
      })
      if (snapshot.availability === 'available') {
        const provider = output.filter(window => window.scope === 'provider')
        expect(snapshot.limitReached).toBe(
          provider.some(window => window.exhausted === true) ? true
            : provider.length === 0 || provider.some(window => window.exhausted === null) ? null
              : false
        )
      }
      // Availability degradation never invents windows: unknown carries none and a note.
      if (snapshot.availability === 'unknown') {
        expect(output).toEqual([])
        expect(typeof snapshot.note).toBe('string')
      }
      const typedSnapshot: BartTelemetrySnapshot = snapshot
      expect(typedSnapshot.availability).not.toBe('error')
    }
  ))
})
