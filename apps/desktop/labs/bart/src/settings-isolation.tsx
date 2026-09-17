import { useCallback, useEffect, useRef, useState } from 'react'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { HarnessSettingsPage } from '../../../src/renderer/src/components/HarnessSettingsPage'
import { BartDock } from '../../../src/renderer/src/components/BartDock'
import { BartCrossPageFlight, type BartFlightDirection } from '../../../src/renderer/src/components/BartCrossPageFlight'
import { HARNESS_IDS } from '../../../src/shared/harnesses'
import { createDefaultOpenAgentSettings, type HarnessInstallationMap, type OpenAgentSettings } from '../../../src/shared/openagent-settings'
import { inspectMotionRuntime } from '../../../src/renderer/src/bart-motion/worker-client'
import { getOverviewMotionCoordinator } from '../../../src/renderer/src/overview-motion'

const noop = (): void => undefined, noRequest = async (): Promise<void> => undefined
const installations: HarnessInstallationMap = Object.fromEntries(HARNESS_IDS.map(id => [id, { status: 'installed', executablePath: `/resolved/${id}` }]))
const resources = Object.fromEntries(HARNESS_IDS.map(id => [id, { status: 'loading' as const, reload: noRequest }]))

export function SettingsIsolation() {
  const heartbeat = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null), opener = useRef<HTMLButtonElement>(null), negative = useRef<HTMLCanvasElement>(null)
  const [open, setOpen] = useState(false), [active, setActive] = useState(false)
  const [pagePhase, setPagePhase] = useState('closed')
  const [direction, setDirection] = useState<BartFlightDirection | null>(null)
  const currentDirection = useRef(direction); currentDirection.current = direction
  const closing = useRef(false), activeRef = useRef(active); activeRef.current = active
  const probe = useRef({ delay: 0, value: installations, completed: 0 })
  const load = useCallback(async () => {
    const { delay, value } = probe.current
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    probe.current.completed++
    return value
  }, [])
  const [settings, setSettings] = useState<OpenAgentSettings>(() => { const value = createDefaultOpenAgentSettings(); return { ...value,
    harnesses: Object.fromEntries(HARNESS_IDS.map(id => [id, { useDefaultThreadSettings: false, threadSettings: {} }])),
    bart: { ...value.bart, hostHarnessPreference: 'codex' as const, targetHarnessIds: [...HARNESS_IDS] } } })
  const phaseChanged = useCallback((phase: 'opening' | 'closing' | 'open' | 'closed') => {
    setPagePhase(phase)
    if (phase === 'opening' || phase === 'closing') {
      if (phase === 'opening') closing.current = false
      getOverviewMotionCoordinator().cutScene('bart-cross-page')
      setDirection(phase === 'opening' ? 'to-seat' : 'to-dock')
    }
  }, [])
  useEffect(() => {
    const captureHeartbeat = heartbeat.current!.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(80px)' }], { duration: 500, iterations: Infinity, direction: 'alternate' })
    let frame = 0
    const context = negative.current!.getContext('2d')!
    const draw = (now: number): void => { context.clearRect(0, 0, 160, 36); context.fillStyle = '#d35637'
      context.fillRect(now / 3 % 135, 6, 25, 24); frame = requestAnimationFrame(draw) }
    frame = requestAnimationFrame(draw)
    const api = {
      probe(delay: number, missing = false) {
        probe.current = { delay, completed: 0, value: missing ? { ...installations, pi: { status: 'missing' } } : installations }
      },
      async holdStage(ms: number) {
        const lease = await getOverviewMotionCoordinator().acquireStage('settings-test-hold')
        setTimeout(() => lease.release(), ms)
      },
      act(action: string) {
        performance.clearMarks('bart-cross-page-ready'); performance.clearMarks('bart-host-ready'); performance.clearMarks('bart-dispatch-ready')
        performance.clearMarks('bart-cross-page-skipped')
        performance.mark('bart-settings-action', { detail: { action } })
        if (action === 'open') { performance.clearMarks('bart-cross-page-redirect'); opener.current!.click() }
        else if (action === 'reopen') window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, ctrlKey: true }))
        else if (action === 'close') root.current!.querySelector<HTMLButtonElement>('.settings-page [aria-label="返回"]')!.click()
        else root.current!.querySelector<HTMLButtonElement>(action === 'host' ? '[data-row="host"] [data-agent="claude"]' : '[data-row="dispatch"] [data-agent="codex"]')!.click()
      },
      block(ms: number) { const from = performance.now(); while (performance.now() - from < ms) { /* Real Renderer block. */ } },
      // Arm before the action. Readiness and the actual blocking boundary share
      // the renderer clock; Main never races a poll against a short animation.
      measure(action: string, ms: number) {
        return new Promise((resolve, reject) => {
          const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
              if (entry.name === 'bart-cross-page-skipped') {
                cleanup(); resolve({ skipped: (entry as PerformanceMark).detail }); return
              }
              if (!['bart-cross-page-ready', 'bart-host-ready', 'bart-dispatch-ready'].includes(entry.name)) continue
              cleanup()
              const ready = (entry as PerformanceMark).detail
              // Let the first compositor layer commit before blocking Host JS.
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const started = performance.now(), blockedAt = performance.timeOrigin + started
                api.block(ms)
                const ended = performance.now(), unblockedAt = performance.timeOrigin + ended
                resolve({ ready, blockedAt, unblockedAt, blockedMs: ended - started })
              }))
              return
            }
          })
          const timer = setTimeout(() => { cleanup(); reject(new Error(`Settings ${action} produced no ready/skip event`)) }, 12000)
          const cleanup = (): void => { clearTimeout(timer); observer.disconnect() }
          observer.observe({ type: 'mark' })
          api.act(action)
        })
      },
      inspect: inspectMotionRuntime,
      status() {
        const page = root.current!.querySelector<HTMLElement>('.settings-page')
        const map = page?.querySelector<HTMLElement>('.harness-dispatch-map')
        const rect = map?.getBoundingClientRect()
        const ready = ['bart-cross-page-ready', 'bart-host-ready', 'bart-dispatch-ready'].map(name => (performance.getEntriesByName(name).at(-1) as PerformanceMark | undefined)?.detail).find(Boolean)
        const host = page?.querySelector<HTMLElement>('.bart-host-character')
        return { ready, redirect: (performance.getEntriesByName('bart-cross-page-redirect').at(-1) as PerformanceMark | undefined)?.detail, phase: page?.dataset.phase, sealed: root.current?.hasAttribute('data-bart-scene'),
          active: activeRef.current, probeCompleted: probe.current.completed,
          hostVisibility: host ? getComputedStyle(host).visibility : null,
          rail: page?.querySelector<HTMLElement>('.bart-coordinator-rail')?.style.transform,
          roster: [...page?.querySelectorAll('[data-row="host"] [data-agent]') ?? []].map(item => item.getAttribute('data-agent')),
          dispatch: map?.dataset.dispatchWorker, map: rect?.toJSON(), host: page?.querySelector('[data-bart-engine]')?.getAttribute('data-bart-engine'),
          target: page?.querySelector('[data-row="dispatch"] [data-agent="codex"]')?.getAttribute('aria-checked'),
          errors: (performance.getEntriesByName('bart-cross-page-skipped').at(-1) as PerformanceMark | undefined)?.detail }
      }
    }
    Object.assign(window, { bartSettings: api })
    return () => { cancelAnimationFrame(frame); captureHeartbeat.cancel() }
  }, [])
  return <RendererCapabilitiesProvider capabilities={{}}>
    <div ref={root} className="app-shell">
      <button ref={opener} data-settings-trigger style={{ position: 'absolute', right: 32, top: 24 }} onClick={() => { closing.current = false; setOpen(true) }}>设置</button>
      <BartDock activityContext={{ threadKey: 'bart-settings-isolation', execution: null }} threadOpen={false} sessionIdle inputOpen={false}
        inputValue="" inputDisabled bartAttachments={[]} onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
        onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop} onInteractionResponse={noRequest} passiveVisible={!open} />
      <HarnessSettingsPage open={open} origin={opener.current} defaultCwd="/workspace" value={settings} resources={resources}
        activeHostHarnessId={settings.bart.hostHarnessPreference} loadHarnessInstallations={load} onSave={async value => setSettings(value)}
        bartInFlight={active} onClearHistory={noRequest} onClose={() => { closing.current = true; if (!activeRef.current) setOpen(false) }}
        onPhaseChange={phaseChanged} />
      <BartCrossPageFlight direction={direction} readyToLand={direction !== 'to-dock' || !open || pagePhase === 'closed'} onActiveChange={(value, finished) => {
        if (finished !== currentDirection.current) return
        setActive(value)
        if (!value) { setDirection(null); if (closing.current) setOpen(false) }
      }} />
    </div>
    <div ref={heartbeat} aria-hidden="true" style={{ position: 'fixed', left: 190, top: 8, width: 18, height: 24, background: '#5d8068', zIndex: 100000 }} />
    <canvas ref={negative} width="160" height="36" style={{ position: 'fixed', left: 10, top: 5, zIndex: 100000, background: '#fff' }} />
  </RendererCapabilitiesProvider>
}
