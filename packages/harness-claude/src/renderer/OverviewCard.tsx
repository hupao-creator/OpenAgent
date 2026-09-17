import type { HarnessOverviewDisplayPolicy } from '@openagent/contracts/renderer'
import type { DeepReadonly, PublicInteraction } from '@openagent/contracts'
import type { HarnessRendererThreadActions, HarnessRendererThreadInput } from '@openagent/contracts/renderer'
import { isPublicExecutionActive } from '@openagent/contracts/renderer'
import { useI18n } from '@openagent/plugin-kit/renderer'
import { HarnessThreadCard, ThreadCardStateLabel } from '@openagent/plugin-kit/renderer'
import { ThreadCardProviderStatus } from '@openagent/plugin-kit/renderer'
import { composeThreadCard } from '@openagent/plugin-kit/renderer'
import type { ThreadCardIdentityView, ThreadCardPresentation } from '@openagent/plugin-kit/renderer'
import { isTemporaryWorkspacePath } from '@openagent/contracts'
import { claudeCardProjection } from './overview-projection.js'
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
import { StatusGlyph } from './primitives.js'
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

const OVERVIEW_STATUS_LABELS: Record<ClaudeOverviewView['status'], string> = {
  idle: '等待开始',
  running: '运行中',
  waiting: '等待你的响应',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断'
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
      ...(turn ? { runtime: {
        startedAt: turn.createdAt,
        ...(turn.status === 'running' ? {} : { endedAt: turn.updatedAt })
      } } : {}),
      excerpt: summary
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

export function ClaudeOverviewCard(props: OverviewCardProps): React.JSX.Element {
  const { t } = useI18n()
  const view = props.projection
  const publicInteraction = view.pendingPublicInteraction
  const stateClass = view.status === 'waiting' ? 'attention' :
    view.status === 'interrupted' ? 'cancelled' : view.status
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
        providerStatus: <ThreadCardProviderStatus
          brandKey="claude" label="Claude" logoSource={claudeCodeLogo} statusClassName={stateClass}
        />,
        state: <ThreadCardStateLabel className={stateClass} icon={<StatusGlyph status={view.status} />}>
          {view.statusLabel || t(OVERVIEW_STATUS_LABELS[view.status])}
        </ThreadCardStateLabel>
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
    (item.kind === 'assistant' || (live && item.kind === 'reasoning')) && item.content.trim())
  const source = (latestText && 'content' in latestText ? latestText.content.trim() : '') ||
    turn?.text.trim() || turn?.reasoning.trim() || turn?.error ||
    latestVisibleClaudePrompt(turn) || turn?.statusLabel || forkSummary ||
    state.nativeNotifications.at(-1)?.summary || fallback
  const normalized = source.replace(/\s+/g, ' ').trim()
  const characters = Array.from(normalized)
  const hasOutput = Boolean(latestText || turn?.text.trim() || turn?.reasoning.trim())
  return live && hasOutput && characters.length > 600 ? `…${characters.slice(-600).join('')}` : boundedText(normalized, 600)
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
