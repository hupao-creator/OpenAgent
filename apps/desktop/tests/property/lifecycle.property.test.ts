import fc from 'fast-check'
import { expect, it } from 'vitest'
import type { PublicExecution, ThreadPublicObservation } from '@openagent/contracts'
import { checkAsync, sequenceLength } from './check'
import { deferred, input, lifecycleDriver, permission, signal } from './lifecycle-driver'

const operation = fc.constantFrom('send', 'stop', 'stale-stop', 'no-target-stop', 'service-stop',
  'wait', 'respond', 'stale-respond', 'complete', 'fail', 'background', 'unarchive', 'dispose', 'reopen')
const operations = fc.array(operation, { minLength: 1, maxLength: sequenceLength(35) })
const terminal = (execution: PublicExecution | null) => !execution ||
  ['completed', 'failed', 'interrupted'].includes(execution.status)

it('lifecycle public model preserves execution and interaction authority', async () => {
  await checkAsync('lifecycle public model', fc.asyncProperty(operations, async events => {
    const driver = await lifecycleDriver()
    // Model contains only public facts and authority: no runtime queues, claims map or native state.
    let expected: { -readonly [K in keyof ThreadPublicObservation]: ThreadPublicObservation[K] } = { latestExecution: null, backgroundWork: null }
    let closed = false
    // Core archives the Agent Thread in the commit that publishes a failed
    // latest Execution, so the archive fact is part of the public model: a send
    // is refused until an unarchive command is committed.
    let archived = false
    let lastInteraction = 'never-issued'
    let serial = 0
    const executionIds: string[] = []
    try {
      for (const event of events) {
        const current = expected.latestExecution
        const active = !terminal(current)
        const beforeIO = structuredClone(driver.io)
        const rejects = async (action: () => Promise<unknown>) => {
          await expect(action()).rejects.toThrow()
          expect(driver.io).toEqual(beforeIO)
        }
        switch (event) {
          case 'send': {
            if (closed || archived || current?.status === 'waiting-for-user') {
              await rejects(() => driver.instance.send(input, signal())); break
            }
            const result = await driver.instance.send(input, signal())
            expect(result.startedNewExecution).toBe(!active)
            if (!active) {
              expect(executionIds).not.toContain(result.executionId)
              executionIds.push(result.executionId)
              expected.latestExecution = { executionId: result.executionId, status: 'running', startedAt: 1 }
            } else expect(result.executionId).toBe(current!.executionId)
            expect(driver.io.sends).toEqual([...beforeIO.sends, result.executionId])
            break
          }
          case 'stop': case 'service-stop': {
            const action = () => event === 'stop'
              ? driver.instance.interrupt(current?.executionId ?? 'unknown')
              : driver.service.interrupt('agent', signal())
            if (closed || (event === 'service-stop' && !active)) { await rejects(action); break }
            await action()
            if (active) {
              expected.latestExecution = { executionId: current!.executionId, status: 'interrupted', startedAt: 1, finishedAt: 100 }
              expect(driver.io.stops).toEqual([...beforeIO.stops, current!.executionId])
              // Repeated exact Stop after success must neither call native interrupt nor change the result.
              await driver.instance.interrupt(current!.executionId)
              expect(driver.io.stops).toHaveLength(beforeIO.stops.length + 1)
            } else expect(driver.io).toEqual(beforeIO)
            break
          }
          case 'stale-stop': {
            const stale = executionIds.find(id => id !== current?.executionId) ?? 'unknown'
            if (closed) await rejects(() => driver.instance.interrupt(stale))
            else { await driver.instance.interrupt(stale); expect(driver.io).toEqual(beforeIO) }
            break
          }
          case 'no-target-stop': await rejects(() => driver.instance.interrupt(null)); break
          case 'wait': {
            if (!active || closed) break // native waiting only generated at its valid frontier
            lastInteraction = `interaction-${++serial}`
            expected.latestExecution = { executionId: current!.executionId, status: 'waiting-for-user', startedAt: 1,
              interactions: [permission(lastInteraction)] }
            await driver.publish(expected)
            break
          }
          case 'respond': case 'stale-respond': {
            const id = event === 'respond' ? lastInteraction : `stale-${lastInteraction}`
            const action = () => driver.service.respond('agent', { interactionId: id, actionId: 'allow' }, signal())
            if (closed || event === 'stale-respond' || current?.status !== 'waiting-for-user') {
              await rejects(action); break
            }
            await action()
            expected.latestExecution = { executionId: current.executionId, status: 'running', startedAt: 1 }
            expect(driver.io.responses).toEqual([...beforeIO.responses, id])
            break
          }
          case 'complete': case 'fail': {
            if (!active || closed) break
            expected.latestExecution = { executionId: current!.executionId,
              status: event === 'complete' ? 'completed' : 'failed', startedAt: 1, finishedAt: 2 }
            await driver.publish(expected)
            // A failure of the committed latest Execution archives the Thread
            // in the same commit; a completion never does.
            if (event === 'fail') archived = true
            break
          }
          case 'unarchive': {
            await driver.unarchive()
            archived = false
            break
          }
          case 'background': {
            const next = { ...expected, backgroundWork: expected.backgroundWork ? null : { status: 'running' as const } }
            if (closed) await rejects(() => driver.publish(next))
            else { await driver.publish(next); expected = next }
            break
          }
          case 'dispose': {
            await driver.instance.dispose()
            if (!closed && active) expected.latestExecution = {
              executionId: current!.executionId, status: 'interrupted', startedAt: 1, finishedAt: 100
            }
            closed = true
            break
          }
          case 'reopen': if (closed) { await driver.open(); closed = false }; break
        }
        expect(driver.observation(), `after ${event}: ${events.join(' → ')}`).toEqual(expected)
        expect(driver.instance.observation).toEqual(expected)
        expect(driver.archived(), `after ${event}: ${events.join(' → ')}`).toBe(archived)
      }
    } finally { await driver.close() }
  }))
}, 130_000)

