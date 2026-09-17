/**
 * Serial queue for chart rendering.
 *
 * Mermaid keeps its configuration in module state, so two renders may never be
 * in flight at once — the second `initialize` would change what the first one
 * draws. Jobs run one at a time and the loop yields a frame between them so a
 * burst of charts cannot block paint.
 */

export type QueueFailureReason = 'superseded' | 'timeout'

export class QueueError extends Error {
  readonly reason: QueueFailureReason

  constructor(reason: QueueFailureReason, message?: string) {
    super(message ?? reason)
    this.name = 'QueueError'
    this.reason = reason
  }
}

export interface MermaidQueueOptions {
  /** Logical wait after which a render is given up on. */
  timeoutMs: number
  /** How long the queue waits for an abandoned render before writing the runner off. */
  settleGraceMs: number
}

export interface MermaidQueue {
  enqueue<T>(key: string, run: () => Promise<T>): Promise<T>
  /**
   * Drops a request that has not started. A chart that unmounted while it
   * waited cannot supersede its own job — a remount or a re-shown message
   * brings a new key — so without this every chart scrolled out of view would
   * still be parsed and drawn before the visible ones.
   */
  cancel(key: string): void
}

interface Job {
  key: string
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export function createMermaidQueue(options: MermaidQueueOptions): MermaidQueue {
  const queue: Job[] = []
  let draining = false
  /**
   * Set when a render overran its timeout and still had not settled after the
   * grace period. The runner keeps reading the shared config, and there is no
   * way to cancel it, so nothing else may run while it is out there.
   *
   * It is cleared if that render eventually settles: a job writes the whole
   * config before it renders, so a render that finished late left nothing
   * behind, and refusing every later chart for the rest of the session would
   * turn one slow diagram into a permanent, unretryable failure. Only a render
   * that never settles keeps the runner written off.
   */
  let wedged = false
  const reusableAgain = (): void => {
    wedged = false
  }
  const wedgedError = (): QueueError => new QueueError('timeout', 'A previous render never settled')

  const enqueue = <T,>(key: string, run: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (wedged) {
        reject(wedgedError())
        return
      }
      // Only the newest not-yet-started request for a key is worth running.
      const queued = queue.findIndex((candidate) => candidate.key === key)
      if (queued !== -1) {
        const [superseded] = queue.splice(queued, 1)
        superseded.reject(new QueueError('superseded'))
      }
      queue.push({ key, run, resolve: resolve as (value: unknown) => void, reject })
      void drain()
    })

  const cancel = (key: string): void => {
    const queued = queue.findIndex((candidate) => candidate.key === key)
    if (queued === -1) return
    const [dropped] = queue.splice(queued, 1)
    // The caller is told it was superseded: from its side the work is over
    // either way, and a chart that already unmounted does nothing with it.
    dropped.reject(new QueueError('superseded'))
  }

  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0) {
        const job = queue.shift() as Job
        if (wedged) {
          job.reject(wedgedError())
          continue
        }
        const render = job.run()
        try {
          job.resolve(await withTimeout(render, options.timeoutMs))
        } catch (error) {
          // The caller hears about the give-up at the timeout, not after the
          // grace period; waiting on an abandoned render is the queue's own
          // problem, not the chart's.
          job.reject(error)
          if (error instanceof QueueError && error.reason === 'timeout') {
            if (!(await settlesWithin(render, options.settleGraceMs))) {
              wedged = true
              void render.then(reusableAgain, reusableAgain)
            }
          }
        }
        await nextFrame()
      }
    } finally {
      draining = false
    }
  }

  return { enqueue, cancel }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new QueueError('timeout', `Render exceeded ${timeoutMs}ms`)),
      timeoutMs
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    const settle = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    promise.then(settle, settle)
  })
}

/** `requestAnimationFrame` is reached through `globalThis` so this module also
 * compiles for the Node test project, which has no DOM library. */
function nextFrame(): Promise<void> {
  const raf = (globalThis as { requestAnimationFrame?: (callback: () => void) => void })
    .requestAnimationFrame
  return new Promise<void>((resolve) => {
    if (raf) raf(() => resolve())
    else setTimeout(resolve, 0)
  })
}
