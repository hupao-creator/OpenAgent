import fc from 'fast-check'
import { expect, it } from 'vitest'
import type { AgentInput, JsonValue } from '@openagent/contracts'
import {
  appendCodexFollowUp,
  clearCodexNativeActivity,
  completeCodexBackgroundActivity,
  createEmptyCodexState,
  decodeCodexState,
  isCodexState,
  reduceCodexEvent,
  rejectCodexFollowUp,
  retireCodexBackgroundTerminals,
  settleCodexExecution,
  settleCodexOrphanedExecutions,
  stageCodexExecution,
  updateCodexBackgroundTerminals,
  updateCodexNativeActivity
} from '../../../../packages/harness-codex/src/shared/state'
import { codexSessionState } from '../../../../packages/harness-codex/src/shared/session-state'
import { mergeDeltaEvents } from '../../../../packages/harness-codex/src/main/thread/thread-handle'
import { joinCodexAssistantTexts } from '../../../../packages/harness-codex/src/shared/assistant-text'
import type {
  CodexBackgroundTerminal,
  CodexHarnessState,
  CodexInteraction,
  CodexInteractionQuestion,
  CodexNativeEvent,
  CodexTimelineItem,
  CodexTurn,
  CodexUsage
} from '../../../../packages/harness-codex/src/shared/types'
import { checkAsync } from './check'

const timeout = process.env.FC_EXPLORE ? 130_000 : 35_000
const budgetMs = process.env.FC_EXPLORE ? 120_000 : 10_000
// The three heaviest properties in this file keep the reduced tier; the rest use
// the pure sample budget directly.
const heavySamples = { normal: 50, explore: 500 }

// Persistence caps mirrored from packages/harness-codex/src/shared/state.ts
// (module-private there); they define the tail-truncation contract.
const MAX_TURNS = 200
const MAX_PLAN_STEPS = 200
const MAX_ANSWER = 256 * 1024
const MAX_REASONING = 64 * 1024
const MAX_DETAIL = 32 * 1024
const MAX_NOTICE = 16 * 1024

/**
 * The generated native-event domain mirrors what the app-server parser can
 * hand to the reducer after JSON decoding. Free text excludes NUL: the
 * validator refuses it on load and nothing in the native pipeline is expected
 * to write one into these fields, so samples stay inside the honest input
 * domain instead of reporting a generator artifact as a reducer failure.
 */
const text = fc.string({ maxLength: 16 }).map(value => value.replaceAll('\0', ''))
const ident = fc.integer({ min: 0, max: 1_000_000 }).map(value => `id${value.toString(36)}`)
const opt = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.option(arb, { nil: undefined })

/** Drop keys carrying undefined so generated values stay valid JSON (isJsonValue rejects undefined members). */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T
}

const fileArb = fc.record({
  id: ident,
  path: fc.constant('/property/file'),
  name: text,
  mimeType: fc.constantFrom('image/png', 'audio/wav', 'text/plain'),
  size: fc.nat(4096)
})
const inputArb: fc.Arbitrary<AgentInput> = fc.record({
  parts: fc.array(fc.oneof(
    fc.record({ kind: fc.constant('text' as const), text }),
    fc.record({ kind: fc.constant('mention' as const), name: ident, path: fc.constant('/property') }),
    fc.record({ kind: fc.constant('skill' as const), name: ident, path: fc.constant('/property') }),
    fc.record({ kind: fc.constant('image' as const), file: fileArb }),
    fc.record({ kind: fc.constant('audio-url' as const), url: ident })
  ), { minLength: 1, maxLength: 3 }),
  presentation: opt(fc.constantFrom('visible' as const, 'internal' as const))
}).map(compact)

const usageKeys = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'contextWindow'] as const
const usageArb: fc.Arbitrary<CodexUsage> = fc.nat(31).map(mask => {
  const usage: Record<string, number> = {}
  usageKeys.forEach((key, index) => {
    if (mask & (1 << index)) usage[key] = ((mask + 1) * 7919 + index) % 100_000
  })
  return usage
})

const activityKinds = ['command', 'file', 'tool', 'search', 'agent', 'subagent', 'review', 'hook'] as const
const activityArb = fc.record({
  id: ident,
  kind: fc.constantFrom(...activityKinds),
  label: text,
  status: fc.constantFrom('running', 'completed', 'failed', 'cancelled')
}).map(compact)

const questionArb: fc.Arbitrary<CodexInteractionQuestion> = fc.record({
  id: ident,
  header: opt(text),
  prompt: text,
  secret: fc.boolean(),
  allowOther: fc.boolean(),
  options: fc.array(fc.record({ id: ident, label: text, description: opt(text) }), { maxLength: 3 })
}).map(question => compact({ ...question, options: question.options.map(compact) }))

const ACTION_INTENTS = {
  'allow-once': 'allow',
  'allow-session': 'allow',
  deny: 'deny',
  cancel: 'cancel',
  submit: 'submit'
} as const
const ACTION_KEYS = Object.keys(ACTION_INTENTS) as readonly (keyof typeof ACTION_INTENTS)[]
const actionsArb = fc.array(fc.record({ id: fc.constantFrom(...ACTION_KEYS), label: text }), { maxLength: 4 })
  .map(actions => actions.map(action => ({ id: action.id, intent: ACTION_INTENTS[action.id], label: action.label })))

