import assert from 'node:assert/strict'
import { exactCallDirective } from '../bart.mjs'
import { assertContainsToken, bounded } from '../support.mjs'

const DISPATCH_LEAD_MS = 75_000
const CANCEL_LEAD_MS = 30 * 60_000

/**
 * A pending dispatch owns no Thread. These cases prove that the Thread appears
 * only when the dispatch is actually due, and never appears after a cancel.
 */
export const scheduleSuite = {
  id: 'schedule',
  tier: 'extended',
  description: 'Future dispatches that create a Thread only when due',
  cases: [
    {
      id: 'past-execute-at-is-rejected',
      scope: 'once',
      requires: ['plain'],
      description: 'a timestamp in the past creates neither a schedule nor a Thread',
      async run(context) {
        const executeAt = new Date(Date.now() - 60_000).toISOString()
        const scheduleArguments = {
          ...context.startArguments({
            cwd: context.repositoryRoot,
            worktree: false,
            options: context.options(),
            prompt: schedulePrompt(context, `SCHEDULE_PAST:${context.token}`)
          }),
          executeAt
        }
        const before = await context.client.loadState()
        const { message } = await context.bart.askForToolFailure({
          name: 'openagent_schedule_create',
          expectedArguments: scheduleArguments,
          errorPattern: /未来|future/i,
          directive: exactCallDirective(
            'Attempt one deliberately expired scheduled dispatch.',
            'openagent_schedule_create',
            scheduleArguments,
            ['Report the tool error verbatim. Do not change executeAt.']
          )
        })
        const listOperation = await context.bart.askForTool({
          name: 'openagent_schedule_list',
          expectedArguments: {},
          directive: exactCallDirective(
            'List schedules after the rejected expired dispatch.',
            'openagent_schedule_list',
            {}
          )
        })
        assert.ok(
          !listOperation.result.schedules.some(schedule => schedule.executeAt === executeAt),
          `the rejected expired dispatch was persisted: ${bounded(listOperation.result)}`
        )
        const after = await context.client.loadState()
        assert.equal(after.threads.length, before.threads.length)
        return { executeAt, message }
      }
    },
    {
      id: 'dispatch-when-due',
      scope: 'once',
      requires: ['plain'],
      description: 'a due dispatch creates and runs exactly one Thread',
      async run(context) {
        const marker = `SCHEDULE_OK:${context.token}`
        const executeAt = new Date(Date.now() + DISPATCH_LEAD_MS).toISOString()
        const scheduleArguments = {
          ...context.startArguments({
            cwd: context.repositoryRoot,
            worktree: false,
            options: context.options(),
            prompt: schedulePrompt(context, marker)
          }),
          executeAt
        }
        const before = await context.client.loadState()
        const existingThreadIds = new Set(before.threads.map(thread => thread.id))

        const createOperation = await context.bart.askForTool({
          name: 'openagent_schedule_create',
          expectedArguments: scheduleArguments,
          directive: exactCallDirective(
            'Register one future dispatch for this acceptance run.',
            'openagent_schedule_create',
            scheduleArguments,
            ['Do not start the Thread yourself and do not adjust executeAt.']
          )
        })
        const scheduleId = createOperation.result.schedule.scheduleId
        assert.equal(createOperation.result.schedule.harnessId, context.harness)
        assert.equal(createOperation.result.schedule.executeAt, executeAt)

        const listOperation = await context.bart.askForTool({
          name: 'openagent_schedule_list',
          expectedArguments: {},
          directive: exactCallDirective(
            'List the pending dispatches for this acceptance run.',
            'openagent_schedule_list',
            {}
          )
        })
        assert.ok(
          listOperation.result.schedules
            .some(schedule => schedule.scheduleId === scheduleId),
          `the pending dispatch is not listed: ${bounded(listOperation.result)}`
        )
        const pending = await context.client.loadState()
        assert.equal(
          pending.threads.filter(thread => !existingThreadIds.has(thread.id)).length,
          0,
          'a pending dispatch created a Thread before it was due'
        )

        const dispatched = await context.client.waitForState(state => {
          const created = state.threads
            .filter(thread => !existingThreadIds.has(thread.id) && thread.bart !== true)
          if (created.length > 1) {
            throw new Error(`one dispatch created ${created.length} Threads`)
          }
          return created.length === 1 ? created[0] : undefined
        }, 'scheduled dispatch Thread', DISPATCH_LEAD_MS + context.client.timeoutMs)
        context.threads.add(dispatched.id)

        const terminal = await context.waitForCompleted(dispatched.id)
        assertContainsToken(terminal.summary, marker, bounded(terminal))
        assert.equal(dispatched.harnessId, context.harness)

        const settledList = await context.bart.askForTool({
          name: 'openagent_schedule_list',
          expectedArguments: {},
          directive: exactCallDirective(
            'List the pending dispatches again.',
            'openagent_schedule_list',
            {}
          )
        })
        assert.ok(
          !settledList.result.schedules
            .some(schedule => schedule.scheduleId === scheduleId),
          `a consumed dispatch is still pending: ${bounded(settledList.result)}`
        )
        return { scheduleId, threadId: dispatched.id, executionId: terminal.executionId }
      }
    },
    {
      id: 'cancel-before-due',
      scope: 'once',
      requires: ['plain'],
      description: 'a cancelled dispatch never produces a Thread',
      async run(context) {
        const executeAt = new Date(Date.now() + CANCEL_LEAD_MS).toISOString()
        const scheduleArguments = {
          ...context.startArguments({
            cwd: context.repositoryRoot,
            worktree: false,
            options: context.options(),
            prompt: schedulePrompt(context, `SCHEDULE_CANCELLED:${context.token}`)
          }),
          executeAt
        }
        const before = await context.client.loadState()
        const createOperation = await context.bart.askForTool({
          name: 'openagent_schedule_create',
          expectedArguments: scheduleArguments,
          directive: exactCallDirective(
            'Register one future dispatch that will be cancelled.',
            'openagent_schedule_create',
            scheduleArguments
          )
        })
        const scheduleId = createOperation.result.schedule.scheduleId

        const [cancelOperation, listOperation] = await context.bart.askForTools({
          directive: [
            'Retire the pending acceptance dispatch.',
            `First call openagent_schedule_cancel with this exact JSON: ${JSON.stringify({ scheduleId })}`,
            'Then call openagent_schedule_list exactly once with {} and stop.'
          ].join('\n'),
          expect: [
            { name: 'openagent_schedule_cancel', expectedArguments: { scheduleId } },
            { name: 'openagent_schedule_list', expectedArguments: {} }
          ]
        })
        assert.equal(cancelOperation.result.schedule.scheduleId, scheduleId)
        assert.ok(
          !listOperation.result.schedules
            .some(schedule => schedule.scheduleId === scheduleId),
          `the cancelled dispatch is still pending: ${bounded(listOperation.result)}`
        )
        const after = await context.client.loadState()
        assert.equal(
          after.threads.length,
          before.threads.length,
          'a cancelled dispatch still created a Thread'
        )
        return { scheduleId }
      }
    }
  ]
}

function schedulePrompt(context, marker) {
  return [
    'This is a native scheduled-dispatch acceptance case.',
    'Do not use any tool.',
    `Reply with exactly ${marker} and nothing else.`
  ].join('\n')
}
