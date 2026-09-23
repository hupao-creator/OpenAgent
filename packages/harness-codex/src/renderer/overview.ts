import type { HarnessOverviewDisplayPolicy } from '@openagent/contracts/renderer'
import type {
  HarnessOverviewProjection,
  HarnessRendererThreadInput
} from '@openagent/contracts/renderer'
import type { PublicInteraction } from '@openagent/contracts'
import { isTemporaryWorkspacePath } from '@openagent/contracts'
import { composeThreadCard } from '@openagent/plugin-kit/renderer'
import type {
  ThreadCardIdentityView,
  ThreadCardActivityStatus,
  ThreadCardIdentityProjection,
  ThreadCardIdentityTool,
  ThreadCardIdentityToolKind,
  ThreadCardIdentityUsage,
  ThreadCardIntervention,
  ThreadCardPresentation,
  ThreadCardProjection,
  ThreadCardQuestion
} from '@openagent/plugin-kit/renderer'
import type { DeepReadonly, HarnessThreadRecord } from '@openagent/contracts'
import { createEmptyCodexState, decodeCodexState, latestCodexTurn } from '../shared/state.js'
import type {
  CodexHarnessState,
  CodexInteraction,
  CodexThreadSettings,
  CodexTurn
} from '../shared/types.js'
import { codexPublicInteractionsByNativeId } from './public-interactions.js'

export type CodexOverviewStatus =
  | 'running'
  | 'attention'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'idle'

export interface CodexOverviewView {
  readonly identity: ThreadCardIdentityView
  readonly presentation: ThreadCardPresentation
  readonly status: CodexOverviewStatus
  readonly statusLabel: string
  readonly pendingInteractionId?: string
}

/** Codex-private state projection; Core receives only the opaque presentation result. */
export function projectCodexOverview(
  input: HarnessRendererThreadInput & {
    readonly displayPolicy?: HarnessOverviewDisplayPolicy
    readonly layout: { readonly availableColumns: number }
  }
): HarnessOverviewProjection<CodexOverviewView> {
  const state = input.thread.sessionState === null
    ? createEmptyCodexState(input.thread.createdAt)
    : decodeCodexState(input.thread.sessionState)
  const turn = latestCodexTurn(state)
  const pendingInteraction = turn?.interactions.find(
    (interaction) => interaction.status === 'pending' && interaction.blocksTurn
  )
  const publicInteractionsByNativeId = codexPublicInteractionsByNativeId(
    state,
    input.thread.observation
  )
  const publicPendingInteraction = pendingInteraction
    ? publicInteractionsByNativeId.get(pendingInteraction.id)
    : undefined
  const live = Boolean(turn && activeTurn(turn))
  const projection = codexCardProjection(
    state,
    turn,
    live,
    publicInteractionsByNativeId
  )
  const presentation = composeThreadCard(projection, {
    displayPolicy: input.displayPolicy, availableCols: input.layout.availableColumns
  })
  const status = codexOverviewStatus(turn)
  // Inherited history supplies a preview until the child starts its own work.
  // It never contributes execution status, tools, usage, or pending actions.
  const previewTurn = turn ?? state.forkHistory?.at(-1)
  const prompt = previewTurn?.messages.findLast((message) =>
    message.role === 'user' && message.internal !== true && message.content.trim())
  const latestText = previewTurn?.timeline.findLast((item) =>
    (item.kind === 'assistant' || item.kind === 'reasoning') && item.content.trim())
  const currentText = latestText && 'content' in latestText ? latestText.content : previewTurn?.answer ?? ''
  const excerpt = headExcerpt(currentText, 600, live) ||
    headExcerpt(previewTurn?.reasoning ?? '', 600) || headExcerpt(previewTurn?.error ?? '', 600) ||
    headExcerpt(prompt?.content ?? '', 600) || ''
  const message = latestText?.kind === 'assistant' || latestText?.kind === 'reasoning'
    ? { id: JSON.stringify([previewTurn!.executionId, latestText.kind, latestText.kind === 'assistant' ? latestText.itemId : latestText.id]), text: messageWindowText(latestText.content, latestText.kind === 'assistant' ? 256 * 1024 : 64 * 1024) }
    : (() => {
      const [kind, text] = ([['answer', previewTurn?.answer], ['reasoning', previewTurn?.reasoning], ['error', previewTurn?.error],
        [`prompt:${prompt?.id ?? ''}`, prompt?.content]] as const).find(([, text]) => text?.trim()) ?? ['empty', '']
      return { id: JSON.stringify([previewTurn?.executionId ?? null, kind]), text: text?.trim() ?? '' }
    })()
  const settings = input.thread.settings as CodexThreadSettings
  const cwd = input.thread.worktree?.baseCwd?.trim() || input.thread.cwd
  const steer = turn?.messages.findLast(
    (message) => message.kind === 'follow-up' && message.internal !== true
  )?.content.trim()
  const identity: ThreadCardIdentityView = {
    title: input.thread.title,
    model: turn?.runtimeModel?.trim() || settings.model?.trim() || '未知模型',
    ...(settings.effort?.trim() ? { effort: settings.effort.trim() } : {}),
    ...(settings.serviceTier === 'priority' ? { fastMode: true } : {}),
    ...(input.thread.observation.latestExecution ? {
      runtime: { startedAt: input.thread.observation.latestExecution.startedAt,
        ...('finishedAt' in input.thread.observation.latestExecution ? { endedAt: input.thread.observation.latestExecution.finishedAt } : {}) }
    } : {}),
    ...(cwd && !isTemporaryWorkspacePath(cwd) ? { cwd, cwdName: threadCardCwdName(cwd) } : {}),
    ...(input.thread.worktree ? { usesWorktree: true } : {}),
    ...(steer ? { steer } : {}),
    excerpt,
    message
  }
  return {
    footprint: {
      columns: presentation.size.cols,
      rows: presentation.size.rows
    },
    structureKey: presentation.key,
    excerpt,
    view: {
      identity,
      presentation,
      status,
      statusLabel: codexOverviewStatusLabel(status, turn),
      ...(publicPendingInteraction
        ? { pendingInteractionId: publicPendingInteraction.id }
        : {})
    }
  }
}

