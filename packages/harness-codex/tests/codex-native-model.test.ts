import { describe, expect, it } from 'vitest'
import {
  MAX_PUBLIC_INTERACTION_PROMPT_CHARACTERS,
  PUBLIC_OBSERVATION_LIMITS,
  isPublicInteraction,
  isThreadPublicObservation
} from '@openagent/contracts'
import {
  createEmptyCodexState,
  decodeCodexState,
  reduceCodexEvent,
  settleCodexExecution,
  stageCodexExecution
} from '../src/shared/state.js'
import { toPublicInteraction } from '../src/shared/public-interactions.js'
import { assertCodexInteractionAdmission } from '../src/shared/interaction-admission.js'
import type { CodexInteraction, CodexNativeEvent } from '../src/shared/types.js'

describe('Codex native message identity', () => {
  it.each(['done-event', 'controller-settlement'] as const)(
    'keeps first occurrence order and one authoritative item per message after %s',
    (settlement) => {
      let state = stagedState()
      const events: CodexNativeEvent[] = [
        { type: 'text-delta', itemId: 'a', delta: 'A' },
        { type: 'activity-start', activity: {
          id: 'tool', kind: 'tool', label: 'tool', status: 'running'
        } },
        { type: 'text-delta', itemId: 'b', delta: 'B' },
        { type: 'text-delta', itemId: 'a', delta: ' streamed' },
        { type: 'text-final', itemId: 'b', text: 'B final' },
        { type: 'text-final', itemId: 'a', text: 'A final' },
        { type: 'text-final', itemId: 'a', text: 'A final' },
        { type: 'text-delta', itemId: 'a', delta: 'late replay' }
      ]
      for (const event of events) {
        state = reduceCodexEvent(state, 'execution', event, state.updatedAt + 1, 'event')
      }
      state = settlement === 'done-event'
        ? reduceCodexEvent(state, 'execution', { type: 'done', outcome: 'completed' }, 30, 'done')
        : settleCodexExecution(state, 'execution', 'completed', 30)
      const turn = decodeCodexState(JSON.parse(JSON.stringify(state))).turns[0]!
      expect(turn.status).toBe('completed')
      expect(turn.answer).toBe('A final\n\nB final')
      expect(turn.timeline.map((item) => item.kind)).toEqual([
        'user-message', 'assistant', 'activity', 'assistant'
      ])
      expect(turn.timeline.filter((item) => item.kind === 'assistant')).toMatchObject([
        { itemId: 'a', content: 'A final', status: 'complete' },
        { itemId: 'b', content: 'B final', status: 'complete' }
      ])
    }
  )

  it('does not duplicate one message when an activity interrupts its stream', () => {
    let state = stagedState()
    for (const event of [
      { type: 'text-delta', itemId: 'a', delta: 'Before ' },
      { type: 'activity-start', activity: {
        id: 'tool', kind: 'tool', label: 'tool', status: 'running'
      } },
      { type: 'text-delta', itemId: 'a', delta: 'after' }
    ] satisfies CodexNativeEvent[]) {
      state = reduceCodexEvent(state, 'execution', event, state.updatedAt + 1, 'event')
    }
    expect(state.turns[0]?.answer).toBe('Before after')
    expect(state.turns[0]?.timeline.filter((item) => item.kind === 'assistant')).toHaveLength(1)
  })
})