const interactionArb: fc.Arbitrary<CodexInteraction> = fc.oneof(
  fc.record({
    kind: fc.constantFrom('command-approval', 'file-approval', 'permissions', 'user-input'),
    id: ident,
    title: text,
    detail: opt(text),
    blocksTurn: fc.boolean(),
    resolution: opt(text),
    actions: actionsArb,
    questions: fc.array(questionArb, { maxLength: 2 })
  }).map(base => compact({ ...base, status: 'pending' as const })),
  // mcp-elicitation is a dependent shape: exactly one question carrying the form's questionId, or a URL with none.
  fc.record({ id: ident, title: text, blocksTurn: fc.boolean(), resolution: opt(text), actions: actionsArb, questionId: ident })
    .map(base => {
      // The native questionId lives only inside the elicitation payload; a
      // top-level key would leave the interaction outside the validator.
      const { questionId, ...rest } = base
      return compact({
        ...rest,
        kind: 'mcp-elicitation' as const,
        status: 'pending' as const,
        elicitation: {
          mode: 'form' as const,
          requestedSchema: { type: 'object', properties: { a: { type: 'string' } } },
          questionId
        },
        questions: [{ id: questionId, prompt: 'JSON form values', secret: false, allowOther: true, options: [] }]
      })
    }),
  fc.record({ id: ident, title: text, blocksTurn: fc.boolean(), resolution: opt(text), actions: actionsArb })
    .map(base => compact({
      ...base,
      kind: 'mcp-elicitation' as const,
      status: 'pending' as const,
      elicitation: { mode: 'url' as const, url: `https://${base.id}.example` },
      questions: []
    }))
)

const nativeEventArb: fc.Arbitrary<CodexNativeEvent> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ type: fc.constant('text-delta' as const), itemId: ident, delta: text }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('text-final' as const), itemId: ident, text, displayText: opt(text) }).map(compact) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('reasoning-delta' as const), delta: text }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('status' as const), label: opt(text) }).map(compact) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('runtime-model' as const), model: ident }) },
  {
    weight: 1,
    // Up to 230 steps: the reducer must slice the plan to the persisted cap itself.
    arbitrary: fc.record({
      type: fc.constant('plan' as const),
      steps: fc.array(fc.record({ step: text, status: fc.constantFrom('pending', 'inProgress', 'completed') }), { maxLength: 230 }),
      explanation: opt(text)
    }).map(compact)
  },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('diff' as const), diff: text }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('review' as const), review: text }) },
  { weight: 1, arbitrary: fc.constant({ type: 'context-compacted' as const }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('activity-start' as const), activity: activityArb }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('activity-update' as const), activityId: ident, detail: text }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('activity-end' as const), activityId: ident, status: fc.constantFrom('completed', 'failed', 'cancelled'), detail: opt(text) }).map(compact) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('interaction-opened' as const), interaction: interactionArb }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('interaction-closed' as const), interactionId: ident, resolution: fc.constantFrom('accept', 'acceptForSession', 'turn', 'session', 'submit', 'cancel', 'decline', 'other') }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('usage' as const), usage: usageArb }) },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant('generation-usage' as const),
      nativeSessionId: ident,
      generationId: ident,
      model: ident,
      usage: fc.record({ inputTokens: fc.nat(1000), outputTokens: fc.nat(1000) })
    })
  },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('warning' as const), message: text }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('error' as const), message: text }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('done' as const), outcome: fc.constantFrom('completed', 'failed', 'interrupted') }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('session' as const), sessionId: ident }) }
)

const atDelta = fc.nat(40)

type Step =
  | { readonly op: 'event'; readonly event: CodexNativeEvent; readonly generatedId: string; readonly atDelta: number }
  | { readonly op: 'follow-up'; readonly input: AgentInput; readonly messageId: string; readonly atDelta: number }
  | { readonly op: 'reject'; readonly message: string; readonly noticeId: string; readonly atDelta: number }
  | { readonly op: 'native-activity'; readonly status: string; readonly detail?: string; readonly atDelta: number }
  | { readonly op: 'clear-native-activity'; readonly atDelta: number }
  | { readonly op: 'background-terminals'; readonly terminals: readonly CodexBackgroundTerminal[]; readonly atDelta: number }
  | { readonly op: 'complete-background'; readonly activityId: string; readonly status: 'completed' | 'failed' | 'cancelled'; readonly detail?: string; readonly atDelta: number }
  | { readonly op: 'retire'; readonly atDelta: number }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 10, arbitrary: fc.record({ op: fc.constant('event' as const), event: nativeEventArb, generatedId: ident, atDelta }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('follow-up' as const), input: inputArb, messageId: ident, atDelta }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('reject' as const), message: text, noticeId: ident, atDelta }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('native-activity' as const), status: text, detail: opt(text), atDelta }).map(compact) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('clear-native-activity' as const), atDelta }) },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('background-terminals' as const),
      terminals: fc.array(fc.record({ id: ident, command: text, cwd: text }), { maxLength: 3 }),
      atDelta
    })
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('complete-background' as const), activityId: ident, status: fc.constantFrom('completed', 'failed', 'cancelled'), detail: opt(text), atDelta }).map(compact) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('retire' as const), atDelta }) }
)

type Terminal =
  | { readonly kind: 'settle'; readonly outcome: 'completed' | 'failed' | 'interrupted'; readonly error?: string }
  | { readonly kind: 'orphan'; readonly error: string }

