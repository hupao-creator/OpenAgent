import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Bot,
  Check,
  Circle,
  CircleAlert,
  FilePenLine,
  GitPullRequest,
  MessageSquare,
  Search,
  ShieldCheck,
  Terminal,
  Wrench
} from 'lucide-react'
import type {
  HarnessRendererThreadActions,
  HarnessRendererThreadInput
} from '@openagent/contracts/renderer'
import type {
  PublicInteraction,
  PublicInteractionQuestion,
  ThreadPublicObservation
} from '@openagent/contracts'
import {
  HarnessToolActivityGroup,
  useReconciledSnapshot,
  ThreadActivityRow,
  ThreadDetailRequest,
  ThreadDetailSurface,
  ThreadDocumentSummary,
  threadDocumentHeading,
  ThreadDetailTurn,
  ThreadTokenUsage,
  threadExecutionRunIds,
  type ThreadDetailRow,
  ThreadTimelineAssistantMessage,
  ThreadTimelineArtifactDisclosure,
  ThreadTimelineAttachment,
  ThreadTimelineAttachments,
  ThreadTimelineMarkdown,
  ThreadTimelineUserMessage
} from '@openagent/plugin-kit/renderer'
import {
  ThreadSurfaceDisclosure,
  ThreadSurfacePlan,
  ThreadSurfacePlanRow
} from '@openagent/plugin-kit/renderer'
import {
  InteractionQuestionField,
  useInteractionAnswers
} from '@openagent/plugin-kit/renderer'
import { useI18n } from '@openagent/plugin-kit/renderer'
import { useRendererFirstCommitDiagnostics } from '@openagent/plugin-kit/renderer'
import { codexBartReplyAnchor } from '../shared/bart-presentation.js'
import { createEmptyCodexState, decodeCodexState } from '../shared/state.js'
import type {
  CodexActivity,
  CodexHarnessState,
  CodexInteraction,
  CodexTimelineItem,
  CodexTurn
} from '../shared/types.js'
import { codexActionLabel, codexStatusLabel } from './copy.js'
import { codexPublicInteractionsByNativeId } from './public-interactions.js'
import './codex-thread-surface.css'

export function CodexThreadView({
  thread,
  actions,
  readingTarget
}: HarnessRendererThreadInput & {
  readonly actions: HarnessRendererThreadActions
}): React.JSX.Element {
  const state = useReconciledSnapshot(useMemo(() => thread.sessionState === null
    ? createEmptyCodexState(thread.createdAt)
    : decodeCodexState(thread.sessionState), [thread.sessionState, thread.createdAt]))
  const latestExecution = thread.observation.latestExecution
  const currentTurn = latestExecution
    ? state.turns.findLast((turn) => turn.executionId === latestExecution.executionId)
    : undefined
  useRendererFirstCommitDiagnostics({
    threadId: thread.id,
    executionId: latestExecution?.executionId,
    active: latestExecution?.status === 'running' || latestExecution?.status === 'waiting-for-user',
    hasReasoning: Boolean(currentTurn?.reasoning.trim() || currentTurn?.timeline.some(
      (item) => item.kind === 'reasoning' && item.content.trim()
    )),
    hasText: Boolean(currentTurn?.answer.trim() || currentTurn?.timeline.some(
      (item) => item.kind === 'assistant' && item.content.trim()
    ))
  })
  return (
    <div
      className="thread-surface thread-surface-codex"
      data-harness="codex"
      data-thread-surface-kind="codex"
    >
      <CodexNativeTimeline
        actions={actions}
        readingTarget={readingTarget}
        observation={thread.observation}
        state={state}
        threadId={thread.id}
        title={thread.title}
        emoji={thread.emoji}
      />
    </div>
  )
}

