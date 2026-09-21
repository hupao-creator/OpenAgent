import { memo, useEffect, useState } from 'react'
import { useI18n } from '../i18n.js'

const RollingDigit = memo(function RollingDigit({ value }: { readonly value: string }) {
  const [frame, setFrame] = useState({ current: value, previous: value })
  if (frame.current !== value) setFrame({ current: value, previous: frame.current })
  return <span className="thread-card-rolling-digit">
    <span key={frame.current} className="thread-card-rolling-digit-frame" data-changed={frame.current !== frame.previous}>
      {frame.current !== frame.previous ? <span className="thread-card-rolling-digit-old">{frame.previous}</span> : null}
      <span className="thread-card-rolling-digit-new">{frame.current}</span>
    </span>
  </span>
})

/** Both metrics use the same numeric cells; only changed digits move, always upward. */
export const RollingNumberText = memo(function RollingNumberText(props: {
  readonly value: string
  readonly clock?: boolean
  readonly dimColon?: boolean
  readonly ticking?: boolean
}): React.JSX.Element {
  return <span className="thread-card-rolling-number" aria-label={props.value}
    data-clock={props.clock || undefined} data-ticking={props.ticking || undefined} data-colon-dim={props.dimColon || undefined}>
    <span aria-hidden="true">{Array.from(props.value, (character, index) => {
      const key = props.value.length - index
      return character >= '0' && character <= '9' ? <RollingDigit key={key} value={character} />
        : <span key={key} className={props.clock && character === ':' ? 'thread-card-clock-colon' : 'thread-card-rolling-character'}>{character}</span>
    })}</span>
  </span>
})

export function ThreadCardRuntime(props: {
  readonly startedAt: number
  readonly endedAt?: number
}): React.JSX.Element {
  const { t } = useI18n()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (props.endedAt !== undefined) return
    let timer: ReturnType<typeof setTimeout>
    const tick = (): void => {
      const current = Date.now()
      setNow(current)
      const elapsed = Math.max(0, current - props.startedAt)
      timer = setTimeout(tick, 1_000 - elapsed % 1_000)
    }
    tick()
    return () => clearTimeout(timer)
  }, [props.startedAt, props.endedAt])
  const seconds = Math.floor(Math.max(0, (props.endedAt ?? now) - props.startedAt) / 1_000)
  const clock = [Math.floor(seconds / 3_600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':')
  const ticking = props.endedAt === undefined
  const label = t('用时：{duration}', { duration: clock })
  return <span className="thread-card-runtime" title={label} aria-label={label} tabIndex={0}>
    <RollingNumberText value={clock} clock ticking={ticking} dimColon={ticking && seconds % 2 === 1} />
  </span>
}
