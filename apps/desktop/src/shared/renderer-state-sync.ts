import type { RendererAppState, RendererStateMutation } from './renderer-state-contracts'
import { RendererStateGapError } from './renderer-state-patch'
import {
  applyRendererStateStoreMutation,
  hydrateRendererStateStore,
  type RendererStateStore,
  type RendererTransitionFailure
} from './renderer-store'

/** Owns subscription-before-load, hydration buffering and gap recovery. */
export function synchronizeRendererState(input: {
  readonly store: RendererStateStore
  readonly load: () => Promise<RendererAppState>
  readonly subscribe: (listener: (mutation: RendererStateMutation) => void) => () => void
  readonly beforeCommit: (current: RendererAppState, next: RendererAppState, mutation: RendererStateMutation) => void
  readonly transitionFailed?: (failure: RendererTransitionFailure) => void
  readonly hydrated: (snapshot: RendererAppState) => void
  readonly failed: (error: unknown) => void
}): () => void {
  let active = true
  let loading = false
  let loaded = false
  const buffered: RendererStateMutation[] = []
  const apply = (mutation: RendererStateMutation): boolean => {
    try {
      applyRendererStateStoreMutation(input.store, mutation,
        (current, next) => input.beforeCommit(current, next, mutation), input.transitionFailed)
      return true
    } catch (error) {
      if (!(error instanceof RendererStateGapError)) throw error
      return false
    }
  }
  const reload = async (): Promise<void> => {
    if (loading || !active) return
    loading = true
    let needsReload = false
    try {
      const snapshot = await input.load()
      if (!active) return
      hydrateRendererStateStore(input.store, snapshot)
      loaded = true
      input.hydrated(snapshot)
      // The snapshot subsumes older queued changes. Effects on those revisions
      // are deliberately not replayed during initial load or gap recovery.
      const pending = buffered.splice(0)
      for (let index = 0; index < pending.length; index += 1) {
        if (apply(pending[index])) continue
        buffered.push(...pending.slice(index))
        needsReload = true
        break
      }
    } catch (error) {
      if (active) input.failed(error)
    } finally {
      loading = false
    }
    if (needsReload) void reload()
  }
  const unsubscribe = input.subscribe(mutation => {
    if (!active) return
    if (!loaded || loading) buffered.push(mutation)
    else if (!apply(mutation)) { buffered.push(mutation); void reload() }
  })
  void reload()
  return () => { active = false; buffered.length = 0; unsubscribe() }
}