const terminalArb: fc.Arbitrary<Terminal> = fc.oneof(
  fc.record({ kind: fc.constant('settle' as const), outcome: fc.constantFrom('completed', 'failed', 'interrupted'), error: opt(text) }).map(compact),
  fc.record({ kind: fc.constant('orphan' as const), error: text })
)

interface Round {
  readonly executionId: string
  readonly input: AgentInput
  readonly messageId: string
  readonly atDelta: number
  readonly steps: readonly Step[]
}

const roundArb: fc.Arbitrary<Round & { readonly terminal: Terminal }> = fc.record({
  executionId: ident,
  input: inputArb,
  messageId: ident,
  atDelta,
  steps: fc.array(stepArb, { maxLength: 8 }),
  terminal: terminalArb
})

interface Scenario {
  readonly seedAt: number
  readonly rounds: readonly (Round & { readonly terminal: Terminal })[]
  readonly finalRound?: Round
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  seedAt: fc.nat(2_000),
  rounds: fc.array(roundArb, { maxLength: 4 }),
  finalRound: opt(fc.record({
    executionId: ident,
    input: inputArb,
    messageId: ident,
    atDelta,
    steps: fc.array(stepArb, { maxLength: 8 })
  }))
}).map(compact) as fc.Arbitrary<Scenario>

// Generated plans stay well inside the persisted cap, so this example is
// mandatory: it drives the reducer's 200-step head-keeping slice on every run.
const planCapExamples: readonly [Scenario][] = [[{
  seedAt: 0,
  rounds: [{
    executionId: 'exec-plan-cap',
    input: { parts: [{ kind: 'text', text: 'plan probe' }] },
    messageId: 'msg-plan-cap',
    atDelta: 0,
    steps: [{
      op: 'event',
      event: {
        type: 'plan',
        steps: Array.from({ length: MAX_PLAN_STEPS + 30 }, (_, index) => ({ step: `step ${index}`, status: 'pending' as const }))
      },
      generatedId: 'gen-plan-cap',
      atDelta: 0
    }],
    terminal: { kind: 'settle', outcome: 'completed' }
  }]
}]]

/**
 * Native traffic names the entities it closes: a generated draw cannot be
 * relied on to pair a close with its open, and the oracle's close assertions
 * only read a real entity. This example stages one running activity, one
 * pending blocking interaction and one session binding on every run — each
 * closed by the event that follows it — so terminalizing, resolving, binding
 * and the waiting-input → running resume of the last blocker are checked
 * deterministically rather than only when the generator happens to correlate.
 */
const entityLifecycleExamples: readonly [Scenario][] = [[{
  seedAt: 0,
  rounds: [{
    executionId: 'exec-entity-lifecycle',
    input: { parts: [{ kind: 'text', text: 'entity lifecycle probe' }] },
    messageId: 'msg-entity-lifecycle',
    atDelta: 0,
    steps: [
      {
        op: 'event',
        event: {
          type: 'activity-start',
          activity: { id: 'act-probe', kind: 'command', label: 'probe', status: 'running' }
        },
        generatedId: 'gen-activity-start',
        atDelta: 0
      },
      {
        op: 'event',
        event: { type: 'activity-update', activityId: 'act-probe', detail: 'progress' },
        generatedId: 'gen-activity-update',
        atDelta: 0
      },
      {
        op: 'event',
        event: { type: 'activity-end', activityId: 'act-probe', status: 'completed' },
        generatedId: 'gen-activity-end',
        atDelta: 1
      },
      {
        op: 'event',
        event: {
          type: 'interaction-opened',
          interaction: {
            kind: 'command-approval',
            id: 'int-probe',
            title: 'probe',
            blocksTurn: true,
            status: 'pending',
            actions: [{ id: 'deny', intent: 'deny', label: 'deny' }],
            questions: []
          }
        },
        generatedId: 'gen-interaction-open',
        atDelta: 1
      },
      {
        op: 'event',
        event: { type: 'interaction-closed', interactionId: 'int-probe', resolution: 'accept' },
        generatedId: 'gen-interaction-close',
        atDelta: 1
      },
      {
        op: 'event',
        event: { type: 'session', sessionId: 'sess-probe' },
        generatedId: 'gen-session',
        atDelta: 1
      }
    ],
    terminal: { kind: 'settle', outcome: 'completed' }
  }]
}]]

const resolutionExamples: readonly [Scenario][] = [
  'accept', 'acceptForSession', 'turn', 'session', 'submit', 'cancel', 'decline', 'other'
].map(resolution => [{
  ...entityLifecycleExamples[0]![0],
  rounds: entityLifecycleExamples[0]![0].rounds.map(round => ({
    ...round,
    steps: round.steps.map(step => step.op === 'event' && step.event.type === 'interaction-closed'
      ? { ...step, event: { ...step.event, resolution } }
      : step)
  }))
}])

const outcomeExamples: readonly [Scenario][] = (['completed', 'failed', 'interrupted'] as const).map(outcome => [{
  seedAt: 0,
  rounds: [{
    executionId: 'exec-outcome',
    input: { parts: [{ kind: 'text', text: 'settlement probe' }] },
    messageId: 'msg-outcome',
    atDelta: 0,
    steps: [
      { op: 'event', event: { type: 'text-delta', itemId: 'item-stream', delta: 'answer' }, generatedId: 'gen-text', atDelta: 0 },
      { op: 'event', event: { type: 'done', outcome }, generatedId: 'gen-done', atDelta: 0 }
    ],
    terminal: { kind: 'settle', outcome }
  }]
}])

