import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import fc from 'fast-check'
import { DEFAULT_TIMEOUT_MS, loadRunConfig } from '../plan.mjs'
import { HARNESS_IDS, HOST_HARNESS_IDS, provider } from '../providers.mjs'
import { errorSummary } from '../support.mjs'
import { parseArguments } from './argv.mjs'
import { pbtParameters, runConfiguration, SHORT_REGRESSION_SEED } from './budget.mjs'
import { assertCoverage, createCoverage, describeCoverage, summarizeCoverage, resetCoverage, recordAttempt } from './coverage.mjs'
import { FailureTracker, ReplayAttempt } from './failures.mjs'
import { ExecutionDeadline } from './deadline.mjs'
import { HostSelection } from './hosts.mjs'
import { driveCheckpoint, PROPERTY_NAMES, selectProperties, supportsProperty } from './properties.mjs'
import { counterexampleDescriptor, formatFailure, failureSignature, operationSequence, checkpointReproduced, checkpointFailureDescriptor } from './report.mjs'
import { checkpointCommands } from './checkpoints.mjs'
import { openPbtSession } from './session.mjs'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const repositoryRoot = resolve(desktopRoot, '../..')
const electronMain = join(desktopRoot, 'out/main/index.js')
const run = promisify(execFile)

export async function main(argv, { signal } = {}) {
  // fast-check otherwise caps generated arrays at its default size (10), even
  // when maxCommands is larger. This standalone runner uses the declared ceiling.
  fc.configureGlobal({ defaultSizeToMaxWhenMaxSpecified: true })
  const cli = parseArguments(argv)
  if (cli.help) {
    printHelp()
    return 0
  }
  const budget = pbtParameters(process.env, {
    explore: cli.mode === 'explore' ? true : undefined,
    samples: cli.samples,
    maxCommands: cli.maxCommands,
    seed: cli.seed,
    path: cli.path,
    replayPath: cli.replayPath
  })
  // The Bart host is a real native CLI; the Mock only replaces the external LLM.
  const config = await loadRunConfig(desktopRoot, { provider: 'mock', config: undefined })
  const items = planItems(cli)
  const hostSelection = new HostSelection(cli.host, config, items.map(item => item.target).filter(Boolean))
  const host = hostSelection.requested

  if (cli.mode === 'list') {
    printPlan(items, budget, host)
    return 0
  }
  if (process.platform === 'win32') {
    throw new Error('Bart headless PBT currently requires a POSIX shell')
  }
  if (!existsSync(electronMain)) {
    throw new Error(`Missing ${electronMain}; run pnpm --dir apps/desktop build first`)
  }

  const artifactsDir = cli.artifactsDir ? resolve(cli.artifactsDir)
    : join(homedir(), 'Developer', 'OpenAgentValidation')
  const startedAt = new Date().toISOString()
  const git = await candidateIdentity()
  const requiredClis = hostSelection.requiredClis
  const cliVersions = await probeCliVersions(hostSelection.probeClis)
  const unavailable = requiredClis.filter(id => cliVersions[id].startsWith('unavailable:'))
  if (unavailable.length) {
    // The product resolves a CLI from a login-shell snapshot with a short
    // timeout and falls back to this process's PATH, so a CLI that is not
    // resolvable here will make the product report the harness as unavailable
    // mid-run. Failing here says which one and why.
    throw new Error(
      `Cannot run: ${unavailable.map(id => `${id} (${cliVersions[id]})`).join('; ')}. ` +
      'The product resolves native CLIs from a login-shell snapshot and falls back to the PATH that ' +
      'launched this run, so every required CLI must be on that PATH.'
    )
  }
  signal?.throwIfAborted()
  await mkdir(artifactsDir, { recursive: true })
  const runRoot = await mkdtemp(join(artifactsDir, 'openagent-bart-pbt-'))
  const workerCount = resolveWorkerCount(cli, items.length)
  process.stdout.write(
    `${cli.mode} PBT: ${items.length} property item(s), up to ${workerCount} concurrent item(s), ` +
    `${budget.samples} generated sample(s) and ${budget.maxCommands} command(s) each, ` +
    `seed ${budget.seed ?? 'fresh per item on each candidate run'}\n`
  )
  process.stdout.write(
    `Native CLIs: ${requiredClis.map(id => `${id}=${cliVersions[id]}`).join(', ')}\n`
  )
  process.stdout.write(`Run artifacts: ${runRoot}\n\n`)

  const results = []
  for (let offset = 0; offset < items.length; offset += workerCount) {
    signal?.throwIfAborted()
    const batch = await Promise.all(items.slice(offset, offset + workerCount).map(item => runItem({
      ...item, cli, config, budget, host, hostSelection, runRoot, cliVersions, signal
    })))
    results.push(...batch)
    if (signal?.aborted) break
  }
  results.sort((left, right) => left.label.localeCompare(right.label))

  const failed = results.filter(result => result.status === 'failed')
  await writeFile(join(runRoot, 'results.json'), JSON.stringify({
    startedAt,
    completedAt: new Date().toISOString(),
    mode: cli.mode,
    command: ['node', 'tests/bart-headless-pbt.mjs', ...argv],
    git,
    budget,
    requestedHost: host,
    host: hostSelection.actual,
    cliVersions,
    provider: { id: 'mock', model: 'mock-model', authentication: 'none', network: 'loopback' },
    workerCount,
    passed: results.filter(result => result.status === 'passed').length,
    failed: failed.length,
    skipped: results.filter(result => result.status === 'skipped').length,
    results
  }, null, 2) + '\n')

  process.stdout.write('\nBart headless PBT summary\n')
  for (const result of results) {
    process.stdout.write(`${summaryLine(result)}\n`)
  }
  if (cli.mode !== 'replay') printCost(results)
  process.stdout.write(`\n${results.filter(result => result.status === 'passed').length}/${results.length} item(s) passed\n`)

  if (failed.length || cli.keep || cli.mode === 'replay') {
    process.stdout.write(`Artifacts preserved at ${runRoot}\n`)
  } else {
    await rm(runRoot, { recursive: true, force: true })
  }
  // Replay reports success when the recorded counterexample reproduced, and
  // failure when it did not: an unreproducible counterexample is not evidence.
  return failed.length ? 1 : 0
}

