import assert from 'node:assert/strict'
import { check } from './invariant.mjs'
import {
  bounded,
  bartThread,
  isTerminal,
  latestExecution,
  toolOperations
} from './support.mjs'

/**
 * Every case drives the product through the real Bart: a natural-language
 * directive on `bart:submit`, a native Bart tool call, and the committed
 * tool operation as the proof that the control chain executed. Delegated Thread
 * responses always go through Bart's Core tool. The driver may use the normal
 * GUI response command only for a native permission on the current Bart host.
 */
export class BartDriver {
  constructor(client) {
    this.client = client
    this.hostInteractions = []
  }

  submit(directive) {
    return this.client.invoke('bart:submit', {
      input: { parts: [{ kind: 'text', text: directive }] }
    })
  }

  /**
   * Submits one directive and waits until the expected ordered native tool
   * operations have all committed and the Bart host has completed successfully.
   */
  async askForTools(request) {
    const expectations = request.expect
    assert.ok(expectations.length, 'a Bart directive must expect at least one tool')
    await this.client.waitForBartIdle('Bart idle before directive')
    const before = await this.client.loadState()
    const existing = new Set(toolOperations(before).map(operation => operation.id))
    const label = `Bart ${expectations.map(item => item.name).join(' → ')}`
    const existingTranscript = new Set(
      (bartThread(before)?.transcript || []).map(item => item.id)
    )
    const admissionController = new AbortController()
    const admitted = this.client.waitForState(state => {
      const thread = bartThread(state)
      if (!thread) return undefined
      const userMessage = (thread.transcript || []).find(item => (
        !existingTranscript.has(item.id) &&
        item.type === 'message' &&
        item.role === 'user' &&
        item.systemEvent !== true &&
        item.content === request.directive
      ))
      if (!userMessage) return undefined
      return state.executions.find(execution => execution.threadId === thread.id)?.executionId
    }, `${label} admission`, request.timeoutMs, admissionController.signal)
    const submission = this.submit(request.directive)
    void submission.catch(error => admissionController.abort(error))
    let executionId
    try {
      executionId = await admitted
    } finally {
      admissionController.abort(new Error(`${label} admission settled`))
    }

    const settlementController = new AbortController()
    void submission.catch(error => settlementController.abort(error))
    let settled
    try {
      ;[settled] = await Promise.all([
        this.waitForBartExecution(executionId, `${label} terminal`, request.timeoutMs, settlementController.signal),
        submission
      ])
    } finally {
      settlementController.abort(new Error(`${label} settled`))
    }
    assertHostCompleted(settled, label)
    const fresh = toolOperations(settled).filter(operation => !existing.has(operation.id))
    check.equal('bart.tools.count',
      fresh.length,
      expectations.length,
      `${label} made an unexpected number of tool calls: ${bounded(fresh)}; ` +
        `Bart terminal=${bounded(latestExecution(bartThread(settled)))}`
    )
    fresh.forEach((operation, index) => {
      check.equal('bart.tools.execution-owner',
        operation.executionId,
        executionId,
        `${label} included a tool call from another Bart Execution: ${bounded(operation)}`
      )
      check.equal('bart.tools.order',
        operation.name,
        expectations[index].name,
        `${label} changed the exact tool sequence: ${bounded(fresh)}`
      )
      check.notEqual('bart.tools.committed',
        operation.completedAt,
        undefined,
        `${operation.name} did not commit a result before Bart terminal`
      )
      assertOperation(operation, expectations[index])
    })
    return fresh
  }

  async waitForBartExecution(executionId, label, timeoutMs, signal) {
    const deadline = Date.now() + (timeoutMs ?? this.client.timeoutMs ?? 180_000)
    const responded = new Set()
    while (true) {
      signal?.throwIfAborted()
      const remaining = deadline - Date.now()
      assert.ok(remaining > 0, `${label} timed out while responding to native Bart permissions`)
      const outcome = await this.client.waitForState(state => {
        const thread = bartThread(state)
        const execution = latestExecution(thread)
        if (!execution || execution.executionId !== executionId) return undefined
        if (execution.status === 'waiting-for-user') {
          check.ok('bart.host.waiting-interactions', execution.interactions?.length,
            `Bart waiting state did not expose an interaction: ${bounded(execution)}`)
          const interaction = execution.interactions.find(item => !responded.has(item.id))
          return interaction ? { threadId: thread.id, interactionId: interaction.id } : undefined
        }
        if (!isTerminal(execution) || state.executions.some(active => active.executionId === executionId)) return undefined
        return { state }
      }, label, remaining, signal)
      if (outcome.state) return outcome.state
      check.ok('bart.host.permission-limit', responded.size < 16, 'Bart native permission chain exceeded 16 interactions')
      await this.respondToHostPermission({ ...outcome, executionId }, signal)
      responded.add(outcome.interactionId)
    }
  }