const nativeExamples: readonly [Scenario][] = [...planCapExamples, ...resolutionExamples, ...outcomeExamples]

/**
 * Real native traffic names entities that exist: the event that ends an
 * activity or closes an interaction follows the one that opened it. The
 * generator cannot know the model, so the driver points a close or progress
 * event at the matching live entity whenever the turn has one — otherwise the
 * oracle's close assertions are vacuous on most samples — and leaves the
 * generated id in place when it has none, so the unknown-entity path stays
 * covered.
 */
function retargetAtLiveEntity(
  state: CodexHarnessState,
  executionId: string,
  event: CodexNativeEvent
): CodexNativeEvent {
  const turn = state.turns.find(candidate => candidate.executionId === executionId && isActive(candidate))
  if (!turn) return event
  if (event.type === 'activity-end' || event.type === 'activity-update') {
    const live = turn.activities.find(activity => activity.status === 'running')
    return live ? { ...event, activityId: live.id } : event
  }
  if (event.type === 'interaction-closed') {
    const pending = turn.interactions.find(interaction => interaction.status === 'pending')
    return pending ? { ...event, interactionId: pending.id } : event
  }
  return event
}

const isActive = (turn: CodexTurn): boolean => turn.status === 'running' || turn.status === 'waiting-input'
const isTerminal = (turn: CodexTurn): boolean => !isActive(turn)

function timelineReference(item: CodexTimelineItem): string | undefined {
  switch (item.kind) {
    case 'user-message': return item.messageId
    case 'activity': return item.activityId
    case 'interaction': return item.interactionId
    case 'notice': return item.noticeId
    default: return undefined
  }
}

function assertTimelineInvariants(state: CodexHarnessState): void {
  for (const turn of state.turns) {
    const ids = turn.timeline.map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    const references = turn.timeline
      .map(item => {
        const reference = timelineReference(item)
        return reference === undefined ? undefined : `${item.kind}:${reference}`
      })
      .filter((entry): entry is string => entry !== undefined)
    expect(new Set(references).size).toBe(references.length)
    for (const kind of ['plan', 'diff', 'review', 'error'] as const) {
      expect(turn.timeline.filter(item => item.kind === kind).length).toBeLessThanOrEqual(1)
    }
  }
}

/** Mirrors the persistence suffix rule in state.ts (`…\n` + the last max - 2 characters). */
function persistedTail(value: string, max: number): string {
  return value.length > max ? `…\n${value.slice(-max + 2)}` : value
}

const assistantItems = (turn: CodexTurn): readonly Extract<CodexTimelineItem, { kind: 'assistant' }>[] =>
  turn.timeline.filter(
    (item): item is Extract<CodexTimelineItem, { kind: 'assistant' }> => item.kind === 'assistant'
  )

/** The answer is the reducer's join of every assistant item's retained content. */
function expectedAnswer(turn: CodexTurn): string {
  return persistedTail(
    joinCodexAssistantTexts(assistantItems(turn).flatMap(item => (item.content ? [item.content] : []))),
    MAX_ANSWER
  )
}

/**
 * Model-based oracle for one event: the expected effect is derived from the
 * pre-state and the event alone, so a reducer that ignores a branch — or
 * returns the prior state, which the generic checks above cannot see because
 * they skip monotonicity for an identical object — fails here instead of
 * passing. Only the fields the event owns are pinned; unrelated fields are
 * left to the invariant checks.
 */
