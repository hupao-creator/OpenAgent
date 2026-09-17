import { useMemo } from 'react'
import { GitBranch } from 'lucide-react'
import type { DeepReadonly, PublicInteraction } from '@openagent/contracts'
import type { HarnessRendererThreadActions, HarnessRendererThreadInput } from '@openagent/contracts/renderer'
import { isPublicExecutionActive } from '@openagent/contracts/renderer'
import { useI18n } from '@openagent/plugin-kit/renderer'
import { useReconciledSnapshot, useRendererFirstCommitDiagnostics } from '@openagent/plugin-kit/renderer'
import {
  ThreadDetailSurface,
  ThreadDocumentSummary,
  threadDocumentHeading,
  ThreadTimelineUserMessage,
  useThreadDetailVisibility,
  type ThreadDocumentRow
} from '@openagent/plugin-kit/renderer'
import { claudeBartReplyAnchor } from '../shared/bart-presentation.js'
import { type ClaudeForkHistory, type ClaudeForkHistoryItem } from '../shared/state.js'
import { claudePublicInteractionsByNativeId } from './public-interactions.js'
import { decodeThreadState } from './state.js'
import { StateError, InlineError, Markdown } from './primitives.js'
import {
  ClaudeTurnView,
  claudeTimelineRowKind,
  ClaudeAttachments,
  ClaudeReasoning,
  ClaudeForkInteraction,
  ClaudeNoticeView,
  ClaudePlanView,
  ClaudeUsageView,
  ClaudeReview,
  ClaudeContextCompaction
} from './thread/TurnView.js'
import { ClaudeBackgroundTasks, ClaudeNotifications } from './thread/Notifications.js'
import { ClaudeActivityDetails } from './thread/Activities.js'

type ThreadViewProps = HarnessRendererThreadInput & {
  readonly actions: HarnessRendererThreadActions
}

export function ClaudeThreadView(props: ThreadViewProps): React.JSX.Element {
  const { t } = useI18n()
  const decoded = useReconciledSnapshot(useMemo(() => decodeThreadState(props.thread.sessionState), [
    props.thread.sessionState
  ]))
  const executionActive = isPublicExecutionActive(props.thread.observation)
  const state = 'state' in decoded ? decoded.state : undefined
  const runtime = state?.runtime
  const latestExecution = props.thread.observation.latestExecution
  const currentTurn = latestExecution && state
    ? state.turns.findLast((turn) => turn.executionId === latestExecution.executionId)
    : undefined
  useRendererFirstCommitDiagnostics({
    threadId: props.thread.id,
    executionId: latestExecution?.executionId,
    active: executionActive,
    hasReasoning: Boolean(currentTurn?.reasoning.trim() || currentTurn?.timeline.some(
      (item) => item.kind === 'reasoning' && item.content.trim()
    )),
    hasText: Boolean(currentTurn?.text.trim() || currentTurn?.timeline.some(
      (item) => item.kind === 'assistant' && item.content.trim()
    ))
  })
  const publicInteractionsByNativeId = useMemo(
    () => state
      ? claudePublicInteractionsByNativeId(state, props.thread.observation)
      : new Map<string, PublicInteraction>(),
    [props.thread.id, props.thread.observation, state]
  )

  const runningTurnId = latestExecution?.status === 'running' && currentTurn?.status === 'running'
    ? currentTurn.executionId
    : undefined
  const rows: ThreadDocumentRow[] = []
  if ('error' in decoded) {
    rows.push({ id: 'state-error', createdAt: 0, node: <StateError message={decoded.error} /> })
  } else {
    if (decoded.state.forkHistory?.items.length) {
      rows.push({
        id: 'fork-history',
        createdAt: 0,
        node: <ClaudeForkHistoryView history={decoded.state.forkHistory} />
      })
    }
    rows.push(...decoded.state.turns.map((turn, index, turns) => ({
      id: turn.executionId,
      createdAt: turn.createdAt,
      subpage: index < turns.length - 1 ? {
        ...threadDocumentHeading(turn.prompts.find((_, promptIndex) => !turn.internalPromptIndexes?.includes(promptIndex)) || t('历史对话')),
        summary: <ThreadDocumentSummary markdown={turn.text} />,
        completedAt: turn.status === 'completed' ? turn.finishedAt : undefined
      } : undefined,
      node: <ClaudeTurnView
        actions={props.actions}
        active={runningTurnId === turn.executionId}
        waiting={latestExecution?.executionId === turn.executionId && latestExecution.status === 'waiting-for-user'}
        publicInteractionsByNativeId={publicInteractionsByNativeId}
        turn={turn}
      />
    })))
    if (runtime?.backgroundTasks?.length) {
      rows.push({
        id: 'native-background-tasks',
        createdAt: props.thread.updatedAt,
        node: <ClaudeBackgroundTasks tasks={runtime.backgroundTasks} />
      })
    }
    if (decoded.state.nativeNotifications.length) {
      rows.push({
        id: 'native-notifications',
        createdAt: props.thread.updatedAt,
        node: <ClaudeNotifications notifications={decoded.state.nativeNotifications} />
      })
    }
  }

  return (
    <section className="claude-renderer-thread" aria-label={t('Claude Thread 内容')}>
      <ThreadDetailSurface
        readingTarget={props.readingTarget ? {
          requestId: props.readingTarget.requestId,
          rowId: state?.turns.some(turn => turn.executionId === props.readingTarget?.executionId)
            ? (props.readingTarget.mode === 'current' ? undefined : props.readingTarget.executionId) : null,
          anchorId: state ? claudeBartReplyAnchor(state, props.readingTarget.message) : undefined
        } : undefined}
        threadId={props.thread.id}
        title={props.thread.title}
        icon={props.thread.emoji}
        rows={rows}
        running={latestExecution?.status === 'running'}
        runningTurnId={runningTurnId}
        actions={<>
          {runtime?.backgroundTasks?.length ? (
            <span className="claude-renderer-background-count">
              {t('{count} 个后台任务', { count: runtime.backgroundTasks.length })}
            </span>
          ) : null}
        </>}
      />
    </section>
  )
}

