import {
  CheckCircle2,
  CircleAlert,
  CircleMinus,
  CircleX,
  LoaderCircle
} from 'lucide-react'
import type {
  HarnessRendererThreadActions,
  HarnessRendererThreadInput
} from '@openagent/contracts/renderer'
import { ThreadCardProviderStatus } from '@openagent/plugin-kit/renderer'
import {
  HarnessThreadCard,
  ThreadCardStateLabel
} from '@openagent/plugin-kit/renderer'
import type {
  ThreadCardInterventionResponse,
  ThreadCardPresentation
} from '@openagent/plugin-kit/renderer'
import { useI18n } from '@openagent/plugin-kit/renderer'
import codexLogo from './codex-glyph.svg?inline'
import { codexActionLabel, codexModelLabel, codexStatusLabel } from './copy.js'
import type { CodexOverviewStatus, CodexOverviewView } from './overview.js'

export function CodexOverviewCard({
  projection,
  actions
}: HarnessRendererThreadInput & {
  readonly projection: CodexOverviewView
  readonly actions: HarnessRendererThreadActions & { openThread(): void }
}): React.JSX.Element {
  const { t } = useI18n()
  const respond = (request: ThreadCardInterventionResponse): Promise<void> => {
    if (!projection.pendingInteractionId) {
      return Promise.reject(new Error(t('该 Codex 请求已失效。')))
    }
    return actions.respond({
      interactionId: projection.pendingInteractionId,
      actionId: request.actionId,
      ...(request.answers
        ? {
            answers: Object.fromEntries(
              Object.entries(request.answers).map(([id, value]) => [
                id,
                typeof value === 'string' ? value : [...value]
              ])
            )
          }
        : {})
    })
  }
  return (
    <HarnessThreadCard
      identity={{
        ...projection.identity,
        ...(typeof projection.identity.model === 'string'
          ? { model: codexModelLabel(projection.identity.model, t) }
          : {}),
        providerStatus: (
          <ThreadCardProviderStatus
            brandKey="codex"
            label="Codex"
            logoSource={codexLogo}
            statusClassName={projection.status}
          />
        ),
        state: (
          <ThreadCardStateLabel
            className={projection.status}
            icon={statusIcon(projection.status)}
          >
            {codexStatusLabel(projection.status, projection.statusLabel, t)}
          </ThreadCardStateLabel>
        )
      }}
      presentation={localizeCodexPresentation(projection.presentation, t)}
      onInterventionResponse={projection.pendingInteractionId ? respond : undefined}
      onOpenThread={actions.openThread}
    />
  )
}

function localizeCodexPresentation(
  presentation: ThreadCardPresentation,
  t: (source: string) => string
): ThreadCardPresentation {
  if (presentation.projection.kind !== 'standard') return presentation
  return {
    ...presentation,
    projection: {
      ...presentation.projection,
      extensions: presentation.projection.extensions.map((extension) =>
        extension.kind !== 'intervention'
          ? extension
          : {
              ...extension,
              intervention: {
                ...extension.intervention,
                actions: extension.intervention.actions.map((action) => ({
                  ...action,
                  label: codexActionLabel(action, t)
                }))
              }
            }
      )
    }
  }
}

function statusIcon(status: CodexOverviewStatus): React.ReactNode {
  if (status === 'running') return <LoaderCircle size={13} />
  if (status === 'attention') return <CircleAlert size={13} />
  if (status === 'failed') return <CircleX size={13} />
  if (status === 'cancelled') return <CircleMinus size={13} />
  return <CheckCircle2 size={13} />
}
