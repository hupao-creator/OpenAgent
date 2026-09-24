import assert from 'node:assert/strict'

/**
 * Effective-operation and reached-state coverage, counted per phase.
 *
 * `fc.commands` silently skips commands whose `check(model)` is false, so a run
 * can "pass" while almost nothing ran. Coverage is therefore counted from
 * commands that actually executed, and the runner requires minimum reach so a
 * vacuous sample cannot masquerade as a pass.
 *
 */
export function createCoverage(property, phase) {
  return { property, phase, executed: {}, reached: new Set(), samples: 0, emptySamples: 0 }
}

/** Commands retain this object across clones; reset its fields, not its identity. */
export function resetCoverage(coverage) {
  coverage.executed = {}
  coverage.reached = new Set()
}

/** Count exactly one actual attempt, including one that failed before a command. */
export function recordAttempt(total, attempt) {
  total.samples += 1
  if (Object.values(attempt.executed).every(count => count === 0)) total.emptySamples += 1
  for (const [kind, count] of Object.entries(attempt.executed)) {
    total.executed[kind] = (total.executed[kind] ?? 0) + count
  }
  reach(total, ...attempt.reached)
}

export function countExecution(coverage, kind) {
  coverage.executed[kind] = (coverage.executed[kind] ?? 0) + 1
}

export function reach(coverage, ...states) {
  for (const state of states) coverage.reached.add(state)
}

/**
 * `emptySamples` counts generated samples that executed no command at all. They
 * still booted a real Electron process and are reported so that a run cannot
 * look productive while most of its samples did nothing.
 */
export function summarizeCoverage(coverage, totals = {}) {
  const commandsExecuted = Object.values(coverage.executed).reduce((sum, value) => sum + value, 0)
  return {
    property: coverage.property,
    phase: coverage.phase,
    samples: totals.samples ?? coverage.samples,
    emptySamples: totals.emptySamples ?? coverage.emptySamples,
    commandsExecuted,
    byKind: Object.fromEntries(Object.entries(coverage.executed).sort(([a], [b]) => a.localeCompare(b))),
    reached: [...coverage.reached].sort()
  }
}

/**
 * A coverage shortfall is a test failure, not a warning: the point of the PBT is
 * to reach the required states in generated samples. Shrinking and replay
 * cannot satisfy a generated-sample requirement.
 */
export function assertCoverage(coverage, { kinds = {}, states = [] }, label) {
  const missingKinds = Object.entries(kinds).filter(([kind, minimum]) =>
    (coverage.executed[kind] ?? 0) < minimum)
  const missingStates = states.filter(state => !coverage.reached.has(state))
  const problems = [
    ...missingKinds.map(([kind, minimum]) =>
      `${kind} ran ${coverage.executed[kind] ?? 0} times, need ${minimum}`),
    ...missingStates.map(state => `never reached ${state}`)
  ]
  assert.equal(
    problems.length,
    0,
    `${label} (${coverage.phase}): ${problems.join('; ')} — executed=${JSON.stringify(coverage.executed)} ` +
    `reached=${[...coverage.reached].join(',')}`
  )
}

/** One line describing what a phase executed and reached, for the item report. */
export function describeCoverage(measured) {
  const kinds = Object.entries(measured.byKind).map(([kind, count]) => `${kind}:${count}`).join(' ')
  const empty = measured.emptySamples === null ? '' : `, ${measured.emptySamples}/${measured.samples} sample(s) executed nothing`
  return `${measured.commandsExecuted} command(s)${empty} [${kinds || 'none'}]`
}
