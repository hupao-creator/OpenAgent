import { useState, type ReactNode } from 'react'
import { Bot, Hourglass } from 'lucide-react'
import { useI18n } from '../i18n.js'
import { InteractionOtherAnswer } from '../components/InteractionQuestions.js'
import { tokenizeCommandLine } from './command-line.js'
import type {
  ThreadCardActivityStatus,
  ThreadCardAgentRow,
  ThreadCardDerivedKind,
  ThreadCardDerivedRow,
  ThreadCardInterventionHandler,
  ThreadCardIntervention,
  ThreadCardQuestion,
  ThreadCardVariantId
} from './contracts.js'

export { CardPlanLadder, threadCardPlanWindow } from './plan-ladder.js'

interface InteractionAnswerState {
  picked(question: ThreadCardQuestion): readonly string[]
  otherOpen(question: ThreadCardQuestion): boolean
  otherText(question: ThreadCardQuestion): string
  toggle(question: ThreadCardQuestion, value: string): void
  toggleOther(question: ThreadCardQuestion): void
  writeOther(question: ThreadCardQuestion, text: string): void
  answered(question: ThreadCardQuestion): boolean
  answersFor(
    questions: readonly ThreadCardQuestion[]
  ): Record<string, string | string[]>
}

function textOnly(question: ThreadCardQuestion): boolean {
  return question.options.length === 0
}

/** Historical local answer state; the provider's action/value ids are preserved verbatim. */
function useInteractionAnswers(): InteractionAnswerState {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const pickedOf = (question: ThreadCardQuestion): string[] => picked[question.id] ?? []
  const otherOpen = (question: ThreadCardQuestion): boolean =>
    textOnly(question) || other[question.id] !== undefined
  const otherText = (question: ThreadCardQuestion): string => other[question.id] ?? ''
  const clearOther = (questionId: string): void => {
    setOther((rest) =>
      Object.fromEntries(Object.entries(rest).filter(([id]) => id !== questionId))
    )
  }
  const answerOf = (question: ThreadCardQuestion): string[] => {
    const raw = otherText(question)
    const custom = question.secret ? raw : raw.trim()
    const chosen = pickedOf(question)
    if (!custom) return chosen
    return question.multiple ? [...chosen, custom] : [custom]
  }
  return {
    picked: pickedOf,
    otherOpen,
    otherText,
    answered: (question) => answerOf(question).length > 0,
    toggle: (question, value) => {
      if (!question.multiple) clearOther(question.id)
      setPicked((rest) => {
        const selected = rest[question.id] ?? []
        if (!question.multiple) return { ...rest, [question.id]: [value] }
        return {
          ...rest,
          [question.id]: selected.includes(value)
            ? selected.filter((entry) => entry !== value)
            : [...selected, value]
        }
      })
    },
    toggleOther: (question) => {
      if (other[question.id] === undefined) {
        setOther((rest) => ({ ...rest, [question.id]: '' }))
        if (!question.multiple) setPicked((rest) => ({ ...rest, [question.id]: [] }))
      } else {
        clearOther(question.id)
      }
    },
    writeOther: (question, text) => {
      setOther((rest) => ({ ...rest, [question.id]: text }))
    },
    answersFor: (questions) => Object.fromEntries(
      questions
        .map((question) => [question, answerOf(question)] as const)
        .filter(([, answer]) => answer.length > 0)
        .map(([question, answer]) => [
          question.id,
          question.multiple ? answer : answer[0] ?? ''
        ])
    )
  }
}

function InteractionQuestionField(props: {
  readonly question: ThreadCardQuestion
  readonly state: InteractionAnswerState
  readonly disabled?: boolean
}): ReactNode {
  const { t } = useI18n()
  const { question, state } = props
  const selected = state.picked(question)
  return (
    <div className="interaction-question">
      <span className="interaction-question-prompt">
        <strong>{question.header || question.prompt}</strong>
        {question.header ? <small>{question.prompt}</small> : null}
      </span>
      {question.options.length ? (
        <span
          className="interaction-question-options"
          data-select={question.multiple ? 'multiple' : 'single'}
        >
          {question.options.map((option) => (
            <button
              aria-pressed={selected.includes(option.value)}
              className={selected.includes(option.value) ? 'active' : undefined}
              disabled={props.disabled}
              key={option.id}
              onClick={() => state.toggle(question, option.value)}
              title={option.description}
              type="button"
            >
              <span className="interaction-question-option-text">
                <b>{option.label}</b>
                {option.description ? <small>{option.description}</small> : null}
              </span>
            </button>
          ))}
          {question.allowOther ? (
            <span className="interaction-question-other-slot">
              <InteractionOtherAnswer
                open={state.otherOpen(question)}
                value={state.otherText(question)}
                label={question.prompt}
                secret={question.secret}
                disabled={props.disabled}
                onOpen={() => state.toggleOther(question)}
                onClose={() => state.toggleOther(question)}
                onChange={value => state.writeOther(question, value)}
              />
            </span>
          ) : null}
        </span>
      ) : null}
      {textOnly(question) ? (
        <input
          aria-label={question.prompt}
          autoComplete={question.secret ? 'off' : undefined}
          className="interaction-question-input"
          disabled={props.disabled}
          onChange={(event) => state.writeOther(question, event.target.value)}
          placeholder={textOnly(question) ? t('输入回答') : t('输入你的回答')}
          type={question.secret ? 'password' : 'text'}
          value={state.otherText(question)}
        />
      ) : null}
    </div>
  )
}