describe('Codex private MCP interaction semantics', () => {
  it('keeps the private decoder independent of the per-request admission byte budget', () => {
    const base = mcpInteraction('form')
    if (base.kind !== 'mcp-elicitation' || base.elicitation.mode !== 'form') {
      throw new Error('Expected form')
    }
    const interaction: CodexInteraction = {
      ...base,
      elicitation: {
        ...base.elicitation,
        requestedSchema: { description: 'x'.repeat(8 * 1024 * 1024) }
      }
    }
    expect(() => assertCodexInteractionAdmission(interaction)).toThrow('8 MiB')
    const state = reduceCodexEvent(stagedState(), 'execution', {
      type: 'interaction-opened', interaction
    }, 3, 'event')
    expect(decodeCodexState(state).turns[0]!.interactions[0]).toEqual(interaction)
  })

  it.each(['form', 'url'] as const)('round-trips explicit %s semantics', (mode) => {
    const interaction = mcpInteraction(mode)
    const state = reduceCodexEvent(stagedState(), 'execution', {
      type: 'interaction-opened', interaction
    }, 3, 'event')
    expect(decodeCodexState(JSON.parse(JSON.stringify(state))).turns[0]?.interactions[0])
      .toEqual(interaction)
    expect(toPublicInteraction(interaction).kind).toBe(mode === 'form' ? 'question' : 'permission')
  })

  it('rejects missing or inconsistent MCP metadata in persisted state', () => {
    const state = reduceCodexEvent(stagedState(), 'execution', {
      type: 'interaction-opened', interaction: mcpInteraction('form')
    }, 3, 'event')
    const malformed = JSON.parse(JSON.stringify(state))
    malformed.turns[0].interactions[0].elicitation.questionId = 'unknown-field'
    expect(() => decodeCodexState(malformed)).toThrow()
    delete malformed.turns[0].interactions[0].elicitation
    expect(() => decodeCodexState(malformed)).toThrow()
  })

  it('retains the full private schema and bounds the complete public prompt', () => {
    const interaction = mcpInteraction('form')
    if (interaction.kind !== 'mcp-elicitation' || interaction.elicitation.mode !== 'form') {
      throw new Error('Expected form')
    }
    const large = {
      ...interaction,
      elicitation: {
        ...interaction.elicitation,
        requestedSchema: { type: 'object', description: 's'.repeat(30_000) }
      }
    } satisfies CodexInteraction
    const projected = toPublicInteraction(large)
    expect(projected.questions[0]?.prompt.length).toBe(MAX_PUBLIC_INTERACTION_PROMPT_CHARACTERS)
    expect(isThreadPublicObservation({
      latestExecution: {
        executionId: 'execution', startedAt: 1, status: 'waiting-for-user', interactions: [projected]
      },
      backgroundWork: null
    })).toBe(true)
    const state = reduceCodexEvent(stagedState(), 'execution', {
      type: 'interaction-opened', interaction: large
    }, 3, 'event')
    expect(decodeCodexState(state).turns[0]?.interactions[0]).toEqual(large)
  })
})

describe('Codex public interaction display bounds', () => {
  it.each([
    ['overlong', 'x'.repeat(30_000)],
    ['blank', ' \t\n'],
    ['empty', ''],
    ['blank prefix', `${' '.repeat(20_000)}Visible text`]
  ])('projects %s display text without changing private answers or identities', (_name, text) => {
    const interaction: CodexInteraction = {
      id: 'native-interaction', kind: 'user-input', title: text,
      detail: text, blocksTurn: true, status: 'pending',
      actions: [{ id: 'submit', intent: 'submit', label: text }],
      questions: [{
        id: 'native/question', prompt: text, header: text, secret: false,
        allowOther: false, options: [{
          id: 'native/question:option:0', label: text, description: text
        }]
      }]
    }
    const original = structuredClone(interaction)
    const projected = toPublicInteraction(interaction)
    expect(isPublicInteraction(projected)).toBe(true)
    expect(projected.title.length).toBeLessThanOrEqual(PUBLIC_OBSERVATION_LIMITS.title)
    expect(projected.description?.length ?? 0).toBeLessThanOrEqual(PUBLIC_OBSERVATION_LIMITS.description)
    expect(projected.actions[0]!.label.length).toBeLessThanOrEqual(PUBLIC_OBSERVATION_LIMITS.actionLabel)
    const question = projected.questions[0]!
    expect(question.prompt.length).toBeLessThanOrEqual(PUBLIC_OBSERVATION_LIMITS.prompt)
    expect(question.header?.length ?? 0).toBeLessThanOrEqual(PUBLIC_OBSERVATION_LIMITS.header)
    expect(question.options[0]!.label.length).toBeLessThanOrEqual(PUBLIC_OBSERVATION_LIMITS.optionLabel)
    expect(question.options[0]!.description?.length ?? 0)
      .toBeLessThanOrEqual(PUBLIC_OBSERVATION_LIMITS.optionDescription)
    expect(interaction).toEqual(original)
    const state = reduceCodexEvent(stagedState(), 'execution', {
      type: 'interaction-opened', interaction
    }, 3, 'event')
    expect(decodeCodexState(state).turns[0]!.interactions[0]).toEqual(original)
  })
})

function stagedState() {
  return stageCodexExecution(createEmptyCodexState(1), 'execution', {
    parts: [{ kind: 'text', text: 'Test native model' }]
  }, 2, 'user')
}

function mcpInteraction(mode: 'form' | 'url'): CodexInteraction {
  return {
    id: 'mcp-request', kind: 'mcp-elicitation', title: 'MCP request',
    blocksTurn: true, status: 'pending',
    actions: [
      { id: 'submit', intent: 'submit', label: 'Submit' },
      { id: 'deny', intent: 'deny', label: 'Deny' },
      { id: 'cancel', intent: 'cancel', label: 'Cancel' }
    ],
    elicitation: mode === 'form'
      ? { mode, questionId: 'arbitrary-field', requestedSchema: { type: 'object' } }
      : { mode, url: 'https://example.test/form' },
    questions: mode === 'form'
      ? [{ id: 'arbitrary-field', prompt: 'JSON values', secret: false, allowOther: true, options: [] }]
      : []
  }
}
