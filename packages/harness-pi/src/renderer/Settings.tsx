import { useEffect, useId, useState } from 'react'
import type { HarnessSettingsProps, HarnessThreadSettingsProps, HarnessSettingsResource } from '@openagent/contracts/renderer'
import { isPublicExecutionActive } from '@openagent/contracts/renderer'
import {
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
  SettingsInput,
  SettingsSelect,
  SettingsCliStatus,
  SettingsUseDefaults,
  useI18n,
  useSettingsFormPage
} from '@openagent/plugin-kit/renderer'
import type { PiHarnessSettings as Settings, PiThreadOptions as ThreadSettings, PiThreadSettingsUpdate, PiSettingsPresentation } from '../shared/types.js'

function cliPresentation(resource: HarnessSettingsResource<PiSettingsPresentation>, t: (source: string) => string): {
  status: string; tone: 'info' | 'error' | 'success' | 'warning'
} {
  if (resource.status === 'loading') return { status: t('正在读取 Pi 环境…'), tone: 'info' }
  if (resource.status === 'error') return { status: resource.message, tone: 'error' }
  const cli = resource.value.cli
  if (cli.status === 'ready') return {
    status: [t('可用'), cli.version, cli.message].filter(Boolean).join(' · '), tone: 'success'
  }
  return { status: cli.message || t('不可用'), tone: 'warning' }
}

