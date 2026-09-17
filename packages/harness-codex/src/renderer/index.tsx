import {
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import {
  AlertCircle,
  Check,
  LoaderCircle,
  RefreshCw
} from 'lucide-react'
import type { DeepReadonly } from '@openagent/contracts'
import type {
  HarnessRendererPlugin,
  HarnessSettingsProps,
  HarnessSettingsResource,
  HarnessThreadSettingsProps
} from '@openagent/contracts/renderer'
import { isPublicExecutionActive } from '@openagent/contracts/renderer'
import { useI18n } from '@openagent/plugin-kit/renderer'
import { HarnessExecutableSetting } from '@openagent/plugin-kit/renderer'
import {
  SettingsCliStatus,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
  SettingsSelect,
  SettingsUseDefaults,
  useSettingsFormPage
} from '@openagent/plugin-kit/renderer'
import type {
  CodexHarnessSettings,
  CodexModelOption,
  CodexPermissionMode,
  CodexSettingsPresentationData,
  CodexThreadSettings,
  CodexThreadSettingsUpdate
} from '../shared/types.js'
import { CODEX_PERMISSION_MODES } from '../shared/types.js'
import codexLogo from './codex-glyph.svg?inline'
import { CodexOverviewCard } from './OverviewCard.js'
import { CodexThreadView } from './ThreadView.js'
import { createEmptyCodexState, decodeCodexState } from '../shared/state.js'
import { projectCodexBartPresentation } from '../shared/bart-presentation.js'
import { codexHasNativePermissionConfig } from '../shared/settings.js'
import {
  projectCodexOverview,
  type CodexOverviewView
} from './overview.js'
import './codex-renderer.css'
import { codexRendererTranslations } from './translations.js'

export function CodexThreadSettingsView({
  thread,
  resource,
  update
}: HarnessThreadSettingsProps<
  CodexThreadSettingsUpdate,
  CodexSettingsPresentationData
>): React.JSX.Element {
  const { t } = useI18n()
  const settings = thread.settings as DeepReadonly<CodexThreadSettings>
  const current = useMemo(() => cloneProfile(settings), [settings])
  const identity = JSON.stringify(current)
  const [draft, setDraft] = useState<CodexThreadSettings>(() => current)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const executionActive = isPublicExecutionActive(thread.observation)
  const change = useMemo(
    () => threadSettingsUpdate(current, draft),
    [current, draft]
  )
  const dirty = Object.keys(change).length > 0

  useEffect(() => {
    setDraft(current)
    setError(undefined)
  }, [thread.id, identity])

  const save = async (): Promise<void> => {
    if (saving || executionActive || !dirty) return
    setSaving(true)
    setError(undefined)
    try {
      await update(change)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="codex-settings provider-settings-stack">
      <SettingsResourceStatus resource={resource} />
      <SettingsSection
        description={t('保存后的设置在下一次 Codex 操作时生效；Primary Native Session 不会被替换。')}
        title={t('Thread 配置')}
      >
        <ProfileFields
          disabled={saving || executionActive}
          id={`codex-thread-${thread.id}`}
          models={readyModels(resource)}
          value={draft}
          onChange={setDraft}
        />
      </SettingsSection>

      {executionActive ? (
        <div className="codex-settings-warning" role="status">
          <AlertCircle size={13} />
          <span>{t('该 Thread 正在运行，请等待完成或停止后再修改。')}</span>
        </div>
      ) : null}
      {error ? <InlineError message={error} /> : null}
      <div className="codex-settings-actions">
        <button
          disabled={saving || executionActive || !dirty}
          onClick={() => void save()}
          type="button"
        >
          {saving ? <LoaderCircle className="codex-settings-spin" size={12} /> : null}
          {saving ? t('保存中…') : t('应用 Thread 配置')}
        </button>
      </div>
    </div>
  )
}

export function CodexHarnessSettingsView({
  section,
  value,
  resource,
  change
}: HarnessSettingsProps<
  CodexHarnessSettings,
  CodexSettingsPresentationData
>): React.JSX.Element {
  const { t } = useI18n()
  const settingsFormPage = useSettingsFormPage()
  const models = readyModels(resource)
  const settings = cloneHarnessSettings(value)
  const useDefaultThreadSettings = settings.useDefaultThreadSettings !== false

  const changeProfile = (next: CodexThreadSettings): void => {
    change({
      ...(settings.useDefaultThreadSettings === false ? { useDefaultThreadSettings: false } : {}),
      threadSettings: cloneProfile(next)
    })
  }
  // Going back to the Agent defaults clears the stored values so the page stops
  // showing knobs that would otherwise keep executing. The composition boundary
  // rejects an own key holding `undefined`, so the flag is dropped rather than
  // blanked.
  const changeUseDefaults = (useDefaults: boolean): void => {
    change({
      ...(useDefaults ? {} : { useDefaultThreadSettings: false }),
      threadSettings: useDefaults ? {} : cloneProfile(settings.threadSettings)
    })
  }

  if (section === 'cli') {
    const cli = resource.status === 'ready' ? resource.value.cli : undefined
    const status = resource.status === 'loading' ? t('正在读取 Codex 环境…')
      : resource.status === 'error' ? resource.message
      : cli?.available ? cli.version || t('已读取 Codex 环境')
      : cli?.error || t('Codex CLI 不可用')
    if (settingsFormPage) {
      return (
        <SettingsCliStatus
          error={resource.status === 'ready' ? resource.value.modelsError : undefined}
          label="Codex CLI"
          status={status}
          tone={resource.status === 'error' ? 'error' : cli?.available ? 'success' : 'warning'}
        />
      )
    }
    return (
      <HarnessExecutableSetting
        available={cli?.available === true}
        error={resource.status === 'ready' ? resource.value.modelsError : undefined}
        loading={resource.status === 'loading'}
        logoSource={codexLogo}
        name="Codex CLI"
        onReload={resource.reload}
        status={status}
      />
    )
  }

  return (
    <div className="codex-settings provider-settings-stack">
      {resource.status !== 'ready' || !resource.value.cli.available || resource.value.modelsError
        ? <SettingsResourceStatus resource={resource} /> : null}

      {section === 'thread' ? <SettingsSection
        description={t('用于新建 Thread 的原生配置默认值，包括 Bart 宿主。')}
        title={t('Codex Thread 默认配置')}
      >
        {settingsFormPage
          ? <SettingsUseDefaults checked={useDefaultThreadSettings}
              onChange={changeUseDefaults}>
              <ProfileFields
                id="codex-default-thread"
                models={models}
                value={settings.threadSettings}
                onChange={(next) => changeProfile(next)}
              />
            </SettingsUseDefaults>
          : <ProfileFields
              id="codex-default-thread"
              models={models}
              value={settings.threadSettings}
              onChange={(next) => changeProfile(next)}
            />}
      </SettingsSection> : null}
    </div>
  )
}

function ProfileField(props: {
  readonly children: ReactNode
  readonly description?: ReactNode
  readonly label: ReactNode
  readonly page: boolean
  readonly wide?: boolean
}): React.JSX.Element {
  if (props.page) {
    return (
      <SettingsRow
        label={props.label}
      >
        {props.children}
      </SettingsRow>
    )
  }

  return (
    <label className={`settings-control${props.wide ? ' settings-control-wide' : ''}`}>
      <span>{props.label}</span>
      {props.children}
      {props.description ? (
        <small className="settings-field-hint">{props.description}</small>
      ) : null}
    </label>
  )
}

function LegacySettingsSelect(
  props: React.ComponentPropsWithRef<'select'>
): React.JSX.Element {
  return <select {...props} />
}

function ProfileFields(props: {
  readonly disabled?: boolean
  readonly id: string
  readonly models: readonly DeepReadonly<CodexModelOption>[]
  readonly value: DeepReadonly<CodexThreadSettings>
  onChange(value: CodexThreadSettings): void
}): React.JSX.Element {
  const { t } = useI18n()
  const settingsFormPage = useSettingsFormPage()
  const selected = props.models.find((model) => model.value === props.value.model)
  const efforts = reasoningEfforts(props.models, selected, props.value.effort)
  const tiers = serviceTiers(props.models, selected, props.value.serviceTier)
  // With no explicit native permission fields, blank resolves to the
  // approve-for-me preset for new Threads; label it accordingly.
  const nativePermissionConfigured = codexHasNativePermissionConfig(props.value)
  const blankPermissionLabel = nativePermissionConfigured
    ? t('OpenAgent 默认')
    : t('OpenAgent 默认（approve-for-me）')
  const update = <Key extends keyof CodexThreadSettings>(
    key: Key,
    value: CodexThreadSettings[Key]
  ): void => props.onChange(withProfileSetting(props.value, key, value))

  const Select = settingsFormPage
    ? SettingsSelect
    : LegacySettingsSelect
  const selectedEffort = efforts.find((effort) => effort.value === props.value.effort)

  return (
    <div className={settingsFormPage ? 'codex-settings-profile-fields' : 'settings-form-grid'}>
      <ProfileField
        description={selected?.description}
        label={t('模型')}
        page={settingsFormPage}
        wide
      >
        <Select
          aria-label={`${profileLabel(props.id, t)} ${t('模型')}`}
          disabled={props.disabled}
          value={props.value.model || ''}
          onChange={(event) => {
            const model = event.currentTarget.value || undefined
            let next = withProfileSetting(props.value, 'model', model)
            const option = props.models.find((candidate) => candidate.value === model)
            if (
              option &&
              next.effort &&
              !option.supportedReasoningEfforts.some(({ value }) => value === next.effort)
            ) {
              next = withProfileSetting(next, 'effort', undefined)
            }
            if (
              option &&
              next.serviceTier &&
              !option.serviceTiers.some(({ value }) => value === next.serviceTier)
            ) {
              next = withProfileSetting(next, 'serviceTier', undefined)
            }
            props.onChange(next)
          }}
        >
          <option value="">{t('跟随 Codex 默认模型')}</option>
          {props.value.model && !selected ? (
            <option value={props.value.model}>
              {props.value.model} · {t('目录中不可用')}
            </option>
          ) : null}
          {props.models.map((model) => (
            <option key={model.value} value={model.value}>{model.displayName}</option>
          ))}
        </Select>
      </ProfileField>

      <ProfileField
        description={selectedEffort?.description}
        label={t('推理强度')}
        page={settingsFormPage}
      >
        <Select
          aria-label={`${profileLabel(props.id, t)} ${t('推理强度')}`}
          disabled={props.disabled}
          value={props.value.effort || ''}
          onChange={(event) => update('effort', event.currentTarget.value || undefined)}
        >
          <option value="">{t('模型默认')}</option>
          {efforts.map((effort) => (
            <option key={effort.value} value={effort.value}>{effort.value}</option>
          ))}
        </Select>
      </ProfileField>

      <ProfileField label={t('服务层级')} page={settingsFormPage}>
        <Select
          aria-label={`${profileLabel(props.id, t)} ${t('服务层级')}`}
          disabled={props.disabled}
          value={props.value.serviceTier || ''}
          onChange={(event) => update('serviceTier', event.currentTarget.value || undefined)}
        >
          <option value="">{t('模型默认')}</option>
          {tiers.map((tier) => (
            <option key={tier.value} value={tier.value}>
              {tier.displayName ? `${tier.displayName} · ${tier.value}` : tier.value}
            </option>
          ))}
        </Select>
      </ProfileField>

      <ProfileField label={t('权限模式')} page={settingsFormPage}>
        <Select
          aria-label={`${profileLabel(props.id, t)} ${t('权限模式')}`}
          disabled={props.disabled}
          value={props.value.permissionMode || ''}
          onChange={(event) => update(
            'permissionMode',
            (event.currentTarget.value || undefined) as CodexPermissionMode | undefined
          )}
        >
          <option value="">{blankPermissionLabel}</option>
          {CODEX_PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>{t(permissionModeLabel(mode))}</option>
          ))}
        </Select>
      </ProfileField>
    </div>
  )
}

