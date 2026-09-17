import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { isJsonValue, type AgentThreadRecord } from '@openagent/contracts'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { generationFixture } from './generation-fixtures'
import { parseClaudeThreadState } from '../../../../../packages/harness-claude/src/shared/state'
import { decodeCodexState } from '../../../../../packages/harness-codex/src/shared/state'
import { HarnessThreadOverviewCard } from '../../../src/renderer/src/components/ConversationOverview'
import { projectHarnessOverviewThread } from '../../../src/renderer/src/harness-composition'
import { BartDock } from '../../../src/renderer/src/components/BartDock'
import { BartThreadGenerations, bartGenerationThreadTarget, bartGenerationReportTarget, type BartGenerationWork } from '../../../src/renderer/src/components/BartThreadGeneration'
import { ReportCard } from '../../../src/renderer/src/components/ReportCard'
import type { RendererReport } from '../../../src/shared/renderer-state-contracts'
import { getOverviewMotionCoordinator } from '../../../src/renderer/src/overview-motion'

const noop = () => {}
const noRequest = async () => {}
const longText = '检查最新的任务内容与卡片边界。This paragraph wraps across multiple lines. '.repeat(30)

function fixtures(): AgentThreadRecord[] {
  const codex = generationFixture()
  const codexState = decodeCodexState(codex.sessionState)
  codexState.turns[0] = { ...codexState.turns[0]!, messages: [{
    ...codexState.turns[0]!.messages[0]!, content: longText
  }] }
  const at = codex.createdAt
  const claudeState = parseClaudeThreadState({ version: 1, primarySessionId: 'fixture-claude',
    turns: [{ executionId: 'fixture-claude-run', createdAt: at, updatedAt: at, status: 'running',
      prompts: [longText], promptAttachments: [[]], text: '', reasoning: '', plan: [], activities: [],
      interactions: [], notices: [], timeline: [] }], nativeNotifications: [], runtime: { model: 'Claude fixture' }
  })
  if (!isJsonValue(codexState) || !isJsonValue(claudeState)) throw new Error('Invalid fixture')
  return [{ ...codex, sessionState: codexState }, {
    ...codex, id: 'claude-generation', harnessId: 'claude', title: 'Claude 卡片完整性',
    settings: {}, sessionState: claudeState, observation: {
      latestExecution: { executionId: 'fixture-claude-run', startedAt: at, status: 'running' }, backgroundWork: null
    }
  }, { ...codex, id: 'pi-generation', harnessId: 'pi', title: 'Pi 卡片完整性', settings: {},
    sessionState: { version: 1, messages: [{ id: 'pi-prompt', executionId: 'pi-run', role: 'user', text: longText }],
      executions: [], latestExecutionId: null }, observation: { latestExecution: null, backgroundWork: null } }]
}

