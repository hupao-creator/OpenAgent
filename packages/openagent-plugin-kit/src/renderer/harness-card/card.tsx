import {
  Fragment,
  lazy,
  Suspense,
  type CSSProperties,
  type ReactNode
} from 'react'
import {
  CheckCircle2,
  CircleAlert,
  CircleX,
  CornerDownRight,
  FileText,
  LoaderCircle,
  Search,
  Terminal,
  Wrench,
  Zap
} from 'lucide-react'
import {
  CardDerivedWork,
  CardInterventionPanel,
  CardPlanLadder,
  CardWorkflowAgents,
  CardWorkflowPhases
} from './sections.js'
import { SINGLE_CARD_SIZE } from './contracts.js'
import { useTextSwap } from './text-swap.js'
import { RollingNumberText, ThreadCardRuntime } from './metrics.js'
import type {
  ThreadCardExtensionPlacement,
  ThreadCardExtensionProjection,
  ThreadCardIdentityTool,
  ThreadCardIdentityUsage,
  ThreadCardIdentityView,
  ThreadCardInterventionHandler,
  ThreadCardPresentation,
  ThreadCardSize
} from './contracts.js'
import { useI18n } from '../i18n.js'
import { measureThreadCardExcerptEnd, useThreadCardAnchor } from './spatial-anchors.js'

const MarkdownBody = lazy(() => import('../components/MarkdownBody.js'))

/**
 * Historical provider-card content without the old Provider registry or Core
 * article shell. The concrete Plugin owns identity/status facts and actions.
 */
export function HarnessThreadCard(props: {
  readonly identity: ThreadCardIdentityView
  readonly presentation: ThreadCardPresentation
  readonly transitionTarget?: boolean
  readonly onInterventionResponse?: ThreadCardInterventionHandler
  readonly onOpenThread?: () => void
  readonly interventionDetails?: ReactNode
}): ReactNode {
  const { presentation } = props
  const identitySpan = presentation.composition.kind === 'standard'
    ? presentation.composition.identity.selectedSize
    : SINGLE_CARD_SIZE
  const identity = (
    <div
      className="thread-card-identity"
      data-identity-size={`${identitySpan.cols}x${identitySpan.rows}`}
      style={{
        gridColumn: `1 / span ${identitySpan.cols}`,
        gridRow: `1 / span ${identitySpan.rows}`
      }}
    >
      <ThreadCardIdentity
        identity={props.identity}
        projection={presentation.projection.identity}
        selectedSize={identitySpan}
        transitionTarget={props.transitionTarget === true}
      />
    </div>
  )
  if (presentation.projection.kind === 'dynamic-workflow') {
    const workflow = presentation.projection.workflow
    return (
      <div className="thread-card-layout thread-card-dynamic-workflow">
        {identity}
        <div className="thread-card-workflow-phase-cell">
          <CardWorkflowPhases phases={workflow.phases} total={workflow.phaseCount} capacity={4} />
        </div>
        <div className="thread-card-workflow-agent-cell">
          <CardWorkflowAgents rows={workflow.agents} capacity={6} />
        </div>
      </div>
    )
  }
  if (presentation.composition.kind !== 'standard') return identity
  const extensions = new Map(
    presentation.projection.extensions.map((extension) => [extension.kind, extension])
  )
  return (
    <div className="thread-card-layout">
      {identity}
      {presentation.composition.placements.map((placement) => {
        const extension = extensions.get(placement.kind)
        return extension ? (
          <ThreadCardExtension
            key={placement.kind}
            extension={extension}
            placement={placement}
            onInterventionResponse={props.onInterventionResponse}
            onOpenThread={props.onOpenThread}
            interventionDetails={props.interventionDetails}
          />
        ) : null
      })}
    </div>
  )
}