export function CardInterventionPanel(props: {
  readonly intervention: ThreadCardIntervention
  readonly variant: ThreadCardVariantId
  readonly onRespond?: ThreadCardInterventionHandler
  readonly onOpenThread?: () => void
  readonly details?: ReactNode
}): ReactNode {
  const { t } = useI18n()
  const { intervention } = props
  const questions = intervention.questions ?? []
  const [step, setStep] = useState(0)
  const [responding, setResponding] = useState(false)
  const [responseError, setResponseError] = useState<string>()
  const answers = useInteractionAnswers()
  const current = questions[Math.min(step, Math.max(0, questions.length - 1))]
  const currentAnswered = current ? answers.answered(current) : true
  const lastStep = step >= questions.length - 1

  const respond = async (actionId: string, skip = false): Promise<void> => {
    if (responding || !props.onRespond) return
    setResponding(true)
    setResponseError(undefined)
    try {
      await props.onRespond({
        actionId,
        ...(questions.length && (skip || actionId === intervention.submitActionId)
          ? { answers: skip ? {} : answers.answersFor(questions) }
          : {})
      })
      // A successful response stays locally locked until the authoritative
      // projection removes this pending interaction. This closes the window
      // where a slow Core observation could admit the same click twice.
    } catch (error) {
      setResponseError(error instanceof Error ? error.message : String(error))
      setResponding(false)
    }
  }

  return (
    <div className={`thread-card-intervention variant-${props.variant}`}>
      {questions.length > 1 ? (
        <span className="thread-card-section-head tally">
          <small>{`${step + 1} / ${questions.length}`}</small>
        </span>
      ) : null}
      {questions.length ? null : (
        <b className="thread-card-intervention-title">{intervention.title}</b>
      )}
      {intervention.detail && !questions.length ? (
        <span className="thread-card-intervention-detail">{intervention.detail}</span>
      ) : null}
      {props.details ? (
        <details className="thread-card-intervention-details">
          <summary>{t('请求详情')}</summary>
          {props.details}
        </details>
      ) : null}
      {current ? (
        <InteractionQuestionField
          disabled={responding}
          key={current.id}
          question={current}
          state={answers}
        />
      ) : null}
      {responseError ? (
        <small className="message-error thread-card-intervention-error" role="alert">
          {responseError}
        </small>
      ) : null}
      <span className="thread-card-intervention-actions">
        {questions.length ? (
          <>
            {lastStep
              ? intervention.actions.map((action) => (
                  <button
                    type="button"
                    key={action.id}
                    disabled={responding || (
                      action.id === intervention.submitActionId && !currentAnswered
                    )}
                    onClick={() => void respond(action.id)}
                  >
                    {action.label}
                  </button>
                ))
              : (
                <button
                  type="button"
                  disabled={responding || !currentAnswered}
                  onClick={() => setStep((value) => value + 1)}
                >
                  {t('下一步')}
                </button>
              )}
            {intervention.skipAction ? (
              <button type="button" disabled={responding}
                onClick={() => void respond(intervention.skipAction!.id, true)}>
                {intervention.skipAction.label}
              </button>
            ) : null}
            {step > 0 ? (
              <button
                type="button"
                disabled={responding}
                onClick={() => setStep((value) => value - 1)}
              >
                {t('上一步')}
              </button>
            ) : null}
          </>
        ) : intervention.actions.length ? (
          intervention.actions.map((action) => (
            <button
              type="button"
              disabled={responding}
              key={action.id}
              onClick={() => void respond(action.id)}
            >
              {action.label}
            </button>
          ))
        ) : (
          <button type="button" onClick={props.onOpenThread}>
            {t('在 thread 中处理')}
          </button>
        )}
      </span>
    </div>
  )
}

