import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { BartDock } from '../../../src/renderer/src/components/BartDock'
import { BartCoordinatorIdentity } from '../../../src/renderer/src/components/BartCoordinatorIdentity'
import { BartCrossPageFlight, type BartFlightDirection } from '../../../src/renderer/src/components/BartCrossPageFlight'
import { inspectMotionRuntime } from '../../../src/renderer/src/bart-motion/worker-client'
import { getOverviewMotionCoordinator } from '../../../src/renderer/src/overview-motion'
import '../../../src/renderer/src/components/settings-page.css'

const noop = (): void => undefined
const noRequest = async (): Promise<void> => undefined

export function CrossPageIsolation() {
  const root = useRef<HTMLDivElement>(null)
  const [direction, setDirection] = useState<BartFlightDirection | null>(null)
  const currentDirection = useRef(direction)
  currentDirection.current = direction
  const [active, setActive] = useState(false)
  const [seat, setSeat] = useState(false)
  const destinationSeat = useRef(false)
  useEffect(() => {
    let frame = 0
    const context = root.current!.querySelector<HTMLCanvasElement>('[data-negative]')!.getContext('2d')!
    const draw = (now: number): void => {
      context.clearRect(0, 0, 160, 36); context.fillStyle = '#d35637'; context.fillRect(now / 3 % 135, 6, 25, 24)
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    Object.assign(window, { bartCrossPage: {
      fly(next: BartFlightDirection) {
        performance.clearMarks('bart-cross-page-ready')
        performance.clearMarks('bart-cross-page-skipped')
        destinationSeat.current = next === 'to-seat'
        getOverviewMotionCoordinator().cutScene('bart-cross-page')
        flushSync(() => setDirection(next))
      },
      block(ms: number) { const from = performance.now(); while (performance.now() - from < ms) { /* Real Renderer block. */ } },
      inspect: inspectMotionRuntime,
      status() { return { ready: (performance.getEntriesByName('bart-cross-page-ready').at(-1) as PerformanceMark | undefined)?.detail,
        skipped: (performance.getEntriesByName('bart-cross-page-skipped').at(-1) as PerformanceMark | undefined)?.detail,
        layout: root.current?.querySelector<HTMLElement>('.bart-dock')?.dataset.layout,
        residents: [...root.current!.querySelectorAll<HTMLElement>('.bart-logo')].map(svg => ({ ready: svg.dataset.workerReady, rect: svg.getBoundingClientRect().toJSON() })),
        flying: Boolean(root.current?.querySelector('[data-bart-cross-page-flight]')),
        sealed: root.current?.hasAttribute('data-bart-scene'),
        dockVisible: getComputedStyle(root.current!.querySelector('.bart-dock')!).visibility,
        seatVisible: getComputedStyle(root.current!.querySelector('.bart-host-character')!).visibility } }
    } })
    return () => cancelAnimationFrame(frame)
  }, [])
  return <RendererCapabilitiesProvider capabilities={{}}>
    <div ref={root} className={`isolation app-shell cross-page-isolation${seat ? ' is-seated' : ''}`}>
      <header>跨页角色身份转移 · Worker 连续状态</header>
      <div className="cross-page-seat harness-dispatch-map" style={{ visibility: seat || active ? 'visible' : 'hidden' }}>
        <div data-row="host"><BartCoordinatorIdentity harnessId="codex" handoff={null} inFlight={active}
          position={50} dispatchFeedback={null} /></div>
      </div>
      <BartDock activityContext={{ threadKey: 'bart-cross-page-isolation', execution: null }} threadOpen={false} sessionIdle inputOpen={false}
        inputValue="" inputDisabled bartAttachments={[]} onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
        onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop} onInteractionResponse={noRequest} />
      <BartCrossPageFlight direction={direction} onActiveChange={(value, finishedDirection) => {
        if (finishedDirection !== currentDirection.current) return
        setActive(value)
        if (!value) { setDirection(null); setSeat(destinationSeat.current) }
      }} />
      <div className="production-negative"><canvas width="160" height="36" data-negative /></div>
    </div>
  </RendererCapabilitiesProvider>
}
