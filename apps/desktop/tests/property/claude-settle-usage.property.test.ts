import fc from 'fast-check'
import { expect, it } from 'vitest'
import {
  type ClaudeTurn,
  type ClaudeUsage
} from '../../../../packages/harness-claude/src/shared/state'
import {
  appendTimelineText,
  applyClaudeUsageSample,
  recordClaudeActivity,
  recordClaudeInteraction,
  settleClaudeTurn,
  type ClaudeUsageProjection
} from '../../../../packages/harness-claude/src/main/thread/timeline'
import {
  claudeModelCostEvents,
  type ClaudeExecutionNativeEvent
} from '../../../../packages/harness-claude/src/main/runtime/transport'
import { checkAsync } from './check'

const timeout = process.env.FC_EXPLORE ? 130_000 : 35_000
// Pure in-memory accounting, so this family keeps the pure sample budget.
const samples = { normal: 100, explore: 1000 }

const activityKinds = ['command', 'file', 'tool', 'search', 'thinking', 'agent', 'task', 'hook', 'review', 'subagent'] as const
const activityStatuses = ['running', 'completed', 'failed', 'cancelled'] as const
const interactionStatuses = ['pending', 'allowed', 'denied', 'submitted', 'cancelled', 'resolved'] as const
const outcomes = ['completed', 'failed', 'interrupted'] as const

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

const outcomeStatus: Record<(typeof outcomes)[number], 'completed' | 'failed' | 'cancelled'> = {
  completed: 'completed',
  failed: 'failed',
  interrupted: 'cancelled'
}
// Assistant timeline text uses its own terminal vocabulary.
const outcomeTextStatus: Record<(typeof outcomes)[number], 'complete' | 'failed' | 'cancelled'> = {
  completed: 'complete',
  failed: 'failed',
  interrupted: 'cancelled'
}

// Only draw from a handful of ids so upserts, background exemptions and duplicate
// generation identifiers are common rather than astronomically rare.
const activityGen = fc.record({
  id: fc.integer({ min: 0, max: 2 }).map(n => `act-${n}`),
  kind: fc.constantFrom(...activityKinds),
  status: fc.constantFrom(...activityStatuses),
  taskId: fc.option(fc.constantFrom('task-1', 'task-2'), { nil: undefined })
})
const interactionGen = fc.record({
  id: fc.integer({ min: 0, max: 1 }).map(n => `int-${n}`),
  status: fc.constantFrom(...interactionStatuses)
})

const settleScenario = fc.record({
  activities: fc.array(activityGen, { maxLength: 5 }),
  interactions: fc.array(interactionGen, { maxLength: 4 }),
  streams: fc.array(fc.integer({ min: 1, max: 4 }).map(n => `stream-${n}`), { maxLength: 3 }),
  outcome: fc.constantFrom(...outcomes),
  backgroundTaskIds: fc.array(fc.constantFrom('act-0', 'act-1', 'act-2', 'task-1', 'task-2', 'bg-9'), { maxLength: 3 })
})