function assertEventEffect(
  before: CodexHarnessState,
  after: CodexHarnessState,
  event: CodexNativeEvent,
  executionId: string,
  generatedId: string,
  at: number
): void {
  // The reducer maps the first *active* turn with this execution id and replaces
  // it in place; an execution id staged again after settling must not be read
  // from the terminal round that shares it.
  const index = before.turns.findIndex(turn => turn.executionId === executionId && isActive(turn))
  expect(index).toBeGreaterThanOrEqual(0)
  const turnBefore = before.turns[index]
  const turnAfter = after.turns[index]
  expect(turnBefore).toBeDefined()
  expect(turnAfter).toBeDefined()
  if (!turnBefore || !turnAfter) return
  switch (event.type) {
    case 'status': {
      // A status event with no label keeps the label already on screen.
      expect(turnAfter.statusLabel).toEqual(event.label ?? turnBefore.statusLabel)
      expect(turnAfter.status).toBe(turnBefore.status)
      return
    }
    case 'runtime-model': {
      expect(turnAfter.runtimeModel).toBe(event.model)
      return
    }
    case 'text-delta': {
      const existing = assistantItems(turnBefore).find(item => item.itemId === event.itemId)
      if (existing && existing.status !== 'streaming') {
        // A replayed late delta cannot change a finalized native message.
        expect(turnAfter.answer).toBe(turnBefore.answer)
        return
      }
      const item = assistantItems(turnAfter).find(candidate => candidate.itemId === event.itemId)
      expect(item?.status).toBe('streaming')
      expect(item?.content).toBe(persistedTail((existing?.content ?? '') + event.delta, MAX_ANSWER))
      expect(turnAfter.answer).toBe(expectedAnswer(turnAfter))
      return
    }
    case 'text-final': {
      const item = assistantItems(turnAfter).find(candidate => candidate.itemId === event.itemId)
      expect(item?.status).toBe('complete')
      expect(item?.content).toBe(persistedTail(event.text, MAX_ANSWER))
      expect(turnAfter.answer).toBe(expectedAnswer(turnAfter))
      return
    }
    case 'reasoning-delta': {
      expect(turnAfter.reasoning).toBe(persistedTail(turnBefore.reasoning + event.delta, MAX_REASONING))
      return
    }
    case 'plan': {
      expect(turnAfter.plan).toEqual(event.steps.slice(0, MAX_PLAN_STEPS))
      expect(turnAfter.planExplanation).toEqual(
        event.explanation ? persistedTail(event.explanation, MAX_DETAIL) : undefined
      )
      return
    }
    case 'diff': {
      expect(turnAfter.diff).toBe(persistedTail(event.diff, MAX_ANSWER))
      return
    }
    case 'review': {
      expect(turnAfter.review).toBe(persistedTail(event.review, MAX_ANSWER))
      return
    }
    case 'context-compacted': {
      expect(turnAfter.contextCompacted).toBe(true)
      return
    }
    case 'activity-start': {
      const existing = turnBefore.activities.find(candidate => candidate.id === event.activity.id)
      const activity = turnAfter.activities.find(candidate => candidate.id === event.activity.id)
      expect(activity?.status).toBe(existing ? existing.status : 'running')
      expect(activity?.label).toBe(persistedTail(event.activity.label, MAX_DETAIL))
      return
    }
    case 'activity-update': {
      // Native progress mixes raw tool input with user-visible progress and is
      // deliberately not persisted.
      expect(turnAfter.activities).toEqual(turnBefore.activities)
      expect(turnAfter.updatedAt).toBe(Math.max(before.updatedAt + 1, Math.trunc(at)))
      return
    }
    case 'activity-end': {
      const existing = turnBefore.activities.find(candidate => candidate.id === event.activityId)
      const activity = turnAfter.activities.find(candidate => candidate.id === event.activityId)
      if (existing) {
        expect(activity).toBeDefined()
        expect(activity?.status).toBe(event.status)
        expect(activity?.detail).toBe(existing.kind === 'command' && event.detail
          ? persistedTail(event.detail, MAX_DETAIL)
          : undefined)
      } else {
        expect(turnAfter.activities).toEqual(turnBefore.activities)
      }
      return
    }
    case 'interaction-opened': {
      const interaction = turnAfter.interactions.find(candidate => candidate.id === event.interaction.id)
      expect(interaction?.status).toBe('pending')
      if (event.interaction.blocksTurn) expect(turnAfter.status).toBe('waiting-input')
      return
    }
    case 'interaction-closed': {
      const existing = turnBefore.interactions.find(candidate => candidate.id === event.interactionId)
      const interaction = turnAfter.interactions.find(candidate => candidate.id === event.interactionId)
      if (existing) {
        const statuses: Readonly<Record<string, CodexInteraction['status']>> = {
          accept: 'allowed', acceptForSession: 'allowed', turn: 'allowed', session: 'allowed',
          submit: 'submitted', cancel: 'cancelled', decline: 'denied'
        }
        expect(interaction?.status).toBe(statuses[event.resolution.trim()] ?? 'resolved')
        expect(interaction?.resolution).toBe(persistedTail(event.resolution, 1_000))
      } else {
        expect(turnAfter.interactions).toEqual(turnBefore.interactions)
      }
      // A waiting turn only leaves waiting-input when nothing pending still blocks
      // it: closing the last blocker resumes the turn, closing one of several
      // leaves it waiting. Deriving the expectation from the pre-state and the
      // closed id keeps a dropped transition visible.
      if (turnBefore.status === 'waiting-input') {
        const stillBlocked = turnBefore.interactions.some(
          candidate => candidate.id !== event.interactionId && candidate.status === 'pending' && candidate.blocksTurn
        )
        expect(turnAfter.status).toBe(stillBlocked ? 'waiting-input' : 'running')
        expect(turnAfter.statusLabel).toBe(stillBlocked ? '等待你的输入' : '正在工作')
      } else {
        expect(turnAfter.status).toBe(turnBefore.status)
      }
      return
    }
    case 'usage': {
      expect(turnAfter.usage).toEqual(event.usage)
      return
    }
    case 'generation-usage': {
      // Telemetry-only: never enters Plugin persistence.
      expect(turnAfter).toEqual(turnBefore)
      return
    }
    case 'warning': {
      expect(turnAfter.notices.at(-1)).toEqual({
        id: generatedId,
        level: 'warning',
        message: persistedTail(event.message, MAX_NOTICE)
      })
      return
    }
    case 'error': {
      expect(turnAfter.error).toBe(persistedTail(event.message, MAX_NOTICE))
      expect(turnAfter.notices.at(-1)).toMatchObject({ id: generatedId, level: 'error' })
      return
    }
    case 'done': {
      expect(turnAfter.status).toBe(event.outcome)
      expect(turnAfter.finishedAt).toBeDefined()
      expect(turnAfter.interactions.filter(interaction => interaction.status === 'pending')).toEqual([])
      expect(assistantItems(turnAfter).some(item => item.status === 'streaming')).toBe(false)
      const textStatus = { completed: 'complete', failed: 'failed', interrupted: 'cancelled' } as const
      expect(assistantItems(turnAfter)).toEqual(assistantItems(turnBefore).map(item =>
        item.status === 'streaming' ? { ...item, status: textStatus[event.outcome] } : item
      ))
      return
    }
    default: {
      return
    }
  }
}

