import type { HarnessOverviewDisplayPolicy } from '@openagent/contracts/renderer'
import type { DeepReadonly, PublicInteraction } from '@openagent/contracts'
import type { HarnessRendererThreadActions, HarnessRendererThreadInput } from '@openagent/contracts/renderer'
import { isPublicExecutionActive } from '@openagent/contracts/renderer'
import { useI18n } from '@openagent/plugin-kit/renderer'
import { HarnessThreadCard, ThreadCardStatus } from '@openagent/plugin-kit/renderer'
import { composeThreadCard } from '@openagent/plugin-kit/renderer'
import type { ThreadCardIdentityView, ThreadCardPresentation } from '@openagent/plugin-kit/renderer'
import { isTemporaryWorkspacePath } from '@openagent/contracts'
import { claudeCardProjection, claudeCardUsage } from './overview-projection.js'
import {
  currentClaudeTurn,
  latestVisibleClaudePrompt,
  pendingClaudeInteraction,
  type ClaudeForkHistory,
  type ClaudeThreadState,
  type ClaudeTurnStatus
} from '../shared/state.js'
import { type ClaudeThreadSettings } from '../shared/settings.js'
import claudeCodeLogo from './claude-code.svg?inline'
import { claudePublicInteractionsByNativeId } from './public-interactions.js'
import { decodeClaudeRendererState } from './state.js'
import { boundedText } from './values.js'

export interface ClaudeOverviewView {
  readonly status: 'idle' | 'waiting' | ClaudeTurnStatus
  readonly statusLabel?: string
  readonly summary: string
  readonly identity: Omit<ThreadCardIdentityView, 'title' | 'model' | 'effort' | 'providerStatus' | 'state'> & {
    readonly title: string
    readonly model: string
    readonly effort?: string
  }
  readonly presentation: ThreadCardPresentation
  readonly pendingPublicInteraction?: PublicInteraction
}

type OverviewCardProps = HarnessRendererThreadInput & {
  readonly projection: DeepReadonly<ClaudeOverviewView>
  readonly actions: HarnessRendererThreadActions & { openThread(): void }
}

export function projectClaudeOverview(input: HarnessRendererThreadInput & {
  readonly displayPolicy?: HarnessOverviewDisplayPolicy
  readonly layout: { readonly availableColumns: number }
}) {
  if (input.thread.harnessId !== 'claude') {
    throw new Error(`Claude Renderer 收到 ${input.thread.harnessId} Thread`)
  }
  const state = decodeClaudeRendererState(input.thread.sessionState)
  const turn = currentClaudeTurn(state)
  const pending = pendingClaudeInteraction(turn)
  const publicInteraction = pending
    ? claudePublicInteractionsByNativeId(state, input.thread.observation).get(pending.id)
    : undefined
  const status: ClaudeOverviewView['status'] = pending ? 'waiting' :
    isPublicExecutionActive(input.thread.observation) || turn?.status === 'running'
      ? 'running' : turn?.status || 'idle'
  const summary = overviewSummary(state, input.thread.title)
  const settings = input.thread.settings as DeepReadonly<ClaudeThreadSettings>
  const cwd = input.thread.worktree?.baseCwd?.trim() || input.thread.cwd
  const visiblePrompts = turn?.prompts.filter((_, index) => !turn.internalPromptIndexes?.includes(index)) ?? []
  const steer = visiblePrompts.length > 1 ? visiblePrompts.at(-1) : undefined
  const presentation = composeThreadCard(
    claudeCardProjection(turn, state.runtime?.backgroundTasks ?? [], pending, publicInteraction),
    { displayPolicy: input.displayPolicy, availableCols: input.layout.availableColumns }
  )
  const view: ClaudeOverviewView = {
    status,
    ...(turn?.statusLabel ? { statusLabel: turn.statusLabel } : {}),
    summary,
    identity: {
      title: input.thread.title,
      model: state.runtime?.model || settings.model || 'Claude',
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(cwd && !isTemporaryWorkspacePath(cwd) ? { cwd } : {}),
      usesWorktree: Boolean(input.thread.worktree),
      ...(steer ? { steer } : {}),
      ...(input.thread.observation.latestExecution ? { runtime: {
        startedAt: input.thread.observation.latestExecution.startedAt,
        ...('finishedAt' in input.thread.observation.latestExecution ? { endedAt: input.thread.observation.latestExecution.finishedAt } : {})
      } } : {}),
      excerpt: summary,
      message: overviewMessage(state, input.thread.title)
    },
    presentation,
    ...(publicInteraction ? { pendingPublicInteraction: publicInteraction } : {})
  }
  return {
    footprint: { columns: presentation.size.cols, rows: presentation.size.rows },
    structureKey: presentation.key,
    excerpt: summary,
    view
  }
}

