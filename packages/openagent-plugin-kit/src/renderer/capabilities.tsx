import { createContext, useContext, type PropsWithChildren } from 'react'

import type { RendererFirstCommitDiagnostic } from '../shared/diagnostic-tracing.js'

/** Optional host services for shared renderer components. */
export interface RendererCapabilities {
  /** When omitted, Markdown links retain their normal browser navigation. */
  readonly openExternal?: (url: string) => void | Promise<void>
  /** When omitted, first-commit diagnostics are disabled. */
  readonly reportRendererFirstCommit?: (input: RendererFirstCommitDiagnostic) => void
}

const RendererCapabilitiesContext = createContext<RendererCapabilities>({})

/** Scope capabilities to a renderer tree; independent hosts need no global bridge. */
export function RendererCapabilitiesProvider({
  capabilities,
  children
}: PropsWithChildren<{ readonly capabilities: RendererCapabilities }>): React.JSX.Element {
  return <RendererCapabilitiesContext.Provider value={capabilities}>
    {children}
  </RendererCapabilitiesContext.Provider>
}

export function useRendererCapabilities(): RendererCapabilities {
  return useContext(RendererCapabilitiesContext)
}
