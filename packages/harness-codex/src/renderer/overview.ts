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
  // Keep the current task visible before its answer arrives; never borrow an older turn's answer.
  const prompt = turn?.messages.findLast((message) =>
    message.role === 'user' && message.internal !== true && message.content.trim())?.content
  const latestText = turn?.timeline.findLast((item) =>
    (item.kind === 'assistant' || (live && item.kind === 'reasoning')) && item.content.trim())
  const currentText = latestText && 'content' in latestText ? latestText.content : turn?.answer ?? ''
  const excerpt = headExcerpt(currentText, 600, live) ||
    headExcerpt(turn?.reasoning ?? '', 600) || headExcerpt(turn?.error ?? '', 600) ||
    headExcerpt(prompt ?? '', 600) || ''
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
    ...(turn ? {
      runtime: { startedAt: turn.createdAt, ...(live ? {} : { endedAt: turn.finishedAt }) }
    } : {}),
    ...(cwd && !isTemporaryWorkspacePath(cwd) ? { cwd, cwdName: threadCardCwdName(cwd) } : {}),
    ...(input.thread.worktree ? { usesWorktree: true } : {}),
    ...(steer ? { steer } : {}),
    excerpt
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
    inclusiveCacheIdentityUsage(turn.usage && {
      inputTokens: turn.usage.inputTokens,
      cachedTokens: turn.usage.cachedInputTokens,
      outputTokens: turn.usage.outputTokens,
      contextWindow: turn.usage.contextWindow
    }),
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

/** Normalize whitespace and retain the beginning of the latest message. */
export function codexTurnsExcerpt(turns: readonly CodexTurn[]): string {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const excerpt = headExcerpt(turns[index]!.answer, 600)
    if (excerpt) return excerpt
  }
  return ''
}

function headExcerpt(content: string, limit: number, tail = false): string | undefined {
  const characters = Array.from(content.replace(/\s+/gu, ' ').trim())
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
function inclusiveCacheIdentityUsage(usage: {
  readonly inputTokens?: number
  readonly cachedTokens?: number
  readonly outputTokens?: number
  readonly contextWindow?: number
} | undefined): ThreadCardIdentityUsage | undefined {
  if (!usage) return undefined
  const cachedReadTokens = usage.cachedTokens
  const uncachedInputTokens = usage.inputTokens === undefined
    ? undefined
    : Math.max(0, usage.inputTokens - (cachedReadTokens ?? 0))
  const parts: ThreadCardIdentityUsage['parts'][number][] = []
  if (cachedReadTokens !== undefined && uncachedInputTokens !== undefined) {
    const totalInput = cachedReadTokens + uncachedInputTokens
    const ratio = totalInput > 0 ? cachedReadTokens / totalInput : 0
    parts.push({
      id: 'cache',
      suffix: 'cached', description: '缓存读取 token 占输入 token 的比例',
      value: formatPercentOneDecimal(ratio),
      numericValue: ratio
    })
  }
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    parts.unshift({
      id: 'total',
      suffix: 'tokens', description: '输入与输出 token 合计，按 Harness 当前上报的统计范围显示',
      value: formatTokens(total),
      numericValue: total
    })
  } else if (usage.contextWindow !== undefined) {
    parts.push({ id: 'context-window', label: 'Context ', value: formatTokens(usage.contextWindow) })
  }
  return parts.length ? { parts } : undefined
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  const [scale, suffix] = value >= 1_000_000_000 ? [1_000_000_000, 'B'] as const
    : value >= 1_000_000 ? [1_000_000, 'M'] as const
      : [1_000, 'K'] as const
  const compact = value / scale
  return `${compact >= 100 ? Math.round(compact) : compact.toFixed(1).replace(/\.0$/, '')}${suffix}`
}

function formatPercentOneDecimal(ratio: number): string {
  const value = Math.max(0, Math.min(1, ratio)) * 100
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? String(Math.round(rounded)) : rounded.toFixed(1)}%`
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
