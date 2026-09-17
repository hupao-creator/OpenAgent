import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n.js'

/**
 * 提问型介入的共享控件：俯瞰卡片与各 provider 的 thread surface 共用同一套
 * 选择语义与排版。这里只做展示与本地选择状态；选项的提交值由调用方投影。
 */

interface InteractionQuestionOption {
  id: string
  label: string
  description?: string
  /** 实际提交出去的值。 */
  value: string
}

export interface InteractionQuestionSpec {
  id: string
  prompt: string
  header?: string
  multiple: boolean
  /** 允许自定义回答；无选项的纯文本题恒等于 true。 */
  allowOther: boolean
  secret: boolean
  options: InteractionQuestionOption[]
}

export interface InteractionAnswerState {
  picked: (question: InteractionQuestionSpec) => string[]
  otherOpen: (question: InteractionQuestionSpec) => boolean
  otherText: (question: InteractionQuestionSpec) => string
  toggle: (question: InteractionQuestionSpec, value: string) => void
  toggleOther: (question: InteractionQuestionSpec) => void
  writeOther: (question: InteractionQuestionSpec, text: string) => void
  answered: (question: InteractionQuestionSpec) => boolean
  answersFor: (
    questions: InteractionQuestionSpec[]
  ) => Record<string, string | string[]>
}

/** 无选项的题目就是纯文本题：输入框常驻，不需要「其它…」开关。 */
function textOnly(question: InteractionQuestionSpec): boolean {
  return question.options.length === 0
}

export function useInteractionAnswers(): InteractionAnswerState {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})

  const pickedOf = (question: InteractionQuestionSpec): string[] =>
    picked[question.id] ?? []
  // 「其它…」的开合看键在不在，不是值空不空：置空串会让它错显示为已选中。
  const otherOpen = (question: InteractionQuestionSpec): boolean =>
    textOnly(question) || other[question.id] !== undefined
  const otherText = (question: InteractionQuestionSpec): string =>
    other[question.id] ?? ''
  const clearOther = (questionId: string): void => {
    setOther((rest) =>
      Object.fromEntries(Object.entries(rest).filter(([id]) => id !== questionId))
    )
  }
  const answerOf = (question: InteractionQuestionSpec): string[] => {
    const raw = otherText(question)
    // secret 回答按原文提交：首尾空格可能是口令的一部分，不能替用户 trim。
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
      // 单选选了列表里的选项，就撤掉之前填的自定义回答。
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
        // 单选下自定义回答与列表选项互斥，展开输入框即撤掉已选项。
        if (!question.multiple) setPicked((rest) => ({ ...rest, [question.id]: [] }))
      } else {
        clearOther(question.id)
      }
    },
    writeOther: (question, text) => {
      setOther((rest) => ({ ...rest, [question.id]: text }))
    },
    // 只带上真正作答的题，避免把「没答」编码成「答了个空」。
    answersFor: (questions) =>
      Object.fromEntries(
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

/**
 * 单题控件：选项纵向排列，指示器形状区分单选（圆点）与多选（圆角方块），
 * 「其它…」就地展开输入框。
 */
export function InteractionQuestionField(props: {
  question: InteractionQuestionSpec
  state: InteractionAnswerState
  disabled?: boolean
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
            <InteractionOtherAnswer
              open={state.otherOpen(question)}
              value={state.otherText(question)}
              label={question.prompt}
              secret={question.secret}
              disabled={props.disabled}
              onOpen={() => state.toggleOther(question)}
              onClose={() => state.toggleOther(question)}
              onChange={(text) => state.writeOther(question, text)}
            />
          ) : null}
        </span>
      ) : null}
      {textOnly(question) ? (
        <input
          aria-label={question.prompt}
          className="interaction-question-input"
          disabled={props.disabled}
          onChange={(event) => state.writeOther(question, event.target.value)}
          placeholder={t('输入回答')}
          autoComplete={question.secret ? 'off' : undefined}
          type={question.secret ? 'password' : 'text'}
          value={state.otherText(question)}
        />
      ) : null}
    </div>
  )
}

/** A custom-answer option turns into its editor without adding another row. */
export function InteractionOtherAnswer(props: {
  readonly open: boolean
  readonly value: string
  readonly label: string
  readonly secret?: boolean
  readonly disabled?: boolean
  readonly onOpen: () => void
  readonly onClose: () => void
  readonly onChange: (text: string) => void
}): ReactNode {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (props.open) inputRef.current?.focus({ preventScroll: true })
  }, [props.open])
  return props.open ? <input
    ref={inputRef}
    aria-label={props.label}
    className="interaction-question-input interaction-question-other-input"
    disabled={props.disabled}
    placeholder={t('输入你的回答')}
    type={props.secret ? 'password' : 'text'}
    autoComplete={props.secret ? 'off' : undefined}
    value={props.value}
    onChange={(event) => props.onChange(event.target.value)}
    onBlur={() => {
      if (!(props.secret ? props.value : props.value.trim())) props.onClose()
    }}
    onKeyDown={(event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      props.onClose()
    }}
  /> : <button
    className="interaction-question-other"
    disabled={props.disabled}
    onClick={props.onOpen}
    type="button"
  >{t('其它…')}</button>
}
