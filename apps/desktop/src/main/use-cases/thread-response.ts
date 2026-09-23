import {
  PublicResponseAnswersSchema,
  PublicResponseMessageSchema,
  type HarnessRespondRequest
} from '@openagent/contracts'

export type { ThreadInteractionResponseRequest as ThreadResponseCommand } from '@openagent/contracts'

/** Validated command boundary for explicit user replies to Agent and Bart Threads. */
export function normalizeThreadResponse(value: unknown): {
  readonly threadId: string
  readonly response: HarnessRespondRequest
} {
  if (!record(value)) throw new Error('Thread response 必须是 object')
  const allowed = new Set(['threadId', 'interactionId', 'actionId', 'answers', 'message'])
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length) throw new Error(`Thread response 包含未知字段：${unknown.join(', ')}`)
  const threadId = identifier(value.threadId, 'threadId')
  const interactionId = identifier(value.interactionId, 'interactionId')
  const actionId = identifier(value.actionId, 'actionId')
  const answers = value.answers === undefined ? undefined : PublicResponseAnswersSchema.parse(value.answers)
  for (const id of Object.keys(answers ?? {})) identifier(id, 'answer id')
  const message = PublicResponseMessageSchema.parse(value.message)
  return {
    threadId,
    response: {
      interactionId,
      actionId,
      ...(answers === undefined ? {} : { answers }),
      ...(message === undefined ? {} : { message })
    }
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 128 || /[\s\0]/.test(value)) {
    throw new Error(`${label} 无效`)
  }
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