/**
 * Plugin-private, read-only provenance. It is displayed before this Thread's
 * turns and deliberately has neither a Core execution id nor live controls.
 */
function ClaudeForkHistoryView(props: {
  readonly history: DeepReadonly<ClaudeForkHistory>
}): React.JSX.Element {
  const { t } = useI18n()
  const visibility = useThreadDetailVisibility()
  const items = projectClaudeForkHistory(props.history.items)
  const finalMessages = new Set<string>()
  let lastAssistant: string | undefined
  for (const item of items) {
    if (item.kind === 'user-message') {
      if (lastAssistant) finalMessages.add(lastAssistant)
      lastAssistant = undefined
    } else if (item.kind === 'assistant') lastAssistant = item.id
  }
  if (lastAssistant) finalMessages.add(lastAssistant)
  const visibleItems = items.filter((item) => {
    if (item.kind === 'user-message') return visibility.userMessages
    const kind = claudeTimelineRowKind(item, finalMessages.has(item.id))
    return kind !== 'work' || (visibility.work && !visibility.workTurnId)
  })
  return (
    <section
      aria-label={t('来自源 Claude 会话的分支历史')}
      className="claude-renderer-fork-history"
      data-provenance="fork-history"
    >
      <header>
        <GitBranch size={13} />
        <strong>{t('来自源 Claude 会话的分支历史')}</strong>
        <small>{t('只读历史 · 不属于当前 Execution')}</small>
      </header>
      <div>
        {visibleItems.map((item) => (
          <div className={`thread-detail-row thread-detail-${claudeTimelineRowKind(item, finalMessages.has(item.id))}`} key={item.id}>
            <ClaudeForkHistoryEntry item={item} />
          </div>
        ))}
      </div>
    </section>
  )
}

function projectClaudeForkHistory(
  items: readonly DeepReadonly<ClaudeForkHistoryItem>[]
): readonly DeepReadonly<ClaudeForkHistoryItem>[] {
  const replaceKinds = new Set<ClaudeForkHistoryItem['kind']>([
    'plan',
    'usage',
    'review'
  ])
  const lastIndexes = new Map<ClaudeForkHistoryItem['kind'], number>()
  items.forEach((item, index) => {
    if (replaceKinds.has(item.kind)) lastIndexes.set(item.kind, index)
  })
  return items.filter((item, index) =>
    item.kind !== 'diff' && (!replaceKinds.has(item.kind) || lastIndexes.get(item.kind) === index)
  )
}

function ClaudeForkHistoryEntry(props: {
  readonly item: DeepReadonly<ClaudeForkHistoryItem>
}): React.JSX.Element | null {
  const { t } = useI18n()
  const item = props.item
  if (item.kind === 'user-message') {
    return (
      <ThreadTimelineUserMessage
        id={item.id}
        steeringLabel={t('你')}
        attachments={item.attachments?.length ? <ClaudeAttachments attachments={item.attachments} /> : null}
      >
        <Markdown content={item.content} streaming={false} />
      </ThreadTimelineUserMessage>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <article className="claude-renderer-fork-message assistant" data-status={item.status}>
        <small>OpenAgent</small>
        <Markdown content={item.content} streaming={false} />
        {item.status === 'failed' ? <em>{t('失败')}</em> : null}
        {item.status === 'cancelled' ? <em>{t('已取消')}</em> : null}
      </article>
    )
  }
  if (item.kind === 'reasoning') {
    return <ClaudeReasoning content={item.content} running={false} />
  }
  if (item.kind === 'activity') {
    return <ClaudeActivityDetails activity={item.activity} />
  }
  if (item.kind === 'interaction') {
    return <ClaudeForkInteraction interaction={item.interaction} />
  }
  if (item.kind === 'notice') return <ClaudeNoticeView notice={item.notice} />
  if (item.kind === 'plan') {
    return <ClaudePlanView explanation={item.explanation} steps={item.plan} />
  }
  if (item.kind === 'error') return <InlineError message={item.message} />
  if (item.kind === 'usage') return <ClaudeUsageView usage={item.usage} />
  if (item.kind === 'review') {
    return <ClaudeReview content={item.content} />
  }
  return item.kind === 'context-compaction' ? <ClaudeContextCompaction /> : null
}
