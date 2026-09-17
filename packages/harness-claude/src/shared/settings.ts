import type { DeepReadonly, JsonObject } from '@openagent/contracts'

export const CLAUDE_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const

export const CLAUDE_PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan'
] as const

export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'auto'

export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number]
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number]

export interface ClaudeThreadSettings {
  /** Resolved when the record is created so a Handle has no hidden app-settings channel. */
  executablePath: string
  model?: string
  effort?: ClaudeEffortLevel
  goalMode?: boolean
  permissionMode?: ClaudePermissionMode
  allowedTools?: string[]
  disallowedTools?: string[]
}

export interface ClaudeThreadSettingsRequest {
  executablePath?: string
  model?: string
  effort?: ClaudeEffortLevel
  goalMode?: boolean
  permissionMode?: ClaudePermissionMode
  allowedTools?: string[]
  disallowedTools?: string[]
}

export interface ClaudeThreadSettingsUpdate {
  model?: string | null
  effort?: ClaudeEffortLevel | null
  permissionMode?: ClaudePermissionMode | null
  allowedTools?: string[] | null
  disallowedTools?: string[] | null
}

export interface ClaudeHarnessSettings {
  /** False while the settings page shows these Thread defaults for editing. */
  useDefaultThreadSettings?: boolean
  threadSettings: ClaudeThreadSettingsRequest
}

export interface ClaudePromptSettings {
  executablePath?: string
  model?: string
  effort?: ClaudeEffortLevel
}

export interface ClaudeModelPresentation {
  value: string
  displayName: string
  description?: string
  supportedEfforts: ClaudeEffortLevel[]
}

export interface ClaudeSettingsPresentationData {
  cli:
    | { status: 'available'; executablePath: string; version?: string }
    | { status: 'unavailable'; executablePath: string; message: string }
  models: ClaudeModelPresentation[]
}

export const DEFAULT_CLAUDE_HARNESS_SETTINGS: ClaudeHarnessSettings = {
  threadSettings: {}
}

export function normalizeClaudeHarnessSettings(
  value: DeepReadonly<ClaudeHarnessSettings>
): ClaudeHarnessSettings {
  assertRecord(value, 'Claude harness settings')
  assertOnlyKeys(
    value,
    ['useDefaultThreadSettings', 'threadSettings'],
    'Claude harness settings'
  )
  const missing = ['threadSettings'].filter(
    (key) => !Object.hasOwn(value, key)
  )
  if (missing.length) {
    throw new Error(`Claude harness settings 缺少字段：${missing.join(', ')}`)
  }
  const useDefaultThreadSettings = normalizeOptionalBoolean(
    value.useDefaultThreadSettings,
    'useDefaultThreadSettings'
  )
  const threadSettings = normalizeClaudeHarnessThreadSettings(value.threadSettings)
  // A Harness on its Agent defaults owns no Thread default values, so any
  // persisted custom settings are canonicalized away until the page opts out.
  // Only an explicit opt-out keeps the customized values.
  if (useDefaultThreadSettings === false) {
    return { useDefaultThreadSettings: false, threadSettings }
  }
  return { threadSettings: {} }
}

/**
 * Harness-level defaults are user-facing knobs only: the executable is
 * host-owned, so a settings payload can never pin the binary (A1).
 */
function normalizeClaudeHarnessThreadSettings(
  value: DeepReadonly<ClaudeThreadSettingsRequest>
): ClaudeThreadSettingsRequest {
  assertRecord(value, 'Claude harness settings threadSettings')
  assertOnlyKeys(
    value,
    ['model', 'effort', 'goalMode', 'permissionMode', 'allowedTools', 'disallowedTools'],
    'Claude harness settings threadSettings'
  )
  return normalizeClaudeThreadRequest(value)
}

