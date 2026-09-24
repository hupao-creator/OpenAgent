import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { errorSummary, shellQuote } from '../support.mjs'

/**
 * Everything needed to reproduce one failing sample without the original run:
 * the fast-check value-stream coordinates, the generator configuration that
 * shaped the stream, the shrunk operation sequence, the recorded gate order, the
 * native CLI versions, and the per-sample artifacts on disk.
 */
export function counterexampleDescriptor(input) {
  const { definition, target, host, result, budget, artifacts, gateOrder = [], cliVersions = {} } = input
  const commands = result.counterexample?.[0]
  const rendered = commands === undefined ? null : String(commands)
  // fast-check 4 reports a thrown failure as `errorInstance`. An interruption
  // can retain an earlier failure, or have no verdict when no oracle failed.
  const failure = result.errorInstance ?? null
  const interrupted = result.interrupted === true
  const signature = failureSignature(failure)
  const interruption = input.interruption ?? `the ${budget.timeLimitMs}ms time limit was reached`
  return {
    failureSignature: signature,
    rejectedAttempts: input.rejectedAttempts ?? [],
    property: definition.name,
    target,
    host,
    interrupted,
    seed: result.seed,
    path: result.counterexamplePath ?? null,
    replayPath: rendered === null ? null : extractReplayPath(rendered),
    numRuns: budget.samples,
    completedRuns: result.numRuns ?? null,
    numShrinks: result.numShrinks ?? null,
    maxCommands: budget.maxCommands,
    operationSequence: rendered === null ? [] : operationSequence(rendered),
    error: interrupted
      ? signature
        ? `${errorSummary(failure)}; shrinking stopped before completion: ${interruption}`
        : `the run stopped without a property verdict: ${interruption}`
      : failure === null
        ? 'the property returned false without throwing'
        : errorSummary(failure),
    detail: failure instanceof Error ? failure.stack ?? failure.message : String(failure ?? ''),
    fastCheck: fc.__version,
    node: process.version,
    cliVersions,
    gateOrder,
    artifacts
  }
}

/**
 * `CommandsIterable#toString()` appends a trailing block comment carrying the
 * replay path, so the minimal operation sequence and the replay path share one
 * string.
 */
export function extractReplayPath(rendered) {
  const match = rendered.match(/\/\*replayPath=(.*)\*\/\s*$/)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

export function operationSequence(rendered) {
  return rendered.replace(/\s*\/\*.*\*\/\s*$/, '').split(',').map(entry => entry.trim()).filter(Boolean)
}

/**
 * The copy-pasteable replay. It pins every input that shaped the failing value:
 * the property and target selection, the sample and command budget, and the
 * fast-check coordinates.
 */
export function replayCommand(descriptor) {
  const parts = [
    'node tests/bart-headless-pbt.mjs replay',
    `--property ${descriptor.property}`,
    `--harness ${descriptor.target}`,
    `--host ${descriptor.host}`,
    `--samples ${descriptor.numRuns}`,
    `--max-commands ${descriptor.maxCommands}`,
    `--seed ${descriptor.seed}`,
    `--path ${shellQuote(String(descriptor.path ?? ''))}`
  ]
  if (descriptor.failureSignature) parts.push(`--failure-signature ${descriptor.failureSignature}`)
  if (descriptor.replayPath) parts.push(`--replay-path ${shellQuote(descriptor.replayPath)}`)
  return parts.join(' ')
}

export function formatFailure(descriptor) {
  const lines = [
    descriptor.interrupted
      ? `PBT run stopped: ${descriptor.property} on ${descriptor.target} (host ${descriptor.host})`
      : `PBT property failed: ${descriptor.property} on ${descriptor.target} (host ${descriptor.host})`
  ]
  // A retained counterexample is useful after interruption, but is not minimal.
  if (!descriptor.interrupted && descriptor.failureSignature) {
    lines.push(
      `  minimal operation sequence (${descriptor.operationSequence.length} commands, ` +
      `${descriptor.numShrinks ?? 0} shrink step(s)): ${descriptor.operationSequence.join(' -> ')}`
    )
  } else if (descriptor.interrupted && descriptor.failureSignature) {
    lines.push(`  retained failing sequence (shrinking incomplete): ${descriptor.operationSequence.join(' -> ')}`)
  }
  lines.push(
    `  gate order: ${descriptor.gateOrder.length
      ? descriptor.gateOrder.map(entry => `${entry.event}(${entry.marker}@${entry.elapsedMs}ms)`).join(' -> ')
      : 'none (this sample did not park a native turn)'}`,
    `  error: ${descriptor.error}`,
    `  native CLIs: ${Object.entries(descriptor.cliVersions).map(([id, version]) => `${id}=${version ?? 'unknown'}`).join(', ')}`,
    `  artifacts: ${descriptor.artifacts.sampleRoot ?? 'none'}`
  )
  for (const attempt of descriptor.rejectedAttempts ?? []) {
    lines.push(`  rejected attempt: ${attempt.error}; artifacts: ${attempt.sampleRoot}`)
  }
  lines.push(descriptor.failureSignature
      ? `Replay: ${replayCommand(descriptor)}`
      : 'Replay: not applicable — no reproducible property verdict was obtained')
  return lines.join('\n')
}

export function failureSignature(error) {
  if (!(error instanceof Error) || !['commands', 'native-evidence'].includes(error.pbtPhase)) return null
  if (!error.invariantId) return null
  return createHash('sha256').update(`pbt:v1:${error.invariantId}`).digest('hex').slice(0, 24)
}
