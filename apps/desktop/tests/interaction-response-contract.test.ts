import { describe, expect, it } from 'vitest'
import {
  AUTO_INTERVENTION_OUTPUT_SCHEMA,
  parseAutoInterventionOutput
} from '../src/main/internal-runs'
import type { JsonObject } from '@openagent/contracts'
import { MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS } from '@openagent/contracts'

describe('provider-neutral interaction response contract', () => {
  it('publishes the same bounded message in the strict structured-output schema', () => {
    const response = (AUTO_INTERVENTION_OUTPUT_SCHEMA.properties as JsonObject)
      .response as JsonObject
    const objectBranch = (response.anyOf as JsonObject[])[0]!
    const properties = objectBranch.properties as JsonObject

    expect(properties.message).toEqual({
      anyOf: [{ type: 'string', maxLength: MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS }, { type: 'null' }]
    })
    expect(objectBranch.additionalProperties).toBe(false)
  })

  it('parses opaque feedback without interpreting Plugin action semantics', () => {
    expect(parseAutoInterventionOutput({
      decision: 'respond',
      response: {
        interactionId: 'public-interaction',
        actionId: 'public-action',
        answers: [{ key: 'choices', value: ['second', 'first', 'second'] }],
        message: 'Use the read-only operation instead.'
      },
      reason: 'The user previously requested a read-only alternative.'
    })).toEqual({
      respond: true,
      response: {
        interactionId: 'public-interaction',
        actionId: 'public-action',
        answers: { choices: ['second', 'first', 'second'] },
        message: 'Use the read-only operation instead.'
      },
      reason: 'The user previously requested a read-only alternative.'
    })
  })

  it('normalizes empty feedback away and rejects non-current or unsafe shapes', () => {
    const decision = (response: JsonObject): JsonObject => ({
      decision: 'respond',
      response: { answers: null, message: null, ...response },
      reason: 'Test strict response parsing.'
    })
    expect(parseAutoInterventionOutput(decision({
      interactionId: 'public-interaction',
      actionId: 'public-action',
      message: ''
    }))).toMatchObject({
      response: {
        interactionId: 'public-interaction',
        actionId: 'public-action'
      }
    })
    expect(parseAutoInterventionOutput(decision({
      interactionId: 'public-interaction',
      actionId: 'public-action',
      message: ''
    })).response).not.toHaveProperty('message')
    expect(() => parseAutoInterventionOutput(decision({
      interactionId: 'public-interaction',
      actionId: 'public-action',
      message: 'x'.repeat(MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS + 1)
    }))).toThrow('message 无效')
    expect(() => parseAutoInterventionOutput(decision({
      interactionId: 'public-interaction',
      actionId: 'public-action',
      message: 'unsafe\0feedback'
    }))).toThrow('message 无效')
    expect(() => parseAutoInterventionOutput(decision({
      interactionId: 'public-interaction',
      actionId: 'public-action',
      nativeFeedback: 'legacy field'
    }))).toThrow('字段无效')
    expect(() => parseAutoInterventionOutput(decision({
      interactionId: 'public-interaction',
      actionId: 'public-action',
      answers: {}
    }))).toThrow('字段无效')
  })
})
