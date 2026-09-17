import { check } from '../invariant.mjs'
import fc from 'fast-check'
import { exactCallDirective } from '../bart.mjs'
import { bounded } from '../support.mjs'
import {
  assertEvidenceIsStillLocked,
  assertEvidenceUnlocked,
  permissionPrompt,
  preparePermissionEvidence
} from '../suites/permission.mjs'
import {
  assertExecutionNeverReturned,
  assertStatusNeverAppeared,
  isTerminal,
  newThread,
  statusMatches,
  TERMINAL,
  transitionMark
} from './model.mjs'
import { countExecution, reach } from './coverage.mjs'
import { isTargetTurn } from './gates.mjs'

/**
 * Generated commands. Each one drives the real chain
 * (`bart:submit` → Bart host tool call → Core → native CLI) and then compares
 * committed renderer state against the independent model. Expectations are
 * never copied from the observation under test.
 */

const LIFECYCLE = 'T'

/**
 * Kinds are weighted, not uniform. `fc.commands` picks a kind first and then
 * drops it when `check(model)` rejects it, so a uniform generator spends most of
 * its picks on kinds that cannot run and executes almost nothing: every kind but
 * a start is infeasible until a Thread exists, and most are infeasible while the
 * Thread has no live Execution. The weights are therefore concentrated on the
 * kinds that create the state the others need, and on the ordered patterns the
 * deep states require.
 *
 * The start weights increase the proportion of feasible sequences. Coverage is
 * measured independently for generated samples; explore adds bounded batches
 * if an uncommon ordering was absent, and fails if its ceiling is exhausted.

 */
export const LIFECYCLE_WEIGHTS = {
  'start-hold': 20,
  'start-plain': 14,
  send: 5,
  steer: 4,
  release: 12,
  interrupt: 5,
  delete: 4,
  status: 1,
  list: 1
}
export const PERMISSION_WEIGHTS = {
  start: 12,
  'respond-allow': 10,
  'respond-deny': 5,
  'respond-unknown': 4,
  'respond-consumed': 4,
  delete: 2,
  status: 2
}
export const ISOLATION_WEIGHTS = {
  start: 13,
  'respond-allow': 4,
  'respond-deny': 8,
  'respond-foreign': 6,
  interrupt: 5,
  delete: 8,
  status: 2
}

export const LIFECYCLE_KINDS = Object.keys(LIFECYCLE_WEIGHTS)
export const PERMISSION_KINDS = Object.keys(PERMISSION_WEIGHTS)
export const ISOLATION_KINDS = Object.keys(ISOLATION_WEIGHTS)

function weightedKind(weights) {
  return fc.oneof(...Object.entries(weights).map(([kind, weight]) => ({
    arbitrary: fc.constant(kind),
    weight
  })))
}

export function lifecyclePlan() {
  return fc.record({ kind: weightedKind(LIFECYCLE_WEIGHTS) })
}

export function permissionPlan() {
  return fc.record({ kind: weightedKind(PERMISSION_WEIGHTS) })
}

export function isolationPlan() {
  return fc.record({
    kind: weightedKind(ISOLATION_WEIGHTS),
    thread: fc.constantFrom('A', 'B')
  })
}

export function lifecycleCommand(plan, coverage) {
  return new LifecycleCommand(plan, coverage)
}

export function permissionCommand(plan, coverage) {
  return new PermissionCommand(plan, coverage)
}

export function isolationCommand(plan, coverage) {
  return new IsolationCommand(plan, coverage)
}

/**
 * `fc.commands` takes an array of command arbitraries, and shrinking needs its
 * own `clone()` on every command. A replay passes the recorded `replayPath` to
 * reconstruct the recorded command checks before executing that candidate once.
 */
export function lifecycleCommands(coverage, constraints = {}) {
  return fc.commands([lifecycleCommandArbitrary(coverage)], constraints)
}

export function permissionCommands(coverage, constraints = {}) {
  return fc.commands([permissionCommandArbitrary(coverage)], constraints)
}

