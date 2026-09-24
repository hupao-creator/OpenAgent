import fc from 'fast-check'
import { expect, it } from 'vitest'
import { isJsonValue, type JsonValue } from '@openagent/contracts'
import { encodeInteractionResponse, parseInteraction, type CodexInteractionRequest } from '../../../../packages/harness-codex/src/main/runtime/app-server'
import { assertCodexInteractionAdmission } from '../../../../packages/harness-codex/src/shared/interaction-admission'
import type { CodexInteraction } from '../../../../packages/harness-codex/src/shared/types'
import { checkAsync } from './check'

const timeout = process.env.FC_EXPLORE ? 130_000 : 35_000
const budgetMs = process.env.FC_EXPLORE ? 120_000 : 10_000
// Pure in-memory protocol mapping, so the pure sample budget applies.
const samples = { normal: 100, explore: 1000 }

// Mirrors the private CODEX_APPROVAL_DECISIONS map in app-server.ts; the wire
// union for command/file approvals is exactly these four decisions.
const APPROVAL_DECISIONS = {
  'allow-once': 'accept',
  'allow-session': 'acceptForSession',
  deny: 'decline',
  cancel: 'cancel'
} as const

const freeText = fc.string({ maxLength: 12 }).map(value => value.replaceAll('\0', ''))

/**
 * The decisions each native method must advertise, declared independently of
 * production `parseInteraction`: the matrix below encodes every action the
 * parser returns, so only this table catches an action that stops being
 * offered at all (a supported user decision silently disappearing).
 */
const EXPECTED_ACTION_IDS: Record<string, readonly string[]> = {
  'item/commandExecution/requestApproval': ['allow-once', 'allow-session', 'deny', 'cancel'],
  'item/fileChange/requestApproval': ['allow-once', 'allow-session', 'deny', 'cancel'],
  'item/permissions/requestApproval': ['allow-once', 'allow-session', 'deny'],
  'item/tool/requestUserInput': ['submit', 'cancel'],
  'mcpServer/elicitation/request': ['submit', 'deny', 'cancel']
}
const sortedIds = (ids: readonly string[]): readonly string[] => [...ids].sort()
const ident = fc.integer({ min: 0, max: 1_000_000 }).map(value => `id${value.toString(36)}`)
const optionLabel = ident.map(value => `选项${value}`)
const opt = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.option(arb, { nil: undefined })

/** Drop keys carrying undefined so generated values stay valid JSON. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T
}

const jsonValueArb: fc.Arbitrary<JsonValue> = fc.oneof(
  freeText,
  fc.nat(100),
  fc.boolean(),
  fc.record({ flag: fc.boolean(), count: fc.nat(9), note: freeText }),
  fc.array(fc.nat(50), { maxLength: 3 })
)

const idsParams = { interactionId: opt(ident), elicitationId: opt(ident) }
const approvalParams = fc.record({
  ...idsParams,
  reason: opt(freeText),
  command: opt(freeText),
  grantRoot: opt(freeText),
  commandActions: opt(fc.array(fc.record({ kind: fc.constantFrom('exec', 'read'), command: freeText }), { maxLength: 2 })),
  permissions: opt(jsonValueArb)
})
const questionParamsArb = fc.record({
  id: ident,
  header: opt(freeText),
  question: opt(freeText),
  isSecret: fc.boolean(),
  isOther: fc.boolean(),
  options: opt(fc.array(fc.record({ label: optionLabel, description: opt(freeText) }), { maxLength: 3 }))
})
const userInputParams = fc.record({
  ...idsParams,
  isBlocking: fc.boolean(),
  // Public question ids are digests of the native ones and the public contract
  // requires them unique, so a native request naming one id twice cannot be
  // projected and admission refuses it. That payload is outside the honest
  // domain (the native side keys its answers by question id), so ids stay
  // distinct within one request.
  questions: fc.uniqueArray(questionParamsArb, { maxLength: 3, selector: question => question.id })
})
const elicitationParams = fc.record({
  ...idsParams,
  mode: opt(fc.constantFrom('form', 'openai/form', 'url')),
  serverName: opt(freeText),
  url: opt(freeText),
  message: opt(freeText),
  requestedSchema: opt(fc.record({ type: fc.constantFrom('object', 'string'), title: freeText })),
  _meta: opt(jsonValueArb)
})
const requestArb: fc.Arbitrary<PendingScenario> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ method: fc.constant('item/commandExecution/requestApproval'), params: approvalParams }) },
  { weight: 1, arbitrary: fc.record({ method: fc.constant('item/fileChange/requestApproval'), params: approvalParams }) },
  { weight: 1, arbitrary: fc.record({ method: fc.constant('item/permissions/requestApproval'), params: approvalParams }) },
  { weight: 2, arbitrary: fc.record({ method: fc.constant('item/tool/requestUserInput'), params: userInputParams }) },
  { weight: 2, arbitrary: fc.record({ method: fc.constant('mcpServer/elicitation/request'), params: elicitationParams }) }
)

interface PendingScenario {
  readonly method: string
  readonly params: Record<string, unknown>
}

const pendingOf = (scenario: PendingScenario): CodexInteractionRequest => {
  const interaction = parseInteraction(scenario.method, scenario.params)
  expect(interaction).toBeDefined()
  return { method: scenario.method, params: scenario.params, interaction: interaction! }
}

/** One choice per generated question; the fallback fills questions the run never planned for. */
interface AnswerChoice {
  readonly mode: 'option' | 'free' | 'multi' | 'dropped'
  readonly optionIndex: number
  readonly text: string
}
const choicesArb = fc.array(fc.record({
  mode: fc.constantFrom('option', 'free', 'multi', 'dropped'),
  optionIndex: fc.nat(2),
  text: freeText
}), { maxLength: 3 })
const choiceFor = (choices: readonly AnswerChoice[], index: number): AnswerChoice =>
  choices[index] ?? { mode: 'free', optionIndex: 0, text: 'fallback answer' }