/** tail() prefixes capped native text with a synthetic omission marker.
 * Keep it out of the streaming coordinates so suffix overlap stays detectable. */
function messageWindowText(content: string, limit: number): string {
  return content.length === limit && content.startsWith('…\n') ? content.slice(2) : content
}

function codexCardProjection(
  state: CodexHarnessState,
  turn: CodexTurn | undefined,
  live: boolean,
  publicInteractionsByNativeId: ReadonlyMap<string, PublicInteraction>
): ThreadCardProjection {
  if (!turn) return { kind: 'standard', identity: {}, extensions: [] }
  const extensions: Extract<ThreadCardProjection, { kind: 'standard' }>['extensions'][number][] = []
  const plan = live ? turn.plan : []
  if (plan.some((step) => step.status !== 'completed')) {
    extensions.push({ kind: 'todo', steps: plan })
  }
  const intervention = pendingIntervention(turn, publicInteractionsByNativeId)
  if (intervention) extensions.push({ kind: 'intervention', intervention })
  const derived = [
    ...(live
      ? turn.activities
        .filter((activity) =>
          activity.status === 'running' &&
          (activity.kind === 'agent' || activity.kind === 'subagent')
        )
        .map((activity) => ({
          id: activity.id,
          label: activity.label,
          status: activity.status,
          kind: 'agent' as const,
          commandLine: false
        }))
      : []),
    ...state.backgroundTerminals.map((terminal) => ({
      id: terminal.id,
      label: terminal.command,
      status: 'running' as const,
      kind: 'shell' as const,
      commandLine: true
    }))
  ]
  if (derived.length) extensions.push({ kind: 'derived', rows: derived })
  const excludedNames = new Set([
    'update_plan',
    ...(turn.interactions.some((interaction) => interaction.status === 'pending' && interaction.blocksTurn) ? ['request_user_input'] : []),
    ...turn.interactions
      .filter((interaction) => interaction.status === 'pending' && interaction.blocksTurn)
      .flatMap((interaction) => [interaction.detail, interaction.title])
      .filter((value): value is string => Boolean(value))
  ])
  const identity = threadCardIdentityProjection(
    turn.activities
      .filter((activity) =>
        activity.kind === 'command' || activity.kind === 'file' ||
        activity.kind === 'search' || activity.kind === 'tool'
      )
      .map(({ id, kind, label, status }) => ({ id, kind, label, status })),
    codexCardUsage(turn.usage),
    { excludedNames }
  )
  return { kind: 'standard', identity, extensions }
}