/**
 * A property is exercised by every target that declares the capabilities it is
 * about. Skipping one for a capability it never claimed is announced; an
 * emptied explicit selection is an error, never a silent pass.
 */
export function planItems(cli) {
  const definitions = cli.properties.length
    ? [...new Set(cli.properties.flatMap(name => selectProperties(name)))]
    : selectProperties('all')
  const requested = cli.harnesses.length ? [...new Set(cli.harnesses)] : [...HARNESS_IDS]
  for (const target of requested) provider(target)
  const items = []
  for (const definition of definitions) {
    const eligible = requested.filter(target => supportsProperty(definition, provider(target).capabilities))
    if (!eligible.length) {
      if (cli.properties.length || cli.harnesses.length) {
        throw new Error(
          `No selected target declares the capabilities required by the ${definition.name} property ` +
          `(${definition.requires.join(', ')}); selected targets: ${requested.join(', ')}`
        )
      }
      items.push({ definition, target: null })
      continue
    }
    for (const target of eligible) items.push({ definition, target })
  }
  return items
}

function resolveWorkerCount(cli, itemCount) {
  if (itemCount === 0) return 0
  if (cli.workers !== 'auto') return Math.min(cli.workers, itemCount)
  return Math.max(1, Math.min(4, itemCount))
}

/**
 * One property on one target Harness: the fixed checkpoints in their own
 * isolated session, then the generated samples. Every sample and every shrink
 * attempt opens and closes its own headless process, Mock LLM, and native
 * profile, so nothing can leak between them.
 */