/** Mirrors nativeQuestionAnswers: the native option id maps to its label, free text passes through. */
const translate = (question: CodexInteraction['questions'][number], value: string): string => {
  const option = question.options.find(candidate => candidate.id === value)
  return option?.label || value
}

it('codex encodes every advertised action of every native interaction into its legal wire union', async () => {
  await checkAsync('codex encodes every advertised action of every native interaction into its legal wire union', fc.asyncProperty(
    fc.record({
      request: requestArb,
      choices: choicesArb,
      unknownAnswer: opt(freeText)
    }),
    async ({ request, choices, unknownAnswer }) => {
      // A URL elicitation without its URL throws at parse time, so it is
      // outside the honest input domain and is skipped before parsing.
      if (request.method === 'mcpServer/elicitation/request' && request.params.mode === 'url' && !request.params.url) return
      const interaction = parseInteraction(request.method, request.params)
      expect(interaction).toBeDefined()
      // Every parseable native interaction must clear admission unchanged.
      expect(() => assertCodexInteractionAdmission(interaction)).not.toThrow()
      // The advertised set is pinned independently of the loop below, so losing
      // a decision is a failure even though the remaining ones still encode.
      expect(sortedIds(interaction!.actions.map(action => action.id)))
        .toEqual(sortedIds(EXPECTED_ACTION_IDS[request.method]!))
      const pending: CodexInteractionRequest = { method: request.method, params: request.params, interaction: interaction! }

      const responseAnswers: Record<string, unknown> = {}
      const expectedAnswers: Record<string, { readonly answers: readonly string[] }> = {}
      interaction!.questions.forEach((question, index) => {
        const choice = choiceFor(choices, index)
        if (choice.mode === 'dropped') {
          responseAnswers[question.id] = 42
          return
        }
        const resolve = (): string => choice.mode === 'option'
          ? question.options[choice.optionIndex]?.id ?? choice.text
          : choice.text
        const value = choice.mode === 'multi' ? [resolve(), choice.text] : resolve()
        responseAnswers[question.id] = value
        const values = Array.isArray(value) ? value : [value]
        expectedAnswers[question.id] = { answers: values.map(entry => translate(question, entry)) }
      })
      if (unknownAnswer !== undefined) {
        responseAnswers['unknown-question'] = unknownAnswer
        expectedAnswers['unknown-question'] = { answers: [unknownAnswer] }
      }

      for (const action of interaction!.actions) {
        const response = interaction!.kind === 'mcp-elicitation' && interaction!.elicitation.mode === 'form' && action.id === 'submit'
          ? { actionId: action.id, answers: { [interaction!.elicitation.questionId]: '{"count":1}' } }
          : interaction!.kind === 'user-input'
            ? { actionId: action.id, answers: responseAnswers }
            : { actionId: action.id }
        const wire = encodeInteractionResponse(pending, response as JsonValue) as Record<string, unknown>
        // Model oracle: the documented wire shape per kind and action.
        if (pending.interaction.kind === 'command-approval' || pending.interaction.kind === 'file-approval') {
          expect(wire).toEqual({ decision: APPROVAL_DECISIONS[action.id as keyof typeof APPROVAL_DECISIONS] })
          expect(Object.keys(wire)).toEqual(['decision'])
          expect(['accept', 'acceptForSession', 'decline', 'cancel']).toContain(wire.decision)
        } else if (pending.interaction.kind === 'permissions') {
          expect(wire).toEqual({
            permissions: action.id.startsWith('allow') && isJsonValue(pending.params.permissions)
              ? pending.params.permissions
              : {},
            scope: action.id === 'allow-session' ? 'session' : 'turn'
          })
          expect(Object.keys(wire).sort()).toEqual(['permissions', 'scope'])
          expect(['session', 'turn']).toContain(wire.scope)
        } else if (pending.interaction.kind === 'user-input') {
          expect(wire).toEqual({ answers: expectedAnswers })
          expect(['submit', 'cancel']).toContain(action.id)
        } else if (action.id === 'deny' || action.id === 'cancel') {
          expect(wire).toEqual({ action: action.id === 'deny' ? 'decline' : 'cancel', content: null, _meta: null })
          expect(['accept', 'decline', 'cancel']).toContain(wire.action)
        } else if (pending.interaction.kind === 'mcp-elicitation' && pending.interaction.elicitation.mode === 'url') {
          expect(wire).toEqual({ action: 'accept', content: {}, _meta: null })
        } else {
          expect(wire).toEqual({
            action: 'accept',
            content: JSON.parse('{"count":1}'),
            _meta: isJsonValue(pending.params._meta) ? pending.params._meta : null
          })
        }
      }
    }
  ), 'parse each native method → clear admission → encode every advertised action against the documented wire union', budgetMs, samples)
}, timeout)