function CodexNativeTimeline(props: {
  readonly readingTarget?: HarnessRendererThreadInput['readingTarget']
  readonly actions: HarnessRendererThreadActions
  readonly observation: ThreadPublicObservation
  readonly state: CodexHarnessState
  readonly threadId: string
  readonly title: string
  readonly emoji?: string
}): React.JSX.Element {
  const { t } = useI18n()
  const [busyInteractionId, setBusyInteractionId] = useState<string>()
  const [actionError, setActionError] = useState<{ id: string; message: string }>()
  const stateRef = useRef(props.state)
  const observationRef = useRef(props.observation)
  stateRef.current = props.state
  observationRef.current = props.observation
  useEffect(() => {
    if (
      busyInteractionId &&
      !findPendingInteraction(props.state, busyInteractionId)
    ) {
      setBusyInteractionId(undefined)
    }
  }, [busyInteractionId, props.state])
  const publicInteractionsByNativeId = useMemo(
    () => codexPublicInteractionsByNativeId(props.state, props.observation),
    [props.observation, props.state]
  )
  const latestExecution = props.observation.latestExecution
  const runningTurnId = latestExecution?.status === 'running'
    ? props.state.turns.findLast((turn) => turn.executionId === latestExecution.executionId &&
      turn.status === 'running')?.executionId
    : undefined
  const respond = useCallback(async (
    interaction: CodexInteraction,
    actionId: CodexInteraction['actions'][number]['id'],
    detail?: { answers?: Record<string, string | string[]> }
  ): Promise<void> => {
    const owned = findPendingInteraction(stateRef.current, interaction.id)
    const publicInteraction = codexPublicInteractionsByNativeId(
      stateRef.current,
      observationRef.current
    ).get(interaction.id)
    if (
      !owned ||
      !publicInteraction ||
      !owned.actions.some((action) => action.id === actionId) ||
      !publicInteraction.actions.some((action) => action.id === actionId)
    ) {
      setActionError({ id: interaction.id, message: t('该 Codex 请求已失效。') })
      return
    }
    setBusyInteractionId(interaction.id)
    setActionError(undefined)
    try {
      await props.actions.respond({
        interactionId: publicInteraction.id,
        actionId,
        ...(detail?.answers ? { answers: detail.answers } : {})
      })
    } catch (error) {
      setActionError({
        id: interaction.id,
        message: error instanceof Error ? error.message : String(error)
      })
      setBusyInteractionId((current) => current === interaction.id ? undefined : current)
      console.error('Codex ThreadView response failed', error)
    }
  }, [props.actions, t])
  const rows = [
    ...[...(props.state.forkHistory ?? []), ...props.state.turns].map((turn, index, turns) => ({
      id: `turn:${turn.executionId}`,
      createdAt: turn.createdAt,
      subpage: index < turns.length - 1 ? {
        ...threadDocumentHeading(turn.messages.find((message) => message.role === 'user' && !message.internal)?.content || t('历史对话')),
        summary: <ThreadDocumentSummary markdown={turn.answer} />,
        completedAt: turn.status === 'completed' ? turn.finishedAt : undefined
      } : undefined,
      node: (
        <CodexTurnRows
          active={turn.executionId === runningTurnId}
          actionError={actionError}
          busyInteractionId={busyInteractionId}
          onRespond={respond}
          publicInteractionsByNativeId={publicInteractionsByNativeId}
          turn={turn}
        />
      )
    })),
    ...(props.state.backgroundTerminals.length
      ? [{
          id: 'codex:background-terminals',
          createdAt: props.state.updatedAt,
          node: <CodexBackgroundTerminals state={props.state} />
        }]
      : []),
    ...(props.state.nativeActivity?.status.includes('systemError')
      ? [{
          id: 'codex:system-error',
          createdAt: props.state.nativeActivity.updatedAt,
          node: (
            <div className="message-error codex-native-system-error" role="alert">
              <CircleAlert size={13} /> {t('Codex 线程发生系统错误')}
            </div>
          )
        }]
      : [])
  ]
  return (
    <ThreadDetailSurface
      readingTarget={props.readingTarget ? {
        requestId: props.readingTarget.requestId,
        inlineRowId: props.readingTarget.mode === 'current' ? `turn:${props.readingTarget.executionId}` : undefined,
        rowId: props.state.turns.some(turn => turn.executionId === props.readingTarget?.executionId)
          ? (props.readingTarget.mode === 'current' ? undefined : `turn:${props.readingTarget.executionId}`) : null,
        anchorId: codexBartReplyAnchor(props.state, props.readingTarget.message)
      } : undefined}
      rows={rows}
      running={latestExecution?.status === 'running'}
      runningTurnId={runningTurnId}
      threadId={props.threadId}
      title={props.title}
      icon={props.emoji}
    />
  )
}

