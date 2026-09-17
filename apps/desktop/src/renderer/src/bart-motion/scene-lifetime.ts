type Cleanup = () => void

/** Host-side lifetime only: no queue, renderer, geometry or invalidation policy.
 * Abort stops work; handoff commits the current DOM before releasing its cover.
 * Observers stop first, then resources release in the caller's declared order. */
export function createSceneLifetime(message: string, parentSignal?: AbortSignal) {
  const controller = new AbortController(), signal = controller.signal
  const observers: Cleanup[] = [], resources: Cleanup[] = []
  let phase: 'active' | 'handoff' | 'disposed' = 'active'
  let resolveSettled!: () => void
  const settled = new Promise<void>(resolve => { resolveSettled = resolve })
  const abort = (): void => controller.abort(new DOMException(message, 'AbortError'))
  const register = (list: Cleanup[], cleanups: Cleanup[]): void => {
    if (phase === 'disposed') cleanups.forEach(cleanup => cleanup())
    else list.push(...cleanups)
  }
  const release = (): void => {
    if (phase === 'disposed') return
    phase = 'disposed'
    abort()
    const errors: unknown[] = []
    for (const cleanup of [...observers.splice(0), ...resources.splice(0)]) {
      try { cleanup() } catch (error) { errors.push(error) }
    }
    resolveSettled()
    if (errors.length) throw new AggregateError(errors, `${message}: cleanup failed`)
  }
  if (parentSignal) {
    parentSignal.addEventListener('abort', abort, { once: true })
    observers.push(() => parentSignal.removeEventListener('abort', abort))
    if (parentSignal.aborted) abort()
  }
  return {
    signal,
    settled,
    get active(): boolean { return phase === 'active' },
    abort,
    observe(...cleanups: Cleanup[]): void { register(observers, cleanups) },
    release(...cleanups: Cleanup[]): void { register(resources, cleanups) },
    dispose(): void {
      // React may unmount this scene and mount its successor in one commit.
      // Explicit unmount must free its surface before the successor starts.
      release()
    },
    handoff(commit: () => void): void {
      if (phase !== 'active') return
      phase = 'handoff'
      try { commit() } finally { release() }
    },
    async wait<T>(milestone: Promise<T>): Promise<T> {
      let onAbort!: () => void
      const canceled = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      try { return await Promise.race([canceled, milestone]) }
      finally { signal.removeEventListener('abort', onAbort) }
    }
  }
}
