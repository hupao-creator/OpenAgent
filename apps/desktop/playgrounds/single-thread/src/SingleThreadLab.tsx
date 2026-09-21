import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { useStore } from 'zustand'
import { OVERVIEW_CARD_GEOMETRY, overviewCardAvailableColumns } from '@openagent/contracts/renderer'
import { REPORT_CARD_SIZE } from '../../../src/renderer/src/conversation-overview-layout'
import { ReportCard } from '../../../src/renderer/src/components/ReportCard'
import { HarnessThreadOverviewCard, reportRelatedThreads } from '../../../src/renderer/src/components/ConversationOverview'
import { projectHarnessOverviewThread } from '../../../src/renderer/src/harness-composition'
import { createRendererStateStore, hydrateRendererStateStore } from '../../../src/shared/renderer-store'
import { fakeSnapshots } from './fake-snapshots'
import { harnesses, agentScenarios, combinations, reportScenarios } from './scenarios'

export function SingleThreadLab(): React.JSX.Element {
  const [store] = useState(() => createRendererStateStore(''))
  const state = useStore(store)
  const cases = fakeSnapshots
  const [loaded, setLoaded] = useState('')
  const initial = new URLSearchParams(location.search)
  const [kind, setKind] = useState(() => initial.get('kind') === 'report' ? 'report' : 'agent')
  const [harness, setHarness] = useState(() => harnesses.some(item => item.id === initial.get('harness')) ? initial.get('harness')! : 'claude')
  const [scenario, setScenario] = useState(() => initial.get('case') || 'question')
  const [reportScenario, setReportScenario] = useState(() => initial.get('kind') === 'report' ? initial.get('case') || 'summary' : 'summary')
  const [navigationId, setNavigationId] = useState('')
  const [notice, setNotice] = useState('')
  const [replay, setReplay] = useState(0)
  const [theme, setTheme] = useState(() => initial.get('theme') === 'dark' ? 'dark' : 'light')
  const [clockOrigin, setClockOrigin] = useState(Date.now)
  const stage = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(0)
  const availableColumns = overviewCardAvailableColumns(width, width <= 700 ? 28 : 128)
  const selected = cases.find(item => item.harness === (kind === 'report' ? 'report' : harness)
    && item.scenario === (kind === 'report' ? reportScenario : scenario))

  useEffect(() => {
    const node = stage.current
    if (!node) return
    const measure = (): void => setWidth(node.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    setLoaded(''); setNotice(''); setNavigationId(''); setClockOrigin(Date.now())
    if (!selected) return
    hydrateRendererStateStore(store, selected.state)
    setLoaded(selected.snapshot)
  }, [selected, store])
  useEffect(() => {
    const url = new URL(location.href)
    url.search = new URLSearchParams({ kind, harness, case: kind === 'report' ? reportScenario : scenario }).toString()
    if (theme === 'dark') url.searchParams.set('theme', 'dark')
    history.replaceState(null, '', url)
  }, [kind, harness, scenario, reportScenario, theme])
  useEffect(() => {
    document.documentElement.style.colorScheme = theme
    return () => { document.documentElement.style.removeProperty('color-scheme') }
  }, [theme])

  const capturedThread = state.agentThreads.find(({ id }) => id === (navigationId || selected?.threadId))
  // Move only the preview clock to the present; the frozen source stays immutable.
  const thread = useMemo(() => {
    const execution = capturedThread?.observation.latestExecution
    if (!capturedThread || !execution) return capturedThread
    return { ...capturedThread, observation: { ...capturedThread.observation, latestExecution: {
      ...execution, startedAt: clockOrigin - 37_000,
      ...('finishedAt' in execution ? { finishedAt: clockOrigin } : {})
    } } }
  }, [capturedThread, clockOrigin])
  const report = state.reports.find(({ id }) => id === selected?.threadId)
  const source = useMemo(() => thread ? projectHarnessOverviewThread({ thread }, availableColumns) : null, [thread, availableColumns])
  const related = useMemo(() => report ? reportRelatedThreads(report,
    new Map(state.agentThreads.map(thread => [thread.id, { thread }])), text => text) : [], [report, state.agentThreads])
  const { columns, rows } = kind === 'report' && !navigationId ? { columns: REPORT_CARD_SIZE.cols, rows: REPORT_CARD_SIZE.rows } : source?.envelope.footprint ?? { columns: 1, rows: 1 }
  const log = (action: string): void => setNotice(`${action}；快照保持不变`)

  return <RendererCapabilitiesProvider capabilities={{ openExternal: url => log(`记录打开链接：${url}`) }}><main className="single-lab">
    <header className="single-lab-header">
      <strong>Single Thread Lab</strong><span className="single-lab-note">生产卡片 · 模拟数据</span>
      <div className="single-lab-switch" role="group" aria-label="Thread 类型">
        {['agent', 'report'].map(value => <button type="button" key={value} aria-pressed={kind === value}
          onClick={() => { setKind(value); setNavigationId(''); setNotice('') }}>{value === 'agent' ? 'Agent Thread' : 'Report Thread'}</button>)}
      </div>
      <label>外观 <select aria-label="外观" value={theme} onChange={event => setTheme(event.target.value)}><option value="light">浅色</option><option value="dark">深色</option></select></label>
    </header>
    <section ref={stage} className="single-lab-stage" aria-label="单 Thread 生产卡片预览">
      {!loaded || loaded !== selected?.snapshot ? <p className="single-lab-empty">{selected ? '正在加载场景…' : '未知模拟场景，请选择下方场景'}</p> : <div className="single-lab-grid" data-snapshot={loaded} role="list" style={{
        '--thread-card-column-width': `${OVERVIEW_CARD_GEOMETRY.columnWidth}px`,
        '--thread-card-row-height': `${OVERVIEW_CARD_GEOMETRY.rowHeight}px`,
        '--thread-card-gap': `${OVERVIEW_CARD_GEOMETRY.gap}px`,
        gridTemplateColumns: `repeat(${columns}, ${OVERVIEW_CARD_GEOMETRY.columnWidth}px)`
      } as CSSProperties}>
        {kind === 'report' && !navigationId ? report ? <ReportCard key={`${loaded}:${report.id}:${replay}`} report={report} relatedThreads={related}
          index={0} totalCount={1} transitionTarget={false}
          onOpen={() => log('记录打开报告')}
          onOpenThread={(id, executionId) => { setNavigationId(id); log(`记录打开关联 Execution：${id} / ${executionId}`) }}
          onSetArchived={(_id, archived) => log(archived ? '记录归档请求' : '记录恢复请求')} /> : <p>此快照没有 Report。</p>
          : source ? <HarnessThreadOverviewCard key={`${loaded}:${source.thread.id}:${replay}`} source={source} columns={columns} rows={rows} structureKey={source.envelope.structureKey}
            availableColumns={availableColumns} index={0} totalCount={1} transitionTarget={false} generationPending={false}
            followUpBlocked={source.thread.archived || source.thread.observation.latestExecution?.status === 'waiting-for-user'}
            interrupt={async () => log('记录停止请求')}
            respond={async request => log(`记录回应：${JSON.stringify(request)}`)}
            onOpen={() => log('记录打开 Agent Thread')}
            onSetArchived={(_id, archived) => log(archived ? '记录归档请求' : '记录恢复请求')}
            onFollowUpOpen={(_id, draft = '') => log(`记录续写请求 ${draft}`)} /> : <p>此快照没有 Agent Thread。</p>}
      </div>}
    </section>
    <aside className="single-lab-controls" aria-label="实验室控制台">
      {kind === 'agent' ? <>
        <div className="single-lab-switch" role="group" aria-label="Harness">
          {harnesses.map(item => <button type="button" key={item.id} aria-pressed={harness === item.id}
            onClick={() => {
              setHarness(item.id); setNotice('')
            }}>{item.label}</button>)}
        </div>
        <div className="single-lab-switch single-lab-scenarios" role="group" aria-label="任务场景">
          {agentScenarios.map(item => <button type="button" key={item.id} aria-pressed={scenario === item.id}
            onClick={() => setScenario(item.id)}>{item.label}</button>)}
        </div>
        <div className="single-lab-switch single-lab-scenarios" role="group" aria-label="组合场景">
          {combinations.filter(item => cases.some(capture => capture.harness === harness && capture.scenario === item.id)).map(item => <button type="button" key={item.id} aria-pressed={scenario === item.id}
            onClick={() => setScenario(item.id)}>{item.label}</button>)}
        </div>
      </> : <div className="single-lab-switch" role="group" aria-label="报告场景">
        {reportScenarios.map(item => <button type="button" key={item.id} aria-pressed={reportScenario === item.id}
          onClick={() => { setReportScenario(item.id); setNavigationId('') }}>{item.label}</button>)}
      </div>}
      <div className="single-lab-footer">
        <span>模拟快照 · 布局随窗口自动调整</span>
        {navigationId ? <button type="button" onClick={() => setNavigationId('')}>返回报告</button> : null}
        <button type="button" onClick={() => { setReplay(value => value + 1); setNotice(''); setClockOrigin(Date.now()) }}>重置交互</button>
      </div>
      <output aria-live="polite">{notice}</output>
    </aside>
  </main></RendererCapabilitiesProvider>
}
