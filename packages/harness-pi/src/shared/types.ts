import type { PublicExecution } from '@openagent/contracts'
import type { HarnessBartForeground } from '@openagent/contracts/renderer'

export interface PiThreadOptions {
  provider?: string
  model?: string
  thinkingLevel?: string
}
/** Resolved Harness-owned settings; executablePath is never a public Thread option. */
export interface PiThreadSettings extends PiThreadOptions {
  executablePath?: string
}
export type PiThreadSettingsUpdate = { [K in keyof PiThreadOptions]?: string | null }
export interface PiHarnessSettings {
  threadSettings: PiThreadOptions
  /** False while the settings page shows these Thread defaults for editing. */
  useDefaultThreadSettings?: boolean
}
export interface PiModel {
  provider: string
  id: string
  name: string
  reasoning: boolean
  thinkingLevels?: string[]
}
export interface PiSettingsPresentation {
  cli: { status: 'ready' | 'unavailable'; executablePath?: string; version?: string; message?: string }
  models: PiModel[]
}
export interface PiMessage {
  id: string
  executionId: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  thinking?: string
  toolName?: string
  isError?: boolean
  /** Confirmed snapshot from a successful native todo result, including an empty clear. */
  todos?: PiTodo[]
  model?: string
  provider?: string
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number }
}
export interface PiTodo {
  id: number
  text: string
  done: boolean
}
/** Foreground semantic activity of one Execution, maintained where native events are accepted. */
export interface PiExecutionForeground {
  executionId: string
  foreground: HarnessBartForeground
}
export interface PiSessionState {
  version: 1
  sessionFile?: string
  /** Native JSONL snapshot at the last idle boundary, for deterministic forks. */
  nativeSessionJsonl?: string
  /** Deferred native clone; a fork never opens the source for writing. */
  forkSource?: { jsonl: string }
  messages: PiMessage[]
  executions: PublicExecution[]
  latestExecutionId: string | null
  /** Absent until an Execution accepts a foreground event; a new Execution starts clean. */
  foregrounds?: PiExecutionForeground[]
}
