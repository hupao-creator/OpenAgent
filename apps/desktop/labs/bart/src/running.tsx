import { useEffect, useLayoutEffect, useRef } from 'react'
import { createCanvasCharacter } from '../../../src/renderer/src/bart-motion/character-canvas'
import { EYE_COLOR } from '../../../src/renderer/src/bart-motion/character-model'
import type { LabConfig } from './scenarios'
import { runningFaces, sampleRunningFace, type FacePoint } from './running-faces'
import { RunningBottomPreview } from './running-bottom'
import './running.css'

export function RunningPreview({ config }: { config: LabConfig }): React.JSX.Element {
  return config.variant === 'bottom' ? <RunningBottomPreview config={config} /> : <RunningFacePreview config={config} />
}

/** Lab-only face study on the production silhouette and spring-eye renderer. */
function RunningFacePreview({ config }: { config: LabConfig }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const latest = useRef(config)
  const redraw = useRef<() => void>(() => {})
  useLayoutEffect(() => { latest.current = config; redraw.current() }, [config])
  useEffect(() => {
    const canvas = canvasRef.current!, ctx = canvas.getContext('2d')!
    const texture = new OffscreenCanvas(420, 420), paint = texture.getContext('2d')!
    const character = createCanvasCharacter({ activity: 'start', phase: 'running' })
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0, previous = 0, phase = 0
    let face = latest.current.runningIdle ? 0 : 1
    let points = sampleRunningFace(latest.current.variant, phase, reduced.matches)
    const active = (): boolean => !latest.current.runningPaused && !document.hidden && !reduced.matches
    const draw = (now: number): void => {
      frame = 0
      const current = latest.current
      const delta = previous && active() ? Math.min(64, now - previous) : 0
      previous = now
      phase = (phase + delta / (current.runningCycle * 1000)) % 1
      const target = current.runningIdle ? 0 : 1
      face = active() ? face + (target - face) * (1 - Math.exp(-delta / 75)) : target
      if (Math.abs(target - face) < .001) face = target
      const targetPoints = sampleRunningFace(current.variant, phase, reduced.matches)
      if (!active()) points = targetPoints
      else {
        const blend = 1 - Math.exp(-delta / 45)
        points.forEach((point, index) => {
          for (const key of Object.keys(point) as (keyof FacePoint)[]) {
            point[key] += (targetPoints[index][key] - point[key]) * blend
          }
        })
      }
      // Scaling the native eyes to zero lets the same renderer retain Bart's
      // body and idle expression, without changing production descriptors.
      character.update({ activity: current.runningIdle ? 'idle' : 'start',
        phase: current.runningIdle ? 'idle' : 'running',
        animate: !((reduced.matches || current.runningPaused) && current.runningIdle),
        eyeMotion: { key: 0, duration: 1, points: [{ at: 0, x: 0, y: 0,
          scaleX: 1 - face, scaleY: 1 - face }] } })
      const width = canvas.clientWidth, height = canvas.clientHeight, ratio = devicePixelRatio || 1
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio)
      }
      paint.clearRect(0, 0, 420, 420)
      character.paint(paint, now, 420, 420)
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height)
      ctx.drawImage(texture, 0, 0, width, height)
      ctx.scale(width / 640, height / 640)
      ctx.fillStyle = EYE_COLOR
      for (const point of points) {
        ctx.globalAlpha = face * point.opacity
        ctx.beginPath()
        ctx.ellipse(point.x, point.y, point.rx * face, point.ry * face, 0, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
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
  return <main className="app-shell bart-preview running-preview" data-guides={config.guides}
    data-variant={config.variant} data-idle={config.runningIdle}>
    <div className="cadence-source" role="status">
      <span>{config.runningIdle ? '待机对照' : '任务运行中 · 暂无具体活动'}</span>
    </div>
    <div className="running-character">
      <canvas ref={canvasRef} role="img" aria-label={config.runningIdle ? '待机的 Bart' : `Bart · ${runningFaces.find(item => item.id === config.variant)?.label}`} />
    </div>
  </main>
}
