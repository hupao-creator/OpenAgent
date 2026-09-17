import type {
  BartMessage,
  BartToolOperation,
  BartTranscriptItem
} from '@openagent/contracts'
import type { JsonValue } from '@openagent/contracts'

interface AssistantTranscriptMutation {
  readonly messageId: string
  readonly executionId: string
  readonly createdAt: number
}

export type BartTranscriptMutation =
  | { readonly type: 'append-message'; readonly message: BartMessage }
  | {
      readonly type: 'append-tool-call'
      readonly operation: BartToolOperation
    }
  | ({ readonly type: 'append-text'; readonly delta: string } & AssistantTranscriptMutation)
  | ({ readonly type: 'append-reasoning'; readonly delta: string } & AssistantTranscriptMutation)
  | ({ readonly type: 'set-status'; readonly status: string | undefined } & AssistantTranscriptMutation)
  | ({ readonly type: 'set-error'; readonly message: string } & AssistantTranscriptMutation)
  | {
      readonly type: 'finish-execution'
      readonly executionId: string
      readonly status: Extract<BartMessage['status'], 'complete' | 'cancelled' | 'failed'>
    }
  | {
      readonly type: 'complete-tool-result'
      readonly operationId: string
      readonly executionId: string
      readonly callId: string
      readonly completedAt: number
      readonly result: JsonValue
      readonly isError?: boolean
    }

export function reduceBartTranscript(
  transcript: readonly BartTranscriptItem[],
  mutation: BartTranscriptMutation
): readonly BartTranscriptItem[] {
  if (mutation.type === 'append-message') {
    assertUniqueItemId(transcript, mutation.message.id)
    return [...transcript, mutation.message]
  }

  if (mutation.type === 'append-tool-call') {
    assertUniqueItemId(transcript, mutation.operation.id)
    if (transcript.some(
      (item) => item.type === 'tool-operation' && item.callId === mutation.operation.callId
    )) {
      throw new Error(`Bart tool call already exists: ${mutation.operation.callId}`)
    }
    if (mutation.operation.completedAt !== undefined || mutation.operation.result !== undefined) {
      throw new Error('A Bart tool call must be appended before its result')
    }
    return [...transcript, mutation.operation]
  }

  if (mutation.type === 'complete-tool-result') {
    const index = transcript.findIndex(
      (item) => item.type === 'tool-operation' && item.id === mutation.operationId
    )
    if (index < 0) throw new Error(`Bart tool operation not found: ${mutation.operationId}`)
    const operation = transcript[index]
    if (operation.type !== 'tool-operation') throw new Error('Bart transcript item is not a tool operation')
    if (
      operation.executionId !== mutation.executionId ||
      operation.callId !== mutation.callId
    ) {
      throw new Error('Bart tool result does not match its recorded call')
    }
    if (operation.completedAt !== undefined || operation.result !== undefined) {
      throw new Error(`Bart tool operation is already complete: ${mutation.operationId}`)
    }
    const completed: BartToolOperation = {
      ...operation,
      completedAt: mutation.completedAt,
      result: mutation.result,
      ...(mutation.isError ? { isError: true } : {})
    }
    return replaceAt(transcript, index, completed)
  }

  if (mutation.type === 'finish-execution') {
    let changed = false
    const next = transcript.map((item): BartTranscriptItem => {
      if (
        item.type !== 'message' ||
        item.role !== 'assistant' ||
        item.executionId !== mutation.executionId ||
        item.status !== 'streaming'
      ) return item
      changed = true
      return { ...item, status: mutation.status, statusLabel: undefined }
    })
    return changed ? next : transcript
  }

  if (mutation.type === 'set-status' || mutation.type === 'set-error') {
    const latestIndex = findLatestStreamingAssistant(transcript, mutation.executionId)
    if (latestIndex >= 0) {
      const latest = transcript[latestIndex]
      if (latest.type !== 'message') throw new Error('Bart transcript item is not a message')
      return reduceAssistantMessage(transcript, latestIndex, latest, mutation)
    }
    if (mutation.type === 'set-status' && mutation.status === undefined) return transcript
  }

  const tailIndex = transcript.length - 1
  const tail = transcript[tailIndex]
  if (
    tail?.type === 'message' &&
    tail.role === 'assistant' &&
    tail.executionId === mutation.executionId
  ) {
    if (
      tail.status !== 'streaming'
    ) {
      throw new Error(`Bart assistant message is already terminal: ${tail.id}`)
    }
    return reduceAssistantMessage(transcript, tailIndex, tail, mutation)
  }

  if (
    (mutation.type === 'append-text' || mutation.type === 'append-reasoning') &&
    mutation.delta.length === 0
  ) {
    return transcript
  }

  assertUniqueItemId(transcript, mutation.messageId)
  const message: BartMessage = {
    type: 'message',
    id: mutation.messageId,
    role: 'assistant',
    content: '',
    createdAt: mutation.createdAt,
    status: 'streaming',
    executionId: mutation.executionId
  }
  return reduceAssistantMessage([...transcript, message], transcript.length, message, mutation)
}

function reduceAssistantMessage(
  transcript: readonly BartTranscriptItem[],
  index: number,
  message: BartMessage,
  mutation: Exclude<
    BartTranscriptMutation,
    {
      type:
        | 'append-message'
        | 'append-tool-call'
        | 'complete-tool-result'
        | 'finish-execution'
    }
  >
): readonly BartTranscriptItem[] {
  if (message.status !== 'streaming') {
    throw new Error(`Bart assistant message is already terminal: ${message.id}`)
  }

  if (mutation.type === 'append-text') {
    if (mutation.delta.length === 0) return transcript
    return replaceAt(transcript, index, { ...message, content: message.content + mutation.delta })
  }
  if (mutation.type === 'append-reasoning') {
    if (mutation.delta.length === 0) return transcript
    return replaceAt(transcript, index, {
      ...message,
      reasoning: (message.reasoning || '') + mutation.delta
    })
  }
  if (mutation.type === 'set-status') {
    if (message.statusLabel === mutation.status) return transcript
    return replaceAt(transcript, index, { ...message, statusLabel: mutation.status })
  }
  if (mutation.type === 'set-error') {
    if (message.error === mutation.message) return transcript
    return replaceAt(transcript, index, { ...message, error: mutation.message })
  }
  return transcript
}

function findLatestStreamingAssistant(
  transcript: readonly BartTranscriptItem[],
  executionId: string
): number {
  return transcript.findLastIndex((item) =>
    item.type === 'message' &&
    item.role === 'assistant' &&
    item.executionId === executionId &&
    item.status === 'streaming'
  )
}

function assertUniqueItemId(transcript: readonly BartTranscriptItem[], id: string): void {
  if (transcript.some((item) => item.id === id)) {
    throw new Error(`Bart transcript item already exists: ${id}`)
  }
}

function replaceAt(
  transcript: readonly BartTranscriptItem[],
  index: number,
  item: BartTranscriptItem
): readonly BartTranscriptItem[] {
  const next = [...transcript]
  next[index] = item
  return next
}
