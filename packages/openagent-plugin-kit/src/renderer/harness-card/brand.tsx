import { useEffect, useRef, useState } from 'react'
import { useThreadCardAnchor } from './spatial-anchors.js'
import type { ThreadCardTerminalStatus } from './status.js'

/**
 * Historical card-corner brand unit without a Core provider registry. The
 * Plugin supplies its own static asset and label; failure falls back to a
 * stable inline glyph so a broken image never remains on the card.
 */
export function ThreadCardProviderStatus(props: {
  readonly logoSource: string
  readonly label: string
  readonly brandKey: string
  readonly statusClassName?: string
  readonly terminal?: ThreadCardTerminalStatus
}): React.JSX.Element {
  const anchorRef = useThreadCardAnchor('status')
  return (
    <span
      ref={anchorRef}
      className={`thread-provider-status ${props.statusClassName ?? ''}`.trim()}
      data-provider={props.brandKey}
      data-terminal={props.terminal}
      tabIndex={0}
      title={props.label}
    >
      <span
        className="thread-provider-logo"
        role="img"
        aria-label={props.label}
        title={props.label}
      >
        {props.terminal ? <svg key={`ring-${props.terminal}`} className="thread-card-terminal-ring" viewBox="0 0 44 44" fill="none" aria-hidden="true">
          <circle className="thread-card-terminal-track" cx="22" cy="22" r="19" stroke="currentColor" strokeWidth="1.25" />
          <circle className="thread-card-terminal-signal" cx="22" cy="22" r="19" pathLength="1" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg> : null}
        <ThreadCardBrandLogo key={props.logoSource} {...props} />
        {props.terminal ? <span key={`symbol-${props.terminal}`} className="thread-card-terminal-symbol" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path pathLength="1" d={props.terminal === 'failed' ? 'm4 4 8 8m0-8-8 8' : props.terminal === 'interrupted' ? 'M5 4v8M11 4v8' : 'm3 8 3.2 3.2L13 4.5'} />
          </svg>
        </span> : null}
      </span>
    </span>
  )
}

function ThreadCardBrandLogo(props: {
  readonly logoSource: string
  readonly label: string
  readonly brandKey: string
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    const image = imageRef.current
    if (image && image.complete && image.naturalWidth === 0) setFailed(true)
  }, [])

  if (failed) {
    return (
      <span className="provider-logo-fallback" aria-label={props.label} role="img">
        <svg
          width="0.9em"
          height="0.9em"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2.5" y="4" width="19" height="14" rx="2.5" />
          <path d="M6.5 9.5h6M6.5 13h3.5" />
          <path d="M14.5 12.5l2.5 2 2.5-2" />
        </svg>
      </span>
    )
  }
  return (
    <img
      ref={imageRef}
      className={`provider-logo provider-logo-${props.brandKey}`}
      data-provider={props.brandKey}
      src={props.logoSource}
      alt=""
      aria-hidden="true"
      onError={() => setFailed(true)}
    />
  )
}