function SettingsResourceStatus(props: {
  readonly resource: HarnessSettingsResource<CodexSettingsPresentationData>
}): React.JSX.Element {
  const { t } = useI18n()
  if (useSettingsFormPage()) {
    if (props.resource.status === 'loading') {
      return <></>
    }
    if (props.resource.status === 'error') {
      return (
        <SettingsNotice
          action={(
            <button
              className="settings-inline-action"
              onClick={() => void props.resource.reload({ refresh: true })}
              type="button"
            >
              <RefreshCw size={11} />{t('重试')}
            </button>
          )}
          className="codex-settings-resource-status"
          tone="error"
        >
          <AlertCircle size={13} />
          <span>{props.resource.message}</span>
        </SettingsNotice>
      )
    }
    return (
      <>
        <SettingsNotice
          action={(
            <button
              className="settings-inline-action"
              onClick={() => void props.resource.reload({ refresh: true })}
              type="button"
            >
              <RefreshCw size={11} />{t('刷新')}
            </button>
          )}
          className="codex-settings-resource-status"
          tone={props.resource.value.cli.available ? 'success' : 'warning'}
        >
          {props.resource.value.cli.available
            ? <Check size={13} />
            : <AlertCircle size={13} />}
          <span>
            {props.resource.value.cli.available
              ? t('已读取 Codex 环境')
              : props.resource.value.cli.error || t('Codex CLI 不可用')}
          </span>
        </SettingsNotice>
        {props.resource.value.modelsError
          ? (
            <SettingsNotice className="codex-settings-error" tone="error">
              <AlertCircle size={13} />
              <span>{props.resource.value.modelsError}</span>
            </SettingsNotice>
          )
          : null}
      </>
    )
  }
  if (props.resource.status === 'loading') {
    return (
      <div className="codex-settings-resource-status" role="status">
        <LoaderCircle className="codex-settings-spin" size={13} />{t('正在读取 Codex 环境…')}
      </div>
    )
  }
  if (props.resource.status === 'error') {
    return (
      <div className="codex-settings-resource-status error" role="alert">
        <AlertCircle size={13} />
        <span>{props.resource.message}</span>
        <button onClick={() => void props.resource.reload({ refresh: true })} type="button">
          <RefreshCw size={11} />{t('重试')}
        </button>
      </div>
    )
  }
  return (
    <>
      <div
        className={`codex-settings-resource-status ${props.resource.value.cli.available ? 'ready' : 'error'}`}
        role="status"
      >
        {props.resource.value.cli.available ? <Check size={13} /> : <AlertCircle size={13} />}
        <span>
          {props.resource.value.cli.available
            ? t('已读取 Codex 环境')
            : props.resource.value.cli.error || t('Codex CLI 不可用')}
        </span>
        <button onClick={() => void props.resource.reload({ refresh: true })} type="button">
          <RefreshCw size={11} />{t('刷新')}
        </button>
      </div>
      {props.resource.value.modelsError
        ? <InlineError message={props.resource.value.modelsError} />
        : null}
    </>
  )
}

