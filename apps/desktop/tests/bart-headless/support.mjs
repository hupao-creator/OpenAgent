import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted'])
export function latestExecution(thread) {
  return thread?.observation?.latestExecution || undefined
}

export function findThread(state, threadId) {
  return state.threads.find(candidate => candidate.id === threadId)
}

export function bartThread(state) {
  return state.threads.find(thread => thread.bart === true)
}

export function toolOperations(state) {
  return (bartThread(state)?.transcript || [])
    .filter(entry => entry.type === 'tool-operation')
}

export function isTerminal(execution) {
  return Boolean(execution) && TERMINAL_STATUSES.has(execution.status)
}

/**
 * Snapshot polling and the mutation stream can both miss an intermediate
 * commit, so ordered observations are only ever asserted as a subsequence.
 */
export function assertSubsequence(actual, expected, message) {
  let cursor = 0
  for (const value of actual) {
    if (value === expected[cursor]) cursor += 1
    if (cursor === expected.length) return
  }
  assert.fail(
    `${message}: expected subsequence ${JSON.stringify(expected)} in ${JSON.stringify(actual)}`
  )
}

export async function assertMissing(path, label = 'path') {
  try {
    await stat(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`${label} existed when it must not: ${path}`)
}

export function assertRecord(value, label) {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`
  )
}

export function requiredString(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.ok(value.trim(), `${label} must not be empty`)
  return value
}

export function bounded(value, limit = 4_000) {
  const text = JSON.stringify(value)
  if (typeof text !== 'string') return String(value)
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * The errors a report has to show. An `AggregateError` that wraps a failure and
 * a cleanup failure carries no reason in its own message, and a single-line
 * summary that stops at it hides exactly what needs fixing, so descend into
 * aggregate members and `cause` chains and report each leaf.
 */
export function errorLeaves(error, seen = new Set()) {
  const nestable = error instanceof Error
  const members = error instanceof AggregateError ? [...error.errors] : []
  if (nestable && error.cause !== undefined && error.cause !== null && !members.includes(error.cause)) {
    members.push(error.cause)
  }
  if (!members.length) return [error]
  const leaves = []
  for (const member of members) {
    if (member instanceof Error) {
      if (seen.has(member)) continue
      seen.add(member)
    }
    leaves.push(...errorLeaves(member, seen))
  }
  return leaves
}

export function errorMessage(error) {
  const leaves = errorLeaves(error)
  if (leaves.length === 1) {
    const [leaf] = leaves
    return leaf instanceof Error ? leaf.stack || leaf.message : String(leaf)
  }
  return leaves.map((leaf, index) =>
    `[${index + 1}/${leaves.length}] ${leaf instanceof Error ? leaf.stack || leaf.message : String(leaf)}`
  ).join('\n')
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function containsToken(text, token) {
  return new RegExp(escapeRegExp(token)).test(text || '')
}

export function assertContainsToken(text, token, message) {
  assert.match(text || '', new RegExp(escapeRegExp(token)), message)
}

export function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** The single-line form used in the run summary; the worker log keeps the stack. */
export function errorSummary(error, limit = 300) {
  const text = errorLeaves(error)
    .map(leaf => leaf instanceof Error ? leaf.message : String(leaf))
    .join(' | ')
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed
}
