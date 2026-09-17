import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { BartLogo } from '../../../src/renderer/src/components/BartLogo'

export function MessageIsolation() {
  const [pulse, setPulse] = useState<'a' | 'b'>('a')
  const negative = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let frame = 0
    const context = negative.current!.getContext('2d')!
    const draw = (now: number): void => { context.clearRect(0, 0, 160, 36); context.fillStyle = '#d35637'
      context.fillRect(now / 3 % 135, 6, 25, 24); frame = requestAnimationFrame(draw) }
    frame = requestAnimationFrame(draw)
    Object.assign(window, { bartMessage: {
      start() { flushSync(() => setPulse(value => value === 'a' ? 'b' : 'a')); return performance.timeOrigin + performance.now() },
      block(ms: number) { const start = performance.now(); while (performance.now() - start < ms) { /* Real Renderer block. */ } }
    } })
    return () => cancelAnimationFrame(frame)
  }, [])
  return <div className="isolation" style={{ display: 'grid', placeContent: 'center' }}>
    <BartLogo width={620} height={320} layout="message" message="已有文字也应持续显露。主线程阻塞时继续前进。" messagePulse={pulse} />
    <canvas ref={negative} width={160} height={36} style={{ position: 'absolute', left: 70, top: 440 }} />
  </div>
}