function SettingsSection(props: {
  readonly action?: ReactNode
  readonly children: ReactNode
  readonly description: string
  readonly title: string
}): React.JSX.Element {
  if (useSettingsFormPage()) {
    return (
      <SettingsGroup action={props.action}>
        {props.children}
      </SettingsGroup>
    )
  }
  return (
    <section className="settings-section">
      <header className="settings-section-heading">
        <div className="settings-section-heading-copy">
          <h3>{props.title}</h3>
          <p>{props.description}</p>
        </div>
        {props.action}
      </header>
      {props.children}
    </section>
  )
}

function InlineError(props: { readonly message: string }): React.JSX.Element {
  return (
    <div className="codex-settings-error" role="alert">
      <AlertCircle size={13} /><span>{props.message}</span>
    </div>
  )
}

function cloneHarnessSettings(
  value: DeepReadonly<CodexHarnessSettings>
): CodexHarnessSettings {
  return {
    ...(value.useDefaultThreadSettings === false ? { useDefaultThreadSettings: false } : {}),
    threadSettings: cloneProfile(value.threadSettings)
  }
}

function cloneProfile(
  value: DeepReadonly<CodexThreadSettings>
): CodexThreadSettings {
  return {
    ...(value.executablePath ? { executablePath: value.executablePath } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.effort ? { effort: value.effort } : {}),
    ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}),
    ...(value.personality ? { personality: value.personality } : {}),
    ...(value.approvalPolicy ? { approvalPolicy: value.approvalPolicy } : {}),
    ...(value.approvalsReviewer ? { approvalsReviewer: value.approvalsReviewer } : {}),
    ...(value.sandbox ? { sandbox: value.sandbox } : {}),
    ...(value.sandboxPolicy
      ? { sandboxPolicy: structuredClone(value.sandboxPolicy) }
      : {}),
    ...(value.summary ? { summary: value.summary } : {}),
    ...(value.permissionMode ? { permissionMode: value.permissionMode } : {})
  }
}