export function isolationCommands(coverage, constraints = {}) {
  return fc.commands([isolationCommandArbitrary(coverage)], constraints)
}

function lifecycleCommandArbitrary(coverage) {
  return lifecyclePlan().map(plan => lifecycleCommand(plan, coverage))
}

function permissionCommandArbitrary(coverage) {
  return permissionPlan().map(plan => permissionCommand(plan, coverage))
}

function isolationCommandArbitrary(coverage) {
  return isolationPlan().map(plan => isolationCommand(plan, coverage))
}

function plainPrompt(harness, marker) {
  return [
    `This is a native ${harness} PBT state-machine task.`,
    'Do not use any tool. Do not read or write any file. Do not run any command.',
    `Reply with exactly ${marker} and nothing else.`
  ].join('\n')
}

async function ask(context, name, args, intro, extra = []) {
  return context.bart.askForTool({
    name,
    expectedArguments: args,
    directive: exactCallDirective(intro, name, args, extra)
  })
}

/* ------------------------------------------------------------------ lifecycle */

/**
 * Generated commands are structural: fast-check 4 no longer exports a `Command`
 * base class, it only requires `check(model)` / `run(model, real)`.
 */
class LifecycleCommand {
  constructor(plan, coverage) {
    this.plan = plan
    this.coverage = coverage
  }

  toString() {
    return `lifecycle.${this.plan.kind}`
  }

  async check(model) {
    const entry = model.threads[LIFECYCLE]
    switch (this.plan.kind) {
      case 'start-plain':
      case 'start-hold':
        return entry === undefined
      case 'send':
        return Boolean(entry) && !entry.deleted && isTerminal(entry.status)
      case 'release':
        return Boolean(entry) && !entry.deleted && Boolean(entry.heldGate)
      case 'steer':
      case 'interrupt':
        return Boolean(entry) && !entry.deleted && entry.status === 'running'
      case 'delete':
      case 'status':
      case 'list':
        return Boolean(entry) && !entry.deleted
      default:
        return false
    }
  }

  async run(model, real) {
    const entry = model.threads[LIFECYCLE] ?? newThread(LIFECYCLE)
    const harness = real.input.target
    countExecution(this.coverage, this.plan.kind)
    switch (this.plan.kind) {
      case 'start-plain':
        await startPlain(this, real, model, entry, harness)
        break
      case 'start-hold':
        await startHeld(this, real, model, entry, harness)
        break
      case 'send':
        await sendAfterTerminal(this, real, model, entry, harness)
        break
      case 'steer':
        await steerRunning(this, real, model, entry)
        break
      case 'release':
        await releaseHeld(this, real, model, entry)
        break
      case 'interrupt':
        await interruptRunning(this, real, model, entry)
        break
      case 'delete':
        await deleteThread(this, real, model, entry)
        break
      case 'status':
        await projectStatus(this, real, entry)
        break
      case 'list':
        await projectList(this, real, entry)
        break
      default:
        check.fail('lifecycle.command-known', `unknown lifecycle command: ${this.plan.kind}`)
    }
  }
}

async function startPlain(command, real, model, entry, harness) {
  const marker = real.marker('PBT_PLAIN_OK')
  const { threadId } = await real.context.start({
    cwd: real.input.repositoryRoot,
    worktree: false,
    options: real.context.options(),
    prompt: plainPrompt(harness, marker)
  })
  const terminal = await real.context.waitForCompleted(threadId)
  check.ok('lifecycle.start.marker',
    (terminal.summary || '').includes(marker),
    `plain start did not complete with its own marker: ${bounded(terminal)}`
  )
  entry.threadId = threadId
  entry.executionId = terminal.executionId
  entry.status = 'completed'
  entry.marker = marker
  model.threads[LIFECYCLE] = entry
  await real.assertObserved(entry, `after ${command.plan.kind}`)
  reach(command.coverage, 'completed')
}

