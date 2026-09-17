import assert from 'node:assert/strict'
import { exactCallDirective } from '../bart.mjs'
import {
  assertContainsToken,
  assertSubsequence,
  bounded,
  containsToken,
  findThread,
  latestExecution
} from '../support.mjs'
import {
  assertEvidenceUnlocked,
  permissionPrompt,
  preparePermissionEvidence
} from './permission.mjs'
import { questionPrompt } from './question.mjs'

/**
 * Composed journeys. Each case chains capabilities that are individually
 * covered elsewhere, so a failure here means the combination broke, not the
 * primitive.
 */
export const combinationSuite = {
  id: 'combination',
  tier: 'complex',
  description: 'Multi-Execution and multi-Thread journeys through one Bart',
  cases: [
    {
      id: 'permission-then-question',
      requires: ['permission', 'question'],
      description: 'two native interaction kinds on one Thread, in order',
      async run(context) {
        const proofPath = context.proofPath('CHAIN')
        const evidence = await preparePermissionEvidence(context, proofPath)
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: permissionPrompt(context, proofPath, evidence)
        })
        const first = await context.waitForInteraction(threadId, 'permission')
        const { terminal: permissionTerminal } = await context.allowPermissionChain({
          threadId, interaction: first.interaction
        })
        await assertEvidenceUnlocked(evidence, proofPath, permissionTerminal, context)

        const prompt = questionPrompt(context)
        const sendOperation = await context.bart.askForTool({
          name: 'openagent_thread_send',
          expectedArguments: { threadId, prompt },
          directive: exactCallDirective(
            'Give the same acceptance Thread a native question task.',
            'openagent_thread_send',
            { threadId, prompt }
          )
        })
        assert.equal(sendOperation.result.startedNewExecution, true, bounded(sendOperation.result))

        const second = await context.waitForInteraction(threadId, 'question')
        assert.notEqual(
          second.interaction.id,
          first.interaction.id,
          'the second interaction reused the permission interaction id'
        )
        const answer = context.answerFor(second.interaction, 'submit', { optionIndex: 1 })
        await context.respond({
          threadId,
          interaction: second.interaction,
          actionId: answer.actionId,
          answers: answer.answers
        })
        const terminal = await context.waitForCompleted(threadId)
        assertContainsToken(
          terminal.summary,
          `QUESTION_OK:${context.token}:${answer.expectedLabel}`,
          `the chained question answer was not observed: ${bounded(terminal)}`
        )
        assertSubsequence(
          context.client.statusTransitions(threadId),
          [
            'running', 'waiting-for-user', 'running', 'completed',
            'running', 'waiting-for-user', 'running', 'completed'
          ],
          'chained public execution transitions'
        )
        return {
          threadId,
          interactionIds: [first.interaction.id, second.interaction.id],
          executionIds: [permissionTerminal.executionId, terminal.executionId]
        }
      }
    },
    {
      id: 'interrupt-then-resume',
      requires: ['shell'],
      description: 'an interrupted Thread still accepts and completes new work',
      async run(context) {
        const marker = `RESUME_OK:${context.token}`
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.permissiveOptions(),
          prompt: [
            `This is a native ${context.harness} interrupt-and-resume acceptance case.`,
            `Run exactly this command in the foreground with the native ${context.provider.permissionTool} tool: sleep 120`,
            'Wait for it to finish. Do not run it in the background.',
            `Only after it exits, reply with exactly RESUME_MISSED:${context.token}.`
          ].join('\n')
        })
        await context.client.waitForThread(threadId, thread =>
          latestExecution(thread)?.status === 'running' ? thread : undefined,
          `thread ${threadId} running`)
        await context.bart.askForTool({
          name: 'openagent_thread_interrupt',
          expectedArguments: { threadId },
          directive: exactCallDirective(
            'Stop the running acceptance Thread.',
            'openagent_thread_interrupt',
            { threadId }
          )
        })
        const interrupted = await context.waitForTerminal(threadId)
        assert.equal(interrupted.status, 'interrupted', bounded(interrupted))

        const prompt = [
          'Forget the previous command. Do not run any tool.',
          `Reply with exactly ${marker} and nothing else.`
        ].join('\n')
        const sendOperation = await context.bart.askForTool({
          name: 'openagent_thread_send',
          expectedArguments: { threadId, prompt },
          directive: exactCallDirective(
            'Resume the interrupted acceptance Thread with a new task.',
            'openagent_thread_send',
            { threadId, prompt }
          )
        })
        assert.equal(sendOperation.result.startedNewExecution, true, bounded(sendOperation.result))
        const terminal = await context.client.waitForThread(threadId, thread => {
          const execution = latestExecution(thread)
          return execution?.executionId === sendOperation.result.executionId &&
            execution.status === 'completed'
            ? execution
            : undefined
        }, `thread ${threadId} resumed execution`)
        assertContainsToken(terminal.summary, marker, bounded(terminal))
        assertSubsequence(
          context.client.statusTransitions(threadId),
          ['running', 'interrupted', 'running', 'completed'],
          'resumed public execution transitions'
        )
        return {
          threadId,
          executionIds: [interrupted.executionId, terminal.executionId]
        }
      }
    },
    {
      id: 'concurrent-threads',
      requires: ['permission'],
      description: 'two Threads wait at once and are answered out of order',
      async run(context) {
        const first = await startPendingPermissionThread(context, 'ONE')
        const second = await startPendingPermissionThread(context, 'TWO')
        assert.notEqual(first.threadId, second.threadId)

        // The second Thread is answered first: a public response must be routed
        // by its own threadId, never by whichever interaction is newest.
        const { terminal: secondTerminal } = await context.allowPermissionChain({
          threadId: second.threadId, interaction: second.interaction
        })
        await assertEvidenceUnlocked(
          second.evidence,
          second.proofPath,
          secondTerminal,
          second.scoped
        )

        const stillWaiting = await context.waitForInteraction(first.threadId, 'permission')
        assert.equal(
          stillWaiting.interaction.id,
          first.interaction.id,
          'answering one Thread disturbed the other pending interaction'
        )
        const { terminal: firstTerminal } = await context.allowPermissionChain({
          threadId: first.threadId, interaction: first.interaction
        })
        await assertEvidenceUnlocked(
          first.evidence,
          first.proofPath,
          firstTerminal,
          first.scoped
        )
        return {
          threadIds: [first.threadId, second.threadId],
          order: [second.threadId, first.threadId]
        }
      }
    },
    {
      id: 'thread-to-report-journey',
      scope: 'once',
      requires: ['plain'],
      description: 'a Thread is observed, reported on, and then retired',
      async run(context) {
        const marker = `JOURNEY_OK:${context.token}`
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: [
            `This is a native ${context.harness} journey acceptance case.`,
            'Do not use any tool.',
            `Reply with exactly ${marker} and nothing else.`
          ].join('\n')
        })
        const reportSource = await context.waitForCompleted(threadId)
        const relatedExecutions = [{ threadId, executionId: reportSource.executionId }]

        const question = `State the exact marker you produced for ${context.token}.`
        const readOperation = await context.bart.askForTool({
          name: 'openagent_thread_read',
          expectedArguments: { threadId, question },
          directive: exactCallDirective(
            'Read the journey acceptance Thread without giving it new work.',
            'openagent_thread_read',
            { threadId, question }
          )
        })
        assert.ok(readOperation.result.answer.trim())

        const title = `Journey ${context.token}`.slice(0, 60)
        const createOperation = await context.bart.askForTool({
          name: 'openagent_report_create',
          matchArguments(callArguments) {
            assert.equal(callArguments.title, title)
            assert.ok(containsToken(callArguments.html, context.token))
            assert.deepEqual(callArguments.relatedExecutions, relatedExecutions)
          },
          directive: [
            'Record the journey acceptance Thread as a Report.',
            'Call openagent_report_create exactly once and then stop.',
            `Use exactly this title: ${title}`,
            `The html must be a single <p> element whose text is exactly ${context.token}.`,
            `Set relatedExecutions to exactly ${JSON.stringify(relatedExecutions)}.`
          ].join('\n')
        })
        const reportId = createOperation.result.report.id

        await context.bart.askForTool({
          name: 'openagent_thread_delete',
          expectedArguments: { threadId },
          directive: exactCallDirective(
            'Retire the journey acceptance Thread.',
            'openagent_thread_delete',
            { threadId }
          )
        })
        context.threads.delete(threadId)

        const state = await context.client.waitForState(candidate =>
          findThread(candidate, threadId) ? undefined : candidate,
          `thread ${threadId} removed`)
        const report = state.reports.find(candidate => candidate.id === reportId)
        assert.ok(report, 'deleting a Thread removed the Report that referenced it')
        assert.deepEqual(
          report.relatedExecutions,
          relatedExecutions,
          'the Report silently rewrote its related Thread references'
        )

        await context.bart.askForTool({
          name: 'openagent_report_delete',
          expectedArguments: { reportId },
          directive: exactCallDirective(
            'Delete the journey acceptance Report.',
            'openagent_report_delete',
            { reportId }
          )
        })
        return { threadId, reportId }
      }
    }
  ]
}

async function startPendingPermissionThread(context, suffix) {
  const scoped = context.withToken(context.subToken(suffix))
  const proofPath = scoped.proofPath('CONCURRENT')
  const evidence = await preparePermissionEvidence(scoped, proofPath)
  const { threadId } = await scoped.start({
    cwd: scoped.repositoryRoot,
    worktree: false,
    options: scoped.options(),
    prompt: permissionPrompt(scoped, proofPath, evidence)
  })
  const { interaction } = await scoped.waitForInteraction(threadId, 'permission')
  return { threadId, interaction, evidence, proofPath, scoped }
}
