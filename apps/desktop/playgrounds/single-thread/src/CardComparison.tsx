import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AgentThreadRecord, DeepReadonly } from '@openagent/contracts'
import { OVERVIEW_CARD_GEOMETRY, overviewCardAvailableColumns } from '@openagent/contracts/renderer'
import { HarnessThreadOverviewCard } from '../../../src/renderer/src/components/ConversationOverview'
import { projectHarnessOverviewThread } from '../../../src/renderer/src/harness-composition'
import { AfterThreadCard } from './AfterThreadCard'
import './comparison.css'

export function CardComparison({ thread, snapshot, replay, record, compact, onCompactChange }: {
  thread: DeepReadonly<AgentThreadRecord>
  snapshot: string
  replay: number
  record(action: string): void
  compact: boolean
  onCompactChange(compact: boolean): void
}): React.JSX.Element {
  const before = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(736)
  useEffect(() => {
    const node = before.current
    if (!node) return
    const measure = (): void => setWidth(node.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const availableColumns = overviewCardAvailableColumns(width, 0)
  const source = useMemo(() => projectHarnessOverviewThread({ thread }, availableColumns), [thread, availableColumns])
  const { columns, rows } = source.envelope.footprint
  return <div className="card-comparison" data-comparison-snapshot={snapshot}>
    <div className="comparison-caption"><span>同一任务，同一份模拟快照</span><span>After 为设计提案</span></div>
    <div className="comparison-pair">
      <section className="comparison-side" aria-label="Before 当前生产卡片">
        <header className="comparison-label"><h2><span>01</span> Before</h2><p>当前生产卡片</p></header>
        <div className="comparison-before-stage" ref={before}>
          <div className="single-lab-grid" data-snapshot={snapshot} role="list" style={{
            '--thread-card-column-width': `${OVERVIEW_CARD_GEOMETRY.columnWidth}px`,
            '--thread-card-row-height': `${OVERVIEW_CARD_GEOMETRY.rowHeight}px`,
            '--thread-card-gap': `${OVERVIEW_CARD_GEOMETRY.gap}px`,
            gridTemplateColumns: `repeat(${columns}, ${OVERVIEW_CARD_GEOMETRY.columnWidth}px)`
          } as CSSProperties}>
            <HarnessThreadOverviewCard key={`${snapshot}:${replay}`} source={source} columns={columns} rows={rows}
              structureKey={source.envelope.structureKey} availableColumns={availableColumns} index={0} totalCount={1}
              transitionTarget={false} generationPending={false}
              followUpBlocked={thread.archived || thread.observation.latestExecution?.status === 'waiting-for-user'}
              interrupt={async () => record('记录停止请求')} respond={async request => record(`记录回应：${JSON.stringify(request)}`)}
              onOpen={() => record('记录打开 Agent Thread')}
              onSetArchived={(_id, archived) => record(archived ? '记录归档请求' : '记录恢复请求')}
              onFollowUpOpen={() => record('记录续写请求')} />
          </div>
        </div>
      </section>
      <section className="comparison-side comparison-side-after" aria-label="After 状态优先卡片">
        <header className="comparison-label"><h2><span>02</span> After</h2><p>状态与下一步</p></header>
        <AfterThreadCard key={`${snapshot}:${replay}`} thread={thread} compact={compact} record={record} />
        <div className="comparison-density" role="group" aria-label="After 信息层级">
          <button type="button" aria-pressed={!compact} onClick={() => onCompactChange(false)}>聚焦</button>
          <button type="button" aria-pressed={compact} onClick={() => onCompactChange(true)}>概览</button>
        </div>
      </section>
    </div>
    <p className="comparison-footnote">点击卡片或回答问题，仅记录模拟操作。</p>
  </div>
}
