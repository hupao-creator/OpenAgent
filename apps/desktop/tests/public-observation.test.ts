import { describe, expect, it } from 'vitest'
import {
  isPublicInteraction,
  isThreadPublicObservation,
  parseThreadPublicObservation,
  PUBLIC_OBSERVATION_LIMITS,
  type ThreadPublicObservation
} from '@openagent/contracts'
import {
  createOpenAgentState,
  readHarnessThread,
  reduceOpenAgentState
} from '../src/shared/openagent-state'
import { createDefaultOpenAgentSettings } from '../src/shared/openagent-settings'

function observation() {
  return {
    latestExecution: {
      executionId: 'execution-1',
      startedAt: 1,
      status: 'waiting-for-user' as const,
      summary: 'Working',
      interactions: [{
        id: 'interaction-1',
        kind: 'question' as const,
        title: 'Input requested',
        description: 'Details',
        actions: [{ id: 'submit', intent: 'submit' as const, label: 'Submit' }],
        questions: [{
          id: 'answer', prompt: 'Choose', header: 'Choice', multiple: false,
          allowOther: true, secret: false,
          options: [{ value: 'yes', label: 'Yes', description: 'Proceed' }]
        }]
      }]
    },
    backgroundWork: null
  }
}

type MutableObservation = ReturnType<typeof observation>
const fields = [
  ['executionId', PUBLIC_OBSERVATION_LIMITS.identifier, (o: MutableObservation, v: string) => { o.latestExecution.executionId = v }],
  ['summary', PUBLIC_OBSERVATION_LIMITS.summary, (o: MutableObservation, v: string) => { o.latestExecution.summary = v }],
  ['interaction id', PUBLIC_OBSERVATION_LIMITS.identifier, (o: MutableObservation, v: string) => { o.latestExecution.interactions[0].id = v }],
  ['title', PUBLIC_OBSERVATION_LIMITS.title, (o: MutableObservation, v: string) => { o.latestExecution.interactions[0].title = v }],
  ['description', PUBLIC_OBSERVATION_LIMITS.description, (o: MutableObservation, v: string) => { o.latestExecution.interactions[0].description = v }],
  ['action id', PUBLIC_OBSERVATION_LIMITS.identifier, (o: MutableObservation, v: string) => { o.latestExecution.interactions[0].actions[0].id = v }],
  ['action label', PUBLIC_OBSERVATION_LIMITS.actionLabel, (o: MutableObservation, v: string) => { o.latestExecution.interactions[0].actions[0].label = v }],
  ['question id', PUBLIC_OBSERVATION_LIMITS.identifier, (o: MutableObservation, v: string) => { o.latestExecution.interactions[0].questions[0].id = v }],
  ['prompt', PUBLIC_OBSERVATION_LIMITS.prompt, (o: MutableObservation, v: string) => { o.latestExecution.interactions[0].questions[0].prompt = v }],
  ['header', PUBLIC_OBSERVATION_LIMITS.header, (o: MutableObservation, v: string) => { o.latestExecution.interactions[0].questions[0].header = v }],
  ['option value', PUBLIC_OBSERVATION_LIMITS.optionValue, (o: MutableObservation, v: string) => { o.latestExecution.interactions[0].questions[0].options[0].value = v }],
  ['option label', PUBLIC_OBSERVATION_LIMITS.optionLabel, (o: MutableObservation, v: string) => { o.latestExecution.interactions[0].questions[0].options[0].label = v }],
  ['option description', PUBLIC_OBSERVATION_LIMITS.optionDescription, (o: MutableObservation, v: string) => { o.latestExecution.interactions[0].questions[0].options[0].description = v }]
] as const

function persist(value: unknown): ThreadPublicObservation {
  const state = createOpenAgentState({
    bartThreadId: 'bart-1', hostHarnessId: 'codex', bartThreadSettings: {},
    bartCwd: '/workspace', createdAt: 1, selectedThreadId: null, settings: createDefaultOpenAgentSettings()
  })
  return readHarnessThread(reduceOpenAgentState(state, {
    type: 'replace-thread-session-state', threadId: 'bart-1', expectedRevision: 0,
    sessionState: { persisted: 'boundary' },
    observation: value as ThreadPublicObservation, updatedAt: 2
  }), 'bart-1').observation
}

