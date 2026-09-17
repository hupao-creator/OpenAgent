import {
  createContext, useContext, useId, type ComponentPropsWithRef, type ReactNode
} from 'react'
import { useI18n } from '../../i18n.js'
import './settings-form.css'

const SettingsFormContext = createContext(false)
/** Marks the settings page; shared plugin fields can retain their thread presentation. */
export function SettingsFormScope({ children }: { children: ReactNode }): React.JSX.Element {
  return <SettingsFormContext.Provider value>{children}</SettingsFormContext.Provider>
}
export function useSettingsFormPage(): boolean { return useContext(SettingsFormContext) }

export function SettingsGroup({ title, description, action, children, className = '' }: {
  title?: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string
}): React.JSX.Element {
  return <section className={`sf-group ${className}`}>
    {(title || description || action) && <header className="sf-group-heading">
      <div>{title && <h3>{title}</h3>}{description && <p>{description}</p>}</div>
      {action && <div className="sf-group-action">{action}</div>}
    </header>}
    <div className="sf-group-content">{children}</div>
  </section>
}

type FieldContextValue = { id: string; describedBy?: string; invalid?: boolean }
const FieldContext = createContext<FieldContextValue | undefined>(undefined)
export function SettingsRow({ label, description, error, htmlFor, layout = 'inline', children, className = '' }: {
  label: ReactNode; description?: ReactNode; error?: ReactNode; htmlFor?: string;
  layout?: 'inline' | 'stacked'; children: ReactNode; className?: string
}): React.JSX.Element {
  const generatedId = useId()
  const { t } = useI18n()
  const id = htmlFor ?? `setting-${generatedId}`
  const describedBy = [description ? `${id}-description` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined
  return <div className={`sf-row sf-row-${layout} ${className}`}>
    <div className="sf-row-copy"><label htmlFor={id} id={`${id}-label`}>{label}</label>
      {description && <button type="button" className="sf-row-hint"
        aria-label={t('说明')} aria-describedby={`${id}-label ${id}-description`} />}
      {description && <p className="sf-row-description" id={`${id}-description`}>{description}</p>}
    </div>
    <div className="sf-row-control"><FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error) }}>
      {children}
    </FieldContext.Provider>
      {error && <p className="sf-error" id={`${id}-error`} role="alert">{error}</p>}
    </div>
  </div>
}
function useFieldProps(props: { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: ComponentPropsWithRef<'input'>['aria-invalid'] }) {
  const field = useContext(FieldContext)
  return {
    id: props.id ?? field?.id,
    'aria-describedby': [props['aria-describedby'], field?.describedBy].filter(Boolean).join(' ') || undefined,
    'aria-invalid': props['aria-invalid'] ?? (field?.invalid || undefined)
  }
}
export function SettingsInput({ className = '', ...props }: ComponentPropsWithRef<'input'>): React.JSX.Element {
  const field = useFieldProps(props)
  return <input {...props} {...field} className={`sf-input ${className}`} />
}
export function SettingsSelect({ className = '', onKeyDown, ...props }: ComponentPropsWithRef<'select'>): React.JSX.Element {
  const field = useFieldProps(props)
  return <select {...props} {...field} className={`sf-select ${className}`} onKeyDown={(event) => {
    onKeyDown?.(event)
    // Let the browser dismiss the picker before Escape can close the settings page.
    if (event.key === 'Escape' && event.currentTarget.matches(':open')) event.stopPropagation()
  }} />
}
export function SettingsTextarea({ className = '', ...props }: ComponentPropsWithRef<'textarea'>): React.JSX.Element {
  const field = useFieldProps(props)
  return <textarea {...props} {...field} className={`sf-textarea ${className}`} />
}
export function SettingsToggle({ className = '', ...props }: Omit<ComponentPropsWithRef<'input'>, 'type'>): React.JSX.Element {
  const field = useFieldProps(props)
  return <input {...props} {...field} type="checkbox" role="switch" className={`sf-toggle ${className}`} />
}
/**
 * The 使用默认配置 switch for a Harness's Thread defaults. The Agent's own
 * defaults stay in effect while it is on, so an untouched Harness shows no
 * empty knobs whose executed values the page would otherwise have to explain;
 * the fields appear once the user opts out of them.
 */
export function SettingsUseDefaults({ checked, disabled, onChange, children }: {
  checked: boolean; disabled?: boolean; onChange(useDefaults: boolean): void; children: ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const id = useId()
  return <>
    <SettingsRow description={t('关闭后可自定义新建 Thread 使用的配置。')}
      htmlFor={id} label={t('使用默认配置')}>
      <SettingsToggle checked={checked} disabled={disabled} id={id}
        onChange={(event) => onChange(event.currentTarget.checked)} />
    </SettingsRow>
    {checked ? null : children}
  </>
}
export function SettingsNotice({ children, tone = 'info', action, className = '' }: {
  children: ReactNode; tone?: 'info' | 'error' | 'warning' | 'success'; action?: ReactNode; className?: string
}): React.JSX.Element {
  return <div className={`sf-notice sf-notice-${tone} ${className}`} role={tone === 'error' ? 'alert' : 'status'}>
    <div>{children}</div>{action}
  </div>
}
/**
 * CLI availability for the settings page. The host owns discovery and always
 * auto-detects, so this reports status and nothing else: there is no path to
 * configure, and showing the resolved one would only invite the user to pin a
 * location the Agent is going to ignore.
 */
export function SettingsCliStatus({ label, status, tone = 'info', error }: {
  label?: ReactNode; status: ReactNode;
  tone?: 'info' | 'error' | 'warning' | 'success'; error?: ReactNode
}): React.JSX.Element {
  return <div className="sf-executable">
    {label && <p className="sf-cli-label">{label}</p>}
    <SettingsNotice tone={tone}>{status}</SettingsNotice>
    {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
  </div>
}
