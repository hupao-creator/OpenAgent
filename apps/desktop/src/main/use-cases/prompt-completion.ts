import type { AgentThreadRecord, DeepReadonly, HarnessPromptCompleteRequest, HarnessPromptCompleteResult, JsonValue } from '@openagent/contracts'

export type PromptCompleter = (
  harnessId: string,
  request: HarnessPromptCompleteRequest<never>,
  sourceThread?: DeepReadonly<AgentThreadRecord>
) => Promise<HarnessPromptCompleteResult>

export function promptResultValue(result: HarnessPromptCompleteResult): JsonValue {
  if (result.output.type === 'json') return result.output.value
  throw new Error('json_schema Prompt Completion 必须返回 JSON output')
}
