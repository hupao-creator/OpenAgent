import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowLeft, ArrowRight, Check, Pause, Play, RotateCcw, Shuffle } from 'lucide-react'
import { BasicTransitionStudy, roles, roleLabel, type Role } from './transition-model'
import { TransitionStudy } from './transition-choreography'
import { paintStudy } from './transition-painter'
import '@fontsource-variable/inter'
import './styles.css'
import './transitions.css'

interface Settings { duration: number; speed: number; paused: boolean; compare: boolean }
interface Cue { role: Role; after: number }
const sequence: Cue[] = [
  { role: 'idle', after: 0 }, { role: 'running', after: 1200 }, { role: 'reasoning', after: 4700 },
  { role: 'tool', after: 3700 }, { role: 'reasoning', after: 1900 }, { role: 'running', after: 2300 },
  { role: 'reply', after: 1700 }, { role: 'idle', after: 2400 }
]

function App(): React.JSX.Element {
  const [role, setRole] = useState<Role>('idle')
  const [from, setFrom] = useState<Role>('idle')
  const [settings, setSettings] = useState<Settings>({ duration: 550, speed: 1, paused: false, compare: false })
  const [playing, setPlaying] = useState(false)
  const [reduced, setReduced] = useState(false)
  const stage = useRef<HTMLCanvasElement>(null), hard = useRef<HTMLCanvasElement>(null), small = useRef<HTMLCanvasElement>(null)
  const progress = useRef<HTMLDivElement>(null), phase = useRef<HTMLOutputElement>(null)
  const scrub = useRef<HTMLInputElement>(null)
  const engine = useRef(new TransitionStudy())
  const baseline = useRef(new BasicTransitionStudy())
  const clock = useRef(0), latest = useRef(settings), still = useRef(false)
  const playlist = useRef<Array<{ role: Role; at: number }>>([])
  const previousPair = useRef<[Role, Role]>(['idle', 'reasoning'])
  const repaint = useRef<() => void>(() => {})
  const command = useRef<(next: Role) => void>(() => {})
  latest.current = settings

  const select = (next: Role): void => {
    const old = engine.current.role
    if (old === next) return
    if (old !== next) previousPair.current = [old, next]
    setFrom(old); setRole(next)
    engine.current.redirect(next, clock.current, still.current ? 0 : latest.current.duration)
    baseline.current.redirect(next, clock.current, still.current ? 0 : latest.current.duration)
    repaint.current()
  }
  command.current = select
  const stop = (): void => { playlist.current = []; setPlaying(false) }
  const run = (cues: Cue[]): void => {
    let time = clock.current
    playlist.current = cues.map(cue => { time += cue.after; return { role: cue.role, at: time } })
    setSettings(current => ({ ...current, paused: false })); setPlaying(true)
  }
  const replay = (): void => {
    const [source, destination] = previousPair.current
    run([{ role: source, after: 0 }, { role: destination, after: latest.current.duration + 800 }])
  }
  const interrupt = (): void => run([
    { role: 'reasoning', after: 0 }, { role: 'tool', after: 1200 },
    { role: 'running', after: settings.duration * .35 }, { role: 'reasoning', after: settings.duration * .35 },
    { role: 'idle', after: settings.duration * .45 }
  ])

  useEffect(() => {
    let frame = 0, previous = performance.now()
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const draw = (): void => {
      const time = clock.current, appearance = engine.current.sample(time)
      if (stage.current) paintStudy(stage.current, appearance, time, still.current)
      if (small.current) paintStudy(small.current, appearance, time, still.current)
      if (hard.current && latest.current.compare) paintStudy(hard.current,
        { ...baseline.current.sample(time), arcGather: 0, arcReveal: 1, toolReveal: 1, toolX: 271 }, time, still.current)
      const p = engine.current.progress(time)
      if (progress.current) progress.current.style.transform = `scaleX(${p})`
      if (scrub.current) scrub.current.value = String(Math.round(p * 1000))
      if (phase.current) phase.current.textContent = latest.current.paused ? '已暂停' : engine.current.beat(time)
    }
    const tick = (now: number): void => {
      if (!latest.current.paused && !document.hidden && !still.current) clock.current += Math.min(64, now - previous) * latest.current.speed
      previous = now
      while (playlist.current[0] && playlist.current[0].at <= clock.current) {
        const next = playlist.current.shift()!
        command.current(next.role)
        if (!playlist.current.length) setPlaying(false)
      }
      draw()
      if (!document.hidden && !still.current) frame = requestAnimationFrame(tick)
    }
    const refresh = (): void => {
      cancelAnimationFrame(frame); previous = performance.now()
      if (!document.hidden) tick(previous)
    }
    const preference = (): void => {
      still.current = media.matches; setReduced(media.matches)
      if (media.matches) {
        playlist.current = []; setPlaying(false)
        engine.current.redirect(engine.current.role, clock.current, 0)
        baseline.current.redirect(baseline.current.role, clock.current, 0)
      }
      refresh()
    }
    repaint.current = draw
    const resize = new ResizeObserver(draw)
    for (const canvas of [stage.current, small.current, hard.current]) if (canvas) resize.observe(canvas)
    media.addEventListener('change', preference)
    document.addEventListener('visibilitychange', refresh)
    preference()
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); repaint.current = () => {}
      media.removeEventListener('change', preference); document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  useEffect(() => { repaint.current() }, [settings])

  return <div className="transition-lab">
    <header className="lab-header">
      <a className="lab-brand" href="./">Bart<span>Lab</span><i /></a>
      <span className="transition-breadcrumb">角色实验室 <span>/</span> 状态过渡</span>
      <a className="back-link" href="./"><ArrowLeft size={13} /> 全部实验</a>
    </header>
    <main className="transition-workspace">
      <aside className="transition-nav">
        <span className="eyebrow">TRANSITIONS / 01</span><h1>状态之间</h1>
        <p>点选下一个状态，<br />也可以在过渡途中再次切换。</p>
        <div className="transition-states" role="group" aria-label="目标状态">
          {roles.map(item => <button type="button" key={item.id} aria-pressed={role === item.id}
            onClick={() => { stop(); select(item.id) }}>
            <span className="state-number">{item.number}</span><span><b>{item.label}</b><small>{item.detail}</small></span>
            {role === item.id ? <Check size={14} /> : <ArrowRight size={14} />}
          </button>)}
        </div>
        <div className="sequence-section"><span className="eyebrow">连续观察</span>
          <button className="sequence-button" type="button" disabled={reduced} onClick={() => playing ? stop() : run(sequence)}>
            {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? '停止连播' : '播放完整序列'}
          </button>
          <button className="text-button" type="button" disabled={reduced} onClick={interrupt}><Shuffle size={14} /> 试试连续打断</button>
          <p>待机 → 运行 → 思考 → 工具<br />思考 → 运行 → 答复 → 待机</p>
        </div>
      </aside>

      <section className="transition-canvas" aria-label="过渡预览">
        <header className="transition-canvas-heading">
          <div><span className="eyebrow">{settings.compare ? '同步对照' : '目光先行 · 部件接力'}</span>
            <h2><span>{roleLabel(from)}</span><ArrowRight size={18} />{roleLabel(role)}</h2></div>
          <span className="study-label">STUDY 02</span>
        </header>
        <div className="handoff-demos" role="group" aria-label="组件衔接演示">
          <button type="button" disabled={reduced} onClick={() => run([{ role: 'running', after: 0 }, { role: 'reasoning', after: 4300 }, { role: 'running', after: 2600 }])}>光点 ⇄ 思考链</button>
          <button type="button" disabled={reduced} onClick={() => run([{ role: 'reasoning', after: 0 }, { role: 'tool', after: 1600 }, { role: 'reasoning', after: 1900 }])}>思考链 ⇄ 工具</button>
          <button type="button" disabled={reduced} onClick={() => run([{ role: 'tool', after: 0 }, { role: 'running', after: 1700 }, { role: 'reply', after: 2000 }])}>工具 → 光点 → 答复</button>
        </div>
        <div className={`study-surfaces ${settings.compare ? 'is-comparing' : ''}`}>
          <figure className="smooth-surface"><figcaption>部件接力 <span>{settings.duration} ms</span></figcaption>
            <canvas ref={stage} role="img" aria-label={`自然过渡：${roleLabel(role)}`} /></figure>
          <figure className="hard-surface" hidden={!settings.compare}><figcaption>初版过渡 <span>同时插值</span></figcaption>
            <canvas ref={hard} role="img" aria-label={`初版过渡：${roleLabel(role)}`} /></figure>
        </div>
        <div className="transition-track"><div ref={progress} /><input ref={scrub} aria-label="过渡进度" title="拖动查看过渡的每一刻"
          type="range" min={0} max={1000} defaultValue={1000} onChange={event => {
            stop(); clock.current = engine.current.timeAt(Number(event.target.value) / 1000)
            setSettings(current => ({ ...current, paused: true })); repaint.current()
          }} /></div>
        <footer className="study-footer"><output ref={phase}>已衔接</output>
          <div><button className="icon-button" type="button" disabled={reduced}
            onClick={() => setSettings(current => ({ ...current, paused: !current.paused }))}>
            {settings.paused ? <Play size={14} /> : <Pause size={14} />}{settings.paused ? '继续' : '暂停'}</button>
            <button className="icon-button" type="button" disabled={reduced} onClick={replay}><RotateCcw size={14} /> 重放这次切换</button></div>
        </footer>
      </section>

      <aside className="transition-inspector">
        <span className="eyebrow">节奏</span>
        <section className="control-section"><h2>播放速度</h2>
          <div className="speed-options">{[1, .5, .25].map(speed => <button type="button" key={speed} aria-pressed={settings.speed === speed}
            onClick={() => setSettings(current => ({ ...current, speed }))}>{speed === 1 ? '正常' : `${speed}×`}</button>)}</div>
          <label className="range-control"><span>整段动作<output>{settings.duration} ms</output></span>
            <input type="range" aria-label="过渡时长" min={300} max={900} step={25} value={settings.duration}
              onChange={event => setSettings(current => ({ ...current, duration: Number(event.target.value) }))} /></label>
          <button className="text-button restore-duration" type="button" onClick={() => setSettings(current => ({ ...current, duration: 550, speed: 1 }))}>恢复推荐节奏</button>
        </section>
        <section className="control-section compare-control"><h2>对照</h2>
          <label className="toggle-row"><span>同时看初版</span><input type="checkbox" checked={settings.compare}
            onChange={event => setSettings(current => ({ ...current, compare: event.target.checked }))} /><span className="switch" aria-hidden="true" /></label>
        </section>
        <section className="actual-size"><h2>小尺寸观察</h2><canvas ref={small} role="img" aria-label="小尺寸的 Bart 过渡" /><p>与上方同步播放</p></section>
        <p className="study-note">{reduced ? '已遵循系统的减少动态效果偏好。点选状态可查看静态效果。' : '光点展开成文字，文字收回状态点，再从同一点展开标签。'}</p>
      </aside>
    </main>
    <footer className="lab-footer"><span><i /> BART · TRANSITION STUDY</span><span>与生产共享过渡与绘制</span></footer>
  </div>
}

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
