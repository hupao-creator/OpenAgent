import { BartLogo } from './BartLogo'
import { useI18n } from '@openagent/plugin-kit/renderer'

interface ThreadFollowUpEntryProps {
  readonly threadId: string
  readonly threadTitle: string
  readonly onOpen: (threadId: string) => void
}

/** Historical card-edge affordance, now hosted by the provider-blind Core shell. */
export function ThreadFollowUpEntry(props: ThreadFollowUpEntryProps): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="thread-follow-up">
      <button
        aria-label={t('续写 {title}', { title: props.threadTitle })}
        className="thread-follow-up-entry"
        onClick={() => props.onOpen(props.threadId)}
        type="button"
      >
        <BartLogo size={14} />
      </button>
    </div>
  )
}