function ResourceStatus({ resource }: { resource: HarnessSettingsResource<PiSettingsPresentation> }): React.JSX.Element {
  const { t } = useI18n()
  const settingsFormPage = useSettingsFormPage()
  const [reloading, setReloading] = useState(false)
  // The presentation resource does not poll, so an unavailable or errored
  // environment needs an explicit retry once the user fixes the CLI. Reload
  // flips the resource to `loading`, so keep the action mounted while pending.
  const unavailable = resource.status === 'error' || (resource.status === 'ready' && resource.value.cli.status !== 'ready')
  // Ready environments stay silent, matching the other harness settings pages.
  if (settingsFormPage && !reloading && resource.status === 'ready' && resource.value.cli.status === 'ready') return <></>
  if (settingsFormPage && !reloading && resource.status === 'loading') return <></>
  const { status, tone } = cliPresentation(resource, t)
  const action = unavailable || reloading
    ? <button type="button" disabled={reloading} onClick={() => {
        setReloading(true)
        void resource.reload().finally(() => setReloading(false))
      }}>{reloading ? t('重试中…') : t('重试')}</button>
    : undefined
  return settingsFormPage
    ? <SettingsNotice tone={tone} action={action}>{status}</SettingsNotice>
    : <div role="status">{status}{action}</div>
}
const modelKey = (provider: string, id: string): string => `${provider}/${id}`
function Fields(props: { value: ThreadSettings; resource: HarnessSettingsResource<PiSettingsPresentation>; disabled?: boolean; change(value: ThreadSettings): void }): React.JSX.Element {
  const { t } = useI18n()
  const settingsFormPage = useSettingsFormPage()
  const id = useId()
  const models = props.resource.status === 'ready' ? props.resource.value.models : []
  const providers = [...new Set(models.map(m => m.provider))]
  const providerModels = models.filter(m => !props.value.provider || m.provider === props.value.provider)
  const selected = providerModels.find(m => m.id === props.value.model)
  const thinkingLevels = selected?.thinkingLevels || []
  // The option value carries the provider so two providers exposing the same
  // model id stay distinguishable; picking one sets provider and model together.
  const modelValue = selected ? modelKey(selected.provider, selected.id) : props.value.model || ''
  const provider = props.value.provider || ''
  const thinkingLevel = props.value.thinkingLevel || ''
  // A closed list cannot display a value it does not offer, so a provider or
  // model change drops the dependent picks instead of stranding them.
  const changeProvider = (next: string): void => {
    const keep = Boolean(next) && models.some(m => m.id === props.value.model && m.provider === next)
    props.change({ ...props.value, provider: next, model: keep ? props.value.model || '' : '', thinkingLevel: '' })
  }
  const changeModel = (key: string): void => {
    const chosen = models.find(m => modelKey(m.provider, m.id) === key)
    if (!chosen) {
      // "Native default", or a persisted value outside the catalog: only the id is known.
      props.change({ ...props.value, model: key, thinkingLevel: '' })
      return
    }
    props.change({
      ...props.value,
      provider: chosen.provider,
      model: chosen.id,
      thinkingLevel: (chosen.thinkingLevels || []).includes(thinkingLevel) ? thinkingLevel : ''
    })
  }
  if (settingsFormPage) {
    return <>
      <SettingsRow htmlFor={`${id}-provider`} label="Provider">
        <SettingsSelect id={`${id}-provider`} disabled={props.disabled} value={provider}
          onChange={e => changeProvider(e.target.value)}>
          <option value="">{t('Pi 原生默认')}</option>
          {provider && !providers.includes(provider)
            ? <option value={provider}>{provider} · {t('目录中不可用')}</option> : null}
          {providers.map(p => <option key={p} value={p}>{p}</option>)}
        </SettingsSelect>
      </SettingsRow>
      <SettingsRow htmlFor={`${id}-model`} label={t('模型')}>
        <SettingsSelect id={`${id}-model`} disabled={props.disabled} value={modelValue}
          onChange={e => changeModel(e.target.value)}>
          <option value="">{t('Pi 原生默认')}</option>
          {props.value.model && !selected
            ? <option value={modelValue}>{provider ? `${provider} · ` : ''}{props.value.model} · {t('目录中不可用')}</option> : null}
          {providerModels.map(m => <option key={modelKey(m.provider, m.id)} value={modelKey(m.provider, m.id)}>{m.provider} · {m.name}</option>)}
        </SettingsSelect>
      </SettingsRow>
      <SettingsRow htmlFor={`${id}-thinkingLevel`} label={t('推理强度')}>
        <SettingsSelect id={`${id}-thinkingLevel`} disabled={props.disabled} value={thinkingLevel}
          onChange={e => props.change({ ...props.value, thinkingLevel: e.target.value })}>
          <option value="">{t('Pi 原生默认')}</option>
          {thinkingLevel && !thinkingLevels.includes(thinkingLevel)
            ? <option value={thinkingLevel}>{thinkingLevel} · {t('目录中不可用')}</option> : null}
          {thinkingLevels.map(level => <option key={level} value={level}>{level}</option>)}
        </SettingsSelect>
      </SettingsRow>
    </>
  }
  const fields = [['provider', 'Provider'], ['model', 'Model'], ['thinkingLevel', 'Thinking level']] as const
  return <>{fields.map(([key, label]) => <SettingsRow key={key} htmlFor={`${id}-${key}`} label={label}>
    <SettingsInput id={`${id}-${key}`} disabled={props.disabled} value={props.value[key] || ''} placeholder={t('Pi 原生默认')}
      list={`${id}-${key}-choices`} onChange={e => props.change({ ...props.value, [key]: e.target.value })} />
    {key === 'provider' ? <datalist id={`${id}-${key}-choices`}>{providers.map(p => <option key={p} value={p} />)}</datalist> : null}
    {key === 'model' ? <datalist id={`${id}-${key}-choices`}>{providerModels.map(m => <option key={`${m.provider}/${m.id}`} value={m.id}>{m.provider} · {m.name}</option>)}</datalist> : null}
    {key === 'thinkingLevel' ? <datalist id={`${id}-${key}-choices`}>{thinkingLevels.map(level => <option key={level} value={level} />)}</datalist> : null}
  </SettingsRow>)}</>
}
export function PiThreadSettings(props: HarnessThreadSettingsProps<PiThreadSettingsUpdate, PiSettingsPresentation>): React.JSX.Element {
  const { t } = useI18n()
  const current = props.thread.settings as ThreadSettings
  const [value, setValue] = useState<ThreadSettings>(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => { setValue(current); setError(undefined) }, [props.thread.id, current])
  const active = isPublicExecutionActive(props.thread.observation)
  const changed = (['provider', 'model', 'thinkingLevel'] as const).filter(k => (value[k] || '') !== (current[k] || ''))
  return <div className="pi-settings"><ResourceStatus resource={props.resource} /><SettingsGroup title={t('Pi Thread 配置')}>
    <Fields value={value} resource={props.resource} disabled={active || busy} change={setValue} />
  </SettingsGroup>{error ? <div role="alert">{error}</div> : null}
    <button disabled={active || busy || !changed.length} onClick={() => {
      setBusy(true); setError(undefined)
      void props.update(Object.fromEntries(changed.map(k => [k, value[k]?.trim() || null])))
        .catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false))
    }}>{t('应用 Thread 配置')}</button>
  </div>
}
export function PiHarnessSettings(props: HarnessSettingsProps<Settings, PiSettingsPresentation>): React.JSX.Element {
  const { t } = useI18n()
  const useDefaults = props.value.useDefaultThreadSettings !== false
  // Going back to the Agent defaults clears the stored values so the page stops
  // showing knobs that would otherwise keep executing. The composition boundary
  // rejects an own key holding `undefined`, so the flag is dropped rather than
  // blanked.
  const changeUseDefaults = (next: boolean): void => {
    const { useDefaultThreadSettings: _dropped, ...settings } = props.value
    props.change({
      ...settings,
      ...(next ? {} : { useDefaultThreadSettings: false }),
      threadSettings: next ? {} : props.value.threadSettings
    })
  }
  return <div className="pi-settings">{props.section === 'cli'
    ? <SettingsCliStatus label="Pi" {...cliPresentation(props.resource, t)} />
    : <><ResourceStatus resource={props.resource} /><SettingsGroup><SettingsUseDefaults checked={useDefaults} onChange={changeUseDefaults}><Fields value={props.value.threadSettings} resource={props.resource} change={threadSettings => props.change({ ...props.value, threadSettings: Object.fromEntries(Object.entries(threadSettings).filter(([, v]) => v !== '')) })} /></SettingsUseDefaults></SettingsGroup></>}
  </div>
}