it('codex persisted state stays valid, monotone and reference-unique under generated native runs', async () => {
  await checkAsync('codex persisted state stays valid, monotone and reference-unique under generated native runs', fc.asyncProperty(
    scenarioArb,
    async scenario => {
      let state = createEmptyCodexState(scenario.seedAt)
      let at = scenario.seedAt

      const observe = (next: CodexHarnessState): void => {
        expect(isCodexState(next)).toBe(true)
        if (next !== state) expect(next.updatedAt).toBeGreaterThan(state.updatedAt)
        expect(next.turns.length).toBeLessThanOrEqual(MAX_TURNS)
        assertTimelineInvariants(next)
        // The persisted form round-trips exactly through the loading API.
        expect(decodeCodexState(JSON.parse(JSON.stringify(next)) as JsonValue)).toEqual(next)
        // The public projection accepts every intermediate state.
        expect(() => codexSessionState.project(JSON.parse(JSON.stringify(next)) as JsonValue)).not.toThrow()
        state = next
      }

      const activeExecutionId = (): string | undefined =>
        state.turns.find(isActive)?.executionId

      const applyStep = (step: Step): void => {
        at += step.atDelta
        if (step.op === 'event') {
          if (step.event.type === 'session') {
            // A conflicting Primary Session binding is refused by the reducer;
            // the driver mirrors that by never issuing one.
            if (!state.primarySessionId || state.primarySessionId === step.event.sessionId) {
              const next = reduceCodexEvent(state, '', step.event, at, step.generatedId)
              // The binding is this event's only observable effect, and `observe`
              // skips monotonicity when the reducer returns the prior object, so
              // compare it here rather than leaving it to the generic checks.
              expect(next.primarySessionId).toBe(step.event.sessionId)
              observe(next)
            }
            return
          }
          const executionId = activeExecutionId()
          // Native traffic after the terminal fact is dropped by the driver.
          if (executionId) {
            const before = state
            const event = retargetAtLiveEntity(before, executionId, step.event)
            const next = reduceCodexEvent(state, executionId, event, at, step.generatedId)
            assertEventEffect(before, next, event, executionId, step.generatedId, at)
            observe(next)
          }
          return
        }
        if (step.op === 'follow-up') {
          const executionId = activeExecutionId()
          if (executionId) observe(appendCodexFollowUp(state, executionId, step.input, at, step.messageId))
          return
        }
        if (step.op === 'reject') {
          const executionId = activeExecutionId()
          if (executionId) observe(rejectCodexFollowUp(state, executionId, step.message, at, step.noticeId))
          return
        }
        if (step.op === 'native-activity') {
          observe(updateCodexNativeActivity(state, step.status, step.detail, at))
          return
        }
        if (step.op === 'clear-native-activity') {
          observe(clearCodexNativeActivity(state, at))
          return
        }
        if (step.op === 'background-terminals') {
          observe(updateCodexBackgroundTerminals(state, step.terminals, at))
          expect(state.backgroundTerminals).toEqual(step.terminals)
          return
        }
        if (step.op === 'complete-background') {
          const before = state
          const turnIndex = before.turns.findLastIndex(turn =>
            turn.activities.some(activity =>
              activity.id === step.activityId &&
              (activity.status === 'running' || activity.status === 'cancelled')))
          const next = completeCodexBackgroundActivity(state, step.activityId, step.status, step.detail, at)
          if (turnIndex >= 0) {
            const previous = before.turns[turnIndex]!.activities.find(activity => activity.id === step.activityId)!
            const updated = next.turns[turnIndex]!.activities.find(activity => activity.id === step.activityId)!
            expect(updated.status).toBe(step.status)
            expect(updated.detail).toBe(step.detail === undefined ? previous.detail : step.detail)
          } else {
            expect(next).toBe(before)
          }
          observe(next)
          return
        }
        // retire
        const next = retireCodexBackgroundTerminals(state, at)
        expect(next.backgroundTerminals).toEqual([])
        for (const turn of next.turns) {
          if (isTerminal(turn)) {
            expect(turn.activities.some(activity => activity.status === 'running')).toBe(false)
          }
        }
        observe(next)
      }

      const assertSettledIdempotence = (executionId: string): void => {
        const outcome = 'interrupted' as const
        // The raw reducer refuses a second settle of a terminal turn; the
        // session adapter is the idempotent seam Core actually drives.
        expect(() => settleCodexExecution(state, executionId, outcome, at)).toThrow()
        const json = JSON.parse(JSON.stringify(state)) as JsonValue
        const once = codexSessionState.settle({ sessionState: json, executionId, outcome, finishedAt: at })
        expect(once).toEqual(json)
        const twice = codexSessionState.settle({ sessionState: once, executionId, outcome, finishedAt: at })
        expect(twice).toEqual(once)
        expect(settleCodexOrphanedExecutions(state, at, 'late failure')).toBe(state)
      }

      for (const round of scenario.rounds) {
        at += round.atDelta
        observe(stageCodexExecution(state, round.executionId, round.input, at, round.messageId))
        for (const step of round.steps) applyStep(step)
        at += 1
        if (round.terminal.kind === 'orphan') {
          observe(settleCodexOrphanedExecutions(state, at, round.terminal.error))
        } else if (state.turns.find(turn => turn.executionId === round.executionId && isActive(turn))) {
          observe(settleCodexExecution(state, round.executionId, round.terminal.outcome, at, round.terminal.error))
        }
        if (!state.turns.some(isActive)) assertSettledIdempotence(round.executionId)
      }

      const final = scenario.finalRound
      if (final) {
        at += final.atDelta
        observe(stageCodexExecution(state, final.executionId, final.input, at, final.messageId))
        for (const step of final.steps) applyStep(step)
        // The round stays live: the adapter must settle it idempotently.
        const json = JSON.parse(JSON.stringify(state)) as JsonValue
        const once = codexSessionState.settle({ sessionState: json, executionId: final.executionId, outcome: 'interrupted', finishedAt: at })
        const twice = codexSessionState.settle({ sessionState: once, executionId: final.executionId, outcome: 'interrupted', finishedAt: at })
        expect(twice).toEqual(once)
      }

      // Projection: latestExecution exists exactly when a turn exists, the
      // background-work flag mirrors its rule, and resolveExecution agrees
      // with projecting the turn's own single-turn slice.
      const json = JSON.parse(JSON.stringify(state)) as JsonValue
      const observation = codexSessionState.project(json)
      expect(observation.latestExecution === null).toBe(state.turns.length === 0)
      expect(observation.backgroundWork !== null).toBe(
        state.backgroundTerminals.length > 0 ||
        state.turns.some(turn => isTerminal(turn) && turn.activities.some(activity => activity.status === 'running'))
      )
      const turns = (json as Record<string, unknown>).turns as unknown as readonly CodexTurn[]
      turns.forEach((turn, index) => {
        if (turns.findIndex(candidate => candidate.executionId === turn.executionId) !== index) return
        const single = JSON.parse(JSON.stringify({ ...(json as Record<string, unknown>), turns: [turn] })) as JsonValue
        expect(codexSessionState.resolveExecution(json, turn.executionId))
          .toEqual(codexSessionState.project(single).latestExecution)
      })
    }
  ), 'stage each generated execution → apply generated native events and state operations in order → assert the per-event expected effect, then validator, monotone time, timeline uniqueness, JSON round trip and projection at every step', budgetMs, heavySamples, nativeExamples)
}, timeout)