export const CodexTurnRows = memo(function CodexTurnRows(props: {
  readonly active: boolean
  readonly actionError?: { readonly id: string; readonly message: string }
  readonly busyInteractionId?: string
  readonly onRespond: (
    interaction: CodexInteraction,
    actionId: CodexInteraction['actions'][number]['id'],
    detail?: { answers?: Record<string, string | string[]> }
  ) => Promise<void>
  readonly publicInteractionsByNativeId: ReadonlyMap<string, PublicInteraction>
  readonly turn: CodexTurn
}): React.JSX.Element {
  const { t } = useI18n()
  const messagesById = useMemo(() => indexById(props.turn.messages), [props.turn.messages])
  const interactionsById = useMemo(
    () => indexById(props.turn.interactions),
    [props.turn.interactions]
  )
  const noticesById = useMemo(() => indexById(props.turn.notices), [props.turn.notices])
  const activitiesById = useMemo(() => indexById(props.turn.activities), [props.turn.activities])
  const executionRunIds = useMemo(() => threadExecutionRunIds(props.turn.timeline,
    item => item.kind === 'reasoning' || item.kind === 'activity'), [props.turn.timeline])
  const lastAssistant = props.turn.timeline.findLastIndex(
    (item) => item.kind === 'assistant' && item.content.trim()
  )
  const rows: ThreadDetailRow[] = []
  for (let index = 0; index < props.turn.timeline.length; index += 1) {
    const item = props.turn.timeline[index]!
    if (item.kind === 'activity') {
      const activities: CodexActivity[] = []
      let next = index
      while (props.turn.timeline[next]?.kind === 'activity') {
        const reference = props.turn.timeline[next]!
        if (reference.kind === 'activity') {
          const activity = activitiesById.get(reference.activityId)
          if (activity) activities.push(activity)
        }
        next += 1
      }
      if (activities.length) rows.push({
        id: item.id,
        kind: 'work',
        node: <CodexToolActivityGroup
          activities={activities}
          groupId={`${props.turn.executionId}:${item.id}:tools`}
        />
      })
      index = next - 1
      continue
    }
    const node = timelineNode({
      actionError: props.actionError,
      busyInteractionId: props.busyInteractionId,
      interactionsById,
      item,
      messagesById,
      noticesById,
      onRespond: props.onRespond,
      publicInteractionsByNativeId: props.publicInteractionsByNativeId,
      t,
      turn: props.turn
    })
    if (!node) continue
    const kind: ThreadDetailRow['kind'] = item.kind === 'user-message'
      ? 'user'
      : item.kind === 'error' || (
        item.kind === 'notice' && noticesById.get(item.noticeId)?.level === 'error'
      ) || (
        item.kind === 'interaction' && interactionsById.get(item.interactionId)?.status === 'pending'
      )
        ? 'attention'
        : item.kind === 'review' || (
          item.kind === 'assistant' && props.turn.status !== 'waiting-input' && index === lastAssistant
        )
          ? 'content'
          : 'work'
    rows.push({
      id: item.id,
      node,
      kind
    })
  }
  return (
    <ThreadDetailTurn
      active={props.active}
      createdAt={props.turn.createdAt}
      id={props.turn.executionId}
      rows={rows}
      executionRunIds={executionRunIds}
      status={codexTurnStatus(props.turn, t)}
      updatedAt={props.turn.finishedAt ?? props.turn.updatedAt}
      completedAt={props.turn.status === 'completed' ? props.turn.finishedAt : undefined}
      usage={<ThreadTokenUsage
        input={props.turn.usage?.inputTokens}
        output={props.turn.usage?.outputTokens}
        cached={props.turn.usage?.cachedInputTokens}
        reasoning={props.turn.usage?.reasoningTokens}
      />}
    />
  )
})

