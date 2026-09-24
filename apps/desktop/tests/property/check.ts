import fc from 'fast-check'

// Only generated command arrays use this cap; mandatory race/fault skeletons stay intact.
export function sequenceLength(fallback: number): number {
  const raw = process.env.FC_MAX_COMMANDS
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new Error('FC_MAX_COMMANDS must be 1..1000')
  }
  return value
}

// Per-property budget. Interruption is a failure, never a silently partial pass.
export function parameters() {
  const integer = (name: string, fallback: number): number => {
    const raw = process.env[name]
    const value = raw === undefined ? fallback : Number(raw)
    if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${name}: ${raw}`)
    return value
  }
  const numRuns = integer('FC_RUNS', process.env.FC_EXPLORE ? 1000 : 100)
  if (numRuns < 1 || numRuns > 100_000) throw new Error('FC_RUNS must be 1..100000')
  const path = process.env.FC_PATH
  if (path !== undefined && process.env.FC_SEED === undefined) throw new Error('FC_PATH requires FC_SEED')
  return {
    numRuns,
    ...(process.env.FC_SEED === undefined ? {} : { seed: integer('FC_SEED', 0) }),
    ...(path === undefined ? {} : { path, endOnFailure: true }),
    interruptAfterTimeLimit: process.env.FC_EXPLORE ? 120_000 : 10_000,
    markInterruptAsFailure: true
  }
}

export function check<T>(name: string, property: fc.IProperty<T>, budgetMs?: number): void {
  report(name, fc.check(property, { ...parameters(), ...(budgetMs === undefined ? {} : { interruptAfterTimeLimit: budgetMs }) }))
}

export async function checkAsync<T>(name: string, property: fc.IAsyncProperty<T>, eventOrder = 'await each generated event in input order; explicit gates are described by the property', budgetMs?: number, sampleBudget = { normal: 30, explore: 1000 }): Promise<void> {
  const config = parameters()
  report(name, await fc.check(property, { ...config, ...(budgetMs === undefined ? {} : { interruptAfterTimeLimit: budgetMs }),
    numRuns: process.env.FC_RUNS ? config.numRuns : process.env.FC_EXPLORE ? sampleBudget.explore : sampleBudget.normal }), eventOrder)
}

function report<T>(name: string, result: fc.RunDetails<T>, eventOrder = 'synchronous, input order'): void {
  if (!result.failed) return
  const replay = { property: name, seed: result.seed, path: result.counterexamplePath,
    interrupted: result.interrupted, budgetMs: result.runConfiguration.interruptAfterTimeLimit,
    numRuns: result.runConfiguration.numRuns, completedRuns: result.numRuns, numShrinks: result.numShrinks, counterexample: result.counterexample,
    fastCheck: fc.__version, node: process.version, eventOrder: name === 'directory waiter ownership and generation fencing' ? 'join callers → cancel prefix → optional invalidate → optional stale completion → retry → stale completion → join retry → fresh completion → cached read → cleanup' : name === 'renderer gap recovery' ? 'subscribe → load A → hydrate A → receive B/C gap → load C → hydrate C → discard stale cue → unsubscribe' : name.startsWith('attachment ') ? 'setup → await counterexample operations in array order → final GC or invalid-index probe → finally remove sample directory' : eventOrder,
    maxCommands: process.env.FC_MAX_COMMANDS === undefined ? null : sequenceLength(1),
    explore: Boolean(process.env.FC_EXPLORE), replayPath: null }
  const mode = replay.explore ? 'FC_EXPLORE=1 ' : ''
  const length = replay.maxCommands === null ? '' : `FC_MAX_COMMANDS=${replay.maxCommands} `
  throw new Error(`Property failed: ${JSON.stringify(replay)}\nReplay: ${mode}${length}FC_RUNS=${result.runConfiguration.numRuns} FC_SEED=${result.seed} FC_PATH='${result.counterexamplePath ?? ''}' pnpm test:properties:replay -- -t '${name}'`, { cause: result.errorInstance })
}