it('claude settle idempotence and terminalization hold under generated turns', async () => {
  await checkAsync('claude settle idempotence and terminalization hold under generated turns', fc.asyncProperty(
    settleScenario,
    async scenario => {
      const turn = emptyTurn(1_000)
      let at = 1_000
      scenario.activities.forEach(activity => {
        at += 1
        turn.updatedAt = at
        recordClaudeActivity(turn, {
          id: activity.id,
          kind: activity.kind,
          label: 'work',
          status: activity.status,
          ...(activity.taskId === undefined ? {} : { taskId: activity.taskId })
        }, at)
      })
      scenario.interactions.forEach(interaction => {
        at += 1
        turn.updatedAt = at
        recordClaudeInteraction(turn, {
          id: interaction.id,
          kind: 'permission',
          title: 'allow?',
          status: interaction.status
        }, at)
      })
      scenario.streams.forEach(streamId => {
        at += 1
        turn.updatedAt = at
        appendTimelineText(turn, 'assistant', `text for ${streamId}`, at, streamId)
      })
      const finishedAt = at + 1
      turn.updatedAt = finishedAt
      const pendingBefore = turn.interactions.filter(interaction => interaction.status === 'pending').map(({ id }) => id)
      const runningBefore = turn.activities.filter(activity => activity.status === 'running')
      const settled = new Set<string>(scenario.backgroundTaskIds)
      const expectedTerminal = runningBefore.filter(activity => !settled.has(activity.taskId || activity.id))

      settleClaudeTurn(turn, scenario.outcome, settled, finishedAt)
      expect(turn.finishedAt).toBe(finishedAt)
      expect(turn.status).toBe(scenario.outcome)
      expect(turn.statusLabel).toBeUndefined()
      // Running work outside the background set is terminalized; background work and
      // already-terminal activities are untouched.
      for (const activity of turn.activities) {
        if (!runningBefore.some(candidate => candidate.id === activity.id)) continue
        if (settled.has(activity.taskId || activity.id)) {
          expect(activity.status).toBe('running')
        } else {
          expect(activity.status).toBe(outcomeStatus[scenario.outcome])
        }
      }
      // Pending interactions are cancelled exactly once: no pending entity remains,
      // and the timeline carries exactly one settlement snapshot per pending id.
      expect(turn.interactions.filter(interaction => interaction.status === 'pending')).toEqual([])
      for (const id of pendingBefore) {
        expect(turn.interactions.find(interaction => interaction.id === id)?.status).toBe('cancelled')
        // Exactly one settlement snapshot per pending id; earlier history of the same
        // id may already carry a cancelled snapshot from a previous cycle.
        expect(turn.timeline.filter(item =>
          item.kind === 'interaction' && item.interaction.id === id && item.id.startsWith(`settled:${finishedAt}:interaction:`)
        )).toHaveLength(1)
      }
      expect(turn.timeline.filter(item => item.id.startsWith('settled:'))).toHaveLength(
        pendingBefore.length + expectedTerminal.length
      )
      for (const item of turn.timeline) {
        if (item.kind !== 'assistant') continue
        expect(item.status).not.toBe('streaming')
        if (scenario.streams.includes(item.messageId ?? '')) {
          expect(item.status).toBe(outcomeTextStatus[scenario.outcome])
        }
      }
      // A second settlement — different outcome, different background set — is a no-op.
      const frozen = JSON.stringify(turn)
      settleClaudeTurn(turn, scenario.outcome === 'completed' ? 'failed' : 'completed', new Set(['bg-other']), finishedAt + 5)
      expect(JSON.stringify(turn)).toBe(frozen)
      expect(turn.finishedAt).toBe(finishedAt)
    }
  ), 'build turn with generated activities/interactions/streams → settle once → settle again with different inputs → unchanged', undefined, samples)
}, timeout)

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

// Duplicated non-provisional generation ids and provisional/non-provisional kinds of
// both families in one sample: dedupe, provisional exclusion and kind scoping hold on
// every run instead of depending on a generated draw. Each example is the one-element
// tuple the property passes to its predicate.
const usageExamples: ReadonlyArray<[{ events: UsageEvent[] }]> = [[{
  events: [
    { kind: 'generation' as const, provisional: true, generationId: 'gen-1', usage: { inputTokens: 100 } },
    { kind: 'generation' as const, provisional: true, generationId: 'gen-1', usage: { inputTokens: 120 } },
    { kind: 'summary' as const, provisional: true, generationId: 'pending-summary', usage: { inputTokens: 3, costUsd: 99, contextWindow: 1000 } },
    { kind: 'generation' as const, provisional: false, generationId: 'gen-1', usage: { inputTokens: 150, costUsd: 0.2 } },
    { kind: 'generation' as const, provisional: false, generationId: 'gen-1', usage: { inputTokens: 1 } },
    { kind: 'summary' as const, provisional: false, generationId: 's1', usage: { costUsd: 0.5 } },
    { kind: 'summary' as const, provisional: false, generationId: 's1', usage: { costUsd: 0.25 } },
    // Carries a field outside the summary family's additive set: the settled
    // projection must hold no token field at all, so a summary sample that
    // leaks one into the ledger fails on the complete-object comparison.
    { kind: 'summary' as const, provisional: false, generationId: 's2', usage: { costUsd: 0.1, inputTokens: 7 } }
  ]
}]]

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
  ), 'drive generated usage samples through the production accounting seam → provisional snapshots stay visible-only → recorded generations sum exactly once', undefined, samples, usageExamples)
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

// A rollback (5 → 3) followed by regrowth (→ 4), a fresh model key that starts at
// zero and one negative cumulative: the emitted deltas must be the positive movements
// only, rebased on the last cumulative, and the negative snapshot is skipped.
const costExamples: ReadonlyArray<[{ usages: ModelUsageFrame['usage'][] }]> = [[{
  usages: [
    { 'claude-sonnet': { costUSD: 5 }, 'claude-opus': { costUSD: 2 } },
    { 'claude-sonnet': { costUSD: 3 } },
    { 'claude-sonnet': { costUSD: 4 }, 'claude-haiku': { costUSD: 0 } },
    { 'claude-haiku': { costUSD: -2 } }
  ]
}]]

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
  ), 'feed generated modelUsage frames through one persistent cost map → emitted deltas equal the independent positive-movement replay', undefined, samples, costExamples)
}, timeout)
