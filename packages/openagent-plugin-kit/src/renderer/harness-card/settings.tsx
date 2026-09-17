import { Check, LoaderCircle, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useI18n } from '../i18n.js'

/** Presentation only: the owning Plugin resolves CLI health; the host auto-detects it. */
export function HarnessExecutableSetting(props: {
  readonly name: string
  readonly logoSource: string
  readonly loading: boolean
  readonly available: boolean
  readonly status: string
  readonly error?: string
  readonly children?: ReactNode
  readonly onReload: () => Promise<void>
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="cli-setting-group">
      <div className="cli-setting">
        <span className="cli-mark" aria-hidden="true">
          <img alt="" className="provider-logo" src={props.logoSource} />
        </span>
        <span className="cli-setting-copy">
          <strong>{props.name}</strong>
          <small className={props.available ? 'available' : 'missing'} role="status" title={props.status}>
            {props.loading ? <LoaderCircle className="spin" size={11} /> : props.available ? <Check size={11} /> : null}
            {props.status}
          </small>
        </span>
        <button
          aria-label={t('刷新 {name} 环境', { name: props.name })}
          className="icon-button cli-setting-refresh"
          disabled={props.loading}
          onClick={() => void props.onReload()}
          type="button"
        ><RefreshCw size={12} /></button>
      </div>
      {props.error ? <p className="settings-error" role="alert">{props.error}</p> : null}
      {props.children}
    </div>
  )
}
