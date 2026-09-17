import type { ComponentPropsWithRef } from 'react'
import { AlertCircle, Check, Download, LoaderCircle } from 'lucide-react'
import type { HarnessId } from '../../../shared/harnesses'
import { harnessLogoSource } from '../harness-composition'

export type HarnessIconState = 'checking' | 'installed' | 'missing' | 'installing' | 'error'

/**
 * Shared icon plate for every Harness picker in the settings page. Callers own
 * the accessible name and the interaction.
 *
 * `showStatus` is the install surface's corner badge, where the plate itself is
 * how a user installs and retries. A picker that only chooses among Agents that
 * are already present leaves it off: the same mark on twelve plates is noise,
 * and there it would claim a status the click does not act on.
 */
export function HarnessIconButton({ harnessId, state, showStatus, className = '', ...props }: {
  readonly harnessId: HarnessId
  readonly state: HarnessIconState
  readonly showStatus?: boolean
} & ComponentPropsWithRef<'button'>): React.JSX.Element {
  return <button
    {...props}
    className={`harness-icon${className ? ` ${className}` : ''}`}
    data-agent={harnessId}
    data-state={state}
    type="button"
  >
    <img src={harnessLogoSource(harnessId)} alt="" draggable={false} />
    {showStatus && <span className="harness-icon-badge" aria-hidden="true">
      {state === 'checking' || state === 'installing'
        ? <LoaderCircle className="spin" size={11} />
        : state === 'installed' ? <Check size={10} strokeWidth={3} />
          : state === 'missing' ? <Download size={11} /> : <AlertCircle size={11} />}
    </span>}
  </button>
}
