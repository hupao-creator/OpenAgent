import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeft, ArrowUpRight, Pause, Play, RotateCcw, SkipForward } from 'lucide-react'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { OVERVIEW_CARD_GEOMETRY } from '@openagent/contracts/renderer'
import { HarnessThreadOverviewCard } from '../../../src/renderer/src/components/ConversationOverview'
import { BartDock } from '../../../src/renderer/src/components/BartDock'
import { projectHarnessOverviewThread } from '../../../src/renderer/src/harness-composition'
import { OVERVIEW_CARD_ENTRY_MOTION } from '../../../src/renderer/src/overview-motion/card-layout-motion'
import { generationFixture, type GenerationSample } from './generation-fixtures'
import './entrance.css'

const candidates = [
  { id: 'instant', letter: '00', name: '直接出现', duration: 0, description: '完整卡片立即就位。', detail: '没有额外提示，作为对照基准。' },
  { id: 'fade', letter: 'A', name: '原位淡入', duration: 240, description: '卡片原位显露，文字一起出现。', detail: '只有透明度变化，注意力留在内容上。' },
  { id: 'rise', letter: 'B', name: '轻抬落定', duration: OVERVIEW_CARD_ENTRY_MOTION.duration, description: '从下方 8px 轻轻落定。', detail: '已采用。短距离上移配合淡入，强调新卡片的位置。' },
  { id: 'outline', letter: 'C', name: '边框提示', duration: 560, description: '内容立即可见，边缘亮起再消退。', detail: '不移动文字，以一次柔和的边框提示标记新增。' }
] as const
const noAction = (): void => undefined
const noRequest = async (): Promise<void> => undefined

