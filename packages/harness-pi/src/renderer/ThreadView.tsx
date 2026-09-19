import { useMemo, useState } from 'react'
import type { HarnessRendererThreadActions, HarnessRendererThreadInput } from '@openagent/contracts/renderer'
import { isPublicExecutionActive } from '@openagent/contracts/renderer'
import type { PublicInteraction } from '@openagent/contracts'
import { ThreadDetailSurface, ThreadDetailTurn, ThreadDocumentSummary, threadDocumentHeading, ThreadTokenUsage, ThreadTimelineMarkdown, ThreadTimelineUserMessage, ThreadTimelineAssistantMessage, ThreadSurfaceDisclosure, ThreadDetailRequest, InteractionQuestionField, useInteractionAnswers, useI18n, threadExecutionRunIds, type ThreadDetailRow } from '@openagent/plugin-kit/renderer'
import { piBartReplyAnchor } from '../shared/bart-presentation.js'
import { piState } from '../shared/state.js'
import type { PiMessage, PiSessionState } from '../shared/types.js'

type Props = HarnessRendererThreadInput & { readonly actions: HarnessRendererThreadActions }
export function PiThreadView(props: Props): React.JSX.Element {
  return <PiTimeline key={props.thread.id} {...props} />
}
function PiTimeline(props: Props): React.JSX.Element {
  const { t } = useI18n()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const active = isPublicExecutionActive(props.thread.observation)
  const latest = props.thread.observation.latestExecution
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true); setError(undefined)
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  // Parsing clones the whole session, so it stays off every unrelated render.
  const parsed = useMemo<{ readonly state: PiSessionState } | { readonly failure: string }>(() => {
    try { return { state: piState(props.thread.sessionState) } }
    catch (e) { return { failure: String(e) } }
  }, [props.thread.sessionState])
  if ('failure' in parsed) return <div role="alert">{t('Pi 状态不可用')} · {parsed.failure}</div>
  const state = parsed.state
  // Native rows and execution membership depend only on the session and locale.
  const executions = useMemo(() => {
    const messagesByExecution = new Map<string, PiMessage[]>()
    for (const message of state.messages) {
      const existing = messagesByExecution.get(message.executionId)
      if (existing) existing.push(message)
      else messagesByExecution.set(message.executionId, [message])
    }
    return state.executions.map((execution) => {
      const messages = messagesByExecution.get(execution.executionId) ?? []
      const messageRows: ThreadDetailRow[] = messages.flatMap(m => {
        // Session state is not validated per field: a message without text is empty.
        const text = typeof m.text === 'string' ? m.text : ''
        return [
          // A thinking-only assistant placeholder is not a prose boundary.
          ...(m.role === 'assistant' && m.thinking ? [{
            id: `${m.id}:thinking`, kind: 'work' as const,
            node: <ThreadSurfaceDisclosure label={t('思考过程')}><ThreadTimelineMarkdown>{m.thinking}</ThreadTimelineMarkdown></ThreadSurfaceDisclosure>
          }] : []),
          ...(m.role === 'assistant' && !text.trim() ? [] : [{
            id: m.id,
            kind: m.role === 'user' ? 'user' as const : m.role === 'tool'
              ? m.isError ? 'attention' as const : 'work' as const : 'content' as const,
            node: <Message message={m} />
          }])
        ]
      })
      return { execution, messages, messageRows,
        executionRunIds: threadExecutionRunIds(messageRows, row => row.kind === 'work') }
    })
  }, [state, t])
  return <div className="pi-thread provider-theme-pi">
    <div className="pi-actions">
      {active ? <button disabled={busy} onClick={() => void run(props.actions.interrupt)}>{t('中断')}</button> : null}
      {error ? <div role="alert">{error}</div> : null}
    </div>
    <ThreadDetailSurface threadId={props.thread.id} title={props.thread.title} icon={props.thread.emoji}
      running={latest?.status === 'running'} runningTurnId={active ? latest?.executionId : undefined}
      readingTarget={props.readingTarget ? { requestId: props.readingTarget.requestId,
        rowId: state.executions.some(e => e.executionId === props.readingTarget!.executionId)
          ? props.readingTarget.mode === 'current' ? undefined : props.readingTarget.executionId : null,
        anchorId: piBartReplyAnchor(state, props.readingTarget.message) } : undefined}
      rows={executions.map(({ execution, messages, messageRows, executionRunIds }, index) => {
        const usage = messages.findLast(m => m.role === 'assistant' && m.usage)?.usage
        const current = latest?.executionId === execution.executionId
        const historical = index < executions.length - 1
        const finishedAt = 'finishedAt' in execution ? execution.finishedAt : undefined
        return { id: execution.executionId, createdAt: execution.startedAt,
          subpage: historical ? {
            ...threadDocumentHeading(messages.find(m => m.role === 'user')?.text || t('历史对话')),
            summary: <ThreadDocumentSummary markdown={messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n')} />,
            completedAt: execution.status === 'completed' ? finishedAt : undefined
          } : undefined,
          node: <ThreadDetailTurn id={execution.executionId} active={current && active}
            createdAt={execution.startedAt} updatedAt={finishedAt ?? execution.startedAt} status={execution.status}
            completedAt={execution.status === 'completed' ? finishedAt : undefined}
            executionRunIds={executionRunIds}
            usage={usage ? <ThreadTokenUsage input={usage.input + usage.cacheRead + usage.cacheWrite} output={usage.output} cached={usage.cacheRead} cacheWrite={usage.cacheWrite} /> : undefined}
            rows={[
              ...messageRows,
              ...(execution.status === 'failed' && execution.error ? [{ id: 'execution-error', kind: 'content' as const, node: <div role="alert">{execution.error}</div> }] : []),
              ...(current && latest?.status === 'waiting-for-user' ? latest.interactions.map(interaction => ({ id: interaction.id, kind: 'content' as const, node: <PiInteraction key={interaction.id} interaction={interaction} busy={busy} respond={(actionId, answers) => run(() => props.actions.respond({ interactionId: interaction.id, actionId, ...(answers ? { answers } : {}) }))} /> })) : [])
            ]} /> }
      })} />
  </div>
}
function Message({ message: m }: { message: PiMessage }): React.JSX.Element {
  const { t } = useI18n()
  if (m.role === 'user') return <ThreadTimelineUserMessage id={m.id}><ThreadTimelineMarkdown>{m.text}</ThreadTimelineMarkdown></ThreadTimelineUserMessage>
  if (m.role === 'tool') return <ThreadSurfaceDisclosure label={m.toolName || t('工具')}><pre className="pi-tool-output" role={m.isError ? 'alert' : undefined}>{m.text}</pre></ThreadSurfaceDisclosure>
  return <ThreadTimelineAssistantMessage id={m.id}>
    <ThreadTimelineMarkdown>{m.text}</ThreadTimelineMarkdown>
  </ThreadTimelineAssistantMessage>
}
function PiInteraction(props: { interaction: PublicInteraction; busy: boolean; respond(action: string, answers?: Record<string, string | string[]>): Promise<void> }): React.JSX.Element {
  const answers = useInteractionAnswers()
  const questions = props.interaction.questions.map(q => ({ ...q, options: q.options.map(o => ({ ...o, id: o.value })) }))
  return <ThreadDetailRequest><header><strong>{props.interaction.title}</strong><p>{props.interaction.description}</p></header>
    {questions.map(q => <InteractionQuestionField key={q.id} question={q} state={answers} disabled={props.busy} />)}
    <footer>{props.interaction.actions.map(a => <button key={a.id} disabled={props.busy || a.intent === 'submit' && !questions.every(q => answers.answered(q))}
      onClick={() => void props.respond(a.id, a.intent === 'submit' ? answers.answersFor(questions) : undefined)}>{a.label}</button>)}</footer>
  </ThreadDetailRequest>
}
