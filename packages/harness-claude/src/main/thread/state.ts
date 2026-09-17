import { type JsonValue } from '@openagent/contracts'
import {
  emptyClaudeThreadState,
  isBoundedInteractionJson,
  parseClaudeThreadState,
  CLAUDE_STATE_LIMITS,
  type ClaudeActivity,
  type ClaudeActivityStatus,
  type ClaudeInteraction,
  type ClaudeThreadState
} from '../../shared/state.js'
import { truncate, isRecord, encodeJsonState } from './values.js'
import { nextClaudeTurnTimestamp, recordClaudeActivity } from './timeline.js'

export function boundedRuntime(
  runtime: NonNullable<ClaudeThreadState['runtime']>
): NonNullable<ClaudeThreadState['runtime']> {
  return {
    ...(runtime.model === undefined
      ? {}
      : { model: truncate(runtime.model, 512) }),
    ...(runtime.cwd === undefined
      ? {}
      : { cwd: truncate(runtime.cwd, 4_096) }),
    ...(runtime.claudeVersion === undefined
      ? {}
      : { claudeVersion: truncate(runtime.claudeVersion, 512) }),
    ...(runtime.permissionMode === undefined
      ? {}
      : { permissionMode: truncate(runtime.permissionMode, 512) }),
    ...(runtime.effort === undefined
      ? {}
      : { effort: truncate(runtime.effort, 512) }),
    ...(runtime.capabilities === undefined
      ? {}
      : {
          capabilities: runtime.capabilities
            .slice(0, CLAUDE_STATE_LIMITS.runtimeCapabilities)
            .map((value) => truncate(value, 2_000))
            .filter(Boolean)
        }),
    ...(runtime.models === undefined
      ? {}
      : {
          models: runtime.models
            .slice(0, CLAUDE_STATE_LIMITS.runtimeModels)
            .map((model) => ({
              value: truncate(model.value, 512) || 'model',
              displayName: truncate(model.displayName, 1_000) || 'Model',
              ...(model.description === undefined
                ? {}
                : { description: truncate(model.description, 8_000) }),
              ...(model.resolvedModel === undefined
                ? {}
                : { resolvedModel: truncate(model.resolvedModel, 512) })
            }))
        }),
    ...(runtime.agents === undefined
      ? {}
      : {
          agents: runtime.agents
            .slice(0, CLAUDE_STATE_LIMITS.runtimeAgents)
            .map((agent) => ({
              name: truncate(agent.name, 1_000) || 'agent',
              description: truncate(agent.description, 8_000),
              ...(agent.model === undefined
                ? {}
                : { model: truncate(agent.model, 512) })
            }))
        }),
    ...(runtime.commands === undefined
      ? {}
      : {
          commands: runtime.commands
            .slice(0, CLAUDE_STATE_LIMITS.runtimeCommands)
            .map((command) => ({
              name: truncate(command.name, 1_000) || 'command',
              ...(command.description === undefined
                ? {}
                : { description: truncate(command.description, 8_000) }),
              ...(command.argumentHint === undefined
                ? {}
                : { argumentHint: truncate(command.argumentHint, 2_000) })
            }))
        }),
    ...(runtime.skills === undefined
      ? {}
      : {
          skills: runtime.skills
            .slice(0, CLAUDE_STATE_LIMITS.runtimeSkills)
            .map((value) => truncate(value, 2_000))
            .filter(Boolean)
        }),
    ...(runtime.plugins === undefined
      ? {}
      : {
          plugins: runtime.plugins
            .slice(0, CLAUDE_STATE_LIMITS.runtimePlugins)
            .map((plugin) => ({
              name: truncate(plugin.name, 1_000) || 'plugin',
              ...(plugin.path === undefined
                ? {}
                : { path: truncate(plugin.path, 4_096) }),
              ...(plugin.version === undefined
                ? {}
                : { version: truncate(plugin.version, 256) })
            }))
        }),
    ...(runtime.mcpServers === undefined
      ? {}
      : {
          mcpServers: runtime.mcpServers
            .slice(0, CLAUDE_STATE_LIMITS.runtimeMcpServers)
            .map((server) => ({
              name: truncate(server.name, 1_000) || 'MCP',
              status: truncate(server.status, 256) || 'unknown',
              ...(server.serverInfo === undefined
                ? {}
                : { serverInfo: truncate(server.serverInfo, 8_000) })
            }))
        }),
    ...(runtime.backgroundTasks === undefined
      ? {}
      : {
          backgroundTasks: runtime.backgroundTasks
            .slice(0, CLAUDE_STATE_LIMITS.backgroundTasks)
            .map((task) => ({
              id: truncate(task.id, 512) || 'task',
              ...(task.type ? { type: truncate(task.type, 256) } : {}),
              description: truncate(task.description, 8_000) || '后台任务',
              status: truncate(task.status, 256) || 'running'
            }))
        }),
    ...(runtime.remoteControl === undefined
      ? {}
      : {
          remoteControl: {
            enabled: runtime.remoteControl.enabled,
            ...(runtime.remoteControl.sessionUrl === undefined
              ? {}
              : { sessionUrl: truncate(runtime.remoteControl.sessionUrl, 8_192) }),
            ...(runtime.remoteControl.connectUrl === undefined
              ? {}
              : { connectUrl: truncate(runtime.remoteControl.connectUrl, 8_192) }),
            ...(runtime.remoteControl.environmentId === undefined
              ? {}
              : {
                  environmentId: truncate(
                    runtime.remoteControl.environmentId,
                    8_192
                  )
                })
          }
        })
  }
}

