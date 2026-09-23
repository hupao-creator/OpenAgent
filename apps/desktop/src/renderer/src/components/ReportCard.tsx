import { memo, useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { Archive, ArchiveRestore, ArrowUpRight, ChevronDown, FileText } from 'lucide-react'
import type { RendererReport } from '../../../shared/renderer-state-contracts'
import { harnessDisplayName } from '../../../shared/harnesses'
import { getBartSpatialRegistry } from '../bart-motion/registry'
import { REPORT_CARD_SIZE } from '../conversation-overview-layout'
import { overviewGridPositionStyle, type OverviewGridPosition } from '../overview-layout-planner'
import { formatRelativeTime, measureThreadCardExcerptEnd, useI18n, type AppLocale } from '@openagent/plugin-kit/renderer'
import { ProviderLogo } from './ProviderLogo'

/**
 * Report Thread 的固定 1 列 × 1 行静态卡片。正文预览与关联 Agent Thread 列表
 * 同时展示（定高区域中的关联可展开滚动访问），不伪造 provider /
 * model / cwd，不展开标签 chips，也绝不在卡片里加载或执行报告 HTML。
 * 归档/恢复是卡片自带的入口，与 Bart 的硬删除语义分离。
 */
interface ReportCardProps {
  report: RendererReport
  relatedThreads: readonly ReportRelatedThread[]
  index: number
  gridPosition?: OverviewGridPosition
  totalCount: number
  transitionTarget: boolean
  /** Bart 生成动画已 attach、等待生成的卡片：渲染期保持隐藏。 */
  generationPending?: boolean
  onOpen: (reportId: string) => void
  onOpenThread: (threadId: string, executionId: string) => void
  /** 缺省时不渲染归档入口（嵌入式消费者没有这条命令）。 */
  onRender?: (id: string) => void
  onSetArchived?: (reportId: string, archived: boolean) => void
}

export interface ReportRelatedThread {
  id: string
  executionId: string
  title: string
  usage?: { readonly value: string; readonly count: number; readonly suffix: string }
  harnessId?: string
  running?: boolean
  missing?: boolean
}

/** 1×1 卡片的关联列表定高区域最多容纳 2 行，超出部分折叠成计数。 */
const MAX_VISIBLE_RELATED_THREADS = 2

export const ReportCard = memo(function ReportCard(props: ReportCardProps): React.JSX.Element {
  const { locale, formatNumber, t } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const { report } = props
  props.onRender?.(report.id)
  const updatedLabel = formatReportUpdatedTime(report.updatedAt, now, locale)
  const [expanded, setExpanded] = useState(false)
  const visibleRelatedThreads = expanded ? props.relatedThreads : props.relatedThreads.slice(0, MAX_VISIBLE_RELATED_THREADS)
  const relationsId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  // 生成动画把卡片当作飞行目标，因此报告卡与 thread 卡登记到同一个空间注册表。
  const registerMotionAnchor = useCallback(
    (element: HTMLElement | null): void => {
      getBartSpatialRegistry().registerThreadCard(report.id, element, hidden => {
        element?.classList.toggle('bart-generation-target', hidden)
      })
    },
    [report.id]
  )
  const registerExcerpt = useCallback((element: HTMLParagraphElement | null): void => {
    getBartSpatialRegistry().registerThreadAnchor(report.id, 'excerpt-end',
      element ? () => element.isConnected ? measureThreadCardExcerptEnd(element) : null : null)
  }, [report.id])
  return (
    <article
      ref={registerMotionAnchor}
      data-report-id={report.id}
      data-overview-card-id={report.id}
      role="listitem"
      onKeyDown={event => {
        if (expanded && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setExpanded(false)
          toggleRef.current?.focus()
        }
      }}
      className={
        'thread-overview-item overview-grid-card report-overview-item ' +
        (props.transitionTarget ? 'transition-target ' : '') +
        (props.generationPending ? 'bart-generation-pending ' : '') + (expanded ? 'report-relations-expanded' : '')
      }
      style={{
        '--thread-index': props.index,
        '--thread-card-cols': REPORT_CARD_SIZE.cols,
        '--thread-card-rows': REPORT_CARD_SIZE.rows,
        ...overviewGridPositionStyle(props.gridPosition)
      } as CSSProperties}
      data-card-cols={String(REPORT_CARD_SIZE.cols)}
      data-card-rows={String(REPORT_CARD_SIZE.rows)}
      data-report-archived={report.archived ? 'true' : 'false'}
      aria-posinset={props.index + 1}
      aria-setsize={props.totalCount}
    >
      <button
        type="button"
        className="thread-overview-item-open"
        aria-label={t('{title}，报告，更新于 {time}，第 {position} 项，共 {total} 项', {
          title: report.title,
          time: updatedLabel,
          position: props.index + 1,
          total: props.totalCount
        })}
        onClick={() => props.onOpen(report.id)}
      />
      <span className="thread-overview-item-head">
        <strong title={report.title}>{report.title}</strong>
        {props.onSetArchived && (
          <button
            type="button"
            className="report-overview-archive"
            aria-label={
              report.archived
                ? t('恢复报告：{title}', { title: report.title })
                : t('归档报告：{title}', { title: report.title })
            }
            title={report.archived ? t('恢复报告') : t('归档报告')}
            onClick={(event) => {
              event.stopPropagation()
              props.onSetArchived?.(report.id, !report.archived)
            }}
          >
            {report.archived
              ? <ArchiveRestore size={12} aria-hidden="true" />
              : <Archive size={12} aria-hidden="true" />}
          </button>
        )}
      </span>
      <small className="report-overview-meta">
        <span className="report-overview-kind">
          <FileText size={11} aria-hidden="true" />
          {t('报告')}
        </span>
        <span className="thread-overview-meta-detail">{' · '}</span>
        <time dateTime={new Date(report.updatedAt).toISOString()}>{updatedLabel}</time>
      </small>
      <p ref={registerExcerpt} className={'report-overview-preview' + (report.previewText ? '' : ' empty')}>
        {report.previewText}
      </p>
      <section id={relationsId} className="report-overview-relations" data-overview-native-scroll={expanded ? 'true' : undefined} aria-label={t('关联的 Agent Thread')}>
        {visibleRelatedThreads.length > 0 ? (
          <ul>
            {visibleRelatedThreads.map((thread) => (
              <li
                className={thread.missing ? 'missing' : ''}
                data-status={thread.missing ? 'missing' : thread.running ? 'running' : 'idle'}
                key={thread.id}
              >
                <button
                  type="button"
                  disabled={thread.missing}
                  aria-label={thread.missing
                    ? undefined
                    : t('打开关联 Thread：{title}', { title: thread.title })}
                  aria-describedby={thread.usage ? `${relationsId}-usage-${thread.id}` : undefined}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (!thread.missing) props.onOpenThread(thread.id, thread.executionId)
                  }}
                >
                  <span
                    className={
                      'report-overview-relation-provider' +
                      (thread.harnessId ? '' : ' missing')
                    }
                    aria-hidden="true"
                    title={thread.harnessId ? harnessDisplayName(thread.harnessId) : undefined}
                  >
                    {thread.harnessId && <ProviderLogo provider={thread.harnessId} />}
                  </span>
                  <span className="report-overview-relation-title" title={thread.title}>
                    {thread.title}
                  </span>
                  {thread.usage || thread.missing || thread.running ? (
                    <span className="report-overview-relation-tail">
                      {thread.usage ? <small id={`${relationsId}-usage-${thread.id}`} className="report-overview-relation-usage"
                        aria-label={`${formatNumber(thread.usage.count)} ${thread.usage.suffix}`.trim()}
                        title={t('输入与输出 token 合计，按 Harness 当前上报的统计范围显示')}>{thread.usage.value}</small> : null}
                      {thread.missing || thread.running ? (
                        <small>{thread.missing ? t('已删除') : t('运行中')}</small>
                      ) : null}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <small className="report-overview-relations-empty">{t('无关联 Thread')}</small>
        )}
      </section>
      <div className="report-overview-footer">
        {props.relatedThreads.length > MAX_VISIBLE_RELATED_THREADS && (
          <button type="button" className="report-overview-relations-more" ref={toggleRef} aria-controls={relationsId} aria-expanded={expanded}
            onClick={event => { event.stopPropagation(); setExpanded(value => !value) }}>
            <span>{expanded ? t('收起关联') : t('查看全部 {count} 个关联', { count: props.relatedThreads.length })}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        )}
        <span className="report-overview-open" aria-hidden="true">
          {t('打开报告')}
          <ArrowUpRight size={11} />
        </span>
      </div>
    </article>
  )
})

export function formatReportUpdatedTime(
  updatedAt: number,
  now = Date.now(),
  locale: AppLocale = 'zh-CN'
): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - updatedAt) / 1_000))
  if (elapsedSeconds < 60) {
    return locale === 'zh-CN' ? '刚刚' : formatRelativeTime(locale, 0, 'second')
  }
  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) return formatRelativeTime(locale, -minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return formatRelativeTime(locale, -hours, 'hour')
  const days = Math.floor(hours / 24)
  if (days < 7) return formatRelativeTime(locale, -days, 'day')
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(updatedAt)
}
