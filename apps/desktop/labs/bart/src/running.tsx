import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { BartLogo } from '../../../src/renderer/src/components/BartLogo'
import type { LabConfig } from './scenarios'
import './running.css'

/** Lab-only signals around the production character; no new execution semantics. */
export function RunningPreview({ config }: { config: LabConfig }): React.JSX.Element {
  const character = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<CSSProperties>()
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  useLayoutEffect(() => {
    const svg = character.current?.querySelector('svg.bart-logo')
    const body = svg?.querySelector<SVGGraphicsElement>('.bart-bot > path')
    if (!(svg instanceof SVGSVGElement) || !body) return
    // Measure the character's stable SVG fallback, not an animated screen rect.
    // The decoration inherits the same carrier size as the production Worker.
    const box = body.getBBox(), view = svg.viewBox.baseVal
    setAnchor({
      left: `${(box.x - view.x) / view.width * 100}%`,
      top: `${(box.y - view.y) / view.height * 100}%`,
      width: `${box.width / view.width * 100}%`,
      height: `${box.height / view.height * 100}%`
    })
  }, [])
  return <main className="app-shell bart-preview running-preview" data-guides={config.guides}
    data-variant={config.variant} data-idle={config.runningIdle} data-paused={config.runningPaused || !visible}
    style={{ '--running-cycle': `${config.runningCycle}s` } as CSSProperties}>
    <div className="cadence-source" role="status">
      <span>{config.runningIdle ? '待机对照' : '任务运行中 · 暂无具体活动'}</span>
    </div>
    <div className="running-character" ref={character}>
      <div className="running-body-motion">
        <BartLogo size={210} layout="mark" resolvedActivity="idle"
          resolvedPhase={config.runningIdle ? 'idle' : 'running'} />
      </div>
      {anchor ? <div className="running-decoration" style={anchor} aria-hidden="true">
        <span className="running-halo" />
        <span className="running-orbit" />
        <span className="running-dots"><i /><i /><i /></span>
      </div> : null}
    </div>
  </main>
}