async function startHeld(command, real, model, entry, harness) {
  const marker = real.marker('PBT_HOLD_OK')
  const gate = real.gates.arm(marker)
  try {
    const { threadId } = await real.context.start({
      cwd: real.input.repositoryRoot,
      worktree: false,
      options: real.context.options(),
      prompt: plainPrompt(harness, marker)
    })
    entry.threadId = threadId
    // The parked HTTP turn is the only proof that the Execution is genuinely in
    // flight. Waiting for `running` alone would also accept an Execution whose
    // native turn already answered, which would silently empty the race window
    // every later command depends on.
    await real.gates.waitForReached(gate, real.input.timeoutMs)
    const executionId = await real.client.waitForThread(threadId, thread => {
      const execution = thread.observation?.latestExecution
      if (execution?.status === 'running') return execution.executionId
      if (execution && isTerminal(execution.status)) {
        throw new Error(
          `thread ${threadId} reached ${execution.status} instead of parking on the gate; ` +
          `the held native turn was not observably in flight: ${bounded(execution)}`
        )
      }
    }, `thread ${threadId} running under a held native turn`)
    entry.executionId = executionId
    entry.heldGate = gate
    entry.status = 'running'
    entry.marker = marker
    model.threads[LIFECYCLE] = entry
    await real.assertObserved(entry, `after ${command.plan.kind}`)
    reach(command.coverage, 'running')
  } catch (error) {
    gate.release()
    throw error
  }
}

async function sendAfterTerminal(command, real, model, entry, harness) {
  const previous = entry.executionId
  const mark = transitionMark(real.client, entry.threadId)
  const marker = real.marker('PBT_SEND_OK')
  const prompt = plainPrompt(harness, marker)
  const operation = await ask(
    real.context,
    'openagent_thread_send',
    { threadId: entry.threadId, prompt },
    'Continue the PBT acceptance Thread with a second native task.'
  )
  check.equal('lifecycle.send.starts-successor',
    operation.result.startedNewExecution,
    true,
    `send after a terminal Execution did not start a new one: ${bounded(operation.result)}`
  )
  check.notEqual('lifecycle.send.new-execution-id',
    operation.result.executionId,
    previous,
    'send reused the terminal Execution id'
  )
  if (entry.heldGate) {
    real.gates.record(entry.heldGate.marker, 'successor-started')
    entry.heldGate.release()
    entry.heldGate = null
    reach(command.coverage, 'late-result-after-successor')
  }
  const terminal = await real.context.client.waitForThread(entry.threadId, thread => {
    const execution = thread.observation?.latestExecution
    return execution?.executionId === operation.result.executionId && isTerminal(execution.status)
      ? execution
      : undefined
  }, `thread ${entry.threadId} successor Execution`)
  check.ok('lifecycle.send.marker',
    (terminal.summary || '').includes(marker),
    `successor Execution did not carry its own marker: ${bounded(terminal)}`
  )
  check.equal('lifecycle.send.completed', terminal.status, 'completed', `successor Execution ended ${terminal.status}`)
  entry.executionId = operation.result.executionId
  entry.status = 'completed'
  assertExecutionNeverReturned(
    real.client, entry.threadId, previous, mark,
    'a superseded Execution overwrote its successor'
  )
  await real.assertStable(entry, () => {
    assertExecutionNeverReturned(real.client, entry.threadId, previous, mark,
      'a late result overwrote the successor Execution')
  }, 'after releasing a superseded native turn')
  await real.assertObserved(entry, `after ${command.plan.kind}`)
  reach(command.coverage, 'successor-execution')
}

async function steerRunning(command, real, model, entry) {
  // The Mock scripts a prompt only when the prompt states the answer it wants,
  // so a steer has to name its own marker. That marker doubles as the delivery
  // evidence: it can appear in the target LLM request log only if the live
  // message really reached the running native turn.
  const marker = real.marker('PBT_STEER_OK')
  const prompt = [
    'This is a live steering message for the current PBT Execution.',
    'Do not start another task.',
    `Reply with exactly ${marker} and nothing else.`
  ].join('\n')
  const operation = await ask(
    real.context,
    'openagent_thread_send',
    { threadId: entry.threadId, prompt },
    'Steer the currently running PBT acceptance Thread.'
  )
  check.equal('lifecycle.steer.reuses-execution',
    operation.result.startedNewExecution,
    false,
    `steering a running Execution created another one: ${bounded(operation.result)}`
  )
  check.equal('lifecycle.steer.execution-id',
    operation.result.executionId,
    entry.executionId,
    'a steer was attributed to a foreign Execution'
  )
  entry.steerMarkers.push(marker)
  await real.assertObserved(entry, `after ${command.plan.kind}`)
  reach(command.coverage, 'steered-running')
}

