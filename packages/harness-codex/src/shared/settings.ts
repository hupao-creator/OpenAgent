import type { DeepReadonly } from '@openagent/contracts'
import type {
  CodexThreadSettings,
  CodexThreadSettingsRequest
} from './types.js'
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_APPROVALS_REVIEWERS,
  CODEX_PERMISSION_MODES,
  CODEX_PERSONALITIES,
  CODEX_REASONING_SUMMARIES,
  CODEX_SANDBOXES
} from './types.js'

export function normalizeCodexThreadSettings(
  value: CodexThreadSettings,
  label = 'settings'
): CodexThreadSettings {
  assertRecord(value, label)
  assertOnlyKeys(value, [
    'executablePath',
    'model',
    'effort',
    'serviceTier',
    'personality',
    'approvalPolicy',
    'approvalsReviewer',
    'sandbox',
    'sandboxPolicy',
    'summary',
    'permissionMode'
  ], label)
  const executablePath = optionalIdentifier(
    value.executablePath,
    `${label}.executablePath`,
    4_096
  )
  const model = optionalIdentifier(value.model, `${label}.model`, 256)
  const effort = optionalIdentifier(value.effort, `${label}.effort`, 64)
  const serviceTier = optionalIdentifier(
    value.serviceTier,
    `${label}.serviceTier`,
    128
  )
  const personality = optionalEnum(
    value.personality,
    CODEX_PERSONALITIES,
    `${label}.personality`
  )
  const approvalPolicy = optionalEnum(
    value.approvalPolicy,
    CODEX_APPROVAL_POLICIES,
    `${label}.approvalPolicy`
  )
  const approvalsReviewer = optionalEnum(value.approvalsReviewer, CODEX_APPROVALS_REVIEWERS, `${label}.approvalsReviewer`)
  const sandbox = optionalEnum(value.sandbox, CODEX_SANDBOXES, `${label}.sandbox`)
  const summary = optionalEnum(
    value.summary,
    CODEX_REASONING_SUMMARIES,
    `${label}.summary`
  )
  const permissionMode = optionalEnum(
    value.permissionMode,
    CODEX_PERMISSION_MODES,
    `${label}.permissionMode`
  )
  const sandboxPolicy = normalizeCodexSandboxPolicy(
    value.sandboxPolicy,
    `${label}.sandboxPolicy`
  )
  if (sandbox && sandboxPolicy) {
    throw new Error(`Codex ${label}.sandbox 与 sandboxPolicy 不能同时设置`)
  }
  return {
    ...(executablePath ? { executablePath } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(personality ? { personality } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
    ...(summary ? { summary } : {}),
    ...(permissionMode ? { permissionMode } : {})
  }
}

/** Explicit native permission fields; when none are set, the Thread preset default applies. */
export function codexHasNativePermissionConfig(
  value: DeepReadonly<Pick<CodexThreadSettings,
    'approvalPolicy' | 'approvalsReviewer' | 'sandbox' | 'sandboxPolicy'>>
): boolean {
  return value.approvalPolicy !== undefined || value.approvalsReviewer !== undefined ||
    value.sandbox !== undefined || value.sandboxPolicy !== undefined
}

export function normalizeCodexThreadSettingsRequest(
  value: CodexThreadSettingsRequest,
  label = 'request'
): CodexThreadSettingsRequest {
  assertRecord(value, label)
  assertOnlyKeys(value, ['model', 'effort', 'serviceTier', 'permissionMode'], label)
  const model = optionalIdentifier(value.model, `${label}.model`, 256)
  const effort = optionalIdentifier(value.effort, `${label}.effort`, 64)
  const serviceTier = optionalIdentifier(value.serviceTier, `${label}.serviceTier`, 128)
  const permissionMode = optionalEnum(value.permissionMode, CODEX_PERMISSION_MODES, `${label}.permissionMode`)
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(permissionMode ? { permissionMode } : {})
  }
}

export function normalizeCodexSandboxPolicy(
  value: CodexThreadSettings['sandboxPolicy'],
  label: string
): CodexThreadSettings['sandboxPolicy'] {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Codex ${label} 必须是对象`)
  }
  if (value.type === 'dangerFullAccess') {
    assertOnlyKeys(value, ['type'], label)
    return { type: 'dangerFullAccess' }
  }
  if (value.type === 'readOnly') {
    assertOnlyKeys(value, ['type', 'networkAccess'], label)
    assertBoolean(value.networkAccess, `${label}.networkAccess`)
    return { type: 'readOnly', networkAccess: value.networkAccess }
  }
  if (value.type === 'externalSandbox') {
    assertOnlyKeys(value, ['type', 'networkAccess'], label)
    if (value.networkAccess !== 'restricted' && value.networkAccess !== 'enabled') {
      throw new Error(`Codex ${label}.networkAccess 无效`)
    }
    return { type: 'externalSandbox', networkAccess: value.networkAccess }
  }
  if (value.type !== 'workspaceWrite') {
    throw new Error(`Codex ${label}.type 无效`)
  }
  assertOnlyKeys(value, [
    'type',
    'writableRoots',
    'networkAccess',
    'excludeTmpdirEnvVar',
    'excludeSlashTmp'
  ], label)
  if (!Array.isArray(value.writableRoots) || value.writableRoots.length > 64) {
    throw new Error(`Codex ${label}.writableRoots 无效`)
  }
  const writableRoots = value.writableRoots.map((root) => {
    const normalized = requiredIdentifier(root, `${label}.writableRoots`, 4_096)
    if (!isPortableAbsolute(normalized)) {
      throw new Error(`Codex ${label}.writableRoots 必须是绝对路径`)
    }
    return normalized
  })
  assertBoolean(value.networkAccess, `${label}.networkAccess`)
  assertBoolean(value.excludeTmpdirEnvVar, `${label}.excludeTmpdirEnvVar`)
  assertBoolean(value.excludeSlashTmp, `${label}.excludeSlashTmp`)
  return {
    type: 'workspaceWrite',
    writableRoots: [...new Set(writableRoots)],
    networkAccess: value.networkAccess,
    excludeTmpdirEnvVar: value.excludeTmpdirEnvVar,
    excludeSlashTmp: value.excludeSlashTmp
  }
}

function assertOnlyKeys(
  value: object,
  allowedKeys: readonly string[],
  label: string
): void {
  const allowed = new Set(allowedKeys)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) {
    throw new Error(`Codex ${label} 包含未知字段：${unknown.join(', ')}`)
  }
}

function assertRecord(value: unknown, label: string): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Codex ${label} 必须是对象`)
  }
}

function optionalIdentifier(
  value: unknown,
  label: string,
  maxLength: number
): string | undefined {
  return value === undefined
    ? undefined
    : requiredIdentifier(value, label, maxLength)
}

function requiredIdentifier(
  value: unknown,
  label: string,
  maxLength: number
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > maxLength ||
    value.includes('\0')
  ) {
    throw new Error(`Codex ${label} 必须是 1-${maxLength} 字符的规范字符串`)
  }
  return value
}

function optionalEnum<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  label: string
): Values[number] | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`Codex ${label} 必须是：${allowed.join('、')}`)
  }
  return value
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Codex ${label} 必须是 boolean`)
  }
}

function isPortableAbsolute(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}
