import { createContext, useContext, useId, useLayoutEffect, type RefObject } from 'react'

export interface BartLiquidRegistration {
  readonly id: string
  readonly token: string
  readonly element: SVGSVGElement
  readonly color: string
}
export interface BartLiquidHost {
  register(value: BartLiquidRegistration): () => void
}
export const BartLiquidContext = createContext<{
  host: BartLiquidHost | null
  painted: ReadonlySet<string>
}>({ host: null, painted: new Set() })

/** Merely asking for glass never hides the body: the host must acknowledge a frame. */
export function useBartLiquidBody(ref: RefObject<SVGSVGElement | null>, eligible: boolean, color: string): boolean {
  const id = useId()
  const { host, painted } = useContext(BartLiquidContext)
  // The acknowledgement is keyed by the registration's identity alone. Folding
  // colour or motion into it would revoke the acknowledgement on every activity
  // or colour change, dropping the body back to solid for a frame each time.
  const token = id
  useLayoutEffect(() => {
    if (!eligible || !host || !ref.current) return
    return host.register({ id, token, element: ref.current, color })
  }, [host, eligible, ref, id, token, color])
  return eligible && painted.has(token)
}
