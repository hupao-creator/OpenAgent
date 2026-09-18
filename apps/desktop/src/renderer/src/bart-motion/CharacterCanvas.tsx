import { useLayoutEffect, useRef } from 'react'
import { createMotionSurface } from './worker-client'
import type { CharacterDescription } from './worker-types'

const eyeControllers = new WeakMap<Element, (motion: CharacterDescription['eyeMotion']) => void>()
const characters = new WeakMap<Element, { id: string; ready(): Promise<void>; description(): CharacterDescription }>()
export function residentCharacter(element: Element) { return characters.get(element) }
let eyeSequence = 0
/** Existing coordinator choreography supplies one prepared eye track. */
export function animateBartEyes(root: Element | null, frames: readonly Keyframe[], duration: number): { cancel(): void } {
  const svg = root?.matches('.bart-logo') ? root : root?.querySelector('.bart-logo')
  const controller = svg ? eyeControllers.get(svg) : undefined
  const key = ++eyeSequence
  const points = frames.map(frame => {
    const values = String(frame.transform).match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [0, 0]
    return { at: Number(frame.offset) * duration, x: values[0], y: values[1] ?? 0 }
  })
  controller?.({ key, duration, points })
  return { cancel: () => controller?.({ key, duration: 0, points: [] }) }
}

export function characterViewBox(layout: CharacterDescription['layout']): readonly [number, number, number, number] {
  return layout === 'permission' ? [20, 110, 760, 380] : layout === 'question' ? [20, 50, 760, 500]
    : layout && layout !== 'mark' ? [20, 100, 780, 400] : [0, 0, 640, 640]
}

/** The SVG retains layout, semantic metadata and a static fallback. Only this surface draws frames. */
export function CharacterCanvas({ width, height, description }: {
  width: number; height: number; description: CharacterDescription
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const surface = useRef<ReturnType<typeof createMotionSurface> | null>(null)
  const refresh = useRef<(() => void) | undefined>(undefined)
  const latest = useRef(description)
  const eyeMotion = useRef<CharacterDescription['eyeMotion']>(undefined)
  latest.current = description
  const [x, y, w, h] = characterViewBox(description.layout)
  const scale = Math.min(width / w, height / h)
  const dimensions = useRef({ width: w * scale, height: h * scale })
  dimensions.current = { width: w * scale, height: h * scale }
  useLayoutEffect(() => {
    const element = canvas.current!, svg = element.closest('svg')!
    if (typeof Worker === 'undefined' || typeof element.transferControlToOffscreen !== 'function') return
    // React StrictMode remounts effects on the same element; transfer ownership
    // exactly once by giving each effect lifetime its own DOM canvas.
    const output = document.createElement('canvas')
    output.style.cssText = 'display:block;width:100%;height:100%'
    element.replaceWith(output)
    canvas.current = output
    let current = true
    const failed = (): void => { if (current) svg.removeAttribute('data-worker-ready') }
    const measuredSize = (): { width: number; height: number } => {
      const rect = output.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : dimensions.current
    }
    const measured = measuredSize()
    const renderer = createMotionSurface(output, measured.width, measured.height, 'character', failed)
    surface.current = renderer
    let configured = renderer.ready
    let configureVersion = 0
    let appearance = ''
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const update = (): void => {
      const version = ++configureVersion
      const nextAppearance = JSON.stringify([latest.current.bodyMaterial, latest.current.bodyColor, latest.current.eyeColor])
      if (appearance !== nextAppearance) {
        // Never expose an old body-free Worker frame after a glass failure.
        svg.removeAttribute('data-worker-ready')
        appearance = nextAppearance
      }
      try {
        const size = measuredSize()
        renderer.resize(size.width, size.height)
        configured = renderer.character({ ...latest.current, eyeMotion: eyeMotion.current, animate: latest.current.animate !== false && !media?.matches })
        void configured
          .then(() => { if (current && version === configureVersion) svg.setAttribute('data-worker-ready', 'true') },
            () => { if (version === configureVersion) failed() })
      } catch { failed() }
    }
    const eyeController = (motion: CharacterDescription['eyeMotion']): void => {
      if (!current || !motion || (motion.duration === 0 && eyeMotion.current?.key !== motion.key)) return
      eyeMotion.current = motion.duration === 0 ? undefined : motion
      update()
    }
    eyeControllers.set(svg, eyeController)
    const character = { id: renderer.id, ready: () => configured,
      // Scene flights have no resident glass stage. Carry colours/identity, but
      // not the resident-only permission to omit the body. Landing restores it.
      description: () => ({ ...latest.current, bodyMaterial: 'solid' as const, eyeMotion: eyeMotion.current, animate: latest.current.animate !== false && !media?.matches }) }
    characters.set(svg, character)
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    resize?.observe(svg)
    media?.addEventListener('change', update)
    refresh.current = update
    return () => {
      current = false
      if (eyeControllers.get(svg) === eyeController) eyeControllers.delete(svg)
      if (characters.get(svg) === character) characters.delete(svg)
      media?.removeEventListener('change', update)
      resize?.disconnect()
      renderer.dispose()
      if (surface.current === renderer) surface.current = null
      if (refresh.current === update) refresh.current = undefined
      svg.removeAttribute('data-worker-ready')
      // Restore React's node before it reconciles or re-runs the effect.
      output.replaceWith(element)
      canvas.current = element
    }
  }, [])
  useLayoutEffect(() => {
    refresh.current?.()
  }, [width, height, description.activity, description.phase, description.key, description.layout,
    description.intervention, description.role, description.animate, description.bodyMaterial, description.bodyColor, description.eyeColor])
  return <foreignObject className="bart-worker-character" x={x} y={y} width={w} height={h} pointerEvents="none">
    <canvas ref={canvas} style={{ display: 'block', width: '100%', height: '100%' }} />
  </foreignObject>
}
