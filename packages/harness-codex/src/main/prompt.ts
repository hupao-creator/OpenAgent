import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isJsonValue } from '@openagent/contracts'
import type {
  HarnessPromptApi,
  HarnessPromptCompleteRequest,
  HarnessPromptCompleteResult
} from '@openagent/contracts'
import type { CodexPromptSettings, CodexThreadSettings } from '../shared/types.js'
import type { CodexTurnHandle } from './runtime/app-server.js'
import type { CodexRuntime } from './runtime/index.js'
import { debugDetail } from './debug.js'

export function createCodexPromptApi(
  runtime: CodexRuntime
): HarnessPromptApi<CodexPromptSettings> {
  return {
    complete: (request) => completeCodexPrompt(runtime, request)
  }
}

async function completeCodexPrompt(
  runtime: CodexRuntime,
  request: HarnessPromptCompleteRequest<CodexPromptSettings>
): Promise<HarnessPromptCompleteResult> {
  if (request.signal.aborted) throw abortError()
  await mkdir(runtime.context.dataRoot, { recursive: true })
  if (request.signal.aborted) throw abortError()
  const settings = request.settings || {}
  const composedPrompt = formatMessages(request.messages)
  debugDetail('codex.prompt.input', {
    harnessId: 'codex',
    purpose: 'prompt',
    messages: request.messages,
    composedPrompt
  })
  const acquired = await runtime.server(
    runtime.context.dataRoot,
    settings.executablePath,
    request.signal,
    'prompt'
  )
  try {
    if (request.signal.aborted) throw abortError()
    let streamedAnswer = ''
    let finalAnswer: string | undefined
    let failure: string | undefined
    let outcome: 'completed' | 'failed' | 'interrupted' | undefined
    let finish!: () => void
    const completion = new Promise<void>((resolve) => { finish = resolve })
    let handle: CodexTurnHandle | undefined
    const abort = (): void => {
      outcome = 'interrupted'
      finish()
      void handle?.cancel().catch(() => undefined)
    }
    request.signal.addEventListener('abort', abort, { once: true })
    try {
      try {
        if (request.signal.aborted) throw abortError()
        handle = await acquired.server.startTurn({
          executionId: randomUUID(),
          cwd: runtime.context.dataRoot,
          inputs: [{
            type: 'text',
            text: composedPrompt,
            text_elements: []
          }],
          settings: {
            ...promptThreadSettings(settings),
            approvalPolicy: 'never',
            sandbox: 'read-only',
            ephemeral: true,
            ...(request.outputFormat.type === 'json_schema'
              ? { outputSchema: request.outputFormat.schema }
              : {})
          },
          toolMode: 'exclusive',
          admissionSignal: request.signal,
          signal: request.signal,
          emit(event) {
            if (event.type === 'text-delta') streamedAnswer += event.delta
            else if (event.type === 'text-final') {
              finalAnswer = event.displayText || event.text
            }
            else if (event.type === 'interaction-opened') {
              failure = `Codex Prompt Completion requires user input: ${event.interaction.title}`
              outcome = 'failed'
              finish()
              void handle?.cancel().catch(() => undefined)
            } else if (event.type === 'error') {
              failure = event.message
            } else if (event.type === 'done') {
              outcome = event.outcome
              finish()
            }
          }
        })
        if (request.signal.aborted) abort()
        await completion
      } catch (error) {
        if (request.signal.aborted) throw abortError()
        throw error
      }
    } finally {
      request.signal.removeEventListener('abort', abort)
    }
    if (request.signal.aborted) throw abortError()
    if (outcome !== 'completed') throw new Error(failure || `Codex Prompt Completion ${outcome}`)
    const answer = finalAnswer || streamedAnswer
    if (request.outputFormat.type === 'text') {
      return { output: { type: 'text', text: answer }, finishReason: 'stop' }
    }
    let value: unknown
    try {
      value = JSON.parse(answer)
    } catch (error) {
      throw new Error(`Codex Prompt Completion 返回无效 JSON：${errorMessage(error)}`)
    }
    if (!isJsonValue(value)) {
      throw new Error('Codex Prompt Completion 返回的 JSON 不是有限 JSON value')
    }
    return {
      output: { type: 'json', value },
      finishReason: 'stop'
    }
  } finally {
    await acquired.server.dispose()
  }
}

function promptThreadSettings(settings: CodexPromptSettings): CodexThreadSettings {
  return {
    ...(settings.executablePath ? { executablePath: settings.executablePath } : {}),
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    ...(settings.serviceTier ? { serviceTier: settings.serviceTier } : {})
  }
}

function formatMessages(
  messages: HarnessPromptCompleteRequest<CodexPromptSettings>['messages']
): string {
  return messages.map((message) =>
    `<${message.role}>\n${message.content}\n</${message.role}>`
  ).join('\n\n')
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
