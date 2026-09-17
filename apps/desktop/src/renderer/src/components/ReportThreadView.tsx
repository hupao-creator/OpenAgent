import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  CircleAlert,
  FileText,
  Minimize2,
  Settings
} from 'lucide-react'
import type { RendererReport } from '../../../shared/renderer-state-contracts'
import { useI18n } from '@openagent/plugin-kit/renderer'

interface ReportThreadViewProps {
  report: RendererReport
  /** 宿主浮层显示时把原生报告 view 收缩到零面积，保留其临时页面状态。 */
  suppressed: boolean
  onBack: () => void
  onSettings: (event: React.MouseEvent<HTMLButtonElement>) => void
}

function formatReportUpdatedTime(
  updatedAt: number,
  now: number,
  locale: string
): string {
  const elapsed = Math.max(0, now - updatedAt)
  if (elapsed < 60_000) return locale === 'en-US' ? 'just now' : '刚刚'
  if (elapsed < 3_600_000) {
    const minutes = Math.floor(elapsed / 60_000)
    return locale === 'en-US' ? `${minutes}m ago` : `${minutes} 分钟前`
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(updatedAt)
}

const HIDDEN_BOUNDS = { x: 0, y: 0, width: 0, height: 0 }

export function ReportThreadView(props: ReportThreadViewProps): React.JSX.Element {
  const { locale, t } = useI18n()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [failure, setFailure] = useState('')
  const reportId = props.report.id
  const updatedAt = props.report.updatedAt
  const suppressed = props.suppressed

  const surfaceBounds = useCallback((): DOMRect | undefined => {
    return surfaceRef.current?.getBoundingClientRect()
  }, [])

  // 打开或按最新持久化 HTML 重新加载。updatedAt 变化即重载，页面临时状态不保留。
  useLayoutEffect(() => {
    const rect = surfaceBounds()
    if (!rect) return
    setFailure('')
    const bounds = suppressed
      ? HIDDEN_BOUNDS
      : { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    void window.openAgent.openReportRuntime(reportId, bounds).catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : String(error))
    })
    // suppressed 只影响可见矩形，不重新加载报告，因此不进依赖。
  }, [reportId, surfaceBounds, updatedAt])

  useEffect(() => () => {
    void window.openAgent.closeReportRuntime().catch(() => undefined)
  }, [])

  useEffect(() => window.openAgent.onReportRuntimeFailure((event) => {
    if (event.reportId !== reportId) return
    setFailure(event.message)
    void window.openAgent.closeReportRuntime().catch(() => undefined)
  }), [reportId])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const sync = (): void => {
      const rect = surface.getBoundingClientRect()
      void window.openAgent.setReportRuntimeBounds(
        suppressed
          ? HIDDEN_BOUNDS
          : { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      ).catch(() => undefined)
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(surface)
    window.addEventListener('resize', sync)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [reportId, suppressed])

  return (
    <div className="workspace report-workspace">
      <header className="workspace-header">
        <div className="header-leading">
          <div className="report-heading">
            <FileText size={14} aria-hidden="true" />
            <strong>{props.report.title}</strong>
            <span className="heading-separator" aria-hidden="true" />
            <span className="cwd-label">{t('更新于 {time}', {
              time: formatReportUpdatedTime(updatedAt, Date.now(), locale)
            })}</span>
          </div>
        </div>
        <div className="header-actions no-drag">
          <button type="button" className="icon-button" title={t('返回俯瞰')} aria-label={t('返回俯瞰')} onClick={props.onBack}>
            <Minimize2 size={15} />
          </button>
          <button className="icon-button" data-settings-trigger onClick={props.onSettings} title={t('设置（⌘/Ctrl ,）')}>
            <Settings size={15} />
          </button>
        </div>
      </header>
      <div className="report-workspace-body">
        <div className="report-runtime-surface" ref={surfaceRef} aria-label={t('报告 {title}', { title: props.report.title })}>
          {failure && (
            <div className="report-runtime-unavailable" role="alert">
              <CircleAlert size={18} aria-hidden="true" />
              <strong>{props.report.title}</strong>
              <p>{t('报告暂时无法显示：{error}', { error: failure })}</p>
              <p>{t('返回俯瞰后重新打开即可重试；报告本身没有被修改。')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
