import { createContext, useContext, type ReactNode } from 'react'

const FollowUpContext = createContext<(() => void) | null>(null)

/** Core owns eligibility and routing; the Harness logo owns its visual affordance. */
export function ThreadCardFollowUpProvider(props: { readonly onOpen: (() => void) | null; readonly children: ReactNode }): React.JSX.Element {
  return <FollowUpContext.Provider value={props.onOpen}>{props.children}</FollowUpContext.Provider>
}

export function useThreadCardFollowUp(): (() => void) | null {
  return useContext(FollowUpContext)
}
