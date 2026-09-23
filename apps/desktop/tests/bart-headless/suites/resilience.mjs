import assert from 'node:assert/strict'
import { exactCallDirective } from '../bart.mjs'
import {
  assertMissing,
  bounded,
  bartThread,
  findThread,
  latestExecution,
  toolOperations
} from '../support.mjs'
import { permissionPrompt, preparePermissionEvidence } from './permission.mjs'

/**
 * Guardrails are part of the public contract. Every case here proves that a
 * rejected command changed nothing: no Thread, no response, no lost interaction.
 */
export const resilienceSuite = {
  id: 'resilience',
  tier: 'extended',
  description: 'Rejected commands leave committed state untouched',
  cases: [
    {
      id: 'unknown-thread',
      scope: 'once',
      requires: ['plain'],
      description: 'status refuses an identifier that never existed',
      async run(context) {
        const threadId = `absent-${context.token}`
        const before = await context.client.loadState()
        const status = await context.bart.askForToolFailure({
          name: 'thread_status',
          expectedArguments: { threadId },
          errorPattern: /不存在|not exist|not found/i,
          directive: exactCallDirective(
            'Inspect a Thread identifier that does not exist.',
            'thread_status',
            { threadId },
            ['Report the tool error verbatim. Do not create anything.']
          )
        })
        const after = await context.client.loadState()
        assert.equal(after.threads.length, before.threads.length)
        return { status: status.message }
      }
    },
    {
      id: 'respond-to-unknown-interaction',
      requires: ['permission'],
      description: 'a stale interaction id cannot consume a pending interaction',
      async run(context) {
        const proofPath = context.proofPath('STALE')
        const evidence = await preparePermissionEvidence(context, proofPath)
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: permissionPrompt(context, proofPath, evidence)
        })
        const { interaction } = await context.waitForInteraction(threadId, 'permission')
        const allow = context.answerFor(interaction, 'allow')

        const staleArguments = {
          threadId,
          interactionId: `stale-${context.token}`,
          actionId: allow.actionId
        }
        let message = ''
        await assert.rejects(
          () => context.client.invoke('thread:interaction-respond', staleArguments),
          error => { message = String(error); return true }
        )
        assert.ok(message.trim(), 'the rejected respond produced no error message')
        if (evidence.kind === 'write-proof') {
          await assertMissing(proofPath, 'native proof after a stale respond')
        }

        const stillWaiting = await context.waitForInteraction(threadId, 'permission')
        assert.equal(
          stillWaiting.interaction.id,
          interaction.id,
          'the stale respond consumed the pending interaction'
        )
        const { terminal } = await context.allowPermissionChain({
          threadId, interaction: stillWaiting.interaction
        })
        return { threadId, executionId: terminal.executionId, guardrail: message }
      }
    },
    {
      id: 'respond-to-consumed-interaction',
      requires: ['permission'],
      description: 'a second response cannot replay an interaction that already completed',
      async run(context) {
        const proofPath = context.proofPath('CONSUMED')
        const evidence = await preparePermissionEvidence(context, proofPath)
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: permissionPrompt(context, proofPath, evidence)
        })
        const { interaction } = await context.waitForInteraction(threadId, 'permission')
        const actionId = context.answerFor(interaction, 'allow').actionId
        const { terminal } = await context.allowPermissionChain({ threadId, interaction })
        const replayArguments = {
          threadId,
          interactionId: interaction.id,
          actionId
        }
        let message = ''
        await assert.rejects(
          () => context.client.invoke('thread:interaction-respond', replayArguments),
          error => { message = String(error); return /interaction|pending|waiting|等待|active/i.test(message) }
        )
        const after = latestExecution(findThread(await context.client.loadState(), threadId))
        assert.deepEqual(after, terminal, 'a replayed interaction response mutated the terminal state')
        return {
          threadId,
          executionId: terminal.executionId,
          interactionId: interaction.id,
          guardrail: message
        }
      }
    },
    {
      id: 'bart-cancel',
      scope: 'once',
      requires: ['plain'],
      description: 'cancel interrupts a streaming Bart Execution and releases its slot',
      async run(context) {
        await context.client.waitForBartIdle('Bart idle before cancel case')
        const before = await context.client.loadState()
        const existingOperations = new Set(toolOperations(before).map(operation => operation.id))
        const submission = context.bart
          .submit([
            'This is a Bart cancellation acceptance case.',
            'Do not call any tool, run a command, or delegate work.',
            'Write every integer from 1 to 20000, one per line, without omissions or commentary.',
            'Begin your answer with the first integer immediately. Continue until interrupted.'
          ].join('\n'))
          .catch(error => error)

        const running = await context.client.waitForState(state =>
          state.executions.length === 1 ? state.executions[0] : undefined,
          'Bart execution running')
        assert.equal(running.status, 'running')

        // Core transcript is an orchestration audit, not native assistant
        // output. Observe generated text through the public execution summary.
        // This numeric prefix does not occur verbatim in the user prompt.
        const outputPrefix = /^1\s+2\s+3\s+4\s+5(?:\s|$)/
        await context.client.waitForState(state => {
          const execution = latestExecution(bartThread(state))
          if (!execution) return undefined
          assert.equal(execution.executionId, running.executionId,
            'cancel precondition failed: the Bart Execution was replaced')
          assert.equal(execution.status, 'running',
            'cancel precondition failed: the Bart Execution ended before cancellation')
          return outputPrefix.test(execution.summary || '') ? execution : undefined
        }, 'Bart generating a native answer')

        await context.client.invoke('bart:cancel')
        const settled = await context.client.waitForState(state => {
          const execution = latestExecution(bartThread(state))
          return state.executions.length === 0 &&
            execution?.executionId === running.executionId &&
            execution.status !== 'running' ? state : undefined
        }, 'Bart execution settled')
        await submission

        const interrupted = latestExecution(bartThread(settled))
        assert.equal(interrupted.status, 'interrupted', bounded(interrupted))
        assert.match(interrupted.summary || '', outputPrefix,
          'cancellation lost the already-generated answer')
        assert.deepEqual(toolOperations(settled).filter(operation =>
          !existingOperations.has(operation.id)), [], 'the native answer invoked tools')
        return { executionId: running.executionId, status: interrupted.status }
      }
    }
  ]
}
