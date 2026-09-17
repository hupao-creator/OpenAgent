import { lazy, Suspense } from 'react'
import { AlertCircle, Check, Circle, CircleStop, LoaderCircle } from 'lucide-react'
import { useI18n } from '@openagent/plugin-kit/renderer'

const MarkdownBody = lazy(() => import('@openagent/plugin-kit/renderer').then((m) => ({ default: m.MarkdownBody })))

export function Markdown(props: {
  readonly content: string
  readonly streaming: boolean
}): React.JSX.Element {
  return (
    <Suspense fallback={<div className="markdown-body markdown-fallback">{props.content}</div>}>
      <MarkdownBody content={props.content} streaming={props.streaming} />
    </Suspense>
  )
}

export function InlineError(props: { readonly message: string }): React.JSX.Element {
  return (
    <div className="claude-renderer-inline-error" role="alert">
      <AlertCircle size={13} />
      <span>{props.message}</span>
    </div>
  )
}

export function StateError(props: { readonly message: string }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="claude-renderer-state-error" role="alert">
      <AlertCircle size={18} />
      <span>
        <strong>{t('Claude Thread 状态不可用')}</strong>
        <small>{props.message}</small>
      </span>
    </div>
  )
}

export function StatusGlyph(props: { readonly status: string }): React.JSX.Element {
  if (props.status === 'running' || props.status === 'waiting') {
    return <LoaderCircle className="claude-renderer-spin" size={12} />
  }
  if (props.status === 'completed') return <Check size={12} />
  if (props.status === 'failed') return <AlertCircle size={12} />
  if (props.status === 'interrupted') return <CircleStop size={12} />
  return <Circle size={10} />
}
