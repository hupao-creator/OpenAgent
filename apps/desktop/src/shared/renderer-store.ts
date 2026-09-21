import { createStore, type StoreApi } from 'zustand/vanilla'
import type { AgentThreadRecord } from '@openagent/contracts'
import { createInitialRendererState } from './renderer-state'
import { applyRendererStatePatch, sameRendererReport } from './renderer-state-patch'
import type {
  RendererAppState,
  RendererBartThreadRecord,
  RendererStateMutation,
  RendererThreadRecord
} from './renderer-state-contracts'

export interface NormalizedRendererState {
  readonly revision: number
  readonly defaultCwd: string
  readonly threads: RendererAppState['threads']
  readonly threadIds: readonly string[]
  readonly agentThreadIds: readonly string[]
  /** Stable across Bart-only changes; Agent content subscribers use this slice. */
  readonly agentThreads: readonly AgentThreadRecord[]
  readonly bartThreadId: string | null
  readonly threadsById: Readonly<Record<string, RendererThreadRecord>>
  /** Changes only when tag/filter metadata or Agent membership changes. */
  readonly agentCatalogRevision: number
  /** Changes for every accepted Agent Thread record revision. */
  readonly agentContentRevision: number
  readonly executions: RendererAppState['executions']
  readonly reports: RendererAppState['reports']
  readonly selectedThreadId: string | null
  readonly settings: RendererAppState['settings']
}

export type RendererStateObserver = (state: NormalizedRendererState, mutation: RendererStateMutation | null) => void
export type RendererStateStore = StoreApi<NormalizedRendererState> & {
  /** Synchronous delivery before React can coalesce renders; null means recovery. */
  observe: (listener: RendererStateObserver) => () => void
}
const observers = new WeakMap<RendererStateStore, Set<RendererStateObserver>>()
function notifyObservers(store: RendererStateStore, mutation: RendererStateMutation | null): void {
  for (const listener of observers.get(store) ?? []) {
    try { listener(store.getState(), mutation) } catch (error) {
      reportRendererTransitionFailure({ error, currentRevision: store.getState().revision, nextRevision: store.getState().revision })
    }
  }
}

export function createRendererStateStore(defaultCwd: string): RendererStateStore {
  const listeners = new Set<RendererStateObserver>()
  const store: RendererStateStore = Object.assign(createStore<NormalizedRendererState>()(() =>
    normalizeRendererState(createInitialRendererState(defaultCwd))
  ), { observe: (listener: RendererStateObserver) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  } })
  observers.set(store, listeners)
  return store
}

/** Initial hydration is authoritative even when its revision is zero. */
export function hydrateRendererStateStore(
  store: RendererStateStore,
  snapshot: RendererAppState
): void {
  store.setState(normalizeRendererState(snapshot, store.getState()), true)
  notifyObservers(store, null)
}

/**
 * Applies a committed Main-process patch and exposes its accepted transition
 * before subscribers render it. The callback is used for Overview choreography.
 */
export function applyRendererStateStoreMutation(
  store: RendererStateStore,
  mutation: RendererStateMutation,
  beforeCommit?: (current: RendererAppState, next: RendererAppState) => void,
  transitionFailed: (failure: RendererTransitionFailure) => void = reportRendererTransitionFailure
): boolean {
  const current = store.getState()
  if (mutation.revision <= current.revision) return false
  const next = normalizeRendererState(applyRendererStatePatch(rendererAppState(current), mutation), current)
  let failure: RendererTransitionFailure | undefined
  try {
    beforeCommit?.(rendererAppState(current), rendererAppState(next))
  } catch (error) {
    failure = { error, currentRevision: current.revision, nextRevision: next.revision }
  }
  // Layout capture must remain synchronous so batched A → B → A updates keep
  // both transitions, but a visual observer can never veto Main's commit.
  store.setState(next, true)
  notifyObservers(store, mutation)
  if (failure) {
    try { transitionFailed(failure) } catch (error) {
      reportRendererTransitionFailure({ ...failure, error })
    }
  }
  return true
}

export interface RendererTransitionFailure {
  readonly error: unknown
  readonly currentRevision: number
  readonly nextRevision: number
}

export function reportRendererTransitionFailure(failure: RendererTransitionFailure): void {
  console.error('Renderer visual transition failed after accepting state', failure)
}

export function rendererAppState(state: NormalizedRendererState): RendererAppState {
  return {
    revision: state.revision,
    defaultCwd: state.defaultCwd,
    threads: state.threads,
    executions: state.executions,
    reports: state.reports,
    selectedThreadId: state.selectedThreadId,
    settings: state.settings
  }
}

