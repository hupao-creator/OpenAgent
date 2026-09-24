import fc from 'fast-check'
import { expect, it } from 'vitest'
import {
  CLAUDE_STATE_LIMITS,
  currentClaudeTurn,
  emptyClaudeThreadState,
  latestVisibleClaudePrompt,
  parseClaudeThreadState,
  type ClaudeActivityKind,
  type ClaudeActivityStatus,
  type ClaudeInteraction,
  type ClaudeNotice,
  type ClaudeRuntimeState,
  type ClaudeThreadState,
  type ClaudeTurn,
  type ClaudeUsage
} from '../../../../packages/harness-claude/src/shared/state'
import {
  boundedRuntime,
  decodeClaudeMainState,
  encodeClaudeThreadState
} from '../../../../packages/harness-claude/src/main/thread/state'
import {
  appendTimelinePlan,
  appendTimelineText,
  appendTimelineUsage,
  appendTurnNotice,
  mergeClaudeTurnUsage,
  recordClaudeActivity,
  recordClaudeInteraction,
  settleClaudeTurn
} from '../../../../packages/harness-claude/src/main/thread/timeline'
import { appendBounded, truncate } from '../../../../packages/harness-claude/src/main/thread/values'
import { check, checkAsync } from './check'

const timeout = process.env.FC_EXPLORE ? 130_000 : 35_000
// Every boundary here is a pure in-memory function, so this family keeps the pure
// sample budget.
const samples = { normal: 100, explore: 1000 }

const activityKinds = ['command', 'file', 'tool', 'search', 'thinking', 'agent', 'task', 'hook', 'review', 'subagent'] as const
const activityStatuses = ['running', 'completed', 'failed', 'cancelled'] as const
const interactionKinds = ['permission', 'question', 'elicitation', 'dialog'] as const
const interactionStatuses = ['pending', 'allowed', 'denied', 'submitted', 'cancelled', 'resolved'] as const
const noticeLevels = ['info', 'warning', 'error'] as const
const outcomes = ['completed', 'failed', 'interrupted'] as const

// The producer never receives \0 from these generators: `recordClaudeActivity` and
// `recordClaudeInteraction` persist their input verbatim, so a \0 here would be a
// generator defect rather than a property observation.
const deltaText = fc.string({ maxLength: 24 }).map(value => value.replaceAll('\0', ''))
const shortText = fc.string({ minLength: 1, maxLength: 12 }).map(value => value.replaceAll('\0', ''))
const optionalName = fc.option(deltaText, { nil: undefined })

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

type Op =
  | { type: 'text'; delta: string; messageId: string | undefined }
  | { type: 'reasoning'; delta: string }
  | { type: 'activity'; id: string; kind: ClaudeActivityKind; label: string; status: ClaudeActivityStatus; taskId: string | undefined }
  | { type: 'interaction'; interaction: ClaudeInteraction }
  | { type: 'notice'; level: ClaudeNotice['level']; message: string }
  | { type: 'plan'; steps: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>; explanation: string | undefined }
  | { type: 'usage'; kind: 'generation' | 'summary'; usage: ClaudeUsage }
  | { type: 'settle'; outcome: (typeof outcomes)[number]; backgroundTaskIds: string[] }