/** Source Thread settings take precedence over the generic configured defaults. */
export function claudePromptSettings(
  settings: DeepReadonly<ClaudeHarnessSettings>,
  sourceThreadSettings?: DeepReadonly<ClaudeThreadSettings>
): ClaudePromptSettings {
  const normalized = normalizeClaudeHarnessSettings(settings)
  const profile: DeepReadonly<ClaudeThreadSettingsRequest> = sourceThreadSettings ?? normalized.threadSettings
  const executablePath = sourceThreadSettings
    ? sourceThreadSettings.executablePath
    : defaultClaudeThreadSettings(normalized).executablePath
  return {
    ...(executablePath ? { executablePath } : {}),
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effort: profile.effort } : {})
  }
}

export function defaultClaudeThreadSettings(
  settings: DeepReadonly<ClaudeHarnessSettings>
): ClaudeThreadSettings {
  const normalized = normalizeClaudeHarnessSettings(settings)
  // `threadSettings` never carries `executablePath` (host-owned discovery), so
  // the literal `claude` command survives the custom-defaults spread.
  return {
    executablePath: 'claude',
    permissionMode: CLAUDE_DEFAULT_PERMISSION_MODE,
    ...normalized.threadSettings
  }
}

export function normalizeClaudeThreadSettings(
  value: DeepReadonly<ClaudeThreadSettings>
): ClaudeThreadSettings {
  assertRecord(value, 'Claude thread settings')
  assertOnlyKeys(
    value,
    [
      'executablePath',
      'model',
      'effort',
      'goalMode',
      'permissionMode',
      'allowedTools',
      'disallowedTools'
    ],
    'Claude thread settings'
  )
  return {
    executablePath: normalizeIdentifier(value.executablePath, 'executablePath'),
    ...normalizeClaudeThreadRequest({
      model: value.model,
      effort: value.effort,
      goalMode: value.goalMode,
      permissionMode: value.permissionMode,
      allowedTools: value.allowedTools,
      disallowedTools: value.disallowedTools
    })
  }
}

