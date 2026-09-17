import type { OverviewLayoutContext } from '@openagent/contracts/renderer'
import { OVERVIEW_LAYOUT_CONTEXT } from './overview-layout-planner'
import type { LayoutPlacement } from './overview-layout'
import { createStore } from 'zustand/vanilla'
import type { BartGenerationWork } from './components/BartThreadGeneration'
import type { ConversationOverviewLayoutRevision } from './components/ConversationOverview'
import { MOTION_LIMITS } from './bart-motion/runtime-limits'

/** UI facts only. The existing generation executor owns stage leases and aborts. */
export function createOverviewOrchestrationStore() {
  const store = createStore(() => ({
    layoutContext: OVERVIEW_LAYOUT_CONTEXT,
    placement: null as { sceneKey: string; placements: readonly LayoutPlacement[] } | null,
    revisions: [] as ConversationOverviewLayoutRevision[],
    revision: 0,
    deletedIndexes: {} as Readonly<Record<string, number>>,
    works: [] as readonly BartGenerationWork[],
    releasedIds: [] as readonly string[],
    hiddenIds: [] as readonly string[],
    reveal: null as { id: string; key: number } | null,
    revealKey: 0
  }))
  const hidden = (works: readonly BartGenerationWork[], released: readonly string[]) =>
    works.flatMap(work => work.targets.map(target => target.id)).filter(id => !released.includes(id))
  return Object.assign(store, {
    setPlacements(sceneKey: string, placements: readonly LayoutPlacement[]) {
      store.setState({ placement: { sceneKey, placements } })
    },
    setLayoutContext(layoutContext: OverviewLayoutContext) {
      if (store.getState().layoutContext.availableCols !== layoutContext.availableCols) store.setState({ layoutContext })
    },
    appendRevision(revision: Omit<ConversationOverviewLayoutRevision, 'revision'>) {
      store.setState(state => ({ revision: state.revision + 1,
        revisions: [...state.revisions, { ...revision, revision: state.revision + 1 }] }))
    },
    consumeRevisions(through: number) {
      store.setState(state => ({ revisions: state.revisions.filter(item => item.revision > through) }))
    },
    setDeletedIndexes(deletedIndexes: Readonly<Record<string, number>>) { store.setState({ deletedIndexes }) },
    clearDeletedIndexes() {
      if (Object.keys(store.getState().deletedIndexes).length) store.setState({ deletedIndexes: {} })
    },
    enqueue(work: BartGenerationWork) {
      store.setState(state => {
        if (state.works.some(item => item.key === work.key)) return state
        if (state.works.length >= MOTION_LIMITS.queuedScenes || work.targets.length > MOTION_LIMITS.sceneCards) {
          work.controller.abort()
          return state
        }
        const works = [...state.works, work]
        return { works, hiddenIds: hidden(works, state.releasedIds) }
      })
    },
    consumeWork(key: number) {
      store.setState(state => {
        const works = state.works.filter(work => work.key !== key)
        const live = new Set(works.flatMap(work => work.targets.map(target => target.id)))
        const releasedIds = state.releasedIds.filter(id => live.has(id))
        return { works, releasedIds, hiddenIds: hidden(works, releasedIds), reveal: null }
      })
    },
    releaseCard(id: string) {
      store.setState(state => {
        if (state.releasedIds.includes(id)) return state
        const releasedIds = [...state.releasedIds, id]
        return { releasedIds, hiddenIds: hidden(state.works, releasedIds) }
      })
    },
    clearReveal() { store.setState({ reveal: null }) },
    requestReveal(id: string) {
      store.setState(state => ({ revealKey: state.revealKey + 1, reveal: { id, key: state.revealKey + 1 } }))
    },
    reset() {
      for (const work of store.getState().works) work.controller.abort()
      store.setState({ revisions: [], deletedIndexes: {}, works: [], releasedIds: [], hiddenIds: [], reveal: null })
    }
  })
}
export type OverviewOrchestrationStore = ReturnType<typeof createOverviewOrchestrationStore>