async function releaseHeld(command, real, model, entry) {
  const executionId = entry.executionId
  entry.heldGate.release()
  entry.heldGate = null
  if (entry.status === 'interrupted') {
    await assertInterruptedStable(real, entry)
    reach(command.coverage, 'late-result-after-interrupt')
    return
  }
  const terminal = await real.context.client.waitForThread(entry.threadId, thread => {
    const execution = thread.observation?.latestExecution
    return execution?.executionId === executionId && isTerminal(execution.status)
      ? execution
      : undefined
  }, `thread ${entry.threadId} held turn settled`)
  check.equal('lifecycle.release.completed', terminal.status, 'completed', `held Execution ended ${terminal.status}`)
  // Which native answer the Execution commits depends on how the CLI folds a
  // live steer into the running turn, so either the held answer or a steer
  // answer may legitimately be the committed one. Any other text would mean the
  // answer was lost, or that no scripted prompt produced it.
  const markers = [entry.marker, ...entry.steerMarkers]
  check.ok('lifecycle.release.marker',
    markers.some(marker => (terminal.summary || '').includes(marker)),
    `the released native answer was lost: ${bounded(terminal)}`
  )
  // A steer the model answered is only possible if the request carrying it
  // existed; the Mock's own request log is that evidence, and it is HTTP input
  // rather than product state.
  for (const marker of entry.steerMarkers) {
    check.ok('lifecycle.steer.native-delivery',
      real.llm.requests.some(({ request }) => isTargetTurn(request) &&
        request.messages.some(message => (message.content || '').includes(marker))),
      `the live steer ${marker} never reached the target native turn`
    )
  }
  entry.status = 'completed'
  await real.assertObserved(entry, `after ${command.plan.kind}`)
}

async function interruptRunning(command, real, model, entry) {
  const mark = transitionMark(real.client, entry.threadId)
  await ask(
    real.context,
    'openagent_thread_interrupt',
    { threadId: entry.threadId },
    'Stop the running PBT acceptance Thread.'
  )
  if (entry.heldGate) real.gates.record(entry.heldGate.marker, 'interrupted')
  const terminal = await real.context.waitForTerminal(entry.threadId)
  check.equal('lifecycle.interrupt.execution-id', terminal.executionId, entry.executionId, 'interrupt settled a foreign Execution')
  check.equal('lifecycle.interrupt.status', terminal.status, 'interrupted', `interrupt produced ${terminal.status}`)
  entry.status = 'interrupted'
  entry.interruptedMark = mark
  await real.assertObserved(entry, `after ${command.plan.kind}`)
  assertStatusNeverAppeared(real.client, entry.threadId, ['completed'], mark,
    'a cancelled Execution still committed a completion')
  // Keep the old HTTP response parked. A following send starts a successor
  // before releasing it; release alone tests the cancelled Execution instead.
  reach(command.coverage, 'interrupted')
}

async function assertInterruptedStable(real, entry) {
  await real.assertStable(entry, observation => {
    check.equal('lifecycle.late-response.execution-id', observation.latestExecution?.executionId, entry.executionId,
      'a late native result replaced the interrupted Execution')
    check.equal('lifecycle.late-response.status', observation.latestExecution?.status, 'interrupted',
      'a late native result overwrote the interrupted Execution')
    assertStatusNeverAppeared(real.client, entry.threadId, ['completed'], entry.interruptedMark,
      'a cancelled Execution briefly committed a completion after its native response was released')
  }, 'after releasing a cancelled native turn')
}