function ThreadCardExtension(props: {
  readonly extension: ThreadCardExtensionProjection
  readonly placement: ThreadCardExtensionPlacement
  readonly onInterventionResponse?: ThreadCardInterventionHandler
  readonly onOpenThread?: () => void
  readonly interventionDetails?: ReactNode
}): ReactNode {
  const { extension, placement } = props
  const style: CSSProperties = {
    gridColumn: `${placement.col + 1} / span ${placement.selectedSize.cols}`,
    gridRow: `${placement.row + 1} / span ${placement.selectedSize.rows}`,
    ...(placement.col > 0 ? { ['--thread-card-grow-x' as string]: '-16px' } : {}),
    ...(placement.row > 0 ? { ['--thread-card-grow-y' as string]: '-16px' } : {})
  }
  let content: ReactNode
  if (extension.kind === 'todo') {
    content = <CardPlanLadder steps={extension.steps} variant={placement.variant} />
  } else if (extension.kind === 'intervention') {
    content = (
      <CardInterventionPanel
        key={extension.intervention.id}
        intervention={extension.intervention}
        variant={placement.variant}
        onRespond={props.onInterventionResponse}
        onOpenThread={props.onOpenThread}
        details={props.interventionDetails}
      />
    )
  } else {
    content = (
      <CardDerivedWork
        rows={extension.rows}
        variant={placement.variant}
        capacity={extensionCapacity(placement)}
      />
    )
  }
  return (
    <section
      className={`thread-card-extension extension-${extension.kind} variant-${placement.variant}`}
      data-extension-kind={extension.kind}
      data-extension-variant={placement.variant}
      style={style}
    >
      {content}
    </section>
  )
}

function extensionCapacity(placement: ThreadCardExtensionPlacement): number {
  if (placement.kind === 'derived') return placement.selectedSize.rows > 1 ? 12 : 6
  return placement.selectedSize.rows > 1 ? 5 : 3
}

export function ThreadCardIdentity(props: {
  readonly identity: ThreadCardIdentityView
  readonly projection?: {
    readonly recentTools?: readonly ThreadCardIdentityTool[]
    readonly latestTool?: ThreadCardIdentityTool
    readonly usage?: ThreadCardIdentityUsage
  }
  readonly selectedSize: ThreadCardSize
  readonly transitionTarget?: boolean
}): React.JSX.Element {
  const expanded = props.selectedSize.rows > 1
  const identity = props.identity
  const title = useTextSwap<HTMLElement>(identity.title)
  const titleClass = [props.transitionTarget ? 'session-title-shared' : '', title.className]
    .filter(Boolean)
    .join(' ')
  return (
    <>
      <span className="thread-overview-item-head">
        <strong ref={title.ref} className={titleClass || undefined}>
          {title.content}
        </strong>
        {identity.providerStatus}
        {identity.state}
      </span>
      {identity.model || identity.effort || identity.fastMode ? (
        <small>
          {identity.model ? <span className="thread-overview-meta-model">{identity.model}</span> : null}
          {identity.effort || identity.fastMode ? (
            <>
              {identity.model ? <span className="thread-overview-meta-detail">{' \u00b7 '}</span> : null}
              <span className={'thread-overview-meta-effort' + (identity.fastMode ? ' fast' : '')}>
                {identity.fastMode ? <Zap size={10} aria-hidden="true" /> : null}
                {identity.effort}
              </span>
            </>
          ) : null}
        </small>
      ) : null}
      {identity.runtime || props.projection?.usage?.parts.length ? (
        <div className="thread-card-metrics">
          {identity.runtime ? <ThreadCardRuntime {...identity.runtime} /> : null}
          {props.projection?.usage ? <ThreadCardUsage usage={props.projection.usage} /> : null}
        </div>
      ) : null}
      {identity.steer ? (
        <span className="thread-overview-steer" title={identity.steer}>
          <CornerDownRight size={11} aria-hidden="true" />
          <span>{identity.steer}</span>
        </span>
      ) : null}
      <ThreadCardExcerpt content={identity.excerpt} />
      {expanded ? (props.projection?.recentTools ?? (props.projection?.latestTool ? [props.projection.latestTool] : []))
        .slice(-3).map((tool, index) => <ThreadCardLatestTool key={index} tool={tool} />) : null}
    </>
  )
}

