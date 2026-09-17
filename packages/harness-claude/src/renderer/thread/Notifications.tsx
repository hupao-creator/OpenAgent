import { Bell, ListTodo } from 'lucide-react'
import { useI18n, useThreadDetailVisibility } from '@openagent/plugin-kit/renderer'
import type { ClaudeBackgroundTask, ClaudeThreadState } from '../../shared/state.js'

export function ClaudeNotifications(props: {
  readonly notifications: ClaudeThreadState['nativeNotifications']
}): React.JSX.Element | null {
  const { t } = useI18n()
  const visibility = useThreadDetailVisibility()
  if (!visibility.work) return null
  const visible = props.notifications.slice(-12)
  return (
    <details className="claude-renderer-notifications">
      <summary>
        <Bell size={12} />
        {t('原生通知 · {count}', { count: props.notifications.length })}
      </summary>
      <ul>
        {visible.map((notification, index) => (
          <li key={`${index}:${notification.summary}`}>
            <span>{notification.summary}</span>
            {notification.status ? <small>{notification.status}</small> : null}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Native Session status remains visible after the owning foreground turn ends. */
export function ClaudeBackgroundTasks(props: {
  readonly tasks: readonly ClaudeBackgroundTask[]
}): React.JSX.Element | null {
  const { t } = useI18n()
  const visibility = useThreadDetailVisibility()
  if (!visibility.work) return null
  return (
    <details className="claude-renderer-notifications">
      <summary><ListTodo size={12} />{t('后台任务')}</summary>
      <ul>
        {props.tasks.map(task => (
          <li key={task.id}>
            <span>{task.description}</span>
            <small>{task.status}</small>
          </li>
        ))}
      </ul>
    </details>
  )
}
