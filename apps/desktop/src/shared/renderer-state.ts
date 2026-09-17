import { createDefaultOpenAgentSettings } from './openagent-settings'
import type { RendererAppState } from './renderer-state-contracts'

export function createInitialRendererState(defaultCwd: string): RendererAppState {
  return {
    revision: 0,
    defaultCwd,
    threads: [],
    executions: [],
    reports: [],
    selectedThreadId: null,
    settings: createDefaultOpenAgentSettings()
  }
}