function timelineNode(input: {
  readonly actionError?: { readonly id: string; readonly message: string }
  readonly busyInteractionId?: string
  readonly interactionsById: ReadonlyMap<string, CodexInteraction>
  readonly item: CodexTimelineItem
  readonly messagesById: ReadonlyMap<string, CodexTurn['messages'][number]>
  readonly noticesById: ReadonlyMap<string, CodexTurn['notices'][number]>
  readonly onRespond: (
    interaction: CodexInteraction,
    actionId: CodexInteraction['actions'][number]['id'],
    detail?: { answers?: Record<string, string | string[]> }
  ) => Promise<void>
  readonly publicInteractionsByNativeId: ReadonlyMap<string, PublicInteraction>
  readonly t: (source: string) => string
  readonly turn: CodexTurn
}): ReactNode {
  const item = input.item
  if (item.kind === 'user-message') {
    const message = input.messagesById.get(item.messageId)
    return message && message.internal !== true
      ? <CodexUserMessage message={message} />
      : null
  }
  if (item.kind === 'assistant') {
    if (!item.content.trim()) return null
    return (
      <ThreadTimelineAssistantMessage id={item.id}>
        {item.content ? (
          <ThreadTimelineMarkdown streaming={item.status === 'streaming'}>
            {item.content}
          </ThreadTimelineMarkdown>
        ) : null}
      </ThreadTimelineAssistantMessage>
    )
  }
  if (item.kind === 'reasoning') {
    return (
      <ThreadTimelineAssistantMessage id={item.id}>
        <CodexReasoning value={item.content} />
      </ThreadTimelineAssistantMessage>
    )
  }
  if (item.kind === 'plan') {
    return input.turn.plan.length ? <CodexPlan turn={input.turn} /> : null
  }
  if (item.kind === 'interaction') {
    const interaction = input.interactionsById.get(item.interactionId)
    const publicInteraction = interaction
      ? input.publicInteractionsByNativeId.get(interaction.id)
      : undefined
    return interaction ? (
      <ThreadTimelineAssistantMessage id={item.id}>
        <CodexInteractionPanel
          busy={input.busyInteractionId === interaction.id}
          error={input.actionError?.id === interaction.id ? input.actionError.message : undefined}
          interaction={interaction}
          onRespond={input.onRespond}
          publicInteraction={publicInteraction}
        />
      </ThreadTimelineAssistantMessage>
    ) : null
  }
  if (item.kind === 'notice') {
    const notice = input.noticesById.get(item.noticeId)
    return notice ? (
      <ThreadTimelineAssistantMessage id={item.id}>
        <div className={`message-notice ${notice.level}`}>{notice.message}</div>
      </ThreadTimelineAssistantMessage>
    ) : null
  }
  if (item.kind === 'review' && input.turn.review) {
    return (
      <ThreadTimelineAssistantMessage id={item.id}>
        <ThreadTimelineArtifactDisclosure
          className="codex-native-artifact"
          icon={<GitPullRequest size={13} />}
          title="Review"
        >
          <ThreadTimelineMarkdown>{input.turn.review}</ThreadTimelineMarkdown>
        </ThreadTimelineArtifactDisclosure>
      </ThreadTimelineAssistantMessage>
    )
  }
  if (item.kind === 'context-compaction') {
    return (
      <ThreadTimelineAssistantMessage id={item.id}>
        <div className="message-notice">{input.t('上下文已压缩')}</div>
      </ThreadTimelineAssistantMessage>
    )
  }
  if (item.kind === 'error' && input.turn.error) {
    return (
      <ThreadTimelineAssistantMessage id={item.id}>
        <div className="message-error" role="alert">
          <CircleAlert size={13} /> {input.turn.error}
        </div>
      </ThreadTimelineAssistantMessage>
    )
  }
  return null
}

