import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import type { ThreadCardPlanStep, ThreadCardVariantId } from './contracts.js'

export function threadCardPlanWindow(
  variant: ThreadCardVariantId
): { readonly before: number; readonly after: number } {
  return variant === 'tall' ? { before: 2, after: 5 } : { before: 1, after: 2 }
}

interface PlanRow {
  element: HTMLElement
  node: HTMLElement
  label: HTMLElement
  x: number
  y: number
  nodeStyle: Keyframe
  labelStyle: Keyframe
}

interface PlanFrame {
  steps: readonly ThreadCardPlanStep[]
  variant: ThreadCardVariantId
  appearance: string
  rows: Map<number, PlanRow>
}

function measureRows(track: HTMLElement): Map<number, PlanRow> {
  const origin = track.getBoundingClientRect()
  return new Map(Array.from(track.querySelectorAll<HTMLElement>('[data-plan-index]'), element => {
    const node = element.querySelector('i')!
    const label = element.querySelector('b')!
    const nodeRect = node.getBoundingClientRect()
    const nodeStyle = getComputedStyle(node)
    const labelStyle = getComputedStyle(label)
    return [Number(element.dataset.planIndex), {
      element, node, label,
      x: nodeRect.left + nodeRect.width / 2 - origin.left,
      y: nodeRect.top + nodeRect.height / 2 - origin.top,
      nodeStyle: { backgroundColor: nodeStyle.backgroundColor, borderColor: nodeStyle.borderColor,
        color: nodeStyle.color, boxShadow: nodeStyle.boxShadow },
      labelStyle: { color: labelStyle.color, fontWeight: labelStyle.fontWeight }
    }]
  }))
}

