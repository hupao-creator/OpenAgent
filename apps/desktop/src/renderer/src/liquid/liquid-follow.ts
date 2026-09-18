/** One bounded, coalesced invalidation window per stage; never an idle animation loop. */
export function createLiquidFollow(draw: () => void, clock = {
  now: () => performance.now(),
  request: (callback: FrameRequestCallback) => requestAnimationFrame(callback),
  cancel: (handle: number) => cancelAnimationFrame(handle)
}) {
  let handle = 0, until = 0, disposed = false
  const step = (): void => {
    handle = 0
    if (disposed) return
    draw()
    if (!disposed && clock.now() < until && !handle) handle = clock.request(step)
  }
  return {
    invalidate(windowMs = 240): void {
      if (disposed) return
      until = Math.max(until, clock.now() + windowMs)
      if (!handle) handle = clock.request(step)
    },
    dispose(): void {
      disposed = true
      if (handle) clock.cancel(handle)
      handle = 0
    }
  }
}