function CodexUserMessage({
  message
}: {
  readonly message: CodexTurn['messages'][number]
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <ThreadTimelineUserMessage
      id={message.id}
      steeringLabel={message.kind === 'follow-up' ? t('补充') : t('你')}
      attachments={message.attachments.length ? (
        <ThreadTimelineAttachments>
          {message.attachments.map((attachment) => (
            <ThreadTimelineAttachment key={attachment.id} title={attachment.name}>
              {attachment.name}
            </ThreadTimelineAttachment>
          ))}
        </ThreadTimelineAttachments>
      ) : undefined}
    >
      <ThreadTimelineMarkdown>{message.content}</ThreadTimelineMarkdown>
    </ThreadTimelineUserMessage>
  )
}

function CodexReasoning({ value }: { readonly value: string }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <ThreadSurfaceDisclosure
      className="reasoning-block thread-surface-reasoning"
      label={t('思考过程')}
    >
      <ThreadTimelineMarkdown>{value}</ThreadTimelineMarkdown>
    </ThreadSurfaceDisclosure>
  )
}

function CodexPlan(props: {
  readonly label?: string
  readonly turn: CodexTurn
}): React.JSX.Element {
  const completed = props.turn.plan.filter((step) => step.status === 'completed').length
  return (
    <ThreadSurfacePlan
      completed={completed}
      explanation={props.turn.planExplanation}
      label={props.label}
      total={props.turn.plan.length}
    >
      {props.turn.plan.map((step, index) => (
        <ThreadSurfacePlanRow
          className={step.status}
          key={`${index}:${step.step}`}
          state={step.status === 'completed'
            ? <PlanCheckGlyph />
            : step.status === 'inProgress'
              ? <span className="status-spinner" />
              : <span className="thread-surface-pending-dot" />}
        >
          {step.step}
        </ThreadSurfacePlanRow>
      ))}
    </ThreadSurfacePlan>
  )
}

function PlanCheckGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m3.5 8.2 2.8 2.7 6.2-6" />
    </svg>
  )
}