function withProfileSetting<Key extends keyof CodexThreadSettings>(
  value: DeepReadonly<CodexThreadSettings>,
  key: Key,
  setting: CodexThreadSettings[Key]
): CodexThreadSettings {
  const next = cloneProfile(value) as Record<string, unknown>
  if (setting === undefined) delete next[key]
  else next[key] = structuredClone(setting)
  return next as CodexThreadSettings
}

function threadSettingsUpdate(
  current: DeepReadonly<CodexThreadSettings>,
  draft: DeepReadonly<CodexThreadSettings>
): CodexThreadSettingsUpdate {
  const update: Record<string, unknown> = {}
  for (const key of [
    'model',
    'effort',
    'serviceTier',
    'permissionMode'
  ] as const) {
    if (JSON.stringify(current[key]) === JSON.stringify(draft[key])) continue
    update[key] = draft[key] === undefined ? null : structuredClone(draft[key])
  }
  return update as CodexThreadSettingsUpdate
}

function reasoningEfforts(
  models: readonly DeepReadonly<CodexModelOption>[],
  selected: DeepReadonly<CodexModelOption> | undefined,
  configured: string | undefined
): readonly { readonly value: string; readonly description?: string }[] {
  const options = selected
    ? selected.supportedReasoningEfforts
    : models.flatMap((model) => model.supportedReasoningEfforts)
  const byValue = new Map(options.map((option) => [option.value, option]))
  if (configured && !byValue.has(configured)) byValue.set(configured, { value: configured })
  return [...byValue.values()]
}

