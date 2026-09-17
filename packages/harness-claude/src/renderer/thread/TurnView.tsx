import { memo, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  Check,
  Circle,
  CircleStop,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  Minimize2
} from 'lucide-react'
import type { DeepReadonly, PublicInteraction } from '@openagent/contracts'
import type { HarnessRendererThreadActions } from '@openagent/contracts/renderer'
import { useI18n } from '@openagent/plugin-kit/renderer'
import {
  ThreadDetailTurn,
  ThreadTokenUsage,
  ThreadSurfaceDisclosure,
  ThreadSurfacePlan,
  ThreadSurfacePlanRow,
  ThreadTimelineAttachment,
  ThreadTimelineAttachments,
  ThreadTimelineUserMessage,
  type ThreadDetailRow
} from '@openagent/plugin-kit/renderer'
import {
  type ClaudeActivity,
  type ClaudeForkHistoryInteraction,
  type ClaudeForkHistoryItem,
  type ClaudeInputAttachment,
  type ClaudeInteraction,
  type ClaudeNotice,
  type ClaudePlanStep,
  type ClaudeTimelineItem,
  type ClaudeTurn,
  type ClaudeUsage
} from '../../shared/state.js'
import { claudeActivityRunStarts, projectClaudeTimeline } from '../../shared/timeline.js'
import { errorMessage } from '../values.js'
import { InlineError, Markdown } from '../primitives.js'
import { ClaudeActivities } from './Activities.js'
import { turnStatusLabel, resolvedInteractionStatusLabel, type Translate } from '../labels.js'
import { ClaudeInteractionPanel } from './InteractionPanel.js'

