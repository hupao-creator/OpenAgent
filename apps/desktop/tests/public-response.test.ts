import { expect, it } from 'vitest'
import { parseHarnessRespondRequest, PublicResponseAnswersSchema, PublicResponseMessageSchema, MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS } from '@openagent/contracts'
import { normalizeThreadResponse } from '../src/main/use-cases/thread-response'

it('shares response structure and empty message normalization across runtime and use case', () => {
  const response = { interactionId: 'interaction-1', actionId: 'submit', answers: { q: ['one', 'two'] }, message: '' }
  const runtime = parseHarnessRespondRequest(response)
  expect(normalizeThreadResponse({ threadId: 'thread-1', ...response }).response).toEqual(runtime)
  expect(runtime.message).toBeUndefined()
  response.answers.q.push('three')
  expect(runtime.answers).toEqual({ q: ['one', 'two'] })
})

it('rejects invalid answers and UTF-16 feedback overflow consistently', () => {
  for (const answers of [{ q: 1 }, { ' ': 'answer' }, { q: [undefined] }]) {
    const response = { interactionId: 'i', actionId: 'a', answers }
    expect(PublicResponseAnswersSchema.safeParse(answers).success).toBe(false)
    expect(() => parseHarnessRespondRequest(response)).toThrow()
    expect(() => normalizeThreadResponse({ threadId: 't', ...response })).toThrow()
  }
  const message = '😀'.repeat(MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS / 2)
  expect(PublicResponseMessageSchema.parse(message)).toBe(message)
  for (const invalid of [message + 'a', 'a\0b']) {
    const response = { interactionId: 'i', actionId: 'a', message: invalid }
    expect(() => parseHarnessRespondRequest(response)).toThrow()
    expect(() => normalizeThreadResponse({ threadId: 't', ...response })).toThrow()
  }
})

it('preserves literal answer keys without changing the result prototype', () => {
  const answers = JSON.parse('{"__proto__":"literal","constructor":"answer"}')
  const parsed = PublicResponseAnswersSchema.parse(answers)
  expect(Object.hasOwn(parsed, '__proto__')).toBe(true)
  expect(parsed['__proto__']).toBe('literal')
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
  expect(PublicResponseAnswersSchema.safeParse(JSON.parse('{"__proto__":1}')).success).toBe(false)
})
