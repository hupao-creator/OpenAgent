import { useEffect, useMemo, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { AppI18nProvider } from '../../../src/renderer/src/i18n'
import { HarnessThreadOverviewCard } from '../../../src/renderer/src/components/ConversationOverview'
import { projectHarnessOverviewThread } from '../../../src/renderer/src/harness-composition'
import { createMotionSurface, inspectMotionRuntime } from '../../../src/renderer/src/bart-motion/worker-client'
import { prepareMotionCard, prewarmMotionCards, motionCardRevision } from '../../../src/renderer/src/bart-motion/card-assets'
import { prepareWithinBudget, sealGeometry, sealMotionScene } from '../../../src/renderer/src/bart-motion/scene-host'
import { compileGenerationProgram } from '../../../src/renderer/src/bart-motion/generation-program'
import type { BartLogoActivity } from '../../../src/renderer/src/bart-motion/character-model'
import { BartLogo } from '../../../src/renderer/src/components/BartLogo'
import { BartDock } from '../../../src/renderer/src/components/BartDock'
import { BartReplyBadge } from '../../../src/renderer/src/components/BartReplyBadge'
import { getOverviewMotionCoordinator, type OverviewStageLease } from '../../../src/renderer/src/overview-motion'
import { generationFixture } from './generation-fixtures'
import '@fontsource-variable/inter'
import '../../../src/renderer/src/styles.css'
import './isolation.css'
import { MessageIsolation } from './message-isolation'
import { ProductionIsolation } from './production-isolation'
import { SettingsIsolation } from './settings-isolation'
import { OverviewRegressions } from './overview-regressions'
import { CameraIsolation } from './camera-isolation'
import { CrossPageIsolation } from './cross-page-isolation'

const noAction = (): void => undefined
const noRequest = async (): Promise<void> => undefined
const globals = window as unknown as { bartIsolation?: {
  prepare(): Promise<unknown>; play(): Promise<unknown>; release(): void
  block(milliseconds: number): number; status(): unknown
  reply(open: boolean): void; staleRelease(): boolean; invalidate(): void
  inspect: typeof inspectMotionRuntime
  stress(): Promise<unknown>
} }

function Character({ size, activity = 'list' }: { size: number; activity?: BartLogoActivity }) {
  return <BartLogo size={size} resolvedActivity={activity} resolvedPhase="running" />
}

function IsolationLab() {
  const stage = useRef<HTMLDivElement>(null)
  const output = useRef<HTMLCanvasElement>(null)
  const fixture = useMemo(() => generationFixture(), [])
  const sources = useMemo(() => [0, 1].map(index => projectHarnessOverviewThread({ thread: {
    ...fixture, id: `isolation-card-${index}`, title: index ? '验证任务接力与归位' : fixture.title
  } }, 1)), [fixture])
  useEffect(() => {
    const root = stage.current!, canvas = output.current!
    const surface = createMotionSurface(canvas, root.clientWidth, root.clientHeight)
    let program: ReturnType<typeof compileGenerationProgram> | undefined
    let run: ReturnType<typeof surface.play> | undefined
    let seal: ReturnType<typeof sealMotionScene> | undefined
    let previousSeal: ReturnType<typeof sealMotionScene> | undefined
    let lease: OverviewStageLease | undefined
    let state = 'cold', preparedMs = 0, prewarmMs = 0, sealedMs = 0, lockMs = 0
    let validate = (): boolean => false
    const lifetime = new AbortController()
    let negativeFrame = 0
    const negative = root.querySelector<HTMLCanvasElement>('[data-negative]')!, ctx = negative.getContext('2d')!
    const animate = (now: number): void => {
      ctx.clearRect(0, 0, 160, 36)
      ctx.fillStyle = '#d35637'; ctx.fillRect((now / 3) % 135, 6, 25, 24)
      negativeFrame = requestAnimationFrame(animate)
    }
    negativeFrame = requestAnimationFrame(animate)
    const cards = [...root.querySelectorAll<HTMLElement>('.thread-overview-item')]
    const dockElement = root.querySelector<HTMLElement>('.bart-dock')!
    const handoff = (): void => {
      const valid = validate()
      if (seal) { lockMs = performance.now() - seal.sealedAt; seal.release(); previousSeal = seal; seal = undefined }
      run?.release(); run = undefined
      lease?.release(); lease = undefined
      state = valid ? 'handed-off' : 'aborted-to-current-dom'
    }
    globals.bartIsolation = {
      async prepare() {
        if (seal || run) throw new Error('The preceding scene must hand off first')
        const started = performance.now()
        const fonts = await prepareWithinBudget(async signal => {
          await surface.ready
          while (root.querySelector('[aria-busy="true"]')) {
            signal.throwIfAborted()
            await new Promise(resolve => setTimeout(resolve, 20))
          }
          return prewarmMotionCards(cards[0], signal)
        }, lifetime.signal)
        prewarmMs = performance.now() - started
        lease = await getOverviewMotionCoordinator().acquireStage('bart-isolation', lifetime.signal)
        seal = sealMotionScene({ root, canvas, covered: [...cards, dockElement], freezeTransforms: [dockElement] })
        const prepared: Awaited<ReturnType<typeof prepareMotionCard>>[] = []
        try {
          const bounds = root.getBoundingClientRect()
          validate = sealGeometry([...cards, dockElement], () => cards.map(motionCardRevision).join('\0'))
          await prepareWithinBudget(async signal => {
            for (const card of cards) {
              prepared.push(await prepareMotionCard(card, { x: bounds.left, y: bounds.top }, signal, fonts))
              signal.throwIfAborted()
            }
            const dock = root.querySelector<SVGGraphicsElement>('.bart-dock .bart-bot > path')!.getBoundingClientRect()
            program = compileGenerationProgram(prepared, { x: dock.left + dock.width / 2 - bounds.left,
              y: dock.top + dock.height / 2 - bounds.top, radius: Math.min(dock.width, dock.height) / 2 })
            await surface.load(prepared.flatMap(card => card.assets))
            signal.throwIfAborted()
            if (!validate()) throw new Error('Scene changed while resources were sealed')
          }, lifetime.signal, 2000)
        } catch (error) {
          prepared.flatMap(card => card.assets).forEach(asset => asset.bitmap.close())
          handoff(); throw error
        }
        sealedMs = performance.now() - seal.sealedAt
        preparedMs = performance.now() - started
        state = 'ready'
        return { duration: program!.duration, phases: program!.phases, preparedMs, prewarmMs, sealedMs,
          revealBlocks: program!.textures.filter(texture => texture.reveal).map(texture => ({
            id: texture.id, rect: texture.rect, start: texture.from, end: texture.reveal!.at(-1)!.at
          })),
          cards: prepared.map(card => card.rect), width: root.clientWidth, height: root.clientHeight }
      },
      async play() {
        if (!program || !seal) throw new Error('Prepare the scene first')
        try {
          if (!validate()) throw new Error('Scene changed before playback')
          run = surface.play(program)
          await run.started
          if (!seal.show()) throw new Error('Scene ownership expired')
          state = 'playing'
          const current = run
          void run.performed.then(() => { if (run === current) state = 'waiting-host' }, () => { if (run === current) handoff() })
        } catch (error) { handoff(); throw error }
        return { duration: program.duration, phases: program.phases }
      },
      release: handoff,
      inspect: inspectMotionRuntime,
      async stress() {
        const results = []
        for (let round = 0; round < 3; round++) {
          const temporary = Array.from({ length: 64 }, () => {
            const canvas = document.createElement('canvas')
            canvas.hidden = true; root.append(canvas)
            return { canvas, surface: createMotionSurface(canvas, 10, 10, 'character') }
          })
          try {
            const ready = await Promise.allSettled(temporary.map(item => item.surface.ready))
            results.push({ rejected: ready.filter(result => result.status === 'rejected').length, peak: await inspectMotionRuntime() })
          } finally { temporary.forEach(({ canvas, surface }) => { surface.dispose(); canvas.remove() }) }
        }
        return { rounds: results, final: await inspectMotionRuntime() }
      },
      staleRelease: () => previousSeal?.release() ?? false,
      invalidate: () => { cards[0].querySelector('.thread-overview-item-head > strong')!.textContent = '更新后的真实内容' },
      reply(open) {
        if (open) root.querySelector<HTMLButtonElement>('.isolation-reply .bart-reply-target')!.focus()
        else (document.activeElement as HTMLElement)?.blur()
      },
      block(milliseconds) {
        const start = performance.now()
        while (performance.now() - start < milliseconds) { /* Deliberate renderer CPU block; capture runs in Electron Main. */ }
        return performance.now() - start
      },
      status: () => ({ state, preparedMs, prewarmMs, sealedMs, lockMs, cards: cards.length,
        valid: validate(),
        owned: seal?.owns() ?? false, coveredInert: cards.every(card => card.inert),
        scrollTop: root.querySelector('[data-scroll]')!.scrollTop,
        replyReady: Boolean(root.querySelector('.bart-reply-target')) })
    }
    return () => { lifetime.abort(); delete globals.bartIsolation; cancelAnimationFrame(negativeFrame); handoff(); surface.dispose() }
  }, [])
  return <RendererCapabilitiesProvider capabilities={{}}>
    <div className="isolation app-shell" ref={stage}>
      <header><span>BART / EXECUTION ISOLATION</span><span>专用 Worker · 真实卡片资源</span></header>
      <div className="isolation-cards">{sources.map((source, index) => <HarnessThreadOverviewCard key={source.thread.id}
        source={source} columns={1} rows={1} structureKey={source.envelope.structureKey} availableColumns={2}
        index={index} totalCount={2} transitionTarget={false} generationPending={false}
        followUpBlocked interrupt={noRequest} respond={noRequest} onOpen={noAction} onFollowUpOpen={noAction} />)}</div>
      <div className="isolation-scroll" data-scroll><div>可滚动 / 裁剪的小 Logo</div>
        {Array.from({ length: 18 }, (_, index) => <div className="isolation-row" key={index}>
          <Character size={index % 2 ? 14 : 11} />正在执行任务 {index + 1}<Character size={24} /></div>)}
      </div>
      <BartDock activityContext={{ threadKey: 'bart-isolation', execution: null }} threadOpen={false} sessionIdle inputOpen={false} inputValue="" inputDisabled
        bartAttachments={[]} onThreadOpenChange={noAction} onInputOpenChange={noAction}
        onInputChange={noAction} onChooseFiles={noAction} onRemoveBartAttachment={noAction}
        onSubmit={noAction} onInteractionResponse={noRequest} />
      <aside className="isolation-settings"><BartLogo size={110} resolvedActivity="list" resolvedPhase="running" />
        <span>设置层 / 透明合成</span><b data-occlusion>设置</b></aside>
      <div className="isolation-reply"><BartLogo size={145} />
        <BartReplyBadge excerpt="这是静态未读提醒，点击后进入对应答复。" onOpen={noAction} /></div>
      <canvas className="isolation-scene" ref={output} hidden />
      <div className="isolation-negative"><canvas width="160" height="36" data-negative /><span>主线程动画对照</span></div>
      <footer><button onClick={() => void globals.bartIsolation?.prepare()}>准备资源</button>
        <button onClick={() => void globals.bartIsolation?.play()}>开始演出</button>
        <button onClick={() => globals.bartIsolation?.block(5000)}>阻塞主线程 5 秒</button>
        <button onClick={() => globals.bartIsolation?.release()}>交还页面</button></footer>
    </div>
  </RendererCapabilitiesProvider>
}
createRoot(document.getElementById('root')!).render(<AppI18nProvider locale="zh-CN">{location.search.includes('overview-regressions') ? <OverviewRegressions /> : location.search.includes('message') ? <MessageIsolation /> : location.search.includes('settings') ? <SettingsIsolation /> : location.search.includes('camera') ? <CameraIsolation /> : location.search.includes('production') ? <ProductionIsolation /> : location.search.includes('cross-page') ? <CrossPageIsolation /> : <IsolationLab />}</AppI18nProvider>)
