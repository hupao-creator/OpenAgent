import type {
  RendererAppState,
  RendererCollectionPatch,
  RendererReport,
  RendererStateMutation
} from './renderer-state-contracts'

export class RendererStateGapError extends Error {
  constructor() { super('Renderer state stream requires a fresh snapshot') }
}

/** Compare record envelopes, never traverse opaque sessionState. */
export function createRendererStateMutation(
  previous: RendererAppState,
  next: RendererAppState,
  effect?: RendererStateMutation['effect']
): RendererStateMutation {
  const threads = collectionDiff(previous.threads, next.threads,
    (left, right) => left.revision === right.revision)
  const reports = collectionDiff(previous.reports, next.reports, sameRendererReport)
  return {
    type: 'state-patched',
    baseRevision: previous.revision,
    revision: next.revision,
    ...(threads ? { threads } : {}),
    ...(reports ? { reports } : {}),
    ...(previous.defaultCwd !== next.defaultCwd ? { defaultCwd: next.defaultCwd } : {}),
    ...(!sameJson(previous.executions, next.executions) ? { executions: next.executions } : {}),
    ...(previous.selectedThreadId !== next.selectedThreadId ? { selectedThreadId: next.selectedThreadId } : {}),
    ...(!sameJson(previous.settings, next.settings) ? { settings: next.settings } : {}),
    ...(effect ? { effect } : {})
  }
}

export function applyRendererStatePatch(
  current: RendererAppState,
  mutation: RendererStateMutation
): RendererAppState {
  if (mutation.revision <= current.revision) return current
  if (mutation.baseRevision > current.revision) throw new RendererStateGapError()
  return {
    revision: mutation.revision,
    threads: applyCollection(current.threads, mutation.threads,
      (previous, next) => previous.revision >= next.revision),
    reports: applyCollection(current.reports, mutation.reports, sameRendererReport),
    defaultCwd: mutation.defaultCwd ?? current.defaultCwd,
    executions: mutation.executions ?? current.executions,
    selectedThreadId: mutation.selectedThreadId === undefined
      ? current.selectedThreadId : mutation.selectedThreadId,
    settings: mutation.settings ?? current.settings
  }
}

/** Coalesce an undelivered plain patch into its successor, retaining every change. */
export function mergeRendererStateMutations(
  previous: RendererStateMutation,
  next: RendererStateMutation
): RendererStateMutation {
  if (previous.effect || previous.revision !== next.baseRevision) {
    throw new RendererStateGapError()
  }
  return {
    ...previous,
    ...next,
    baseRevision: previous.baseRevision,
    ...(previous.bartActivities || next.bartActivities
      ? { bartActivities: [...previous.bartActivities ?? [], ...next.bartActivities ?? []] } : {}),
    ...(previous.threads || next.threads
      ? { threads: mergeCollection(previous.threads, next.threads) } : {}),
    ...(previous.reports || next.reports
      ? { reports: mergeCollection(previous.reports, next.reports) } : {})
  }
}

function collectionDiff<T extends { readonly id: string }>(
  previous: readonly T[], next: readonly T[], same: (left: T, right: T) => boolean
): RendererCollectionPatch<T> | undefined {
  if (previous === next) return undefined
  const previousById = new Map(previous.map(record => [record.id, record]))
  const nextIds = new Set(next.map(record => record.id))
  const upserts = next.filter(record => {
    const old = previousById.get(record.id)
    return !old || old !== record && !same(old, record)
  })
  const removedIds = previous.filter(record => !nextIds.has(record.id)).map(record => record.id)
  const sameOrder = previous.length === next.length &&
    previous.every((record, index) => record.id === next[index].id)
  if (!upserts.length && !removedIds.length && sameOrder) return undefined
  return { upserts, removedIds, ...(!sameOrder ? { order: next.map(record => record.id) } : {}) }
}

function applyCollection<T extends { readonly id: string }>(
  current: readonly T[], patch: RendererCollectionPatch<T> | undefined,
  keep: (previous: T, next: T) => boolean
): readonly T[] {
  if (!patch) return current
  const byId = new Map(current.map(record => [record.id, record]))
  for (const id of patch.removedIds) byId.delete(id)
  for (const record of patch.upserts) {
    const previous = byId.get(record.id)
    byId.set(record.id, previous && keep(previous, record) ? previous : record)
  }
  const records = patch.order ? patch.order.map(id => {
    const record = byId.get(id)
    if (!record) throw new RendererStateGapError()
    return record
  }) : [...byId.values()]
  return current.length === records.length && current.every((record, index) => record === records[index])
    ? current : records
}

function mergeCollection<T extends { readonly id: string }>(
  previous: RendererCollectionPatch<T> | undefined,
  next: RendererCollectionPatch<T> | undefined
): RendererCollectionPatch<T> {
  if (!previous) return next!
  if (!next) return previous
  const upserts = new Map(previous.upserts.map(record => [record.id, record]))
  const removedIds = new Set(previous.removedIds)
  for (const id of next.removedIds) { upserts.delete(id); removedIds.add(id) }
  for (const record of next.upserts) { upserts.set(record.id, record); removedIds.delete(record.id) }
  const order = next.order ?? previous.order
  return { upserts: [...upserts.values()], removedIds: [...removedIds], ...(order ? { order } : {}) }
}

export function sameRendererReport(left: RendererReport, right: RendererReport): boolean {
  return left.id === right.id && left.title === right.title && left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt && left.archived === right.archived &&
    left.previewText === right.previewText && sameStrings(left.tags, right.tags) &&
    left.relatedExecutions.length === right.relatedExecutions.length &&
    left.relatedExecutions.every((ref, index) => ref.threadId === right.relatedExecutions[index]?.threadId &&
      ref.executionId === right.relatedExecutions[index]?.executionId)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left === right || left.length === right.length && left.every((value, index) => value === right[index])
}

function sameJson(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}
