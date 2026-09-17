import { useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { createCrossPageScene, prewarmCrossPageScene, type CrossPageScene, type BartFlightDirection } from '../bart-motion/cross-page-scene'
import './bart-cross-page-flight.css'

export type { BartFlightDirection } from '../bart-motion/cross-page-scene'

/** React owns mounting and business commits; the scene owns the flight. */
export function BartCrossPageFlight({ direction, readyToLand = true, onActiveChange }: {
  readonly direction: BartFlightDirection | null
  readonly readyToLand?: boolean
  readonly onActiveChange: (active: boolean, direction: BartFlightDirection) => void
}): React.JSX.Element {
  const marker = useRef<HTMLSpanElement>(null)
  const session = useRef<CrossPageScene | undefined>(undefined)
  const landingReady = useRef(readyToLand)
  landingReady.current = readyToLand
  const notify = useRef(onActiveChange)
  notify.current = onActiveChange
  useLayoutEffect(() => {
    prewarmCrossPageScene(marker.current?.closest<HTMLElement>('.app-shell'))
  }, [])
  useLayoutEffect(() => () => { session.current?.dispose(); session.current = undefined }, [])
  useLayoutEffect(() => {
    // Finish outside the layout effect stack while the covering frame stays up.
    queueMicrotask(() => session.current?.land())
  }, [readyToLand])
  useLayoutEffect(() => {
    if (!direction) return
    if (session.current?.redirect(direction)) return
    session.current?.dispose()
    const scene = createCrossPageScene(marker.current?.closest<HTMLElement>('.app-shell'), direction, {
      readyToLand: () => landingReady.current,
      onActiveChange: (active, next) => notify.current(active, next),
      handoff: next => flushSync(() => notify.current(false, next))
    })
    session.current = scene
    void scene.settled.then(() => { if (session.current === scene) session.current = undefined })
  }, [direction])
  return <span hidden aria-hidden="true" ref={marker} />
}
