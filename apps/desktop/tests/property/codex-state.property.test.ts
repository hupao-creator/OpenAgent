import fc from 'fast-check'
import { expect, it } from 'vitest'
import type { AgentInput, JsonValue } from '@openagent/contracts'
import {
  createEmptyCodexState,
  decodeCodexState,
  isCodexState,
  reduceCodexEvent,
  settleCodexExecution,
  stageCodexExecution
} from '../../../../packages/harness-codex/src/shared/state'
import { mergeDeltaEvents } from '../../../../packages/harness-codex/src/main/thread/thread-handle'
import type { CodexHarnessState, CodexNativeEvent, CodexTurn } from '../../../../packages/harness-codex/src/shared/types'
import { checkAsync } from './check'

const timeout = process.env.FC_EXPLORE ? 130_000 : 35_000
const budgetMs = process.env.FC_EXPLORE ? 120_000 : 10_000
// Larger generated states use reduced sample budgets.
const heavySamples = { normal: 50, explore: 500 }

// Persistence caps mirrored from packages/harness-codex/src/shared/state.ts
// (module-private there); they define the tail-truncation contract.
const MAX_TURNS = 200
const MAX_ANSWER = 256 * 1024
const MAX_REASONING = 64 * 1024
const MAX_NOTICE = 16 * 1024

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
  ), 'stage → reduce each delta on its own vs reduce the production batched merge → answers, reasoning and assistant items agree', budgetMs, heavySamples)
}, timeout)
