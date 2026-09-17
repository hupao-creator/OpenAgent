import fc from 'fast-check'
import { expect, it } from 'vitest'
import { isJsonValue, type HarnessRespondRequest, type JsonValue } from '@openagent/contracts'
import {
  defaultInteractionDecline,
  encodeInteractionResponse,
  nativeQuestionAnswers,
  parseInteraction,
  type CodexInteractionRequest
} from '../../../../packages/harness-codex/src/main/runtime/app-server'
import { nativeCodexInteractionResponse } from '../../../../packages/harness-codex/src/main/thread/thread-handle'
import { assertCodexInteractionAdmission } from '../../../../packages/harness-codex/src/shared/interaction-admission'
import { toPublicInteraction } from '../../../../packages/harness-codex/src/shared/public-interactions'
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

// One sample per native method, run before the generated ones, so no run can
// reach the gate with a kind unexercised.
const matrixExamples: readonly [{
  request: PendingScenario
  choices: AnswerChoice[]
  unknownAnswer: undefined
}][] =
  ([
    { method: 'item/commandExecution/requestApproval', params: { interactionId: 'native-1', command: 'cargo test' } },
    { method: 'item/fileChange/requestApproval', params: { interactionId: 'native-2', grantRoot: '/repo' } },
    { method: 'item/permissions/requestApproval', params: { interactionId: 'native-3', permissions: { scopes: ['fs.write'] } } },
    {
      method: 'item/tool/requestUserInput',
      params: { interactionId: 'native-4', isBlocking: true, questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'One' }] }] }
    },
    {
      method: 'mcpServer/elicitation/request',
      params: { elicitationId: 'native-5', mode: 'form', requestedSchema: { type: 'object' }, _meta: { flag: true } }
    }
  ] as const).map(request => [{
    request,
    choices: [{ mode: 'option' as const, optionIndex: 0, text: '' }],
    unknownAnswer: undefined
  }])

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
  ), 'parse each native method → clear admission → encode every advertised action against the documented wire union', budgetMs, samples, matrixExamples)
}, timeout)

const declineExamples: readonly [PendingScenario][] =
  ([
    { method: 'item/commandExecution/requestApproval', params: { interactionId: 'native-1' } },
    { method: 'item/fileChange/requestApproval', params: { interactionId: 'native-2' } },
    { method: 'item/permissions/requestApproval', params: { interactionId: 'native-3' } },
    { method: 'item/tool/requestUserInput', params: { interactionId: 'native-4', isBlocking: true, questions: [{ id: 'q1' }] } },
    { method: 'mcpServer/elicitation/request', params: { elicitationId: 'native-5', mode: 'url', url: 'https://example.com' } }
  ] as const).map(scenario => [scenario])

