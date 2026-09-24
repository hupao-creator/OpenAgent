import fc from 'fast-check'
import { errorSummary } from '../support.mjs'
import { failureSignature } from './report.mjs'

/** Colon paths ignore numRuns: stop before fast-check visits a sibling value. */
export class ReplayAttempt {
  attempted = false
  passed = false

  async run(operation) {
    if (this.attempted) throw new fc.PreconditionFailure(true)
    this.attempted = true
    await operation()
    this.passed = true
  }
}

/** Freeze the first oracle identity before allowing fast-check to shrink it. */
export class FailureTracker {
  constructor({ original = null, signature = null } = {}) {
    this.original = original
    this.signature = signature ?? failureSignature(original)
    this.accepted = false
    this.diagnostics = []
    this.fatal = null
    this.fatalEvidence = null
  }

  consider(error, evidence) {
    const signature = failureSignature(error)
    if (!this.signature && !this.original && signature) this.signature = signature
    if (signature && signature === this.signature) {
      this.original ??= error
      this.accepted = true
      return 'accept'
    }
    this.diagnostics.push({ error: errorSummary(error), signature, ...evidence })
    // Before accepting the recorded replay, a different error means
    // it did not reproduce. Infrastructure faults also stop further attempts.
    if (!signature || !this.accepted) {
      this.fatal = error
      this.fatalEvidence = evidence
      return 'interrupt'
    }
    return 'skip'
  }

  stop(error, evidence) {
    this.diagnostics.push({ error: errorSummary(error), signature: failureSignature(error), ...evidence })
    this.fatal ??= error
    this.fatalEvidence ??= evidence
  }

  /** Keep an observed oracle even when this same attempt also fails teardown. */
  considerAttempt(primary, cleanup, evidence) {
    const verdict = primary ? this.consider(primary, evidence) : null
    for (const error of cleanup) this.stop(error, evidence)
    return verdict === 'accept' ? verdict : this.fatal ? 'interrupt' : verdict
  }
}
