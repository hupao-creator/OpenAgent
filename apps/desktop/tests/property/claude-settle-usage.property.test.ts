import fc from 'fast-check'
import { expect, it } from 'vitest'
import {
  type ClaudeTurn,
  type ClaudeUsage
} from '../../../../packages/harness-claude/src/shared/state'
import { applyClaudeUsageSample, type ClaudeUsageProjection } from '../../../../packages/harness-claude/src/main/thread/timeline'
import {
  claudeModelCostEvents,
  type ClaudeExecutionNativeEvent
} from '../../../../packages/harness-claude/src/main/runtime/transport'
import { checkAsync } from './check'

const timeout = process.env.FC_EXPLORE ? 130_000 : 35_000
// Pure in-memory accounting, so this family keeps the pure sample budget.
const samples = { normal: 100, explore: 1000 }

function emptyTurn(at: number): ClaudeTurn {
  return {
    executionId: 'execution-property',
    createdAt: at,
    updatedAt: at,
    prompts: [],
    promptAttachments: [],
    text: '',
    reasoning: '',
    status: 'running',
    plan: [],
    activities: [],
    interactions: [],
    notices: [],
    timeline: []
  }
}

const usageGen: fc.Arbitrary<ClaudeUsage> = fc.record({
  inputTokens: fc.option(fc.nat(2_000), { nil: undefined }),
  outputTokens: fc.option(fc.nat(2_000), { nil: undefined }),
  reasoningTokens: fc.option(fc.nat(2_000), { nil: undefined }),
  cachedTokens: fc.option(fc.nat(2_000), { nil: undefined }),
  cacheWriteTokens: fc.option(fc.nat(2_000), { nil: undefined }),
  totalTokens: fc.option(fc.nat(4_000), { nil: undefined }),
  contextTokens: fc.option(fc.nat(4_000), { nil: undefined }),
  costUsd: fc.option(fc.nat(5_000).map(value => value / 100), { nil: undefined }),
  contextWindow: fc.option(fc.nat(1_000_000), { nil: undefined })
})

interface UsageEvent {
  kind: 'generation' | 'summary'
  provisional: boolean
  generationId: string
  usage: ClaudeUsage
}

function additiveKeys(kind: 'generation' | 'summary'): ReadonlyArray<keyof ClaudeUsage> {
  return kind === 'generation'
    ? ['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedTokens', 'cacheWriteTokens', 'totalTokens', 'contextTokens']
    : ['costUsd']
}

const usageEventGen: fc.Arbitrary<UsageEvent> = fc.record({
  kind: fc.constantFrom('generation', 'summary'),
  provisional: fc.boolean(),
  generationId: fc.constantFrom('gen-1', 'gen-2', 'gen-3'),
  usage: usageGen
})

it('claude usage merge ledger accounting sums additive keys once per generation', async () => {
  await checkAsync('claude usage merge ledger accounting sums additive keys once per generation', fc.asyncProperty(
    fc.record({ events: fc.array(usageEventGen, { maxLength: 10 }) }),
    async ({ events }) => {
      // Drive the production accounting seam itself — deduplication, the
      // provisional/settled split and the pending projection all live in
      // applyClaudeUsageSample, so removing its guard or admitting a
      // provisional sample to the recorded set fails here.
      const turn = emptyTurn(1_000)
      const recorded = new Set<string>()
      const projection: ClaudeUsageProjection = { settled: undefined, pending: new Map<string, ClaudeUsage>() }
      const expectedSettled: Record<string, number> = {}
      const expectedRecordedKeys = new Set<string>()
      const expectedPending = new Map<string, ClaudeUsage>()
      let at = 1_000
      for (const event of events) {
        at += 1
        // Advance the model from inputs before calling the production seam.
        const wasRecorded = expectedRecordedKeys.has(event.generationId)
        if (!wasRecorded) {
          if (event.provisional) {
            expectedPending.set(event.generationId, { ...event.usage })
          } else {
            expectedPending.delete(event.generationId)
            expectedRecordedKeys.add(event.generationId)
            for (const key of additiveKeys(event.kind)) {
              const value = event.usage[key]
              if (value !== undefined) expectedSettled[key] = (expectedSettled[key] ?? 0) + value
            }
            if (event.usage.contextWindow !== undefined) expectedSettled.contextWindow = event.usage.contextWindow
          }
        }
        const expectedVisible: Record<string, number> = { ...expectedSettled }
        for (const usage of expectedPending.values()) {
          for (const key of additiveKeys('generation')) {
            const value = usage[key]
            if (value !== undefined) expectedVisible[key] = (expectedVisible[key] ?? 0) + value
          }
          if (usage.contextWindow !== undefined) expectedVisible.contextWindow = usage.contextWindow
        }
        const isNewGeneration = applyClaudeUsageSample(turn, recorded, projection, {
          key: event.generationId,
          usage: event.usage,
          usageKind: event.kind,
          provisional: event.provisional
        }, at)
        expect(isNewGeneration).toBe(!wasRecorded && !event.provisional)
        expect([...recorded]).toEqual([...expectedRecordedKeys])
        expect([...projection.pending]).toEqual([...expectedPending])
        expect(projection.settled).toEqual(expectedRecordedKeys.size === 0 ? undefined : expectedSettled)
        // Check every prefix: settlement must not hide a lost provisional sample.
        expect(turn.usage).toEqual(expectedVisible)
        expect(turn.timeline.filter(item => item.kind === 'usage')).toHaveLength(expectedRecordedKeys.size)
      }
      if (events.length === 0) expect(turn.usage).toBeUndefined()
    }
  ), 'drive generated usage samples through the production accounting seam → provisional snapshots stay visible-only → recorded generations sum exactly once', undefined, samples)
}, timeout)

