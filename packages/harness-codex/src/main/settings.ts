import type { DeepReadonly, HarnessSettingsApi } from '@openagent/contracts'
import { describeCodexThreadSettings } from './settings-schema.js'
import { decodeCodexState } from '../shared/state.js'
import {
  codexHasNativePermissionConfig,
  normalizeCodexSandboxPolicy,
  normalizeCodexThreadSettings,
  normalizeCodexThreadSettingsRequest
} from '../shared/settings.js'
import type {
  CodexHarnessSettings,
  CodexPermissionMode,
  CodexPromptSettings,
  CodexThreadSettings,
  CodexThreadSettingsRequest,
  CodexThreadSettingsUpdate
} from '../shared/types.js'
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_DEFAULT_PERMISSION_MODE,
  CODEX_PERMISSION_MODES,
  CODEX_PERSONALITIES,
  CODEX_REASONING_SUMMARIES,
  CODEX_SANDBOXES
} from '../shared/types.js'
import {
  type CodexCatalogSource,
  validateCodexModelSettings
} from './catalog.js'

type CodexSettingsApi = HarnessSettingsApi<
  CodexHarnessSettings,
  CodexThreadSettings,
  CodexThreadSettingsRequest,
  CodexThreadSettingsUpdate,
  CodexPromptSettings
>