const AGENT_STATUS_LABEL: Record<ThreadCardActivityStatus, string> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消'
}

const DERIVED_KIND_LABEL: Record<ThreadCardDerivedKind, string> = {
  shell: 'shell',
  agent: '子 Agent',
  task: '任务'
}

function derivedGlyph(kind: ThreadCardDerivedKind): ReactNode {
  if (kind === 'shell') return '$'
  if (kind === 'agent') return <Bot size={11} strokeWidth={2} />
  return <Hourglass size={11} strokeWidth={2} />
}

export function CardDerivedWork(props: {
  readonly rows: readonly ThreadCardDerivedRow[]
  readonly variant: ThreadCardVariantId
  readonly capacity: number
}): ReactNode {
  const { t } = useI18n()
  if (!props.rows.length) return null
  const visible = props.rows.slice(0, props.capacity)
  const overflow = props.rows.length - visible.length
  return (
    <div className={`thread-card-derived variant-${props.variant}`}>
      <span className="thread-card-derived-rows">
        {visible.map((row) => (
          <span
            className={`thread-card-derived-row ${row.status}` + (row.commandLine ? ' command' : '')}
            key={row.id}
          >
            <i aria-hidden="true">{derivedGlyph(row.kind)}</i>
            <b title={row.label}>
              {row.commandLine
                ? tokenizeCommandLine(row.label).map((token, index) => (
                    <span className={`thread-card-command-${token.role}`} key={index}>
                      {token.text}
                    </span>
                  ))
                : row.label}
            </b>
            {row.status === 'running' ? (
              row.commandLine ? null : <em>{t(DERIVED_KIND_LABEL[row.kind])}</em>
            ) : (
              <em>{t(AGENT_STATUS_LABEL[row.status])}</em>
            )}
          </span>
        ))}
        {overflow > 0 ? <small className="thread-card-overflow">{`+${overflow}`}</small> : null}
      </span>
    </div>
  )
}

export function CardWorkflowPhases(props: {
  readonly phases: readonly string[]
  readonly total: number
  readonly capacity: number
}): ReactNode {
  const { t } = useI18n()
  const visible = props.phases.slice(0, props.capacity)
  const total = Math.max(props.total, props.phases.length)
  const overflow = Math.max(0, total - visible.length)
  return (
    <div className="thread-card-workflow-phases">
      <span className="thread-card-workflow-head">
        <span className="thread-card-workflow-title">
          <small>PHASED EXECUTION</small>
          <strong>Dynamic Workflow</strong>
        </span>
        <span className="thread-card-workflow-summary">
          <b>{total}</b>
          <span><strong>{t('阶段')}</strong><small>{t('有序定义')}</small></span>
        </span>
      </span>
      <span className="thread-card-workflow-route" aria-label={t('已声明阶段')}>
        {visible.map((phase, index) => (
          <span className="thread-card-workflow-phase" key={`${index}:${phase}`}>
            <i aria-hidden="true">{String(index + 1).padStart(2, '0')}</i>
            <b title={phase}>{phase}</b>
          </span>
        ))}
      </span>
      {overflow > 0 ? <small className="thread-card-workflow-overflow">{`+${overflow}`}</small> : null}
    </div>
  )
}

export function CardWorkflowAgents(props: {
  readonly rows: readonly ThreadCardAgentRow[]
  readonly capacity: number
}): ReactNode {
  const { t } = useI18n()
  const visible = props.rows.slice(0, props.capacity)
  const overflow = props.rows.length - visible.length
  const done = props.rows.filter((row) => row.status === 'completed').length
  return (
    <div className="thread-card-workflow-agents">
      <span className="thread-card-workflow-agents-head">
        <small>AGENT EXECUTION</small>
        <small>{t('{done}/{total} 完成', { done, total: props.rows.length })}</small>
      </span>
      <span className="thread-card-workflow-rows">
        {visible.map((row) => (
          <span className={'thread-card-workflow-row ' + row.status} key={row.id}>
            <i aria-hidden="true" />
            <b title={row.label}>{row.label}</b>
            <small>{t(AGENT_STATUS_LABEL[row.status])}</small>
          </span>
        ))}
      </span>
      {overflow > 0 ? (
        <small className="thread-card-workflow-overflow">{`+${overflow}`}</small>
      ) : null}
    </div>
  )
}
