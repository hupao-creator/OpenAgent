import { useEffect, useLayoutEffect, useRef } from 'react'
import { createCanvasCharacter } from '../../../src/renderer/src/bart-motion/character-canvas'
import type { LabConfig } from './scenarios'
import { sampleRunningStory } from '../../../src/renderer/src/bart-motion/running-story'
import './running.css'

/** The original production face, following one shared light-and-gaze story. */
export function RunningPreview({ config }: { config: LabConfig }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dotsRef = useRef<HTMLSpanElement>(null)
  const stageRef = useRef<HTMLOutputElement>(null)
  const latest = useRef(config)
  const redraw = useRef<() => void>(() => {})
  useLayoutEffect(() => { latest.current = config; redraw.current() }, [config])
  useEffect(() => {
    const canvas = canvasRef.current!, ctx = canvas.getContext('2d')!
    const texture = new OffscreenCanvas(420, 420), paint = texture.getContext('2d')!
    const character = createCanvasCharacter({ activity: 'idle', phase: 'running' })
    const dots = Array.from(dotsRef.current!.children) as HTMLElement[]
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0, previous = 0, elapsed = 0
    let paintedState: string | undefined
    const active = (): boolean => !latest.current.runningPaused && !document.hidden && !reduced.matches
    const draw = (now: number): void => {
      frame = 0
      const current = latest.current
      const delta = previous && active() ? Math.min(64, now - previous) : 0
      previous = now
      // Idle comparison holds the story, so returning to running continues it.
      if (!current.runningIdle) elapsed += delta / (current.runningCycle * 1000)
      const story = sampleRunningStory(elapsed, reduced.matches || current.runningIdle)
      const width = canvas.clientWidth, height = canvas.clientHeight, ratio = devicePixelRatio || 1
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio)
      }
      const paintState = `${current.runningIdle}:${reduced.matches}`
      // A resize or inspector refresh redraws the cached texture while paused.
      // Advancing the native blink clock here would change a frozen expression.
      if (active() || paintedState !== paintState) {
        character.update({ activity: 'idle', phase: current.runningIdle ? 'idle' : 'running',
          animate: !reduced.matches && !current.runningPaused,
          eyeMotion: { key: 0, duration: 1, points: [{ at: 0, ...story.eyes }] } })
        paint.clearRect(0, 0, 420, 420)
        character.paint(paint, now, 420, 420)
        paintedState = paintState
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height)
      ctx.drawImage(texture, 0, 0, width, height)
      dots.forEach((dot, index) => {
        const point = story.dots[index]
        dot.style.opacity = String(point.opacity)
        dot.style.backgroundColor = point.color
        dot.style.transform = `translate(${point.x * 210 / 640 - 3.5}px, ${point.y * 210 / 640 - 3.5}px)`
      })
      const label = current.runningIdle ? '待机对照' : story.stage
      if (stageRef.current && stageRef.current.textContent !== label) stageRef.current.textContent = label
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
  return <main className="app-shell bart-preview running-preview" data-guides={config.guides} data-idle={config.runningIdle}>
    <div className="cadence-source">{config.runningIdle ? null : <span>运行中 · </span>}<output ref={stageRef} aria-live="off">三拍接力</output></div>
    <div className="running-character">
      <canvas ref={canvasRef} role="img" aria-label={config.runningIdle ? '待机的 Bart' : 'Bart 看着彩虹光点绕行并回到底部'} />
      <span className="running-dots" ref={dotsRef} aria-hidden="true"><i /><i /><i /></span>
    </div>
  </main>
}