export function normalizeClaudeThreadRequest(
  value: DeepReadonly<ClaudeThreadSettingsRequest>
): ClaudeThreadSettingsRequest {
  assertRecord(value, 'Claude thread settings request')
  assertOnlyKeys(
    value,
    ['executablePath', 'model', 'effort', 'goalMode', 'permissionMode', 'allowedTools', 'disallowedTools'],
    'Claude thread settings request'
  )
  const executablePath = normalizeOptionalIdentifier(value.executablePath, 'executablePath')
  const model = normalizeOptionalIdentifier(value.model, 'model')
  const effort = normalizeOptionalEnum(value.effort, CLAUDE_EFFORT_LEVELS, 'effort')
  const permissionMode = normalizeOptionalEnum(
    value.permissionMode,
    CLAUDE_PERMISSION_MODES,
    'permissionMode'
  )
  if (value.goalMode !== undefined && typeof value.goalMode !== 'boolean') {
    throw new Error('Claude goalMode 必须是 boolean')
  }
  return {
    ...(executablePath === undefined ? {} : { executablePath }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(value.goalMode === undefined ? {} : { goalMode: value.goalMode }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(value.allowedTools === undefined
      ? {}
      : { allowedTools: normalizeToolNames(value.allowedTools, 'allowedTools') }),
    ...(value.disallowedTools === undefined
      ? {}
      : { disallowedTools: normalizeToolNames(value.disallowedTools, 'disallowedTools') })
  }
}

/** Creation overrides are narrower than the internal default/native profile. */
export function validateClaudeThreadCreationOptions(
  value: DeepReadonly<ClaudeThreadSettingsRequest>
): void {
  assertRecord(value, 'Claude thread creation options')
  assertOnlyKeys(value, ['model', 'effort', 'permissionMode'], 'Claude thread creation options')
  normalizeClaudeThreadRequest(value)
}

/** Native examples describe this environment; resolution validates the actual target. */
export function claudeThreadSettingsSchema(
  presentation: DeepReadonly<ClaudeSettingsPresentationData>
): JsonObject {
  const models = presentation.cli.status === 'available' ? presentation.models : []
  const efforts = [...new Set(models.flatMap(model => model.supportedEfforts))]
  const identifier = {
    type: 'string', minLength: 1, maxLength: 512,
    pattern: '^[^\\s\\u0000](?:[^\\u0000]*[^\\s\\u0000])?$'
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      model: {
        ...identifier,
        examples: models.map(model => model.value),
        description: [
          'Examples reflect only the current description environment.',
          'The target Thread executable and working directory determine supported models, validated when settings resolve.',
          'Omit to inherit the configured default.'
        ].join(' ')
      },
      effort: {
        type: 'string', enum: [...CLAUDE_EFFORT_LEVELS],
        examples: efforts,
        description: [
          'Examples reflect only the current description environment.',
          'The actual target executable, working directory and effective model determine supported efforts, validated when settings resolve.',
          'Model changes clear inherited effort unless supplied.'
        ].join(' ')
      },
      permissionMode: {
        type: 'string', enum: [...CLAUDE_PERMISSION_MODES],
        description: 'Claude Code native permission mode.'
      }
    }
  }
}

export function applyClaudeThreadSettingsUpdate(input: {
  current: DeepReadonly<ClaudeThreadSettings>
  defaults: DeepReadonly<ClaudeThreadSettings>
  update: DeepReadonly<ClaudeThreadSettingsUpdate>
  hasContent: boolean
}): ClaudeThreadSettings {
  assertRecord(input.update, 'Claude thread settings update')
  assertOnlyKeys(
    input.update,
    ['model', 'effort', 'permissionMode', 'allowedTools', 'disallowedTools'],
    'Claude thread settings update'
  )
  const next: ClaudeThreadSettings = normalizeClaudeThreadSettings(input.current)
  const defaults = normalizeClaudeThreadSettings(input.defaults)
  applyNullable(next, defaults, 'model', input.update.model)
  applyNullable(next, defaults, 'effort', input.update.effort)
  applyNullable(next, defaults, 'permissionMode', input.update.permissionMode)
  applyNullableArray(next, defaults, 'allowedTools', input.update.allowedTools)
  applyNullableArray(next, defaults, 'disallowedTools', input.update.disallowedTools)
  const normalized = normalizeClaudeThreadSettings(next)
  if (
    input.hasContent &&
    (input.update.allowedTools !== undefined || input.update.disallowedTools !== undefined)
  ) {
    throw new Error('已有 Claude Primary Native Session 不能更改工具 allow/deny 列表')
  }
  return normalized
}

function applyNullable<
  Key extends 'model' | 'effort' | 'permissionMode'
>(
  target: ClaudeThreadSettings,
  defaults: ClaudeThreadSettings,
  key: Key,
  value: ClaudeThreadSettingsUpdate[Key]
): void {
  if (value === undefined) return
  if (value === null) {
    if (defaults[key] === undefined) delete target[key]
    else target[key] = defaults[key] as never
  }
  else target[key] = value as never
}

function applyNullableArray(
  target: ClaudeThreadSettings,
  defaults: ClaudeThreadSettings,
  key: 'allowedTools' | 'disallowedTools',
  value: readonly string[] | null | undefined
): void {
  if (value === undefined) return
  if (value === null) {
    if (defaults[key] === undefined) delete target[key]
    else target[key] = [...defaults[key]]
  }
  else target[key] = [...value]
}

function normalizeToolNames(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values) || values.length > 128) {
    throw new Error(`Claude ${label} 数量无效`)
  }
  const normalized = values.map((value) => normalizeIdentifier(value, label))
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Claude ${label} 不能包含重复项`)
  }
  return normalized
}

function normalizeOptionalIdentifier(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : normalizeIdentifier(value, label)
}

function normalizeIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 512 ||
    value.includes('\0')
  ) {
    throw new Error(`无效的 Claude ${label}`)
  }
  return value
}

function normalizeOptionalEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string
): Values[number] | undefined {
  if (value === undefined) return undefined
  if (!values.includes(value as string)) throw new Error(`无效的 Claude ${label}`)
  return value as Values[number]
}

function normalizeOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`Claude ${label} 必须是布尔值`)
  }
  return value
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是 object`)
  }
}

function assertOnlyKeys(
  value: object,
  allowed: readonly string[],
  label: string
): void {
  const keys = new Set(allowed)
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error(`${label} 包含未知字段`)
  }
}