/** Pure visual state row; the Plugin chooses both class and icon from its private facts. */
export function ThreadCardStateLabel(props: {
  readonly className: string
  readonly icon: ReactNode
  readonly children: ReactNode
}): React.JSX.Element {
  return (
    <span className={`thread-state ${props.className}`}>
      {props.icon}
      <span>{props.children}</span>
    </span>
  )
}

export function ThreadCardLatestTool(props: {
  readonly tool: ThreadCardIdentityTool
}): React.JSX.Element {
  const { t } = useI18n()
  const ToolIcon = props.tool.kind === 'command'
    ? Terminal
    : props.tool.kind === 'file'
      ? FileText
      : props.tool.kind === 'search'
        ? Search
        : Wrench
  const StatusIcon = props.tool.status === 'running'
    ? LoaderCircle
    : props.tool.status === 'failed'
      ? CircleX
      : props.tool.status === 'cancelled'
        ? CircleAlert
        : CheckCircle2
  return (
    <div className="thread-card-identity-tool" data-tool-status={props.tool.status}>
      <ToolIcon className="thread-card-identity-tool-kind" size={13} aria-hidden="true" />
      <strong>{props.tool.name}</strong>
      {props.tool.summary ? <span title={props.tool.summary}>{props.tool.summary}</span> : null}
      <StatusIcon
        className="thread-card-identity-tool-status"
        size={13}
        role="img"
        aria-label={t(activityStatusLabel(props.tool.status))}
      />
    </div>
  )
}

export function ThreadCardUsage(props: {
  readonly usage: ThreadCardIdentityUsage
}): React.JSX.Element | null {
  const { formatNumber, t } = useI18n()
  if (!props.usage.parts.length) return null
  return (
    <div className="thread-card-identity-usage">
      {props.usage.parts.map((part, index) => (
        <Fragment key={part.id}>
          {index > 0 ? (
            <span className="thread-card-identity-usage-divider"> · </span>
          ) : null}
          <span className="thread-card-context-usage" data-usage-suffix={part.suffix || undefined} title={part.description ? t(part.description) : undefined}
            aria-label={part.numericValue === undefined ? undefined : `${formatNumber(part.numericValue)} ${part.suffix ?? ''}`.trim()} tabIndex={0}>
            {part.label ? <span>{part.label}</span> : null}
            {part.numericValue === undefined ? part.value : (
              <RollingNumberText value={part.value} />
            )}
            {part.suffix ? <span className="thread-card-usage-suffix">{part.suffix}</span> : null}
          </span>
        </Fragment>
      ))}
    </div>
  )
}

function activityStatusLabel(status: ThreadCardIdentityTool['status']): string {
  if (status === 'running') return '运行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  return '已取消'
}

export function ThreadCardExcerpt(props: {
  readonly content: string
}): React.JSX.Element {
  const anchorRef = useThreadCardAnchor('excerpt-end', measureThreadCardExcerptEnd)
  return (
    <div className="thread-overview-excerpt" ref={anchorRef}>
      <Suspense fallback={<div className="markdown-body markdown-fallback" aria-busy="true">{props.content}</div>}>
        {/* An overview excerpt is a measured card, not a reading surface: a
            chart here would be unreadable and would perturb card height. */}
        <MarkdownBody content={props.content} streaming={false} mermaid={false} />
      </Suspense>
    </div>
  )
}

export function threadCardCwdName(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return ''
  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, '')
  if (!withoutTrailingSeparators) return trimmed
  if (/^[A-Za-z]:$/.test(withoutTrailingSeparators) && /^[A-Za-z]:[\\/]+$/.test(trimmed)) {
    return trimmed
  }
  return withoutTrailingSeparators.split(/[\\/]/).filter(Boolean).at(-1) || trimmed
}
