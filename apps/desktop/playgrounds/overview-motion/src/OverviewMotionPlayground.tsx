import type { OverviewCameraMemory } from '../../../src/renderer/src/overview-motion/camera'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Pause, Play, RotateCcw, SkipForward } from 'lucide-react'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import type { OverviewLayoutContext } from '@openagent/contracts/renderer'
import { ConversationOverview, type ConversationOverviewLayoutRevision } from '../../../src/renderer/src/components/ConversationOverview'
import { getOverviewCameraCockpit, getOverviewMotionCoordinator } from '../../../src/renderer/src/overview-motion'
import { OVERVIEW_LAYOUT_CONTEXT, type OverviewLayoutPlanningState } from '../../../src/renderer/src/overview-layout-planner'
import { applyMotionAction, captureMotionLayout, createMotionFrame, motionActions, motionScenarios, type MotionAction, type MotionFrame } from './scenarios'

interface PlaygroundState {
  frame: MotionFrame
  mount: number
  epoch: number
  revision: number
  revisions: readonly ConversationOverviewLayoutRevision[]
  events: readonly string[]
}

function MotionReadout(): React.JSX.Element {
  const camera = getOverviewCameraCockpit()
  const state = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot)
  const [busy, setBusy] = useState(false)
  const scale = useRef<HTMLOutputElement>(null)
  useEffect(() => {
    const updateScale = (): void => {
      if (scale.current) scale.current.value = `${Math.round((camera.live?.transform.scale ?? 1) * 100)}%`
    }
    updateScale()
    const unsubscribe = camera.subscribeFrame(updateScale)
    const timer = window.setInterval(() => setBusy(getOverviewMotionCoordinator().stageBusy), 100)
    return () => { unsubscribe(); window.clearInterval(timer) }
  }, [camera])
  return <div className="motion-readout" aria-label="动画实时状态">
    <span><i data-busy={busy} /> <output aria-label="舞台状态">{busy ? '动画播放中' : '舞台空闲'}</output></span>
    <span><output aria-label="相机模式">{!state ? 'Canvas · 等待内容' : state.manual ? 'Canvas · 手动' : 'Canvas · 自动'}</output></span>
    <output aria-label="相机缩放" ref={scale}>100%</output>
  </div>
}