export function boundedActivity(activity: ClaudeActivity): ClaudeActivity {
  const workflowDetail = isWorkflowActivity(activity)
    ? workflowPhaseDetail(activity.detail)
    : undefined
  return {
    id: truncate(activity.id, 512),
    kind: activity.kind,
    label: truncate(activity.label, 1_000),
    status: activity.status,
    ...(activity.toolName
      ? { toolName: truncate(activity.toolName, CLAUDE_STATE_LIMITS.activityToolNameCharacters) }
      : {}),
    ...(workflowDetail ? { detail: workflowDetail } : {}),
    ...(activity.parentId === undefined
      ? {}
      : { parentId: truncate(activity.parentId, 512) }),
    ...(activity.taskId === undefined
      ? {}
      : { taskId: truncate(activity.taskId, 512) })
  }
}

export function boundedInteraction(interaction: ClaudeInteraction): ClaudeInteraction {
  const input =
    interaction.input !== undefined && isBoundedInteractionJson(interaction.input)
      ? structuredClone(interaction.input)
      : undefined
  const schema =
    interaction.schema !== undefined && isBoundedInteractionJson(interaction.schema)
      ? structuredClone(interaction.schema)
      : undefined
  return {
    id: truncate(interaction.id, 512),
    kind: interaction.kind,
    title: truncate(interaction.title, 2_000),
    ...(interaction.description === undefined
      ? {}
      : { description: truncate(interaction.description, 20_000) }),
    ...(interaction.toolName === undefined
      ? {}
      : { toolName: truncate(interaction.toolName, 512) }),
    ...(interaction.canRemember === undefined
      ? {}
      : { canRemember: interaction.canRemember }),
    ...(input === undefined ? {} : { input }),
    ...(schema === undefined ? {} : { schema }),
    ...(interaction.elicitationMode === undefined
      ? {}
      : { elicitationMode: interaction.elicitationMode }),
    ...(interaction.url === undefined
      ? {}
      : { url: truncate(interaction.url, 8_192) }),
    ...(interaction.elicitationId === undefined
      ? {}
      : { elicitationId: truncate(interaction.elicitationId, 512) }),
    ...(interaction.serverName === undefined
      ? {}
      : { serverName: truncate(interaction.serverName, 2_000) }),
    status: interaction.status,
    ...(interaction.questions === undefined
      ? {}
      : {
          questions: interaction.questions.slice(0, 32).map((question) => ({
            question: truncate(question.question, 10_000),
            ...(question.header === undefined
              ? {}
              : { header: truncate(question.header, 1_000) }),
            multiSelect: question.multiSelect,
            options: question.options.slice(0, 32).map((option) => ({
              label: truncate(option.label, 2_000),
              ...(option.description === undefined
                ? {}
                : { description: truncate(option.description, 10_000) })
            }))
          }))
        })
  }
}

