import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  QueueError,
  createMermaidQueue
} from '../../../packages/openagent-plugin-kit/src/renderer/markdown/mermaid-queue'

const RENDER_TIMEOUT_MS = 10_000
const SETTLE_GRACE_MS = 5_000

/** Stands in for a render the test can hold open, settle, or never settle. */
function createRunner(): {
  started: string[]
  run: (key: string) => () => Promise<string>
  settle: (index: number) => void
} {
  const pending: ((value: string) => void)[] = []
  const started: string[] = []
  return {
    started,
    run: (key) => () => {
      started.push(key)
      return new Promise<string>((resolve) => pending.push(resolve))
    },
    settle: (index) => pending[index](`svg-${index}`)
  }
}

const reasonOf = (error: unknown): string =>
  error instanceof QueueError ? error.reason : `unexpected ${String(error)}`

function report<T>(promise: Promise<T>): Promise<string> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => reasonOf(error)
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Mermaid render queue', () => {
  it('drops a queued request when a newer one arrives for the same slot', async () => {
    vi.useFakeTimers()
    const runner = createRunner()
    const queue = createMermaidQueue({ timeoutMs: RENDER_TIMEOUT_MS, settleGraceMs: SETTLE_GRACE_MS })

    const running = report(queue.enqueue('a', runner.run('a')))
    const replaced = report(queue.enqueue('b', runner.run('b')))
    const replacement = report(queue.enqueue('b', runner.run('b')))

    await vi.advanceTimersByTimeAsync(0)
    // The superseded request never reaches the runner at all.
    expect(await replaced).toBe('superseded')
    expect(runner.started).toEqual(['a'])

    runner.settle(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(runner.started).toEqual(['a', 'b'])

    runner.settle(1)
    expect(await running).toBe('resolved')
    expect(await replacement).toBe('resolved')
  })

  it('starts no other render until an abandoned one settles', async () => {
    vi.useFakeTimers()
    const runner = createRunner()
    const queue = createMermaidQueue({ timeoutMs: RENDER_TIMEOUT_MS, settleGraceMs: SETTLE_GRACE_MS })

    const first = report(queue.enqueue('a', runner.run('a')))
    const second = report(queue.enqueue('b', runner.run('b')))
    await vi.advanceTimersByTimeAsync(0)

    // The caller gives up on 'a' here, but its render is still running and still
    // reading the shared config, so 'b' must not start.
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS)
    expect(await first).toBe('timeout')
    expect(runner.started).toEqual(['a'])

    runner.settle(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(runner.started).toEqual(['a', 'b'])

    runner.settle(1)
    expect(await second).toBe('resolved')
  })

  it('writes the queue off when an abandoned render never settles', async () => {
    vi.useFakeTimers()
    const runner = createRunner()
    const queue = createMermaidQueue({ timeoutMs: RENDER_TIMEOUT_MS, settleGraceMs: SETTLE_GRACE_MS })

    const first = report(queue.enqueue('a', runner.run('a')))
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS + SETTLE_GRACE_MS)
    expect(await first).toBe('timeout')

    expect(await report(queue.enqueue('c', runner.run('c')))).toBe('timeout')
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS)
    expect(runner.started).toEqual(['a'])
  })

  it('reuses the queue once the abandoned render finally settles', async () => {
    vi.useFakeTimers()
    const runner = createRunner()
    const queue = createMermaidQueue({ timeoutMs: RENDER_TIMEOUT_MS, settleGraceMs: SETTLE_GRACE_MS })

    const first = report(queue.enqueue('a', runner.run('a')))
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS + SETTLE_GRACE_MS)
    expect(await first).toBe('timeout')

    // Nothing may start beside the render that is still out there.
    expect(await report(queue.enqueue('c', runner.run('c')))).toBe('timeout')

    // It finishes after all. Every job writes the whole config before it
    // renders, so this one left nothing behind: writing the queue off for the
    // rest of the session would make one slow diagram permanently unretryable.
    runner.settle(0)
    await vi.advanceTimersByTimeAsync(1)

    const next = report(queue.enqueue('d', runner.run('d')))
    await vi.advanceTimersByTimeAsync(0)
    expect(runner.started).toEqual(['a', 'd'])

    runner.settle(1)
    expect(await next).toBe('resolved')
  })

  it('reports a render failure to its own caller only', async () => {
    vi.useFakeTimers()
    const runner = createRunner()
    const queue = createMermaidQueue({ timeoutMs: RENDER_TIMEOUT_MS, settleGraceMs: SETTLE_GRACE_MS })

    // The handler is attached before any timer runs, so the rejection is
    // observed rather than reported as unhandled.
    const failing = expect(
      queue.enqueue('bad', () => Promise.reject(new Error('syntax error in line 2')))
    ).rejects.toThrow('syntax error in line 2')
    const healthy = report(queue.enqueue('good', runner.run('good')))

    await vi.advanceTimersByTimeAsync(0)
    await failing

    runner.settle(0)
    expect(await healthy).toBe('resolved')
  })

  it('drops a waiting render whose chart is gone', async () => {
    vi.useFakeTimers()
    const runner = createRunner()
    const queue = createMermaidQueue({ timeoutMs: RENDER_TIMEOUT_MS, settleGraceMs: SETTLE_GRACE_MS })

    const running = report(queue.enqueue('a', runner.run('a')))
    const abandoned = report(queue.enqueue('b', runner.run('b')))
    await vi.advanceTimersByTimeAsync(0)
    expect(runner.started).toEqual(['a'])

    // 'b' was waiting its turn when its chart unmounted. A remount brings a new
    // key, so nothing else would ever supersede it — it has to be dropped here
    // rather than parsed and drawn for nobody.
    queue.cancel('b')
    expect(await abandoned).toBe('superseded')

    runner.settle(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(runner.started).toEqual(['a'])
    expect(await running).toBe('resolved')
  })

  it('leaves a render that already started alone when its chart cancels', async () => {
    vi.useFakeTimers()
    const runner = createRunner()
    const queue = createMermaidQueue({ timeoutMs: RENDER_TIMEOUT_MS, settleGraceMs: SETTLE_GRACE_MS })

    const running = report(queue.enqueue('a', runner.run('a')))
    await vi.advanceTimersByTimeAsync(0)

    // The render is in flight and cannot be taken back; the chart drops its own
    // result once it lands.
    queue.cancel('a')
    runner.settle(0)
    expect(await running).toBe('resolved')
  })
})