export const ClaudeTurnView = memo(function ClaudeTurnView(props: {
  readonly active: boolean
  readonly waiting: boolean
  readonly actions: HarnessRendererThreadActions
  readonly publicInteractionsByNativeId: ReadonlyMap<string, PublicInteraction>
  readonly turn: ClaudeTurn
}): React.JSX.Element {
  const { t } = useI18n()
  const turn = props.turn
  const [forkingCheckpoint, setForkingCheckpoint] = useState<string>()
  const [forkError, setForkError] = useState<string>()
  const timeline = projectClaudeTimeline(turn)
  const referencedPrompts = new Set(timeline.flatMap((item) =>
    item.kind === 'user-message' ? [item.promptIndex] : []
  ))
  const referencedActivities = new Set(timeline.flatMap((item) =>
    item.kind === 'activity' ? [item.activity.id] : []
  ))
  const referencedInteractions = new Set(timeline.flatMap((item) =>
    item.kind === 'interaction' ? [item.interaction.id] : []
  ))
  const referencedNotices = new Set(timeline.flatMap((item) =>
    item.kind === 'notice' ? [item.notice.id] : []
  ))
  const timelineKinds = new Set(timeline.map((item) => item.kind))

  const forkFromCheckpoint = async (checkpointId: string): Promise<void> => {
    if (forkingCheckpoint) return
    setForkingCheckpoint(checkpointId)
    setForkError(undefined)
    try {
      await props.actions.forkThread({ checkpointId })
    } catch (cause) {
      setForkError(errorMessage(cause))
    } finally {
      setForkingCheckpoint(undefined)
    }
  }
  // Claude has no final channel. Keep its latest non-empty answer visible
  // while it streams, retaining earlier commentary under execution details.
  const finalMessageId = !props.waiting
    ? timeline.findLast((item) => item.kind === 'assistant' && item.content.trim())?.id
    : undefined
  const rows: ThreadDetailRow[] = []
  // Boundaries come from the original timeline, not the projected one: hidden
  // internal prompts and projected-away entries both interrupt a run of work,
  // but only the original timeline records that they were ever there.
  const runStarts = claudeActivityRunStarts(turn)
  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index]!
    if (item.kind === 'activity') {
      const activities: ClaudeActivity[] = []
      let next = index
      while (timeline[next]?.kind === 'activity') {
        const reference = timeline[next]!
        if (reference.kind === 'activity') {
          if (next > index && runStarts.has(reference.id)) break
          activities.push(reference.activity)
        }
        next += 1
      }
      rows.push({ id: item.id, kind: 'work', node: <ClaudeActivities activities={activities} /> })
      index = next - 1
      continue
    }
    if (item.kind === 'user-message' && turn.internalPromptIndexes?.includes(item.promptIndex)) {
      continue
    }
    rows.push({
      id: item.id,
      kind: claudeTimelineRowKind(item, item.id === finalMessageId),
      node: <ClaudeTimelineEntry
        actions={props.actions}
        active={props.active}
        busyCheckpoint={forkingCheckpoint}
        item={item}
        onFork={forkFromCheckpoint}
        publicInteractionsByNativeId={props.publicInteractionsByNativeId}
        turn={turn}
      />
    })
  }
  const append = (id: string, kind: ThreadDetailRow['kind'], node: ReactNode): void => {
    rows.push({ id: `${turn.executionId}:unreferenced:${id}`, kind, node })
  }
  turn.prompts.forEach((prompt, index) => {
    if (referencedPrompts.has(index) || turn.internalPromptIndexes?.includes(index)) return
    append(`prompt:${index}`, 'user', <ClaudeUserPrompt
      attachments={turn.promptAttachments[index]!}
      busyCheckpoint={forkingCheckpoint}
      content={prompt}
      index={index}
      onFork={forkFromCheckpoint}
    />)
  })
  if (!timelineKinds.has('reasoning') && turn.reasoning) {
    append('reasoning', 'work', <ClaudeReasoning content={turn.reasoning} running={props.active} />)
  }
  if (!timelineKinds.has('assistant') && turn.text) {
    append('assistant', props.waiting ? 'work' : 'content',
      <ClaudeAssistantMessage content={turn.text} streaming={props.active} />)
  }
  if (forkError) append('fork-error', 'attention', <InlineError message={forkError} />)
  if (!timelineKinds.has('plan') && turn.plan.length) {
    append('plan', 'work', <ClaudePlanView explanation={turn.planExplanation} steps={turn.plan} />)
  }
  const activities = turn.activities.filter((activity) => !referencedActivities.has(activity.id))
  if (activities.length) {
    append('activities', 'work', <ClaudeActivities activities={activities} />)
  }
  turn.interactions.filter((interaction) => !referencedInteractions.has(interaction.id))
    .forEach((interaction) => append(`interaction:${interaction.id}`,
      interaction.status === 'pending' ? 'attention' : 'work',
      <ClaudeInteractionEntry
        actions={props.actions}
        interaction={interaction}
        publicInteraction={props.publicInteractionsByNativeId.get(interaction.id)}
      />))
  turn.notices.filter((notice) => !referencedNotices.has(notice.id))
    .forEach((notice) => append(`notice:${notice.id}`, notice.level === 'info' ? 'work' : 'attention',
      <ClaudeNoticeView notice={notice} />))
  if (!timelineKinds.has('error') && turn.error) {
    append('error', 'attention', <InlineError message={turn.error} />)
  }
  if (!timelineKinds.has('usage') && turn.usage) {
    append('usage', 'work', <ClaudeUsageView usage={turn.usage} />)
  }
  if (!timelineKinds.has('review') && turn.review) {
    append('review', 'content', <ClaudeReview content={turn.review} />)
  }
  if (!timelineKinds.has('context-compaction') && turn.compacted) {
    append('context-compaction', 'work', <ClaudeContextCompaction />)
  }
  return <ThreadDetailTurn
    id={turn.executionId}
    active={props.active}
    createdAt={turn.createdAt}
    updatedAt={turn.finishedAt ?? turn.updatedAt}
    completedAt={turn.status === 'completed' ? turn.finishedAt : undefined}
    usage={<ThreadTokenUsage
      input={turn.usage?.inputTokens !== undefined && turn.usage.cachedTokens !== undefined && turn.usage.cacheWriteTokens !== undefined
        ? turn.usage.inputTokens + turn.usage.cachedTokens + turn.usage.cacheWriteTokens : undefined}
      output={turn.usage?.outputTokens}
      cached={turn.usage?.cachedTokens}
      cacheWrite={turn.usage?.cacheWriteTokens}
      reasoning={turn.usage?.reasoningTokens}
    />}
    status={props.waiting ? t('等待你的响应') : turn.statusLabel || turnStatusLabel(turn.status, t)}
    rows={rows}
  />
})

