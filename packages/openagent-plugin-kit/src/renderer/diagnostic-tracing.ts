import { useLayoutEffect, useRef } from 'react'

import type { RendererFirstCommitDiagnostic } from '../shared/diagnostic-tracing.js'
import { useRendererCapabilities } from './capabilities.js'

/**
 * Reports the first rendered reasoning and answer frame for an execution.
 * Provider renderers pass booleans derived from their own private sessionState;
 * this hook never inspects or serializes that data and never runs per token.
 */
export function useRendererFirstCommitDiagnostics(input: {
  readonly threadId: string
  readonly executionId: string | undefined
  /** Only active/current output should contribute to response latency. */
  readonly active: boolean
  readonly hasReasoning: boolean
  readonly hasText: boolean
}): void {
  const { reportRendererFirstCommit } = useRendererCapabilities()
  const trackingRef = useRef<{
    executionId: string | undefined
    observedActive: boolean
    seen: Set<RendererFirstCommitDiagnostic['kind']>
  }>({
    executionId: undefined,
    observedActive: false,
    seen: new Set()
  })

  useLayoutEffect(() => {
    const executionId = prepareTracking(input, trackingRef.current)
    if (!executionId || !input.hasReasoning || !reportRendererFirstCommit) return
    if (!trackingRef.current.observedActive || trackingRef.current.seen.has('reasoning')) {
      return
    }
    return scheduleCommit(
      'reasoning',
      input.threadId,
      executionId,
      trackingRef,
      reportRendererFirstCommit
    )
  }, [input.active, input.executionId, input.hasReasoning, input.threadId, reportRendererFirstCommit])

  useLayoutEffect(() => {
    const executionId = prepareTracking(input, trackingRef.current)
    if (!executionId || !input.hasText || !reportRendererFirstCommit) return
    if (!trackingRef.current.observedActive || trackingRef.current.seen.has('text')) {
      return
    }
    return scheduleCommit(
      'text',
      input.threadId,
      executionId,
      trackingRef,
      reportRendererFirstCommit
    )
  }, [input.active, input.executionId, input.hasText, input.threadId, reportRendererFirstCommit])
}

type CommitTracking = {
  executionId: string | undefined
  observedActive: boolean
  seen: Set<RendererFirstCommitDiagnostic['kind']>
}

function prepareTracking(
  input: {
    readonly executionId: string | undefined
    readonly active: boolean
  },
  tracking: CommitTracking
): string | undefined {
  if (tracking.executionId !== input.executionId) {
    tracking.executionId = input.executionId
    tracking.observedActive = false
    tracking.seen.clear()
  }
  if (!input.executionId) return undefined
  if (input.active) tracking.observedActive = true
  // A response can become terminal in the same committed state update that
  // first exposes text. The active marker permits that final frame, while a
  // completed history opened cold remains ignored.
  if (!input.active && !tracking.observedActive) return undefined
  return input.executionId
}

function scheduleCommit(
  kind: RendererFirstCommitDiagnostic['kind'],
  threadId: string,
  executionId: string,
  trackingRef: { current: CommitTracking },
  report: (input: RendererFirstCommitDiagnostic) => void
): () => void {
  const startedAt = performance.now()
  const scheduleFrame = typeof window.requestAnimationFrame === 'function'
    ? (callback: () => void): number => window.requestAnimationFrame(callback)
    : (callback: () => void): number => window.setTimeout(callback, 0)
  const cancelFrame = typeof window.cancelAnimationFrame === 'function'
    ? (handle: number): void => window.cancelAnimationFrame(handle)
    : (handle: number): void => window.clearTimeout(handle)
  const frame = scheduleFrame(() => {
    const tracking = trackingRef.current
    if (tracking.executionId !== executionId || tracking.seen.has(kind)) return
    tracking.seen.add(kind)
    report({
      kind,
      threadId,
      executionId,
      durationMs: elapsedMilliseconds(startedAt)
    })
  })
  return () => cancelFrame(frame)
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100)
}
