import type { PublicInteraction } from '@openagent/contracts'
import type {
  ThreadCardActivityStatus,
  ThreadCardDerivedRow,
  ThreadCardExtensionProjection,
  ThreadCardIdentityProjection,
  ThreadCardIdentityTool,
  ThreadCardIdentityUsage,
  ThreadCardIntervention,
  ThreadCardProjection
} from '@openagent/plugin-kit/renderer'
import type {
  ClaudeBackgroundTask,
  ClaudeInteraction,
  ClaudeTurn,
  ClaudeUsage
} from '../shared/state.js'

/** Claude owns the native facts; the existing card composer owns their geometry. */
export function claudeCardProjection(
  turn: ClaudeTurn | undefined,
  backgroundTasks: readonly ClaudeBackgroundTask[],
  pending: ClaudeInteraction | undefined,
  publicInteraction: PublicInteraction | undefined
): ThreadCardProjection {
  const activities = turn?.status === 'running' ? turn.activities : []
  const identity = claudeCardIdentity(turn)
  const workflow = activities.find(({ kind, label }) => kind === 'agent' && label === 'Workflow')
  const agents = activities.filter((activity) => activity !== workflow &&
    (activity.kind === 'agent' || activity.kind === 'subagent' || activity.kind === 'task'))
  if (!pending && workflow &&
    (workflow.status === 'running' || agents.some(({ status }) => status === 'running'))) {
    const phases = workflowPhases(workflow.detail)
    return {
      kind: 'dynamic-workflow',
      identity,
      workflow: {
        phases: phases.phases,
        phaseCount: phases.total,
        agents: agents.map(({ id, label, status }) => ({ id, label, status }))
      }
    }
  }
  const extensions: ThreadCardExtensionProjection[] = []
  if (turn?.status === 'running' && turn.plan.some(({ status }) => status !== 'completed')) {
    extensions.push({ kind: 'todo', steps: turn.plan })
  }
  if (pending) extensions.push({
    kind: 'intervention',
    intervention: claudeCardIntervention(pending, publicInteraction)
  })
  const rows = new Map<string, ThreadCardDerivedRow>()
  for (const activity of activities) {
    if (activity.status === 'running' &&
      (activity.kind === 'agent' || activity.kind === 'subagent')) {
      rows.set(activity.id, {
        id: activity.id, label: activity.label, status: activity.status, kind: 'agent', commandLine: false
      })
    }
  }
  for (const task of backgroundTasks) {
    rows.set(task.id, {
      id: task.id,
      label: task.description,
      status: runtimeTaskStatus(task.status),
      kind: task.type === 'local_bash' ? 'shell' :
        ['local_agent', 'remote_agent', 'in_process_teammate'].includes(task.type ?? '') ? 'agent' : 'task',
      commandLine: false
    })
  }
  const tasks = activities.filter(({ kind }) => kind === 'task')
  if (tasks.some(({ status }) => status === 'running')) {
    for (const { id, label, status } of tasks) {
      rows.set(id, { id, label, status, kind: 'agent', commandLine: false })
    }
  }
  if (rows.size) extensions.push({ kind: 'derived', rows: [...rows.values()] })
  return { kind: 'standard', identity, extensions }
}

function claudeCardIntervention(
  pending: ClaudeInteraction,
  interaction: PublicInteraction | undefined
): ThreadCardIntervention {
  const question = pending.kind === 'question' && interaction &&
    interaction.questions.length > 0 &&
    interaction.questions.every(({ secret }) => !secret)
  const submit = question ? interaction.actions.find(({ intent }) => intent === 'submit') : undefined
  const detail = permissionResourceSummary(pending) ?? pending.description
  return {
    id: interaction?.id ?? pending.id,
    title: pending.title,
    ...(detail ? { detail } : {}),
    actions: (interaction?.actions ?? []).filter(({ intent }) => pending.kind === 'permission'
      ? intent === 'allow' || intent === 'deny' || intent === 'cancel'
      : Boolean(submit) && (intent === 'submit' || intent === 'cancel')),
    ...(question && submit ? {
      submitActionId: submit.id,
      questions: interaction.questions.map((item) => ({
        ...item,
        options: item.options.map(({ value, ...option }) => ({ ...option, id: value, value }))
      }))
    } : {})
  }
}