export function OverviewMotionPlayground(): React.JSX.Element {
  const [scenarioId, setScenarioId] = useState(() => {
    const requested = new URLSearchParams(location.search).get('scene')
    return motionScenarios.find(scene => scene.id === requested)?.id ?? 'lifecycle'
  })
  const scenario = motionScenarios.find(scene => scene.id === scenarioId)!
  const [model, setModel] = useState<PlaygroundState>(() => ({
    frame: createMotionFrame(scenario.count), mount: 0, epoch: 0, revision: 0, revisions: [], events: []
  }))
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [interval, setInterval] = useState(1600)
  const [theme, setTheme] = useState('light')
  const [width, setWidth] = useState('fluid')
  const [notice, setNotice] = useState('')
  const [away, setAway] = useState(false)
  const cameraMemory = useRef<OverviewCameraMemory['current']>(null)
  const [planning, setPlanning] = useState<OverviewLayoutPlanningState | null>(null)
  const layout = useRef<OverviewLayoutContext>(OVERVIEW_LAYOUT_CONTEXT)
  const onLayoutContextChange = useCallback((context: OverviewLayoutContext) => { layout.current = context }, [])
  const onLayoutRevisionsConsumed = useCallback((through: number) => {
    setModel(current => ({ ...current, revisions: current.revisions.filter(item => item.revision > through) }))
  }, [])

  const reset = useCallback((count: number) => {
    setPlaying(false); setCursor(0); setNotice(''); setPlanning(null); setAway(false)
    setModel(current => ({ frame: createMotionFrame(count), mount: current.mount + 1, epoch: current.epoch + 1,
      revision: current.revision, revisions: [], events: [] }))
  }, [])

  const perform = useCallback((action: MotionAction) => {
    const context = layout.current
    setModel(current => {
      const frames = applyMotionAction(current.frame, action)
      const epoch = current.epoch + (action === 'cut' ? 1 : 0)
      const revisions = action === 'cut' ? [] : frames.map((frame, index) => ({
        revision: current.revision + index + 1, sceneKey: `playground:${epoch}`, snapshot: captureMotionLayout(frame, context)
      }))
      return { frame: frames.at(-1)!, mount: current.mount, epoch, revision: current.revision + frames.length,
        revisions: action === 'cut' ? [] : [...current.revisions, ...revisions],
        events: [...current.events, motionActions[action]].slice(-6) }
    })
  }, [])

  const next = useCallback(() => {
    const action = scenario.steps[cursor]
    if (!action) { setPlaying(false); return }
    perform(action)
    setCursor(cursor + 1)
    if (cursor + 1 === scenario.steps.length) setPlaying(false)
  }, [cursor, perform, scenario])

  useEffect(() => {
    if (!playing) return
    const timer = window.setTimeout(next, interval)
    return () => window.clearTimeout(timer)
  }, [playing, next, interval])
  useEffect(() => {
    const url = new URL(location.href)
    url.searchParams.set('scene', scenarioId)
    history.replaceState(null, '', url)
  }, [scenarioId])
  useEffect(() => {
    const root = document.documentElement
    // color-scheme 驱动 light-dark()；生产样式里那两块 @media (prefers-color-scheme)
    // 的规则驱不动，由 playground.css 末尾按 data-theme 重述。
    root.style.colorScheme = theme
    root.dataset.theme = theme
    return () => {
      root.style.removeProperty('color-scheme')
      delete root.dataset.theme
    }
  }, [theme])

  const record = (action: string): void => setNotice(`${action} · 仅记录预览请求`)
  const completed = cursor === scenario.steps.length
  return <RendererCapabilitiesProvider capabilities={{ openExternal: url => record(`打开链接 ${url}`) }}>
    <main className="motion-playground">
      <header className="motion-header">
        <div className="motion-brand"><span>OPENAGENT / PLAYGROUNDS</span><h1>Overview Motion</h1></div>
        <div className="motion-environment">
          <nav className="layout-nav" aria-label="Playground"><a href="?scene=lifecycle" aria-current="page">动画</a><a href="?scene=layout">Layout</a></nav>
          <label>视口<select value={width} onChange={event => setWidth(event.target.value)}><option value="fluid">自适应</option><option value="1100">1100 px</option><option value="760">760 px</option><option value="560">560 px</option></select></label>
          <label>外观<select value={theme} onChange={event => setTheme(event.target.value)}><option value="light">浅色</option><option value="dark">深色</option></select></label>
        </div>
      </header>
      <div className="motion-workspace">
        <section className="motion-preview" aria-label="Overview 动画预览">
          <div className="motion-stage" style={{ maxWidth: width === 'fluid' ? undefined : `${width}px` }}>
            {away ? <div className="thread-overview-empty"><strong>已离开 Overview</strong><span>可以在控制台改变卡片集合，再返回观察旧视角与延迟取景。</span></div> :
            <ConversationOverview key={model.mount} cameraMemory={cameraMemory} threads={model.frame.threads} reports={model.frame.reports}
              onLayoutPlanningState={setPlanning}
              canvasScaleFloor={0.05}
              transitionId={null} embedded motionSceneKey={`playground:${model.epoch}`}
              layoutRevisions={model.revisions} onLayoutRevisionsConsumed={onLayoutRevisionsConsumed}
              onLayoutContextChange={onLayoutContextChange}
              interrupt={async id => record(`停止 ${id}`)} respond={async () => record('回应问题')}
              onFollowUpOpen={(id, draft) => record(`续写 ${id}${draft ? `：${draft}` : ''}`)}
              onSelect={id => record(`打开 ${id}`)} onOpenReport={id => record(`打开报告 ${id}`)}
              onOpenRelatedExecution={id => record(`打开关联 ${id}`)} />}
          </div>
          <footer className="motion-stage-footer"><MotionReadout /><span>模拟数据 · 紧凑布局 · 串行直线</span></footer>
        </section>
        <aside className="motion-inspector" aria-label="动画控制台">
          <section className="motion-section motion-layout-summary" aria-label="布局结果">
            <h2>布局</h2>
            {planning && 'error' in planning ? <p role="alert">未找到可用布局，保留上次格位。{planning.error}</p>
              : planning && 'plan' in planning ? <>
                <p role="status">{planning.plan.distanceOptimal ? '零位移 · 总距离已证明最优'
                  : planning.plan.searchComplete ? '搜索已完成 · 浮点结果，未认证精确最优' : '合法方案 · 搜索尚未完成'}</p>
                <dl>
                  <div><dt>包围盒</dt><dd><output aria-label="布局包围盒">{planning.plan.bounds.cols} × {planning.plan.bounds.rows}</output></dd></div>
                  <div><dt>长宽比</dt><dd><output aria-label="布局长宽比">{planning.plan.aspect?.toFixed(3) ?? '—'}</output></dd></div>
                  <div><dt>总移动距离</dt><dd><output aria-label="布局移动距离">{planning.plan.totalShiftDistance.toFixed(1)} px</output></dd></div>
                  <div><dt>移动卡片</dt><dd><output aria-label="布局移动卡片">{planning.plan.shiftedIds.length}</output></dd></div>
                </dl>
              </> : <p>正在规划布局…</p>}
          </section>
          <section className="motion-section">
            <h2>场景</h2>
            <div className="motion-scenarios" role="group" aria-label="动画场景">
              {motionScenarios.map((item, index) => <button type="button" key={item.id} aria-pressed={scenarioId === item.id}
                onClick={() => { setScenarioId(item.id); reset(item.count) }}><span>{String(index + 1).padStart(2, '0')}</span>{item.title}</button>)}
            </div>
          </section>
          <section className="motion-section motion-playback">
            <div className="motion-section-heading"><h2>{scenario.title}</h2><span>{cursor} / {scenario.steps.length}</span></div>
            <p>{scenario.description}</p>
            <div className="motion-transport">
              <button type="button" className="motion-primary" onClick={() => {
                if (playing) { setPlaying(false); return }
                if (completed) reset(scenario.count)
                setPlaying(true)
              }}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? '暂停触发' : completed ? '重新演示' : '开始演示'}</button>
              <button type="button" aria-label="下一步" title="下一步" disabled={playing || completed} onClick={next}><SkipForward size={16} /></button>
              <button type="button" aria-label="重置场景" title="重置场景" onClick={() => reset(scenario.count)}><RotateCcw size={15} /></button>
            </div>
            <label className="motion-interval">触发间隔<select value={interval} onChange={event => setInterval(Number(event.target.value))}>
              <option value={250}>250 ms · 压测</option><option value={1600}>1.6 s · 连续</option><option value={3500}>3.5 s · 观察</option>
            </select></label>
            <ol className="motion-steps">{scenario.steps.map((action, index) => <li key={index} data-done={index < cursor} aria-current={index === cursor ? 'step' : undefined}>
              <span>{index + 1}</span>{motionActions[action]}</li>)}</ol>
            <small>暂停只停止后续触发；当前动画继续落定。</small>
          </section>
          <section className="motion-section">
            <h2>自由触发</h2>
            <button type="button" onClick={() => { setPlaying(false); setAway(!away) }}>{away ? '返回 Overview' : '离开 Overview'}</button>
            <div className="motion-actions">{(Object.keys(motionActions) as MotionAction[]).map(action => <button type="button" key={action}
              onClick={() => { setPlaying(false); perform(action) }}>{motionActions[action]}</button>)}</div>
          </section>
          <section className="motion-section motion-events">
            <div className="motion-section-heading"><h2>最近操作</h2><span>{model.frame.threads.length} 个任务</span></div>
            {model.events.length ? <ol>{model.events.map((event, index) => <li key={`${model.revision}-${index}`}>{event}</li>)}</ol> : <p>选择场景，开始演示或逐步触发。</p>}
            <output aria-live="polite">{notice}</output>
          </section>
        </aside>
      </div>
    </main>
  </RendererCapabilitiesProvider>
}
