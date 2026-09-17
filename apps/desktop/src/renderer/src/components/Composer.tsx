import { memo, useLayoutEffect, useRef } from 'react'
import { ArrowUp, Paperclip, Square } from 'lucide-react'
import type { BartDraftAttachment } from '../../../shared/attachments'
import { harnessDisplayName } from '../../../shared/harnesses'
import { extractPastePayload, insertTextAtSelection } from '../composer-paste'
import { isBartDraftSubmittable } from '../composer-draft'
import { AttachmentChips } from './AttachmentChips'
import { ProviderLogo } from './ProviderLogo'
import { useI18n } from '@openagent/plugin-kit/renderer'

/** Bart is the single conversational input for both coordination and follow-up. */
interface ComposerProps {
  value: string
  focusRequestKey?: number
  /**
   * Set by a caller that is about to hand focus to something else on this
   * entry (a located message): the composer then leaves the initial focus
   * alone. Later focus requests still work.
   */
  suppressInitialFocus?: boolean
  provider: string
  running: boolean
  submitting?: boolean
  disabled?: boolean
  bartAttachments: readonly BartDraftAttachment[]
  error?: string
  onChange: (value: string) => void
  onChooseFiles: () => void
  onPasteFiles?: (files: File[]) => void
  onRemoveBartAttachment: (id: string) => void
  onSend: () => void
  onCancel: () => void
}

function ComposerComponent(props: ComposerProps): React.JSX.Element {
  const { t } = useI18n()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const resizeTextarea = (): void => {
    const textarea = textareaRef.current
    if (!textarea) return
    if (!textarea.value) {
      textarea.style.height = ''
      return
    }
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
  }

  useLayoutEffect(() => resizeTextarea(), [props.value])
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    const composer = textarea?.parentElement
    if (!textarea || !composer || typeof ResizeObserver === 'undefined') return
    let lastWidth: number | undefined
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width
      if (width === undefined || width === lastWidth) return
      lastWidth = width
      resizeTextarea()
    })
    observer.observe(composer)
    return () => observer.disconnect()
  }, [])
  const suppressedRef = useRef(props.suppressInitialFocus === true)
  useLayoutEffect(() => {
    // Only the entry focus is given up; a caller that later asks for focus
    // (disabled lifted, a new request key, another provider) still gets it.
    if (suppressedRef.current) {
      suppressedRef.current = false
      return
    }
    if (!props.disabled) textareaRef.current?.focus()
  }, [props.disabled, props.focusRequestKey, props.provider])

  const canSend = Boolean(
    isBartDraftSubmittable(props.value, props.bartAttachments) &&
      !props.submitting && !props.disabled
  )
  const providerName = harnessDisplayName(props.provider)

  return (
    <div className="composer-wrap">
      <div className={`composer ${props.running ? 'running' : ''}`}>
        <AttachmentChips
          attachments={props.bartAttachments}
          onRemove={props.onRemoveBartAttachment}
        />
        <textarea
          ref={textareaRef}
          value={props.value}
          disabled={Boolean(props.disabled)}
          rows={1}
          placeholder={props.running
            ? t('Bart 正在协调任务…')
            : t('让 Bart 发起、协调或汇报任务…')}
          onChange={(event) => props.onChange(event.target.value)}
          onPaste={(event) => {
            const extraction = extractPastePayload<File>(event)
            if (!extraction.shouldPreventDefault) return
            event.preventDefault()
            if (extraction.text && textareaRef.current) {
              props.onChange(insertTextAtSelection(textareaRef.current, extraction.text))
            }
            props.onPasteFiles?.(extraction.files)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (canSend) props.onSend()
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-context">
            <span
              className="locked-provider"
              role="img"
              aria-label={providerName}
              title={providerName}
            >
              <ProviderLogo provider={props.provider} />
            </span>
            <button className="composer-tool" onClick={props.onChooseFiles} title={t('添加图片或文件')}>
              <Paperclip size={14} />
            </button>
          </div>
          <div className="composer-actions">
            {props.running ? (
              <button
                className="send-button stop"
                onClick={props.onCancel}
                disabled={props.disabled}
                title={t('停止 Bart')}
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : null}
            <button
              className="send-button"
              onClick={props.onSend}
              disabled={!canSend}
              title={t('发送')}
            >
              <ArrowUp size={17} />
            </button>
          </div>
        </div>
      </div>
      {props.error ? <div className="composer-warning error">{props.error}</div> : null}
    </div>
  )
}

export const Composer = memo(ComposerComponent)