it('codex mcp form answers round-trip through JSON into the accepted content object', async () => {
  await checkAsync('codex mcp form answers round-trip through JSON into the accepted content object', fc.asyncProperty(
    fc.record({
      mode: fc.constantFrom('form', 'openai/form'),
      schema: fc.record({ type: fc.constant('object'), title: freeText }),
      meta: opt(jsonValueArb),
      content: fc.record({ count: fc.nat(99), note: freeText, flag: fc.boolean() }),
      fault: fc.constantFrom('none', 'not-json', 'non-object', 'non-string')
    }),
    async ({ mode, schema, meta, content, fault }) => {
      const params = compact({
        elicitationId: 'native-form',
        mode,
        requestedSchema: schema,
        _meta: meta
      })
      const pending = pendingOf({ method: 'mcpServer/elicitation/request', params })
      const interaction = pending.interaction
      if (interaction.kind !== 'mcp-elicitation' || interaction.elicitation.mode !== 'form') {
        throw new Error('expected a form elicitation')
      }
      const questionId = interaction.elicitation.questionId
      const answers = (): Record<string, unknown> => {
        if (fault === 'not-json') return { [questionId]: '{not json' }
        if (fault === 'non-object') return { [questionId]: '[1,2]' }
        if (fault === 'non-string') return { [questionId]: 42 }
        return { [questionId]: JSON.stringify(content) }
      }
      const encode = (): unknown => encodeInteractionResponse(pending, { actionId: 'submit', answers: answers() } as JsonValue)
      if (fault === 'not-json') {
        expect(encode).toThrow('Codex MCP elicitation form values 不是有效 JSON')
        return
      }
      if (fault === 'non-object') {
        expect(encode).toThrow('Codex MCP elicitation form values 必须是 JSON object')
        return
      }
      // A non-string answer is rejected before JSON parsing ever happens.
      if (fault === 'non-string') {
        expect(encode).toThrow('Codex MCP elicitation 缺少 JSON form values')
        return
      }
      const wire = encode() as Record<string, unknown>
      // The accepted content is exactly the parsed object; accepted form mode
      // preserves the request metadata while a decline never echoes any.
      expect(wire).toEqual({ action: 'accept', content, _meta: meta === undefined ? null : meta })
      expect(Object.keys(wire).sort()).toEqual(['_meta', 'action', 'content'])
    }
  ), 'generated form schema and JSON content → submit → accepted content equals the parsed object and request metadata is preserved', budgetMs, samples)
}, timeout)