  /** The sole direct response seam is guarded by the current Bart identity. */
  async respondToHostPermission(pending, signal) {
    const current = await this.client.loadState(signal)
    const host = bartThread(current)
    check.ok('bart.host.present', host, 'No current Bart host exists for the native permission')
    check.equal('bart.host.permission-thread', pending.threadId, host.id,
      'Direct acceptance responses are restricted to the current Bart host')
    const execution = latestExecution(host)
    check.equal('bart.host.permission-execution', execution?.executionId, pending.executionId, 'Bart permission belongs to a stale Execution')
    check.equal('bart.host.permission-status', execution?.status, 'waiting-for-user', 'Bart native permission is no longer pending')
    const interaction = execution.interactions?.find(item => item.id === pending.interactionId)
    check.ok('bart.host.permission-present', interaction, 'Bart native permission is no longer present')
    const evidence = {
      observedAt: Date.now(),
      revision: current.revision,
      threadId: host.id,
      harnessId: host.harnessId,
      executionId: pending.executionId,
      waiting: structuredClone(execution),
      interaction: structuredClone(interaction)
    }
    this.hostInteractions.push(evidence)
    try {
      check.equal('bart.host.permission-kind', interaction.kind, 'permission',
        `Unsupported Bart host interaction: ${interaction.kind}; native questions require explicit answer semantics`)
      const action = interaction.actions?.find(candidate => candidate.intent === 'allow')
      check.ok('bart.host.permission-allow', action, 'Bart native permission exposes no allow action')
      const request = { threadId: host.id, interactionId: interaction.id, actionId: action.id }
      evidence.action = structuredClone(action)
      evidence.request = request
      const result = await this.client.invoke('thread:interaction-respond', request, signal)
      evidence.response = { status: 'accepted', at: Date.now(), result: result ?? null }
    } catch (error) {
      evidence.response = { status: 'failed', at: Date.now(), error: String(error) }
      throw error
    }
  }

  async askForTool(request) {
    const expect = request.requiredBefore
      ? [request.requiredBefore, request]
      : [request]
    const matched = await this.askForTools({
      directive: request.directive,
      expect,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs })
    })
    return matched[matched.length - 1]
  }

  /** Asserts the native tool rejected the request instead of acting on it. */
  async askForToolFailure(request) {
    const operation = await this.askForTool({ ...request, isError: true })
    const message = typeof operation.result?.error === 'string' ? operation.result.error : ''
    if (request.errorPattern) {
      check.match('bart.tools.rejection-reason',
        message,
        request.errorPattern,
        `${request.name} failed for the wrong reason: ${bounded(operation.result)}`
      )
    }
    return { operation, message }
  }

  /** Submits a directive and requires the Bart turn to complete successfully. */
  async ask(directive, timeoutMs) {
    await this.client.waitForBartIdle('Bart idle before directive')
    const before = await this.client.loadState()
    const existing = new Set((before.threads.find(thread => thread.bart)?.transcript || [])
      .map(item => item.id))
    await this.submit(directive)
    const state = await this.client.waitForBartIdle('Bart turn settled', timeoutMs)
    assertHostCompleted(state, 'Bart ask')
    const transcript = state.threads.find(thread => thread.bart)?.transcript || []
    return transcript.filter(item => !existing.has(item.id))
  }

  async bestEffortInterrupt(threadId) {
    try {
      const state = await this.client.loadState()
      const thread = state.threads.find(candidate => candidate.id === threadId)
      const execution = thread && latestExecution(thread)
      if (!execution || isTerminal(execution)) return
      await this.askForTool({
        name: 'thread_interrupt',
        expectedArguments: { threadId },
        directive: exactCallDirective(
          'Clean up an acceptance case that must stop now.',
          'thread_interrupt',
          { threadId }
        )
      })
    } catch {
      // The isolated headless process is always terminated after the worker.
    }
  }
}

function assertHostCompleted(state, label) {
  const execution = latestExecution(bartThread(state))
  check.equal('bart.host.completed', execution?.status, 'completed',
    `${label}: Bart host did not complete: ${execution?.status ?? 'missing'}; execution=${bounded(execution)}`)
}

function assertOperation(operation, expectation) {
  if (expectation.expectedArguments !== undefined) {
    check.deepEqual('bart.tools.arguments',
      operation.arguments,
      expectation.expectedArguments,
      `Bart changed ${expectation.name} arguments: ${bounded(operation.arguments)}`
    )
  }
  expectation.matchArguments?.(operation.arguments, operation)
  if (expectation.isError === true) {
    check.equal('bart.tools.expected-error',
      operation.isError,
      true,
      `${expectation.name} unexpectedly succeeded: ${bounded(operation.result)}`
    )
  } else {
    check.notEqual('bart.tools.unexpected-error',
      operation.isError,
      true,
      `${expectation.name} failed: ${bounded(operation.result)}`
    )
    if (expectation.expectOk !== false) {
      check.equal('bart.tools.result-ok',
        operation.result?.ok,
        true,
        `${expectation.name} did not report ok: ${bounded(operation.result)}`
      )
    }
  }
  expectation.validate?.(operation)
}

/** Builds the strict single-call directive shared by most acceptance cases. */
export function exactCallDirective(intro, name, callArguments, extraLines = []) {
  return [
    intro,
    `Call ${name} exactly once with the exact JSON arguments below.`,
    'Do not call any other OpenAgent tool and stop after the tool result.',
    ...extraLines,
    JSON.stringify(callArguments)
  ].join('\n')
}

/** Builds a directive that requires an ordered pair of native tool calls. */
export function orderedCallDirective(intro, first, second, extraLines = []) {
  return [
    intro,
    `First call ${first.name} with this exact JSON: ${JSON.stringify(first.arguments)}`,
    `Then call ${second.name} exactly once with this exact JSON: ${JSON.stringify(second.arguments)}`,
    'Do not call any other OpenAgent tool and do not send a normal follow-up.',
    ...extraLines
  ].join('\n')
}
