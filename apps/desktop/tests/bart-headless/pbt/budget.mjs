/**
 * Sample and time budgets for the headless PBT.
 *
 * The fixed property tests in `tests/property` use a 10 second interruption
 * limit because every sample is an in-process call. A headless sample boots a
 * real Electron process and real native CLIs, so it needs a much larger limit.
 */

/**
 * Per-sample allowance for the whole batch time budget, not an individual
 * sample timeout. The runner aborts execution at the batch deadline and awaits
 * the active attempt's cleanup before producing a verdict.
 */
export const DEFAULT_SAMPLE_FLOOR_MS = 60_000

/**
 * The short regression is a fixed-seed regression, not an exploration: every
 * run generates the same sequences, so its coverage requirement is a property of
 * the generator that either holds or does not, and a failure names one
 * reproducible sequence. Discovery is what the exploration budget is for, and it
 * draws a fresh seed every run. `--seed`/`PBT_SEED` overrides either one.
 *
 * This value is a fixture choice, in the same sense as the sample count: it was
 * picked after measuring generated reach across candidate seeds, so that the
 * short regression's generated phase (not only its checkpoints) reaches each
 * property's required operations and states.
 */
export const SHORT_REGRESSION_SEED = 218006

/**
 * The standalone runner enables defaultSizeToMaxWhenMaxSpecified, so the
 * command ceiling also controls generated lengths (the library otherwise caps
 * them at its default size). Exploration runs complete batches of 40 samples,
 * adding at most three more batches when generated coverage is incomplete.
 * Every batch has recorded replay coordinates; checkpoint counts cannot help
 * meet that coverage, and exhausting the batch ceiling is a failure.
 */
export function pbtParameters(environment = process.env, requested = {}) {
  const explore = requested.explore ?? Boolean(environment.PBT_EXPLORE)
  const integer = (name, fallback) => {
    const raw = environment[name]
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
    return value
  }
  const samples = requested.samples ?? integer('PBT_SAMPLES', explore ? 40 : 6)
  const maxCommands = requested.maxCommands ?? integer('PBT_MAX_COMMANDS', explore ? 24 : 6)
  if (samples < 1 || samples > 100_000) throw new Error('PBT_SAMPLES must be 1..100000')
  if (maxCommands < 1 || maxCommands > 64) throw new Error('PBT_MAX_COMMANDS must be 1..64')
  const seed = requested.seed ?? (environment.PBT_SEED === undefined
    ? (explore ? undefined : SHORT_REGRESSION_SEED)
    : Number(environment.PBT_SEED))
  const path = requested.path ?? environment.PBT_PATH
  if (seed !== undefined && !Number.isSafeInteger(seed)) throw new Error('PBT_SEED must be an integer')
  if (path !== undefined && seed === undefined) throw new Error('PBT_PATH requires PBT_SEED')
  const perSampleMs = integer('PBT_SAMPLE_BUDGET_MS', DEFAULT_SAMPLE_FLOOR_MS)
  return {
    explore,
    samples,
    maxBatches: explore ? 4 : 1,
    maxCommands,
    seed,
    path,
    replayPath: requested.replayPath ?? environment.PBT_REPLAY_PATH,
    perSampleMs,
    timeLimitMs: Math.max(5 * 60_000, samples * perSampleMs)
  }
}

/** fast-check configuration derived from the budget, mirroring `tests/property/check.ts`. */
export function runConfiguration(budget, { replay = false } = {}) {
  return {
    numRuns: replay ? 1 : budget.samples,
    ...(budget.seed === undefined ? {} : { seed: budget.seed }),
    ...(budget.path === undefined ? {} : { path: budget.path }),
    // Replay verifies the selected counterexample without shrinking it again.
    ...((replay || budget.path !== undefined) ? { endOnFailure: true } : {}),
    // Never use fast-check's interruptAfterTimeLimit for native async work: it
    // races the property promise and can return before its cleanup finishes.
    // An interrupted exploration is a failure, never a silently partial pass.
    markInterruptAsFailure: true
  }
}
