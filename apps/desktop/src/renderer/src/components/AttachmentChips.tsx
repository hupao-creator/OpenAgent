import { FileImage, FileText, Paperclip, X } from 'lucide-react'
import type {
  AgentAttachment,
  BartDraftAttachment
} from '../../../shared/attachments'
import { useI18n } from '@openagent/plugin-kit/renderer'
import './attachment-chips.css'

interface AttachmentChipsProps {
  attachments: readonly BartDraftAttachment[]
  onRemove: (id: string) => void
  className?: string
}

/** Bart 共享草稿的 ready / pending / failed 三态附件条。 */
export function AttachmentChips(props: AttachmentChipsProps): React.JSX.Element | null {
  const { t } = useI18n()
  if (!props.attachments.length) return null
  const className = ['bart-attachment-strip', props.className].filter(Boolean).join(' ')
  return (
    <div className={className} aria-label={t('Bart 附件')}>
      {props.attachments.map((draft) => {
        const id = draft.status === 'ready' ? draft.attachment.id : draft.id
        const name = draft.status === 'ready' ? draft.attachment.name : draft.name
        if (draft.status === 'ready') {
          return (
            <span className="attachment-chip" key={id} title={draft.attachment.path}>
              {attachmentIcon(draft.attachment.kind)}
              <span>{name}</span>
              <span className="attachment-size">{formatBytes(draft.attachment.size)}</span>
              <RemoveAttachmentButton id={id} name={name} onRemove={props.onRemove} />
            </span>
          )
        }
        if (draft.status === 'pending') {
          return (
            <span className="attachment-chip pending" key={id}>
              <Paperclip size={12} aria-hidden="true" />
              <span>{name}</span>
              <span className="attachment-size">{formatBytes(draft.size)}</span>
              <span className="attachment-status">{t('暂存中…')}</span>
              <RemoveAttachmentButton id={id} name={name} onRemove={props.onRemove} />
            </span>
          )
        }
        return (
          <span className="attachment-chip failed" key={id} title={draft.error}>
            <Paperclip size={12} aria-hidden="true" />
            <span>{name}</span>
            <RemoveAttachmentButton id={id} name={name} onRemove={props.onRemove} />
          </span>
        )
      })}
    </div>
  )
}

function RemoveAttachmentButton(props: {
  id: string
  name: string
  onRemove: (id: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={() => props.onRemove(props.id)}
      title={t('移除附件')}
      aria-label={t('移除附件：{name}', { name: props.name })}
    >
      <X size={11} aria-hidden="true" />
    </button>
  )
}

function attachmentIcon(kind: AgentAttachment['kind']): React.JSX.Element {
  return kind === 'image'
    ? <FileImage size={13} aria-hidden="true" />
    : kind === 'document'
      ? <FileText size={13} aria-hidden="true" />
      : <Paperclip size={13} aria-hidden="true" />
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}
