import assert from 'node:assert/strict'
import {
  assertContainsToken,
  assertRecord,
  bounded,
  bartThread,
  findThread,
  isTerminal,
  latestExecution,
  requiredString
} from '../support.mjs'

/**
 * Bart receives terminal facts as internal native history. This suite keeps
 * the provider fact, the committed public observation, the injected history,
 * and Bart's later recall in one assertion chain so those surfaces cannot
 * silently drift apart.
 */
export const terminalHistorySuite = {
  id: 'terminal-history',
  tier: 'complex',
  description: 'Multi-Thread terminal facts stay ordered, unique, and observable',
  cases: [
    {
      id: 'multi-thread-injection',
      harnesses: ['codex'],
      hosts: ['codex'],
      requires: ['shell'],
      description: 'three out-of-order completions are injected once and recalled exactly',
      async run(context) {
        const plans = [
          { suffix: 'SLOW', delaySeconds: 18 },
          { suffix: 'FAST', delaySeconds: 6 },
          { suffix: 'MEDIUM', delaySeconds: 12 }
        ]
        const starts = plans.map(plan => {
          const marker = context.subToken(plan.suffix)
          return {
            marker,
            arguments: context.startArguments({
              cwd: context.repositoryRoot,
              worktree: false,
              options: context.permissiveOptions(),
              prompt: [
                'This is one branch of a multi-Thread terminal-history acceptance case.',
                `Use the shell tool exactly once to run: sleep ${plan.delaySeconds}; printf %s '${marker}'`,
                `After the command completes, output exactly ${marker}.`,
                'Do not modify files and do not ask questions.'
              ].join('\n')
            })
          }
        })

        // All starts must come from one Bart turn: separate Bart turns would
        // not exercise concurrent terminal-event injection into one history.
        const operations = await context.bart.askForTools({
          directive: [
            'Start one multi-Thread terminal-history acceptance batch.',
            'Call thread_create exactly three times, once with each JSON object below.',
            'Use the objects verbatim and preserve their order.',
            'Do not call status, respond, interrupt, delete, or any direct IPC.',
            'After the third tool result, stop. Do not wait for the target Threads.',
            ...starts.map(start => JSON.stringify(start.arguments))
          ].join('\n'),
          expect: starts.map(start => ({
            name: 'thread_create',
            expectedArguments: start.arguments
          }))
        })
        const targets = operations.map((operation, index) => ({
          threadId: requiredString(operation.result?.threadId, `start ${index} threadId`),
          executionId: requiredString(
            operation.result?.executionId,
            `start ${index} executionId`
          ),
          marker: starts[index].marker
        }))
        targets.forEach(target => context.threads.add(target.threadId))
        assert.equal(new Set(targets.map(target => target.threadId)).size, targets.length)
        assert.equal(new Set(targets.map(target => target.executionId)).size, targets.length)

        const terminalState = await context.client.waitForState(state => {
          const resolved = targets.map(target => {
            const thread = findThread(state, target.threadId)
            const execution = latestExecution(thread)
            return isTerminal(execution) ? { target, thread, execution } : undefined
          })
          return resolved.every(Boolean) ? resolved : undefined
        }, 'multi-Thread terminal completion')

        // Provider-private facts are the source material for the public
        // projection. Assert both now so a green UI cannot mask stale reality.
        for (const entry of terminalState) {
          assert.equal(entry.execution.executionId, entry.target.executionId)
          assert.equal(entry.execution.status, 'completed', bounded(entry.execution))
          assertContainsToken(entry.execution.summary, entry.target.marker)
          const privateTurn = entry.thread.sessionState?.turns?.findLast(turn =>
            turn.executionId === entry.target.executionId
          )
          assert.ok(privateTurn, `provider fact missing for ${entry.target.threadId}`)
          assert.equal(privateTurn.status, 'completed', bounded(privateTurn))
          assertContainsToken(privateTurn.answer, entry.target.marker)
          assert.equal(
            privateTurn.answer?.trim(),
            entry.execution.summary?.trim(),
            `public summary diverged from provider answer for ${entry.target.threadId}`
          )
          assert.ok(
            privateTurn.activities?.some(activity =>
              activity.kind === 'command' && activity.status === 'completed'
            ),
            `provider did not record the completed command for ${entry.target.threadId}`
          )
        }

        const injected = await context.client.waitForState(state => {
          const events = bartTerminalHistory(state)
            .filter(event => targets.some(target => target.threadId === event.payload.threadId))
          return targets.every(target => (
            events.filter(event => event.payload.threadId === target.threadId).length === 1
          )) ? events : undefined
        }, 'Bart terminal history injection')
        assert.equal(
          injected.length,
          targets.length,
          `unexpected duplicate terminal history: ${bounded(injected)}`
        )

        for (const target of targets) {
          const event = injected.find(candidate => candidate.payload.threadId === target.threadId)
          assert.ok(event, `missing terminal history for ${target.threadId}`)
          const execution = event.payload.observation?.latestExecution
          assert.equal(execution?.executionId, target.executionId)
          assert.equal(execution?.status, 'completed')
          assertContainsToken(execution?.summary, target.marker)
          assert.equal(event.message.internal, true)
          const visible = terminalState.find(entry => entry.target.threadId === target.threadId)
          assert.deepEqual(
            event.payload.observation,
            visible.thread.observation,
            `injected observation diverged from Core observation for ${target.threadId}`
          )
        }

        const expectedOrder = [...terminalState]
          .sort((left, right) => left.execution.finishedAt - right.execution.finishedAt)
          .map(entry => entry.target.threadId)
        assert.deepEqual(
          injected.map(event => event.payload.threadId),
          expectedOrder,
          'Bart terminal history order diverged from completion order'
        )

        const verificationToken = `VERIFY_${context.token}`
        const answer = await askBartForAnswer(context, verificationToken, [
          `Terminal history verification ${verificationToken}.`,
          'Do not call any tool and do not inspect current Thread state.',
          'Use only the terminal events injected into this Bart conversation after the prior batch.',
          'Output exactly three lines in terminal-event injection order.',
          'Each line must be: <threadId>|<terminal status>|<terminal summary>',
          'Do not add Markdown or commentary.'
        ].join('\n'))
        const expectedLines = injected.map(event => {
          const execution = event.payload.observation.latestExecution
          return `${event.payload.threadId}|${execution.status}|${execution.summary}`
        })
        assert.deepEqual(
          answer.split('\n').map(line => line.trim()).filter(Boolean),
          expectedLines,
          `Bart did not recall the exact injected terminal history: ${answer}`
        )

        const statusArguments = targets.map(target => ({ threadId: target.threadId }))
        const statusOperations = await context.bart.askForTools({
          directive: [
            'Verify the observable state of the three Threads from the prior batch.',
            'Call thread_status exactly three times, once with each JSON object below.',
            'Use the objects verbatim and preserve their order. Do not call any other tool.',
            'After the third tool result, stop.',
            ...statusArguments.map(arguments_ => JSON.stringify(arguments_))
          ].join('\n'),
          expect: statusArguments.map(arguments_ => ({
            name: 'thread_status',
            expectedArguments: arguments_
          }))
        })
        const statusState = await context.client.loadState()
        for (let index = 0; index < targets.length; index += 1) {
          const target = targets[index]
          const visible = findThread(statusState, target.threadId)
          assert.ok(visible, `renderer-visible Thread missing: ${target.threadId}`)
          assert.deepEqual(
            statusOperations[index].result?.thread?.observation,
            visible.observation,
            `Bart tool observation diverged from renderer state for ${target.threadId}`
          )
          assert.equal(statusOperations[index].result?.thread?.updatedAt, visible.updatedAt)
        }

        const finalEvents = bartTerminalHistory(statusState)
          .filter(event => targets.some(target => target.threadId === event.payload.threadId))
        assert.equal(
          finalEvents.length,
          targets.length,
          'terminal history duplicated after a later Bart turn'
        )
        return {
          threadIds: targets.map(target => target.threadId),
          executionIds: targets.map(target => target.executionId),
          terminalOrder: expectedOrder
        }
      }
    }
  ]
}

