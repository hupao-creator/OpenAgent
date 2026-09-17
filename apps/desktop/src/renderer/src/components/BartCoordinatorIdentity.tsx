import { useLayoutEffect, useRef, useState } from 'react'
import type { HarnessId } from '../../../shared/harnesses'
import { harnessLogoSource } from '../harness-composition'
import { BartLogo } from './BartLogo'
import { useBartCoordinatorIdle } from './use-bart-coordinator-idle'
import { useBartDispatchFeedback, type BartDispatchFeedback } from './use-bart-dispatch-feedback'
import { animateBartEyes } from '../bart-motion/CharacterCanvas'

export interface CoordinatorHandoff {
  readonly harnessId: HarnessId
  readonly sequence: number
  readonly fromX: number
}

/** Bart travels to the selected Harness and stays at that Harness's position. */
export function BartCoordinatorIdentity({ harnessId, handoff, inFlight, position, positionPending, dispatchFeedback }: {
  readonly harnessId: HarnessId
  readonly handoff: CoordinatorHandoff | null
  /** Another Bart is still on its way here; the seat holds the place but stays empty. */
  readonly inFlight?: boolean
  readonly position: number
  /** This place is only where the seat would be if every Harness were on the machine. */
  readonly positionPending?: boolean
  readonly dispatchFeedback: BartDispatchFeedback | null
}): React.JSX.Element {
  const [driver, setDriver] = useState(harnessId)
  const [receiving, setReceiving] = useState(false)
  const coordinatorRef = useRef<HTMLSpanElement>(null)
  const receiptRef = useRef<HTMLSpanElement>(null)
  // No gesture plays while a flight is underway, even though the seat is only hidden
  // rather than unmounted: the flight measures this seat's drawn ink, and another
  // Bart is about to be handed over to whatever pose it finds. An idle transform
  // still running through that box would start the copy rotated — and so taller —
  // and a dispatch acknowledgment would land it on a seat mid-lean. Both are held
  // back rather than cancelled, so the acknowledgment the user asked for still plays
  // once the seat is Bart's again; the settings page opens its controls while the
  // copy is still in the air, so this is reachable, not theoretical.
  const ready = !receiving && driver === harnessId && !inFlight
  const responding = useBartDispatchFeedback(coordinatorRef, dispatchFeedback, ready)
  useBartCoordinatorIdle(coordinatorRef, ready && !responding)

  useLayoutEffect(() => {
    const coordinator = coordinatorRef.current
    if (!handoff || handoff.harnessId !== harnessId || !coordinator ||
      typeof coordinator.animate !== 'function' || typeof window.matchMedia !== 'function' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDriver(harnessId)
      setReceiving(false)
      return
    }
    setReceiving(true)
    const direction = Math.sign(handoff.fromX)
    // Horizontal travel belongs to the anchor's selected slot; this adds lift and landing.
    const approach = coordinator?.animate([
      { translate: '0px 0px', offset: 0 },
      { translate: '0px -6px', offset: .2 },
      { translate: '0px -14px', offset: .44 },
      { translate: '0px 2px', offset: .68 },
      { translate: '0px -3px', offset: .84 },
      { translate: '0px 0px', offset: 1 }
    ], { duration: 1050, easing: 'ease-in-out', fill: 'forwards' })
    const body = receiptRef.current?.animate([
      { transform: 'translate(0, 0) rotate(0) scale(1)', offset: 0 },
      { transform: `translate(${direction * 3}px, 0) rotate(${direction * 8}deg)`, offset: .18 },
      { transform: `translate(${direction * 4}px, -3px) rotate(${direction * 11}deg) scale(.97, 1.04)`, offset: .44 },
      { transform: 'translate(0, 2px) rotate(0) scale(1.09, .9)', offset: .68 },
      { transform: 'translate(0, -4px) rotate(0) scale(.97, 1.04)', offset: .84 },
      { transform: 'translate(0, 0) rotate(0) scale(1)', offset: 1 }
    ], { duration: 1050, easing: 'ease-in-out' })
    const eyes = animateBartEyes(receiptRef.current, [
      { transform: 'translate(0, 0)', offset: 0 },
      { transform: `translate(${direction * 32}px, 12px)`, offset: .2 },
      { transform: `translate(${direction * 24}px, 20px)`, offset: .5 },
      { transform: 'translate(0, 32px)', offset: .68 },
      { transform: 'translate(0, -10px)', offset: .84 },
      { transform: 'translate(0, 0)', offset: 1 }
    ], 1050)
    performance.clearMarks('bart-host-ready')
    performance.mark('bart-host-ready', { detail: { origin: performance.timeOrigin + performance.now(), duration: 1050 } })
    const finish = (): void => {
      body?.cancel()
      eyes?.cancel()
      approach?.cancel()
      setDriver(harnessId)
      setReceiving(false)
    }
    const settle = window.setTimeout(finish, 1050)
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const reduce = (): void => { if (media.matches) { window.clearTimeout(settle); finish() } }
    media.addEventListener?.('change', reduce)
    return () => {
      media.removeEventListener?.('change', reduce)
      window.clearTimeout(settle)
      body?.cancel()
      eyes?.cancel()
      approach?.cancel()
    }
  }, [harnessId, handoff])

  return <span className="bart-coordinator-rail" style={{ transform: `translateX(${position}%)` }} aria-hidden="true">
    <span className="bart-coordinator-anchor" data-position-pending={positionPending ? '' : undefined}>
    <span className={`bart-coordinator${receiving ? ' is-receiving' : ''}`} data-bart-coordinator ref={coordinatorRef}>
    <span className="bart-host-identity" ref={receiptRef}>
      {/* Hidden rather than unmounted: the incoming copy measures this seat to land on it. */}
      <span className="bart-host-character" style={inFlight ? { visibility: 'hidden' } : undefined}>
        <span className="bart-host-body"><BartLogo size={72} /></span>
        <span className="bart-host-engine" data-bart-engine={harnessId}>
          {driver !== harnessId && <span className="bart-host-engine-previous" key={driver}>
            <img src={harnessLogoSource(driver)} alt="" draggable={false} />
          </span>}
          <span className="bart-host-engine-mark" key={inFlight ? `${harnessId}-in-flight` : harnessId}
            data-arriving={driver !== harnessId ? '' : undefined}>
            <img src={harnessLogoSource(harnessId)} alt="" draggable={false} />
          </span>
        </span>
      </span>
    </span>
    </span>
  </span>
  </span>
}