export function nativeTaskActivityStatus(
  status: string | undefined
): ClaudeActivityStatus | undefined {
  const value = status?.trim().toLowerCase()
  if (!value) return undefined
  if (['completed', 'complete', 'done', 'success'].includes(value)) return 'completed'
  if (['failed', 'error'].includes(value)) return 'failed'
  if (['cancelled', 'canceled', 'killed'].includes(value)) return 'cancelled'
  return ['running', 'in_progress', 'in-progress', 'inprogress'].includes(value)
    ? 'running'
    : undefined
}

export function isWorkflowActivity(
  activity: Pick<ClaudeActivity, 'kind' | 'label'>
): boolean {
  return activity.kind === 'agent' && activity.label === 'Workflow'
}

/** Keep only bounded Dynamic Workflow phase titles; scripts and other input stay native. */
export function workflowPhaseDetail(value: unknown): string | undefined {
  const raw = safeText(value, CLAUDE_STATE_LIMITS.activityDetailCharacters)
  if (!raw) return undefined
  let script = raw
  try {
    const input: unknown = JSON.parse(raw)
    if (!isRecord(input)) return undefined
    if (Array.isArray(input.phases)) {
      return serializeWorkflowPhases(input.phases, input.total)
    }
    if (typeof input.script !== 'string') return undefined
    script = input.script
  } catch {
    script = raw.replaceAll('\\"', '"')
  }
  const start = script.search(/\bphases\s*:/)
  if (start < 0) return undefined
  const end = script.indexOf(']', start)
  if (end < 0) return undefined
  const titles = [...script.slice(start, end).matchAll(/\btitle\s*:\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
  return serializeWorkflowPhases(titles)
}

function serializeWorkflowPhases(
  values: unknown[],
  projectedTotal?: unknown
): string | undefined {
  const phases: string[] = []
  for (const value of values) {
    const candidate = isRecord(value) ? value.title : value
    const title = safeText(candidate, 200)
    if (title) phases.push(title)
  }
  if (!phases.length) return undefined
  const visible = phases.slice(0, 6)
  const total = Number.isSafeInteger(projectedTotal) &&
      Number(projectedTotal) >= phases.length &&
      Number(projectedTotal) <= 10_000
    ? Number(projectedTotal)
    : phases.length
  return JSON.stringify({ phases: visible, ...(total > visible.length ? { total } : {}) })
}

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .trim()
  return normalized ? truncate(normalized, max) : undefined
}

export function encodeClaudeThreadState(state: ClaudeThreadState): JsonValue {
  return encodeJsonState(
    parseClaudeThreadState(state),
    'Claude sessionState'
  )
}

export function decodeClaudeMainState(value: unknown): ClaudeThreadState {
  // `null` is the one current-format Core handshake for a fresh Thread. It is
  // handled at the Plugin boundary and is never accepted by the private-state
  // parser itself.
  return value === null ? emptyClaudeThreadState() : parseClaudeThreadState(value)
}

export function failStaleClaudeBackgroundWork(state: ClaudeThreadState): boolean {
  let changed = false
  for (const task of state.runtime?.backgroundTasks || []) {
    if (nativeTaskActivityStatus(task.status) !== 'running') continue
    task.status = 'failed'
    changed = true
  }
  for (const turn of state.turns) {
    for (const activity of turn.activities) {
      if (activity.status !== 'running') continue
      recordClaudeActivity(
        turn,
        { ...activity, status: 'failed' },
        nextClaudeTurnTimestamp(turn)
      )
      changed = true
    }
  }
  return changed
}