async function deleteThread(command, real, model, entry) {
  const threadId = entry.threadId
  const wasWaiting = entry.status === 'waiting-for-user'
  await ask(
    real.context,
    'openagent_thread_delete',
    { threadId },
    'Remove the PBT acceptance Thread.'
  )
  // The parked native turn is released after the removal was requested, so the
  // removal races the in-flight result on purpose. Removing a running Thread
  // may legitimately let the in-flight work complete first; what may never
  // happen is the removed Thread coming back, so the window has to be quiet.
  if (entry.heldGate) {
    real.gates.record(entry.heldGate.marker, 'deleted')
    entry.heldGate.release()
    entry.heldGate = null
    reach(command.coverage, 'late-result-after-delete')
  }
  await real.assertAbsent(threadId, 'deleted PBT Thread')
  if (wasWaiting) {
    if (entry.evidence.kind === 'read-secret') {
      check.ok('permission.delete.secret-locked', !JSON.stringify(real.llm.requests).includes(entry.evidence.secret),
        'deleting a pending Thread allowed its protected native read')
    } else {
      await assertEvidenceIsStillLocked(entry.evidence, entry.proofPath, {})
    }
  }
  real.context.threads.delete(threadId)
  entry.deleted = true
  await real.assertObserved(entry, `after ${command.plan.kind}`)
  reach(command.coverage, 'deleted')
}

async function projectStatus(command, real, entry) {
  const operation = await ask(
    real.context,
    'openagent_thread_status',
    { threadId: entry.threadId },
    'Inspect the PBT acceptance Thread.'
  )
  const projected = operation.result.thread
  check.equal('projection.status.thread-id', projected.threadId, entry.threadId, 'status projected a foreign Thread')
  const execution = projected.observation?.latestExecution ?? null
  if (entry.status === null) {
    check.equal('projection.status.no-invented-execution', execution, null, `status invented an Execution: ${bounded(projected)}`)
  } else {
    check.ok('projection.status.execution-present', execution, `status omitted the committed Execution: ${bounded(projected)}`)
    check.equal('projection.status.execution-id', execution.executionId, entry.executionId, 'status projected a foreign Execution')
    check.ok('projection.status.status',
      statusMatches(entry.status, execution.status),
      `status reported ${execution.status}, expected ${entry.status}`
    )
  }
  await real.assertObserved(entry, `after ${command.plan.kind}`)
}

async function projectList(command, real, entry) {
  const operation = await ask(
    real.context,
    'openagent_thread_list',
    {},
    'List the PBT acceptance Threads.'
  )
  const listed = operation.result.threads.find(thread => thread.threadId === entry.threadId)
  check.equal('projection.list.membership', Boolean(listed), !entry.deleted, 'list disagreed with committed state about the PBT Thread')
  if (listed) {
    const execution = listed.observation?.latestExecution ?? null
    check.equal('projection.list.execution-id', execution?.executionId ?? null, entry.executionId, 'list projected a foreign or missing Execution')
    check.ok('projection.list.status', statusMatches(entry.status, execution?.status ?? null), 'list projected the wrong Execution status')
  }
  await real.assertObserved(entry, `after ${command.plan.kind}`)
}

/* ----------------------------------------------------------------- permission */

export const PERMISSION = 'P'

class PermissionCommand {
  constructor(plan, coverage) {
    this.plan = plan
    this.coverage = coverage
  }

  toString() {
    return `permission.${this.plan.kind}`
  }

  async check(model) {
    const entry = model.threads[PERMISSION]
    switch (this.plan.kind) {
      case 'start':
        return entry === undefined
      case 'respond-allow':
      case 'respond-deny':
      case 'respond-unknown':
        return Boolean(entry) && !entry.deleted && entry.status === 'waiting-for-user'
      case 'respond-consumed':
        return Boolean(entry) && !entry.deleted && entry.consumedInteractionId !== null
      case 'delete':
      case 'status':
        return Boolean(entry) && !entry.deleted
      default:
        return false
    }
  }

