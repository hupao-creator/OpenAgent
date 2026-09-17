import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { HarnessThreadOverviewCard } from '../../../src/renderer/src/components/ConversationOverview'
import { BartThreadGenerations, bartGenerationThreadTarget, type BartGenerationWork } from '../../../src/renderer/src/components/BartThreadGeneration'
import { BartDock } from '../../../src/renderer/src/components/BartDock'
import { getOverviewCameraCockpit } from '../../../src/renderer/src/overview-motion'
import { getBartSpatialRegistry } from '../../../src/renderer/src/bart-motion/registry'
import { inspectMotionRuntime } from '../../../src/renderer/src/bart-motion/worker-client'
import { projectHarnessOverviewThread } from '../../../src/renderer/src/harness-composition'
import { generationFixture } from './generation-fixtures'

const noAction = (): void => undefined
const noRequest = async (): Promise<void> => undefined

function ProductionScene() {
  const root = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null), plane = useRef<HTMLDivElement>(null)
  const [works, setWorks] = useState<readonly BartGenerationWork[]>([])
  const [hidden, setHidden] = useState<readonly string[]>([])
  const sources = useMemo(() => [0, 1].map(index => projectHarnessOverviewThread({ thread: {
    ...generationFixture(), id: `production-card-${index}`, title: index ? '视口外的接力卡片' : '生产生成流程'
  } }, 1)), [])
  const consume = useMemo(() => (key: number) => setWorks(works => works.filter(work => work.key !== key)), [])
  useEffect(() => {
    const camera = getOverviewCameraCockpit(), registry = getBartSpatialRegistry()
    const unbind = camera.bindPlane(plane.current!)
    camera.restore({ manual: true, transform: { x: 0, y: 0, scale: 1 } },
      { left: 0, top: 0, width: 780, height: 1300 }, { width: 800, height: 540, toolbarBottom: 0 })
    registry.setRoot(root.current)
    registry.registerScrollContainer(viewport.current)
    let negativeFrame = 0
    const ctx = root.current!.querySelector<HTMLCanvasElement>('[data-negative]')!.getContext('2d')!
    const draw = (now: number): void => {
      ctx.clearRect(0, 0, 160, 36); ctx.fillStyle = '#d35637'; ctx.fillRect(now / 3 % 135, 6, 25, 24)
      negativeFrame = requestAnimationFrame(draw)
    }
    negativeFrame = requestAnimationFrame(draw)
    Object.assign(window, { bartProduction: {
      start() {
        performance.clearMarks('bart-generation-ready'); performance.clearMarks('bart-generation-handoff')
        flushSync(() => setWorks([{ key: Date.now(), targets: sources.map(bartGenerationThreadTarget), controller: new AbortController() }]))
      },
      block(ms: number) { const from = performance.now(); while (performance.now() - from < ms) { /* Real sync block. */ } },
      inspect: inspectMotionRuntime,
      status() {
        return { ready: (performance.getEntriesByName('bart-generation-ready').at(-1) as PerformanceMark | undefined)?.detail,
          handoff: (performance.getEntriesByName('bart-generation-handoff').at(-1) as PerformanceMark | undefined)?.detail,
          state: root.current?.querySelector<HTMLElement>('[data-generation-state]')?.dataset.generationState,
          inert: viewport.current?.inert,
          camera: camera.live,
          cards: [...root.current!.querySelectorAll<HTMLElement>('.thread-overview-item')].map(card => ({
            rect: card.getBoundingClientRect().toJSON(), visibility: getComputedStyle(card).visibility, opacity: getComputedStyle(card).opacity
          })) }
      }
    } })
    return () => { cancelAnimationFrame(negativeFrame); unbind(); camera.dispose(); registry.registerScrollContainer(null) }
  }, [sources])
  return <RendererCapabilitiesProvider capabilities={{}}>
    <div className="isolation app-shell production-isolation" ref={root}>
      <header>生产生成流程 · 真实卡片 / 完整相机接力</header>
      <div ref={viewport} className="production-viewport">
        <div ref={plane} className="thread-overview-plane production-plane">
          <div className="production-native-reference">{Array.from({ length: 48 }, (_, index) =>
            <i key={index} style={{ background: `hsl(${index * 31 % 360} 45% 55%)`, height: `${19 + index % 5 * 7}px` }} />)}</div>
          {sources.map((source, index) => <div key={source.thread.id} style={{ position: 'absolute', display: 'grid', gridTemplateRows: '200px', width: 360, height: 200,
            top: index ? 1000 : 40, left: index ? 410 : 40 }}>
            <HarnessThreadOverviewCard source={source} columns={1} rows={1} structureKey={source.envelope.structureKey}
              availableColumns={2} index={index} totalCount={2} transitionTarget={false} generationPending={hidden.includes(source.thread.id)}
              followUpBlocked interrupt={noRequest} respond={noRequest} onOpen={noAction} onFollowUpOpen={noAction} />
          </div>)}
        </div>
      </div>
      <BartDock activityContext={{ threadKey: 'bart-production-isolation', execution: null }} threadOpen={false} sessionIdle
        inputOpen={false} inputValue="" inputDisabled bartAttachments={[]} onThreadOpenChange={noAction}
        onInputOpenChange={noAction} onInputChange={noAction} onChooseFiles={noAction} onRemoveBartAttachment={noAction}
        onSubmit={noAction} onInteractionResponse={noRequest} />
      <BartThreadGenerations overviewOpen works={works} threads={sources} onWorkConsumed={consume} onHiddenIdsChange={setHidden} />
      <div className="production-negative"><canvas width="160" height="36" data-negative /><span>主线程负对照</span></div>
    </div>
  </RendererCapabilitiesProvider>
}

export function ProductionIsolation() { return <StrictMode><ProductionScene /></StrictMode> }