async function askBartForAnswer(context, token, directive) {
  await context.client.waitForBartIdle('Bart idle before terminal-history recall')
  await context.bart.submit(directive)
  return context.client.waitForState(state => {
    const turns = bartThread(state)?.sessionState?.turns
    if (!Array.isArray(turns)) return undefined
    const turn = turns.findLast(candidate => (
      Array.isArray(candidate.messages) &&
      candidate.messages.some(message =>
        message?.role === 'user' &&
        message?.internal !== true &&
        typeof message?.content === 'string' &&
        message.content.includes(token)
      )
    ))
    if (!turn || !isTerminal(turn) || typeof turn.answer !== 'string') return undefined
    return turn.answer.trim()
  }, `Bart terminal-history recall ${token}`)
}

function bartTerminalHistory(state) {
  const bart = bartThread(state)
  assert.equal(bart?.harnessId, 'codex', 'terminal-history expects the Codex Bart host')
  const turns = bart?.sessionState?.turns
  if (!Array.isArray(turns)) return []
  return turns.flatMap(turn => Array.isArray(turn.messages) ? turn.messages : [])
    .flatMap(message => {
      if (
        message?.internal !== true ||
        typeof message.content !== 'string' ||
        !message.content.startsWith('OpenAgent Agent Thread terminal event:\n')
      ) return []
      const payload = JSON.parse(message.content.split('\n', 2)[1])
      assertRecord(payload, 'Bart terminal history payload')
      return [{ message, payload }]
    })
}
