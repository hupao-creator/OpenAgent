import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoverage, countExecution, recordAttempt, resetCoverage, reach } from './bart-headless/pbt/coverage.mjs'
import { RequestGates, isTargetTurn } from './bart-headless/pbt/gates.mjs'
import { assertPublicObservation, newThread } from './bart-headless/pbt/model.mjs'
import { failureSignature, counterexampleDescriptor, formatFailure } from './bart-headless/pbt/report.mjs'
import { SampleResources } from './bart-headless/pbt/resources.mjs'
import { parseArguments } from './bart-headless/pbt/argv.mjs'
import { planItems } from './bart-headless/pbt/runner.mjs'
import { runConfiguration } from './bart-headless/pbt/budget.mjs'
import { FailureTracker, ReplayAttempt } from './bart-headless/pbt/failures.mjs'
import { check } from './bart-headless/invariant.mjs'
import { ExecutionDeadline } from './bart-headless/pbt/deadline.mjs'
import { HostSelection } from './bart-headless/pbt/hosts.mjs'
import { HeadlessClient } from './bart-headless/headless.mjs'

// These check runner failure handling; the acceptance properties still use only
// the real Bart/Core/native chain and the local HTTP Mock LLM.
describe('headless PBT evidence', () => {
  it('rejects a capability-empty explicit target selection', () => {
    expect(() => planItems(parseArguments(['list', '--harness', 'pi']))).toThrow('permission')
    expect(planItems(parseArguments(['list', '--property', 'lifecycle', '--harness', 'pi']))).toHaveLength(1)
    expect(planItems(parseArguments(['list']))).toHaveLength(7)
  })

  it('requires a concrete host for a replay', () => {
    const args = ['replay', '--property', 'lifecycle', '--harness', 'pi',
      '--seed', '42', '--path', '0:1', '--samples', '1', '--max-commands', '6',
      '--failure-signature', 'known', '--replay-path', 'AA:A']
    expect(() => parseArguments(args)).toThrow('concrete --host')
    expect(() => parseArguments([...args, '--host', 'auto'])).toThrow('concrete --host')
    expect(parseArguments([...args, '--host', 'codex']).host).toBe('codex')
  })

  it('times out a gate that never receives its target request', async () => {
    const gates = new RequestGates()
    const gate = gates.arm('PBT_HOLD_OK:missing')
    await expect(gates.waitForReached(gate, 10)).rejects.toThrow('was not reached')
    gates.releaseAll()
  })

  it('cancels a missing target gate without waiting for its timeout', async () => {
    const controller = new AbortController()
    const gates = new RequestGates(controller.signal)
    const waiting = gates.waitForReached(gates.arm('PBT_HOLD_OK:cancelled'), 180_000)
    controller.abort(new Error('cancelled by the user'))
    await expect(waiting).rejects.toThrow('cancelled by the user')
  })

  it('releases an armed request that arrives after teardown starts', async () => {
    const gates = new RequestGates()
    const gate = gates.arm('PBT_HOLD_OK:late')
    gates.releaseAll()
    await gates.beforeReply({ toolNames: [], lastMessage: gate.marker })
    expect(gates.sequence.map(entry => entry.event)).toEqual(['armed', 'reached', 'released'])
  })

  it('does not call a setup failure a minimized command counterexample', () => {
    const error = new Error('could not start Electron')
    error.pbtPhase = 'open'
    const descriptor = counterexampleDescriptor({
      definition: { name: 'lifecycle' }, target: 'pi', host: 'codex',
      result: { failed: true, errorInstance: error, counterexample: ['start,status'], numShrinks: 2 },
      budget: { maxCommands: 6 }, artifacts: { sampleRoot: '/failed-open' }
    })
    expect(formatFailure(descriptor)).not.toContain('minimal operation sequence')
    expect(formatFailure(descriptor)).toContain('Replay: not applicable')
    expect(formatFailure(descriptor)).toContain('/failed-open')
  })

  it('excludes host directives and metadata from target delivery evidence', () => {
    expect(isTargetTurn({ toolNames: ['mcp__oa__thread_list'] })).toBe(false)
    expect(isTargetTurn({ toolNames: [], systemMessage: 'You classify OpenAgent Agent Thread metadata.' })).toBe(false)
    expect(isTargetTurn({ toolNames: ['read'], systemMessage: 'native target' })).toBe(true)
  })

  it('matches the assertion independently of dynamic labels and rejects infrastructure errors', () => {
    const fail = (label, observation) => {
      try { assertPublicObservation(label, observation, newThread('T', { threadId: 'known' })) }
      catch (error) { error.pbtPhase = 'commands'; return error }
      throw new Error('expected the invariant to fail')
    }
    const first = fail('sample-A', { exists: false })
    const same = fail('sample-B', { exists: false })
    const different = fail('sample-B', { exists: true, archived: true })
    expect(failureSignature(first)).toBeTruthy()
    expect(failureSignature(same)).toBe(failureSignature(first))
    expect(failureSignature(different)).not.toBe(failureSignature(first))
    first.pbtPhase = 'open'
    expect(failureSignature(first)).toBeNull()
    expect(failureSignature(new AggregateError([same, new Error('cleanup failed')]))).toBeNull()
  })

  it.skipIf(process.platform === 'win32').each([false, true])('cleans only its detached native leak even if evidence writing fails (%s)', async writeFails => {
    const root = await mkdtemp(join(tmpdir(), 'oa-pbt-resource-'))
    const token = `resource-test-${process.pid}-${Date.now()}`
    const start = tagged => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore', env: tagged ? { ...process.env, OPENAGENT_PBT_SAMPLE: token } : process.env
    })
    const leaked = start(true), unrelated = start(false)
    const exit = once(leaked, 'exit')
    try {
      await once(leaked, 'spawn')
      const resources = new SampleResources(token, writeFails ? root : join(root, 'resources.json'))
      expect((await resources.capture()).map(row => row.pid)).toContain(leaked.pid)
      await expect(resources.assertReleased()).rejects.toThrow(writeFails
        ? 'sample resource evidence or cleanup failed' : 'leaked native processes')
      await exit
      expect(process.kill(unrelated.pid, 0)).toBe(true)
      if (!writeFails) {
        const evidence = JSON.parse(await readFile(join(root, 'resources.json'), 'utf8'))
        expect(evidence.released).toBe(false)
        expect(evidence.remaining.map(row => row.pid)).toContain(leaked.pid)
      }
    } finally {
      for (const child of [leaked, unrelated]) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})

it('reports cancellation arriving during the final wait rather than a timeout', async () => {
  const controller = new AbortController()
  const client = new HeadlessClient({ port: 1, timeoutMs: 5, signal: controller.signal })
  client.loadState = async () => ({ threads: [] })
  client.nextChange = async () => {
    controller.abort(new Error('cancelled during final wait'))
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await expect(client.waitForState(() => undefined, 'final poll', 5))
    .rejects.toThrow('cancelled during final wait')
})

class ShrinkFixture extends fc.Arbitrary {
  generate() { return new fc.Value(3, undefined) }
  canShrinkWithoutContext() { return true }
  shrink(value) { return value === 3 ? fc.Stream.of(new fc.Value(2, undefined), new fc.Value(1, undefined)) : fc.Stream.nil() }
}

it.each([false, true])('executes only the selected shrink-path replay candidate (fails=%s)', async fails => {
  const attempts = []
  const replay = new ReplayAttempt()
  const result = await fc.check(fc.asyncProperty(new ShrinkFixture(), value => replay.run(() => {
    attempts.push(value)
    if (fails || value === 1) check.fail('fixture.recorded-assertion', 'recorded assertion failed')
  })), runConfiguration({ samples: 40, seed: 42, path: '0:0', timeLimitMs: 5_000 }, { replay: true }))
  expect(attempts).toEqual([2])
  expect(replay.passed).toBe(!fails)
  if (fails) {
    expect(result.failed).toBe(true)
    expect(result.interrupted).toBe(false)
    expect(result.counterexamplePath).toBe('0:0')
  } else {
    // The runner reports the recorded candidate passed, ignoring this deliberate
    // guard interruption. It must never run the failing sibling candidate 1.
    expect(result.interrupted).toBe(true)
    expect(result.errorInstance).toBeNull()
  }
})

it.each([false, true])('preserves the first failure and separates shrink coverage (infrastructure=%s)', async infrastructure => {
  const tracker = new FailureTracker()
  const attempts = createCoverage('fixture', 'attempt')
  const samples = createCoverage('fixture', 'samples')
  const shrinks = createCoverage('fixture', 'shrinking')
  const errorFor = id => {
    try { check.fail(id, id) } catch (error) { error.pbtPhase = 'commands'; return error }
  }
  const original = errorFor('fixture.original')
  const result = await fc.check(fc.asyncProperty(new ShrinkFixture(), value => {
    const total = tracker.accepted ? shrinks : samples
    resetCoverage(attempts)
    if (value !== 2) countExecution(attempts, 'real-operation')
    if (total === shrinks) reach(attempts, 'shrink-only')
    recordAttempt(total, attempts)
    const error = value !== 2 ? original : infrastructure
      ? new Error('cleanup failed') : errorFor('fixture.different')
    const verdict = tracker.consider(error, { sampleRoot: '/attempt-' + value })
    if (verdict === 'accept') throw error
    throw new fc.PreconditionFailure(verdict === 'interrupt')
  }), { seed: 42, numRuns: 1, markInterruptAsFailure: true })
  expect(result.errorInstance).toBe(original)
  expect(result.counterexample).toEqual([infrastructure ? 3 : 1])
  expect(result.interrupted).toBe(infrastructure)
  expect(samples.samples).toBe(1)
  expect(samples.emptySamples).toBe(0)
  expect(samples.reached.has('shrink-only')).toBe(false)
  expect(shrinks.samples).toBe(infrastructure ? 1 : 2)
  expect(shrinks.emptySamples).toBe(1)
  expect(tracker.diagnostics).toHaveLength(1)
  if (infrastructure) {
    const descriptor = counterexampleDescriptor({ definition: { name: 'fixture' }, host: 'codex', target: 'pi',
      result, budget: { samples: 1, maxCommands: 3 }, artifacts: { sampleRoot: '/attempt-3' },
      interruption: tracker.fatal.message, rejectedAttempts: tracker.diagnostics })
    expect(formatFailure(descriptor)).toContain('shrinking incomplete')
    expect(formatFailure(descriptor)).toContain('cleanup failed')
    expect(formatFailure(descriptor)).not.toContain('minimal operation sequence')
  }
})

it('preserves explicit auto, allows missing unselected CLIs, and rejects a changed host', () => {
  const configured = { hosts: ['codex'] }
  expect(new HostSelection(undefined, configured, ['pi']).requested).toBe('codex')
  const selection = new HostSelection('auto', configured, ['pi'])
  expect(selection.requested).toBe('auto')
  expect(selection.requiredClis).toEqual(['pi'])
  expect(selection.probeClis).toContain('codex')
  const versions = { pi: '0.83.0', codex: 'unavailable: ENOENT', claude: '2.1.267' }
  selection.accept({ actualHost: 'pi' }, versions)
  expect(selection.actual).toBe('pi')
  expect(() => selection.accept({ actualHost: 'claude' }, versions)).toThrow('host changed')
  expect(() => new HostSelection('auto', configured, []).accept({ actualHost: 'codex' }, versions))
    .toThrow('selected Bart host codex is unavailable')
})

it('aborts at the batch deadline but awaits the active attempt cleanup', async () => {
  const deadline = new ExecutionDeadline(15, undefined, 'fixture batch')
  let cleaned = false
  let attempts = 0
  try {
    const result = await fc.check(fc.asyncProperty(fc.constant(1), async () => {
      attempts += 1
      try {
        if (!deadline.signal.aborted) await once(deadline.signal, 'abort')
        deadline.signal.throwIfAborted()
      } catch {
        throw new fc.PreconditionFailure(true)
      } finally {
        await new Promise(resolve => setTimeout(resolve, 30))
        cleaned = true
      }
    }), runConfiguration({ samples: 2, timeLimitMs: 15 }))
    expect(result.interrupted).toBe(true)
    expect(deadline.signal.aborted).toBe(true)
    expect(cleaned).toBe(true)
    expect(attempts).toBe(1)
  } finally { deadline.close() }
})

it.each([false, true])('retains the first assertion when the same attempt also fails cleanup (endOnFailure=%s)', async endOnFailure => {
  const tracker = new FailureTracker()
  let original
  try { check.fail('fixture.original-with-cleanup', 'product defect') }
  catch (error) { original = error; original.pbtPhase = 'commands' }
  const cleanup = new Error('cleanup also failed')
  let executed = 0
  const result = await fc.check(fc.asyncProperty(new ShrinkFixture(), () => {
    if (tracker.fatal) throw new fc.PreconditionFailure(true)
    executed += 1
    const verdict = tracker.considerAttempt(original, [cleanup], { sampleRoot: '/original-attempt' })
    expect(verdict).toBe('accept')
    throw original
  }), { seed: 42, numRuns: 1, endOnFailure, markInterruptAsFailure: true })
  expect(executed).toBe(1)
  expect(result.errorInstance).toBe(original)
  expect(result.counterexample).toEqual([3])
  expect(result.counterexamplePath).toBe('0')
  expect(result.interrupted).toBe(!endOnFailure)
  expect(tracker.fatal).toBe(cleanup)
  expect(tracker.diagnostics).toEqual([expect.objectContaining({ sampleRoot: '/original-attempt', error: 'cleanup also failed' })])
})
