import { PUBLIC_OBSERVATION_LIMITS, type DeepReadonly, type JsonValue, type HarnessSessionStateAdapter } from '@openagent/contracts'
import type { HarnessBartForeground } from '@openagent/contracts/renderer'
import type { PiSessionState } from './types.js'

const TOOL_NAME_CHARACTERS = 1_024
const CALL_ID_CHARACTERS = 1_024
const REASONING_CHARACTERS = 1_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function isBoundedNonEmpty(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
}

function isForeground(value: unknown): value is HarnessBartForeground {
  if (!isRecord(value) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) {
    return false
  }
  if (value.kind === 'assistant-text') {
    return hasOnlyKeys(value, ['sequence', 'kind'])
  }
  if (value.kind === 'reasoning') {
    return hasOnlyKeys(value, ['sequence', 'kind', 'text']) &&
      isBoundedNonEmpty(value.text, REASONING_CHARACTERS)
  }
  if (value.kind === 'tool-call') {
    return hasOnlyKeys(value, ['sequence', 'kind', 'callId', 'toolName']) &&
      isBoundedNonEmpty(value.callId, CALL_ID_CHARACTERS) &&
      isBoundedNonEmpty(value.toolName, TOOL_NAME_CHARACTERS)
  }
  return false
}

function isExecutionForeground(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ['executionId', 'foreground']) &&
    isBoundedNonEmpty(value.executionId, 1_024) &&
    isForeground(value.foreground)
}

export function piState(value: DeepReadonly<JsonValue>): PiSessionState {
  if (value === null) return { version: 1, messages: [], executions: [], latestExecutionId: null }
  if (typeof value !== 'object' || Array.isArray(value) || !('version' in value) || value.version !== 1 ||
    !('messages' in value) || !('executions' in value) || !Array.isArray(value.messages) || !Array.isArray(value.executions)) throw new Error('Invalid Pi session state')
  if ('foregrounds' in value && value.foregrounds !== undefined &&
    (!Array.isArray(value.foregrounds) || !value.foregrounds.every(isExecutionForeground))) {
    throw new Error('Invalid Pi session state')
  }
  return structuredClone(value) as unknown as PiSessionState
}
export function piJson(state: PiSessionState): JsonValue { return state as unknown as JsonValue }
export function piLastAssistantText(state: PiSessionState, executionId: string): string {
  const message = state.messages.findLast(m => m.executionId === executionId && m.role === 'assistant')
  return message?.text.replaceAll('\0', '').slice(0, PUBLIC_OBSERVATION_LIMITS.summary) || ''
}
export const piSessionAdapter: HarnessSessionStateAdapter = {
  project(value) {
    const state = piState(value)
    return { latestExecution: state.executions.find(e => e.executionId === state.latestExecutionId) ?? null, backgroundWork: null }
  },
  resolveExecution(value, id) { return piState(value).executions.find(e => e.executionId === id) ?? null },
  settle({ sessionState, executionId, outcome, finishedAt }) {
    const state = piState(sessionState)
    const summary = piLastAssistantText(state, executionId)
    state.executions = state.executions.map(e => e.executionId === executionId &&
      (e.status === 'running' || e.status === 'waiting-for-user')
      ? { executionId, startedAt: e.startedAt, status: outcome, finishedAt: Math.max(e.startedAt, finishedAt),
        ...(summary ? { summary } : {}) } : e)
    return piJson(state)
  }
}
