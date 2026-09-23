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
  const base = characterViewBox(description.layout)
  const [x, y, w, h] = description.viewport ?? base
  const scale = Math.min(width / base[2], height / base[3])
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
    const failed = (): void => { if (current) { svg.removeAttribute('data-worker-ready'); svg.removeAttribute('data-resident-ready') } }
    const measuredSize = (): { width: number; height: number } => {
      const rect = output.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : dimensions.current
    }
    const measured = measuredSize()
    const renderer = createMotionSurface(output, measured.width, measured.height, 'character', failed)
    surface.current = renderer
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const configuration = (): CharacterDescription => ({ ...latest.current, eyeMotion: eyeMotion.current,
      resident: latest.current.resident ? { ...latest.current.resident, reducedMotion: reduced?.matches } : undefined,
      animate: latest.current.animate !== false && !((latest.current.resident || latest.current.role === 'running') && reduced?.matches) })
    let configured = renderer.ready
    let version = 0
    const update = (): void => {
      const revision = ++version
      try {
        const size = measuredSize()
        renderer.resize(size.width, size.height)
        const config = configuration()
        configured = renderer.character(config)
        void configured
          .then(() => {
            if (!current || revision !== version) return
            svg.setAttribute('data-worker-ready', 'true')
            if (config.resident && (config.layout ?? 'mark') === 'mark') svg.setAttribute('data-resident-ready', 'true')
            else svg.removeAttribute('data-resident-ready')
          }, failed)
      } catch { failed() }
    }
    const eyeController = (motion: CharacterDescription['eyeMotion']): void => {
      if (!current || !motion || (motion.duration === 0 && eyeMotion.current?.key !== motion.key)) return
      eyeMotion.current = motion.duration === 0 ? undefined : motion
      update()
    }
    eyeControllers.set(svg, eyeController)
    const character = { id: renderer.id, ready: () => configured,
      description: configuration }
    characters.set(svg, character)
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    resize?.observe(svg)
    reduced?.addEventListener('change', update)
    refresh.current = update
    return () => {
      current = false
      if (eyeControllers.get(svg) === eyeController) eyeControllers.delete(svg)
      if (characters.get(svg) === character) characters.delete(svg)
      reduced?.removeEventListener('change', update)
      resize?.disconnect()
      renderer.dispose()
      if (surface.current === renderer) surface.current = null
      if (refresh.current === update) refresh.current = undefined
      svg.removeAttribute('data-worker-ready')
      svg.removeAttribute('data-resident-ready')
      // Restore React's node before it reconciles or re-runs the effect.
      output.replaceWith(element)
      canvas.current = element
    }
  }, [])
  useLayoutEffect(() => {
    refresh.current?.()
  }, [width, height, description.activity, description.phase, description.key, description.layout,
    description.role, description.resident, description.animate, description.launch, description.viewport])
  return <foreignObject className="bart-worker-character" x={x} y={y} width={w} height={h} pointerEvents="none">
    <canvas ref={canvas} style={{ display: 'block', width: '100%', height: '100%' }} />
  </foreignObject>
}
