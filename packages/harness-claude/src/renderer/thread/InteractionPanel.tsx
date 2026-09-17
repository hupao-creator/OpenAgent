import { useState } from 'react'
import { FileQuestion, LoaderCircle, ShieldAlert } from 'lucide-react'
import type { DeepReadonly, PublicInteraction } from '@openagent/contracts'
import type { HarnessRendererThreadActions } from '@openagent/contracts/renderer'
import { useI18n } from '@openagent/plugin-kit/renderer'
import { InteractionOtherAnswer, ThreadDetailRequest } from '@openagent/plugin-kit/renderer'
import { type ClaudeInteraction } from '../../shared/state.js'
import { isJsonObject, errorMessage, prettyJson } from '../values.js'
import { InlineError } from '../primitives.js'

export function ClaudeInteractionPanel(props: {
  readonly actions: HarnessRendererThreadActions
  readonly interaction: DeepReadonly<ClaudeInteraction>
  readonly publicInteraction?: DeepReadonly<PublicInteraction>
}): React.JSX.Element {
  const { t } = useI18n()
  const interaction = props.interaction
  const [busyAction, setBusyAction] = useState<string>()
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState('')
  const [jsonText, setJsonText] = useState('{}')
  const [answers, setAnswers] = useState<Record<number, string[]>>({})
  const [otherAnswers, setOtherAnswers] = useState<Record<number, string>>({})
  const commandInput = interaction.kind === 'permission' && isJsonObject(interaction.input)
    ? interaction.input
    : undefined
  const command = typeof commandInput?.command === 'string' ? commandInput.command : undefined
  const commandCwd = typeof commandInput?.cwd === 'string' ? commandInput.cwd : undefined

  const respond = async (
    actionId: string,
    answers?: Record<string, string | string[]>,
    message?: string
  ): Promise<boolean> => {
    if (busyAction) return false
    const publicAction = props.publicInteraction?.actions.find(
      (action) => action.id === actionId
    )
    if (!props.publicInteraction || !publicAction) {
      setError(t('该请求已失效。'))
      return false
    }
    setBusyAction(publicAction.id)
    setError(undefined)
    try {
      await props.actions.respond({
        interactionId: props.publicInteraction.id,
        actionId: publicAction.id,
        ...(answers ? { answers } : {}),
        ...(message === undefined ? {} : { message })
      })
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setBusyAction(undefined)
    }
  }

  const acceptUrl = async (): Promise<void> => {
    if (busyAction || !interaction.url) return
    const submit = props.publicInteraction?.actions.find(
      (action) => action.intent === 'submit'
    )
    if (!props.publicInteraction || !submit) {
      setError(t('该请求已失效。'))
      return
    }
    setBusyAction(submit.id)
    setError(undefined)
    try {
      await props.actions.openExternal(interaction.url)
      await props.actions.respond({
        interactionId: props.publicInteraction.id,
        actionId: submit.id
      })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyAction(undefined)
    }
  }

  const closeOtherAnswer = (questionIndex: number): void => {
    setOtherAnswers((current) => {
      const next = { ...current }
      delete next[questionIndex]
      return next
    })
  }

  const selectAnswer = (questionIndex: number, label: string, multiple: boolean): void => {
    if (!multiple) closeOtherAnswer(questionIndex)
    setAnswers((current) => {
      if (!multiple) return { ...current, [questionIndex]: [label] }
      const selected = current[questionIndex] || []
      return {
        ...current,
        [questionIndex]: selected.includes(label)
          ? selected.filter((value) => value !== label)
          : [...selected, label]
      }
    })
  }

  const questions = props.publicInteraction?.questions || []
  const customAnswer = (index: number): string => {
    const value = otherAnswers[index] || ''
    return questions[index]?.secret ? value : value.trim()
  }
  const answersComplete = questions.every((_question, index) =>
    Boolean(answers[index]?.length || customAnswer(index))
  )

  const submitQuestions = (): void => {
    const payload: Record<string, string | string[]> = {}
    questions.forEach((question, index) => {
      const selected = answers[index] || []
      const other = customAnswer(index)
      payload[question.id] = question.multiple
        ? [...selected, ...(other ? [other] : [])]
        : other || selected[0] || ''
    })
    void respond('submit', payload)
  }

  const submitValues = (): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      setError(t('表单内容必须是有效 JSON。'))
      return
    }
    if (!isJsonObject(parsed)) {
      setError(t('表单内容必须是 JSON object。'))
      return
    }
    const valuesQuestion = props.publicInteraction?.questions[0]
    if (!valuesQuestion) {
      setError(t('该请求已失效。'))
      return
    }
    void respond('submit', { [valuesQuestion.id]: JSON.stringify(parsed) })
  }

  if (!props.publicInteraction) {
    return (
      <ThreadDetailRequest className={`claude-renderer-interaction ${interaction.kind}`}>
        <header>
          <span>{interaction.kind === 'permission'
            ? <ShieldAlert size={15} />
            : <FileQuestion size={15} />}</span>
          <div>
            <strong>{interaction.title}</strong>
            {interaction.description ? <p>{interaction.description}</p> : null}
            {interaction.toolName ? <small>{interaction.toolName}</small> : null}
          </div>
        </header>
        <InlineError message={t('该请求已失效。')} />
      </ThreadDetailRequest>
    )
  }

  return (
    <ThreadDetailRequest className={`claude-renderer-interaction ${interaction.kind}`}>
      <header>
        <span>{interaction.kind === 'permission' ? <ShieldAlert size={15} /> : <FileQuestion size={15} />}</span>
        <div>
          <strong>{interaction.title}</strong>
          {interaction.description ? <p>{interaction.description}</p> : null}
          {interaction.toolName ? <small>{interaction.toolName}</small> : null}
        </div>
      </header>

      {command ? <pre>{command}</pre> : null}
      {commandCwd ? <dl className="claude-renderer-request-properties">
        <div><dt>{t('工作目录')}</dt><dd>{commandCwd}</dd></div>
      </dl> : null}
      {interaction.input !== undefined ? (
        <details className="claude-renderer-payload">
          <summary>{t('请求详情')}</summary>
          <pre>{prettyJson(interaction.input)}</pre>
        </details>
      ) : null}

      {interaction.kind === 'question' ? questions.map((question, index) => (
        <fieldset className="claude-renderer-question" key={question.id}>
          <legend>
            {question.header ? <small>{question.header}</small> : null}
            {question.prompt}
          </legend>
          {question.options.length ? (
            <div className="interaction-question-options" data-select={question.multiple ? 'multiple' : 'single'}>
              {question.options.map((option) => {
                const selected = answers[index]?.includes(option.value) === true
                return (
                  <label className={selected ? 'selected' : ''} key={option.value}>
                    <input
                      checked={selected}
                      disabled={Boolean(busyAction)}
                      name={question.id}
                      type={question.multiple ? 'checkbox' : 'radio'}
                      onChange={() => selectAnswer(index, option.value, question.multiple)}
                    />
                    <span>
                      {option.label}
                      {option.description ? <small>{option.description}</small> : null}
                    </span>
                  </label>
                )
              })}
              {question.allowOther ? <InteractionOtherAnswer
                open={otherAnswers[index] !== undefined}
                value={otherAnswers[index] || ''}
                label={question.prompt}
                secret={question.secret}
                disabled={Boolean(busyAction)}
                onOpen={() => {
                  setOtherAnswers((current) => ({ ...current, [index]: '' }))
                  if (!question.multiple) {
                    setAnswers((current) => ({ ...current, [index]: [] }))
                  }
                }}
                onClose={() => closeOtherAnswer(index)}
                onChange={(value) => setOtherAnswers((current) => ({ ...current, [index]: value }))}
              /> : null}
            </div>
          ) : <input
            aria-label={question.prompt}
            type={question.secret ? 'password' : 'text'}
            autoComplete={question.secret ? 'off' : undefined}
            className="interaction-question-input"
            disabled={Boolean(busyAction)}
            placeholder={t('输入回答…')}
            value={otherAnswers[index] || ''}
            onChange={(event) => setOtherAnswers((current) => ({ ...current, [index]: event.target.value }))}
          />}
        </fieldset>
      )) : null}

      {interaction.kind === 'permission' ? (
        <label className="claude-renderer-message-field">
          <span>{t('拒绝原因')} <small>{t('可选')}</small></span>
          <textarea
            disabled={Boolean(busyAction)}
            placeholder={t('输入拒绝原因')}
            rows={2}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
      ) : null}

      {interaction.kind === 'elicitation' && interaction.elicitationMode === 'url' ? (
        <div className="claude-renderer-url-elicitation">
          <p>{t('此请求需要在 Claude 提供的外部页面中完成。')}</p>
          {interaction.url ? <code>{interaction.url}</code> : null}
          {interaction.serverName ? (
            <small>{t('MCP Server：{serverName}', { serverName: interaction.serverName })}</small>
          ) : null}
          {interaction.elicitationId ? (
            <small>{t('请求 ID：{id}', { id: interaction.elicitationId })}</small>
          ) : null}
        </div>
      ) : interaction.kind === 'elicitation' ? (
        <div className="claude-renderer-json-form">
          {interaction.schema !== undefined ? (
            <details className="claude-renderer-payload">
              <summary>{t('字段约束')}</summary>
              <pre>{prettyJson(interaction.schema)}</pre>
            </details>
          ) : null}
          <label>
            <span>{t('JSON 表单内容')}</span>
            <textarea
              disabled={Boolean(busyAction)}
              rows={5}
              spellCheck={false}
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
            />
          </label>
        </div>
      ) : null}

      {interaction.kind === 'dialog' ? (
        <label className="claude-renderer-message-field">
          <span>{t('回复 Claude')}</span>
          <textarea
            disabled={Boolean(busyAction)}
            placeholder={t('输入回复')}
            rows={3}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
      ) : null}

      {error ? <InlineError message={error} /> : null}

      <footer>
        {interaction.kind === 'permission' ? (
          <>
            <InteractionButton
              primary
              busy={busyAction === 'allow'}
              disabled={Boolean(busyAction)}
              label={t('允许一次')}
              onClick={() => void respond('allow')}
            />
            {interaction.canRemember ? (
              <InteractionButton
                busy={busyAction === 'allow-session'}
                disabled={Boolean(busyAction)}
                label={t('本会话始终允许')}
                onClick={() => void respond('allow-session')}
              />
            ) : null}
            <InteractionButton
              busy={busyAction === 'deny'}
              disabled={Boolean(busyAction)}
              label={t('拒绝')}
              onClick={() => void respond(
                'deny',
                undefined,
                message.trim() || undefined
              )}
            />
          </>
        ) : interaction.kind === 'question' ? (
          <>
            <InteractionButton
              busy={busyAction === 'cancel'}
              disabled={Boolean(busyAction)}
              label={t('取消')}
              onClick={() => void respond('cancel')}
            />
            <InteractionButton
              primary
              busy={busyAction === 'submit'}
              disabled={Boolean(busyAction) || !answersComplete}
              label={t('提交回答')}
              onClick={submitQuestions}
            />
          </>
        ) : interaction.kind === 'elicitation' && interaction.elicitationMode === 'url' ? (
          <>
            <InteractionButton
              primary
              busy={busyAction === 'submit'}
              disabled={Boolean(busyAction) || !interaction.url}
              label={t('同意并打开')}
              onClick={() => void acceptUrl()}
            />
            <InteractionButton
              busy={busyAction === 'deny'}
              disabled={Boolean(busyAction)}
              label={t('拒绝')}
              onClick={() => void respond('deny')}
            />
            <InteractionButton
              busy={busyAction === 'cancel'}
              disabled={Boolean(busyAction)}
              label={t('取消')}
              onClick={() => void respond('cancel')}
            />
          </>
        ) : interaction.kind === 'elicitation' ? (
          <>
            <InteractionButton
              busy={busyAction === 'deny'}
              disabled={Boolean(busyAction)}
              label={t('拒绝')}
              onClick={() => void respond('deny')}
            />
            <InteractionButton
              busy={busyAction === 'cancel'}
              disabled={Boolean(busyAction)}
              label={t('取消')}
              onClick={() => void respond('cancel')}
            />
            <InteractionButton
              primary
              busy={busyAction === 'submit'}
              disabled={Boolean(busyAction)}
              label={t('提交')}
              onClick={submitValues}
            />
          </>
        ) : (
          <>
            <InteractionButton
              busy={busyAction === 'cancel'}
              disabled={Boolean(busyAction)}
              label={t('取消')}
              onClick={() => void respond('cancel')}
            />
            <InteractionButton
              primary
              busy={busyAction === 'submit'}
              disabled={Boolean(busyAction) || !message.trim()}
              label={t('提交')}
              onClick={() => void respond('submit', {
                [props.publicInteraction!.questions[0]!.id]: message.trim()
              })}
            />
          </>
        )}
      </footer>
    </ThreadDetailRequest>
  )
}

function InteractionButton(props: {
  readonly busy: boolean
  readonly disabled: boolean
  readonly label: string
  readonly primary?: boolean
  onClick(): void
}): React.JSX.Element {
  return (
    <button
      className={props.primary ? 'primary' : ''}
      disabled={props.disabled}
      onClick={props.onClick}
      type="button"
    >
      {props.busy ? <LoaderCircle className="claude-renderer-spin" size={12} /> : null}
      {props.label}
    </button>
  )
}
