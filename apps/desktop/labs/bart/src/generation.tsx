import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowLeft, Play, RotateCcw, SkipForward } from 'lucide-react'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { OVERVIEW_CARD_GEOMETRY } from '@openagent/contracts/renderer'
import { AppI18nProvider } from '../../../src/renderer/src/i18n'
import { HarnessThreadOverviewCard } from '../../../src/renderer/src/components/ConversationOverview'
import { projectHarnessOverviewThread } from '../../../src/renderer/src/harness-composition'
import { BartDock } from '../../../src/renderer/src/components/BartDock'
import { BartThreadGenerations, bartGenerationThreadTarget, type BartGenerationWork } from '../../../src/renderer/src/components/BartThreadGeneration'
import { getOverviewMotionCoordinator } from '../../../src/renderer/src/overview-motion'
import { generationFixture } from './generation-fixtures'
import { GenerationRegressions } from './generation-regressions'
import '@fontsource-variable/inter'
import '../../../src/renderer/src/styles.css'
import './generation.css'

const noAction = (): void => undefined
const noRequest = async (): Promise<void> => undefined

function GenerationLab(): React.JSX.Element {
  const [theme, setTheme] = useState('light')
  const [replay, setReplay] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [phase, setPhase] = useState('准备就绪')
  const [works, setWorks] = useState<readonly BartGenerationWork[]>([])
  const [hiddenIds, setHiddenIds] = useState<readonly string[]>([])
  const root = useRef<HTMLDivElement>(null)
  const requestEpoch = useRef(0)
  const fixture = useMemo(() => generationFixture(), [replay])
  const source = useMemo(() => projectHarnessOverviewThread({ thread: fixture }, 1), [fixture])
  const sources = useMemo(() => [source], [source])
  const done = useCallback(() => setPlaying(false), [])
  const consume = useCallback(() => { setWorks([]); setPhase('交接完成 · 正式卡片'); done() }, [done])

  useEffect(() => {
    document.documentElement.style.colorScheme = theme
  }, [theme])
  useEffect(() => () => { requestEpoch.current++; getOverviewMotionCoordinator().cutScene() }, [])
  const finish = (): void => {
    requestEpoch.current++
    getOverviewMotionCoordinator().cutScene()
    setWorks([]); setHiddenIds([]); done(); setPhase('最终卡片')
  }
  const play = async (): Promise<void> => {
    const epoch = ++requestEpoch.current
    setPlaying(true)
    // Allow fonts and the Harness's lazy Markdown reader to settle before measuring.
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (epoch !== requestEpoch.current) return
    setPhase('Worker 演出 · 播放中')
    const controller = new AbortController()
    const target = bartGenerationThreadTarget(source)
    setWorks([{ key: Date.now(), targets: [target], controller }])
  }

  const reset = (): void => { finish(); setReplay(value => value + 1); setPhase('准备就绪') }

  return <RendererCapabilitiesProvider capabilities={{ openExternal: noAction }}>
    <main className="generation-lab">
      <header className="genlab-header">
        <a href="./"><ArrowLeft size={15} /> Bart <span>Lab</span></a>
        <span className="genlab-breadcrumb">角色实验室 <i>/</i> 卡片生成</span>
        <small>CASE 02 <i /> GENERATION</small>
      </header>
      <div className="genlab-workspace">
        <aside className="genlab-controls">
          <span className="genlab-eyebrow">CARD GENERATION</span>
          <h1>从 Bart 到 Thread</h1>
          <p>观察逐字显露，以及动画结束的那一刻。</p>
          <fieldset disabled={playing}><legend>播放设置</legend>
            <label>外观<select aria-label="外观" value={theme} onChange={event => setTheme(event.target.value)}>
              <option value="light">浅色</option><option value="dark">深色</option></select></label>
          </fieldset>
          <div className="genlab-note">完整计划包含飞行、形变、真实内容显露和返回。页面内容更新时交还当前卡片。</div>
        </aside>
        <section className="genlab-preview" aria-label="卡片生成预览">
          <div className="genlab-stage-header"><span>生产 Worker 演出<small> · 新任务 1 × 1</small></span><small>Codex · 模拟数据</small></div>
          <div className="app-shell genlab-stage" ref={root}>
            <div className="genlab-grid" style={{
              '--thread-card-column-width': `${OVERVIEW_CARD_GEOMETRY.columnWidth}px`,
              '--thread-card-row-height': `${OVERVIEW_CARD_GEOMETRY.rowHeight}px`,
              '--thread-card-gap': `${OVERVIEW_CARD_GEOMETRY.gap}px`,
              gridTemplateColumns: `${OVERVIEW_CARD_GEOMETRY.columnWidth}px`
            } as CSSProperties}>
              <HarnessThreadOverviewCard source={source} columns={1} rows={1}
                structureKey={source.envelope.structureKey} availableColumns={1} index={0} totalCount={1}
                transitionTarget={false} generationPending={hiddenIds.includes(source.thread.id)}
                followUpBlocked interrupt={noRequest} respond={noRequest} onOpen={noAction} onFollowUpOpen={noAction} />
            </div>
            <BartDock activityContext={{ threadKey: 'bart-lab-generation', execution: null }} threadOpen={false} sessionIdle inputOpen={false} inputValue="" inputDisabled
              bartAttachments={[]} onThreadOpenChange={noAction} onInputOpenChange={noAction}
              onInputChange={noAction} onChooseFiles={noAction} onRemoveBartAttachment={noAction}
              onSubmit={noAction} onInteractionResponse={noRequest} />
            <BartThreadGenerations overviewOpen threads={sources} works={works} onWorkConsumed={consume} onHiddenIdsChange={setHiddenIds} />
          </div>
          <footer className="genlab-transport">
            <div><span className={`genlab-dot ${playing ? 'playing' : ''}`} /><output aria-live="polite">{phase}</output></div>
            <nav aria-label="播放控制">
              <button onClick={reset} disabled={playing} title="重置场景"><RotateCcw size={15} /></button>
              {playing && <button onClick={() => { const start = performance.now(); while (performance.now() - start < 5000) { /* Isolation check. */ } }}>阻塞主线程 5 秒</button>}
              {playing ? <button onClick={finish}><SkipForward size={15} />最终卡片</button>
                : <button className="genlab-play" onClick={() => void play()}><Play size={15} />播放生产动画</button>}
            </nav>
          </footer>
          <div className="genlab-caption">生成新任务时只展示初始任务说明，保持 1 × 1 基础卡片。</div>
        </section>
      </div>
      <footer className="genlab-footer"><span>BART · MOTION STUDIES</span><span>与生产共用完整计划、真实内容快照和主线程隔离执行。</span></footer>
    </main>
  </RendererCapabilitiesProvider>
}

const reactRoot = createRoot(document.getElementById('root')!)
reactRoot.render(<AppI18nProvider locale="zh-CN">{new URLSearchParams(location.search).has('regression')
  ? <GenerationRegressions /> : <GenerationLab />}</AppI18nProvider>)
import.meta.hot?.dispose(() => reactRoot.unmount())
