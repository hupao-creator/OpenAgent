import { layoutOverview } from './overview-layout'
import type { OverviewLayoutRequest, OverviewLayoutResponse } from './overview-layout-worker'

self.onmessage = (event: MessageEvent<OverviewLayoutRequest>): void => {
  const { previous, next, geometry } = event.data
  let response: OverviewLayoutResponse
  try { response = { plan: layoutOverview(previous, next, geometry) } }
  catch (error) { response = { error: error instanceof Error ? error.message : String(error) } }
  self.postMessage(response)
}
