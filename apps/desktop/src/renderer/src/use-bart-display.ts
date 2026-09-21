import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { BartDockRole } from './bart-role'
import type { PublicExecution } from '@openagent/contracts'
import type { HarnessBartActivity } from '@openagent/contracts/renderer'
import { BartDisplayQueue, type BartDisplayItem } from './bart-display/queue'
import { DEFAULT_BART_DISPLAY_TIMING, IDLE_SESSION_BART_DISPLAY_TIMING, type BartDisplayTiming } from './bart-display/state-rules'
export { DEFAULT_BART_DISPLAY_TIMING, type BartDisplayTiming }

export interface BartActivityContext {
  readonly threadKey: string
  readonly execution: Pick<PublicExecution, 'executionId' | 'status'> | null
}

/** React only supplies visibility and acknowledges what it actually painted. */
export function useBartDisplay(
  latest: BartDockRole, hasActivity: boolean, context: BartActivityContext,
  presenting: boolean, sessionIdle: boolean,
  timing: BartDisplayTiming = sessionIdle ? IDLE_SESSION_BART_DISPLAY_TIMING : DEFAULT_BART_DISPLAY_TIMING,
  source?: BartDisplayQueue, activity?: HarnessBartActivity | null
): BartDockRole {
  const owned = useMemo(() => new BartDisplayQueue(), [])
  const queue = source ?? owned
  const scope = JSON.stringify([context.threadKey, context.execution?.executionId])
  const identity = activity ? String(activity.sequence) : latest.kind === 'reasoning'
    ? latest.segmentKey : latest.kind === 'tool' ? latest.toolName : latest.kind
  const observed = useRef({ scope, identity, sequence: hasActivity ? 1 : 0 })
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot)
  useLayoutEffect(() => {
    queue.setTiming(timing)
    if (!presenting) queue.setPresenting(false)
    if (!source) {
      const previous = observed.current
      if (previous.scope !== scope) observed.current = { scope, identity, sequence: hasActivity ? 1 : 0 }
      else if (previous.identity !== identity) observed.current = { scope, identity, sequence: previous.sequence + 1 }
      const item: BartDisplayItem = { sequence: activity?.sequence ?? observed.current.sequence, role: latest }
      queue.receive({ scope, status: context.execution?.status ?? (latest.kind === 'idle' ? null : 'running'),
        items: hasActivity ? [item] : [], latest: item })
    }
    // A simultaneous return and activity update must catch up before becoming
    // visible; otherwise the just-received item gets queued behind the old one.
    queue.setPresenting(presenting)
  }, [queue, source, scope, identity, latest, activity, hasActivity, context.execution?.status, presenting, timing])
  useLayoutEffect(() => { if (presenting) queue.presented(snapshot.token) }, [queue, snapshot.token, presenting])
  // React StrictMode may reconnect this same consumer. Hiding releases all
  // timers/backlog without permanently disposing the instance before reconnect.
  useLayoutEffect(() => () => { queue.setPresenting(false) }, [queue])
  return snapshot.item.role
}