export function claudeTimelineRowKind(
  item: DeepReadonly<ClaudeTimelineItem | ClaudeForkHistoryItem>,
  finalAssistant: boolean
): ThreadDetailRow['kind'] {
  if (item.kind === 'user-message') return 'user'
  if (item.kind === 'assistant') return finalAssistant ? 'content' : 'work'
  if (item.kind === 'interaction') return item.interaction.status === 'pending' ? 'attention' : 'work'
  if (item.kind === 'error') return 'attention'
  if (item.kind === 'notice') return item.notice.level === 'info' ? 'work' : 'attention'
  if (item.kind === 'review') return 'content'
  return 'work'
}

function ClaudeTimelineEntry(props: {
  readonly active: boolean
  readonly actions: HarnessRendererThreadActions
  readonly busyCheckpoint?: string
  readonly item: ClaudeTimelineItem
  readonly publicInteractionsByNativeId: ReadonlyMap<string, PublicInteraction>
  readonly turn: ClaudeTurn
  onFork(checkpointId: string): Promise<void>
}): React.JSX.Element | null {
  const item = props.item
  if (item.kind === 'user-message') {
    if (props.turn.internalPromptIndexes?.includes(item.promptIndex)) return null
    const content = props.turn.prompts[item.promptIndex]
    const attachments = props.turn.promptAttachments[item.promptIndex]
    if (content === undefined || attachments === undefined) return null
    return (
      <ClaudeUserPrompt
        attachments={attachments}
        busyCheckpoint={props.busyCheckpoint}
        checkpointId={item.checkpointId}
        content={content}
        index={item.promptIndex}
        onFork={props.onFork}
      />
    )
  }
  if (item.kind === 'assistant') {
    return <ClaudeAssistantMessage content={item.content} streaming={props.active && item.status === 'streaming'} />
  }
  if (item.kind === 'reasoning') {
    return (
      <ClaudeReasoning
        content={item.content}
        running={item === props.turn.timeline.at(-1) && props.active}
      />
    )
  }
  if (item.kind === 'interaction') {
    return (
      <ClaudeInteractionEntry
        actions={props.actions}
        interaction={item.interaction}
        publicInteraction={props.publicInteractionsByNativeId.get(item.interaction.id)}
      />
    )
  }
  if (item.kind === 'notice') {
    return <ClaudeNoticeView notice={item.notice} />
  }
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

function ClaudeUserPrompt(props: {
  readonly attachments: readonly ClaudeInputAttachment[]
  readonly busyCheckpoint?: string
  readonly checkpointId?: string
  readonly content: string
  readonly index: number
  onFork(checkpointId: string): Promise<void>
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <ThreadTimelineUserMessage
      id={`claude-prompt:${props.checkpointId || props.index}`}
      steeringLabel={props.index === 0 ? t('你') : t('补充')}
      attachments={props.attachments.length ? <ClaudeAttachments attachments={props.attachments} /> : null}
    >
      <Markdown content={props.content} streaming={false} />
      {props.checkpointId ? (
        <button
          className="claude-renderer-checkpoint-fork"
          disabled={Boolean(props.busyCheckpoint)}
          onClick={() => void props.onFork(props.checkpointId!)}
          type="button"
        >
          {props.busyCheckpoint === props.checkpointId
            ? <LoaderCircle className="claude-renderer-spin" size={11} />
            : <GitBranch size={11} />}
          {t('从此处分支')}
        </button>
      ) : null}
    </ThreadTimelineUserMessage>
  )
}

export function ClaudeAttachments(props: {
  readonly attachments: readonly DeepReadonly<ClaudeInputAttachment>[]
}): React.JSX.Element {
  return (
    <ThreadTimelineAttachments>
      {props.attachments.map((attachment) => (
        <ThreadTimelineAttachment
          key={attachment.id}
          title={`${attachment.mimeType} · ${attachment.size} B`}
        >
          {attachment.name}
        </ThreadTimelineAttachment>
      ))}
    </ThreadTimelineAttachments>
  )
}

function ClaudeAssistantMessage(props: {
  readonly content: string
  readonly streaming: boolean
}): React.JSX.Element {
  return (
    <article className="claude-renderer-assistant-message">
      <Markdown content={props.content} streaming={props.streaming} />
    </article>
  )
}

export function ClaudeReasoning(props: {
  readonly content: string
  readonly running: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <ThreadSurfaceDisclosure label={t('推理过程')} live={props.running}>
      <Markdown content={props.content} streaming={props.running} />
    </ThreadSurfaceDisclosure>
  )
}

export function ClaudeForkInteraction(props: {
  readonly interaction: DeepReadonly<ClaudeForkHistoryInteraction>
}): React.JSX.Element {
  const { t } = useI18n()
  const interaction = props.interaction
  return (
    <article
      className="claude-renderer-fork-interaction"
      data-status={interaction.status}
    >
      <header>
        {interaction.status === 'cancelled'
          ? <CircleStop size={12} />
          : <Check size={12} />}
        <strong>{interaction.title}</strong>
        <small>{resolvedInteractionStatusLabel(interaction.status, t)}</small>
      </header>
      {interaction.description ? <p>{interaction.description}</p> : null}
      {interaction.toolName ? <code>{interaction.toolName}</code> : null}
      {interaction.questions?.length ? (
        <ul>
          {interaction.questions.map((question, index) => (
            <li key={`${index}:${question.question}`}>
              {question.header ? <small>{question.header}</small> : null}
              <span>{question.question}</span>
              {question.options.length ? (
                <em>{question.options.map((option) => option.label).join(' · ')}</em>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}

function ClaudeInteractionEntry(props: {
  readonly actions: HarnessRendererThreadActions
  readonly interaction: DeepReadonly<ClaudeInteraction>
  readonly publicInteraction?: DeepReadonly<PublicInteraction>
}): React.JSX.Element {
  const { t } = useI18n()
  const interaction = props.interaction
  return interaction.status === 'pending' ? (
    <ClaudeInteractionPanel
      actions={props.actions}
      interaction={interaction}
      publicInteraction={props.publicInteraction}
    />
  ) : (
    <div className="claude-renderer-interaction-resolved" data-status={interaction.status}>
      {interaction.status === 'cancelled'
        ? <CircleStop size={12} />
        : <Check size={12} />}
      <span>{interaction.title}</span>
      <small>{resolvedInteractionStatusLabel(interaction.status, t)}</small>
    </div>
  )
}

export function ClaudeNoticeView(props: {
  readonly notice: DeepReadonly<Pick<ClaudeNotice, 'level' | 'message'>>
}): React.JSX.Element {
  return (
    <div className={`claude-renderer-notice ${props.notice.level}`}>
      <AlertCircle size={13} />
      <span>{props.notice.message}</span>
    </div>
  )
}

export function ClaudePlanView(props: {
  readonly explanation?: string
  readonly steps: readonly DeepReadonly<ClaudePlanStep>[]
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <ThreadSurfacePlan
      label={t('计划')}
      explanation={props.explanation}
      completed={props.steps.filter((step) => step.status === 'completed').length}
      total={props.steps.length}
    >
      {props.steps.map((step, index) => (
        <ThreadSurfacePlanRow
          className={step.status}
          key={`${index}:${step.step}`}
          state={step.status === 'completed'
            ? <Check size={11} />
            : step.status === 'inProgress'
              ? <LoaderCircle className="claude-renderer-spin" size={11} />
              : <Circle size={9} />}
        >{step.step}</ThreadSurfacePlanRow>
      ))}
    </ThreadSurfacePlan>
  )
}

export function ClaudeUsageView(props: {
  readonly usage: DeepReadonly<ClaudeUsage>
}): React.JSX.Element {
  const { formatNumber, t } = useI18n()
  return (
    <div className="claude-renderer-usage">
      <strong>{t('Claude 用量')}</strong>
      <span>{usageSummary(props.usage, formatNumber, t) || '—'}</span>
    </div>
  )
}

export function ClaudeReview(props: {
  readonly content: string
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <details className="claude-renderer-artifact review" open>
      <summary>
        <GitPullRequest size={13} />
        {t('Claude 代码审查')}
      </summary>
      <Markdown content={props.content} streaming={false} />
    </details>
  )
}

export function ClaudeContextCompaction(): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="claude-renderer-context-compaction">
      <Minimize2 size={12} />
      <span>{t('Claude 上下文已压缩')}</span>
    </div>
  )
}

function usageSummary(
  usage: DeepReadonly<ClaudeUsage>,
  formatNumber: (value: number) => string,
  t: Translate
): string {
  const parts: string[] = []
  const total = usage.totalTokens ?? (
    (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.reasoningTokens || 0)
  )
  if (total) parts.push(t('{count} Claude tokens', { count: formatNumber(total) }))
  if (usage.cachedTokens) {
    parts.push(t('{count} cached', { count: formatNumber(usage.cachedTokens) }))
  }
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`)
  return parts.join(' · ')
}
