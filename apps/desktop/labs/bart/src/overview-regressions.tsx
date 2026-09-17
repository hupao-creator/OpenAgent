import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useStore } from 'zustand'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { ConversationOverview } from '../../../src/renderer/src/components/ConversationOverview'
import { BartThreadGenerations, bartGenerationThreadTarget } from '../../../src/renderer/src/components/BartThreadGeneration'
import { BartDock } from '../../../src/renderer/src/components/BartDock'
import { createOverviewOrchestrationStore } from '../../../src/renderer/src/overview-orchestration-store'
import { deriveOverviewItems, overviewLayoutSnapshot } from '../../../src/renderer/src/conversation-overview-layout'
import { projectHarnessOverviewThread } from '../../../src/renderer/src/harness-composition'
import { getOverviewCameraCockpit, getOverviewMotionCoordinator } from '../../../src/renderer/src/overview-motion'
import { getBartSpatialRegistry } from '../../../src/renderer/src/bart-motion/registry'
import { inspectMotionRuntime } from '../../../src/renderer/src/bart-motion/worker-client'
import { generationFixture } from './generation-fixtures'

const noop = (): void => undefined, noRequest = async (): Promise<void> => undefined
function OverviewScene() {
  const root = useRef<HTMLDivElement>(null)
  const [store] = useState(createOverviewOrchestrationStore), facts = useStore(store)
  const [count, setCount] = useState(0), [tag, setTag] = useState('')
  const fixture = useMemo(() => generationFixture(), [])
  const inputs = useMemo(() => Array.from({ length: count }, (_, index) => ({ thread: {
    ...fixture, id: `created-${index}`, createdAt: index + 1, tags: ['work'], title: `创建 Thread ${index + 1}`
  } })), [count, fixture])
  const threads = useMemo(() => inputs.map(input => projectHarnessOverviewThread(input, facts.layoutContext.availableCols)), [inputs, facts.layoutContext])
  const current = useRef({ threads, tag }); current.current = { threads, tag }
  useEffect(() => {
    const registry = getBartSpatialRegistry()
    registry.setRoot(root.current)
    Object.assign(window, { bartOverview: {
      create() {
        performance.clearMarks('bart-generation-ready'); performance.clearMarks('bart-generation-skipped')
        const previous = current.current.threads
        const next = [...previous, projectHarnessOverviewThread({ thread: { ...fixture, id: `created-${previous.length}`,
          createdAt: previous.length + 1, tags: ['work'], title: `创建 Thread ${previous.length + 1}` } }, store.getState().layoutContext.availableCols)]
        const snapshot = overviewLayoutSnapshot(deriveOverviewItems({ threads: next, transitionId: null, layoutContext: store.getState().layoutContext }))
        flushSync(() => {
          store.appendRevision({ sceneKey: current.current.tag || 'all', snapshot, generationTargets: [bartGenerationThreadTarget(next.at(-1)!)] })
          setCount(next.length)
        })
      },
      filter() { flushSync(() => setTag(value => value ? '' : 'work')) },
      block(ms: number) { const from = performance.now(); while (performance.now() - from < ms) { /* Renderer negative control. */ } },
      inspect: inspectMotionRuntime,
      status() {
        const mark = (name: string) => (performance.getEntriesByName(name).at(-1) as PerformanceMark | undefined)?.detail
        return { ready: mark('bart-generation-ready'), skipped: mark('bart-generation-skipped'),
          transform: root.current?.querySelector<HTMLElement>('.thread-overview-plane')?.style.transform,
          camera: getOverviewCameraCockpit().live, busy: getOverviewMotionCoordinator().stageBusy,
          sealed: root.current?.hasAttribute('data-bart-scene'), hidden: store.getState().hiddenIds, works: store.getState().works.length,
          viewport: root.current?.querySelector('.thread-overview-scroll')?.getBoundingClientRect().toJSON(),
          cards: [...root.current!.querySelectorAll<HTMLElement>('[data-overview-card-id]')].map(card => ({
            id: card.dataset.overviewCardId, rect: card.getBoundingClientRect().toJSON(), visibility: getComputedStyle(card).visibility,
            column: card.style.gridColumnStart, row: card.style.gridRowStart })) }
      }
    } })
    return () => { store.reset(); registry.setRoot(null) }
  }, [fixture, store])
  return <RendererCapabilitiesProvider capabilities={{}}><div className="app-shell" ref={root}>
    <ConversationOverview threads={inputs} transitionId={null} interrupt={noRequest} respond={noRequest} onSelect={noop}
      motionSceneKey={tag || 'all'} selectedTag={tag} tagFilters={[{ tag: 'work', count, isCwdTag: false }]}
      onTagChange={setTag} onGenerationMotionQueued={store.enqueue} layoutRevisions={facts.revisions}
      onLayoutRevisionsConsumed={store.consumeRevisions} generationHiddenIds={facts.hiddenIds}
      onLayoutContextChange={store.setLayoutContext} onLayoutPresented={store.setPlacements} />
    <BartDock activityContext={{ threadKey: 'bart-overview-regression', execution: null }} threadOpen={false} sessionIdle inputOpen={false}
      inputValue="" inputDisabled bartAttachments={[]} onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
      onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop} onInteractionResponse={noRequest} />
    <BartThreadGenerations overviewOpen threads={threads} works={facts.works} onWorkConsumed={store.consumeWork} orchestration={store} />
  </div></RendererCapabilitiesProvider>
}
export function OverviewRegressions() { return <StrictMode><OverviewScene /></StrictMode> }