export function claudeExecutionTokenUsage(thread: DeepReadonly<HarnessRendererThreadInput['thread']>, executionId: string):
  { readonly value: string; readonly count: number; readonly suffix: string } | undefined {
  const turn = decodeClaudeRendererState(thread.sessionState).turns.findLast(item => item.executionId === executionId)
  const part = claudeCardUsage(turn?.usage)?.parts.find(item => item.id === 'total')
  return part?.numericValue === undefined ? undefined : { value: part.value, count: part.numericValue, suffix: part.suffix ?? '' }
}

export function ClaudeOverviewCard(props: OverviewCardProps): React.JSX.Element {
  const { t } = useI18n()
  const view = props.projection
  const publicInteraction = view.pendingPublicInteraction
  const presentation = view.presentation.projection.kind !== 'standard' ? view.presentation : {
    ...view.presentation,
    projection: {
      ...view.presentation.projection,
      extensions: view.presentation.projection.extensions.map((extension) =>
        extension.kind !== 'intervention' ? extension : {
          ...extension,
          intervention: {
            ...extension.intervention,
            actions: extension.intervention.actions.map((action) => {
              const intent = publicInteraction?.actions.find(({ id }) => id === action.id)?.intent
              return { ...action, label: intent === 'allow'
                ? t(action.id === 'allow-session' ? '本会话始终允许' : '允许一次')
                : intent === 'deny' ? t('拒绝') : intent === 'cancel' ? t('取消') : t('提交回答') }
            })
          }
        })
    }
  }
  return (
    <HarnessThreadCard
      identity={{
        ...view.identity,
        providerStatus: <ThreadCardStatus
          brandKey="claude" label="Claude" logoSource={claudeCodeLogo} observation={props.thread.observation}
        />
      }}
      presentation={presentation}
      onOpenThread={props.actions.openThread}
      onInterventionResponse={async (response) => {
        if (!publicInteraction || !publicInteraction.actions.some(({ id }) => id === response.actionId)) {
          throw new Error(t('该请求已失效。'))
        }
        await props.actions.respond({
          interactionId: publicInteraction.id,
          actionId: response.actionId,
          ...(response.answers ? { answers: response.answers } : {})
        })
      }}
    />
  )
}

function overviewSummary(state: ClaudeThreadState, fallback: string): string {
  const turn = currentClaudeTurn(state)
  const forkSummary = forkHistorySummary(state.forkHistory)
  const live = turn?.status === 'running'
  const latestText = turn?.timeline.findLast((item) =>
    (item.kind === 'assistant' || item.kind === 'reasoning') && item.content.trim())
  const source = (latestText && 'content' in latestText ? latestText.content.trim() : '') ||
    turn?.text.trim() || turn?.reasoning.trim() || turn?.error ||
    latestVisibleClaudePrompt(turn) || turn?.statusLabel || forkSummary ||
    state.nativeNotifications.at(-1)?.summary || fallback
  const text = source.trim()
  const characters = Array.from(text)
  const hasOutput = Boolean(latestText || turn?.text.trim() || turn?.reasoning.trim())
  return live && hasOutput && characters.length > 600 ? `…${characters.slice(-600).join('')}` : boundedText(text, 600)
}

function overviewMessage(state: ClaudeThreadState, fallback: string): NonNullable<ThreadCardIdentityView['message']> {
  const turn = currentClaudeTurn(state)
  const latest = turn?.timeline.findLast(item =>
    (item.kind === 'assistant' || item.kind === 'reasoning') && item.content.trim())
  if (latest?.kind === 'assistant' || latest?.kind === 'reasoning') {
    const nativeId = latest.kind === 'assistant' ? latest.messageId : undefined
    const text = nativeId ? turn!.timeline.flatMap(item =>
      item.kind === 'assistant' && item.messageId === nativeId ? [item.content] : []).join('') : latest.content
    return { id: JSON.stringify([turn!.executionId, latest.kind, nativeId ?? latest.id]), text: text.trim() }
  }
  const candidates = [
    ['answer', turn?.text], ['reasoning', turn?.reasoning], ['error', turn?.error],
    [`prompt:${turn?.prompts.length ?? 0}`, latestVisibleClaudePrompt(turn)], ['status', turn?.statusLabel],
    ['history', forkHistorySummary(state.forkHistory)], ['notice', state.nativeNotifications.at(-1)?.summary], ['title', fallback]
  ] as const
  const [kind, text] = candidates.find(([, text]) => text?.trim()) ?? ['title', fallback]
  return { id: JSON.stringify([turn?.executionId ?? null, kind]), text: text?.trim() ?? '' }
}

function forkHistorySummary(history: ClaudeForkHistory | undefined): string {
  if (!history) return ''
  for (let index = history.items.length - 1; index >= 0; index -= 1) {
    const item = history.items[index]!
    const candidate = item.kind === 'user-message' ||
      item.kind === 'assistant' ||
      item.kind === 'reasoning' ||
      item.kind === 'diff' ||
      item.kind === 'review'
      ? item.content
      : item.kind === 'error'
        ? item.message
        : item.kind === 'notice'
          ? item.notice.message
          : ''
    if (candidate.trim()) return candidate
  }
  return ''
}
