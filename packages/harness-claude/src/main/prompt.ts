import type { HarnessPromptCompleteRequest, HarnessPromptCompleteResult } from '@openagent/contracts'
import { isJsonValue, type JsonObject, type JsonValue } from '@openagent/contracts'
import { type ClaudePromptSettings } from '../shared/settings.js'
import { runClaudePrompt } from './runtime/transport.js'
import { debugDetail, startDebugSpan } from './debug.js'
import { type ClaudeMainContext } from './types.js'
import { throwIfAborted } from './runtime/cancellation.js'
import { resolveClaudeEnvironment } from './runtime/environment.js'
export async function completeClaudePrompt(
  context: ClaudeMainContext,
  request: HarnessPromptCompleteRequest<ClaudePromptSettings>
): Promise<HarnessPromptCompleteResult> {
  throwIfAborted(request.signal)
  const cwd = context.temporaryWorkspaceRoot || process.cwd()
  const resolved = await resolveClaudeEnvironment(
    context,
    cwd,
    request.settings?.executablePath,
    request.signal,
    'prompt'
  )
  const { executable, environment } = resolved
  throwIfAborted(request.signal)
  const systemPrompt = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const prompt = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}:\n${message.content}`)
    .join('\n\n')
  const schema =
    request.outputFormat.type === 'json_schema'
      ? (request.outputFormat.schema as JsonObject)
      : undefined
  const promptSpan = startDebugSpan('claude.prompt.completion', {
    harnessId: 'claude',
    purpose: 'prompt',
    cwd,
    ...(request.settings?.model ? { model: request.settings.model } : {}),
    ...(request.settings?.effort ? { effort: request.settings.effort } : {})
  })
  debugDetail('claude.prompt.input', {
    harnessId: 'claude',
    purpose: 'prompt',
    prompt,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(schema ? { schema } : {})
  })
  let result: Awaited<ReturnType<typeof runClaudePrompt>>
  try {
    result = await runClaudePrompt({
      executable,
      cwd,
      environment,
              providerInjection: context.providers?.explicit?.injection,
      prompt,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(request.settings?.model ? { model: request.settings.model } : {}),
      ...(request.settings?.effort ? { effort: request.settings.effort } : {}),
      ...(schema ? { schema } : {}),
      signal: request.signal
    })
    promptSpan.end({ outcome: result.failed ? 'failed' : 'completed' })
  } catch (error) {
    promptSpan.fail(error)
    throw error
  }
  if (request.outputFormat.type === 'text') {
    return {
      output: { type: 'text', text: result.text },
      finishReason: result.failed ? 'other' : 'stop'
    }
  }
  const value = jsonOutput(result.value, result.text)
  return {
    output: { type: 'json', value },
    finishReason: result.failed ? 'other' : 'stop'
  }
}

function jsonOutput(value: unknown, text: string): JsonValue {
  if (isJsonValue(value)) return value
  try {
    const parsed = JSON.parse(text) as unknown
    if (isJsonValue(parsed)) return parsed
  } catch {
    // Product schema validation will report the non-JSON output precisely.
  }
  throw new Error('Claude 未返回有效 JSON')
}