  async run(model, real) {
    const entry = model.threads[PERMISSION] ?? newThread(PERMISSION)
    countExecution(this.coverage, this.plan.kind)
    switch (this.plan.kind) {
      case 'start':
        await startPermissionThread(this, real, model, entry, PERMISSION)
        break
      case 'respond-allow':
        await allowPermission(this, real, model, entry, PERMISSION)
        break
      case 'respond-deny':
        await denyPermission(this, real, model, entry, PERMISSION)
        break
      case 'respond-unknown':
        await rejectUnknownInteraction(this, real, entry)
        break
      case 'respond-consumed':
        await rejectConsumedInteraction(this, real, entry)
        break
      case 'delete':
        await deleteThread(this, real, model, entry)
        break
      case 'status':
        await projectStatus(this, real, entry)
        break
      default:
        check.fail('permission.command-known', `unknown permission command: ${this.plan.kind}`)
    }
  }
}

/**
 * A start prompt must cover both answers the sequence can give, because the
 * response is chosen after the Thread starts and one prompt drives either one.
 * The Mock resolves a denied tool result from a `PERMISSION_DENIED:<token>` it
 * finds anywhere in the prompt, but it resolves a successful turn from the
 * first `… exactly <marker>` phrase — so the denial is named without that
 * phrase. Spelling the denial as the final-marker instruction would make the
 * approved path report the denial instead of its proof.
 */
function permissionStartPrompt(scoped, proofPath, evidence) {
  return [
    permissionPrompt(scoped, proofPath, evidence),
    'If the native permission request is denied, do not retry it and do not use another tool.',
    `In that case the only answer is PERMISSION_DENIED:${scoped.token}.`
  ].join('\n')
}

/** Shared by the permission and isolation groups. */
async function startPermissionThread(command, real, model, entry, key) {
  const token = real.scope()
  const scoped = real.scoped(token)
  const proofPath = scoped.proofPath('PBT')
  const evidence = await preparePermissionEvidence(scoped, proofPath)
  const { threadId } = await scoped.start({
    cwd: real.input.repositoryRoot,
    worktree: false,
    options: scoped.options(),
    prompt: permissionStartPrompt(scoped, proofPath, evidence)
  })
  const { execution, interaction } = await scoped.waitForInteraction(threadId, 'permission')
  await assertEvidenceIsStillLocked(evidence, proofPath, execution)
  entry.threadId = threadId
  entry.executionId = execution.executionId
  entry.status = 'waiting-for-user'
  entry.interactionId = interaction.id
  entry.proofPath = proofPath
  entry.scopeToken = token
  entry.token = scoped.token
  entry.evidence = evidence
  entry.startedOrder = Object.keys(model.threads).length
  model.threads[key] = entry
  await real.assertObserved(entry, `after ${command.plan.kind}`)
  reach(command.coverage, 'waiting-for-user')
}

async function allowPermission(command, real, model, entry, key) {
  const scoped = real.scoped(entry.scopeToken)
  const interaction = await pendingInteraction(scoped, entry)
  const { terminal, interactionIds } = await scoped.allowPermissionChain({
    threadId: entry.threadId,
    interaction,
    maxPermissions: 4
  })
  await assertEvidenceUnlocked(entry.evidence, entry.proofPath, terminal, scoped)
  entry.consumedInteractionId = interaction.id
  entry.consumedActionId = scoped.answerFor(interaction, 'allow').actionId
  entry.interactionId = null
  check.equal('permission.allow.execution-id', terminal.executionId, entry.executionId, 'permission settled a foreign Execution')
  check.equal('permission.allow.completed', terminal.status, 'completed', 'an approved native action did not complete successfully')
  entry.status = 'completed'
  model.threads[key] = entry
  await real.assertObserved(entry, `after ${command.plan.kind}`)
  check.ok('permission.allow.consumed-interaction', interactionIds.length >= 1, 'the approved chain consumed no interaction')
  reach(command.coverage, 'approved-with-proof')
}