async function runItem(input) {
  const { definition, target, cli, config, budget, host, hostSelection, runRoot, cliVersions, signal } = input
  if (target === null) {
    const missing = definition.requires.join(', ')
    process.stdout.write(`[ SKIP  ] ${definition.name} — no selected target declares ${missing}\n`)
    return {
      label: definition.name,
      status: 'skipped',
      reason: `no selected target declares the ${missing} capability`,
      requiredCapabilities: [...definition.requires]
    }
  }
  const label = `${definition.name}/${target}`
  const itemRoot = join(runRoot, `${definition.name}-${target}`)
  await mkdir(itemRoot, { recursive: true })
  // Counted per phase: a checkpoint sequence is fixed and reaches the deep
  // states every run, a generated sample only as often as its distribution
  // allows. One shared counter let the checkpoints report coverage the
  // generated samples never reached.
  const checkpointCoverage = createCoverage(definition.name, 'checkpoints')
  const sampleCoverage = createCoverage(definition.name, 'samples')
  const shrinkCoverage = createCoverage(definition.name, 'shrinking')
  const replayCoverage = createCoverage(definition.name, 'replay')
  const attemptCoverage = createCoverage(definition.name, 'attempt')
  const cost = {
    sessions: 0, bootMs: 0, sampleMs: 0, closeMs: 0, checkpointMs: 0,
    samples: [], checkpoints: [], totalMs: 0
  }
  const startedAt = Date.now()
  let current = null
  let attemptedRoot = null
  let attemptedHost = null
  // Evidence has to describe the counterexample, not whichever shrink candidate
  // was opened last, so every failing sample records its own session here and
  // the descriptor looks the counterexample back up by operation sequence.
  const evidence = new Map()
  let lastEvidence = null
  let sampleIndex = 0
  let failure = null
  let descriptor = null
  let result = null
  const generatedRuns = []
  let checkpoint = cli.checkpoint ?? null
  let checkpointFailure = null
  let checkpointEvidence = null
  let checkpointTrace = []
  let tracker = new FailureTracker()
  let operationSignal = signal
  process.stdout.write(`[ RUN   ] ${label} on host ${host}\n`)

  const stoppedCheckpoint = () => checkpointFailureDescriptor({
    definition, target, host: checkpointEvidence.actualHost, checkpoint, failure: checkpointFailure,
    budget: { ...budget, seed: budget.seed ?? SHORT_REGRESSION_SEED }, operationSequence: checkpointTrace,
    interruption: tracker.fatal ? errorSummary(tracker.fatal) : 'the checkpoint could not be isolated',
    rejectedAttempts: tracker.diagnostics, cliVersions, gateOrder: checkpointEvidence.gateOrder,
    artifacts: { itemRoot, sampleRoot: checkpointEvidence.sampleRoot,
      llmRequests: join(checkpointEvidence.sampleRoot, 'llm-requests.json'),
      headlessLog: join(checkpointEvidence.sampleRoot, 'headless.log') }
  })

  const open = async token => {
    operationSignal?.throwIfAborted()
    current = null
    attemptedHost = null
    attemptedRoot = join(itemRoot, token)
    const at = Date.now()
    cost.sessions += 1
    const session = await openPbtSession({
      signal: operationSignal,
      token,
      samplesRoot: itemRoot,
      electronMain,
      desktopRoot,
      repositoryRoot,
      host,
      onHostConfigured: selected => {
        attemptedHost = selected.actualHost
        const first = hostSelection.actual === null
        hostSelection.accept(selected, cliVersions)
        if (first && host === 'auto') process.stdout.write(`[ HOST  ] auto selected ${hostSelection.actual}\n`)
      },
      config,
      target,
      property: definition.name,
      timeoutMs: cli.timeoutMs
    })
    cost.bootMs += Date.now() - at
    return session
  }

  try {
    if (cli.mode !== 'replay' && definition.checkpoints.length) {
      const checkpointDeadline = new ExecutionDeadline(budget.timeLimitMs, signal, `${label} checkpoints`)
      operationSignal = checkpointDeadline.signal
      try {
        const at = Date.now()
        const session = await open(`${definition.name}-${target}-checkpoints-${Date.now()}`)
        current = session
        const errors = []
        try {
          for (const [index, plans] of definition.checkpoints.entries()) {
            checkpoint = index
            checkpointTrace = []
            const checkpointAt = Date.now()
            resetCoverage(attemptCoverage)
            try {
              const model = await driveCheckpoint(session, definition, attemptCoverage, plans,
                `${label} checkpoint ${index} (${plans.map(plan => plan.kind).join(' -> ')})`, checkpointTrace)
              // Keep native evidence attached to this independently replayable
              // checkpoint, even if cleanup subsequently fails.
              await session.assertNativeModels(`${label} checkpoint ${index}`, {
                requireEvidence: Object.values(model.threads).some(entry => !entry.deleted && entry.status === 'completed')
              })
            } finally {
              recordAttempt(checkpointCoverage, attemptCoverage)
              cost.checkpoints.push({
                index,
                commands: plans.map(plan => `${plan.kind}${plan.thread ? `(${plan.thread})` : ''}`),
                durationMs: Date.now() - checkpointAt
              })
            }
          }
          checkpoint = null
        } catch (error) {
          if (error instanceof Error) error.pbtPhase = checkpoint === null ? 'native-evidence' : 'commands'
          errors.push(error)
        }
        cost.checkpointMs = Date.now() - at
        try {
          await session.close()
        } catch (error) {
          errors.push(error)
        }
        checkpointDeadline.close()
        if (operationSignal.aborted && !errors.includes(operationSignal.reason)) errors.push(operationSignal.reason)
        if (errors.length && checkpoint !== null && failureSignature(errors[0])) {
          checkpointFailure = errors[0]
          checkpointEvidence = { sampleRoot: session.sampleRoot, gateOrder: [...session.gates.sequence],
            actualHost: session.host.actualHost }
          if (errors.length > 1) {
            tracker = new FailureTracker({ original: checkpointFailure })
            tracker.considerAttempt(checkpointFailure, errors.slice(1), checkpointEvidence)
            lastEvidence = checkpointEvidence
            descriptor = stoppedCheckpoint()
            throw new AggregateError(errors, `${label} checkpoint failed and isolation could not start`)
          }
          process.stdout.write(`[ SHRINK] ${label}: checkpoint ${checkpoint} failed; shrinking it in isolated sessions\n`)
        } else if (errors.length === 1) throw errors[0]
        else if (errors.length) throw new AggregateError(errors, `${label} checkpoints failed and did not clean up`)
      } finally {
        checkpointDeadline.close()
        operationSignal = signal
      }
    }

    tracker = new FailureTracker({ original: checkpointFailure,
      signature: cli.mode === 'replay' ? cli.failureSignature : null })
    const commands = checkpoint !== null
      ? checkpointCommands(definition, checkpoint, attemptCoverage)
      : definition.commands(attemptCoverage, {
      maxCommands: budget.maxCommands,
      ...(cli.mode === 'replay' && budget.replayPath !== undefined
        ? { replayPath: budget.replayPath }
        : {})
    })
    const execute = async generated => {
      if (operationSignal?.aborted && !tracker.fatal) tracker.stop(operationSignal.reason,
        { sampleRoot: attemptedRoot, actualHost: hostSelection.actual })
      if (tracker.fatal) throw new fc.PreconditionFailure(true)
      const attemptPhase = cli.mode === 'replay' ? 'replay'
        : checkpoint !== null || tracker.accepted ? 'shrinking' : 'samples'
      resetCoverage(attemptCoverage)
      const token = `${definition.name}-${target}-s${sampleIndex}-${Date.now()}`
      sampleIndex += 1
      const at = Date.now()
      let session = null
      let primary = null
      const cleanupErrors = []
      let executed = 0
      let phase = 'open'
      try {
        session = await open(token)
        current = session
        phase = 'commands'
        await fc.asyncModelRun(() => ({ model: { threads: {} }, real: session }), generated)
        // `hasRan` is only set by the run, so this must be read afterwards.
        executed = [...generated].filter(command => command.hasRan).length
        // A sequence the pre-conditions rejected wholesale is legitimate, and it
        // is also what fast-check shrinks toward, so the property has to hold for
        // it. No command ran, so no Thread exists and there is no native evidence
        // to demand; the checkpoints already prove every run reaches the deep
        // states, and no sample can pass by running nothing silently.
        phase = 'native-evidence'
        if (executed > 0) await session.assertNativeModels(token)
      } catch (error) {
        if (error instanceof Error) error.pbtPhase = phase
        primary = error instanceof Error ? error : new Error(errorSummary(error))
      }
      // Include operations completed before a failure in the measured coverage.
      executed = [...generated].filter(command => command.hasRan).length
      const sample = { token, phase: attemptPhase, durationMs: Date.now() - at, executedCommands: executed, closeMs: 0 }
      cost.samples.push(sample)
      cost.sampleMs += sample.durationMs
      if (session) {
        const closeAt = Date.now()
        try {
          await session.close()
        } catch (error) {
          cleanupErrors.push(error)
        }
        // Teardown is a real, budgeted cost: it terminates the Electron process
        // tree, the native CLI, the Mock endpoint, and waits for the loopback
        // port. Leaving it out would understate what a sample really costs.
        sample.closeMs = Date.now() - closeAt
        cost.closeMs += sample.closeMs
      }
      recordAttempt(attemptPhase === 'samples' ? sampleCoverage
        : attemptPhase === 'replay' ? replayCoverage : shrinkCoverage, attemptCoverage)
      sample.coverage = summarizeCoverage(attemptCoverage, { samples: 1,
        emptySamples: Object.values(attemptCoverage.executed).every(count => count === 0) ? 1 : 0 })
      const record = { token, sampleRoot: join(itemRoot, token),
        actualHost: session?.host.actualHost ?? attemptedHost,
        gateOrder: [...(session?.gates.sequence ?? [])] }
      if (operationSignal?.aborted && primary !== operationSignal.reason) cleanupErrors.push(operationSignal.reason)
      sample.outcome = primary || cleanupErrors.length ? 'failed' : 'passed'
      if (primary || cleanupErrors.length) {
        const verdict = tracker.considerAttempt(primary, cleanupErrors, record)
        sample.verdict = verdict
        if (verdict === 'accept') {
          evidence.set(operationSequence(String(generated)).join(' -> '), record)
          lastEvidence = record
          // Throw the oracle itself even if teardown also failed. The next
          // callback sees tracker.fatal before opening anything and interrupts.
          throw primary
        }
        throw new fc.PreconditionFailure(verdict === 'interrupt')
      }
    }
    const replayAttempt = new ReplayAttempt()
    const property = fc.asyncProperty(commands, generated => cli.mode === 'replay'
      ? replayAttempt.run(() => execute(generated))
      : execute(generated))

    for (let batch = 0; batch < budget.maxBatches; batch += 1) {
      const seed = batch === 0 ? budget.seed : (result.seed + 1) | 0
      const samplesBefore = sampleCoverage.samples
      const deadline = new ExecutionDeadline(budget.timeLimitMs, signal, `${label} batch ${batch + 1}`)
      operationSignal = deadline.signal
      try {
        // With no fast-check timer, this await includes the entire callback,
        // including open failure cleanup and session.close(). Nothing races it.
        result = await fc.check(property, runConfiguration({ ...budget, seed, ...(checkpoint !== null ? { samples: 1 } : {}) }, { replay: cli.mode === 'replay' }))
      } finally {
        deadline.close()
        operationSignal = signal
      }
      if (deadline.signal.aborted && !tracker.fatal) tracker.stop(deadline.signal.reason,
        { sampleRoot: attemptedRoot, actualHost: hostSelection.actual })
      if (tracker.fatal && result.errorInstance) result = { ...result, interrupted: true }
      if (cli.mode === 'replay' && replayAttempt.passed && !tracker.fatal) {
        // The recorded candidate passed including cleanup. A later sibling was
        // deliberately blocked; that is not a timeout or a reproduced failure.
        result = null
        break
      }
      if (checkpoint === null) generatedRuns.push({
        seed: result.seed, samples: sampleCoverage.samples - samplesBefore,
        fastCheckRuns: result.numRuns, failed: result.failed
      })
      if (checkpointFailure && !checkpointReproduced(checkpointFailure, result)) {
        result = null
        lastEvidence = checkpointEvidence
        if (tracker.fatal) descriptor = stoppedCheckpoint()
        throw new Error(`checkpoint ${checkpoint} failed but the same assertion did not reproduce in isolation`,
          { cause: checkpointFailure })
      }
      if (tracker.fatal && !result.errorInstance) {
        result = null
        throw tracker.fatal
      }
      if (cli.mode === 'replay' || result.failed) break
      assertCoverage(checkpointCoverage, definition.coverage, label)
      try {
        assertCoverage(sampleCoverage, definition.sampleCoverage, label)
        if (budget.explore) assertCoverage(sampleCoverage, definition.exploreCoverage, `${label} exploration`)
        break
      } catch (error) {
        if (batch + 1 === budget.maxBatches) throw error
        process.stdout.write(`[ COVER ] ${label}: generated coverage incomplete after ` +
          `${(batch + 1) * budget.samples} samples; adding batch ${batch + 2}/${budget.maxBatches}\n`)
      }
    }

  } catch (error) {
    failure = error
  }
  cost.totalMs = Date.now() - startedAt
  const measured = {
    checkpoints: summarizeCoverage(checkpointCoverage),
    samples: summarizeCoverage(sampleCoverage),
    shrinking: summarizeCoverage(shrinkCoverage),
    replay: summarizeCoverage(replayCoverage)
  }

  const counterexample = result?.counterexample?.[0]
  const failing = counterexample === undefined
    ? lastEvidence ?? tracker.fatalEvidence
    : evidence.get(operationSequence(String(counterexample)).join(' -> ')) ?? lastEvidence
  const actualHost = failing?.actualHost ?? attemptedHost ?? hostSelection.actual
  const attributedRoot = failing?.sampleRoot ?? attemptedRoot
  const artifacts = {
    itemRoot,
    sampleRoot: attributedRoot,
    llmRequests: attributedRoot ? join(attributedRoot, 'llm-requests.json') : null,
    headlessLog: attributedRoot ? join(attributedRoot, 'headless.log') : null
  }
  const gateOrder = failing?.gateOrder ?? current?.gates.sequence ?? []

  if (result?.failed) {
    descriptor = counterexampleDescriptor({
      definition, target, host: actualHost, result, budget, artifacts, gateOrder, cliVersions, checkpoint,
      interruption: tracker.fatal ? errorSummary(tracker.fatal) : null,
      rejectedAttempts: tracker.diagnostics
    })
  }

  if (cli.mode === 'replay') {
    // A replay that ran out of time proves nothing about the counterexample.
    const reproduced = Boolean(result?.failed) && result?.interrupted !== true && !tracker.fatal &&
      failureSignature(result.errorInstance) === cli.failureSignature
    process.stdout.write(reproduced
      ? `[ REPLAY] ${label} reproduced the recorded counterexample\n${formatFailure(descriptor)}\n`
      : `[ REPLAY] ${label} did NOT reproduce seed=${budget.seed} path=${budget.path}\n`)
    if (!reproduced && descriptor) process.stderr.write(`${formatFailure(descriptor)}\n`)
    if (!descriptor) printRejectedAttempts(tracker.diagnostics)
    return {
      label,
      requestedHost: host, host: actualHost,
      status: reproduced ? 'passed' : 'failed',
      reproduced,
      descriptor,
      rejectedAttempts: tracker.diagnostics,
      coverage: measured,
      cost,
      error: reproduced ? null : (descriptor?.error ?? (failure ? errorSummary(failure) :
        'the recorded assertion did not fail again (unrelated or infrastructure failures do not reproduce it)')),
      artifacts
    }
  }

  if (failure || result?.failed) {
    const summary = descriptor ? formatFailure(descriptor) : errorSummary(failure)
    process.stderr.write(`[ FAIL  ] ${label}: ${summary}\n`)
    if (!descriptor) printRejectedAttempts(tracker.diagnostics)
    return {
      label,
      requestedHost: host, host: actualHost,
      status: 'failed',
      durationMs: cost.totalMs,
      error: descriptor ? descriptor.error : errorSummary(failure),
      detail: descriptor ? descriptor.detail : (failure?.stack ?? String(failure)),
      descriptor,
      rejectedAttempts: tracker.diagnostics,
      coverage: measured,
      generatedRuns,
      cost,
      artifacts
    }
  }

  process.stdout.write(
    `[  OK   ] ${label} (${measured.samples.samples} sample(s) and ${cost.sessions} isolated process(es) in ` +
    `${cost.totalMs} ms)\n` +
    `           checkpoints ${describeCoverage(measured.checkpoints)}\n` +
    `           samples     ${describeCoverage(measured.samples)}\n` +
    `           reached     checkpoints=[${measured.checkpoints.reached.join(',')}] ` +
    `samples=[${measured.samples.reached.join(',')}]\n`
  )
  return {
    label,
    requestedHost: host, host: actualHost,
    status: 'passed',
    durationMs: cost.totalMs,
    coverage: measured,
    generatedRuns,
    cost,
    artifacts
  }
}

