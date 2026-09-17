import type {
  DeepReadonly,
  HarnessSessionStateAdapter,
  HarnessThreadOpenContext,
  JsonObject,
  JsonValue,
  PublicExecution,
  ThreadPublicObservation
} from '@openagent/contracts'

/** Test Plugin schema; production Core never interprets these fixture facts. */
export function testSessionStateWithObservation(
  state: DeepReadonly<JsonValue>,
  observation: ThreadPublicObservation
): JsonValue {
  const previous = testSessionState.project(state).latestExecution
  const history = state !== null && typeof state === 'object' && !Array.isArray(state)
    ? (state as DeepReadonly<JsonObject>).fixtureExecutions : undefined
  const fixtureExecutions: JsonObject = history && typeof history === 'object' && !Array.isArray(history)
    ? structuredClone(history) as JsonObject : {}
  if (previous) fixtureExecutions[previous.executionId] = structuredClone(previous) as unknown as JsonValue
  if (observation.latestExecution) fixtureExecutions[observation.latestExecution.executionId] = structuredClone(observation.latestExecution) as unknown as JsonValue
  return {
    ...(state !== null && typeof state === 'object' && !Array.isArray(state)
      ? structuredClone(state) as JsonObject
      : state === null ? {} : { fixturePayload: structuredClone(state) as JsonValue }),
    fixtureExecutions,
    fixtureObservation: structuredClone(observation) as unknown as JsonValue
  }
}

export const testSessionState: HarnessSessionStateAdapter = {
  resolveExecution(state, executionId) {
    const latest = testSessionState.project(state).latestExecution
    if (latest?.executionId === executionId) return latest
    const history = state !== null && typeof state === 'object' && !Array.isArray(state)
      ? (state as DeepReadonly<JsonObject>).fixtureExecutions : undefined
    const execution = history && typeof history === 'object' && !Array.isArray(history)
      ? (history as DeepReadonly<JsonObject>)[executionId] : undefined
    return execution ? structuredClone(execution) as unknown as PublicExecution : null
  },
  project(state) {
    const observation = state !== null && typeof state === 'object' && !Array.isArray(state)
      ? (state as DeepReadonly<JsonObject>).fixtureObservation
      : undefined
    return observation === undefined
      ? { latestExecution: null, backgroundWork: null }
      : structuredClone(observation) as unknown as ThreadPublicObservation
  },
  settle({ sessionState, executionId, outcome, finishedAt }) {
    const observation = testSessionState.project(sessionState)
    const execution = observation.latestExecution
    if (!execution || execution.executionId !== executionId ||
      execution.status === 'completed' || execution.status === 'failed' ||
      execution.status === 'interrupted') {
      return structuredClone(sessionState) as JsonValue
    }
    return testSessionStateWithObservation(sessionState, {
      ...observation,
      latestExecution: {
        executionId,
        status: outcome,
        startedAt: execution.startedAt,
        finishedAt: Math.max(finishedAt, execution.startedAt)
      }
    })
  }
}

export function commitTestObservation(
  context: Pick<HarnessThreadOpenContext, 'sessionState'>,
  observation: ThreadPublicObservation
): Promise<void> {
  return context.sessionState.commit(testSessionStateWithObservation(
    context.sessionState.read(),
    observation
  ))
}
