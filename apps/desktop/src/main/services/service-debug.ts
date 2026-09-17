import { createDebugTrace, getDebugContext, startDebugSpan, withDebugContext, debugError } from '@openagent/plugin-kit/main'
type DebugContext = ReturnType<typeof createDebugTrace>

export function ensureDebugContext(
  fields: Partial<DebugContext>
): DebugContext {
  const current = getDebugContext()
  return current.traceId
    ? { ...current, ...fields }
    : createDebugTrace(fields)
}

export async function runServiceDebugSpan<Result>(
  event: string,
  fields: Record<string, unknown>,
  operation: () => Promise<Result>,
  contextFields: Partial<DebugContext> = {}
): Promise<Result> {
  const context = ensureDebugContext({
    threadId: typeof fields.threadId === 'string' ? fields.threadId : undefined,
    executionId: typeof fields.executionId === 'string' ? fields.executionId : undefined,
    harnessId: typeof fields.harnessId === 'string' ? fields.harnessId : undefined,
    ...contextFields
  })
  const span = withDebugContext(context, () => startDebugSpan(event, fields))
  try {
    const result = await withDebugContext(span.context, operation)
    span.end()
    return result
  } catch (error) {
    debugError(`${event}.failed`, error, fields)
    span.fail(error, fields)
    throw error
  }
}
