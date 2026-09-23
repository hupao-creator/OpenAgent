import type { LayoutGeometry, LayoutMember, LayoutPlacement, LayoutResult } from './overview-layout'

export interface OverviewLayoutRequest {
  readonly previous: readonly LayoutPlacement[]
  readonly next: readonly LayoutMember[]
  readonly geometry: LayoutGeometry
}
export type OverviewLayoutResponse = { readonly plan: LayoutResult } | { readonly error: string }

/** One planning lease owns one worker. A scene cut also stops its CPU work. */
export function planOverviewInWorker(request: OverviewLayoutRequest, signal: AbortSignal): Promise<LayoutResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Layout cancelled', 'AbortError')); return }
    const worker = new Worker(new URL('./overview-layout.worker.ts', import.meta.url), {
      type: 'module', name: 'openagent-overview-layout'
    })
    const dispose = (): void => {
      signal.removeEventListener('abort', abort)
      worker.onmessage = worker.onerror = worker.onmessageerror = null
      worker.terminate()
    }
    const abort = (): void => { dispose(); reject(new DOMException('Layout cancelled', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<OverviewLayoutResponse>): void => {
      dispose()
      if ('error' in event.data) reject(new Error(event.data.error))
      else resolve(event.data.plan)
    }
    worker.onerror = (event): void => { dispose(); reject(new Error(event.message || 'Layout worker failed')) }
    worker.onmessageerror = (): void => { dispose(); reject(new Error('Invalid layout worker response')) }
    try { worker.postMessage(request) } catch (error) { dispose(); reject(error) }
  })
}