function pendingIntervention(
  turn: CodexTurn,
  publicInteractionsByNativeId: ReadonlyMap<string, PublicInteraction>
): ThreadCardIntervention | undefined {
  const pending = turn.interactions.find(
    (interaction) => interaction.status === 'pending' && interaction.blocksTurn
  )
  if (!pending) return undefined
  const publicInteraction = publicInteractionsByNativeId.get(pending.id)
  if (!publicInteraction) return undefined
  const questions = cardQuestions(pending, publicInteraction)
  const submit = questions
    ? publicInteraction.actions.find((action) => action.intent === 'submit')
    : undefined
  if (questions && submit) {
    return {
      id: publicInteraction.id,
      title: publicInteraction.title,
      ...(publicInteraction.description ? { detail: publicInteraction.description } : {}),
      questions,
      submitActionId: submit.id,
      actions: publicInteraction.actions
        .filter((action) => action.intent === 'submit' || action.intent === 'cancel')
        .map(({ id, label, intent }) => ({ id, label, intent }))
    }
  }
  return {
    id: publicInteraction.id,
    title: publicInteraction.title,
    ...(publicInteraction.description ? { detail: publicInteraction.description } : {}),
    actions: decisionActions(publicInteraction)
  }
}

function cardQuestions(
  interaction: CodexInteraction,
  publicInteraction: PublicInteraction
): readonly ThreadCardQuestion[] | undefined {
  if (interaction.kind !== 'user-input') return undefined
  const questions = publicInteraction.questions
  if (!questions.length || questions.some((question) =>
    question.secret
  )) return undefined
  return questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    ...(question.header ? { header: question.header } : {}),
    multiple: false,
    allowOther: question.allowOther,
    secret: false,
    options: question.options.map((option) => ({
      id: option.value,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      value: option.value
    }))
  }))
}

function decisionActions(interaction: PublicInteraction) {
  if (interaction.kind === 'question') return []
  return interaction.actions
    .filter((action) =>
      action.intent === 'allow' || action.intent === 'deny' || action.intent === 'cancel'
    )
    .map(({ id, label, intent }) => ({ id, label, intent }))
}

function codexOverviewStatus(
  turn: CodexTurn | undefined
): CodexOverviewStatus {
  if (turn?.interactions.some(
    (interaction) => interaction.status === 'pending' && interaction.blocksTurn
  )) {
    return 'attention'
  }
  if (!turn) return 'idle'
  if (turn.status === 'running' || turn.status === 'waiting-input') return 'running'
  if (turn.status === 'failed') return 'failed'
  if (turn.status === 'interrupted') return 'cancelled'
  if (turn.status === 'completed') return 'completed'
  return 'idle'
}

function codexOverviewStatusLabel(
  status: CodexOverviewStatus,
  turn: CodexTurn | undefined
): string {
  if (status === 'attention') return '需处理'
  if (status === 'running') return turn?.statusLabel || '运行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  return '空闲'
}

function activeTurn(turn: CodexTurn): boolean {
  return turn.status === 'running' || turn.status === 'waiting-input'
}

/** Retain the beginning of the latest message with its original inner whitespace. */
export function codexTurnsExcerpt(turns: readonly CodexTurn[]): string {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const excerpt = headExcerpt(turns[index]!.answer, 600)
    if (excerpt) return excerpt
  }
  return ''
}

