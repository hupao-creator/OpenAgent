import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { exactCallDirective } from '../bart.mjs'
import {
  assertContainsToken,
  bounded,
  latestExecution,
  shellQuote
} from '../support.mjs'

/**
 * Native background work outlives its foreground Execution. Bart must observe
 * both facts at once, and the observation must clear on its own without ever
 * rewriting the Execution that already completed.
 */
export const backgroundSuite = {
  id: 'background',
  tier: 'core',
  description: 'Background native work observed beside a completed Execution',
  cases: [
    {
      id: 'observe-and-settle',
      requires: ['background'],
      description: 'a completed Execution coexists with running background work',
      async run(context) {
        const marker = `BACKGROUND_STARTED:${context.token}`
        const proofPath = context.proofPath('BACKGROUND')
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.permissiveOptions(),
          prompt: backgroundPrompt(context, proofPath, 45, marker)
        })

        const observed = await waitForRunningBackgroundWork(context, threadId)
        const foregroundExecutionId = latestExecution(observed).executionId
        assertContainsToken(
          latestExecution(observed).summary,
          marker,
          'the foreground Execution did not report that it yielded'
        )

        const statusOperation = await context.bart.askForTool({
          name: 'openagent_thread_status',
          expectedArguments: { threadId },
          directive: exactCallDirective(
            'Inspect the native background-work acceptance Thread.',
            'openagent_thread_status',
            { threadId }
          )
        })
        const projected = statusOperation.result.thread.observation
        assert.equal(projected.latestExecution?.status, 'completed', bounded(statusOperation.result))
        assert.equal(projected.backgroundWork?.status, 'running', bounded(statusOperation.result))

        const settled = await context.client.waitForThread(threadId, thread =>
          thread.observation?.backgroundWork === null ? thread : undefined,
          `thread ${threadId} background settled`)
        assert.equal(latestExecution(settled).executionId, foregroundExecutionId)
        assert.equal(latestExecution(settled).status, 'completed')
        assert.equal(await readFile(proofPath, 'utf8'), context.token)
        return { threadId, executionId: foregroundExecutionId }
      }
    },
    {
      id: 'follow-up-during-background',
      requires: ['background'],
      description: 'a new Execution runs while background work is still live',
      async run(context) {
        const marker = `BACKGROUND_STARTED:${context.token}`
        const followUpMarker = `BACKGROUND_FOLLOW_UP:${context.token}`
        const proofPath = context.proofPath('BACKGROUND_FOLLOW')
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.permissiveOptions(),
          prompt: backgroundPrompt(context, proofPath, 90, marker)
        })
        const observed = await waitForRunningBackgroundWork(context, threadId)
        const foregroundExecutionId = latestExecution(observed).executionId

        const prompt = [
          'Do not touch the background command and do not wait for it.',
          `Reply with exactly ${followUpMarker} and nothing else.`
        ].join('\n')
        const sendOperation = await context.bart.askForTool({
          name: 'openagent_thread_send',
          expectedArguments: { threadId, prompt },
          directive: exactCallDirective(
            'Give the background-work acceptance Thread a second foreground task.',
            'openagent_thread_send',
            { threadId, prompt }
          )
        })
        assert.equal(sendOperation.result.startedNewExecution, true, bounded(sendOperation.result))
        assert.notEqual(sendOperation.result.executionId, foregroundExecutionId)

        const second = await context.client.waitForThread(threadId, thread => {
          const execution = latestExecution(thread)
          return execution?.executionId === sendOperation.result.executionId &&
            execution.status === 'completed'
            ? thread
            : undefined
        }, `thread ${threadId} second execution`)
        assert.equal(
          second.observation.backgroundWork?.status,
          'running',
          `background work was lost across the second Execution: ${bounded(second.observation)}`
        )
        assertContainsToken(
          latestExecution(second).summary,
          followUpMarker,
          'the second Execution did not report its own marker'
        )

        // Interrupt only ever targets a foreground Execution. Live background
        // work is not interruptible through the public surface, and the tool
        // has to say so instead of silently reporting success.
        const { message } = await context.bart.askForToolFailure({
          name: 'openagent_thread_interrupt',
          expectedArguments: { threadId },
          errorPattern: /active Execution|没有 active/,
          directive: exactCallDirective(
            'Try to interrupt a Thread whose only remaining work is in the background.',
            'openagent_thread_interrupt',
            { threadId },
            ['Report the tool error verbatim. Do not delete the Thread.']
          )
        })

        const cleared = await context.client.waitForThread(threadId, thread =>
          thread.observation?.backgroundWork === null ? thread : undefined,
          `thread ${threadId} background settled`)
        assert.equal(
          latestExecution(cleared).executionId,
          sendOperation.result.executionId,
          'settling background work rewrote the terminal Execution'
        )
        assert.equal(latestExecution(cleared).status, 'completed')
        assert.equal(await readFile(proofPath, 'utf8'), context.token)
        return {
          threadId,
          guardrail: message,
          executionIds: [foregroundExecutionId, sendOperation.result.executionId]
        }
      }
    }
  ]
}

async function waitForRunningBackgroundWork(context, threadId) {
  return context.client.waitForThread(threadId, thread => {
    const execution = latestExecution(thread)
    if (execution?.status === 'failed' || execution?.status === 'interrupted') {
      throw new Error(`the background foreground Execution failed: ${bounded(execution)}`)
    }
    return execution?.status === 'completed' &&
      thread.observation?.backgroundWork?.status === 'running'
      ? thread
      : undefined
  }, `thread ${threadId} background work`)
}

function backgroundPrompt(context, proofPath, seconds, marker) {
  const command =
    `sleep ${seconds}; printf %s ${shellQuote(context.token)} > ${shellQuote(proofPath)}`
  return [
    'This is a native background-work observation acceptance case.',
    `Run exactly this command with the native ${context.provider.permissionTool} tool: ${command}`,
    'Configure the tool call to yield after 1000ms so the command remains in a background terminal.',
    'As soon as the tool reports that the process is still running, do not poll or wait for it.',
    `Finish the foreground response with exactly ${marker}.`
  ].join('\n')
}
