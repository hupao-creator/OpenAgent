import { useEffect, useState, type ReactNode } from 'react'
import { AlertCircle, Check, LoaderCircle, RefreshCw } from 'lucide-react'
import type { DeepReadonly } from '@openagent/contracts'
import type { HarnessSettingsProps, HarnessSettingsResource, HarnessThreadSettingsProps } from '@openagent/contracts/renderer'
import { isPublicExecutionActive } from '@openagent/contracts/renderer'
import { useI18n } from '@openagent/plugin-kit/renderer'
import {
  SettingsUseDefaults,
  SettingsGroup,
  SettingsCliStatus,
  SettingsInput,
  SettingsNotice,
  SettingsRow,
  SettingsSelect,
  useSettingsFormPage
} from '@openagent/plugin-kit/renderer'
import {
  CLAUDE_PERMISSION_MODES,
  type ClaudeEffortLevel,
  type ClaudeHarnessSettings,
  type ClaudeModelPresentation,
  type ClaudePermissionMode,
  type ClaudeSettingsPresentationData,
  type ClaudeThreadSettings,
  type ClaudeThreadSettingsRequest,
  type ClaudeThreadSettingsUpdate
} from '../shared/settings.js'
import claudeCodeLogo from './claude-code.svg?inline'
import { HarnessExecutableSetting } from '@openagent/plugin-kit/renderer'
import { errorMessage } from './values.js'
import { InlineError } from './primitives.js'
import { PERMISSION_MODE_LABELS } from './labels.js'

