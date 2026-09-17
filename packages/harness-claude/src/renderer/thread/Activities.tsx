import { useLayoutEffect, useRef } from 'react'
import {
  AlertCircle,
  Bot,
  Check,
  CircleStop,
  LoaderCircle,
  TerminalSquare,
  Wrench
} from 'lucide-react'
import type { DeepReadonly } from '@openagent/contracts'
import { useI18n } from '@openagent/plugin-kit/renderer'
import { HarnessToolActivityGroup, ThreadActivityRow } from '@openagent/plugin-kit/renderer'
import { type ClaudeActivity } from '../../shared/state.js'
import { activityKindLabel, activityStatusLabel, type Translate } from '../labels.js'

export function ClaudeActivities(props: {
  readonly activities: readonly DeepReadonly<ClaudeActivity>[]
}): React.JSX.Element {
  const { t } = useI18n()
  const activity = props.activities[0]!
  const summaryRef = useRef<HTMLButtonElement>(null)
  const focusedRow = useRef<HTMLElement | null>(null)
  // Tracked as an owner rather than a capture: a row that is blurred without
  // being unmounted must stop holding the handoff, or a later remount would
  // steal focus the user had already moved away from.
  const trackFocus = (node: HTMLElement | null): void => {
    focusedRow.current = node
  }
  // A second adjacent activity swaps the lone row out for the group, which
  // remounts the subtree and drops focus. The group only recovers focus it
  // captured itself, so hand it the row the user was actually standing on.
  useLayoutEffect(() => {
    const node = focusedRow.current
    if (!node || node.isConnected) return
    focusedRow.current = null
    if (document.activeElement !== document.body) return
    summaryRef.current?.focus()
  })
  if (props.activities.length === 1) {
    return <ClaudeActivityDetails activity={activity} onFocusChange={trackFocus} />
  }
  const running = props.activities.some((item) => item.status === 'running')
  return <HarnessToolActivityGroup
    groupId={`claude-activities:${activity.id}`}
    summary={t('执行活动')}
    summaryLabel={activityGroupLabel(props.activities, t)}
    summaryRef={summaryRef}
    summaryState={activityGroupState(props.activities)}
    defaultExpanded={running}
    items={props.activities.map((item) => ({
      id: item.id,
      running: item.status === 'running',
      node: <ClaudeActivityDetails activity={item} onFocusChange={trackFocus} />
    }))}
  />
}

// A folded group hides every per-row glyph and status, so the summary has to
// carry the worst settled state; otherwise a failed activity reads as a plain
// wrench and screen readers hear only that work happened.
function activityGroupState(
  activities: readonly DeepReadonly<ClaudeActivity>[]
): React.JSX.Element {
  if (activities.some((item) => item.status === 'running')) {
    return <LoaderCircle className="claude-renderer-spin" size={13} />
  }
  if (activities.some((item) => item.status === 'failed')) return <AlertCircle size={13} />
  if (activities.some((item) => item.status === 'cancelled')) return <CircleStop size={13} />
  return <Wrench size={13} />
}

function activityGroupLabel(
  activities: readonly DeepReadonly<ClaudeActivity>[],
  t: Translate
): string {
  const settled = (['running', 'failed', 'cancelled'] as const).flatMap((status) => {
    const count = activities.filter((item) => item.status === status).length
    return count ? [`${count} ${activityStatusLabel(status, t)}`] : []
  })
  const label = t('Claude 执行活动')
  return settled.length ? `${label} · ${settled.join(' · ')}` : label
}

interface ClaudeActivityPresentation {
  readonly id?: string
  readonly taskId?: string
  readonly kind: ClaudeActivity['kind']
  readonly label: string
  readonly status: ClaudeActivity['status']
  readonly detail?: string
}

export function ClaudeActivityDetails(props: {
  readonly activity: DeepReadonly<ClaudeActivityPresentation>
  /** Reports the row that owns focus, or null once focus leaves the row. */
  readonly onFocusChange?: (node: HTMLElement | null) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const activity = props.activity
  const onFocusChange = props.onFocusChange
  return (
    <div
      className="claude-renderer-activity-row"
      onFocusCapture={onFocusChange
        ? (event) => onFocusChange(event.target as HTMLElement)
        : undefined}
      onBlur={onFocusChange
        ? (event) => {
            const next = event.relatedTarget
            if (next instanceof HTMLElement && event.currentTarget.contains(next)) return
            onFocusChange(null)
          }
        : undefined}
    >
      <ThreadActivityRow
        id={activity.id || activity.label}
        state={<ActivityGlyph activity={activity} />}
        label={<>
          <span title={activityKindLabel(activity.kind, t)}>{activity.label}</span>
          <small className="claude-renderer-activity-state">{activityStatusLabel(activity.status, t)}</small>
        </>}
        detail={activity.detail}
      />
    </div>
  )
}

function ActivityGlyph(props: {
  readonly activity: DeepReadonly<Pick<ClaudeActivity, 'kind' | 'status'>>
}): React.JSX.Element {
  if (props.activity.status === 'running') {
    return <LoaderCircle className="claude-renderer-spin" size={13} />
  }
  if (props.activity.status === 'failed') return <AlertCircle size={13} />
  if (props.activity.status === 'cancelled') return <CircleStop size={13} />
  if (props.activity.kind === 'command') return <TerminalSquare size={13} />
  if (props.activity.kind === 'subagent') return <Bot size={13} />
  return <Check size={13} />
}