function normalizeRendererState(
  snapshot: RendererAppState,
  previous?: NormalizedRendererState
): NormalizedRendererState {
  if (previous && snapshot.threads === previous.threads) {
    return {
      ...previous,
      ...snapshot,
      reports: reconcileReports(previous.reports, snapshot.reports)
    }
  }
  const threadsById: Record<string, RendererThreadRecord> = {}
  const threads: RendererThreadRecord[] = []
  const agentThreads: AgentThreadRecord[] = []
  let agentChanged = false
  let catalogChanged = false
  for (const incoming of snapshot.threads) {
    const current = previous?.threadsById[incoming.id]
    const thread = current?.revision === incoming.revision ? current : incoming
    threadsById[incoming.id] = thread
    threads.push(thread)
    if (!isBart(thread)) agentThreads.push(thread)
    if (!isBart(incoming) && thread !== current) {
      agentChanged = true
      if (!current || !sameThreadCatalogEntry(current, incoming)) catalogChanged = true
    }
  }
  const threadIds = reuseStringArray(previous?.threadIds, snapshot.threads.map(({ id }) => id))
  const agentThreadIds = reuseStringArray(
    previous?.agentThreadIds,
    snapshot.threads.flatMap((thread) => isBart(thread) ? [] : [thread.id])
  )
  if (agentThreadIds !== previous?.agentThreadIds) {
    agentChanged = true
    catalogChanged = true
  }
  return {
    revision: snapshot.revision,
    defaultCwd: snapshot.defaultCwd,
    threads: previous?.threads.length === threads.length &&
      previous.threads.every((thread, index) => thread === threads[index])
      ? previous.threads
      : threads,
    threadIds,
    agentThreadIds,
    agentThreads: !agentChanged && previous ? previous.agentThreads : agentThreads,
    bartThreadId: snapshot.threads.find(isBart)?.id ?? null,
    threadsById,
    agentCatalogRevision: (previous?.agentCatalogRevision ?? 0) + (catalogChanged ? 1 : 0),
    agentContentRevision: (previous?.agentContentRevision ?? 0) + (agentChanged ? 1 : 0),
    executions: sameExecutions(previous?.executions, snapshot.executions)
      ? previous?.executions ?? snapshot.executions
      : snapshot.executions,
    reports: reconcileReports(previous?.reports, snapshot.reports),
    selectedThreadId: snapshot.selectedThreadId,
    settings: sameJson(previous?.settings, snapshot.settings)
      ? previous?.settings ?? snapshot.settings
      : snapshot.settings
  }
}

function isBart(thread: RendererThreadRecord): thread is RendererBartThreadRecord {
  return 'bart' in thread && thread.bart === true
}

function sameThreadCatalogEntry(
  current: RendererThreadRecord,
  incoming: RendererThreadRecord
): boolean {
  return ('archived' in current ? current.archived : undefined) === ('archived' in incoming ? incoming.archived : undefined) &&
    current.observation.latestExecution?.executionId === incoming.observation.latestExecution?.executionId &&
    current.observation.latestExecution?.status === incoming.observation.latestExecution?.status &&
    current.observation.backgroundWork?.status === incoming.observation.backgroundWork?.status &&
    current.harnessId === incoming.harnessId &&
    current.title === incoming.title && current.cwd === incoming.cwd &&
    current.worktree?.baseCwd === incoming.worktree?.baseCwd &&
    sameStrings(current.tags, incoming.tags)
}

function reconcileReports(
  previous: RendererAppState['reports'] | undefined,
  incoming: RendererAppState['reports']
): RendererAppState['reports'] {
  if (previous === incoming) return previous
  const previousById = new Map(previous?.map((report) => [report.id, report]))
  const reconciled = incoming.map((report) => {
    const current = previousById.get(report.id)
    return current && sameRendererReport(current, report) ? current : report
  })
  return previous && previous.length === reconciled.length &&
    previous.every((report, index) => report === reconciled[index])
    ? previous
    : reconciled
}

function sameExecutions(
  current: RendererAppState['executions'] | undefined,
  incoming: RendererAppState['executions']
): boolean {
  return Boolean(current && current.length === incoming.length && current.every((execution, index) => {
    const next = incoming[index]
    return next && execution.threadId === next.threadId &&
      execution.executionId === next.executionId && execution.status === next.status &&
      execution.startedAt === next.startedAt
  }))
}

function reuseStringArray(
  current: readonly string[] | undefined,
  incoming: readonly string[]
): readonly string[] {
  return current && sameStrings(current, incoming) ? current : incoming
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameJson(left: unknown, right: unknown): boolean {
  return left === right || left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}
