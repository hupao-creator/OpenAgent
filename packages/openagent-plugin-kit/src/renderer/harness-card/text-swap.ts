import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

type TextSwapPhase = 'idle' | 'exit' | 'enter' | 'settle'

interface TextSwap<Element extends HTMLElement> {
  readonly ref: RefObject<Element | null>
  readonly content: ReactNode
  readonly className: string
}

const SWAP_CLASS = 'thread-title-swap'

/**
 * Duration the swap stylesheet gives the element, in milliseconds. The
 * stylesheet stays authoritative: a zero duration (no stylesheet, or the
 * reduced-motion rule) means the text is replaced without a sequence.
 */
function swapDurationMs(node: HTMLElement | null): number {
  if (!node) return 0
  const seconds = Number.parseFloat(getComputedStyle(node).transitionDuration)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
}

function swapClassName(phase: TextSwapPhase): string {
  if (phase === 'exit') return `${SWAP_CLASS} is-exit`
  if (phase === 'enter') return `${SWAP_CLASS} is-enter-start`
  return phase === 'settle' ? SWAP_CLASS : ''
}

/**
 * Replaces a title through the Transitions.dev "text states swap" motion: the
 * outgoing text slides up, blurs and fades, then the incoming text slides back
 * in from below. Apply the returned `ref`, `content` and `className` to the
 * element that holds the title itself, so that element keeps its own ellipsis
 * and alignment.
 *
 * Only a plain string title is swapped. A title a harness composed as an
 * element has no stable identity to compare against, so it renders as it
 * always did.
 */
export function useTextSwap<Element extends HTMLElement>(text: ReactNode): TextSwap<Element> {
  const ref = useRef<Element | null>(null)
  const label = typeof text === 'string' ? text : null
  const [shown, setShown] = useState(label)
  const [phase, setPhase] = useState<TextSwapPhase>('idle')
  const incoming = useRef(label)
  incoming.current = label

  useEffect(() => {
    if (label !== null && label !== shown) setPhase('exit')
  }, [label, shown])

  useLayoutEffect(() => {
    if (label === null || phase !== 'exit') return
    const duration = swapDurationMs(ref.current)
    if (duration === 0) {
      setShown(incoming.current)
      setPhase('idle')
      return
    }
    const timer = setTimeout(() => {
      setShown(incoming.current)
      setPhase('enter')
    }, duration)
    return () => clearTimeout(timer)
  }, [label, phase])

  useLayoutEffect(() => {
    if (phase !== 'enter') return
    // Commit the incoming text at its displaced position before the class is
    // dropped, so the element transitions from there instead of snapping.
    void ref.current?.offsetHeight
    setPhase('settle')
  }, [phase])

  useLayoutEffect(() => {
    if (phase !== 'settle') return
    const duration = swapDurationMs(ref.current)
    if (duration === 0) {
      setPhase('idle')
      return
    }
    const timer = setTimeout(() => setPhase('idle'), duration)
    return () => clearTimeout(timer)
  }, [phase])

  return {
    ref,
    content: label === null ? text : shown,
    className: label === null ? '' : swapClassName(phase)
  }
}
