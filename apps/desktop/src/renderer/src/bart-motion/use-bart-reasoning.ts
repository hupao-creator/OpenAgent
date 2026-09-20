import { useLayoutEffect, useRef, type RefObject } from 'react'
import { animateBartEyes } from './CharacterCanvas'
import { readingGaze } from './reasoning-gaze'
import { readingBody } from './reasoning-body'
import { createStreamPresentation } from './reasoning-stream-presentation'
import { REASONING_CENTER, REASONING_RADIUS, type BartReasoningOptions } from './reasoning-geometry'

/** React owns the source and circle. Stream updates only remeasure the text;
 * the current Worker eye track and compositor body track finish uninterrupted. */
export function useBartReasoning(
  stage: RefObject<HTMLElement | null>, dock: RefObject<HTMLElement | null>,
  textValue: string | null, active: boolean, options: BartReasoningOptions
): void {
  const latest = useRef({ active, options })
  latest.current = { active, options }
  const refresh = useRef<(() => void) | undefined>(undefined)
  const hasText = Boolean(textValue)
  useLayoutEffect(() => {
    const element = stage.current
    // A child layout effect can run before the ancestor ref is attached on
    // first mount; its DOM ancestor is already present at that point.
    const root = dock.current ?? element?.closest<HTMLElement>('.bart-dock')
    const arc = element?.querySelector<SVGSVGElement>('.bart-role-arc')
    const path = arc?.querySelector('path')
    const text = arc?.querySelector('text')
    const textPath = arc?.querySelector('textPath')
    if (!hasText || !element || !root || !arc || !path || !text || !textPath ||
      typeof path.getTotalLength !== 'function' || typeof text.getComputedTextLength !== 'function') return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const presentation = createStreamPresentation(arc, text, textPath)
    const body = root.querySelector<HTMLElement>('.bart-dock-reasoning-motion')
    const logo = root.querySelector<SVGSVGElement>('.bart-logo')
    let eye: ReturnType<typeof animateBartEyes> | undefined
    let bodyAnimations: Animation[] = []
    let timer: number | undefined
    let disposed = false, playing = false, cycle = 0
    let start = 0, end = 0, shape = ''

    const stop = (): void => {
      window.clearTimeout(timer)
      eye?.cancel()
      eye = undefined
      bodyAnimations.forEach(animation => animation.cancel())
      bodyAnimations = []
      playing = false
      cycle = 0
    }
    const sweep = (): void => {
      if (disposed || !arc.isConnected) return
      const from = start, to = end
      const track = readingGaze(progress => {
        const target = path.getPointAtLength(from + (to - from) * progress)
        return {
          x: (target.x - REASONING_CENTER.x) / REASONING_RADIUS * 78,
          y: 30 + (target.y - REASONING_CENTER.y) / REASONING_RADIUS * 70
        }
      }, cycle)
      eye = animateBartEyes(root, track.frames, track.duration)
      if (body?.animate && element.animate) {
        const motion = readingBody(track, cycle)
        bodyAnimations.forEach(animation => animation.cancel())
        const timing: KeyframeAnimationOptions = { duration: track.duration, fill: 'forwards', easing: 'linear' }
        bodyAnimations = [body.animate(motion.bodyFrames, timing), element.animate(motion.circleFrames, timing)]
      }
      cycle++
      timer = window.setTimeout(sweep, track.duration)
    }
    const update = (): void => {
      const { active, options } = latest.current
      const nextShape = `${options.length}:${options.tilt}`
      if (shape !== nextShape) { stop(); shape = nextShape }
      const length = path.getTotalLength(), width = text.getComputedTextLength()
      start = (length - Math.min(length, width)) / 2
      end = (length + Math.min(length, width)) / 2
      textPath.setAttribute('startOffset', String(end))
      const moving = active && !document.hidden && !reduced?.matches
      presentation.update(moving ? options.stream : 'direct', end, width, length)
      // Fallback SVG eyes belong to the decoration, not the body wrapper.
      // Keep the whole pose still until the Worker can carry both together.
      if (!moving || !options.gaze || logo?.getAttribute('data-worker-ready') !== 'true') { stop(); return }
      if (!playing) { playing = true; sweep() }
    }
    refresh.current = update
    // Readiness can change without a text update (including Worker failure).
    // Observe only this lifecycle signal, never text or animation writes.
    const readiness = new MutationObserver(update)
    if (logo) readiness.observe(logo, { attributes: true, attributeFilter: ['data-worker-ready'] })
    reduced?.addEventListener('change', update)
    document.addEventListener('visibilitychange', update)
    void document.fonts?.ready.then(() => { if (!disposed) update() })
    update()
    return () => {
      disposed = true
      refresh.current = undefined
      readiness.disconnect()
      reduced?.removeEventListener('change', update)
      document.removeEventListener('visibilitychange', update)
      stop()
      presentation.dispose()
    }
  }, [stage, dock, hasText])
  useLayoutEffect(() => { refresh.current?.() }, [textValue, active, options.length, options.tilt, options.gaze, options.stream])
}
