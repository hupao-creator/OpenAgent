import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { createSceneLifetime } from '../src/renderer/src/bart-motion/scene-lifetime'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('scene lifetime handoff contract', () => {
  it('commits before uncovering DOM, stops observers, then releases resources once in declared order', async () => {
    const scene = createSceneLifetime('scene ended'), events: string[] = []
    scene.release(...['cover', 'run', 'bitmap', 'pool', 'stage'].map(name => () => { events.push(name) }))
    scene.observe(() => { events.push('observers') })
    scene.handoff(() => { events.push('commit') })
    scene.handoff(() => { events.push('duplicate commit') })
    scene.dispose(); scene.abort()
    await scene.settled
    assert.deepEqual(events, ['commit', 'observers', 'cover', 'run', 'bitmap', 'pool', 'stage'])
    assert.equal(scene.active, false)
    assert.equal(scene.signal.aborted, true)
  })

  it('releases on explicit unmount inside a commit before its successor starts', () => {
    const scene = createSceneLifetime('scene ended'), events: string[] = []
    scene.release(() => { events.push('uncover') })
    scene.handoff(() => {
      assert.equal(scene.active, false)
      events.push('commit begins')
      scene.dispose()
      scene.handoff(() => { throw new Error('Reentered host commit') })
      assert.deepEqual(events, ['commit begins', 'uncover'])
      events.push('commit ends')
    })
    assert.deepEqual(events, ['commit begins', 'uncover', 'commit ends'])
  })

  it('aborts a blocked milestone without releasing the cover before the host handoff', async () => {
    const scene = createSceneLifetime('cancelled'), done = deferred<void>(), events: string[] = []
    scene.release(() => { events.push('uncover') })
    const waiting = scene.wait(done.promise)
    scene.abort()
    await assert.rejects(waiting, { name: 'AbortError', message: 'cancelled' })
    assert.equal(events.length, 0)
    scene.handoff(() => { events.push('latest DOM') })
    done.resolve()
    await Promise.resolve()
    assert.deepEqual(events, ['latest DOM', 'uncover'])
  })

  it('does not let an already aborted wait consume a successful old milestone', async () => {
    const parent = new AbortController()
    parent.abort()
    const scene = createSceneLifetime('cancelled', parent.signal)
    await assert.rejects(scene.wait(Promise.resolve('old run')), { name: 'AbortError' })
    scene.dispose()
    await scene.settled
  })

  it('forwards milestone values and errors without turning them into cancellation', async () => {
    const scene = createSceneLifetime('scene ended')
    assert.equal(await scene.wait(Promise.resolve(42)), 42)
    const failure = new Error('Worker failed')
    await assert.rejects(scene.wait(Promise.reject(failure)), error => error === failure)
    assert.equal(scene.signal.aborted, false)
    scene.dispose()
  })

  it('releases resources when the host commit throws', async () => {
    const scene = createSceneLifetime('scene ended'), events: string[] = [], failure = new Error('Commit failed')
    scene.release(() => { events.push('uncover') }, () => { events.push('stage') })
    assert.throws(() => scene.handoff(() => { throw failure }), error => error === failure)
    await scene.settled
    assert.deepEqual(events, ['uncover', 'stage'])
    assert.equal(scene.active, false)
  })

  it('attempts all cleanup even when one observer and one resource throw', async () => {
    const scene = createSceneLifetime('scene ended'), events: string[] = []
    const first = new Error('Observer failed'), second = new Error('Texture failed')
    scene.observe(() => { throw first }, () => { events.push('observer detached') })
    scene.release(() => { throw second }, () => { events.push('stage released') })
    assert.throws(() => scene.dispose(), error => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [first, second])
      return true
    })
    await scene.settled
    scene.dispose()
    assert.deepEqual(events, ['observer detached', 'stage released'])
  })

  it('immediately retires late resources instead of attaching them to a closed scene', () => {
    const scene = createSceneLifetime('scene ended'), events: string[] = []
    scene.dispose()
    scene.release(() => { events.push('late bitmap') })
    scene.observe(() => { events.push('late observer') })
    scene.dispose()
    assert.deepEqual(events, ['late bitmap', 'late observer'])
  })

  it('isolates child disposal from its parent and another scene', async () => {
    const parent = new AbortController()
    const first = createSceneLifetime('first ended', parent.signal)
    const second = createSceneLifetime('second ended', parent.signal)
    first.dispose()
    assert.equal(parent.signal.aborted, false)
    assert.equal(second.signal.aborted, false)
    parent.abort()
    await assert.rejects(second.wait(Promise.resolve()), { name: 'AbortError' })
    second.dispose()
  })

  it('does not accept an old handoff after disposal even when a Worker completes late', async () => {
    const scene = createSceneLifetime('scene ended'), worker = deferred<void>(), events: string[] = []
    const completion = worker.promise.then(() => scene.handoff(() => { events.push('stale commit') }))
    scene.release(() => { events.push('released') })
    scene.dispose()
    worker.resolve()
    await completion
    assert.deepEqual(events, ['released'])
  })
})