function printRejectedAttempts(attempts) {
  for (const attempt of attempts) {
    process.stderr.write(`  rejected attempt: ${attempt.error}; artifacts: ${attempt.sampleRoot}\n`)
  }
}

function summaryLine(result) {
  const status = result.status === 'passed' ? 'PASS' : result.status === 'failed' ? 'FAIL' : 'SKIP'
  return `${status} ${result.label} ${result.durationMs ?? 0}ms${result.error ? ` — ${result.error}` : ''}`
}

function printCost(results) {
  const rows = results.filter(result => result.cost)
  if (!rows.length) return
  process.stdout.write('\nMeasured cost\n')
  process.stdout.write(
    'item                 sessions  boot(s)  samples  empty  exec/cmd  sample(s)  close(s)  checkpoint(s)  total(s)\n'
  )
  for (const result of rows) {
    const { cost } = result
    const executed = cost.samples.reduce((sum, sample) => sum + sample.executedCommands, 0)
    const empty = cost.samples.filter(sample => sample.executedCommands === 0).length
    process.stdout.write(
      `${result.label.padEnd(20)} ${String(cost.sessions).padStart(8)} ` +
      `${(cost.bootMs / 1000).toFixed(1).padStart(8)} ${String(cost.samples.length).padStart(8)} ` +
      `${String(empty).padStart(6)} ${String(executed).padStart(9)} ` +
      `${(cost.sampleMs / 1000).toFixed(1).padStart(10)} ` +
      `${(cost.closeMs / 1000).toFixed(1).padStart(9)} ` +
      `${(cost.checkpointMs / 1000).toFixed(1).padStart(14)} ${(cost.totalMs / 1000).toFixed(1).padStart(8)}\n`
    )
  }
}

