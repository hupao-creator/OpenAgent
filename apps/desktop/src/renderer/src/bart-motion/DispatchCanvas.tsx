import { useLayoutEffect, useRef } from 'react'
import { createMotionSurface } from './worker-client'
import type { DispatchDescription } from './dispatch-canvas'

export function DispatchCanvas({ description }: { description: DispatchDescription }): React.JSX.Element {
  const host = useRef<HTMLSpanElement>(null), latest = useRef(description)
  const update = useRef<(() => void) | null>(null)
  latest.current = description
  useLayoutEffect(() => {
    const container = host.current!, map = container.parentElement!
    const canvas = document.createElement('canvas')
    if (typeof Worker === 'undefined' || !canvas.transferControlToOffscreen) return
    canvas.style.cssText = 'width:100%;height:100%;display:block'
    container.append(canvas)
    let alive = true, signature = '', surface: ReturnType<typeof createMotionSurface> | undefined
    const failed = (): void => { if (alive) map.removeAttribute('data-dispatch-worker') }
    const refresh = (): void => {
      if (!container.clientWidth || !container.clientHeight) return
      const nextSignature = JSON.stringify([latest.current, container.clientWidth, container.clientHeight])
      if (signature === nextSignature) return
      signature = nextSignature
      try {
        surface ??= createMotionSurface(canvas, container.clientWidth, container.clientHeight, 'character', failed)
        surface.resize(container.clientWidth, container.clientHeight)
        void surface.dispatch(latest.current).then(() => { if (alive) map.setAttribute('data-dispatch-worker', 'true') }, failed)
      } catch { failed() }
    }
    update.current = refresh
    const resize = new ResizeObserver(refresh)
    resize.observe(container)
    refresh()
    return () => { alive = false; resize.disconnect(); update.current = null
      surface?.dispose(); canvas.remove(); map.removeAttribute('data-dispatch-worker') }
  }, [])
  useLayoutEffect(() => update.current?.(), [description])
  return <span className="harness-dispatch-canvas" ref={host} aria-hidden="true" />
}
