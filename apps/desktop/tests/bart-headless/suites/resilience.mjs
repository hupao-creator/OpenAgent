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
      description: 'status and delete refuse an identifier that never existed',
      async run(context) {
        const threadId = `absent-${context.token}`
        const before = await context.client.loadState()
        const status = await context.bart.askForToolFailure({
          name: 'openagent_thread_status',
          expectedArguments: { threadId },
          errorPattern: /不存在|not exist|not found/i,
          directive: exactCallDirective(
            'Inspect a Thread identifier that does not exist.',
            'openagent_thread_status',
            { threadId },
            ['Report the tool error verbatim. Do not create anything.']
          )
        })
        const deletion = await context.bart.askForToolFailure({
          name: 'openagent_thread_delete',
          expectedArguments: { threadId },
          errorPattern: /不存在|not exist|not found/i,
          directive: exactCallDirective(
            'Delete a Thread identifier that does not exist.',
            'openagent_thread_delete',
            { threadId },
            ['Report the tool error verbatim. Do not create anything.']
          )
        })
        const after = await context.client.loadState()
        assert.equal(after.threads.length, before.threads.length)
        return { status: status.message, deletion: deletion.message }
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
        const { message } = await context.bart.askForToolFailure({
          name: 'openagent_thread_respond',
          expectedArguments: staleArguments,
          directive: exactCallDirective(
            'Answer a native interaction with an identifier that is not pending.',
            'openagent_thread_respond',
            staleArguments,
            ['Report the tool error verbatim. Do not retry with the real interaction id.']
          )
        })
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
        const { message } = await context.bart.askForToolFailure({
          name: 'openagent_thread_respond',
          expectedArguments: replayArguments,
          errorPattern: /interaction|pending|waiting|等待|active/i,
          directive: exactCallDirective(
            'Replay a response for an interaction that has already completed.',
            'openagent_thread_respond',
            replayArguments,
            ['Report the tool error verbatim. Do not send a follow-up.']
          )
        })
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
      id: 'delete-running-thread',
      requires: ['plain'],
      description: 'delete interrupts a live Execution and removes the Thread',
      async run(context) {
        const marker = `DELETE_STREAM:${context.token}`
        const { threadId, operation: startOperation } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.permissiveOptions(),
          prompt: [
            `This is a native ${context.harness} deletion acceptance case.`,
            'Do not call any tools, run commands, create files, delegate, or start background work.',
            'Generate your answer directly as assistant text.',
            `Start with exactly ${marker} on the first line, with no introduction.`,
            'Then write every integer from 1 through 4000, one integer per line, in order.',
            'Do not skip numbers, summarize, use ellipses, or finish before the entire sequence is written.',
            `Only after 4000, write DELETE_MISSED:${context.token}.`
          ].join('\n')
        })
        const executionId = startOperation.result.executionId
        await context.client.waitForThread(threadId, thread => {
          const execution = latestExecution(thread)
          if (!execution) return undefined
          assert.equal(execution.executionId, executionId,
            'delete-running-thread precondition failed: the original Execution was replaced')
          assert.equal(execution.status, 'running',
            `delete-running-thread precondition failed: Execution became ${execution.status} before deletion`)
          assert.equal(thread.observation.backgroundWork, null,
            'delete-running-thread precondition failed: native background work appeared')
          // Public summaries update during generation. The prompt has another
          // prefix, so this cannot match an initial user-input projection.
          return execution.summary?.startsWith(marker) ? thread : undefined
        }, `thread ${threadId} generating foreground text before deletion`)

        await context.bart.askForTool({
          name: 'openagent_thread_delete',
          expectedArguments: { threadId },
          directive: exactCallDirective(
            'Remove one running acceptance Thread.',
            'openagent_thread_delete',
            { threadId }
          )
        })
        const state = await context.client.waitForState(candidate =>
          findThread(candidate, threadId) ? undefined : candidate,
          `thread ${threadId} removed`)
        assert.ok(
          !context.client.statusTransitions(threadId).some(status =>
            status === 'completed' || status === 'failed'),
          'delete-running-thread precondition failed: native generation finished before deletion'
        )
        assert.equal(findThread(state, threadId), undefined)
        context.threads.delete(threadId)
        return { threadId }
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
