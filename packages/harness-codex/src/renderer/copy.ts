type Translate = (source: string) => string

/** Localize Plugin-normalized actions without changing the submitted native id. */
export function codexActionLabel(
  action: { readonly id: string; readonly label: string },
  t: Translate
): string {
  if (action.id === 'allow-once') return t('允许一次')
  if (action.id === 'allow-session') return t('本会话始终允许')
  if (action.id === 'deny') return t('拒绝')
  if (action.id === 'cancel') return t('取消')
  if (action.id === 'submit') return t('提交')
  return action.label
}

/** Preserve native model ids; only localize the Plugin-authored empty fallback. */
export function codexModelLabel(model: string, t: Translate): string {
  return model === '未知模型' ? t(model) : model
}

/** A running turn may carry an app-server status label; native labels stay verbatim. */
export function codexStatusLabel(
  status: string,
  label: string,
  t: Translate
): string {
  return status === 'running' && label !== '运行中' ? label : t(label)
}
