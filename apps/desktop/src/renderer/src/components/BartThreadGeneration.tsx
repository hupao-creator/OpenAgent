import { useStore } from 'zustand'
import { createOverviewOrchestrationStore, type OverviewOrchestrationStore } from '../overview-orchestration-store'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RendererReport } from '../../../shared/renderer-state-contracts'
import { harnessDisplayName } from '../../../shared/harnesses'
import { formatReportUpdatedTime } from './ReportCard'
import { createGenerationScene } from '../bart-motion/generation-scene'
import { diag } from '../bart-motion/verify-diag'
import { flushSync } from 'react-dom'
import type { HarnessOverviewThread } from '@openagent/contracts/renderer'
import './BartThreadGeneration.css'

/**
 * Queue cues retain bounded metadata, never a Thread aggregate or a Surface.
 * Playback uses only the id to find the current production card and its content.
 */
interface BartGenerationTextTarget {
  id: string
  createdAt: number
  title: string
  metaText: string
  cwdText: string
  bodyText: string
}

export type BartGenerationTarget = BartGenerationTextTarget & (
  | {
      kind: 'thread'
      harnessId: string
      running: boolean
      worktree: boolean
    }
  | { kind: 'report' }
)

export function bartGenerationThreadTarget(
  source: HarnessOverviewThread
): BartGenerationTarget {
  const { thread, envelope } = source
  const status = thread.observation.latestExecution?.status
  const cwd = thread.worktree?.baseCwd || thread.cwd
  return {
    kind: 'thread',
    id: thread.id,
    createdAt: thread.createdAt,
    title: thread.title,
    metaText: harnessDisplayName(thread.harnessId),
    cwdText: cwd ? compactPath(cwd) : '',
    bodyText: envelope.excerpt,
    harnessId: thread.harnessId,
    running: status === 'running' || status === 'waiting-for-user' ||
      thread.observation.backgroundWork?.status === 'running',
    worktree: Boolean(thread.worktree)
  }
}

export function bartGenerationReportTarget(report: RendererReport): BartGenerationTarget {
  return {
    kind: 'report',
    id: report.id,
    createdAt: report.createdAt,
    title: report.title,
    metaText: `报告 · ${formatReportUpdatedTime(report.updatedAt)}`,
    cwdText: '',
    bodyText: report.previewText
  }
}

/** 路径只保留尾部两段；生成层继续沿用历史卡片的紧凑排版。 */
function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return path
  return '…/' + parts.slice(-2).join('/')
}

export interface BartGenerationWork {
  key: number
  targets: readonly BartGenerationTarget[]
  /** Cancellation metadata only. Execution is reserved after prewarming. */
  controller: AbortController
}

function BartPreparedGeneration({ work, onComplete }: {
  work: BartGenerationWork
  onComplete: () => void
}): React.JSX.Element {
  const marker = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const root = marker.current?.closest<HTMLElement>('.app-shell')
    diag('prepared-effect', { root: Boolean(root), signal: work.controller.signal.aborted })
    if (!root) { queueMicrotask(onComplete); return }
    let active = true
    const scene = createGenerationScene(root, work.targets.map(target => target.id), work.controller.signal)
    const finish = (): void => {
      diag('prepared-finish', { active })
      if (!active) return
      // Release native pending facts and the covering surface in this same Host
      // task. No guessed frame count or timeout is used as presentation proof.
      flushSync(onComplete)
      scene.dispose()
    }
    void scene.performed.then(finish, finish)
    return () => { active = false; scene.dispose() }
  }, [work, onComplete])
  return <span hidden aria-hidden="true" ref={marker} />
}

/** Consume the known batch after its production layout has committed. */
export function BartThreadGenerations({
  overviewOpen,
  works,
  onWorkConsumed,
  onReveal,
  onHiddenIdsChange,
  orchestration
}: {
  orchestration?: OverviewOrchestrationStore
  overviewOpen: boolean
  threads: readonly HarnessOverviewThread[]
  reports?: readonly RendererReport[]
  works: readonly BartGenerationWork[]
  onWorkConsumed: (key: number) => void
  onReveal?: (request: { id: string; key: number } | null) => void
  onHiddenIdsChange?: (ids: readonly string[]) => void
}): React.JSX.Element | null {
  const activeWork = overviewOpen ? works[0] : undefined
  // Standalone Lab callers get the same per-instance facts; production passes
  // its App store and does not echo presentation facts through parent effects.
  const [localStore] = useState(createOverviewOrchestrationStore)
  const presentation = orchestration ?? localStore
  const reveal = useStore(presentation, state => state.reveal)
  const hiddenIds = useStore(presentation, state => state.hiddenIds)
  const releaseCard = presentation.releaseCard
  useLayoutEffect(() => {
    if (orchestration) return
    diag('local-enqueue', { works: works.length })
    for (const work of works) localStore.enqueue(work)
    for (const work of localStore.getState().works) {
      if (!works.some(current => current.key === work.key)) localStore.consumeWork(work.key)
    }
  }, [localStore, orchestration, works])
  useLayoutEffect(() => {
    if (orchestration) return
    onReveal?.(activeWork ? reveal : null)
    onHiddenIdsChange?.(overviewOpen ? hiddenIds : [])
  }, [activeWork, hiddenIds, onHiddenIdsChange, onReveal, orchestration, overviewOpen, reveal])
  const complete = useCallback((): void => {
    diag('complete', { activeWork: activeWork?.key ?? null })
    if (!activeWork) return
    activeWork.controller.abort()
    for (const target of activeWork.targets) releaseCard(target.id)
    // Standalone callers retire work through props. Keep released IDs until
    // then, including completion before the parent layout effect enqueues it.
    if (!orchestration) presentation.clearReveal()
    onWorkConsumed(activeWork.key)
  }, [activeWork, onWorkConsumed, orchestration, presentation, releaseCard])

  const worksRef = useRef(works)
  worksRef.current = works
  const onHiddenIdsChangeRef = useRef(onHiddenIdsChange)
  onHiddenIdsChangeRef.current = onHiddenIdsChange
  const onRevealRef = useRef(onReveal)
  onRevealRef.current = onReveal
  const mountEpoch = useRef(0)
  useEffect(() => {
    const epoch = ++mountEpoch.current
    return () => {
      queueMicrotask(() => {
        if (mountEpoch.current !== epoch) return
        for (const work of worksRef.current) work.controller.abort()
        presentation.reset()
        onHiddenIdsChangeRef.current?.([])
        onRevealRef.current?.(null)
      })
    }
  }, [presentation])

  if (!overviewOpen || !activeWork) return null
  return (
    <BartPreparedGeneration
      key={activeWork.key}
      work={activeWork}
      onComplete={complete}
    />
  )
}
