import { useEffect, useRef, useState } from 'react'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { createCanvasCharacter } from '../../../src/renderer/src/bart-motion/character-canvas'
import { gestureStudy, sampleWritingGesture, writingGestures, writingTrailStyle, type WritingGesture } from './writing-gestures'

function GestureStudy({ gesture, paused, replay, punctuationPauses }: {
  gesture: WritingGesture; paused: boolean; replay: number; punctuationPauses: boolean
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelRef = useRef<HTMLOutputElement>(null)
  const elapsedRef = useRef(0)
  useEffect(() => { elapsedRef.current = 0 }, [replay])
  useEffect(() => {
    if (paused) return
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const texture = new OffscreenCanvas(256, 256), paint = texture.getContext('2d')!
    const character = createCanvasCharacter({ activity: 'idle', phase: 'idle' })
    let frame = 0, previous = performance.now()
    const draw = (now: number): void => {
      elapsedRef.current += Math.min(64, now - previous)
      previous = now
      const elapsed = elapsedRef.current, input = gestureStudy(elapsed, punctuationPauses)
      const pose = sampleWritingGesture(gesture, input)
      const trailStyle = writingTrailStyle(gesture)
      character.update({ activity: 'idle', phase: 'idle', eyeMotion: { key: 0, duration: 1,
        points: [{ at: 0, x: pose.eyeX, y: pose.eyeY, scaleX: 1 / pose.sx, scaleY: 1 / pose.sy }] },
        travelTrail: trailStyle ? { key: 0, duration: Number.MAX_SAFE_INTEGER, style: trailStyle,
          points: [{ at: 0, direction: input.direction, strength: pose.trailStrength }] } : undefined })
      const width = canvas.clientWidth, height = canvas.clientHeight, ratio = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio)
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height)
      paint.clearRect(0, 0, 256, 256)
      character.paint(paint, now, 256, 256)
      for (const [x, diameter] of [[width * .35, 54], [width * .84, 18]]) {
        const scale = diameter / 18, size = diameter * 640 / 328
        ctx.save(); ctx.translate(x + pose.x * scale, height / 2 + pose.y * scale)
        ctx.rotate(pose.angle); ctx.scale(pose.sx, pose.sy)
        ctx.drawImage(texture, -size / 2, -size / 2, size, size); ctx.restore()
      }
      if (labelRef.current) labelRef.current.textContent = input.label
      frame = requestAnimationFrame(draw)
    }
    draw(previous)
    return () => cancelAnimationFrame(frame)
  }, [gesture, paused, replay, punctuationPauses])
  return <>
    <canvas ref={canvasRef} className="genlab-gesture-canvas" aria-hidden="true" />
    <span className="genlab-gesture-scale"><span>放大 3×</span><span>原尺寸 18px</span></span>
    <output ref={labelRef} className="genlab-gesture-phase" />
  </>
}

export function WritingCandidates({ selected, disabled, punctuationPauses, onSelect }: {
  selected: WritingGesture; disabled: boolean; punctuationPauses: boolean; onSelect(value: WritingGesture): void
}): React.JSX.Element {
  const [paused, setPaused] = useState(false), [replay, setReplay] = useState(0)
  return <section className="genlab-candidates" aria-label="Bart 动作候选">
    <header><div><h2>冲刺的细节</h2><p>克制的形变，轻巧的外部掠影。选择后在卡片中比较。</p></div>
      <nav aria-label="候选动作控制">
        <button disabled={disabled} onClick={() => setPaused(value => !value)} aria-label={paused ? '继续候选动作' : '暂停候选动作'}>
          {paused ? <Play size={14} /> : <Pause size={14} />}</button>
        <button disabled={disabled} onClick={() => { setReplay(value => value + 1); setPaused(false) }} aria-label="重播候选动作"><RotateCcw size={14} /></button>
      </nav>
    </header>
    <div className="genlab-candidate-list">{writingGestures.map(item => <button key={item.id}
      className="genlab-candidate" aria-label={`${item.letter} ${item.name}`} aria-pressed={selected === item.id}
      disabled={disabled} onClick={() => onSelect(item.id)}>
      <span className="genlab-candidate-title"><b>{item.letter} · {item.name}</b><small>{selected === item.id ? '已选' : item.character}</small></span>
      <GestureStudy gesture={item.id} paused={paused || disabled} replay={replay} punctuationPauses={punctuationPauses} />
      <span className="genlab-candidate-summary">{item.summary}</span>
    </button>)}</div>
  </section>
}
