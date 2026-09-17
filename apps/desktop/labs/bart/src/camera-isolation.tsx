import { useEffect, useRef } from 'react'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { BartTransitionPlayground } from '../../../playgrounds/bart-thread-transition/src/BartTransitionPlayground'
import { inspectMotionRuntime } from '../../../src/renderer/src/bart-motion/worker-client'
import '../../../playgrounds/bart-thread-transition/src/transitions.css'
import '../../../playgrounds/bart-thread-transition/src/playground.css'

/** Uses the real overview, Bart thread and the same production eye-dive hook. */
export function CameraIsolation() {
  const negative = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let frame = 0
    const context = negative.current!.getContext('2d')!
    const draw = (now: number): void => {
      context.clearRect(0, 0, 160, 36); context.fillStyle = '#d35637'; context.fillRect(now / 3 % 135, 6, 25, 24)
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    Object.assign(window, { bartCamera: {
      fly(inside: boolean) {
        performance.clearMarks('bart-camera-ready'); performance.clearMarks('bart-camera-handoff')
        const buttons = [...document.querySelectorAll<HTMLButtonElement>('.pg-actions button')]
        buttons[inside ? 0 : 1]!.click()
      },
      block(ms: number) { const from = performance.now(); while (performance.now() - from < ms) { /* Real Renderer block. */ } },
      inspect: inspectMotionRuntime,
      status() {
        const stage = document.querySelector('.pg-stage')!
        const inside = stage.hasAttribute('data-camera-inside')
        const native = stage.querySelector<HTMLElement>(inside ? '[data-bart-camera-session]' : '[data-bart-camera-overview]')!
        return { ready: (performance.getEntriesByName('bart-camera-ready').at(-1) as PerformanceMark | undefined)?.detail,
          handoff: (performance.getEntriesByName('bart-camera-handoff').at(-1) as PerformanceMark | undefined)?.detail,
          active: stage.hasAttribute('data-camera-active'), inside, sealed: stage.hasAttribute('data-bart-scene'),
          inert: native.inert, visibility: getComputedStyle(native).visibility, opacity: getComputedStyle(native).opacity,
          content: native.textContent?.slice(0, 180), error: document.querySelector('.pg-notice[role="alert"]')?.textContent }
      }
    } })
    return () => cancelAnimationFrame(frame)
  }, [])
  return <RendererCapabilitiesProvider capabilities={{}}>
    <style>{`.pg-panel { display: none; }`}</style>
    <BartTransitionPlayground />
    <canvas ref={negative} width="160" height="36" style={{ position: 'fixed', left: 10, top: 5, zIndex: 100000, background: '#fff' }} />
  </RendererCapabilitiesProvider>
}
