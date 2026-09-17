import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { useStore } from 'zustand'
import type {
  AgentThreadRecord,
  DeepReadonly
} from '@openagent/contracts'
import type {
  NormalizedRendererState,
  RendererStateStore
} from '../../shared/renderer-store'
import type { RendererThreadRecord } from '../../shared/renderer-state-contracts'

const RendererStoreContext = createContext<RendererStateStore | null>(null)

export function RendererStoreProvider(props: {
  readonly store: RendererStateStore
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <RendererStoreContext.Provider value={props.store}>
      {props.children}
    </RendererStoreContext.Provider>
  )
}

export function useRendererState<Selected>(
  selector: (state: NormalizedRendererState) => Selected
): Selected {
  return useStore(useRendererStoreApi(), selector)
}

/** Catalog consumers only read membership, tags, title, directory and task
 * bucket. Opaque plugin output and Bart tokens do not invalidate this slice. */
export function useRendererAgentCatalog(): readonly AgentThreadRecord[] {
  const store = useRendererStoreApi()
  const revision = useRendererState((state) => state.agentCatalogRevision)
  return useMemo(() => store.getState().agentThreads, [store, revision])
}

export function useRendererThread(
  threadId: string,
  fallback?: DeepReadonly<RendererThreadRecord>
): DeepReadonly<RendererThreadRecord> {
  const store = useContext(RendererStoreContext)
  const thread = useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    () => store?.getState().threadsById[threadId] ?? fallback,
    () => store?.getInitialState().threadsById[threadId] ?? fallback
  )
  if (!thread) throw new Error(`Renderer Thread 不存在: ${threadId}`)
  return thread
}

export function useRendererAgentThread(
  threadId: string,
  fallback?: DeepReadonly<AgentThreadRecord>
): DeepReadonly<AgentThreadRecord> {
  const thread = useRendererThread(threadId, fallback)
  if ('bart' in thread && thread.bart === true) {
    throw new Error(`Renderer Agent Thread 指向 Bart: ${threadId}`)
  }
  return thread
}

const EMPTY_SUBSCRIBE = (): (() => void) => () => undefined

export function useRendererStoreApi(): RendererStateStore {
  const store = useContext(RendererStoreContext)
  if (!store) throw new Error('RendererStoreProvider 缺失')
  return store
}
