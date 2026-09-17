import { useMemo, useState } from 'react'
import {
  LoaderCircle,
  Settings,
  Trash2
} from 'lucide-react'
import type {
  AgentAttachment,
  BartDraftAttachment
} from '../../../shared/attachments'
import type { AgentInput, AgentInputPart } from '@openagent/contracts'
import type { BartThreadRecord } from '@openagent/contracts'
import type { RendererBartExecution } from '../../../shared/renderer-state-contracts'
import {
  harnessDisplayName } from '../../../shared/harnesses'
import {
  HarnessThreadViewHost,
  threadActions
} from '../harness-composition'
import {
  isPublicExecutionActive,
  type HarnessRendererThreadActions,
  type HarnessRendererThreadInput
} from '@openagent/contracts/renderer'
import { ThreadDetailFrame, useI18n } from '@openagent/plugin-kit/renderer'
import { Composer } from './Composer'

export interface BartThreadViewProps {
  readonly thread: BartThreadRecord
  /** One-shot navigation request the owning Harness resolves itself. */
  readonly readingTarget?: HarnessRendererThreadInput['readingTarget']
  readonly execution: RendererBartExecution | null
  readonly inputValue: string
  readonly attachments: readonly BartDraftAttachment[]
  readonly submitting: boolean
  readonly clearing: boolean
  readonly error: string
  readonly onBack: () => void
  readonly backLabel?: string
  readonly onSettings: (event: React.MouseEvent<HTMLButtonElement>) => void
  readonly onInputChange: (value: string) => void
  readonly onChooseFiles: () => void
  readonly onPasteFiles: (files: File[]) => void
  readonly onRemoveAttachment: (id: string) => void
  readonly onSubmit: () => void
  readonly onCancel: () => Promise<void>
  readonly onClear: () => void
  readonly respond: typeof window.openAgent.respondToThreadInteraction
  readonly hostActions?: Pick<HarnessRendererThreadActions,
    'forkThread' | 'invokeHarnessExtension' | 'openExternal'>
}

/** Core owns only the Bart shell; the selected Harness plugin renders its Thread. */
export function BartThreadView(props: BartThreadViewProps): React.JSX.Element {
  const { t } = useI18n()
  const [composerFocusRequest, setComposerFocusRequest] = useState(0)
  const latestExecution = props.thread.observation.latestExecution
  const error = props.error || (latestExecution?.status === 'failed'
    ? latestExecution.error || latestExecution.summary || t('操作失败')
    : '')
  const running = Boolean(props.execution) || isPublicExecutionActive(props.thread.observation)
  const clearBlocked = running || props.thread.observation.backgroundWork?.status === 'running'
  const actions = useMemo(() => ({
    ...threadActions({
      harnessId: props.thread.harnessId,
      threadId: props.thread.id,
      interrupt: async () => props.onCancel(),
      openFollowUp: (initialDraft) => {
        // Baseline suggestion semantics replace the editable draft; they never
        // append to an unrelated in-progress prompt.
        props.onInputChange(initialDraft)
        setComposerFocusRequest((current) => current + 1)
      },
      respond: props.respond
    }),
    ...props.hostActions
  }), [props.thread.harnessId, props.thread.id, props.onCancel, props.onInputChange, props.respond, props.hostActions])
  return (
    <ThreadDetailFrame navigation={{ label: props.backLabel ?? t('俯瞰'), onBack: props.onBack }} id="bart-thread-view" className="workspace bart-thread-workspace thread-detail-theme">
      <header className="workspace-header">
        <div className="header-leading">
          <div className="conversation-heading">
            <strong>Bart</strong>
            <span className="heading-separator" aria-hidden="true" />
            <span className="cwd-label">
              {harnessDisplayName(props.thread.harnessId)}
            </span>
          </div>
        </div>
        <div className="header-actions no-drag">
          <button
            type="button"
            className="icon-button"
            disabled={clearBlocked || props.clearing}
            title={clearBlocked
              ? t('Bart 运行中，停止后才能清空')
              : t('清空 Bart session')}
            aria-label={t('清空 Bart session')}
            onClick={props.onClear}
          >
            {props.clearing ? <LoaderCircle size={14} /> : <Trash2 size={14} />}
          </button>
          <button
            aria-label={t('设置')}
            className="icon-button"
            data-settings-trigger onClick={props.onSettings}
            title={t('设置（⌘/Ctrl ,）')}
          >
            <Settings size={15} />
          </button>
        </div>
      </header>

      <main className="agent-thread-content">
        <HarnessThreadViewHost actions={actions} readingTarget={props.readingTarget} thread={props.thread} />
      </main>

      <Composer
        focusRequestKey={composerFocusRequest}
        suppressInitialFocus={props.readingTarget?.message !== undefined}
        value={props.inputValue}
        provider={props.thread.harnessId}
        running={running}
        submitting={props.submitting}
        bartAttachments={props.attachments}
        error={error}
        onChange={props.onInputChange}
        onChooseFiles={props.onChooseFiles}
        onPasteFiles={props.onPasteFiles}
        onRemoveBartAttachment={props.onRemoveAttachment}
        onSend={props.onSubmit}
        onCancel={() => void props.onCancel()}
      />
    </ThreadDetailFrame>
  )
}

export function buildAgentInput(
  text: string,
  attachments: readonly AgentAttachment[]
): AgentInput {
  const parts: AgentInputPart[] = []
  const prompt = text.trim()
  if (prompt) parts.push({ kind: 'text', text: prompt })
  for (const attachment of attachments) {
    const file = {
      id: attachment.id,
      path: attachment.path,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size
    }
    parts.push(attachment.kind === 'image'
      ? { kind: 'image', file }
      : { kind: 'local-file', file })
  }
  return { parts }
}
