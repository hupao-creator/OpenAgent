import type {
  HarnessRendererThreadActions,
  HarnessRendererThreadInput
} from '@openagent/contracts/renderer'
import { HarnessThreadCard, ThreadCardStatus } from '@openagent/plugin-kit/renderer'
import type {
  ThreadCardInterventionResponse,
  ThreadCardPresentation
} from '@openagent/plugin-kit/renderer'
import { useI18n } from '@openagent/plugin-kit/renderer'
import codexLogo from './codex-glyph.svg?inline'
import { codexActionLabel, codexModelLabel } from './copy.js'
import type { CodexOverviewView } from './overview.js'

export function CodexOverviewCard({
  thread,
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
          <ThreadCardStatus
            brandKey="codex"
            label="Codex"
            logoSource={codexLogo}
            observation={thread.observation}
          />
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