const op = fc.oneof(
  fc.record({ type: fc.constant('text'), delta: deltaText, messageId: fc.option(fc.integer({ min: 0, max: 3 }).map(n => `msg-${n}`), { nil: undefined }) }),
  fc.record({ type: fc.constant('reasoning'), delta: deltaText }),
  fc.record({
    type: fc.constant('activity'),
    id: fc.integer({ min: 0, max: 2 }).map(n => `act-${n}`),
    kind: fc.constantFrom(...activityKinds),
    label: deltaText,
    status: fc.constantFrom(...activityStatuses),
    taskId: fc.option(fc.constantFrom('task-1', 'task-2'), { nil: undefined })
  }),
  fc.record({
    type: fc.constant('interaction'),
    interaction: fc.record({
      id: fc.integer({ min: 0, max: 1 }).map(n => `int-${n}`),
      kind: fc.constantFrom(...interactionKinds),
      title: deltaText,
      status: fc.constantFrom(...interactionStatuses)
    }) as fc.Arbitrary<ClaudeInteraction>
  }),
  fc.record({ type: fc.constant('notice'), level: fc.constantFrom(...noticeLevels), message: deltaText }),
  fc.record({
    type: fc.constant('plan'),
    // The parser requires non-empty plan steps, so the producer's domain does too.
    steps: fc.array(fc.record({ step: shortText, status: fc.constantFrom('pending', 'inProgress', 'completed') }), { maxLength: 3 }),
    explanation: optionalName
  }),
  fc.record({ type: fc.constant('usage'), kind: fc.constantFrom('generation', 'summary'), usage: usageGen }),
  fc.record({
    type: fc.constant('settle'),
    outcome: fc.constantFrom(...outcomes),
    backgroundTaskIds: fc.array(fc.constantFrom('act-0', 'act-1', 'act-2', 'task-1', 'task-2', 'bg-9'), { maxLength: 3 })
  })
) satisfies fc.Arbitrary<Op>

// These maxima define the generated domain; dedicated boundary properties below
// force string truncation and the capability count limit on every run.
const runtimeGen: fc.Arbitrary<ClaudeRuntimeState> = fc.record({
  model: fc.option(fc.string({ minLength: 0, maxLength: 600 }), { nil: undefined }),
  cwd: fc.option(fc.string({ minLength: 0, maxLength: 5_000 }), { nil: undefined }),
  claudeVersion: fc.option(fc.string({ minLength: 0, maxLength: 600 }), { nil: undefined }),
  permissionMode: fc.option(fc.string({ minLength: 0, maxLength: 600 }), { nil: undefined }),
  effort: fc.option(fc.string({ minLength: 0, maxLength: 600 }), { nil: undefined }),
  capabilities: fc.option(fc.array(shortText, { maxLength: 550 }), { nil: undefined }),
  skills: fc.option(fc.array(shortText, { maxLength: 4 }), { nil: undefined }),
  models: fc.option(fc.array(fc.record({
    value: shortText,
    displayName: shortText,
    description: optionalName,
    resolvedModel: fc.option(shortText, { nil: undefined })
  }), { maxLength: 3 }), { nil: undefined }),
  agents: fc.option(fc.array(fc.record({ name: shortText, description: shortText, model: fc.option(shortText, { nil: undefined }) }), { maxLength: 3 }), { nil: undefined }),
  commands: fc.option(fc.array(fc.record({ name: shortText, description: optionalName, argumentHint: optionalName }), { maxLength: 3 }), { nil: undefined }),
  plugins: fc.option(fc.array(fc.record({ name: shortText, path: optionalName, version: optionalName }), { maxLength: 3 }), { nil: undefined }),
  mcpServers: fc.option(fc.array(fc.record({ name: shortText, status: shortText, serverInfo: optionalName }), { maxLength: 3 }), { nil: undefined }),
  backgroundTasks: fc.option(fc.array(fc.record({
    id: shortText,
    type: optionalName,
    description: shortText,
    // Required by the producer; the empty string exercises the bounded fallback.
    status: fc.string({ minLength: 0, maxLength: 12 }).map(value => value.replaceAll('\0', ''))
  }), { maxLength: 4 }), { nil: undefined }),
  remoteControl: fc.option(fc.record({
    enabled: fc.boolean(),
    sessionUrl: fc.option(shortText, { nil: undefined }),
    connectUrl: fc.option(shortText, { nil: undefined }),
    environmentId: fc.option(shortText, { nil: undefined })
  }), { nil: undefined })
})