function CodexInteractionPanel(props: {
  readonly busy: boolean
  readonly error?: string
  readonly interaction: CodexInteraction
  readonly onRespond: (
    interaction: CodexInteraction,
    actionId: CodexInteraction['actions'][number]['id'],
    detail?: { answers?: Record<string, string | string[]> }
  ) => Promise<void>
  readonly publicInteraction?: PublicInteraction
}): React.JSX.Element {
  const { t } = useI18n()
  const interaction = props.interaction
  if (interaction.status !== 'pending') {
    return (
      <div className={`interaction-card resolved ${interaction.status}`}>
        <Check size={13} /> {interaction.title} · {t(interactionStatusLabel(interaction.status))}
      </div>
    )
  }
  if (!props.publicInteraction) {
    return (
      <ThreadDetailRequest className="codex-native-interaction">
        <header>
          <ShieldCheck size={15} />
          <div>
            <strong>{interaction.title}</strong>
            {interaction.detail && interaction.kind !== 'command-approval' ? <p>{interaction.detail}</p> : null}
          </div>
        </header>
        {interaction.kind === 'command-approval' && interaction.detail ? <pre>{interaction.detail}</pre> : null}
        <InteractionError value={t('该 Codex 请求已失效。')} />
      </ThreadDetailRequest>
    )
  }
  if (interaction.kind === 'mcp-elicitation') {
    return <CodexElicitation {...props} interaction={interaction} />
  }
  if (interaction.kind === 'user-input') {
    return <CodexQuestions {...props} questions={props.publicInteraction.questions} />
  }
  return (
    <ThreadDetailRequest className="codex-native-interaction">
      <header>
        <ShieldCheck size={15} />
        <div>
          <strong>{interaction.title}</strong>
          {interaction.detail && interaction.kind !== 'command-approval' ? <p>{interaction.detail}</p> : null}
        </div>
      </header>
      {interaction.kind === 'command-approval' && interaction.detail ? <pre>{interaction.detail}</pre> : null}
      <InteractionError value={props.error} />
      <footer>
        {interaction.actions.map((action) => (
          <button
            className={action.id === interaction.actions.find((candidate) => candidate.intent === 'allow')?.id
              ? 'interaction-primary'
              : 'interaction-secondary'}
            disabled={props.busy}
            key={action.id}
            onClick={() => void props.onRespond(interaction, action.id)}
            type="button"
          >
            {codexActionLabel(action, t)}
          </button>
        ))}
      </footer>
    </ThreadDetailRequest>
  )
}

function CodexQuestions(props: {
  readonly busy: boolean
  readonly error?: string
  readonly interaction: CodexInteraction
  readonly publicInteraction?: PublicInteraction
  readonly questions: readonly PublicInteractionQuestion[]
  readonly onRespond: (
    interaction: CodexInteraction,
    actionId: CodexInteraction['actions'][number]['id'],
    detail?: { answers?: Record<string, string | string[]> }
  ) => Promise<void>
}): React.JSX.Element {
  const { t } = useI18n()
  const answers = useInteractionAnswers()
  const questions = props.questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    ...(question.header ? { header: question.header } : {}),
    multiple: false,
    allowOther: question.allowOther || !question.options.length,
    secret: question.secret,
    options: question.options.map((option) => ({
      id: option.value,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      value: option.value
    }))
  }))
  const submit = props.interaction.actions.find((action) => action.intent === 'submit')
  const complete = questions.every((question) => answers.answered(question))
  return (
    <ThreadDetailRequest className="codex-native-interaction codex-native-questions thread-surface-question">
      <header><MessageSquare size={15} /><div>
        <strong>{props.interaction.title}</strong>
        {props.interaction.detail ? <p>{props.interaction.detail}</p> : null}
      </div></header>
      {questions.map((question) => (
        <InteractionQuestionField
          disabled={props.busy}
          key={question.id}
          question={question}
          state={answers}
        />
      ))}
      <InteractionError value={props.error} />
      <footer>
        {submit ? (
          <button
            className="interaction-primary"
            disabled={props.busy || !complete}
            onClick={() => void props.onRespond(props.interaction, submit.id, {
              answers: answers.answersFor(questions)
            })}
            type="button"
          >
            {codexActionLabel(submit, t)}
          </button>
        ) : null}
        {props.interaction.actions
          .filter((action) => action.intent === 'deny' || action.intent === 'cancel')
          .map((action) => (
            <button
              className="interaction-secondary"
              disabled={props.busy}
              key={action.id}
              onClick={() => void props.onRespond(props.interaction, action.id)}
              type="button"
            >
              {codexActionLabel(action, t)}
            </button>
          ))}
      </footer>
    </ThreadDetailRequest>
  )
}

