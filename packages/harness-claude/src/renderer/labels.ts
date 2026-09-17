import { useI18n } from '@openagent/plugin-kit/renderer'
import { type ClaudeActivity, type ClaudeInteraction, type ClaudeTurn } from '../shared/state.js'
import { type ClaudePermissionMode } from '../shared/settings.js'

export type Translate = ReturnType<typeof useI18n>['t']

export const PERMISSION_MODE_LABELS: Record<ClaudePermissionMode, string> = {
  acceptEdits: '自动接受编辑',
  auto: '自动判断权限',
  manual: '按需询问',
  plan: 'Plan（只读规划）',
  bypassPermissions: '绕过所有权限',
  dontAsk: '不询问，未授权即拒绝'
}

export function activityKindLabel(kind: ClaudeActivity['kind'], t: Translate): string {
  const labels: Record<ClaudeActivity['kind'], string> = {
    tool: '工具',
    command: '命令',
    file: '文件',
    search: '搜索',
    thinking: '思考',
    agent: 'Agent',
    subagent: '子 Agent',
    task: '任务',
    hook: 'Hook',
    review: '审查'
  }
  return t(labels[kind])
}

export function activityStatusLabel(status: ClaudeActivity['status'], t: Translate): string {
  if (status === 'running') return t('运行中')
  if (status === 'completed') return t('已完成')
  if (status === 'failed') return t('失败')
  return t('已取消')
}

export function resolvedInteractionStatusLabel(
  status: Exclude<ClaudeInteraction['status'], 'pending'>,
  t: Translate
): string {
  if (status === 'allowed') return t('已允许')
  if (status === 'denied') return t('已拒绝')
  if (status === 'submitted') return t('已提交')
  if (status === 'cancelled') return t('已取消')
  return t('已处理')
}

export function turnStatusLabel(status: ClaudeTurn['status'], t: Translate): string {
  if (status === 'running') return t('正在工作')
  if (status === 'completed') return t('已完成')
  if (status === 'failed') return t('失败')
  return t('已中断')
}
