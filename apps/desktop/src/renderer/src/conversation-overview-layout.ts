import type { RendererReport } from '../../shared/renderer-state-contracts'
import { threadDirectoryTag } from '@openagent/contracts'
import type { BartVisualOperation } from './bart-visual-operation'
import type {
  HarnessOverviewThread,
  OverviewCardSize,
  OverviewLayoutContext
} from '@openagent/contracts/renderer'

/**
 * Report cards retain the fixed 1-column × 1-row footprint so the
 * preview and related Thread list remain visible together.
 */
export const REPORT_CARD_SIZE: OverviewCardSize = { cols: 1, rows: 1 }

export type OverviewLayoutItem =
  | {
      readonly kind: 'card'
      readonly key: string
      readonly entityId: string
      readonly cardIndex: number
      readonly size: OverviewCardSize
      readonly structureKey: string
    }
  | {
      readonly kind: 'report'
      readonly key: string
      readonly entityId: string
      readonly cardIndex: number
      readonly size: OverviewCardSize
    }
  | {
      readonly kind: 'placeholder'
      readonly key: string
      readonly entityId: string
      readonly cardIndex: number
      readonly size: OverviewCardSize
    }

/**
 * A mutation-boundary snapshot. It intentionally freezes only layout identity
 * and structure, never Thread/Report semantic content or opaque sessionState.
 * That is enough to replay A → B → A geometry without making the motion FIFO a
 * second committed-state channel.
 */
export interface OverviewLayoutSnapshot {
  readonly signature: string
  readonly availableCols: number
  readonly items: readonly OverviewLayoutItem[]
}

/** One signature formula shared by App snapshot capture and live rendering. */
export function overviewLayoutSnapshot(derived: {
  readonly itemSignature: string
  readonly layoutContext: OverviewLayoutContext
  readonly items: readonly OverviewItem[]
}): OverviewLayoutSnapshot {
  return {
    signature: `${derived.layoutContext.availableCols}\u0000${derived.itemSignature}`,
    availableCols: derived.layoutContext.availableCols,
    items: derived.items.map((item): OverviewLayoutItem =>
      item.kind === 'card'
        ? {
            kind: 'card',
            key: item.key,
            entityId: item.source.thread.id,
            cardIndex: item.cardIndex,
            size: item.size,
            structureKey: item.source.envelope.structureKey
          }
        : item.kind === 'report'
          ? {
            kind: 'report',
            key: item.key,
            entityId: item.report.id,
            cardIndex: item.cardIndex,
            size: item.size
          }
          : {
              kind: 'placeholder',
              key: item.key,
              entityId: `operation:${item.operation.id}`,
              cardIndex: item.cardIndex,
              size: { cols: 1, rows: 1 }
            }
    )
  }
}

/**
 * Overview has exactly two archive buckets. A failed Agent Thread reaches
 * Archived through its own auto-archive; `interrupted` alone is not a failure
 * and stays in Default.
 */
export type OverviewView = 'default' | 'archived'

/** Candidate filtering always precedes coverage, including tag filtering. */
export function selectOverviewItems<T extends { readonly thread: Pick<HarnessOverviewThread['thread'], 'id' | 'createdAt' | 'archived' | 'observation' | 'tags' | 'cwd'> }>(
  threads: readonly T[], reports: readonly RendererReport[], view: OverviewView,
  selectedTags: readonly string[] = [], merge = true
): { threads: T[]; reports: RendererReport[]; count: number } {
  const keys = new Set(selectedTags.map(tagKey).filter(Boolean))
  const matchesTags = (tags: readonly string[]): boolean => !keys.size || tags.some(tag => keys.has(tagKey(tag)))
  const visibleReports = reports.filter(report =>
    report.archived === (view === 'archived') && matchesTags(report.tags))
    .sort((a, b) => a.createdAt - b.createdAt)
  const candidates = threads.filter(({ thread }) =>
    Boolean(thread.archived) === (view === 'archived') &&
    matchesTags([threadDirectoryTag(thread), ...thread.tags]))
  const visibleThreads = candidates.filter(({ thread }) => !merge || !visibleReports.some(report =>
    report.relatedExecutions.some(link => link.threadId === thread.id &&
      link.executionId === thread.observation.latestExecution?.executionId)))
    .sort((a, b) => a.thread.createdAt - b.thread.createdAt)
  return { threads: visibleThreads, reports: visibleReports, count: visibleThreads.length + visibleReports.length }
}

type OverviewEntry =
  | {
      readonly kind: 'thread'
      readonly createdAt: number
      readonly source: HarnessOverviewThread
    }
  | {
      readonly kind: 'report'
      readonly createdAt: number
      readonly report: RendererReport
    }

