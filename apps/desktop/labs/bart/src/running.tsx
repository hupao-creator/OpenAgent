import { useEffect, useLayoutEffect, useRef } from 'react'
import { createCanvasCharacter } from '../../../src/renderer/src/bart-motion/character-canvas'
import type { LabConfig } from './scenarios'
import { runningFaces, sampleBottomDots, sampleRunningEyes } from './running-faces'
import { RunningBottomPreview } from './running-bottom'
import './running.css'

export function RunningPreview({ config }: { config: LabConfig }): React.JSX.Element {
  return config.variant === 'bottom' ? <RunningBottomPreview config={config} /> : <RunningEyePreview config={config} />
}

/** Production eyes and silhouette, with a shared Lab clock for gaze and dots. */
function RunningEyePreview({ config }: { config: LabConfig }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dotsRef = useRef<HTMLSpanElement>(null)
  const latest = useRef(config)
  const redraw = useRef<() => void>(() => {})
  useLayoutEffect(() => { latest.current = config; redraw.current() }, [config])
  useEffect(() => {
    const canvas = canvasRef.current!, ctx = canvas.getContext('2d')!
    const texture = new OffscreenCanvas(420, 420), paint = texture.getContext('2d')!
    const character = createCanvasCharacter({ activity: 'start', phase: 'running' })
    const dots = Array.from(dotsRef.current!.children) as HTMLElement[]
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0, previous = 0, phase = 0
    const active = (): boolean => !latest.current.runningPaused && !document.hidden && !reduced.matches
    const draw = (now: number): void => {
      frame = 0
      const current = latest.current
      const delta = previous && active() ? Math.min(64, now - previous) : 0
      previous = now
      phase = (phase + delta / (current.runningCycle * 1000 * .65)) % 1
      const pulses = reduced.matches ? [0, 0, 0] : sampleBottomDots(phase)
      const eyes = current.runningIdle ? { x: 0, y: 0, scaleX: 1, scaleY: 1 }
        : sampleRunningEyes(current.variant, pulses)
      character.update({ activity: current.runningIdle ? 'idle' : 'start',
        phase: current.runningIdle ? 'idle' : 'running',
        animate: !((reduced.matches || current.runningPaused) && current.runningIdle),
        eyeMotion: { key: 0, duration: 1, points: [{ at: 0, ...eyes }] } })
      const width = canvas.clientWidth, height = canvas.clientHeight, ratio = devicePixelRatio || 1
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio)
      }
      paint.clearRect(0, 0, 420, 420)
      character.paint(paint, now, 420, 420)
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height)
      ctx.drawImage(texture, 0, 0, width, height)
      dots.forEach((dot, index) => {
        dot.style.opacity = String(.3 + .7 * pulses[index])
        dot.style.transform = `translateY(${-3 * pulses[index]}px)`
      })
      if (active()) frame = requestAnimationFrame(draw)
    }
    const refresh = (): void => {
      cancelAnimationFrame(frame); previous = 0
      if (!document.hidden) draw(performance.now())
    }
    redraw.current = refresh
    const resize = new ResizeObserver(refresh)
    resize.observe(canvas)
    reduced.addEventListener('change', refresh)
    document.addEventListener('visibilitychange', refresh)
    refresh()
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); redraw.current = () => {}
      reduced.removeEventListener('change', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  return <main className="app-shell bart-preview running-preview running-eyes"
    data-guides={config.guides} data-idle={config.runningIdle}>
    <div className="cadence-source" role="status">
      <span>{config.runningIdle ? '待机对照' : '任务运行中 · 暂无具体活动'}</span>
    </div>
    <div className="running-character">
      <canvas ref={canvasRef} role="img" aria-label={config.runningIdle ? '待机的 Bart' : `Bart · ${runningFaces.find(item => item.id === config.variant)?.label}`} />
      <span className="running-dots" ref={dotsRef} aria-hidden="true"><i /><i /><i /></span>
    </div>
  </main>
}