it('codex turns truncate to the last 200 and every retained turn keeps its own prompt', async () => {
  await checkAsync('codex turns truncate to the last 200 and every retained turn keeps its own prompt', fc.asyncProperty(
    fc.record({ seedAt: fc.nat(1_000), extra: fc.nat(30), atDelta: fc.nat(40) }),
    async ({ seedAt, extra, atDelta }) => {
      const total = MAX_TURNS + 1 + extra
      const inputFor = (index: number): AgentInput => ({ parts: [{ kind: 'text', text: `message ${index}` }] })
      let state = createEmptyCodexState(seedAt)
      for (let index = 0; index < total; index += 1) {
        const at = seedAt + index * (atDelta + 1)
        state = stageCodexExecution(state, `exec-${index}`, inputFor(index), at, `msg-${index}`)
        state = settleCodexExecution(state, `exec-${index}`, 'completed', at + atDelta)
      }
      expect(state.turns).toHaveLength(MAX_TURNS)
      state.turns.forEach((turn, index) => {
        const source = total - MAX_TURNS + index
        // The slice keeps the tail: the oldest turns leave, the newest survive intact.
        expect(turn.executionId).toBe(`exec-${source}`)
        expect(turn.messages[0]?.content).toBe(`message ${source}`)
        expect(turn.status).toBe('completed')
      })
      expect(isCodexState(state)).toBe(true)
      expect(decodeCodexState(JSON.parse(JSON.stringify(state)) as JsonValue)).toEqual(state)
    }
  ), `${MAX_TURNS + 1}..231 stage/settle rounds → assert the retained window is exactly the newest ${MAX_TURNS} turns with their own prompts`, budgetMs, { normal: 30, explore: 100 })
}, timeout)

it('codex oversized text keeps only the documented tail behind an ellipsis marker', async () => {
  await checkAsync('codex oversized text keeps only the documented tail behind an ellipsis marker', fc.asyncProperty(
    fc.record({ seedAt: fc.nat(1_000), overflow: fc.nat(64) }),
    async ({ seedAt, overflow }) => {
      let state = stageCodexExecution(
        createEmptyCodexState(seedAt), 'exec-tail',
        { parts: [{ kind: 'text', text: 'tail probe' }] }, seedAt, 'msg-tail')
      const step = (event: CodexNativeEvent): void => {
        state = reduceCodexEvent(state, 'exec-tail', event, seedAt + 1, 'gen-tail')
      }
      // The persisted caps are module-private in state.ts; the tail rule is
      // `…\n` + the last (cap - 2) characters once the length EXCEEDS the cap,
      // so payloads run one character past it and the total length stays at cap.
      // Distinct suffixes make keeping the head observably different from keeping the tail.
      const reasoningPayload = `${'r'.repeat(MAX_REASONING + overflow)}R`
      step({ type: 'reasoning-delta', delta: reasoningPayload })
      const reasoning = `…\n${reasoningPayload.slice(-(MAX_REASONING - 2))}`
      expect(state.turns[0]?.reasoning).toBe(reasoning)
      expect(state.turns[0]?.reasoning).toHaveLength(MAX_REASONING)

      const errorPayload = `${'e'.repeat(MAX_NOTICE + overflow)}E`
      step({ type: 'error', message: errorPayload })
      const notice = `…\n${errorPayload.slice(-(MAX_NOTICE - 2))}`
      expect(state.turns[0]?.error).toBe(notice)
      expect(state.turns[0]?.notices.at(-1)?.message).toBe(notice)

      const answerPayload = `${'a'.repeat(MAX_ANSWER + overflow)}A`
      step({ type: 'text-final', itemId: 'item-tail', text: answerPayload })
      const answer = `…\n${answerPayload.slice(-(MAX_ANSWER - 2))}`
      expect(state.turns[0]?.answer).toBe(answer)
      expect(state.turns[0]?.timeline.at(-1)).toMatchObject({ kind: 'assistant', content: answer, status: 'complete' })
      expect(isCodexState(state)).toBe(true)
    }
  ), 'one staged turn → oversized reasoning delta, error message and final text → each persisted field is exactly the documented capped suffix', budgetMs, heavySamples)
}, timeout)