function mergeOverviewEntries(
  threads: readonly HarnessOverviewThread[],
  reports: readonly RendererReport[]
): OverviewEntry[] {
  const entries: OverviewEntry[] = [
    ...threads.map((source) => ({
      kind: 'thread' as const,
      createdAt: source.thread.createdAt,
      source
    })),
    ...reports.map((report) => ({
      kind: 'report' as const,
      createdAt: report.createdAt,
      report
    }))
  ]
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        left.entry.createdAt - right.entry.createdAt || left.index - right.index
    )
    .map(({ entry }) => entry)
}

export type OverviewItem =
  | {
      readonly kind: 'card'
      readonly key: string
      readonly source: HarnessOverviewThread
      readonly cardIndex: number
      readonly size: OverviewCardSize
      readonly transitionTarget: boolean
      readonly operation?: BartVisualOperation
    }
  | {
      readonly kind: 'report'
      readonly key: string
      readonly report: RendererReport
      readonly cardIndex: number
      readonly size: OverviewCardSize
    }
  | {
      readonly kind: 'placeholder'
      readonly key: string
      readonly operation: BartVisualOperation
      readonly cardIndex: number
      readonly size: OverviewCardSize
    }

/**
 * Pure layout projection shared by live Overview and App's mutation boundary.
 * Harness-private `view` never enters this module.
 */
export function deriveOverviewItems(input: {
  readonly threads: readonly HarnessOverviewThread[]
  readonly reports?: readonly RendererReport[]
  readonly operations?: readonly BartVisualOperation[]
  readonly deletedIndexes?: Readonly<Record<string, number>>
  readonly transitionId: string | null
  readonly layoutContext: OverviewLayoutContext
}): {
  readonly items: OverviewItem[]
  readonly itemSignature: string
  readonly layoutContext: OverviewLayoutContext
  readonly featuredOperation: BartVisualOperation | undefined
} {
  const entries = mergeOverviewEntries(input.threads, input.reports ?? [])
  const visibleThreadIds = new Set(input.threads.map(({ thread }) => thread.id))
  const operationsByThread = new Map<string, BartVisualOperation>()
  for (const operation of input.operations ?? []) {
    if (operation.threadId && visibleThreadIds.has(operation.threadId)) {
      operationsByThread.set(operation.threadId, operation)
    }
  }
  const detachedDeletes = (input.operations ?? []).filter(
    (operation) => operation.kind === 'delete' &&
      Boolean(operation.threadId) &&
      !visibleThreadIds.has(operation.threadId!)
  )
  const placeholdersByIndex = new Map<number, BartVisualOperation>()
  for (const operation of detachedDeletes) {
    const index = input.deletedIndexes?.[operation.threadId!]
    if (index !== undefined) placeholdersByIndex.set(index, operation)
  }
  const items: OverviewItem[] = []
  for (let cardIndex = 0; cardIndex < entries.length; cardIndex += 1) {
    const placeholder = placeholdersByIndex.get(cardIndex)
    if (placeholder) {
      items.push({
        kind: 'placeholder',
        key: `operation:${placeholder.id}`,
        operation: placeholder,
        cardIndex,
        size: { cols: 1, rows: 1 }
      })
    }
    const entry = entries[cardIndex]
    if (entry.kind === 'report') {
      items.push({
        kind: 'report',
        key: `report:${entry.report.id}`,
        report: entry.report,
        cardIndex,
        size: REPORT_CARD_SIZE
      })
      continue
    }
    const source = entry.source
    items.push({
      kind: 'card',
      key: `thread:${source.thread.id}`,
      source,
      cardIndex,
      size: {
        cols: source.envelope.footprint.columns,
        rows: source.envelope.footprint.rows
      },
      operation: operationsByThread.get(source.thread.id),
      transitionTarget: input.transitionId === source.thread.id
    })
  }
  for (const [index, operation] of [...placeholdersByIndex].sort(
    (left, right) => left[0] - right[0]
  )) {
    if (index < entries.length) continue
    items.push({
      kind: 'placeholder',
      key: `operation:${operation.id}`,
      operation,
      cardIndex: index,
      size: { cols: 1, rows: 1 }
    })
  }

  return {
    items,
    layoutContext: input.layoutContext,
    featuredOperation:
      input.operations?.findLast((operation) => operation.phase === 'running') ??
      input.operations?.at(-1),
    itemSignature: items
      .map((item) =>
        item.kind === 'card'
          ? JSON.stringify([
              item.key,
              item.size.cols,
              item.size.rows,
              item.source.envelope.structureKey
            ])
          : JSON.stringify([item.key, item.size.cols, item.size.rows])
      )
      .join('|')
  }
}

/** Historical tag identity normalization, now kept renderer-local. */
export function tagKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}
