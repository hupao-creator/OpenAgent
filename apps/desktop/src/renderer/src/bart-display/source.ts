import type { NormalizedRendererState, RendererStateStore } from '../../../shared/renderer-store'
import type { RendererStateMutation } from '../../../shared/renderer-state-contracts'
import type { HarnessBartActivity } from '@openagent/contracts/renderer'
import { projectHarnessBartPresentation } from '../harness-composition'
import { resolveBartRole } from '../bart-role'
import { isDedicatedBartTool } from '../bart-visual-operation'
import { BartDisplayQueue, IDLE_DISPLAY_ITEM, RUNNING_DISPLAY_ITEM, type BartDisplayItem } from './queue'

const displayItem = (activity: HarnessBartActivity): BartDisplayItem => ({
  sequence: activity.sequence, role: resolveBartRole(activity, false, true)
})

/** Observe delivery synchronously; no React render is needed to accept an item. */
export function connectBartDisplay(queue: BartDisplayQueue, store: RendererStateStore): () => void {
  const receive = (state: NormalizedRendererState, mutation: RendererStateMutation | null): void => {
    const thread = state.bartThreadId ? state.threadsById[state.bartThreadId] : undefined
    const execution = thread?.observation.latestExecution
    const scope = JSON.stringify([thread?.id, thread?.harnessId, execution?.executionId])
    const activity = thread ? projectHarnessBartPresentation(thread)?.activity : null
    const latest = activity && activity.executionId === execution?.executionId ? displayItem(activity)
      : execution?.status === 'running' ? RUNNING_DISPLAY_ITEM : IDLE_DISPLAY_ITEM
    const input = { scope, status: execution?.status ?? null, latest }
    const events = mutation?.bartActivities?.filter(event => event.threadId === thread?.id &&
      event.harnessId === thread?.harnessId && event.activity.executionId === execution?.executionId) ?? []
    // The last dedicated call is an explicit catch-up boundary even if its
    // brief ownership began and ended inside one transport/React batch.
    const takeover = events.findLastIndex(event => event.activity.kind === 'tool-call' &&
      isDedicatedBartTool(event.activity.toolName))
    if (takeover >= 0) {
      queue.receive({ ...input, status: 'running', latest: { sequence: events[takeover].activity.sequence, role: { kind: 'idle' } }, items: [], reset: true })
    }
    queue.receive({ ...input, reset: mutation === null,
      items: events.slice(takeover + 1).map(event => displayItem(event.activity)) })
  }
  const unsubscribe = store.observe(receive)
  receive(store.getState(), null)
  return unsubscribe
}