/** Lab-only entrances. The real Overview card and resident Bart stay mounted. */
export function EntranceLab(): React.JSX.Element {
  const [candidateId, setCandidateId] = useState<typeof candidates[number]['id']>('rise')
  const [sample, setSample] = useState<GenerationSample>('short')
  const [count, setCount] = useState(1)
  const [speed, setSpeed] = useState(1)
  const [theme, setTheme] = useState('light')
  const [replay, setReplay] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [paused, setPaused] = useState(false)
  const [reduced, setReduced] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const animations = useRef<Animation[]>([])
  const candidate = candidates.find(item => item.id === candidateId)!
  const sources = useMemo(() => Array.from({ length: count }, (_, index) => {
    const fixture = generationFixture(sample)
    return projectHarnessOverviewThread({ thread: {
      ...fixture, id: `entrance-thread-${index}`, title: count === 1 ? fixture.title : `${fixture.title} · ${index + 1}`
    } }, 1)
  }), [sample, count])
  const finish = useCallback(() => {
    for (const animation of animations.current) animation.cancel()
    animations.current = []
    setPlaying(false); setPaused(false)
  }, [])

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const change = (): void => setReduced(media.matches)
    change(); media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    document.documentElement.style.colorScheme = theme
  }, [theme])
  useEffect(() => {
    const onHide = (): void => { if (document.hidden) finish() }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [finish])

  useLayoutEffect(() => {
    finish()
    if (!replay || reduced || document.hidden || !candidate.duration || !stage.current) return
    let disposed = false
    const wrappers = stage.current.querySelectorAll<HTMLElement>('.entrance-card')
    for (const wrapper of wrappers) {
      const element = candidate.id === 'outline' ? wrapper.querySelector<HTMLElement>('.entrance-outline')! : wrapper
      if (typeof element.animate !== 'function') continue
      const keyframes: Keyframe[] = candidate.id === 'rise'
        ? [OVERVIEW_CARD_ENTRY_MOTION.from, OVERVIEW_CARD_ENTRY_MOTION.to]
        : candidate.id === 'outline'
        ? [{ opacity: 0 }, { opacity: 1, offset: .2 }, { opacity: 0 }]
        : [{ opacity: 0 }, { opacity: 1 }]
      animations.current.push(element.animate(keyframes, {
        duration: candidate.duration / speed,
        easing: candidate.id === 'rise' ? OVERVIEW_CARD_ENTRY_MOTION.easing : 'cubic-bezier(.2,.8,.2,1)', fill: 'both'
      }))
    }
    if (animations.current.length) {
      setPlaying(true)
      void Promise.all(animations.current.map(animation => animation.finished)).then(() => {
        if (!disposed) finish()
      }, () => { /* Cancellation reveals the fully rendered cards. */ })
    }
    return () => {
      disposed = true
      for (const animation of animations.current) animation.cancel()
      animations.current = []
    }
  }, [candidate, count, sample, replay, reduced, speed, theme, finish])

  const togglePause = (): void => {
    for (const animation of animations.current) {
      if (paused) animation.play()
      else animation.pause()
    }
    setPaused(!paused)
  }
  const play = (): void => setReplay(value => value + 1)
  const elapsed = reduced ? 0 : candidate.duration / speed
  const phase = reduced ? '减少动态效果 · 直接呈现' : paused ? '已暂停' : playing ? '入场中' : replay ? '已就位' : '准备就绪'

  return <RendererCapabilitiesProvider capabilities={{ openExternal: noAction }}>
    <main className="generation-lab entrance-lab">
      <header className="genlab-header">
        <a href="./"><ArrowLeft size={15} /> Bart <span>Lab</span></a>
        <span className="genlab-breadcrumb">角色实验室 <i>/</i> 卡片入场</span>
        <a className="entrance-old-study" href="?study=writing">原版飞行与书写 <ArrowUpRight size={13} /></a>
      </header>
      <div className="genlab-workspace">
        <aside className="genlab-controls">
          <span className="genlab-eyebrow">CARD ENTRANCE</span>
          <h1>Thread 卡片入场</h1>
          <p>选择一个候选，观察卡片入场。</p>
          <fieldset className="entrance-options"><legend>入场候选</legend>
            {candidates.map(item => <button key={item.id} type="button" aria-pressed={candidateId === item.id}
              className="entrance-option" onClick={() => { setCandidateId(item.id); play() }}>
              <span>{item.letter}</span><span><b>{item.name}</b><small>{item.duration ? `${item.duration} ms` : '对照'}</small></span>
            </button>)}
          </fieldset>
          <fieldset><legend>预览设置</legend>
            <label>卡片数量<select aria-label="卡片数量" value={count} onChange={event => setCount(Number(event.target.value))}>
              <option value={1}>单张卡片</option><option value={3}>三张同时创建</option></select></label>
            <label>示例<select aria-label="示例" value={sample} onChange={event => setSample(event.target.value as GenerationSample)}>
              <option value="short">中文短文</option><option value="long">中文长文</option><option value="english">英文</option></select></label>
            <label>播放速度<select aria-label="播放速度" value={speed} onChange={event => setSpeed(Number(event.target.value))}>
              <option value={1}>正常 · 1×</option><option value={.5}>慢放 · 0.5×</option><option value={.25}>慢放 · 0.25×</option></select></label>
            <label>外观<select aria-label="外观" value={theme} onChange={event => setTheme(event.target.value)}>
              <option value="light">浅色</option><option value="dark">深色</option></select></label>
          </fieldset>
          <div className="genlab-note">正式入场采用 B「轻抬落定」。其余候选保留作对照。</div>
        </aside>
        <section className="genlab-preview" aria-label="卡片入场预览">
          <div className="entrance-heading">
            <div><span className="genlab-eyebrow">{candidate.letter} / {candidate.id === 'rise' ? '已采用' : candidate.duration ? '候选效果' : '静态对照'}</span>
              <h2>{candidate.name}</h2><p>{candidate.description}</p></div>
            <span className="entrance-duration">{candidate.duration}<small>ms</small></span>
          </div>
          <div className="app-shell genlab-stage entrance-stage" ref={stage}>
            <span className="entrance-stage-label">THREAD OVERVIEW <i /> {count === 1 ? '单卡' : '批量创建'}</span>
            <div className="entrance-grid" style={{
              '--entrance-card-width': `${OVERVIEW_CARD_GEOMETRY.columnWidth}px`,
              '--thread-card-row-height': `${OVERVIEW_CARD_GEOMETRY.rowHeight}px`,
              '--thread-card-column-width': `${OVERVIEW_CARD_GEOMETRY.columnWidth}px`,
              '--thread-card-gap': `${OVERVIEW_CARD_GEOMETRY.gap}px`
            } as CSSProperties}>
              {sources.map((source, index) => <div className="entrance-card" key={source.thread.id}>
                <HarnessThreadOverviewCard source={source} columns={1} rows={1} structureKey={source.envelope.structureKey}
                  availableColumns={1} index={index} totalCount={count} transitionTarget={false} generationPending={false}
                  followUpBlocked interrupt={noRequest} respond={noRequest} onOpen={noAction} onFollowUpOpen={noAction} />
                <span className="entrance-outline" aria-hidden="true" />
              </div>)}
            </div>
            <BartDock activityContext={{ threadKey: 'bart-lab-entrance', execution: null }} threadOpen={false} sessionIdle
              inputOpen={false} inputValue="" inputDisabled bartAttachments={[]} onThreadOpenChange={noAction}
              onInputOpenChange={noAction} onInputChange={noAction} onChooseFiles={noAction}
              onRemoveBartAttachment={noAction} onSubmit={noAction} onInteractionResponse={noRequest} />
          </div>
          <footer className="genlab-transport">
            <div><span className={`genlab-dot ${playing ? 'playing' : ''}`} />
              <output aria-live="polite">{phase}{elapsed > 0 && ` · ${(elapsed / 1000).toFixed(2)} s`}</output></div>
            <nav aria-label="播放控制">
              {playing && <button onClick={togglePause}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? '继续' : '暂停'}</button>}
              {playing && <button onClick={finish}><SkipForward size={14} />最终卡片</button>}
              <button className="genlab-play" onClick={play}><RotateCcw size={14} />重放入场</button>
            </nav>
          </footer>
          <p className="genlab-caption">{candidate.detail}{count > 1 && ' 三张卡片同时开始，不逐张排队。'}</p>
        </section>
      </div>
      <footer className="genlab-footer"><span>BART · MOTION STUDIES</span><span>真实卡片 · Bart 保持原位</span></footer>
    </main>
  </RendererCapabilitiesProvider>
}
