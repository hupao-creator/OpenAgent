import assert from 'node:assert/strict'
import { nativeModels } from '../host.mjs'
import { exactCallDirective } from '../bart.mjs'
import {
  assertContainsToken,
  assertSubsequence,
  bounded,
  findThread,
  latestExecution
} from '../support.mjs'

const FALLBACK_THREAD_TITLE = '未命名 Thread'

/**
 * The simplest complete control chain: create a Thread, observe its committed
 * public Execution, project it back through the Bart observation tools, and
 * dispose of it. Everything else in this matrix builds on these facts.
 */
export const lifecycleSuite = {
  id: 'lifecycle',
  tier: 'core',
  description: 'Thread creation, projection, follow-up, interrupt, and deletion',
  cases: [
    {
      id: 'start-complete',
      requires: ['plain'],
      description: 'A plain native task reaches completed with an exact marker',
      async run(context) {
        const marker = `LIFECYCLE_OK:${context.token}`
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: plainPrompt(context, marker)
        })
        const terminal = await context.waitForCompleted(threadId)
        assertContainsToken(
          terminal.summary,
          marker,
          `terminal summary did not carry the native completion marker: ${bounded(terminal)}`
        )
        assertSubsequence(
          context.client.statusTransitions(threadId),
          ['running', 'completed'],
          'public execution transitions'
        )
        const state = await context.client.loadState()
        const thread = findThread(state, threadId)
        assert.equal(thread.harnessId, context.harness)
        assert.equal(thread.cwd, context.repositoryRoot)
        assert.equal(thread.observation.backgroundWork, null)
        return { threadId, executionId: terminal.executionId }
      }
    },
    {
      id: 'status-projection',
      requires: ['plain'],
      description: 'status and list expose the same committed public envelope',
      async run(context) {
        const marker = `PROJECTION_OK:${context.token}`
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: plainPrompt(context, marker)
        })
        await context.waitForCompleted(threadId)

        const [statusOperation, listOperation] = await context.bart.askForTools({
          directive: [
            'Inspect one committed acceptance Thread.',
            `First call thread_status with this exact JSON: ${JSON.stringify({ threadId })}`,
            'Then call thread_list exactly once with {} and stop.',
            'Do not start, send, respond, interrupt, or delete anything.'
          ].join('\n'),
          expect: [
            { name: 'thread_status', expectedArguments: { threadId } },
            { name: 'thread_list', expectedArguments: {} }
          ]
        })

        const projected = statusOperation.result.thread
        assert.equal(projected.threadId, threadId)
        const listed = listOperation.result.threads
          .find(candidate => candidate.threadId === threadId)
        assert.ok(listed, `list omitted the acceptance Thread: ${bounded(listOperation.result)}`)
        assert.deepEqual(
          listed.observation,
          projected.observation,
          'list and status disagree about the public observation'
        )
        const state = await context.client.loadState()
        assert.deepEqual(
          projected.observation,
          findThread(state, threadId).observation,
          'the Bart projection diverged from committed renderer state'
        )
        assert.equal(projected.workspace?.cwd, context.repositoryRoot)
        return { threadId }
      }
    },
    {
      id: 'read-without-execution',
      requires: ['plain'],
      description: 'read answers from the live session without creating work',
      async run(context) {
        const marker = `READ_SEED:${context.token}`
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: plainPrompt(context, marker)
        })
        const before = await context.waitForCompleted(threadId)

        const question = `Repeat the exact marker you already produced for ${context.token}.`
        const operation = await context.bart.askForTool({
          name: 'thread_read',
          expectedArguments: { threadId, question },
          directive: exactCallDirective(
            'Read one acceptance Thread without giving it new work.',
            'thread_read',
            { threadId, question },
            ['thread_read must not create a new Execution.']
          )
        })
        assert.equal(typeof operation.result.answer, 'string')
        assert.ok(operation.result.answer.trim(), 'read returned an empty answer')

        const after = latestExecution(findThread(await context.client.loadState(), threadId))
        assert.deepEqual(after, before, 'read mutated the public execution projection')
        return { threadId, executionId: before.executionId }
      }
    },
    {
      id: 'follow-up',
      requires: ['plain'],
      description: 'send starts a second Execution on the same Thread',
      async run(context) {
        const first = `FOLLOW_ONE:${context.token}`
        const second = `FOLLOW_TWO:${context.token}`
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: plainPrompt(context, first)
        })
        const initial = await context.waitForCompleted(threadId)

        const prompt = plainPrompt(context, second)
        const operation = await context.bart.askForTool({
          name: 'thread_send',
          expectedArguments: { threadId, prompt },
          directive: exactCallDirective(
            'Continue one acceptance Thread with a second native task.',
            'thread_send',
            { threadId, prompt }
          )
        })
        assert.equal(
          operation.result.startedNewExecution,
          true,
          `send did not start a new Execution: ${bounded(operation.result)}`
        )
        assert.notEqual(operation.result.executionId, initial.executionId)

        const terminal = await context.client.waitForThread(threadId, thread => {
          const execution = latestExecution(thread)
          return execution?.executionId === operation.result.executionId &&
            execution.status === 'completed'
            ? execution
            : undefined
        }, `thread ${threadId} second execution`)
        assertContainsToken(
          terminal.summary,
          second,
          'the second Execution summary did not carry its own marker'
        )
        return { threadId, executionIds: [initial.executionId, terminal.executionId] }
      }
    },
    {
      id: 'steer-running',
      requires: ['shell'],
      description: 'send steers the current Execution instead of creating another one',
      async run(context) {
        const { threadId, operation: startOperation } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.permissiveOptions(),
          prompt: [
            `This is a native ${context.harness} live-steering acceptance case.`,
            `Run exactly this command in the foreground with the native ${context.provider.permissionTool} tool: sleep 120`,
            'Wait for it to finish. Do not run it in the background.',
            `Only after it exits, reply with exactly STEER_MISSED:${context.token}.`
          ].join('\n')
        })
        const executionId = startOperation.result.executionId
        await context.client.waitForThread(threadId, thread =>
          latestExecution(thread)?.executionId === executionId &&
          latestExecution(thread)?.status === 'running'
            ? thread
            : undefined,
          `thread ${threadId} running before steer`)

        const prompt = [
          'This is a live steering message for the current Execution.',
          `Remember the marker STEER_RECEIVED:${context.token}, but do not start another task.`
        ].join('\n')
        const sendOperation = await context.bart.askForTool({
          name: 'thread_send',
          expectedArguments: { threadId, prompt },
          directive: exactCallDirective(
            'Steer the currently running acceptance Thread.',
            'thread_send',
            { threadId, prompt }
          )
        })
        assert.equal(
          sendOperation.result.startedNewExecution,
          false,
          `a live steer created another Execution: ${bounded(sendOperation.result)}`
        )
        assert.equal(sendOperation.result.executionId, executionId)

        await context.bart.askForTool({
          name: 'thread_interrupt',
          expectedArguments: { threadId },
          directive: exactCallDirective(
            'Stop the live-steering acceptance Thread.',
            'thread_interrupt',
            { threadId }
          )
        })
        const terminal = await context.waitForTerminal(threadId)
        assert.equal(terminal.status, 'interrupted', bounded(terminal))
        assert.equal(terminal.executionId, executionId)
        return { threadId, executionId }
      }
    },
    {
      id: 'interrupt',
      requires: ['shell'],
      description: 'interrupt stops a live native Execution at interrupted',
      async run(context) {
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.permissiveOptions(),
          prompt: [
            `This is a native ${context.harness} interrupt acceptance case.`,
            `Run exactly this command in the foreground with the native ${context.provider.permissionTool} tool: sleep 120`,
            'Wait for it to finish. Do not run it in the background and do not yield early.',
            `Only after it exits, reply with exactly INTERRUPT_MISSED:${context.token}.`
          ].join('\n')
        })
        await context.client.waitForThread(threadId, thread =>
          latestExecution(thread)?.status === 'running' && nativeModels(thread).length ? thread : undefined,
          `thread ${threadId} running`)

        await context.bart.askForTool({
          name: 'thread_interrupt',
          expectedArguments: { threadId },
          directive: exactCallDirective(
            'Stop one running acceptance Thread now.',
            'thread_interrupt',
            { threadId }
          )
        })
        const terminal = await context.waitForTerminal(threadId)
        assert.equal(
          terminal.status,
          'interrupted',
          `interrupt did not produce an interrupted Execution: ${bounded(terminal)}`
        )
        assert.equal(typeof terminal.finishedAt, 'number')
        assert.ok(terminal.finishedAt >= terminal.startedAt)
        assertSubsequence(
          context.client.statusTransitions(threadId),
          ['running', 'interrupted'],
          'public execution transitions'
        )
        return { threadId, executionId: terminal.executionId }
      }
    },
    {
      id: 'metadata',
      requires: ['plain'],
      description: 'a committed Thread receives its generated title and tags',
      async run(context) {
        const marker = `METADATA_OK:${context.token}`
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: [
            `This is a native ${context.harness} Thread metadata acceptance case.`,
            'Do not use any tool.',
            'The subject of this Thread is the OpenAgent headless acceptance matrix.',
            `Reply with exactly ${marker} and nothing else.`
          ].join('\n')
        })
        await context.waitForCompleted(threadId)
        const thread = await context.client.waitForThread(threadId, candidate =>
          candidate.titlePending === undefined ? candidate : undefined,
          `thread ${threadId} metadata`)
        assert.notEqual(
          thread.title,
          FALLBACK_THREAD_TITLE,
          'the Thread kept the fallback title after metadata settled'
        )
        assert.ok(Array.isArray(thread.tags), `tags must be an array: ${bounded(thread)}`)
        return { threadId, title: thread.title, tags: thread.tags }
      }
    }
  ]
}

function plainPrompt(context, marker) {
  return [
    `This is a native ${context.harness} observation acceptance case.`,
    'Do not use any tool. Do not read or write any file. Do not run any command.',
    `Reply with exactly ${marker} and nothing else.`
  ].join('\n')
}