function CodexElicitation(props: {
  readonly busy: boolean
  readonly error?: string
  readonly interaction: Extract<CodexInteraction, { kind: 'mcp-elicitation' }>
  readonly onRespond: (
    interaction: CodexInteraction,
    actionId: CodexInteraction['actions'][number]['id'],
    detail?: { answers?: Record<string, string | string[]> }
  ) => Promise<void>
  readonly publicInteraction?: PublicInteraction
}): React.JSX.Element {
  const { t } = useI18n()
  const elicitation = props.interaction.elicitation
  const formQuestionIndex = elicitation.mode === 'form'
    ? props.interaction.questions.findIndex((question) => question.id === elicitation.questionId)
    : -1
  const formQuestion = formQuestionIndex < 0
    ? undefined
    : props.publicInteraction?.questions[formQuestionIndex]
  const [value, setValue] = useState('{}')
  const [parseError, setParseError] = useState('')

  const respond = (action: CodexInteraction['actions'][number]): void => {
    if (action.intent !== 'submit' || !formQuestion) {
      setParseError('')
      void props.onRespond(props.interaction, action.id)
      return
    }
    let content: unknown
    try {
      content = JSON.parse(value)
    } catch {
      setParseError(t('内容必须是有效 JSON。'))
      return
    }
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      setParseError(t('内容必须是 JSON object。'))
      return
    }
    setParseError('')
    void props.onRespond(props.interaction, action.id, {
      answers: { [formQuestion.id]: value }
    })
  }

  return (
    <ThreadDetailRequest className="codex-native-interaction codex-native-elicitation">
      <header><ShieldCheck size={15} /><div>
        <strong>{props.interaction.title}</strong>
        {elicitation.mode === 'url'
          ? <code>{elicitation.url}</code>
          : null}
      </div></header>
      {elicitation.mode === 'form'
        ? <pre>{JSON.stringify(elicitation.requestedSchema, null, 2)}</pre>
        : null}
      {formQuestion ? (
        <textarea
          aria-label={formQuestion.prompt}
          disabled={props.busy}
          onChange={(event) => setValue(event.target.value)}
          rows={4}
          spellCheck={false}
          value={value}
        />
      ) : null}
      <InteractionError value={parseError || props.error} />
      <footer>
        {props.interaction.actions.map((action) => (
          <button
            className={action.intent === 'submit'
              ? 'interaction-primary'
              : 'interaction-secondary'}
            disabled={props.busy}
            key={action.id}
            onClick={() => respond(action)}
            type="button"
          >
            {codexActionLabel(action, t)}
          </button>
        ))}
      </footer>
    </ThreadDetailRequest>
  )
}

function InteractionError({ value }: { readonly value?: string }): React.JSX.Element | null {
  return value
    ? <div className="codex-native-action-error" role="alert">{value}</div>
    : null
}

function CodexToolActivityGroup(props: {
  readonly activities: readonly CodexActivity[]
  readonly groupId: string
}): React.JSX.Element | null {
  const summary = summarizeActivities(props.activities)
  return (
    <HarnessToolActivityGroup
      defaultExpanded
      groupId={props.groupId}
      items={props.activities.map((activity) => ({
        id: activity.id,
        running: activity.status === 'running',
        node: <CodexActivityRow activity={activity} />
      }))}
      summary={summary.text}
      summaryLabel={summary.fullText}
      summaryState={activityGroupState(props.activities)}
    />
  )
}

function CodexActivityRow({
  activity
}: {
  readonly activity: CodexActivity
}): React.JSX.Element {
  const Icon = activityIcon(activity.kind)
  const state = activity.status === 'running'
    ? <span className="status-spinner" />
    : activity.status === 'failed'
      ? <CircleAlert size={14} />
      : <Icon size={14} />
  return (
    <ThreadActivityRow
      className={activity.status}
      detail={activity.detail ? <pre>{activity.detail}</pre> : undefined}
      id={activity.id}
      label={activity.label}
      state={state}
    />
  )
}

function activityIcon(kind: CodexActivity['kind']) {
  if (kind === 'command') return Terminal
  if (kind === 'file') return FilePenLine
  if (kind === 'search') return Search
  if (kind === 'agent' || kind === 'subagent') return Bot
  if (kind === 'review') return GitPullRequest
  return Wrench
}

