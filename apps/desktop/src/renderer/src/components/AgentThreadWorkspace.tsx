import { memo, useMemo } from 'react'
import type { AgentThreadRecord } from '@openagent/contracts'
import type { HarnessRendererThreadActions, HarnessRendererThreadInput } from '@openagent/contracts/renderer'
import {
  HarnessThreadViewHost,
  threadActions
} from '../harness-composition'
import { ThreadDetailFrame, useI18n } from '@openagent/plugin-kit/renderer'

export interface AgentThreadWorkspaceProps {
  readonly thread: AgentThreadRecord
  readonly onBack: () => void
  readonly backLabel?: string
  readonly readingTarget?: HarnessRendererThreadInput['readingTarget']
  readonly interrupt: (threadId: string) => Promise<void>
  readonly respond: typeof window.openAgent.respondToThreadInteraction
  readonly onFollowUp: (threadId: string, initialDraft?: string) => void
  readonly hostActions?: Pick<HarnessRendererThreadActions,
    'forkThread' | 'invokeHarnessExtension' | 'openExternal'>
}

export const AgentThreadWorkspace = memo(function AgentThreadWorkspace(
  props: AgentThreadWorkspaceProps
): React.JSX.Element {
  const { t } = useI18n()
  const actions = useMemo(() => ({
    ...threadActions({
      harnessId: props.thread.harnessId,
      threadId: props.thread.id,
      interrupt: props.interrupt,
      openFollowUp: (initialDraft) => { if (!props.thread.archived) props.onFollowUp(props.thread.id, initialDraft) },
      respond: props.respond
    }),
    ...props.hostActions
  }), [props.thread.harnessId, props.thread.id, props.thread.archived, props.interrupt, props.respond, props.onFollowUp, props.hostActions])

  return (
    <ThreadDetailFrame navigation={{ label: props.backLabel ?? t('俯瞰'), onBack: props.onBack }} className="workspace agent-thread-workspace thread-detail-theme">
      <div className="thread-workspace-drag-region" aria-hidden="true" />
      <main className="agent-thread-content">
        <HarnessThreadViewHost
          actions={actions}
          thread={props.thread}
          readingTarget={props.readingTarget}
        />
      </main>
    </ThreadDetailFrame>
  )
})