export function ClaudeThreadSettingsPanel(
  props: HarnessThreadSettingsProps<
    ClaudeThreadSettingsUpdate,
    ClaudeSettingsPresentationData
  >
): React.JSX.Element {
  const { t } = useI18n()
  const settings = props.thread.settings as DeepReadonly<ClaudeThreadSettings>
  const presentation = readyPresentation(props.resource)
  const [draft, setDraft] = useState(() => threadSettingsDraft(settings))
  const [saving, setSaving] = useState(false)
  const [invalidModel, setInvalidModel] = useState(false)
  const [error, setError] = useState<string>()
  const settingsIdentity = [
    settings.model || '',
    settings.effort || '',
    settings.permissionMode || ''
  ].join('\u0000')

  useEffect(() => {
    setDraft(threadSettingsDraft(settings))
    setError(undefined)
  }, [settingsIdentity])

  const update = threadSettingsUpdate(settings, draft)
  const dirty = Object.keys(update).length > 0
  const executionActive = isPublicExecutionActive(props.thread.observation)
  const disabled = saving || executionActive

  const save = async (): Promise<void> => {
    // The editor keeps text the creation contract rejects out of the draft, so
    // applying now would persist the last valid prefix instead of what is shown.
    if (!dirty || disabled || invalidModel) return
    setSaving(true)
    setError(undefined)
    try {
      await props.update(update)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="claude-renderer-settings harness-settings-stack">
      <SettingsResourceStatus resource={props.resource} />
      <SettingsSection
        description={t('保存后的配置会在下一次 Claude 操作时生效；Primary Native Session 不会被替换。')}
        title={t('Thread 配置')}
      >
        <div className="settings-form-grid">
          <ModelField
            disabled={disabled}
            id={`claude-thread-model-${props.thread.id}`}
            models={presentation?.models || []}
            value={draft.model}
            onInvalidChange={setInvalidModel}
            onChange={(model) => setDraft((current) => ({
              ...current,
              model,
              effort: compatibleClaudeEffort(
                presentation?.models || [],
                model,
                current.effort
              )
            }))}
          />
          <EffortField
            disabled={disabled}
            models={presentation?.models || []}
            model={draft.model}
            value={draft.effort}
            onChange={(effort) => setDraft((current) => ({ ...current, effort }))}
          />
          <PermissionModeField
            disabled={disabled}
            value={draft.permissionMode}
            onChange={(permissionMode) => setDraft((current) => ({
              ...current,
              permissionMode
            }))}
          />
        </div>
      </SettingsSection>

      {executionActive ? (
        <p className="claude-renderer-settings-warning">
          {t('该 Thread 正在运行，请等待完成或停止后再修改。')}
        </p>
      ) : null}
      {invalidModel ? (
        <p className="claude-renderer-settings-warning">
          {t('模型标识不能以空白开头或结尾。')}
        </p>
      ) : null}
      {error ? <InlineError message={error} /> : null}
      <div className="claude-renderer-settings-actions">
        <button
          disabled={disabled || invalidModel || !dirty}
          onClick={() => void save()}
          type="button"
        >
          {saving ? <LoaderCircle className="claude-renderer-spin" size={12} /> : null}
          {saving ? t('正在保存…') : t('应用 Thread 配置')}
        </button>
      </div>
    </div>
  )
}

export function ClaudeHarnessSettingsPanel(
  props: HarnessSettingsProps<ClaudeHarnessSettings, ClaudeSettingsPresentationData>
): React.JSX.Element {
  const { t } = useI18n()
  const settingsFormPage = useSettingsFormPage()
  const presentation = readyPresentation(props.resource)
  const draft = props.value
  const useDefaults = draft.useDefaultThreadSettings !== false

  const changeThreadDefaults = (patch: Partial<ClaudeThreadSettingsRequest>): void => {
    props.change({
      ...cloneHarnessSettings(draft),
      threadSettings: cloneThreadRequest({
        ...cloneThreadRequest(draft.threadSettings),
        ...patch
      })
    })
  }

  // Going back to the Agent defaults clears the stored values so the page stops
  // displaying knobs that would otherwise keep executing. The composition
  // boundary rejects an own key holding `undefined`, so that payload drops the
  // flag rather than blanking it.
  const changeUseDefaults = (next: boolean): void => {
    const { useDefaultThreadSettings: _dropped, ...settings } = cloneHarnessSettings(draft)
    props.change({
      ...settings,
      ...(next ? {} : { useDefaultThreadSettings: false }),
      threadSettings: next ? {} : cloneThreadRequest(draft.threadSettings)
    })
  }

  if (props.section === 'cli') {
    const cli = presentation?.cli
    if (settingsFormPage) {
      const available = cli?.status === 'available'
      const status = props.resource.status === 'loading'
        ? t('正在读取 Claude 环境…')
        : props.resource.status === 'error'
          ? props.resource.message
          : available
            ? cli.version || t('已读取 Claude 环境')
            : cli?.message || t('不可用')
      const tone: 'info' | 'error' | 'warning' | 'success' = props.resource.status === 'loading'
        ? 'info'
        : props.resource.status === 'error'
          ? 'error'
          : available ? 'success' : 'warning'
      return (
        <SettingsCliStatus
          label="Claude Code"
          status={status}
          tone={tone}
        />
      )
    }
    return (
      <HarnessExecutableSetting
        available={cli?.status === 'available'}
        loading={props.resource.status === 'loading'}
        logoSource={claudeCodeLogo}
        name="Claude Code"
        onReload={props.resource.reload}
        status={props.resource.status === 'loading' ? t('正在读取 Claude 环境…')
          : props.resource.status === 'error' ? props.resource.message
          : cli?.status === 'available' ? cli.version || t('已读取 Claude 环境')
          : cli?.message || t('不可用')}
      />
    )
  }

  return (
    <div className="claude-renderer-settings harness-settings-stack">
      {props.resource.status !== 'ready' || presentation?.cli.status !== 'available'
        ? <SettingsResourceStatus resource={props.resource} /> : null}

      {props.section === 'thread' ? <SettingsSection
        description={t('普通 Thread 与 Bart 共用的 Claude 原生默认配置。')}
        title={t('Claude Thread 默认配置')}
      >
        {settingsFormPage
          ? <SettingsUseDefaults checked={useDefaults} onChange={changeUseDefaults}>
              <ThreadDefaultsFields
                id="claude-thread-defaults"
                models={presentation?.models || []}
                value={draft.threadSettings}
                onChange={changeThreadDefaults}
              />
            </SettingsUseDefaults>
          : <ThreadDefaultsFields
              id="claude-thread-defaults"
              models={presentation?.models || []}
              value={draft.threadSettings}
              onChange={changeThreadDefaults}
            />}
      </SettingsSection> : null}
    </div>
  )
}

function ThreadDefaultsFields(props: {
  readonly id: string
  readonly models: readonly DeepReadonly<ClaudeModelPresentation>[]
  readonly value: DeepReadonly<ClaudeThreadSettingsRequest>
  readonly disabled?: boolean
  onChange(patch: Partial<ClaudeThreadSettingsRequest>): void
}): React.JSX.Element {
  const settingsFormPage = useSettingsFormPage()
  const fields = (
    <>
      <ModelField
        disabled={props.disabled}
        id={`${props.id}-model`}
        models={props.models}
        value={props.value.model || ''}
        onChange={(model) => props.onChange({
          model: model || undefined,
          effort: compatibleClaudeEffort(props.models, model, props.value.effort) ||
            undefined
        })}
      />
      <EffortField
        disabled={props.disabled}
        models={props.models}
        model={props.value.model || ''}
        value={props.value.effort || ''}
        onChange={(effort) => props.onChange({
          effort: (effort || undefined) as ClaudeEffortLevel | undefined
        })}
      />
      <PermissionModeField
        disabled={props.disabled}
        value={props.value.permissionMode || ''}
        onChange={(permissionMode) => props.onChange({
          permissionMode: (permissionMode || undefined) as ClaudePermissionMode | undefined
        })}
      />
    </>
  )
  if (settingsFormPage) return fields
  return (
    <div className="settings-form-grid">
      {fields}
    </div>
  )
}

function ModelField(props: {
  readonly disabled?: boolean
  readonly id: string
  readonly models: readonly DeepReadonly<ClaudeModelPresentation>[]
  readonly value: string
  onChange(value: string): void
  onInvalidChange?(invalid: boolean): void
}): React.JSX.Element {
  const { t } = useI18n()
  const settingsFormPage = useSettingsFormPage()
  const selected = props.models.find((model) => model.value === props.value)
  const [text, setText] = useState(props.value)
  const valid = validModelIdentifier(text)
  useEffect(() => setText(props.value), [props.value])
  // The creation contract rejects surrounding whitespace and over-long
  // identifiers. Keep rejected text in the editor without handing it to the
  // autosaving host, which would persist a value the harness refuses.
  const change = (value: string): void => {
    setText(value)
    if (validModelIdentifier(value)) props.onChange(value)
  }
  // Explicit-apply hosts need the editor's own validity: the draft holds the
  // last accepted prefix, so saving it would apply something other than what
  // the field displays.
  const reportValidity = props.onInvalidChange
  useEffect(() => {
    reportValidity?.(!valid)
  }, [reportValidity, valid])
  if (settingsFormPage) {
    return (
      <SettingsRow
        htmlFor={props.id}
        label={t('模型')}
      >
        <SettingsInput
          disabled={props.disabled}
          id={props.id}
          list={`${props.id}-catalog`}
          maxLength={512}
          pattern={'^[^\\s](?:.*[^\\s])?$'}
          placeholder={t('跟随 Claude 默认模型')}
          spellCheck={false}
          title={t('模型标识不能以空白开头或结尾。')}
          value={text}
          onChange={(event) => change(event.target.value)}
        />
        <datalist id={`${props.id}-catalog`}>
          {props.models.map((model) => (
            <option key={model.value} value={model.value}>{model.displayName}</option>
          ))}
        </datalist>
      </SettingsRow>
    )
  }
  return (
    <label className="settings-control settings-control-wide">
      <span>{t('模型')}</span>
      <input
        disabled={props.disabled}
        list={`${props.id}-catalog`}
        maxLength={512}
        pattern={'^[^\\s](?:.*[^\\s])?$'}
        placeholder={t('跟随 Claude 默认模型')}
        spellCheck={false}
        value={text}
        onChange={(event) => change(event.target.value)}
      />
      <datalist id={`${props.id}-catalog`}>
        {props.models.map((model) => (
          <option key={model.value} value={model.value}>{model.displayName}</option>
        ))}
      </datalist>
      {selected?.description ? <small className="settings-field-hint">{selected.description}</small> : null}
    </label>
  )
}

function EffortField(props: {
  readonly disabled?: boolean
  readonly models: readonly DeepReadonly<ClaudeModelPresentation>[]
  readonly model: string
  readonly value: string
  onChange(value: string): void
}): React.JSX.Element {
  const { t } = useI18n()
  const settingsFormPage = useSettingsFormPage()
  const options = availableEfforts(props.models, props.model)
  if (settingsFormPage) {
    return (
      <SettingsRow label={t('推理强度')}>
        <SettingsSelect
          disabled={props.disabled || !props.model || options.length === 0}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        >
          <option value="">{t('跟随 Claude 配置')}</option>
          {options.map((effort) => (
            <option key={effort} value={effort}>{effortLabel(effort)}</option>
          ))}
        </SettingsSelect>
      </SettingsRow>
    )
  }
  return (
    <label className="settings-control">
      <span>{t('推理强度')}</span>
      <select
        disabled={props.disabled || !props.model || options.length === 0}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        <option value="">{t('跟随 Claude 配置')}</option>
        {options.map((effort) => (
          <option key={effort} value={effort}>{effortLabel(effort)}</option>
        ))}
      </select>
    </label>
  )
}

function PermissionModeField(props: {
  readonly disabled?: boolean
  readonly value: string
  onChange(value: string): void
}): React.JSX.Element {
  const { t } = useI18n()
  const settingsFormPage = useSettingsFormPage()
  if (settingsFormPage) {
    return (
      <SettingsRow label={t('权限模式')}>
        <SettingsSelect
          disabled={props.disabled}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        >
          <option value="">{t('OpenAgent 默认（auto）')}</option>
          {CLAUDE_PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>{mode} · {t(PERMISSION_MODE_LABELS[mode])}</option>
          ))}
        </SettingsSelect>
      </SettingsRow>
    )
  }
  return (
    <label className="settings-control">
      <span>{t('权限模式')}</span>
      <select
        disabled={props.disabled}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        <option value="">{t('OpenAgent 默认（auto）')}</option>
        {CLAUDE_PERMISSION_MODES.map((mode) => (
          <option key={mode} value={mode}>{mode} · {t(PERMISSION_MODE_LABELS[mode])}</option>
        ))}
      </select>
    </label>
  )
}