function activityGroupState(activities: readonly CodexActivity[]): ReactNode {
  if (activities.some((activity) => activity.status === 'running')) {
    return <span className="status-spinner" />
  }
  if (activities.some((activity) => activity.status === 'failed')) {
    return <CircleAlert size={13} />
  }
  if (activities.some((activity) => activity.status === 'cancelled')) {
    return <Circle size={13} />
  }
  return <Check size={13} />
}

function summarizeActivities(activities: readonly CodexActivity[]): {
  readonly text: string
  readonly fullText: string
} {
  const counts = new Map<'file' | 'command' | 'search' | 'other', number>()
  for (const activity of activities) {
    const kind = activity.kind === 'file'
      ? 'file'
      : activity.kind === 'command'
        ? 'command'
        : activity.kind === 'search'
          ? 'search'
          : 'other'
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const labels = [...counts].map(([kind, count]) => {
    if (kind === 'file') return `Touched ${count} ${count === 1 ? 'file' : 'files'}`
    if (kind === 'command') return `Ran ${count} ${count === 1 ? 'command' : 'commands'}`
    if (kind === 'search') return `Searched ${count} ${count === 1 ? 'time' : 'times'}`
    return `Used ${count} ${count === 1 ? 'tool' : 'tools'}`
  })
  const sentence = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)
  )
  const text = sentence.length < 2
    ? sentence[0] || ''
    : sentence.length === 2
      ? sentence.join(' and ')
      : `${sentence.slice(0, -1).join(', ')}, and ${sentence.at(-1)}`
  const statuses = [
    statusCount(activities, 'running', 'running'),
    statusCount(activities, 'failed', 'failed'),
    statusCount(activities, 'cancelled', 'stopped')
  ].filter(Boolean)
  return {
    text,
    fullText: statuses.length ? `${text} · ${statuses.join(' · ')}` : text
  }
}

function statusCount(
  activities: readonly CodexActivity[],
  status: CodexActivity['status'],
  label: string
): string {
  const count = activities.filter((activity) => activity.status === status).length
  return count ? `${count} ${label}` : ''
}

function CodexBackgroundTerminals({
  state
}: {
  readonly state: CodexHarnessState
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <section className="codex-native-terminals" role="listitem" aria-label={t('后台终端')}>
      <div className="codex-native-section-title">
        <Terminal size={14} /><strong>{t('后台终端')}</strong>
      </div>
      {state.backgroundTerminals.map((terminal) => (
        <div className="codex-native-terminal" key={terminal.id}>
          <span className="status-spinner" />
          <code>{terminal.command}</code>
          <small>{terminal.cwd}</small>
        </div>
      ))}
    </section>
  )
}

function findPendingInteraction(
  state: CodexHarnessState,
  interactionId: string
): CodexInteraction | undefined {
  const matches = state.turns.flatMap((turn) => turn.interactions).filter(
    (interaction) => interaction.id === interactionId &&
      interaction.status === 'pending' && interaction.blocksTurn
  )
  return matches.length === 1 ? matches[0] : undefined
}

function indexById<T extends { readonly id: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) if (!map.has(item.id)) map.set(item.id, item)
  return map
}

function interactionStatusLabel(status: CodexInteraction['status']): string {
  if (status === 'allowed') return '已允许'
  if (status === 'denied') return '已拒绝'
  if (status === 'submitted') return '已提交'
  if (status === 'cancelled') return '已取消'
  return '已处理'
}

function codexTurnStatus(turn: CodexTurn, t: (source: string) => string): string {
  if (turn.status === 'waiting-input') return t('等待输入')
  if (turn.status === 'completed') return t('已完成')
  if (turn.status === 'failed') return t('失败')
  if (turn.status === 'interrupted') return t('已取消')
  return codexStatusLabel(turn.status, turn.statusLabel || '运行中', t)
}