/** 1x1 keeps -1/+2; a selected 1x2 Todo expands the task window to -2/+5. */
export function CardPlanLadder(props: {
  readonly steps: readonly ThreadCardPlanStep[]
  readonly variant: ThreadCardVariantId
}): ReactNode {
  const { steps, variant } = props
  const track = useRef<HTMLSpanElement>(null)
  const previous = useRef<PlanFrame | null>(null)
  const animations = useRef(new Set<Animation>())
  const particles = useRef(new Set<HTMLElement>())

  function cancelMotion(): void {
    for (const animation of animations.current) animation.cancel()
    animations.current.clear()
    for (const particle of particles.current) particle.remove()
    particles.current.clear()
  }

  useEffect(() => {
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const changed = (): void => { if (preference?.matches) cancelMotion() }
    preference?.addEventListener('change', changed)
    return () => { preference?.removeEventListener('change', changed); cancelMotion() }
  }, [])

  useLayoutEffect(() => {
    const element = track.current
    const before = previous.current
    if (!element) { cancelMotion(); previous.current = null; return }
    const samePlan = before?.variant === variant && before.steps.length === steps.length
      && before.steps.every((step, index) => step.step === steps[index]!.step)
    const appearance = getComputedStyle(element).colorScheme
    const sameAppearance = before?.appearance === appearance
    // Provider projections can allocate a fresh plan for unrelated streaming updates.
    if (samePlan && sameAppearance && before.steps.every((step, index) => step.status === steps[index]!.status)) return
    const interrupted = animations.current.size > 0
    cancelMotion()
    const rows = measureRows(element)
    previous.current = { steps: steps.map(step => ({ ...step })), variant, appearance, rows }
    if (!samePlan || !sameAppearance || interrupted || typeof element.animate !== 'function'
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    function animate(target: Element, keyframes: Keyframe[], duration: number, delay = 0): Animation {
      const animation = target.animate(keyframes, {
        duration, delay, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards'
      })
      animations.current.add(animation)
      // Cancellation rejects finished; neither cancellation nor unmount is an error.
      void animation.finished.then(() => animations.current.delete(animation), () => animations.current.delete(animation))
      return animation
    }

    const from = before.steps.findIndex(step => step.status === 'inProgress')
    const to = steps.findIndex(step => step.status === 'inProgress')
    const source = before.rows.get(from)
    const destination = before.rows.get(to)
    const relay = from >= 0 && to === from + 1 && steps[from]?.status === 'completed'
      && before.steps[to]?.status === 'pending' && source && destination && rows.has(from) && rows.has(to)
    const layoutDelay = relay ? 280 : 0

    for (const [index, row] of rows) {
      const old = before.rows.get(index)
      if (old) {
        // Keep node centers aligned even when flex distributes a new row height.
        const delta = old.y - row.y
        if (Math.abs(delta) > .5) animate(row.element, [
          { transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }
        ], 180, layoutDelay)
        if (steps[index]!.status !== before.steps[index]!.status) {
          const delay = relay && index === to ? 240 : 0
          animate(row.node, [old.nodeStyle, row.nodeStyle], 150, delay)
          animate(row.label, [old.labelStyle, row.labelStyle], 150, delay)
          const completed = steps[index]!.status === 'completed'
          const wasCompleted = before.steps[index]!.status === 'completed'
          if (completed !== wasCompleted) {
            animate(row.node.querySelector('svg')!, [
              { opacity: completed ? 0 : 1, transform: completed ? 'scale(.6)' : 'scale(1)' },
              { opacity: completed ? 1 : 0, transform: 'scale(1)' }
            ], 160)
            animate(row.node.querySelector('.thread-card-plan-number')!, [
              { opacity: completed ? 1 : 0 }, { opacity: completed ? 0 : 1 }
            ], 120)
          }
        }
      } else {
        animate(row.element, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], 180, layoutDelay)
      }
    }
    if (relay) {
      const particle = document.createElement('span')
      particle.className = 'thread-card-plan-relay'
      particle.setAttribute('aria-hidden', 'true')
      particle.style.left = `${source.x - 3}px`
      particle.style.top = `${source.y - 3}px`
      element.append(particle)
      particles.current.add(particle)
      const flight = animate(particle, [
        { transform: 'translate(0, 0)', opacity: 0 },
        { opacity: 1, offset: .15 },
        { transform: `translate(${destination.x - source.x}px, ${destination.y - source.y}px)`, opacity: 1, offset: .85 },
        { transform: `translate(${destination.x - source.x}px, ${destination.y - source.y}px)`, opacity: 0 }
      ], 240, 40)
      // The node's final appearance is already committed; the particle is disposable.
      void flight.finished.then(() => { particle.remove(); particles.current.delete(particle) }, () => {})
    }
  })

  if (!steps.length) return null
  let currentIndex = steps.findIndex(step => step.status === 'inProgress')
  if (currentIndex < 0) currentIndex = steps.findIndex(step => step.status === 'pending')
  if (currentIndex < 0) currentIndex = steps.length - 1
  const planWindow = threadCardPlanWindow(variant)
  const start = Math.max(0, currentIndex - planWindow.before)
  const visible = steps.slice(start, currentIndex + planWindow.after + 1)
  const hiddenAfter = steps.length - (start + visible.length)
  return (
    <div className={`thread-card-plan variant-${variant}`}>
      <span className="thread-card-plan-steps" ref={track}>
        {start > 0 ? <span className="thread-card-plan-gap walked" aria-hidden="true" /> : null}
        {visible.map((step, index) => (
          <span className={'thread-card-plan-step ' + step.status} data-plan-index={start + index} key={`${start + index}:${step.step}`}>
            <i aria-hidden="true">
              <span className="thread-card-plan-number">{start + index + 1}</span>
              <Check size={10} strokeWidth={3} />
            </i>
            <b>{step.step}</b>
          </span>
        ))}
        {hiddenAfter > 0 ? <>
          <span className="thread-card-plan-gap ahead" aria-hidden="true" />
          <small className="thread-card-overflow">{`+${hiddenAfter}`}</small>
        </> : null}
      </span>
    </div>
  )
}