function headExcerpt(content: string, limit: number, tail = false): string | undefined {
  const characters = Array.from(content.trim())
  if (!characters.length) return undefined
  if (tail && characters.length > limit) return `…${characters.slice(-limit).join('')}`
  const excerpt = characters.slice(0, limit).join('')
  return characters.length > limit ? `${excerpt}…` : excerpt
}

function threadCardCwdName(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return ''
  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, '')
  if (!withoutTrailingSeparators) return trimmed
  if (/^[A-Za-z]:$/.test(withoutTrailingSeparators) && /^[A-Za-z]:[\\/]+$/.test(trimmed)) {
    return trimmed
  }
  return withoutTrailingSeparators.split(/[\\/]/).filter(Boolean).at(-1) || trimmed
}

interface CodexIdentityActivityCandidate {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: ThreadCardActivityStatus
}

/** Historical Codex-local latest-tool projection, including its exclusion rules. */
function threadCardIdentityProjection(
  activities: readonly CodexIdentityActivityCandidate[],
  usage: ThreadCardIdentityUsage | undefined,
  options: { readonly excludedNames?: ReadonlySet<string> } = {}
): ThreadCardIdentityProjection {
  const excludedNames = new Set(
    Array.from(options.excludedNames ?? []).map(normalizedToolName)
  )
  const recentTools: ThreadCardIdentityTool[] = []
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!
    const label = singleLine(activity.label)
    if (!label || excludedNames.has(normalizedToolName(label))) continue
    recentTools.unshift(safeTool(activity.kind, label, activity.status))
    if (recentTools.length === 3) break
  }
  return {
    ...(recentTools.length ? { recentTools, latestTool: recentTools.at(-1) } : {}),
    ...(usage && Object.values(usage).some((value) => value !== undefined) ? { usage } : {})
  }
}

/** Codex input tokens include cache reads; this is its historical usage arithmetic. */
function codexCardUsage(usage: {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly contextWindow?: number
} | undefined): ThreadCardIdentityUsage | undefined {
  if (!usage) return undefined
  const parts: ThreadCardIdentityUsage['parts'][number][] = []
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    parts.push({
      id: 'total',
      suffix: 'tokens', description: '输入与输出 token 合计，按 Harness 当前上报的统计范围显示',
      value: formatTokens(total),
      numericValue: total
    })
  }
  return parts.length ? { parts } : undefined
}

export function codexExecutionTokenUsage(thread: DeepReadonly<HarnessThreadRecord>, executionId: string):
  { readonly value: string; readonly count: number; readonly suffix: string } | undefined {
  const state = thread.sessionState === null
    ? createEmptyCodexState(thread.createdAt)
    : decodeCodexState(thread.sessionState)
  const part = codexCardUsage(state.turns.findLast(turn => turn.executionId === executionId)?.usage)
    ?.parts.find(item => item.id === 'total')
  return part?.numericValue === undefined ? undefined : { value: part.value, count: part.numericValue, suffix: part.suffix ?? '' }
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  const [scale, suffix] = value >= 1_000_000_000 ? [1_000_000_000, 'B'] as const
    : value >= 1_000_000 ? [1_000_000, 'M'] as const
      : [1_000, 'K'] as const
  return `${(value / scale).toFixed(1)}${suffix}`
}

function safeTool(
  sourceKind: string,
  label: string,
  status: ThreadCardActivityStatus
): ThreadCardIdentityTool {
  const kind: ThreadCardIdentityToolKind =
    sourceKind === 'command' || sourceKind === 'file' || sourceKind === 'search'
      ? sourceKind
      : 'tool'
  if (kind === 'command' && looksLikeCommand(label)) {
    return { kind, name: 'Shell', summary: bounded(label), status }
  }
  if (kind === 'file' && looksLikeResource(label)) {
    return { kind, name: 'File', summary: bounded(label), status }
  }
  return { kind, name: bounded(label, 48), status }
}

function looksLikeCommand(value: string): boolean {
  return value.startsWith('/') || value.includes(' -') || value.includes(' ') || value.includes('|')
}

function looksLikeResource(value: string): boolean {
  return value.includes('/') || value.includes('\\')
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function bounded(value: string, limit = 120): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`
}

function normalizedToolName(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
}
