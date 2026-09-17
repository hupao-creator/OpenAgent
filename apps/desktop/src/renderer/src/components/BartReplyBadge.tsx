import { useId } from 'react'
import './bart-reply.css'

export interface BartReplyBadgeProps {
  /** Bounded answer excerpt for assistive technology. */
  readonly excerpt: string
  /** Opens the Bart session at this answer. */
  readonly onOpen: () => void
}

/** Static unread reminder. Reading happens in the session, never on hover. */
export function BartReplyBadge({ excerpt, onOpen }: BartReplyBadgeProps): React.JSX.Element {
  const excerptId = useId()
  return (
    <div className="bart-role-stage bart-reply-stage">
      <button
        type="button"
        className="bart-reply-target"
        aria-label="打开 Bart 的最新答复"
        aria-describedby={excerptId}
        onClick={onOpen}
      >
        <span className="bart-reply-count" aria-hidden="true"><span>1</span></span>
      </button>
      <span className="bart-reply-excerpt" id={excerptId}>{excerpt}</span>
    </div>
  )
}
