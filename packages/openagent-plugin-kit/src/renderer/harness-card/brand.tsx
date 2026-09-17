import { useEffect, useRef, useState } from 'react'
import { useThreadCardAnchor } from './spatial-anchors.js'

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
}): React.JSX.Element {
  const anchorRef = useThreadCardAnchor('status')
  return (
    <span
      ref={anchorRef}
      className={`thread-provider-status ${props.statusClassName ?? ''}`.trim()}
      data-provider={props.brandKey}
    >
      <span
        className="thread-provider-logo"
        role="img"
        aria-label={props.label}
        title={props.label}
      >
        <ThreadCardBrandLogo {...props} />
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
