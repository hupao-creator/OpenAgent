import type { JsonValue } from '@openagent/contracts'
import type { HarnessToolBinding } from '@openagent/contracts'
import type { BartTranscriptMutation } from './transcript'
import { cloneBoundedJsonValue } from './json'
import {
  createDebugTrace,
  debugDetail,
  debugError,
  getDebugContext,
  startDebugSpan,
  withDebugContext
} from '@openagent/plugin-kit/main'

type DebugContext = ReturnType<typeof createDebugTrace>

export const BART_TOOL_VALUE_MAX_BYTES = 8 * 1024 * 1024
const BART_TOOL_ERROR_MAX_CHARACTERS = 8 * 1024

export interface BartToolExecutionBinding {
  readonly threadId: string
  readonly executionId: string
  readonly signal: AbortSignal
  /** Captured owner context; follow-ups must not replace it. */
  readonly debugContext?: DebugContext
}

export function createRecordedHarnessToolBinding(input: {
  readonly binding: HarnessToolBinding
  readonly threadId: string
  readonly threadSignal: AbortSignal
  readonly currentExecution: () => BartToolExecutionBinding | null
  readonly createCallId: () => string
  readonly createOperationId: () => string
  readonly now: () => number
  readonly recordTranscript: (mutation: BartTranscriptMutation) => Promise<void>
}): HarnessToolBinding {
  return {
    name: input.binding.name,
    description: input.binding.description,
    inputSchema: input.binding.inputSchema,
    ...(input.binding.outputSchema === undefined
      ? {}
      : { outputSchema: input.binding.outputSchema }),
    async execute(request): Promise<JsonValue> {
      input.threadSignal.throwIfAborted()
      request.signal.throwIfAborted()

      const execution = input.currentExecution()
      if (!execution) throw new Error(`Bart tool ${input.binding.name} has no active execution`)
      if (execution.threadId !== input.threadId) {
        throw new Error(`Bart tool ${input.binding.name} belongs to a replaced Thread`)
      }
      execution.signal.throwIfAborted()

      const executionContext = execution.debugContext ?? ensureDebugContext({
        threadId: execution.threadId,
        executionId: execution.executionId
      })
      const span = withDebugContext(executionContext, () => startDebugSpan(
        'bart.tool',
        {
          name: input.binding.name,
          threadId: execution.threadId,
          executionId: execution.executionId
        }
      ))

      // Native harness call ids are transport correlation tokens. They can be
      // recycled after a native session restart and need not satisfy the
      // persisted state identifier contract, so mint both persisted ids here.
      try {
        return await withDebugContext(span.context, async () => {
          const callId = createBoundaryId(input.createCallId, 'tool call')
          const operationId = createBoundaryId(input.createOperationId, 'tool operation')
          const argumentsValue = cloneBoundedJsonValue(
            request.arguments,
            `Arguments for Bart tool ${input.binding.name}`,
            BART_TOOL_VALUE_MAX_BYTES
          )
          const createdAt = boundaryTimestamp(input.now(), 'tool start')
          debugDetail('bart.tool.input', {
            name: input.binding.name,
            threadId: execution.threadId,
            executionId: execution.executionId,
            callId,
            operationId,
            arguments: argumentsValue
          })
          await input.recordTranscript({
            type: 'append-tool-call',
            operation: {
              type: 'tool-operation',
              id: operationId,
              executionId: execution.executionId,
              callId,
              name: input.binding.name,
              arguments: argumentsValue,
              createdAt
            }
          })

          const signal = AbortSignal.any([
            request.signal,
            execution.signal,
            input.threadSignal
          ])
          let result: JsonValue
          try {
            signal.throwIfAborted()
            result = cloneBoundedJsonValue(
              await input.binding.execute({
                callId,
                arguments: argumentsValue,
                signal
              }),
              `Result from Bart tool ${input.binding.name}`,
              BART_TOOL_VALUE_MAX_BYTES
            )
          } catch (error) {
            const failureResult: JsonValue = {
              error: errorMessage(error).slice(0, BART_TOOL_ERROR_MAX_CHARACTERS)
            }
            try {
              await input.recordTranscript({
                type: 'complete-tool-result',
                operationId,
                executionId: execution.executionId,
                callId,
                completedAt: Math.max(createdAt, boundaryTimestamp(input.now(), 'tool failure')),
                result: failureResult,
                isError: true
              })
            } catch (recordError) {
              throw new AggregateError(
                [error, recordError],
                `Bart tool ${input.binding.name} failed and its terminal operation could not be recorded`
              )
            }
            debugDetail('bart.tool.failure-result', {
              name: input.binding.name,
              threadId: execution.threadId,
              executionId: execution.executionId,
              callId,
              operationId,
              result: failureResult
            })
            throw error
          }
          await input.recordTranscript({
            type: 'complete-tool-result',
            operationId,
            executionId: execution.executionId,
            callId,
            completedAt: Math.max(createdAt, boundaryTimestamp(input.now(), 'tool completion')),
            result
          })
          debugDetail('bart.tool.result', {
            name: input.binding.name,
            threadId: execution.threadId,
            executionId: execution.executionId,
            callId,
            operationId,
            result
          })
          span.end({ outcome: 'completed', callId, operationId })
          return result
        })
      } catch (error) {
        debugError('bart.tool.failed', error, {
          name: input.binding.name,
          threadId: execution.threadId,
          executionId: execution.executionId
        })
        span.fail(error, {
          name: input.binding.name,
          threadId: execution.threadId,
          executionId: execution.executionId
        })
        throw error
      }
    }
  }
}

function createBoundaryId(create: () => string, label: string): string {
  const value = create()
  if (
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new Error(`Invalid Bart ${label} id`)
  }
  return value
}

function boundaryTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid Bart ${label} timestamp`)
  }
  return value
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return typeof error === 'string' ? error : 'Bart tool execution failed'
}

function ensureDebugContext(fields: Partial<DebugContext>): DebugContext {
  const current = getDebugContext()
  return current.traceId
    ? { ...current, ...fields }
    : createDebugTrace(fields)
}
