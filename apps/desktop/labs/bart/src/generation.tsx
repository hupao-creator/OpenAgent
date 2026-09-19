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
import { generationFixture, type GenerationSample } from './generation-fixtures'
import { createWritingProgram } from '../../../src/renderer/src/bart-motion/writing-program'
import { WritingCandidates } from './writing-candidates'
import { writingGestures, type WritingGesture } from './writing-gestures'
import type { GenerationPreview } from '../../../src/renderer/src/bart-motion/generation-scene'
import { GenerationRegressions } from './generation-regressions'
import '@fontsource-variable/inter'
import '../../../src/renderer/src/styles.css'
import './generation.css'

const noAction = (): void => undefined
const noRequest = async (): Promise<void> => undefined

function GenerationLab(): React.JSX.Element {
  const [theme, setTheme] = useState('light')
  const [experience, setExperience] = useState<'writing' | 'current'>('writing')
  const [sample, setSample] = useState<GenerationSample>('long')
  const [speed, setSpeed] = useState(1)
  const [softReveal, setSoftReveal] = useState(true)
  const [punctuationPauses, setPunctuationPauses] = useState(false)
  const [gesture, setGesture] = useState<WritingGesture>('spring')
  const [duration, setDuration] = useState<number | null>(null)
  const [replay, setReplay] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [phase, setPhase] = useState('准备就绪')
  const [works, setWorks] = useState<readonly BartGenerationWork[]>([])
  const [hiddenIds, setHiddenIds] = useState<readonly string[]>([])
  const root = useRef<HTMLDivElement>(null)
  const requestEpoch = useRef(0)
  const fixture = useMemo(() => generationFixture(sample), [replay, sample])
  const source = useMemo(() => projectHarnessOverviewThread({ thread: fixture }, 1), [fixture])
  const sources = useMemo(() => [source], [source])
  const done = useCallback(() => setPlaying(false), [])
  const consume = useCallback(() => { setWorks([]); setPhase('交接完成 · 正式卡片'); done() }, [done])
  const preview = useMemo<GenerationPreview>(() => {
    const writing = createWritingProgram({ speed, softReveal, gesture, punctuationPauses })
    return (program, cards) => {
      const result = experience === 'writing' ? writing(program, cards) : createWritingProgram()(program, cards)
      setDuration(result.duration)
      return result
    }
  }, [experience, speed, softReveal, gesture, punctuationPauses])
  const gestureName = writingGestures.find(item => item.id === gesture)!.name

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
    setPhase(experience === 'writing' ? `${gestureName} · 播放中` : '当前效果 · 播放中')
    const controller = new AbortController()
    const target = bartGenerationThreadTarget(source)
    setWorks([{ key: Date.now(), targets: [target], controller }])
  }

  const reset = (): void => { finish(); setReplay(value => value + 1); setDuration(null); setPhase('准备就绪') }

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
          <p>让 Bart 朝文字前方冲刺，在停顿处收势。</p>
          <fieldset disabled={playing}><legend>效果对照</legend>
            <button className="genlab-choice" aria-pressed={experience === 'writing'} onClick={() => { setExperience('writing'); setDuration(null) }}>专注书写 <small>参数预览</small></button>
            <button className="genlab-choice" aria-pressed={experience === 'current'} onClick={() => { setExperience('current'); setDuration(null) }}>当前效果 <small>生产版本</small></button>
          </fieldset>
          <fieldset disabled={playing}><legend>播放设置</legend>
            <label>示例<select aria-label="示例" value={sample} onChange={event => { setSample(event.target.value as GenerationSample); setDuration(null) }}>
              <option value="short">中文短文</option><option value="long">中文长文</option><option value="english">英文</option></select></label>
            {experience === 'writing' && <label className="genlab-speed">书写速度 <output>{speed.toFixed(2)}×</output>
              <input aria-label="书写速度" type="range" min="0.7" max="1.3" step="0.05" value={speed}
                onChange={event => { setSpeed(Number(event.target.value)); setDuration(null) }} />
              <small><span>更从容</span><span>更利落</span></small>
            </label>}
            {experience === 'writing' && <label>文字柔和显露<input type="checkbox" aria-label="文字柔和显露" checked={softReveal}
              onChange={event => setSoftReveal(event.target.checked)} /></label>}
            {experience === 'writing' && <label>标点停顿<input className="genlab-switch" type="checkbox" role="switch"
              aria-label="标点停顿" checked={punctuationPauses}
              onChange={event => { setPunctuationPauses(event.target.checked); setDuration(null) }} /></label>}
            <label>外观<select aria-label="外观" value={theme} onChange={event => setTheme(event.target.value)}>
              <option value="light">浅色</option><option value="dark">深色</option></select></label>
          </fieldset>
          <div className="genlab-note">{experience === 'writing'
            ? `${punctuationPauses ? '标点处停顿收势' : '标点处连续前进'}，换行时反向回冲。三个候选共用文字节奏、路径与柔和显露。`
            : '已锁定的短速度线、1.00×、柔和显露，标点连续前进。'}</div>
        </aside>
        <section className="genlab-preview" aria-label="卡片生成预览">
          {experience === 'writing' && <WritingCandidates selected={gesture} disabled={playing} punctuationPauses={punctuationPauses} onSelect={setGesture} />}
          <div className="genlab-stage-header"><span>{experience === 'writing' ? gestureName : '当前效果'}<small> · 新任务 1 × 1</small></span>
            {playing ? <button onClick={finish}><SkipForward size={13} />最终卡片</button>
              : <button onClick={() => void play()} aria-label={`在卡片中播放${experience === 'writing' ? gestureName : '当前效果'}`}><Play size={13} />在卡片中播放</button>}</div>
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
            <BartThreadGenerations overviewOpen threads={sources} works={works} preview={preview} onWorkConsumed={consume} onHiddenIdsChange={setHiddenIds} />
          </div>
          <footer className="genlab-transport">
            <div><span className={`genlab-dot ${playing ? 'playing' : ''}`} /><output aria-live="polite">{phase}{duration !== null && ` · ${(duration / 1000).toFixed(1)}s`}</output></div>
            <nav aria-label="播放控制">
              <button onClick={reset} disabled={playing} title="重置场景"><RotateCcw size={15} /></button>
              {playing && <button onClick={() => { const start = performance.now(); while (performance.now() - start < 5000) { /* Isolation check. */ } }}>阻塞主线程 5 秒</button>}
              {playing ? <button onClick={finish}><SkipForward size={15} />最终卡片</button>
                : <button className="genlab-play" onClick={() => void play()}><Play size={15} />{experience === 'writing' ? '播放书写预览' : '播放当前效果'}</button>}
            </nav>
          </footer>
          <div className="genlab-caption">{experience === 'writing' ? '参数预览 · 单卡最多 8 秒，可随时查看最终卡片。' : '当前生产效果 · 生成新任务时展示初始任务说明。'}</div>
        </section>
      </div>
      <footer className="genlab-footer"><span>BART · MOTION STUDIES</span><span>Lab 单卡预览 · 真实卡片与角色</span></footer>
    </main>
  </RendererCapabilitiesProvider>
}

const reactRoot = createRoot(document.getElementById('root')!)
reactRoot.render(<AppI18nProvider locale="zh-CN">{new URLSearchParams(location.search).has('regression')
  ? <GenerationRegressions /> : <GenerationLab />}</AppI18nProvider>)
import.meta.hot?.dispose(() => reactRoot.unmount())