function SettingsResourceStatus(props: {
  readonly resource: HarnessSettingsResource<ClaudeSettingsPresentationData>
}): React.JSX.Element {
  const { t } = useI18n()
  const settingsFormPage = useSettingsFormPage()
  if (props.resource.status === 'loading') {
    if (settingsFormPage) {
      return <></>
    }
    return (
      <div className="claude-renderer-resource-status">
        <LoaderCircle className="claude-renderer-spin" size={13} />
        {t('正在读取 Claude 环境…')}
      </div>
    )
  }
  if (props.resource.status === 'error') {
    if (settingsFormPage) {
      return (
        <SettingsNotice
          action={(
            <button onClick={() => void props.resource.reload({ refresh: true })} type="button">
              <RefreshCw size={11} />{t('重试')}
            </button>
          )}
          className="claude-renderer-resource-status"
          tone="error"
        >
          <span><AlertCircle size={13} />{props.resource.message}</span>
        </SettingsNotice>
      )
    }
    return (
      <div className="claude-renderer-resource-status error">
        <AlertCircle size={13} />
        <span>{props.resource.message}</span>
        <button onClick={() => void props.resource.reload({ refresh: true })} type="button">
          <RefreshCw size={11} />{t('重试')}
        </button>
      </div>
    )
  }
  const available = props.resource.value.cli.status === 'available'
  if (settingsFormPage) {
    return (
      <SettingsNotice
        action={(
          <button onClick={() => void props.resource.reload({ refresh: true })} type="button">
            <RefreshCw size={11} />{t('刷新')}
          </button>
        )}
        className="claude-renderer-resource-status"
        tone={available ? 'success' : 'error'}
      >
        <span>{available ? <Check size={13} /> : <AlertCircle size={13} />}
          {available ? t('已读取 Claude 环境') : props.resource.value.cli.message}
        </span>
      </SettingsNotice>
    )
  }
  return (
    <div className={`claude-renderer-resource-status ${available ? 'ready' : 'error'}`}>
      {available ? <Check size={13} /> : <AlertCircle size={13} />}
      <span>{available ? t('已读取 Claude 环境') : props.resource.value.cli.message}</span>
      <button onClick={() => void props.resource.reload({ refresh: true })} type="button">
        <RefreshCw size={11} />{t('刷新')}
      </button>
    </div>
  )
}