function expectBoundaryParity(value: unknown, accepted: boolean): void {
  expect(isThreadPublicObservation(value)).toBe(accepted)
  if (accepted) {
    expect(parseThreadPublicObservation(value)).toEqual(value)
    expect(persist(value)).toEqual(value)
  } else {
    expect(() => parseThreadPublicObservation(value)).toThrow()
    expect(() => persist(value)).toThrow()
  }
}

describe('Public observation contract and persistence parity', () => {
  it.each(fields)('shares the %s limit at ingestion and persistence', (_name, maximum, set) => {
    const atLimit = observation()
    set(atLimit, 'a'.repeat(maximum))
    expectBoundaryParity(atLimit, true)
    const overLimit = observation()
    set(overLimit, 'a'.repeat(maximum + 1))
    expectBoundaryParity(overLimit, false)
    const nul = observation()
    set(nul, 'a\0b')
    expectBoundaryParity(nul, false)
  })

  it('uses UTF-16 limits consistently for non-ASCII input', () => {
    const value = observation()
    value.latestExecution.interactions[0].questions[0].prompt =
      '😀'.repeat(PUBLIC_OBSERVATION_LIMITS.prompt / 2)
    expectBoundaryParity(value, true)
    value.latestExecution.interactions[0].questions[0].prompt += '😀'
    expectBoundaryParity(value, false)
  })

  it('enforces terminal bounds, timestamp ordering, closed fields and unique identities', () => {
    const completed = {
      latestExecution: { executionId: 'execution-1', startedAt: 2, status: 'completed', finishedAt: 2 },
      backgroundWork: { status: 'running' }
    }
    expectBoundaryParity(completed, true)
    expectBoundaryParity({ ...completed, latestExecution: { ...completed.latestExecution, finishedAt: 1 } }, false)
    const failed = { ...completed, latestExecution: { ...completed.latestExecution, status: 'failed', error: 'e'.repeat(PUBLIC_OBSERVATION_LIMITS.error) } }
    expectBoundaryParity(failed, true)
    expectBoundaryParity({ ...failed, latestExecution: { ...failed.latestExecution, error: failed.latestExecution.error + 'e' } }, false)
    expectBoundaryParity({ ...failed, latestExecution: { ...failed.latestExecution, error: 'a\0b' } }, false)
    expectBoundaryParity({ ...completed, nativeData: {} }, false)
    expectBoundaryParity({ latestExecution: null, backgroundWork: null }, true)
    expectBoundaryParity({ latestExecution: null, backgroundWork: { status: 'running' } }, true)
    const duplicate = observation()
    duplicate.latestExecution.interactions.push(structuredClone(duplicate.latestExecution.interactions[0]))
    expectBoundaryParity(duplicate, false)
    const invalidIdentifier = observation()
    invalidIdentifier.latestExecution.executionId = 'native/id'
    expectBoundaryParity(invalidIdentifier, false)
    const missingText = observation()
    missingText.latestExecution.interactions[0].questions[0].prompt = '  '
    expectBoundaryParity(missingText, false)
  })

  it('validates standalone interactions and returns a detached boundary value', () => {
    const source = observation()
    expect(isPublicInteraction(source.latestExecution.interactions[0])).toBe(true)
    expect(isPublicInteraction({ ...source.latestExecution.interactions[0], nativeData: {} })).toBe(false)
    const detached = parseThreadPublicObservation(source)
    source.latestExecution.interactions[0].questions[0].prompt = 'Changed by plugin'
    expect(detached).not.toEqual(source)
  })
})

it('keeps UTF-16 ceilings for astral characters and rejects unsafe objects before reading getters', () => {
  const value = observation()
  value.latestExecution.interactions[0].title = '😀'.repeat(PUBLIC_OBSERVATION_LIMITS.title / 2)
  expectBoundaryParity(value, true)
  value.latestExecution.interactions[0].title += 'a'
  expectBoundaryParity(value, false)
  let reads = 0
  const unsafe = Object.defineProperty({}, 'latestExecution', { enumerable: true, get() { reads++; return null } })
  expectBoundaryParity(unsafe, false)
  expect(reads).toBe(0)
})
