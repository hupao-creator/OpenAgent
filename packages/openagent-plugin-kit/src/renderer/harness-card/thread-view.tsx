import { type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useI18n } from '../i18n.js'

export function formatThreadWorkDuration(startedAt: number, endedAt: number): string {
  return formatDuration(startedAt, endedAt)
}

function formatDuration(startedAt: number, endedAt: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000))
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`
  const hours = Math.floor(elapsedSeconds / 3_600)
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60)
  const seconds = elapsedSeconds % 60
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export function ThreadSurfacePlan(props: {
  readonly className?: string
  readonly explanation?: string
  readonly label?: string
  readonly completed: number
  readonly total: number
  readonly children: ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <section className={`thread-surface-plan ${props.className || ''}`} aria-label={t('计划')}>
      <div className="thread-surface-work-heading">
        <span className="thread-surface-work-icon" aria-hidden="true"><PlanGlyph /></span>
        <strong>{props.label || t('计划')}</strong>
        <span className="thread-surface-work-count">{props.completed}/{props.total}</span>
      </div>
      {props.explanation ? <p>{props.explanation}</p> : null}
      <ol className="plan-list">{props.children}</ol>
    </section>
  )
}

/** Plan state and copy are Plugin slots; this component supplies only the historical row DOM. */
export function ThreadSurfacePlanRow(props: {
  readonly className?: string
  readonly state: ReactNode
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <li className={props.className}>
      <span className="thread-surface-step-state" aria-hidden="true">{props.state}</span>
      <span>{props.children}</span>
    </li>
  )
}

export function ThreadSurfaceDisclosure(props: {
  readonly children: ReactNode
  readonly className?: string
  readonly label: string
  readonly live?: boolean
}): React.JSX.Element {
  return (
    <details
      className={`thread-surface-disclosure ${props.className || ''}`}
      open={props.live || undefined}
    >
      <summary>
        <span className="thread-surface-work-icon" aria-hidden="true"><TraceGlyph /></span>
        <span>{props.label}</span>
        <ChevronRight className="thread-surface-disclosure-chevron" size={13} />
      </summary>
      <div className="thread-surface-disclosure-body">{props.children}</div>
    </details>
  )
}

function PlanGlyph(): React.JSX.Element {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M6.25 4h6M6.25 8h6M6.25 12h6" />
    <path d="m2.6 4 1 1 1.7-2M2.6 8l1 1 1.7-2M2.6 12l1 1 1.7-2" />
  </svg>
}

function TraceGlyph(): React.JSX.Element {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2.5 11.5c1.7 0 1.7-7 3.6-7s1.8 7 3.7 7 1.8-5 3.7-5" />
    <circle cx="2.5" cy="11.5" r=".7" fill="currentColor" stroke="none" />
    <circle cx="13.5" cy="6.5" r=".7" fill="currentColor" stroke="none" />
  </svg>
}
