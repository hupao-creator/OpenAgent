import { DEFAULT_TIMEOUT_MS } from '../plan.mjs'

export const MODES = Object.freeze(['run', 'explore', 'replay', 'list'])

/**
 * `run`      short generated regression, the default.
 * `explore`  the same properties with a much larger sample budget.
 * `replay`   re-executes one recorded counterexample, and only that one.
 * `list`     prints what `run` would execute.
 */
export function parseArguments(values) {
  const parsed = {
    mode: 'run',
    properties: [],
    harnesses: [],
    host: undefined,
    samples: undefined,
    maxCommands: undefined,
    seed: undefined,
    path: undefined,
    replayPath: undefined,
    failureSignature: undefined,
    artifactsDir: undefined,
    timeoutMs: Number(process.env.OPENAGENT_ACCEPTANCE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    workers: 'auto',
    keep: false,
    help: false
  }
  const positional = []
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--') continue
    if (value === '--property') parsed.properties.push(requiredArgument(values, ++index, value))
    else if (value === '--harness') parsed.harnesses.push(requiredArgument(values, ++index, value))
    else if (value === '--host') parsed.host = requiredArgument(values, ++index, value)
    else if (value === '--samples') parsed.samples = integer(requiredArgument(values, ++index, value), value)
    else if (value === '--max-commands') parsed.maxCommands = integer(requiredArgument(values, ++index, value), value)
    else if (value === '--seed') parsed.seed = integer(requiredArgument(values, ++index, value), value)
    else if (value === '--path') parsed.path = String(requiredArgument(values, ++index, value))
    else if (value === '--replay-path') parsed.replayPath = String(requiredArgument(values, ++index, value))
    else if (value === '--failure-signature') parsed.failureSignature = requiredArgument(values, ++index, value)
    else if (value === '--artifacts-dir') parsed.artifactsDir = requiredArgument(values, ++index, value)
    else if (value === '--timeout-ms') parsed.timeoutMs = integer(requiredArgument(values, ++index, value), value)
    else if (value === '--workers') {
      const raw = requiredArgument(values, ++index, value)
      parsed.workers = raw === 'auto' ? 'auto' : integer(raw, '--workers')
    } else if (value === '--keep') parsed.keep = true
    else if (value === '--help' || value === '-h') parsed.help = true
    else if (value.startsWith('--')) throw new Error(`Unknown argument: ${value}`)
    else positional.push(value)
  }
  if (positional.length > 1) throw new Error(`Unexpected arguments: ${positional.slice(1).join(', ')}`)
  if (positional.length === 1) {
    if (!MODES.includes(positional[0])) {
      throw new Error(`Unknown mode: ${positional[0]} (expected ${MODES.join(', ')})`)
    }
    parsed.mode = positional[0]
  }
  if (parsed.mode === 'list') parsed.list = true
  if (parsed.timeoutMs < 10_000) throw new Error('--timeout-ms must be an integer >= 10000')
  if (parsed.workers !== 'auto' && (parsed.workers < 1 || parsed.workers > 16)) {
    throw new Error('--workers must be "auto" or an integer between 1 and 16')
  }
  if (parsed.mode === 'replay') {
    if (!parsed.host || parsed.host === 'auto') throw new Error('replay requires a concrete --host')
    // A replay is only faithful when it reproduces the recorded value stream and
    // the recorded generator configuration, so both are mandatory.
    for (const name of ['seed', 'path', 'samples', 'maxCommands', 'failureSignature', 'replayPath']) {
      if (parsed[name] === undefined) throw new Error(`replay requires --${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`)
    }
    if (parsed.properties.length !== 1 || parsed.harnesses.length !== 1 || parsed.properties[0] === 'all') {
      throw new Error('replay requires exactly one --property and one --harness')
    }
  }
  return parsed
}

function integer(raw, flag) {
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${flag} requires an integer, received ${raw}`)
  return value
}

function requiredArgument(values, index, flag) {
  const value = values[index]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}
