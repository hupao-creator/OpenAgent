import { emptyClaudeThreadState, parseClaudeThreadState, type ClaudeThreadState } from '../shared/state.js'
import { errorMessage } from './values.js'

export function decodeThreadState(value: unknown):
  | { readonly state: ClaudeThreadState }
  | { readonly error: string } {
  try {
    return { state: decodeClaudeRendererState(value) }
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

export function threadStateStatus(value: unknown):
  | { readonly status: 'empty' }
  | { readonly status: 'bound' }
  | { readonly status: 'invalid' } {
  try {
    return decodeClaudeRendererState(value).primarySessionId
      ? { status: 'bound' }
      : { status: 'empty' }
  } catch {
    return { status: 'invalid' }
  }
}

export function decodeClaudeRendererState(value: unknown): ClaudeThreadState {
  // `null` is the current Core-to-Plugin handshake before a newly created
  // Thread publishes its first Plugin-owned state. Every non-null value must
  // satisfy the exact current Claude schema; no legacy shape is accepted.
  if (value === null) return emptyClaudeThreadState()
  if (value === undefined) throw new Error('Claude sessionState 无效')
  return parseClaudeThreadState(value)
}
