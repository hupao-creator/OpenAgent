import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowDownLeft, ArrowUpRight, Check, Maximize2, RotateCcw } from 'lucide-react'
import { initialConfig, reasoningStreamStyles, scenes, variants, type ConfigMessage, type LabConfig, type LabEvent, type PreviewMessage, type Scene } from './scenarios'
import '@fontsource-variable/inter'
import './styles.css'

function App(): React.JSX.Element {
  const [config, setConfig] = useState(initialConfig)
  const [ready, setReady] = useState(false)
  const [fit, setFit] = useState(true)
  const [events, setEvents] = useState<Array<LabEvent & { id: number; time: string }>>([])
  const [bounds, setBounds] = useState({ width: 800, height: 560 })
  const frameRef = useRef<HTMLIFrameElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const configRef = useRef(config)
  configRef.current = config
  const eventId = useRef(0)
  const scene = scenes.find((item) => item.id === config.scene)!
  const variant = variants[config.scene].find(([id]) => id === config.variant)!
  const index = scenes.indexOf(scene)
  const thinking = config.scene === 'resident' && config.variant.startsWith('reasoning')
  const tiltLabel = config.reasoningTilt === 0 ? '居中 0°'
    : `${config.reasoningTilt < 0 ? '左' : '右'} ${Math.abs(config.reasoningTilt)}°`
  // The input capsule grows upward out of the Dock's box, so this scene has to
  // budget for the room the tallest draft occupies above it.
  const target = config.scene === 'question' ? [820, 560]
    : config.scene === 'permission' ? [600, 360]
      : config.scene === 'input' ? [520, 440] : [400, 260]
  const scale = fit ? Math.max(0.1, Math.min(bounds.width / target[0], bounds.height / target[1], 2.1)) : 1

  const configure = (value: LabConfig): void => {
    const message: ConfigMessage = { source: 'bart-lab', type: 'configure', config: value }
    frameRef.current?.contentWindow?.postMessage(message, window.location.origin)
  }
  const selectScene = (next: Scene): void => {
    setConfig((current) => ({ ...current, scene: next, variant: variants[next][0][0] }))
  }

  useEffect(() => {
    const receive = (event: MessageEvent<PreviewMessage>): void => {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return
      const message = event.data
      if (message?.source !== 'bart-preview') return
      if (message.type === 'ready') {
        setReady(true)
        configure(configRef.current)
      } else if (message.type === 'event') {
        const entry = {
          ...message.event, id: ++eventId.current,
          time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
        }
        setEvents((current) => [entry, ...current].slice(0, 8))
      } else if (message.type === 'scene' && scenes.some((item) => item.id === message.scene)) {
        selectScene(message.scene)
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])

  useEffect(() => configure(config), [config])
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(([entry]) => {
      setBounds({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="lab-shell">
      <header className="lab-header">
        <a className="lab-brand" href="./" aria-label="Bart Lab 首页">Bart<span>Lab</span><i /></a>
        <div className="lab-header-context"><span>OPENAGENT</span><span className="header-slash">/</span><span>角色实验室</span></div>
        <a className="lab-edition" href="./generation.html">CASE 02 → 卡片生成</a>
      </header>

      <main className="lab-workspace">
        <nav className="lab-nav" aria-label="Bart 状态">
          <div className="nav-heading"><span className="eyebrow">EXPLORER</span><h1>状态</h1><p>观察 Bart 的形态与节奏。</p></div>
          <div className="scene-list">
            {scenes.map((item, itemIndex) => (
              <button key={item.id} type="button" aria-pressed={config.scene === item.id}
                className={`scene-button ${config.scene === item.id ? 'selected' : ''}`} onClick={() => selectScene(item.id)}>
                <span className="scene-number">0{itemIndex + 1}</span>
                <span className="scene-name"><b>{item.label}</b><small>{item.id === 'question' ? '提问与回答' : item.id === 'permission' ? '请求与授权' : item.english}</small></span>
                <ArrowUpRight size={15} aria-hidden="true" />
              </button>
            ))}
          </div>
        </nav>

        <section className="lab-canvas" aria-label="状态工作台">
          <header className="canvas-header">
            <div><span className="eyebrow">CASE 01 / 状态</span><h2>{scene.label}</h2></div>
            <span className="live-indicator"><i className={ready ? 'is-ready' : ''} />{ready ? 'LIVE PREVIEW' : 'LOADING'}</span>
          </header>
          <div className="preview-viewport" ref={stageRef}>
            <iframe ref={frameRef} title="Bart 交互预览" src="./preview.html" onLoad={() => configure(configRef.current)}
              style={{ width: bounds.width / scale, height: bounds.height / scale, transform: `scale(${scale})` }} />
          </div>
          <footer className="canvas-footer">
            <div className="specimen-caption"><span className="eyebrow">0{index + 1} — {variant[2].toUpperCase()}</span><p>{scene.description}</p></div>
            <div className="canvas-tools">
              <button type="button" className="icon-button" aria-label="重放当前场景" title="重放当前场景"
                onClick={() => setConfig((current) => ({ ...current, replay: current.replay + 1, reasoningStreamPaused: false }))}><RotateCcw size={15} /><span>重放</span></button>
              <button type="button" className={`icon-button ${fit ? 'is-active' : ''}`} aria-label="适合画布" aria-pressed={fit}
                title={fit ? '切换到原始比例' : '适合画布'} onClick={() => setFit((current) => !current)}><Maximize2 size={17} /></button>
              <span className="scale-label">{Math.round(scale * 100)}%</span>
            </div>
          </footer>
        </section>

        <aside className="lab-inspector" aria-label="场景设置">
          <div className="inspector-heading"><span className="eyebrow">INSPECTOR</span><span>0{index + 1}</span></div>
          {thinking && config.variant === 'reasoning-live' ? <section className="control-section reasoning-controls">
            <h2>流式展示</h2>
            <div className="stream-candidates" role="group" aria-label="流式效果候选">
              {reasoningStreamStyles.map(style => <button key={style.id} type="button"
                className={`stream-candidate ${config.reasoningStreamStyle === style.id ? 'selected' : ''}`}
                aria-label={style.label} aria-pressed={config.reasoningStreamStyle === style.id}
                onClick={() => setConfig(current => ({ ...current, reasoningStreamStyle: style.id }))}>
                <span><b>{style.label}</b><small>{style.description}</small></span>
                {config.reasoningStreamStyle === style.id ? <Check size={14} aria-hidden="true" /> : null}
              </button>)}
            </div>
            <label className="range-control">
              <span>输入速度<output>{config.reasoningStreamSpeed.toFixed(2)}×</output></span>
              <input aria-label="输入速度" type="range" min={.5} max={2} step={.25} value={config.reasoningStreamSpeed}
                onChange={(event) => setConfig((current) => ({ ...current, reasoningStreamSpeed: Number(event.target.value) }))} />
            </label>
            <label className="toggle-row"><span>模拟批量输入</span><input type="checkbox" checked={config.reasoningStreamBursts}
              onChange={(event) => setConfig(current => ({ ...current, reasoningStreamBursts: event.target.checked }))} /><span className="switch" aria-hidden="true" /></label>
            <button type="button" className="icon-button" onClick={() => setConfig(current => ({
              ...current, reasoningStreamPaused: !current.reasoningStreamPaused
            }))}>{config.reasoningStreamPaused ? '继续流入' : '暂停流入'}</button>
            <p className="control-hint">输入速度调整文字到达的频率。开启批量输入可比较成段到达时的推进效果；暂停后，等待中的文字继续滑入。</p>
          </section> : null}
          {thinking ? <section className="control-section reasoning-controls">
            <h2>思考实验</h2>
            <label className="range-control">
              <span>文本显示长度<output>{config.reasoningLength}%</output></span>
              <input aria-label="文本显示长度" type="range" min={60} max={200} step={5} value={config.reasoningLength}
                onChange={(event) => setConfig((current) => ({ ...current, reasoningLength: Number(event.target.value) }))} />
            </label>
            <label className="range-control">
              <span>文字倾斜<output>{tiltLabel}</output></span>
              <input aria-label="文字倾斜" aria-valuetext={tiltLabel} type="range" min={-45} max={45} step={1} value={config.reasoningTilt}
                onChange={(event) => setConfig((current) => ({ ...current, reasoningTilt: Number(event.target.value) }))} />
            </label>
            <label className="toggle-row"><span>眼球跟随文字</span><input type="checkbox" checked={config.reasoningGaze}
              onChange={(event) => setConfig((current) => ({ ...current, reasoningGaze: event.target.checked }))} /><span className="switch" aria-hidden="true" /></label>
            <button type="button" className="icon-button" onClick={() => setConfig((current) => ({
              ...current, reasoningLength: initialConfig.reasoningLength, reasoningTilt: initialConfig.reasoningTilt,
              reasoningGaze: initialConfig.reasoningGaze, reasoningStreamStyle: initialConfig.reasoningStreamStyle
            }))}>恢复锁定参数</button>
            <p className="control-hint">已锁定：顺滑推进 · 200% · 左 20° · 眼球放大 10% · 自然扫读与身体跟随。</p>
          </section> : null}
          <section className="control-section">
            <h2>{config.scene === 'cadence' ? '输入序列' : config.scene === 'resident' ? '当前状态' : config.scene === 'input' ? '输入场景' : config.scene === 'question' ? '回答方式' : '请求类型'}</h2>
            <div className="variant-list">
              {variants[config.scene].map(([id, label]) => (
                <button type="button" key={id} className={`variant-button ${config.variant === id ? 'selected' : ''}`}
                  aria-pressed={config.variant === id} onClick={() => setConfig((current) => ({ ...current, variant: id }))}>
                  <span>{label}</span>{config.variant === id ? <Check size={14} aria-hidden="true" /> : <i />}
                </button>
              ))}
            </div>
            <p className="control-hint">{scene.hint}</p>
          </section>

          {config.scene === 'cadence' ? <section className="control-section cadence-controls">
            <h2>节奏参数</h2>
            {([
              ['minimumMs', '最短展示时间', 0, 2000, 50],
              ['reasoningMs', '思考文字刷新', 0, 500, 25],
              ['eventMs', '事件输入间隔', 20, 1000, 20]
            ] as const).map(([field, label, min, max, step]) => <label key={field}>
              <span>{label}<output>{config[field]}ms</output></span>
              <input aria-label={label} type="range" min={min} max={max} step={step} value={config[field]}
                onChange={(event) => setConfig((current) => ({ ...current, [field]: Number(event.target.value) }))} />
            </label>)}
            <button type="button" className="icon-button" onClick={() => setConfig((current) => ({
              ...current, minimumMs: initialConfig.minimumMs, reasoningMs: initialConfig.reasoningMs, eventMs: initialConfig.eventMs
            }))}>恢复默认参数</button>
            <p className="control-hint">当前选择：{config.minimumMs} / {config.reasoningMs}ms。调整仅作用于 Lab。</p>
          </section> : null}

          <section className="control-section display-controls">
            <h2>显示</h2>
            <label className="toggle-row"><span>参考线</span><input type="checkbox" checked={config.guides}
              onChange={(event) => setConfig((current) => ({ ...current, guides: event.target.checked }))} /><span className="switch" aria-hidden="true" /></label>
          </section>

          <section className="event-section" aria-label="交互记录">
            <div className="event-heading"><h2>交互记录</h2>{events.length > 0 && <button type="button" onClick={() => setEvents([])}>清空</button>}</div>
            <div className="event-live" role="status" aria-live="polite">{events[0]?.title ?? ''}</div>
            {events.length === 0 ? <div className="event-empty"><ArrowDownLeft size={20} strokeWidth={1.3} /><p>试着与 Bart 互动。<br /><span>结果会出现在这里。</span></p></div>
              : <ol className="event-list">{events.map((event) => <li key={event.id}>
                <time>{event.time}</time><b>{event.title}</b><p>{event.detail}</p>
                {event.payload !== undefined && <details><summary>查看数据</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>}
              </li>)}</ol>}
          </section>
        </aside>
      </main>
      <footer className="lab-footer"><span><i /> BART · CHARACTER STUDIES</span><span>本地交互演示</span></footer>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