function permissionResourceSummary(pending: ClaudeInteraction): string | undefined {
  const input = pending.input
  if (pending.kind !== 'permission' || !input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined
  }
  // Preserve the baseline approval context without exposing unrelated native arguments.
  const keys = ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern', 'query', 'prompt']
  const parts = keys.flatMap((key) => {
    const value = input[key]
    if (typeof value !== 'string') return []
    const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').trim()
    return text ? [bounded(text, 1_000)] : []
  })
  return parts.length ? bounded(parts.join(' · '), 2_000) : undefined
}

function claudeCardIdentity(turn: ClaudeTurn | undefined): ThreadCardIdentityProjection {
  const excluded = new Set(['todowrite', 'taskcreate', 'taskupdate', 'update_plan'])
  for (const interaction of turn?.interactions ?? []) {
    if (interaction.status !== 'pending') continue
    excluded.add((interaction.toolName ?? '').toLowerCase())
    excluded.add(interaction.title.toLowerCase())
  }
  const activities = (turn?.activities ?? []).filter(({ kind, label }) =>
    ['command', 'file', 'search', 'tool'].includes(kind) && label.trim() &&
    !excluded.has(label.trim().toLowerCase())).slice(-3)
  const usage = claudeCardUsage(turn?.usage)
  const recentTools: ThreadCardIdentityTool[] = activities.map((latest) => {
    const label = latest.label.replace(/\s+/g, ' ').trim()
    const kind = latest.kind === 'command' || latest.kind === 'file' || latest.kind === 'search'
      ? latest.kind : 'tool'
    const subject = kind === 'command' && (label.includes(' ') || label.startsWith('/'))
      ? 'Shell' : kind === 'file' && /[\\/]/.test(label) ? 'File' : undefined
    return {
      kind,
      name: subject ?? bounded(label, 48),
      ...(subject ? { summary: bounded(label, 120) } : {}),
      status: latest.status
    }
  })
  return {
    ...(recentTools.length ? { recentTools, latestTool: recentTools.at(-1) } : {}),
    ...(usage ? { usage } : {})
  }
}

export function claudeCardUsage(usage: ClaudeUsage | undefined): ThreadCardIdentityUsage | undefined {
  if (!usage) return undefined
  const parts: ThreadCardIdentityUsage['parts'][number][] = []
  const fields = [usage.inputTokens, usage.cachedTokens, usage.cacheWriteTokens, usage.outputTokens]
  const total = usage.totalTokens ?? (fields.some((value) => value !== undefined)
    ? fields.reduce<number>((sum, value) => sum + (value ?? 0), 0) : undefined)
  if (total !== undefined) {
    parts.push({ id: 'total', suffix: 'tokens', description: '输入与输出 token 合计，按 Harness 当前上报的统计范围显示', value: tokens(total), numericValue: total })
  }
  return parts.length ? { parts } : undefined
}

function runtimeTaskStatus(status: string): ThreadCardActivityStatus {
  const value = status.trim().toLowerCase()
  if (['completed', 'complete', 'done', 'success'].includes(value)) return 'completed'
  if (value === 'failed' || value === 'error') return 'failed'
  if (['cancelled', 'canceled', 'killed'].includes(value)) return 'cancelled'
  return 'running'
}

function workflowPhases(detail: string | undefined): { phases: string[]; total: number } {
  if (!detail) return { phases: [], total: 0 }
  try {
    const value: unknown = JSON.parse(detail)
    if (!value || typeof value !== 'object' || !('phases' in value) || !Array.isArray(value.phases)) {
      return { phases: [], total: 0 }
    }
    const phases = value.phases.filter((phase): phase is string => typeof phase === 'string')
      .map((phase) => phase.trim()).filter(Boolean)
    const total = 'total' in value ? value.total : undefined
    return { phases, total: typeof total === 'number' && Number.isSafeInteger(total) && total >= phases.length
      ? total : phases.length }
  } catch {
    return { phases: [], total: 0 }
  }
}

function bounded(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value
}

function tokens(value: number): string {
  if (value < 1_000) return String(value)
  const [scale, suffix] = value >= 1_000_000_000 ? [1_000_000_000, 'B'] as const
    : value >= 1_000_000 ? [1_000_000, 'M'] as const
      : [1_000, 'K'] as const
  return `${(value / scale).toFixed(1)}${suffix}`
}
