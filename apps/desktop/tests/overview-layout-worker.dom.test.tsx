// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { planOverviewInWorker, type OverviewLayoutRequest, type OverviewLayoutResponse } from '../src/renderer/src/overview-layout-worker'
import { layoutOverview } from '../src/renderer/src/overview-layout'

afterEach(() => vi.unstubAllGlobals())

const request: OverviewLayoutRequest = {
  previous: [], next: [{ id: 'one', cols: 2, rows: 1 }, { id: 'two', cols: 1, rows: 2 }],
  geometry: { columnWidth: 200, rowHeight: 160, gap: 16 }
}
function fixture() {
  const workers: FakeWorker[] = []
  class FakeWorker {
    onmessage?: (event: MessageEvent<OverviewLayoutResponse>) => void
    onerror?: (event: { message: string }) => void
    request?: OverviewLayoutRequest
    terminate = vi.fn()
    constructor() { workers.push(this) }
    postMessage(value: OverviewLayoutRequest) { this.request = value }
    finish() {
      const { previous, next, geometry } = this.request!
      this.onmessage?.({ data: { plan: layoutOverview(previous, next, geometry) } } as MessageEvent<OverviewLayoutResponse>)
    }
  }
  vi.stubGlobal('Worker', FakeWorker)
  return workers
}

it('delivers the unchanged solver result asynchronously and terminates its worker', async () => {
  const workers = fixture()
  let delivered = false
  const pending = planOverviewInWorker(request, new AbortController().signal).then(plan => { delivered = true; return plan })
  await Promise.resolve()
  expect(delivered).toBe(false)
  expect(workers[0]?.request).toEqual(request)
  workers[0]!.finish()
  expect(await pending).toEqual(layoutOverview(request.previous, request.next, request.geometry))
  expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)
})

it('cancels computation on a scene cut and ignores late responses', async () => {
  const workers = fixture()
  const controller = new AbortController()
  const pending = planOverviewInWorker(request, controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)
  workers[0]!.finish()
  expect(workers).toHaveLength(1)
  const cancelled = new AbortController(); cancelled.abort()
  await expect(planOverviewInWorker(request, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(workers).toHaveLength(1)
})

it('reports worker errors instead of running the expensive search on the UI thread', async () => {
  const workers = fixture()
  const pending = planOverviewInWorker(request, new AbortController().signal)
  const rejected = expect(pending).rejects.toThrow('Could not load worker')
  workers[0]!.onerror?.({ message: 'Could not load worker' })
  await rejected
  expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)
})