export function createCodexSettingsApi(
  catalogSource?: CodexCatalogSource,
  defaultPermissionMode: CodexPermissionMode = CODEX_DEFAULT_PERMISSION_MODE
): CodexSettingsApi {
  return {
    normalizeHarnessSettings,

    async describe(input) {
      throwIfAborted(input.signal)
      // Only validates the payload: Harness-level settings cannot pin the
      // binary, so the host auto-detects the executable for this catalog.
      normalizeHarnessSettings(clone(input.settings))
      const catalog = catalogSource
        ? await catalogSource.load({ cwd: input.cwd, signal: input.signal })
        : { models: [] }
      throwIfAborted(input.signal)
      return describeCodexThreadSettings(catalog.models)
    },

    defaultThreadSettings(settings) {
      // Thread defaults carry no settings-page override: a Thread pins the
      // binary the host resolved at creation, and only that Thread-level path
      // survives here.
      return normalizeHarnessSettings(clone(settings)).threadSettings
    },

    async resolveThreadSettings(input) {
      throwIfAborted(input.signal)
      const rawRequested = input.requested ? clone(input.requested) : undefined
      const requested = rawRequested
        ? normalizeCodexThreadSettingsRequest(rawRequested, 'requested')
        : undefined
      const merged = normalizeCodexThreadSettings(replaceRequestedModelGroup(
        resolvePermissionMode(clone(input.merged), requested, defaultPermissionMode),
        rawRequested
      ), 'merged')
      const { permissionMode: _mode, ...modelSettings } = requested ?? {}
      const next = normalizeCodexThreadSettings({ ...merged, ...modelSettings }, 'resolved')
      assertExecutableIdentity(input.existing, next)
      await validateAgainstCatalog(catalogSource, next, input.cwd, input.signal, 'resolved settings')
      return next
    },

    hasThreadContent(sessionState) {
      if (sessionState === null) return false
      const state = decodeCodexState(sessionState)
      return state.primarySessionId !== undefined || state.turns.length > 0
    },

    async applyThreadSettingsUpdate(input) {
      throwIfAborted(input.signal)
      const current = normalizeCodexThreadSettings(clone(input.current), 'current')
      const update = normalizeUpdate(clone(input.update), 'update')
      const model = updatedSetting(
        hasOwn(update, 'model'),
        update.model,
        current.model
      )
      const modelChanged = hasOwn(update, 'model') && model !== current.model
      const effort = updatedSetting(
        hasOwn(update, 'effort'),
        update.effort,
        modelChanged ? undefined : current.effort
      )
      const serviceTier = updatedSetting(
        hasOwn(update, 'serviceTier'),
        update.serviceTier,
        modelChanged ? undefined : current.serviceTier
      )
      const personality = updatedSetting(
        hasOwn(update, 'personality'),
        update.personality,
        current.personality
      )
      const permissionGroup = updatedPermissionGroup(current, update, defaultPermissionMode)
      const summary = updatedSetting(
        hasOwn(update, 'summary'),
        update.summary,
        current.summary
      )
      const next = normalizeCodexThreadSettings({
        ...(current.executablePath ? { executablePath: current.executablePath } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(serviceTier !== undefined ? { serviceTier } : {}),
        ...(personality !== undefined ? { personality } : {}),
        ...permissionGroup,
        ...(summary !== undefined ? { summary } : {})
      }, 'updated')
      assertExecutableIdentity(current, next)
      // A permission-only update must not wait on model discovery, and a kept
      // permission group still has to hold up its reviewer.
      const modelGroupChanged = hasAnyOwn(update, ['model', 'effort', 'serviceTier'])
      if (modelGroupChanged || hasOwn(update, 'permissionMode')) {
        await validateAgainstCatalog(catalogSource, next, input.cwd, input.signal,
          'updated settings', modelGroupChanged ? 'all' : 'autoReview')
      }
      return next
    },

    promptSettings(settings, sourceThreadSettings) {
      const normalized = normalizeHarnessSettings(clone(settings))
      const profile: DeepReadonly<CodexThreadSettings> = sourceThreadSettings ?? normalized.threadSettings
      // Only a Thread's pinned identity carries a binary; Harness defaults do not.
      const executablePath = sourceThreadSettings?.executablePath
      return {
        ...(executablePath ? { executablePath } : {}),
        ...(profile.model ? { model: profile.model } : {}),
        // Match the baseline's bounded, low-effort title/tag classification.
        ...(sourceThreadSettings ? { effort: 'low' as const }
          : profile.effort ? { effort: profile.effort } : {}),
        ...(profile.serviceTier
          ? { serviceTier: profile.serviceTier }
          : {})
      }
    }
  }
}

async function validateAgainstCatalog(
  source: CodexCatalogSource | undefined,
  settings: CodexThreadSettings,
  cwd: string,
  signal: AbortSignal,
  label: string,
  scope: 'all' | 'autoReview' = 'all'
): Promise<void> {
  // A permission-only update must not be rejected because an untouched model
  // fell out of the live catalog; it only needs the auto-review capability.
  const validatesModels = scope === 'all' &&
    Boolean(settings.model || settings.effort || settings.serviceTier)
  const validatesAutoReview = settings.approvalsReviewer === 'auto_review'
  if (!validatesModels && !validatesAutoReview) return
  if (!source) {
    if (validatesAutoReview) throw new Error('Codex approve-for-me 自动审批不可用：缺少目标 runtime 能力确认')
    return
  }
  const executablePath = settings.executablePath
  if (validatesAutoReview) {
    // Asked of a runtime started now: this is the capability the settings turn
    // on, and the runtime applies the same check at every turn.
    const autoReview = await source.probeAutoReview({
      cwd,
      ...(executablePath ? { executablePath } : {}),
      signal
    })
    signal.throwIfAborted()
    if (autoReview !== true) {
      throw new Error('Codex approve-for-me 自动审批不可用：目标 runtime 不支持或禁止 auto_review')
    }
  }
  if (validatesModels) {
    const snapshot = await source.load({
      cwd,
      ...(executablePath ? { executablePath } : {}),
      signal
    })
    signal.throwIfAborted()
    validateCodexModelSettings(snapshot.models, settings, label)
  }
}

function replaceRequestedModelGroup(
  merged: CodexThreadSettings,
  rawRequested: CodexThreadSettingsRequest | undefined
): CodexThreadSettings {
  if (!rawRequested || !hasOwn(rawRequested, 'model')) return merged
  const next = { ...merged }
  // Effort and service tier are model capabilities. A target that explicitly
  // switches model must not inherit either sibling from App defaults.
  if (!hasOwn(rawRequested, 'effort')) delete next.effort
  if (!hasOwn(rawRequested, 'serviceTier')) delete next.serviceTier
  return next
}

function resolvePermissionMode(
  merged: CodexThreadSettings,
  requested: CodexThreadSettingsRequest | undefined,
  defaultPermissionMode: CodexPermissionMode
): CodexThreadSettings {
  // Core shallow-merges opaque creation options; only the Harness interprets them.
  const mergedWithMode = merged as CodexThreadSettings & CodexThreadSettingsRequest
  const { permissionMode, ...native } = mergedWithMode
  const mode = requested?.permissionMode ?? permissionMode
  if (!mode) {
    // No preset anywhere: explicitly configured native permission fields win;
    // otherwise the provider default applies.
    if (codexHasNativePermissionConfig(native)) return native
  }
  const effective = mode ?? defaultPermissionMode
  const { sandbox: _sandbox, sandboxPolicy: _policy, approvalPolicy: _approval,
    approvalsReviewer: _reviewer, ...rest } = native
  return {
    ...rest,
    ...(mode ? { permissionMode: effective } : {}),
    ...nativePermissionPreset(effective)
  }
}

/** Maps a public permission preset onto the native permission triple. */
function nativePermissionPreset(
  mode: CodexPermissionMode
): Pick<CodexThreadSettings, 'sandbox' | 'approvalPolicy' | 'approvalsReviewer'> {
  return {
    sandbox: mode === 'full-access' ? 'danger-full-access' : 'workspace-write',
    approvalPolicy: mode === 'full-access' ? 'never' : 'on-request',
    approvalsReviewer: mode === 'approve-for-me' ? 'auto_review' : 'user'
  }
}

function updatedPermissionGroup(
  current: CodexThreadSettings,
  update: CodexThreadSettingsUpdate,
  defaultPermissionMode: CodexPermissionMode
): Pick<
  CodexThreadSettings,
  'permissionMode' | 'approvalPolicy' | 'approvalsReviewer' | 'sandbox' | 'sandboxPolicy'
> {
  if (!hasOwn(update, 'permissionMode')) {
    const approvalPolicy = updatedSetting(
      hasOwn(update, 'approvalPolicy'),
      update.approvalPolicy,
      current.approvalPolicy
    )
    const sandboxGroup = updatedSandboxGroup(current, update)
    // Patching the native group directly invalidates a persisted preset; the
    // resolved triple no longer matches what the preset advertises.
    const nativePatched = hasOwn(update, 'approvalPolicy') ||
      hasOwn(update, 'sandbox') || hasOwn(update, 'sandboxPolicy')
    return {
      ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
      ...(current.approvalsReviewer ? { approvalsReviewer: current.approvalsReviewer } : {}),
      ...sandboxGroup,
      ...(current.permissionMode && !nativePatched ? { permissionMode: current.permissionMode } : {})
    }
  }
  const mode = update.permissionMode
  if (!mode) {
    // Blank restores the provider default preset instead of dropping the
    // native permission group that the runtime consumes directly.
    return nativePermissionPreset(defaultPermissionMode)
  }
  return {
    permissionMode: mode,
    ...nativePermissionPreset(mode)
  }
}

function updatedSandboxGroup(
  current: CodexThreadSettings,
  update: CodexThreadSettingsUpdate
): Pick<CodexThreadSettings, 'sandbox' | 'sandboxPolicy'> {
  const updatesSandbox = hasOwn(update, 'sandbox')
  const updatesPolicy = hasOwn(update, 'sandboxPolicy')
  if (!updatesSandbox && !updatesPolicy) {
    return cloneSandboxGroup(current)
  }

  const requestedSandbox = updatesSandbox && update.sandbox !== null
    ? update.sandbox
    : undefined
  const requestedPolicy = updatesPolicy && update.sandboxPolicy !== null
    ? update.sandboxPolicy
    : undefined
  if (requestedSandbox !== undefined && requestedPolicy !== undefined) {
    throw new Error('Codex update.sandbox 与 update.sandboxPolicy 不能同时设置')
  }
  if (requestedSandbox !== undefined) return { sandbox: requestedSandbox }
  if (requestedPolicy !== undefined) {
    return { sandboxPolicy: structuredClone(requestedPolicy) }
  }
  if (updatesSandbox && updatesPolicy) return {}
  if (updatesSandbox) {
    // Clearing the simple field removes it only when it is the selected
    // representation; a sparse DTO must not destroy an existing custom policy.
    return current.sandbox !== undefined ? {} : cloneSandboxGroup(current)
  }
  // Symmetric partial clear for the custom representation.
  return current.sandboxPolicy !== undefined ? {} : cloneSandboxGroup(current)
}

function cloneSandboxGroup(
  value: CodexThreadSettings
): Pick<CodexThreadSettings, 'sandbox' | 'sandboxPolicy'> {
  if (value.sandboxPolicy) {
    return { sandboxPolicy: structuredClone(value.sandboxPolicy) }
  }
  return value.sandbox ? { sandbox: value.sandbox } : {}
}

function normalizeHarnessSettings(settings: CodexHarnessSettings): CodexHarnessSettings {
  assertRecord(settings, 'harness settings')
  assertOnlyKeys(
    settings,
    ['useDefaultThreadSettings', 'threadSettings'],
    'harness settings'
  )
  if (!Object.hasOwn(settings, 'threadSettings')) {
    throw new Error('Codex harness settings 缺少 threadSettings')
  }
  const useDefaultThreadSettings = settings.useDefaultThreadSettings
  if (useDefaultThreadSettings !== undefined && typeof useDefaultThreadSettings !== 'boolean') {
    throw new Error('Codex harness settings.useDefaultThreadSettings 必须是 boolean')
  }
  assertRecord(settings.threadSettings, 'threadSettings')
  // The host owns executable discovery, so a Harness-level default must never
  // pin the binary. Thread-level settings legitimately keep the pinned path.
  if (Object.hasOwn(settings.threadSettings, 'executablePath')) {
    throw new Error('Codex harness settings.threadSettings 不能包含 executablePath')
  }
  const threadSettings = normalizeCodexThreadSettings(settings.threadSettings, 'threadSettings')
  // While the gate is on (default), the Harness runs its Agent's own defaults:
  // stored values are dropped rather than blanked (acceptance A3).
  if (useDefaultThreadSettings === false) {
    return { useDefaultThreadSettings: false, threadSettings }
  }
  return { threadSettings: {} }
}

function normalizeUpdate(
  value: CodexThreadSettingsUpdate,
  label = 'update'
): CodexThreadSettingsUpdate {
  assertRecord(value, label)
  assertOnlyKeys(value, [
    'model',
    'effort',
    'serviceTier',
    'personality',
    'approvalPolicy',
    'sandbox',
    'sandboxPolicy',
    'summary',
    'permissionMode'
  ], label)
  const model = hasOwn(value, 'model')
    ? nullableIdentifier(value.model, `${label}.model`, 256)
    : undefined
  const effort = hasOwn(value, 'effort')
    ? nullableIdentifier(value.effort, `${label}.effort`, 64)
    : undefined
  const serviceTier = hasOwn(value, 'serviceTier')
    ? nullableIdentifier(value.serviceTier, `${label}.serviceTier`, 128)
    : undefined
  const personality = hasOwn(value, 'personality')
    ? nullableEnum(value.personality, CODEX_PERSONALITIES, `${label}.personality`)
    : undefined
  const approvalPolicy = hasOwn(value, 'approvalPolicy')
    ? nullableEnum(
        value.approvalPolicy,
        CODEX_APPROVAL_POLICIES,
        `${label}.approvalPolicy`
      )
    : undefined
  const sandbox = hasOwn(value, 'sandbox')
    ? nullableEnum(value.sandbox, CODEX_SANDBOXES, `${label}.sandbox`)
    : undefined
  const sandboxPolicy = hasOwn(value, 'sandboxPolicy')
    ? nullableSandboxPolicy(value.sandboxPolicy, `${label}.sandboxPolicy`)
    : undefined
  const summary = hasOwn(value, 'summary')
    ? nullableEnum(value.summary, CODEX_REASONING_SUMMARIES, `${label}.summary`)
    : undefined
  const permissionMode = hasOwn(value, 'permissionMode')
    ? nullableEnum(value.permissionMode, CODEX_PERMISSION_MODES, `${label}.permissionMode`)
    : undefined
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(personality !== undefined ? { personality } : {}),
    ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(sandboxPolicy !== undefined ? { sandboxPolicy } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {})
  }
}