it('lifecycle native admission requires claim publication durability and live authority', async () => {
  await checkAsync('lifecycle native admission', fc.asyncProperty(
    fc.constantFrom('allow', 'deny', 'dispose', 'terminal'), fc.integer({ min: 1, max: 4 }), async (ending, duplicateCount) => {
      const driver = await lifecycleDriver()
      const gate = deferred()
      const entered = deferred()
      const durable = deferred()
      const flushEntered = deferred()
      const flushThread = driver.store.flushThread.bind(driver.store)
      driver.store.flushThread = async id => { flushEntered.resolve(); await durable.promise; await flushThread(id) }
      let admitted: Promise<unknown>[] = []
      let nativeIO = 0
      try {
        await expect(driver.context.executionAdmission.admit('unclaimed')).rejects.toThrow()
        await expect(driver.publish({ latestExecution: { executionId: 'unclaimed', status: 'running', startedAt: 1 }, backgroundWork: null })).rejects.toThrow()
        const abandoned = driver.context.executionClaims.claim()
        abandoned.abandon(); abandoned.abandon()
        await expect(driver.context.executionAdmission.admit(abandoned.executionId)).rejects.toThrow()
        const claim = driver.context.executionClaims.claim()
        await expect(driver.context.executionAdmission.admit(claim.executionId)).rejects.toThrow()
        expect(() => driver.context.executionClaims.claim()).toThrow()
        await driver.publish({ latestExecution: { executionId: claim.executionId, status: 'running', startedAt: 1 }, backgroundWork: { status: 'running' } })
        driver.setAdmission(async () => { entered.resolve(); await gate.promise; if (ending === 'deny') throw new Error('admission denied') })
        admitted = Array.from({ length: duplicateCount }, () => driver.context.executionAdmission.admit(claim.executionId)
          .then(() => { nativeIO++; return 'accepted' }, () => 'rejected'))
        await entered.promise
        expect(nativeIO).toBe(0)
        expect(driver.io.admissions).toBe(1)
        gate.resolve()
        if (ending !== 'deny') {
          await flushEntered.promise
          expect(nativeIO).toBe(0)
        }
        if (ending === 'dispose') { durable.resolve(); await driver.instance.dispose() }
        if (ending === 'terminal') await driver.publish({ ...driver.observation(), latestExecution: {
          executionId: claim.executionId, status: 'completed', startedAt: 1, finishedAt: 2
        } })
        durable.resolve()
        expect(await Promise.all(admitted)).toEqual(Array(duplicateCount).fill(ending === 'allow' ? 'accepted' : 'rejected'))
        expect(nativeIO).toBe(ending === 'allow' ? duplicateCount : 0)
        if (ending === 'deny') {
          driver.setAdmission(async () => undefined)
          await driver.context.executionAdmission.admit(claim.executionId)
          expect(driver.io.admissions).toBe(2)
        }
        expect(driver.observation().backgroundWork).toEqual({ status: 'running' })
      } finally { gate.resolve(); durable.resolve(); await Promise.all(admitted); await driver.close() }
    }))
}, 130_000)