interface ModelUsageFrame {
  boundary: string
  usage: Record<string, { costUSD?: number; canonicalModel?: string }>
}

const modelKeys = ['claude-sonnet', 'claude-opus', 'claude-haiku'] as const
const costValue = fc.oneof(
  fc.nat(20_000).map(value => value / 100),
  fc.constant(-1),
  fc.constant(0)
)
const modelUsageGen: fc.Arbitrary<ModelUsageFrame['usage']> = fc.array(
  fc.record({
    key: fc.constantFrom(...modelKeys),
    entry: fc.record({
      costUSD: fc.option(costValue, { nil: undefined }),
      canonicalModel: fc.option(fc.constantFrom('canonical-a', 'canonical-b'), { nil: undefined })
    })
  }),
  { maxLength: 3 }
).map(entries => {
  const usage: ModelUsageFrame['usage'] = {}
  for (const { key, entry } of entries) usage[key] = entry
  return usage
})

it('claude model cost event deltas rebase on the last cumulative and never repeat a generation', async () => {
  await checkAsync('claude model cost event deltas rebase on the last cumulative and never repeat a generation', fc.asyncProperty(
    // Each result frame owns one boundary id, as the transport consumes a result's
    // user-message uuid exactly once, so generated boundaries are unique per sample.
    fc.record({ usages: fc.array(modelUsageGen, { maxLength: 4 }) }),
    async ({ usages }) => {
      const frames = usages.map((usage, index) => ({ boundary: `msg-${index}`, usage }))
      const costs = new Map<string, number>()
      const events: ClaudeExecutionNativeEvent[] = []
      for (const frame of frames) events.push(...claudeModelCostEvents(frame.usage, costs, frame.boundary))

      // Independent replay of the cumulative-per-key contract: every valid snapshot
      // rebases the stored cumulative even when its own delta is skipped, so the
      // emitted deltas are exactly the positive movements of the trajectory.
      const previous = new Map<string, number>()
      const expectedEvents: Array<{ generationId: string; model: string; costUsd: number }> = []
      const trajectories = new Map<string, number[]>()
      for (const frame of frames) {
        for (const [modelKey, rawUsage] of Object.entries(frame.usage)) {
          const cumulative = rawUsage.costUSD
          if (cumulative === undefined || cumulative < 0) continue
          const list = trajectories.get(modelKey) ?? []
          list.push(cumulative)
          trajectories.set(modelKey, list)
          const base = previous.get(modelKey) ?? 0
          previous.set(modelKey, cumulative)
          const delta = cumulative - base
          if (delta <= 0) continue
          expectedEvents.push({
            generationId: `${frame.boundary}:model-cost:${modelKey}`,
            model: rawUsage.canonicalModel || modelKey,
            costUsd: delta
          })
        }
      }
      for (const [modelKey, list] of trajectories) {
        // A never-decreasing trajectory bills exactly final minus initial. The
        // comparison is approximate: the model subtracts per frame while the
        // assertion adds emitted deltas, so IEEE754 rounding may differ by ~1e-13.
        if (list.every((value, index) => index === 0 || value >= list[index - 1]!)) {
          const keySum = expectedEvents
            .filter(event => event.generationId.endsWith(`:model-cost:${modelKey}`))
            .reduce((total, event) => total + event.costUsd, 0)
          expect(Math.abs(keySum - list[list.length - 1]!)).toBeLessThan(1e-9)
        }
      }
      for (const event of events) expect(event.type).toBe('usage')
      const actual = events.map(event => event.type === 'usage'
        ? { generationId: event.generationId, model: event.model, costUsd: event.usage.costUsd }
        : null)
      expect(actual).toEqual(expectedEvents)
      expect(new Set(actual.map(event => event?.generationId)).size).toBe(actual.length)
      for (const event of actual) expect(event?.costUsd).toBeGreaterThan(0)
    }
  ), 'feed generated modelUsage frames through one persistent cost map → emitted deltas equal the independent positive-movement replay', undefined, samples)
}, timeout)