function printPlan(items, budget, host) {
  process.stdout.write(`host: ${host}\n`)
  process.stdout.write(
    `budget: ${budget.samples} generated sample(s), ${budget.maxCommands} command(s) each, ` +
    `${budget.explore ? 'explore' : 'regression'} budgets, ` +
    `seed ${budget.seed ?? 'fresh per run'}, time limit ${budget.timeLimitMs}ms\n\n`
  )
  for (const item of items) {
    if (item.target === null) {
      process.stdout.write(`  ${item.definition.name} — skipped: no selected target declares ${item.definition.requires.join(', ')}\n`)
      continue
    }
    process.stdout.write(
      `  ${item.definition.name} on ${item.target} — ${item.definition.description}\n` +
      `    ${item.definition.checkpoints.length} checkpoint(s) plus ${budget.samples} generated sample(s)\n`
    )
  }
}

function printHelp() {
  console.log(`Usage: node tests/bart-headless-pbt.mjs [run|explore|replay|list] [options]

State-machine property-based acceptance for the real Bart -> Harness -> native
chain. The only test double is the external LLM HTTP endpoint: real Bart, real
Core, real Harness plugins, real native CLIs, real permission interactions, and
real file effects. Every sample and every shrink attempt gets its own headless
process, Mock LLM, native profile, and proof directory.

Modes:
  run        short generated regression (default); fixed seed ${SHORT_REGRESSION_SEED}
  explore    the same properties with a larger sample budget and a fresh seed
  replay     re-execute one recorded counterexample, and only that one
  list       print the planned items and budget, then exit

Coverage is reported and required per phase: the fixed checkpoint sequences and
the generated samples are counted separately, so a checkpoint can never satisfy
a requirement about what the generated distribution reached.

Options:
  --property <${PROPERTY_NAMES.join('|')}|all>   Repeat to select properties (default: all)
  --harness <${HARNESS_IDS.join('|')}>        Repeat to select target Harnesses (default: all)
  --host <auto|${HOST_HARNESS_IDS.join('|')}>       Bart host (default: the configured host)
  --samples <n>                            Generated samples per property/target
  --max-commands <n>                       Generated commands per sample
  --seed <n> --path <p>                    fast-check replay coordinates
                                           (--seed overrides the fixed run seed)
  --replay-path <p>                        Recorded shrink path for a faithful replay
  --checkpoint <index>                    Replay a shrunk mandatory sequence
  --failure-signature <hash>               Recorded assertion identity; required for replay
  --workers <auto|1-16>                    Concurrent property items (default: auto)
  --artifacts-dir <path>                   Parent directory for isolated run artifacts
  --timeout-ms <milliseconds>              Per wait timeout (default: ${DEFAULT_TIMEOUT_MS})
  --keep                                   Preserve artifacts even when everything passes
  --help                                   Show this help

Environment:
  No provider credentials are needed; every LLM request goes to a loopback server.
  PBT_EXPLORE, PBT_SAMPLES, PBT_MAX_COMMANDS, PBT_SEED, PBT_PATH, PBT_REPLAY_PATH,
  PBT_SAMPLE_BUDGET_MS mirror the flags.
`)
}

async function candidateIdentity() {
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
    run('git', ['status', '--porcelain'], { cwd: repositoryRoot })
  ])
  return { head: head.trim(), dirty: Boolean(status.trim()) }
}

/**
 * Native CLI versions are evidence, not an assertion: the executable that
 * actually ran is resolved by the product, and the committed Thread settings
 * already prove which provider and model were used. A probe that fails is
 * recorded as unavailable rather than aborting the run.
 */
async function probeCliVersions(harnesses) {
  const entries = await Promise.all(harnesses.map(async harness => {
    try {
      const { stdout } = await run(harness, ['--version'], { timeout: 20_000 })
      return [harness, stdout.trim().split('\n')[0]]
    } catch (error) {
      return [harness, `unavailable: ${errorSummary(error)}`]
    }
  }))
  return Object.fromEntries(entries)
}