async function denyPermission(command, real, model, entry, key) {
  const scoped = real.scoped(entry.scopeToken)
  const interaction = await pendingInteraction(scoped, entry)
  const response = scoped.answerFor(interaction, 'deny')
  await scoped.respond({
    threadId: entry.threadId,
    interaction,
    actionId: response.actionId,
    intro: 'Reject the pending native permission request for this PBT sample.'
  })
  const terminal = await scoped.waitForTerminal(entry.threadId)
  check.ok('permission.deny.marker',
    (terminal.summary || '').includes(`PERMISSION_DENIED:${entry.token}`),
    `the native agent did not report the denial: ${bounded(terminal)}`
  )
  await assertEvidenceIsStillLocked(entry.evidence, entry.proofPath, terminal)
  check.doesNotMatch('permission.deny.no-approved-marker',
    terminal.summary || '',
    new RegExp(entry.evidence.expectedMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'a denied native action still reported its approved completion marker'
  )
  entry.consumedInteractionId = interaction.id
  entry.consumedActionId = scoped.answerFor(interaction, 'allow').actionId
  entry.interactionId = null
  check.equal('permission.deny.execution-id', terminal.executionId, entry.executionId, 'permission settled a foreign Execution')
  entry.status = TERMINAL
  model.threads[key] = entry
  await real.assertObserved(entry, `after ${command.plan.kind}`)
  entry.denied = true
  reach(command.coverage, 'denied-without-proof')
}

async function rejectUnknownInteraction(command, real, entry) {
  const scoped = real.scoped(entry.scopeToken)
  const unknownId = `pbt-unknown-${entry.token}`
  const valid = await pendingInteraction(scoped, entry)
  const actionId = scoped.answerFor(valid, 'allow').actionId
  await assertRejected(
    real, entry,
    { threadId: entry.threadId, interactionId: unknownId, actionId },
    'Answer the pending native interaction with an identifier that is not pending.'
  )
  // The pending interaction must survive the rejected answer, and the protected
  // native effect must still be impossible.
  const pending = await pendingInteraction(scoped, entry)
  check.equal('permission.unknown.still-pending', pending.id, entry.interactionId, 'a rejected answer consumed the pending interaction')
  await assertEvidenceStillLocked(real, entry)
  reach(command.coverage, 'rejected-unknown-interaction')
}

async function rejectConsumedInteraction(command, real, entry) {
  const consumed = entry.consumedInteractionId
  check.ok('permission.consumed.identity-present', consumed, 'no consumed interaction is available to replay')
  await assertRejected(
    real, entry,
    { threadId: entry.threadId, interactionId: consumed, actionId: entry.consumedActionId },
    'Replay a response for a native interaction that has already completed.'
  )
  await real.assertObserved(entry, `after ${command.plan.kind}`)
  if (entry.denied) await assertEvidenceStillLocked(real, entry)
  reach(command.coverage, 'rejected-consumed-interaction')
}

async function assertRejected(real, entry, args, intro) {
  const before = await real.client.loadState()
  const beforeExecution = await real.observe(entry.threadId)
  const { message } = await real.bart.askForToolFailure({
    name: 'openagent_thread_respond',
    expectedArguments: args,
    directive: exactCallDirective(intro, 'openagent_thread_respond', args,
      ['Report the tool error verbatim. Do not retry with the real interaction id.'])
  })
  check.ok('permission.rejected.error-message', message.trim(), 'a rejected respond produced no error message')
  const after = await real.client.loadState()
  check.equal('permission.rejected.thread-set', after.threads.length, before.threads.length, 'a rejected respond changed the Thread set')
  const afterExecution = await real.observe(entry.threadId)
  check.deepEqual('permission.rejected.observation',
    afterExecution.latestExecution,
    beforeExecution.latestExecution,
    'a rejected respond mutated the public Execution'
  )
}

async function assertEvidenceStillLocked(real, entry) {
  const observation = await real.observe(entry.threadId)
  await assertEvidenceIsStillLocked(entry.evidence, entry.proofPath, observation.latestExecution)
}

async function pendingInteraction(scoped, entry) {
  const { interaction } = await scoped.waitForInteraction(entry.threadId, 'permission')
  check.equal('permission.pending.identity',
    interaction.id,
    entry.interactionId,
    'the pending native interaction is not the one the model recorded'
  )
  return interaction
}

/* ------------------------------------------------------------------ isolation */

class IsolationCommand {
  constructor(plan, coverage) {
    this.plan = plan
    this.coverage = coverage
  }

  toString() {
    return `isolation.${this.plan.kind}(${this.plan.thread})`
  }

  async check(model) {
    const entry = model.threads[this.plan.thread]
    const other = model.threads[otherKey(this.plan.thread)]
    switch (this.plan.kind) {
      case 'start':
        return entry === undefined
      case 'respond-allow':
      case 'respond-deny':
      case 'interrupt':
        return Boolean(entry) && !entry.deleted && entry.status === 'waiting-for-user'
      case 'respond-foreign':
        return Boolean(entry) && !entry.deleted && entry.status === 'waiting-for-user' &&
          Boolean(other) && !other.deleted && other.status === 'waiting-for-user'
      case 'delete':
      case 'status':
        return Boolean(entry) && !entry.deleted
      default:
        return false
    }
  }

  async run(model, real) {
    const key = this.plan.thread
    const entry = model.threads[key] ?? newThread(key)
    countExecution(this.coverage, this.plan.kind)
    switch (this.plan.kind) {
      case 'start':
        await startPermissionThread(this, real, model, entry, key)
        break
      case 'respond-allow':
        await allowPermission(this, real, model, entry, key)
        break
      case 'respond-deny':
        await denyPermission(this, real, model, entry, key)
        break
      case 'interrupt':
        await interruptRunning(this, real, model, entry)
        await assertEvidenceStillLocked(real, entry)
        break
      case 'respond-foreign':
        await rejectForeignInteraction(this, real, model, entry, key)
        break
      case 'delete':
        await deleteThread(this, real, model, entry)
        break
      case 'status':
        await projectStatus(this, real, entry)
        break
      default:
        check.fail('isolation.command-known', `unknown isolation command: ${this.plan.kind}`)
    }
    // The second law of this group: a command on one Thread never disturbs the
    // other Thread's committed observation.
    const other = model.threads[otherKey(key)]
    if (other) {
      await real.assertObserved(other, `after ${this.toString()} (untouched sibling)`)
      if (!other.deleted && other.status === 'waiting-for-user') {
        await assertEvidenceStillLocked(real, other)
        if (this.plan.kind === 'interrupt') reach(this.coverage, 'cancelled-beside-waiting')
        if (this.plan.kind === 'delete') reach(this.coverage, 'deleted-beside-waiting')
        if (['respond-allow', 'respond-deny'].includes(this.plan.kind) &&
            entry.startedOrder > other.startedOrder) {
          reach(this.coverage, 'out-of-order-completion')
        }
      }
    }
  }
}

async function rejectForeignInteraction(command, real, model, entry, key) {
  const foreign = model.threads[otherKey(key)]
  const scoped = real.scoped(entry.scopeToken)
  const interaction = await pendingInteraction(real.scoped(foreign.scopeToken), foreign)
  const actionId = real.scoped(foreign.scopeToken).answerFor(interaction, 'allow').actionId
  await assertRejected(
    real, entry,
    { threadId: entry.threadId, interactionId: foreign.interactionId, actionId },
    'Answer one PBT Thread with an interaction that belongs to another Thread.'
  )
  const pending = await pendingInteraction(scoped, entry)
  check.equal('isolation.foreign.local-pending', pending.id, entry.interactionId, 'a foreign answer consumed the local pending interaction')
  const foreignPending = await pendingInteraction(real.scoped(foreign.scopeToken), foreign)
  check.equal('isolation.foreign.foreign-pending', foreignPending.id, foreign.interactionId,
    'a foreign answer consumed the other Thread pending interaction')
  await assertEvidenceStillLocked(real, entry)
  await assertEvidenceStillLocked(real, foreign)
  await real.assertObserved(entry, `after ${command.plan.kind}`)
  reach(command.coverage, 'rejected-foreign-interaction')
}

function otherKey(key) {
  return key === 'A' ? 'B' : 'A'
}