it('codex timeout decline is indistinguishable from the user choosing cancel or deny', async () => {
  await checkAsync('codex timeout decline is indistinguishable from the user choosing cancel or deny', fc.asyncProperty(
    requestArb,
    async request => {
      // Same parse-time guard as the decision matrix: URL elicitation without
      // a URL never produces an interaction.
      if (request.method === 'mcpServer/elicitation/request' && request.params.mode === 'url' && !request.params.url) return
      const interaction = parseInteraction(request.method, request.params)
      expect(interaction).toBeDefined()
      const pending: CodexInteractionRequest = { method: request.method, params: request.params, interaction: interaction! }
      const decline = defaultInteractionDecline(pending)
      // Every kind advertises the action the timeout maps onto: cancel where
      // it exists, otherwise deny (the permissions kind filters cancel out).
      const chosen = interaction!.actions.find(action => action.intent === 'cancel') ??
        interaction!.actions.find(action => action.intent === 'deny')
      expect(chosen).toBeDefined()
      const wire = encodeInteractionResponse(pending, { actionId: chosen!.id } as JsonValue)
      expect(decline.response).toEqual({ result: wire })
      // The recorded resolution is the one the state machine maps back onto
      // the same terminal status the chosen action's intent implies.
      expect(decline.resolution).toBe(chosen!.intent === 'cancel' ? 'cancel' : 'decline')
    }
  ), 'parse each native method → encode its cancel (or deny) action → the timeout decline response and resolution match it exactly', budgetMs, samples, declineExamples)
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

interface PublicScenario {
  readonly request: {
    readonly method: string
    readonly params: Record<string, unknown>
  }
  readonly choices: readonly AnswerChoice[]
  readonly formContent: { readonly count: number; readonly note: string; readonly flag: boolean }
  readonly fault: 'none' | 'unknown-question'
}

// A generated run could keep every question free-text. This example is
// mandatory and answers one option through the public id, one free text, so
// no run can reach the gate without exercising the public option round trip.
const publicExamples: readonly [PublicScenario][] = [[{
  request: {
    method: 'item/tool/requestUserInput',
    params: {
      interactionId: 'native-public',
      isBlocking: true,
      questions: [
        { id: 'q1', question: 'Pick', options: [{ label: 'One' }] },
        { id: 'q2', question: 'Describe' }
      ]
    }
  },
  choices: [
    { mode: 'option', optionIndex: 0, text: '' },
    { mode: 'free', optionIndex: 0, text: 'my own words' }
  ],
  formContent: { count: 0, note: '', flag: false },
  fault: 'none'
}]]

/**
 * The public projection maps native option at index i to the public option at
 * the same index, so the round-trip oracle pairs them positionally: hop one
 * (nativeCodexInteractionResponse) sends a public option value back to its
 * native option id and passes free text through untouched; hop two
 * (encodeInteractionResponse) maps the native option id to its label via
 * nativeQuestionAnswers and again passes unknown values through.
 */
it('codex public option ids translate back to native ids and free text passes through', async () => {
  await checkAsync('codex public option ids translate back to native ids and free text passes through', fc.asyncProperty(
    fc.record({
      request: fc.oneof(
        fc.record({ method: fc.constant('item/tool/requestUserInput'), params: userInputParams }),
        fc.record({ method: fc.constant('mcpServer/elicitation/request'), params: elicitationParams })
      ),
      choices: choicesArb,
      formContent: fc.record({ count: fc.nat(99), note: freeText, flag: fc.boolean() }),
      fault: fc.constantFrom('none', 'unknown-question')
    }),
    async ({ request, choices, formContent, fault }) => {
      if (request.method === 'mcpServer/elicitation/request' && request.params.mode === 'url' && !request.params.url) return
      const interaction = parseInteraction(request.method, request.params)
      expect(interaction).toBeDefined()
      const pending: CodexInteractionRequest = { method: request.method, params: request.params, interaction: interaction! }
      const publicInteraction = toPublicInteraction(interaction!)

      if (fault === 'unknown-question') {
        // The public question ids are digests; 'bogus' never matches one.
        expect(() => nativeCodexInteractionResponse(
          { interactionId: publicInteraction.id, actionId: 'submit', answers: { bogus: 'x' } },
          interaction!
        )).toThrow('Codex interaction answer 对应未知 question')
        return
      }

      const answers: Record<string, string | string[]> = {}
      // Per question: the values sent on the public seam and the exact values
      // each hop must produce for them. Hop one preserves the answer's shape
      // (string in, string out; array in, array out), so expectations share it.
      const nativeIds: Record<string, string | string[]> = {}
      const labels: Record<string, string | string[]> = {}
      publicInteraction.questions.forEach((publicQuestion, index) => {
        const nativeQuestion = interaction!.questions[index]!
        const choice = choiceFor(choices, index)
        if (interaction!.kind === 'mcp-elicitation') {
          // The form question carries its JSON answer as free text; the native
          // wire receives the string untouched and parses it on encode.
          answers[publicQuestion.id] = JSON.stringify(formContent)
          nativeIds[nativeQuestion.id] = JSON.stringify(formContent)
          labels[nativeQuestion.id] = JSON.stringify(formContent)
          return
        }
        const option = nativeQuestion.options[choice.optionIndex]
        const publicOption = publicQuestion.options[choice.optionIndex]
        if (choice.mode === 'option' && option && publicOption) {
          answers[publicQuestion.id] = publicOption.value
          nativeIds[nativeQuestion.id] = option.id
          labels[nativeQuestion.id] = option.label
          return
        }
        const value = choice.text || 'free text'
        if (choice.mode === 'multi') {
          // Arrays map element-wise through both hops.
          const values = [option && publicOption ? publicOption.value : value, value]
          answers[publicQuestion.id] = values
          nativeIds[nativeQuestion.id] = values.map(entry =>
            entry === publicOption?.value && option ? option.id : entry)
          labels[nativeQuestion.id] = (nativeIds[nativeQuestion.id] as string[]).map(entry => translate(nativeQuestion, entry))
          return
        }
        answers[publicQuestion.id] = value
        // Free text is no public option value, so hop one passes it through;
        // hop two only relabels an exact native option id.
        nativeIds[nativeQuestion.id] = value
        labels[nativeQuestion.id] = translate(nativeQuestion, value)
      })

      const response = {
        interactionId: publicInteraction.id,
        actionId: 'submit',
        ...(Object.keys(answers).length ? { answers } : {})
      } as HarnessRespondRequest
      const nativeResponse = nativeCodexInteractionResponse(response, interaction!) as {
        readonly interactionId: string
        readonly actionId: string
        readonly answers?: Record<string, string | string[]>
      }
      expect(nativeResponse.interactionId).toBe(interaction!.id)
      // First hop: public values become native option ids (free text through).
      for (const [questionId, expected] of Object.entries(nativeIds)) {
        expect(nativeResponse.answers?.[questionId]).toEqual(expected)
      }
      // Second hop: native ids become the native answer labels on the wire;
      // the wire normalizes every answer to an array of strings.
      const wire = encodeInteractionResponse(pending, nativeResponse as JsonValue) as {
        readonly answers?: Record<string, { readonly answers: readonly string[] }>
      }
      if (interaction!.kind === 'user-input') {
        for (const [questionId, expected] of Object.entries(labels)) {
          expect(wire.answers?.[questionId]?.answers).toEqual(Array.isArray(expected) ? expected : [expected])
        }
      }
      // nativeQuestionAnswers agrees with the second hop for the same input.
      for (const [questionId, ids] of Object.entries(nativeIds)) {
        const sent = Array.isArray(ids) ? ids : [ids]
        const expected = labels[questionId]!
        expect(nativeQuestionAnswers(interaction!, questionId, sent))
          .toEqual(Array.isArray(expected) ? expected : [expected])
      }
    }
  ), 'parse native interaction → project public → answer via public option ids or free text → translate back to native ids → encode the native wire labels', budgetMs, samples, publicExamples)
}, timeout)