const deltaStepArb = fc.record({
  // Two text itemIds and one reasoning entity force merges, splits and re-opens.
  entity: fc.nat(2),
  delta: fc.string({ minLength: 1, maxLength: 16 }).map(value => value.replaceAll('\0', '') || 'x')
})
type DeltaEvent =
  | Extract<CodexNativeEvent, { readonly type: 'text-delta' }>
  | Extract<CodexNativeEvent, { readonly type: 'reasoning-delta' }>
const deltaEvent = (step: { readonly entity: number; readonly delta: string }): DeltaEvent =>
  step.entity === 2
    ? { type: 'reasoning-delta', delta: step.delta }
    : { type: 'text-delta', itemId: `item-${step.entity}`, delta: step.delta }

// A generated run could alternate entities and never offer a merge. This
// example is mandatory and opens with consecutive same-entity deltas on both
// the text and the reasoning entity.
interface DeltaScenario {
  readonly seedAt: number
  readonly deltas: readonly { readonly entity: number; readonly delta: string }[]
}
const deltaExamples: readonly [DeltaScenario][] = [[{
  seedAt: 0,
  deltas: [
    { entity: 0, delta: 'a' }, { entity: 0, delta: 'b' },
    { entity: 2, delta: 'c' }, { entity: 2, delta: 'd' }
  ]
}]]

it('codex delta batching is answer-equivalent to reducing every delta on its own', async () => {
  await checkAsync('codex delta batching is answer-equivalent to reducing every delta on its own', fc.asyncProperty(
    fc.record({ seedAt: fc.nat(1_000), deltas: fc.array(deltaStepArb, { minLength: 1, maxLength: 24 }) }),
    async ({ seedAt, deltas }) => {
      const events = deltas.map(deltaEvent)
      // Domain guard: the equivalence claim holds below every persistence cap.
      const volume = events.reduce((total, event) => total + Buffer.byteLength(event.delta, 'utf8'), 0)
      expect(volume).toBeLessThan(MAX_REASONING)
      const staged = (): CodexHarnessState => stageCodexExecution(
        createEmptyCodexState(seedAt), 'exec-delta',
        { parts: [{ kind: 'text', text: 'delta probe' }] }, seedAt, 'msg-delta')

      let sequential = staged()
      let at = seedAt
      for (const event of events) {
        at += 1
        sequential = reduceCodexEvent(sequential, 'exec-delta', event, at, 'gen-delta')
      }
      let merged = staged()
      at = seedAt
      for (const event of mergeDeltaEvents(events)) {
        at += 1
        merged = reduceCodexEvent(merged, 'exec-delta', event, at, 'gen-delta')
      }
      const left = sequential.turns[0]!
      const right = merged.turns[0]!
      expect(right.answer).toBe(left.answer)
      expect(right.reasoning).toBe(left.reasoning)
      const items = (turn: CodexTurn): readonly { readonly itemId: string; readonly content: string; readonly status: string }[] =>
        turn.timeline.flatMap(item => item.kind === 'assistant'
          ? [{ itemId: item.itemId, content: item.content, status: item.status }]
          : [])
      expect(items(right)).toEqual(items(sequential.turns[0]!))
      // Independent oracles inside the untruncated domain: reasoning is the
      // ordered concatenation of every reasoning delta, and a single-item run
      // makes the answer that exact concatenation too.
      const reasoning = events.filter((event): event is Extract<CodexNativeEvent, { type: 'reasoning-delta' }> => event.type === 'reasoning-delta')
      expect(left.reasoning).toBe(reasoning.map(event => event.delta).join(''))
      const textItemIds = new Set(events.flatMap(event => event.type === 'text-delta' ? [event.itemId] : []))
      if (textItemIds.size <= 1) {
        expect(left.answer).toBe(events.flatMap(event => event.type === 'text-delta' ? [event.delta] : []).join(''))
      }
      expect(isCodexState(sequential)).toBe(true)
      expect(isCodexState(merged)).toBe(true)
    }
  ), 'stage → reduce each delta on its own vs reduce the production batched merge → answers, reasoning and assistant items agree', budgetMs, heavySamples, deltaExamples)
}, timeout)
