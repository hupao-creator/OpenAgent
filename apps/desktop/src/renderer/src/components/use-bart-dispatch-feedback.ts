import { useLayoutEffect, useState, type RefObject } from 'react'
import type { HarnessId } from '../../../shared/harnesses'
import { animateBartEyes } from '../bart-motion/CharacterCanvas'

export interface BartDispatchFeedback {
  readonly sequence: number
  readonly harnessId: HarnessId
  readonly enabled: boolean
  readonly gazeX: number
}

// Rapid clicking is the user flip-flopping, not asking for one acknowledgment per
// click. Waiting for the clicks to stop lets the character play a single clip for
// the final state instead of restarting from rest on every click.
const QUIET_MS = 200

/** Acknowledge the latest target change; coordinator handoff takes priority. */
export function useBartDispatchFeedback(
  rootRef: RefObject<HTMLElement | null>,
  feedback: BartDispatchFeedback | null,
  ready: boolean
): boolean {
  const [settled, setSettled] = useState(0)
  const [armed, setArmed] = useState<BartDispatchFeedback | null>(null)
  const pending = feedback !== null && feedback.sequence !== settled

  // The toggle itself lands on every click; only the acknowledgment waits. `pending`
  // is true throughout the wait, so idle gestures stay out of the way until then.
  // `settled` is deliberately not a dependency: an earlier clip finishing mid-wait
  // would otherwise restart the quiet window and push the acknowledgment out.
  useLayoutEffect(() => {
    if (!feedback) return
    const quiet = window.setTimeout(() => setArmed(feedback), QUIET_MS)
    return () => window.clearTimeout(quiet)
  }, [feedback])

  // `feedback` is read but deliberately not a dependency: re-running on every click
  // would cancel the clip in flight, which is the snap this hook exists to remove. The
  // closure is still current whenever this effect runs, because the render that changes
  // `armed`/`ready`/`settled` carries the latest feedback with it.
  useLayoutEffect(() => {
    // A handoff — or another Bart still flying in — holds the clip back while `ready` is
    // false. By the time it clears, `armed` can describe a click the user has since
    // superseded, so only start the latest.
    if (!armed || armed.sequence !== feedback?.sequence || armed.sequence === settled || !ready) return
    const character = rootRef.current?.querySelector<HTMLElement>('.bart-host-character')
    const face = rootRef.current?.querySelector<SVGElement>('.bart-face')
    if (!character || !face || !character.getClientRects().length ||
      typeof character.animate !== 'function' || typeof window.matchMedia !== 'function' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setSettled(armed.sequence)
      return
    }
    const target = rootRef.current?.closest('.harness-dispatch-map')
      ?.querySelector(`[data-row="dispatch"] [data-agent="${armed.harnessId}"] img`)
    const core = rootRef.current?.querySelector('.bart-host-engine-mark')
    const lean = armed.gazeX / 9
    const turn = armed.gazeX / 6
    const neutral = 'translate(0, 0) rotate(0) scale(1)'
    const duration = armed.enabled ? 1800 : 1600
    // Orient and hold, acknowledge the change, wait for the target, then relax.
    const movement = character.animate(armed.enabled ? [
      { transform: neutral, offset: 0 },
      { transform: `translate(${lean}px, 2px) rotate(${turn}deg)`, offset: .18 },
      { transform: `translate(${lean}px, 2px) rotate(${turn}deg)`, offset: .32 },
      { transform: `translate(${lean * 1.25}px, 5px) rotate(${turn}deg) scale(1.04, .94)`, offset: .46 },
      { transform: `translate(${lean}px, -2px) rotate(${turn * .5}deg) scale(.98, 1.03)`, offset: .61 },
      { transform: `translate(${lean * .7}px, 0) rotate(${turn * .5}deg)`, offset: .78 },
      { transform: neutral, offset: 1 }
    ] : [
      { transform: neutral, offset: 0 },
      { transform: `translate(${lean}px, 2px) rotate(${turn}deg)`, offset: .18 },
      { transform: `translate(${lean}px, 2px) rotate(${turn}deg)`, offset: .36 },
      { transform: `translate(${-lean * .5}px, -3px) rotate(${-turn * .4}deg) scale(.98, 1.02)`, offset: .6 },
      { transform: `translate(${-lean * .25}px, -1px)`, offset: .78 },
      { transform: neutral, offset: 1 }
    ], { duration, easing: 'ease-in-out' })
    const eyes = animateBartEyes(rootRef.current, [
      { transform: 'translate(0, 0)', offset: 0 },
      { transform: `translate(${armed.gazeX}px, 28px)`, offset: .13 },
      { transform: `translate(${armed.gazeX}px, ${armed.enabled ? 36 : 28}px)`, offset: .38 },
      { transform: `translate(${armed.enabled ? armed.gazeX * .75 : 0}px, ${armed.enabled ? 26 : 8}px)`, offset: .72 },
      { transform: 'translate(0, 0)', offset: 1 }
    ], duration)
    const response = target?.animate(armed.enabled ? [
      { transform: 'translateY(0) scale(1)', opacity: 1, offset: 0 },
      { transform: 'translateY(0) scale(1)', opacity: 1, offset: .44 },
      { transform: 'translateY(-5px) scale(1.12)', opacity: 1, offset: .61 },
      { transform: 'translateY(1px) scale(1.04, .97)', opacity: 1, offset: .75 },
      { transform: 'translateY(0) scale(1)', opacity: 1, offset: 1 }
    ] : [
      { transform: 'scale(1)', opacity: 1, offset: 0 },
      { transform: 'scale(1)', opacity: 1, offset: .32 },
      { transform: 'scale(.9)', opacity: .5, offset: .6 },
      { transform: 'scale(1)', opacity: 1, offset: 1 }
    ], { duration, easing: 'ease-in-out' })
    const confirmation = core?.animate([
      { transform: 'scale(1)', opacity: 1, offset: 0 },
      { transform: 'scale(1)', opacity: 1, offset: .65 },
      { transform: `scale(${armed.enabled ? 1.1 : .95})`, opacity: armed.enabled ? 1 : .65, offset: .82 },
      { transform: 'scale(1)', opacity: 1, offset: 1 }
    ], { duration, easing: 'ease-in-out' })
    performance.clearMarks('bart-dispatch-ready')
    performance.mark('bart-dispatch-ready', { detail: { origin: performance.timeOrigin + performance.now(), duration, enabled: armed.enabled } })
    movement.onfinish = () => setSettled(armed.sequence)
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const stop = (): void => { movement.cancel(); eyes.cancel(); response?.cancel(); confirmation?.cancel() }
    const reduce = (): void => { if (media.matches) { stop(); setSettled(armed.sequence) } }
    media.addEventListener?.('change', reduce)
    return () => { media.removeEventListener?.('change', reduce); stop() }
  }, [rootRef, armed, ready, settled])

  return pending
}