/** Drives the same pure timeline composition the controller applies per native event. */
function buildTurn(ops: readonly Op[], startAt: number): ClaudeTurn {
  const turn: ClaudeTurn = {
    executionId: 'execution-property',
    createdAt: startAt,
    updatedAt: startAt,
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
  ops.forEach((op, index) => {
    const at = startAt + 1 + index
    turn.updatedAt = at
    switch (op.type) {
      case 'text':
        turn.text = appendBounded(turn.text, op.delta, CLAUDE_STATE_LIMITS.textCharacters)
        appendTimelineText(turn, 'assistant', op.delta, at, op.messageId)
        break
      case 'reasoning':
        turn.reasoning = appendBounded(turn.reasoning, op.delta, CLAUDE_STATE_LIMITS.reasoningCharacters)
        appendTimelineText(turn, 'reasoning', op.delta, at)
        break
      case 'activity':
        recordClaudeActivity(turn, {
          id: op.id,
          kind: op.kind,
          label: op.label,
          status: op.status,
          ...(op.taskId === undefined ? {} : { taskId: op.taskId })
        }, at)
        break
      case 'interaction':
        recordClaudeInteraction(turn, op.interaction, at)
        break
      case 'notice':
        appendTurnNotice(turn, { id: `notice-${index}`, level: op.level, message: op.message }, at)
        break
      case 'plan':
        turn.plan = op.steps
        turn.planExplanation = op.explanation
        appendTimelinePlan(turn, at)
        break
      case 'usage':
        turn.usage = mergeClaudeTurnUsage(turn.usage, op.usage, op.kind)
        appendTimelineUsage(turn, at)
        break
      case 'settle':
        settleClaudeTurn(turn, op.outcome, new Set(op.backgroundTaskIds), at)
        break
    }
  })
  return turn
}

function tailRetain(joined: string, max: number): string {
  return joined.length <= max ? joined : joined.slice(-max)
}

it('claude state encode/decode parse round trip keeps the produced state unchanged', async () => {
  await checkAsync('claude state encode/decode parse round trip keeps the produced state unchanged', fc.asyncProperty(
    fc.record({
      ops: fc.array(op, { maxLength: 24 }),
      runtime: fc.option(runtimeGen, { nil: undefined }),
      startAt: fc.nat(10_000).map(n => n + 1_000_000)
    }),
    async ({ ops, runtime, startAt }) => {
      const turn = buildTurn(ops, startAt)
      const state: ClaudeThreadState = {
        version: 1,
        turns: [turn],
        nativeNotifications: [],
        ...(runtime === undefined ? {} : { runtime: boundedRuntime(runtime) })
      }
      // The produced state is the exact shape the producer persists: no NUL anywhere,
      // unique timeline ids in non-decreasing createdAt order, every retained length
      // within CLAUDE_STATE_LIMITS, and turn text equal to the delta concatenation.
      expect(JSON.stringify(state)).not.toContain('\0')
      const seenIds = new Set<string>()
      let previousAt = turn.createdAt
      for (const item of turn.timeline) {
        expect(seenIds.has(item.id)).toBe(false)
        seenIds.add(item.id)
        expect(item.createdAt).toBeGreaterThanOrEqual(previousAt)
        expect(item.createdAt).toBeLessThanOrEqual(turn.updatedAt)
        previousAt = item.createdAt
      }
      expect(turn.timeline.length).toBeLessThanOrEqual(CLAUDE_STATE_LIMITS.timelineItemsPerTurn)
      expect(turn.text.length).toBeLessThanOrEqual(CLAUDE_STATE_LIMITS.textCharacters)
      expect(turn.reasoning.length).toBeLessThanOrEqual(CLAUDE_STATE_LIMITS.reasoningCharacters)
      expect(turn.text).toBe(tailRetain(ops.filter(op => op.type === 'text').map(op => op.delta).join(''), CLAUDE_STATE_LIMITS.textCharacters))
      expect(turn.reasoning).toBe(tailRetain(ops.filter(op => op.type === 'reasoning').map(op => op.delta).join(''), CLAUDE_STATE_LIMITS.reasoningCharacters))
      for (const capability of state.runtime?.capabilities ?? []) expect(capability.length).toBeLessThanOrEqual(2_000)
      for (const task of state.runtime?.backgroundTasks ?? []) expect(task.status.length).toBeLessThanOrEqual(256)
      if (state.runtime?.model !== undefined) expect(state.runtime.model.length).toBeLessThanOrEqual(512)
      if (state.runtime?.cwd !== undefined) expect(state.runtime.cwd.length).toBeLessThanOrEqual(4_096)

      // encode runs the parser on the produced state, so any rejection here is the
      // "false rejection loses history" defect this family exists to catch.
      const encoded = encodeClaudeThreadState(state)
      const serialized = JSON.parse(JSON.stringify(encoded)) as unknown
      // parse is a fixed point of its own output, the persisted bytes decode to the
      // produced state, and encoding is stable across a storage round trip.
      expect(encoded).toEqual(state)
      expect(parseClaudeThreadState(serialized)).toEqual(encoded)
      expect(decodeClaudeMainState(serialized)).toEqual(state)
      expect(parseClaudeThreadState(decodeClaudeMainState(serialized))).toEqual(encoded)
    }
  ), 'drive timeline pure functions with generated events → encode → JSON storage round trip → decode → re-parse', undefined, samples)
}, timeout)

it('appendBounded tail retention and truncate marker holds for generated strings', () => {
  const assertBounded = (previous: string | undefined, next: string, max: number): void => {
    const value = `${previous || ''}${next.replaceAll('\0', '')}`
    const expectedAppend = value.length <= max ? value : value.slice(-max)
    expect(appendBounded(previous, next, max)).toBe(expectedAppend)
    const sanitized = next.replaceAll('\0', '')
    const expectedTruncate = sanitized.length <= max ? sanitized : `${sanitized.slice(0, max - 1)}…`
    expect(truncate(next, max)).toBe(expectedTruncate)
  }
  // Mandatory probe: an overflowing previous value whose head differs from its
  // tail, so a helper that starts keeping the head fails on every run rather than
  // only when a generated draw happens to exceed the bound with distinct ends.
  assertBounded('aaaaaaaaaaa', 'zzzz', 5)
  check('appendBounded tail retention and truncate marker holds for generated strings', fc.property(
    fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
    fc.oneof(fc.string({ maxLength: 20 }), fc.string({ maxLength: 18 }).map(value => `a\0${value}b`)),
    fc.integer({ min: 1, max: 30 }),
    assertBounded
  ))
})

// `boundedRuntime` is the only place the persisted runtime bounds are applied, and a
// string generator with a large maximum need never reach it under fast-check's default
// sizing. These values are generated one character past each bound with `minLength`
// built from the bound itself, so every run clips every bounded field — the top-level
// strings, the model/agent/command/plugin/mcp-server/background-task members and the
// remote-control URLs — and a removed `truncate` call fails on the first sample
// instead of staying green.
it('claude runtime strings past every persisted bound keep the documented clipped head', () => {
  check('claude runtime strings past every persisted bound keep the documented clipped head', fc.property(
    fc.integer({ min: 1, max: 24 }),
    fc.constantFrom('x', '中'),
    (extra, unit) => {
      const oversize = (bound: number): string => unit.repeat(bound + extra)
      const clipped = (value: string, bound: number): string => {
        const sanitized = value.replaceAll('\0', '')
        return sanitized.length <= bound ? sanitized : `${sanitized.slice(0, bound - 1)}…`
      }
      const runtime = boundedRuntime({
        model: `\0\0${oversize(512)}`,
        cwd: oversize(4_096),
        claudeVersion: oversize(512),
        permissionMode: oversize(512),
        effort: oversize(512),
        capabilities: [oversize(2_000), oversize(2_000)],
        models: [{
          value: oversize(512),
          displayName: oversize(1_000),
          description: oversize(8_000),
          resolvedModel: oversize(512)
        }],
        agents: [{ name: oversize(1_000), description: oversize(8_000), model: oversize(512) }],
        commands: [{ name: oversize(1_000), description: oversize(8_000), argumentHint: oversize(2_000) }],
        skills: [oversize(2_000)],
        plugins: [{ name: oversize(1_000), path: oversize(4_096), version: oversize(256) }],
        mcpServers: [{ name: oversize(1_000), status: oversize(256), serverInfo: oversize(8_000) }],
        backgroundTasks: [{
          id: oversize(512),
          type: oversize(256),
          description: oversize(8_000),
          status: oversize(256)
        }],
        remoteControl: {
          enabled: true,
          sessionUrl: oversize(8_192),
          connectUrl: oversize(8_192),
          environmentId: oversize(8_192)
        }
      })
      // The NUL characters are stripped before the bound applies, so the clipped form
      // is the head of the sanitized value plus the ellipsis marker.
      const expectClipped = (value: string, bound: number, actual: string | undefined): void => {
        expect(actual).toBe(clipped(value, bound))
        expect(actual!.length).toBeLessThanOrEqual(bound)
      }
      expectClipped(`\0\0${oversize(512)}`, 512, runtime.model)
      expectClipped(oversize(4_096), 4_096, runtime.cwd)
      expectClipped(oversize(512), 512, runtime.claudeVersion)
      expectClipped(oversize(512), 512, runtime.permissionMode)
      expectClipped(oversize(512), 512, runtime.effort)
      expect(runtime.capabilities).toHaveLength(2)
      runtime.capabilities!.forEach(value => expectClipped(oversize(2_000), 2_000, value))
      expectClipped(oversize(2_000), 2_000, runtime.skills![0])
      const model = runtime.models![0]!
      expectClipped(oversize(512), 512, model.value)
      expectClipped(oversize(1_000), 1_000, model.displayName)
      expectClipped(oversize(8_000), 8_000, model.description)
      expectClipped(oversize(512), 512, model.resolvedModel)
      const agent = runtime.agents![0]!
      expectClipped(oversize(1_000), 1_000, agent.name)
      expectClipped(oversize(8_000), 8_000, agent.description)
      expectClipped(oversize(512), 512, agent.model)
      const command = runtime.commands![0]!
      expectClipped(oversize(1_000), 1_000, command.name)
      expectClipped(oversize(8_000), 8_000, command.description)
      expectClipped(oversize(2_000), 2_000, command.argumentHint)
      const plugin = runtime.plugins![0]!
      expectClipped(oversize(1_000), 1_000, plugin.name)
      expectClipped(oversize(4_096), 4_096, plugin.path)
      expectClipped(oversize(256), 256, plugin.version)
      const server = runtime.mcpServers![0]!
      expectClipped(oversize(1_000), 1_000, server.name)
      expectClipped(oversize(256), 256, server.status)
      expectClipped(oversize(8_000), 8_000, server.serverInfo)
      const task = runtime.backgroundTasks![0]!
      expectClipped(oversize(512), 512, task.id)
      expectClipped(oversize(256), 256, task.type)
      expectClipped(oversize(8_000), 8_000, task.description)
      expectClipped(oversize(256), 256, task.status)
      const remote = runtime.remoteControl!
      expectClipped(oversize(8_192), 8_192, remote.sessionUrl)
      expectClipped(oversize(8_192), 8_192, remote.connectUrl)
      expectClipped(oversize(8_192), 8_192, remote.environmentId)
    }
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

it('claude state selectors follow prompts and internal indexes', () => {
  check('claude state selectors follow prompts and internal indexes', fc.property(
    fc.array(fc.record({ text: deltaText, internal: fc.boolean() }), { maxLength: 6 }),
    prompts => {
      const internal = prompts
        .map((prompt, index) => prompt.internal ? index : -1)
        .filter(index => index >= 0)
      const turn = {
        ...emptyClaudeThreadState(),
        turns: [{
          ...buildTurn([], 1_000),
          prompts: prompts.map(prompt => prompt.text),
          promptAttachments: prompts.map(() => []),
          ...(internal.length > 0 ? { internalPromptIndexes: internal } : {})
        }]
      }
      expect(currentClaudeTurn(turn)).toBe(turn.turns[0])
      let expected: string | undefined
      for (let index = prompts.length - 1; index >= 0; index -= 1) {
        if (!internal.includes(index)) { expected = prompts[index]!.text; break }
      }
      expect(latestVisibleClaudePrompt(turn.turns[0])).toBe(expected)
      expect(latestVisibleClaudePrompt(undefined)).toBeUndefined()
      expect(currentClaudeTurn(emptyClaudeThreadState())).toBeUndefined()
    }
  ))
})