/** Deterministic production regression surface; no native CLI, IPC or account. */
export function GenerationRegressions(): React.JSX.Element {
  const [threads, setThreads] = useState(fixtures)
  const [works, setWorks] = useState<readonly BartGenerationWork[]>([])
  const [hidden, setHidden] = useState<readonly string[]>([])
  const [expanded, setExpanded] = useState(false)
  const [scale, setScale] = useState(1)
  const root = useRef<HTMLDivElement>(null), grid = useRef<HTMLDivElement>(null)
  const sources = useMemo(() => threads.map(thread => projectHarnessOverviewThread({ thread }, 2)), [threads])
  const report: RendererReport = useMemo(() => ({ id: 'generation-report', title: 'Report preview',
    previewText: longText, createdAt: 1, updatedAt: 1, archived: false,
    tags: [], relatedExecutions: [] }), [])
  const consume = useCallback(() => setWorks([]), [])
  const originalStructure = useRef(sources[1]!.envelope.structureKey)
  useLayoutEffect(() => {
    const coordinator = getOverviewMotionCoordinator()
    coordinator.setCameraView(true, { x: 0, y: 0, scale })
    coordinator.syncPlaneGeometry(root.current!, grid.current!)
    return () => { coordinator.cutScene(); coordinator.resetPlaneGeometry() }
  }, [scale])
  const start = (): void => {
    const controller = new AbortController()
    setWorks([{ key: Date.now(), targets: [...sources.map(bartGenerationThreadTarget), bartGenerationReportTarget(report)],
      controller }])
  }
  const update = (content: boolean): void => setThreads(previous => previous.map(thread => {
    if (thread.harnessId !== 'claude') return thread
    const state = parseClaudeThreadState(thread.sessionState)
    if (content) {
      const answer = state.turns[0]!.timeline.find(item => item.kind === 'assistant' && item.id === 'updated-answer')
      if (answer?.kind === 'assistant') answer.content += ' More streamed content.'
      else state.turns[0]!.timeline.push({ kind: 'assistant', id: 'updated-answer',
        content: '最新的真实内容已经到达。Latest committed output.', status: 'streaming', createdAt: state.turns[0]!.updatedAt })
    } else state.runtime = { ...state.runtime, backgroundTasks: Array.from({ length: 7 }, (_, index) => ({
      id: `task-${index}`, description: `后台任务 ${index + 1}`, type: 'local_agent', status: 'completed'
    })) }
    if (!isJsonValue(state)) throw new Error('Invalid fixture')
    return { ...thread, revision: thread.revision + 1, sessionState: state }
  }))
  return <RendererCapabilitiesProvider capabilities={{ openExternal: noop }}>
    <nav style={{ display: 'flex', gap: 16, padding: 20 }}>
      <button onClick={start} disabled={works.length > 0}>连续生成</button>
      <button onClick={() => update(false)}>Claude 后台任务到达</button>
      <button onClick={() => update(true)}>Claude 新文本到达</button>
      <button onClick={() => setExpanded(true)}>提交卡片扩展</button>
      <button onClick={() => { getOverviewMotionCoordinator().cutScene(); setWorks([]) }}>取消动画</button>
      <label>缩放 <select value={scale} onChange={event => setScale(Number(event.target.value))}>
        <option value={0.75}>75%</option><option value={1}>100%</option><option value={1.4}>140%</option>
      </select></label>
    </nav>
    <div className="app-shell" ref={root} style={{ height: 800, position: 'relative' }}>
      <div className="thread-overview-grid" ref={grid} style={{ position: 'absolute', left: 60, top: 60,
        transform: `scale(${scale})`, transformOrigin: 'top left', '--overview-available-cols': 2,
        '--thread-card-column-width': '360px', '--thread-card-row-height': '200px', '--thread-card-gap': '16px'
      } as CSSProperties}>
        {sources.map((source, index) => <HarnessThreadOverviewCard key={source.thread.id} source={source}
          columns={index === 1 && expanded ? source.envelope.footprint.columns : 1}
          rows={index === 1 && expanded ? source.envelope.footprint.rows : 1}
          structureKey={index === 1 && !expanded ? originalStructure.current : source.envelope.structureKey}
          availableColumns={2} index={index} totalCount={4} transitionTarget={false}
          generationPending={hidden.includes(source.thread.id)} followUpBlocked={false}
          interrupt={noRequest} respond={noRequest} onOpen={noop} onFollowUpOpen={noop} />)}
        <ReportCard report={report} relatedThreads={[]} index={3} totalCount={4} transitionTarget={false}
          generationPending={hidden.includes(report.id)} onOpen={noop} onOpenThread={noop} />
      </div>
      <BartDock activityContext={{ threadKey: 'generation-regression', execution: null }} threadOpen={false}
        sessionIdle inputOpen={false} inputValue="" inputDisabled bartAttachments={[]}
        reply={{ id: 'fixture-reply', readKey: 'fixture-reply', excerpt: 'Unread reply', executionId: 'fixture' }}
        onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop} onChooseFiles={noop}
        onRemoveBartAttachment={noop} onSubmit={noop} onInteractionResponse={noRequest} />
      <BartThreadGenerations overviewOpen threads={sources} reports={[report]} works={works}
        onWorkConsumed={consume} onHiddenIdsChange={setHidden} />
    </div>
  </RendererCapabilitiesProvider>
}
