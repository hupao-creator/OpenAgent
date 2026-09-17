import { check } from '../invariant.mjs'
import { bounded } from '../support.mjs'

/**
 * The independent expected model. It holds only public facts and identities the
 * real tool results returned — never product internals, and never a value copied
 * out of the observation it is compared against.
 *
 * `status` is either an exact public status, the class `'terminal'` when the
 * product may legitimately choose any terminal state, or null.
 */
export const TERMINAL = 'terminal'
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted'])

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status)
}

export function newThread(key, extra = {}) {
  return {
    key,
    threadId: null,
    executionId: null,
    status: null,
    archived: false,
    deleted: false,
    // Native permission bookkeeping: identities observed on the public surface.
    interactionId: null,
    consumedInteractionId: null,
    proofPath: null,
    token: null,
    marker: null,
    // Every steer marker this Thread's live Execution was sent, oldest first.
    steerMarkers: [],
    ...extra
  }
}

export function publicExpectation(entry) {
  if (entry.deleted) return { exists: false }
  return {
    exists: true,
    archived: entry.archived,
    executionId: entry.executionId,
    status: entry.status
  }
}

export function statusMatches(expected, actual) {
  if (expected === null) return actual === null || actual === undefined
  if (expected === TERMINAL) return isTerminal(actual)
  return expected === actual
}

/** Asserts committed renderer state still equals the independently derived model. */
export function assertPublicObservation(label, observed, entry) {
  const expected = publicExpectation(entry)
  if (!expected.exists) {
    check.equal('observation.deleted-absent', observed.exists, false, `${label}: deleted Thread is still committed`)
    return
  }
  check.equal('observation.thread-present', observed.exists, true, `${label}: committed Thread disappeared`)
  check.equal('observation.archived', observed.archived, expected.archived, `${label}: archived diverged`)
  if (expected.executionId === null) {
    check.equal('observation.no-invented-execution', observed.latestExecution, null, `${label}: unexpected Execution ${bounded(observed.latestExecution)}`)
    return
  }
  check.ok('observation.execution-present', observed.latestExecution, `${label}: latest Execution is missing`)
  check.equal('observation.execution-id',
    observed.latestExecution.executionId,
    expected.executionId,
    `${label}: latest Execution is not the expected one — ${bounded(observed.latestExecution)}`
  )
  check.ok('observation.status',
    statusMatches(expected.status, observed.latestExecution.status),
    `${label}: status ${observed.latestExecution.status} does not satisfy ${expected.status}`
  )
}

/** Number of ordered observations recorded for one Agent Thread so far. */
export function transitionMark(client, threadId) {
  return (client.transitionLog.get(threadId) || []).length
}

/**
 * A committed observation may never present a superseded Execution as the
 * Thread's latest one again: that is exactly "a late result overwrote the
 * successor".
 */
export function assertExecutionNeverReturned(client, threadId, staleExecutionId, sinceMark, label) {
  const tail = (client.transitionLog.get(threadId) || []).slice(sinceMark)
  const regression = tail.find(entry => entry.executionId === staleExecutionId)
  check.equal('history.superseded-execution-absent',
    regression,
    undefined,
    `${label}: superseded Execution ${staleExecutionId} became latest again — ${bounded(regression)}`
  )
}

/** No ordered observation after `sinceMark` may report one of `statuses`. */
export function assertStatusNeverAppeared(client, threadId, statuses, sinceMark, label) {
  const forbidden = new Set(statuses)
  const tail = (client.transitionLog.get(threadId) || []).slice(sinceMark)
  const found = tail.find(entry => entry.status !== undefined && forbidden.has(entry.status))
  check.equal('history.forbidden-status-absent',
    found,
    undefined,
    `${label}: observed ${bounded(found)} after it was ruled out`
  )
}
