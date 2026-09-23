import type { JsonValue, ThreadPublicObservation } from '@openagent/contracts'

/** Cumulative native-shaped histories; no runtime, credentials or user data. */
export function createPiBenchmarkFixture(text: string, threadId: string, phase: 'running' | 'completed', history: number) {
  const executions = Array.from({ length: history }, (_, index) => ({
    executionId: `${threadId}-run-${index}`, startedAt: 1_000 + index * 2,
    ...(index === history - 1 && phase === 'running' ? { status: 'running' as const }
      : { status: 'completed' as const, finishedAt: 1_001 + index * 2 }),
    summary: index === history - 1 ? text : `Historical answer ${index}`
  }))
  const latest = executions.at(-1)!
  const messages = executions.flatMap((execution, index) => [
    { id: `${execution.executionId}-user`, executionId: execution.executionId, role: 'user', text: `Inspect rendering ${index}` },
    { id: `${execution.executionId}-assistant`, executionId: execution.executionId, role: 'assistant', model: 'fixture-model', provider: 'fixture',
      text: index === history - 1 ? text : `## Result ${index}\n\n${'Historical text with stable content. '.repeat(60)}` }
  ])
  return { sessionState: { version: 1, messages, executions, latestExecutionId: latest.executionId } as unknown as JsonValue,
    observation: { latestExecution: latest, backgroundWork: null } satisfies ThreadPublicObservation }
}
