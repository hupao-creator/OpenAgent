import type {
  BartThreadRecord,
  BartToolOperation
} from '@openagent/contracts'
import type { JsonValue } from '@openagent/contracts'
import { isHarnessId, type HarnessId } from '../../shared/harnesses'

export type BartVisualOperationKind =
  | 'list'
  | 'start'
  | 'send'
  | 'read'
  | 'status'
  | 'interrupt'
  | 'delete'

/**
 * Core-owned visual projection of Bart's own Thread tools. It is intentionally
 * independent of Harness-native events and exists only to drive the historical
 * Dock/Overview choreography.
 */
export interface BartVisualOperation {
  readonly id: string
  readonly kind: BartVisualOperationKind
  readonly phase: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly threadId?: string
  readonly title?: string
  readonly prompt?: string
  readonly harnessId?: HarnessId
}

export function projectBartVisualOperations(
  transcript: BartThreadRecord['transcript']
): BartVisualOperation[] {
  const currentExecutionId = [...transcript]
    .reverse()
    .find((item) => item.executionId)?.executionId
  if (!currentExecutionId) return []
  return transcript.flatMap((item) => {
    if (
      item.type !== 'tool-operation' ||
      item.executionId !== currentExecutionId
    ) return []
    const kind = visualKind(item.name)
    if (!kind) return []
    const arguments_ = jsonObject(item.arguments)
    const result = jsonObject(item.result)
    const threadId = stringField(arguments_, 'threadId') ||
      stringField(result, 'threadId')
    const prompt = stringField(arguments_, 'prompt')
    const title = stringField(result, 'title') || stringField(arguments_, 'title')
    const harnessId = harnessField(arguments_, 'harnessId')
    return [{
      id: item.id,
      kind,
      phase: operationPhase(item),
      ...(threadId ? { threadId } : {}),
      ...(prompt ? { prompt } : {}),
      ...(title ? { title } : {}),
      ...(harnessId ? { harnessId } : {})
    }]
  })
}

/**
 * Whether a canonical tool name owns a dedicated Dock route. The generic tool
 * fallback must not also paint a call that already has its own choreography.
 * It answers for the name only; the route itself stays driven by its audit
 * operation id, never by matching a specific call.
 */
export function isDedicatedBartTool(name: string): boolean {
  return visualKind(name) !== undefined
}

function visualKind(name: string): BartVisualOperationKind | undefined {
  switch (name) {
    case 'openagent_thread_list': return 'list'
    case 'openagent_thread_start': return 'start'
    case 'openagent_thread_send':
    case 'openagent_thread_respond': return 'send'
    case 'openagent_thread_read': return 'read'
    case 'openagent_thread_status': return 'status'
    case 'openagent_thread_interrupt': return 'interrupt'
    case 'openagent_thread_delete': return 'delete'
    default: return undefined
  }
}

function operationPhase(
  operation: BartToolOperation
): BartVisualOperation['phase'] {
  if (operation.completedAt === undefined) return 'running'
  return operation.isError ? 'failed' : 'completed'
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined
}

function stringField(
  value: Record<string, JsonValue> | undefined,
  key: string
): string | undefined {
  const field = value?.[key]
  return typeof field === 'string' && field.trim() ? field : undefined
}

function harnessField(
  value: Record<string, JsonValue> | undefined,
  key: string
): HarnessId | undefined {
  const field = stringField(value, key)
  return isHarnessId(field) ? field : undefined
}