function SettingsSection(props: {
  readonly children: ReactNode
  readonly description: string
  readonly title: string
}): React.JSX.Element {
  if (useSettingsFormPage()) {
    return (
      <SettingsGroup>
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
      </header>
      {props.children}
    </section>
  )
}

interface ThreadSettingsDraft {
  readonly model: string
  readonly effort: string
  readonly permissionMode: string
}

function threadSettingsDraft(
  settings: DeepReadonly<ClaudeThreadSettings>
): ThreadSettingsDraft {
  return {
    model: settings.model || '',
    effort: settings.effort || '',
    permissionMode: settings.permissionMode || ''
  }
}

function threadSettingsUpdate(
  current: DeepReadonly<ClaudeThreadSettings>,
  draft: ThreadSettingsDraft
): ClaudeThreadSettingsUpdate {
  const model = draft.model.trim()
  const modelChanged = model !== (current.model || '')
  return {
    ...(modelChanged ? { model: model || null } : {}),
    ...(draft.effort !== (current.effort || '') &&
      !(modelChanged && draft.effort === '')
      ? { effort: (draft.effort || null) as ClaudeEffortLevel | null }
      : {}),
    ...(draft.permissionMode !== (current.permissionMode || '')
      ? { permissionMode: (draft.permissionMode || null) as ClaudePermissionMode | null }
      : {})
  }
}

/** Mirrors the creation contract: blank, or 1-512 characters without surrounding whitespace. */
function validModelIdentifier(value: string): boolean {
  return value === '' ||
    (value.length <= 512 && value === value.trim() && !value.includes('\0'))
}

function readyPresentation(
  resource: HarnessSettingsResource<ClaudeSettingsPresentationData>
): DeepReadonly<ClaudeSettingsPresentationData> | undefined {
  return resource.status === 'ready' ? resource.value : undefined
}

function cloneHarnessSettings(
  value: DeepReadonly<ClaudeHarnessSettings>
): ClaudeHarnessSettings {
  return {
    ...(value.useDefaultThreadSettings === false ? { useDefaultThreadSettings: false } : {}),
    threadSettings: cloneThreadRequest(value.threadSettings)
  }
}

function cloneThreadRequest(value: DeepReadonly<ClaudeThreadSettingsRequest>): ClaudeThreadSettingsRequest {
  return {
    ...(value.executablePath === undefined ? {} : { executablePath: value.executablePath }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.effort === undefined ? {} : { effort: value.effort }),
    ...(value.goalMode === undefined ? {} : { goalMode: value.goalMode }),
    ...(value.permissionMode === undefined ? {} : { permissionMode: value.permissionMode }),
    ...(value.allowedTools === undefined ? {} : { allowedTools: [...value.allowedTools] }),
    ...(value.disallowedTools === undefined ? {} : { disallowedTools: [...value.disallowedTools] })
  }
}

function availableEfforts(
  models: readonly DeepReadonly<ClaudeModelPresentation>[],
  model: string
): ClaudeEffortLevel[] {
  const selected = models.find((candidate) => candidate.value === model)
  return selected ? [...selected.supportedEfforts] : []
}

function compatibleClaudeEffort(
  models: readonly DeepReadonly<ClaudeModelPresentation>[],
  model: string,
  effort: string | undefined
): ClaudeEffortLevel | '' {
  if (!model || !effort) return ''
  const selected = models.find((candidate) => candidate.value === model)
  return selected?.supportedEfforts.includes(effort as ClaudeEffortLevel)
    ? effort as ClaudeEffortLevel
    : ''
}

function effortLabel(effort: ClaudeEffortLevel): string {
  if (effort === 'low') return 'Low'
  if (effort === 'medium') return 'Medium'
  if (effort === 'high') return 'High'
  if (effort === 'xhigh') return 'Extra high'
  return 'Maximum'
}