function nullableSandboxPolicy(
  value: CodexThreadSettingsUpdate['sandboxPolicy'],
  label: string
): CodexThreadSettings['sandboxPolicy'] | null {
  if (value === null) return null
  const normalized = normalizeCodexSandboxPolicy(value, label)
  if (normalized === undefined) throw new Error(`Codex ${label} 必须是对象或 null`)
  return normalized
}

function assertExecutableIdentity(
  existing: DeepReadonly<CodexThreadSettings> | undefined,
  next: CodexThreadSettings
): void {
  if (existing?.executablePath !== undefined && existing.executablePath !== next.executablePath) {
    throw new Error('已有 Codex Primary Native Session 不能更换 executablePath')
  }
}

function assertOnlyKeys(
  value: object,
  allowedKeys: readonly string[],
  label: string
): void {
  const allowed = new Set(allowedKeys)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new Error(`Codex ${label} 包含未知字段：${unknown.join(', ')}`)
}

function assertRecord(value: unknown, label: string): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Codex ${label} 必须是对象`)
  }
}

function requiredIdentifier(value: unknown, label: string, maxLength: number): string {
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

function nullableIdentifier(
  value: unknown,
  label: string,
  maxLength: number
): string | null {
  return value === null ? null : requiredIdentifier(value, label, maxLength)
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

function nullableEnum<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  label: string
): Values[number] | null {
  if (value === null) return null
  const normalized = optionalEnum(value, allowed, label)
  if (normalized === undefined) {
    throw new Error(`Codex ${label} 必须是：${allowed.join('、')}，或 null`)
  }
  return normalized
}

function updatedSetting<Setting>(
  provided: boolean,
  update: Setting | null | undefined,
  current: Setting | undefined
): Setting | undefined {
  if (!provided) return current
  return update === null ? undefined : update
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasAnyOwn(value: object, keys: readonly PropertyKey[]): boolean {
  return keys.some((key) => hasOwn(value, key))
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
}

function clone<T>(value: DeepReadonly<T>): T {
  return structuredClone(value) as T
}
