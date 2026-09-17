import { useLayoutEffect, useRef, useState } from 'react'
import type { BartDockRole } from './bart-role'
import type { PublicExecution } from '@openagent/contracts'

export interface BartActivityContext {
  readonly threadKey: string
  readonly execution: Pick<PublicExecution, 'executionId' | 'status'> | null
}

export interface BartDisplayTiming {
  readonly minimumMs: number
  readonly reasoningMs: number
}

export const DEFAULT_BART_DISPLAY_TIMING: BartDisplayTiming = { minimumMs: 800, reasoningMs: 150 }

/** Keep a visible fragment legible, then select the latest input, never a backlog. */
export function useBartDisplay(
  latest: BartDockRole, hasActivity: boolean, context: BartActivityContext,
  presenting: boolean,
  timing: BartDisplayTiming = DEFAULT_BART_DISPLAY_TIMING
): BartDockRole {
  const scope = JSON.stringify([context.threadKey, context.execution?.executionId])
  const running = context.execution?.status === 'running'
  const [displayed, setDisplayed] = useState(latest)
  const shownAt = useRef(performance.now())
  const textAt = useRef(shownAt.current)
  const started = useRef(hasActivity)
  const previousScope = useRef(scope)
  const wasPresenting = useRef(presenting)
  useLayoutEffect(() => {
    const scopeChanged = previousScope.current !== scope
    if (scopeChanged) started.current = false
    previousScope.current = scope
    const visibilityChanged = wasPresenting.current !== presenting
    wasPresenting.current = presenting
    const immediate = !presenting || visibilityChanged || scopeChanged || !running || (!started.current && hasActivity)
    started.current = running && (started.current || hasActivity)
    if (immediate) {
      shownAt.current = textAt.current = performance.now()
      if (!sameRole(displayed, latest)) setDisplayed(latest)
      return
    }
    if (sameRole(displayed, latest)) return
    const textOnly = displayed.kind === 'reasoning' && latest.kind === 'reasoning'
    const dueAt = textOnly ? textAt.current + timing.reasoningMs : shownAt.current + timing.minimumMs
    const timer = window.setTimeout(() => {
      if (!textOnly) shownAt.current = performance.now()
      textAt.current = performance.now()
      setDisplayed(latest)
    }, Math.max(0, dueAt - performance.now()))
    return () => window.clearTimeout(timer)
  }, [displayed, latest, hasActivity, running, scope, presenting, timing.minimumMs, timing.reasoningMs])
  return displayed
}

function sameRole(left: BartDockRole, right: BartDockRole): boolean {
  return left.kind === right.kind && (
    left.kind === 'idle' ||
    (left.kind === 'reasoning' && right.kind === 'reasoning' && left.text === right.text) ||
    (left.kind === 'tool' && right.kind === 'tool' && left.toolName === right.toolName)
  )
}
