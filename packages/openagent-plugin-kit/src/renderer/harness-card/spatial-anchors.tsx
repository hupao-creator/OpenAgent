import { createContext, useCallback, useContext, type ReactNode } from 'react'

/** Viewport geometry published by the component that owns its DOM. */
export interface ThreadCardAnchorRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export type ThreadCardAnchorName = 'status' | 'excerpt-end'
export type ThreadCardAnchorMeasure = () => ThreadCardAnchorRect | null
export type ThreadCardAnchorRegistrar = (
  name: ThreadCardAnchorName,
  measure: ThreadCardAnchorMeasure | null
) => void

const AnchorContext = createContext<ThreadCardAnchorRegistrar | null>(null)

export function ThreadCardAnchorProvider(props: {
  readonly register: ThreadCardAnchorRegistrar
  readonly children: ReactNode
}): React.JSX.Element {
  return <AnchorContext.Provider value={props.register}>{props.children}</AnchorContext.Provider>
}

const elementBounds = (element: HTMLElement): ThreadCardAnchorRect => element.getBoundingClientRect()

export function useThreadCardAnchor(
  name: ThreadCardAnchorName,
  measure: (element: HTMLElement) => ThreadCardAnchorRect | null = elementBounds
): (element: HTMLElement | null) => void {
  const register = useContext(AnchorContext)
  return useCallback((element: HTMLElement | null) => {
    register?.(name, element ? () => element.isConnected ? measure(element) : null : null)
  }, [register, name, measure])
}

/** The excerpt owns the text layout; animation consumers only see its endpoint. */
export function measureThreadCardExcerptEnd(element: HTMLElement): ThreadCardAnchorRect | null {
  const document = element.ownerDocument
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let last: Text | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.length && !(node.parentElement?.closest('[aria-hidden="true"]'))) last = node as Text
  }
  if (!last?.length) return null
  const range = document.createRange()
  range.setStart(last, last.length - 1)
  range.setEnd(last, last.length)
  if (typeof range.getBoundingClientRect !== 'function') return null
  const rect = range.getBoundingClientRect()
  if (!rect.width && !rect.height) return null
  return { left: rect.right + 8, top: rect.top + rect.height / 2, width: 0, height: 0 }
}
