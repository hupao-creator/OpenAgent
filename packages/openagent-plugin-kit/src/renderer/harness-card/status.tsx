import { CircleDashed, CircleX, MessageCircle, Pause, ShieldCheck } from 'lucide-react'
import type { ThreadPublicObservation } from '@openagent/contracts'
import { useI18n } from '../i18n.js'
import { ThreadCardProviderStatus } from './brand.js'

export type ThreadCardTerminalStatus = 'completed' | 'interrupted' | 'failed'

/** Public execution and background facts share one status precedence across Harnesses. */
export function threadCardStatus(observation: ThreadPublicObservation) {
  const execution = observation.latestExecution
  const background = observation.backgroundWork?.status === 'running'
  const secondary = background ? '后台仍在运行' : undefined
  if (execution?.status === 'waiting-for-user') {
    const question = execution.interactions.some(item => item.kind === 'question')
    const permission = execution.interactions.some(item => item.kind === 'permission')
    return { kind: 'attention', label: question && permission ? '需要你处理' : question ? '等你回答' : permission ? '等你授权' : '等待你的响应',
      Icon: question ? MessageCircle : ShieldCheck, secondary }
  }
  if (execution?.status === 'failed' || execution?.status === 'interrupted') {
    return { kind: execution.status, label: execution.status === 'failed' ? '执行失败' : '已中断',
      Icon: execution.status === 'failed' ? CircleX : Pause, secondary,
      terminal: background ? undefined : execution.status }
  }
  if (execution?.status === 'running' || background) {
    return { kind: 'running', label: execution?.status === 'running' ? '运行中' : '后台运行中', secondary }
  }
  if (execution?.status === 'completed') {
    return { kind: 'completed', label: '已完成', terminal: 'completed' as const }
  }
  return { kind: 'idle', label: '等待开始', Icon: CircleDashed }
}

export function ThreadCardStatus(props: {
  readonly observation: ThreadPublicObservation
  readonly brandKey: string
  readonly label: string
  readonly logoSource: string
  readonly className?: string
}): React.JSX.Element {
  const { t } = useI18n()
  const status = threadCardStatus(props.observation)
  const label = t(status.label)
  const Icon = status.Icon
  return <>
    <ThreadCardProviderStatus brandKey={props.brandKey} logoSource={props.logoSource}
      label={`${props.label} · ${label}${status.secondary ? ` · ${t(status.secondary)}` : ''}`}
      statusClassName={[props.className, status.kind].filter(Boolean).join(' ')} terminal={status.terminal} />
    {status.terminal || status.kind === 'running' ? null :
      <span className="thread-card-task-state" data-tone={status.kind} role="status">
        <span className="thread-card-task-state-primary">{Icon ? <Icon size={14} aria-hidden="true" /> : null}<span>{label}</span></span>
        {status.secondary ? <span className="thread-card-task-state-secondary">{t(status.secondary)}</span> : null}
      </span>}
  </>
}