function serviceTiers(
  models: readonly DeepReadonly<CodexModelOption>[],
  selected: DeepReadonly<CodexModelOption> | undefined,
  configured: string | undefined
): readonly { readonly value: string; readonly displayName?: string }[] {
  const options = selected
    ? selected.serviceTiers
    : models.flatMap((model) => model.serviceTiers)
  const byValue = new Map(options.map((option) => [option.value, option]))
  if (configured && !byValue.has(configured)) byValue.set(configured, { value: configured })
  return [...byValue.values()]
}

function readyModels(
  resource: HarnessSettingsResource<CodexSettingsPresentationData>
): readonly DeepReadonly<CodexModelOption>[] {
  return resource.status === 'ready' ? resource.value.models : []
}

function profileLabel(id: string, t: ReturnType<typeof useI18n>['t']): string {
  if (id === 'codex-default-thread') return t('Codex Thread 默认配置')
  return t('Codex Thread')
}

function permissionModeLabel(value: CodexPermissionMode): string {
  switch (value) {
    case 'ask-for-approval': return 'ask-for-approval · 按需询问用户'
    case 'approve-for-me': return 'approve-for-me · 原生自动审批'
    case 'full-access': return 'full-access · 完全访问'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const codexRendererPlugin = {
  logoSource: codexLogo,
  translations: codexRendererTranslations,
  ThreadView: CodexThreadView,
  OverviewCard: {
    project: projectCodexOverview,
    Card: CodexOverviewCard
  },
  projectBartDock({ thread }) {
    const state = thread.sessionState === null
      ? createEmptyCodexState(thread.createdAt)
      : decodeCodexState(thread.sessionState)
    return projectCodexBartPresentation(state)
  },
  ThreadSettings: CodexThreadSettingsView,
  HarnessSettings: CodexHarnessSettingsView
} satisfies HarnessRendererPlugin<
  CodexOverviewView,
  CodexThreadSettingsUpdate,
  CodexHarnessSettings,
  CodexSettingsPresentationData
>
