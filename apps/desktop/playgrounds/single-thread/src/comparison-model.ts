import type { DeepReadonly, HarnessThreadRecord, PublicInteraction } from '@openagent/contracts'
import { decodeCodexState, latestCodexTurn } from '../../../../../packages/harness-codex/src/shared/state'
import { currentClaudeTurn, parseClaudeThreadState } from '../../../../../packages/harness-claude/src/shared/state'

export type ComparisonStatus = 'running' | 'question' | 'permission' | 'completed' | 'failed' | 'interrupted' | 'idle' | 'background'

export interface ComparisonCardModel {
  status: ComparisonStatus
  label: string
  headline: string
  detail?: string
  action: string
  background: boolean
  interaction?: PublicInteraction
  plan: readonly { readonly step: string; readonly status: string }[]
}

/** Lab-only adapter: both designs read the same frozen Harness fixture. */
export function comparisonCardModel(thread: DeepReadonly<HarnessThreadRecord>): ComparisonCardModel {
  const execution = thread.observation.latestExecution
  const background = thread.observation.backgroundWork?.status === 'running'
  const plan = thread.harnessId === 'codex'
    ? latestCodexTurn(decodeCodexState(thread.sessionState))?.plan ?? []
    : thread.harnessId === 'claude'
      ? currentClaudeTurn(parseClaudeThreadState(thread.sessionState))?.plan ?? []
      : []
  const base = { background, plan }
  if (execution?.status === 'waiting-for-user') {
    const interaction = execution.interactions[0]!
    const permission = interaction.kind === 'permission'
    return { ...base, interaction, status: permission ? 'permission' : 'question',
      label: permission ? '需要授权' : '等你回答',
      headline: interaction.title, detail: permission ? interaction.description : undefined,
      action: permission ? '处理授权' : '回答问题' }
  }
  if (execution?.status === 'failed') return { ...base, status: 'failed', label: '执行失败',
    headline: execution.error || '这次执行遇到了问题', detail: '打开执行记录，查看失败原因。', action: '查看错误' }
  if (execution?.status === 'interrupted') return { ...base, status: 'interrupted', label: '已停止',
    headline: '本轮执行已停止', detail: execution.summary || '查看已有记录，再决定下一步。', action: '查看记录' }
  if (execution?.status === 'running') {
    const current = plan.find(step => step.status === 'inProgress')
    const next = current ? plan[plan.indexOf(current) + 1] : undefined
    return { ...base, status: 'running', label: '运行中', headline: current ? `正在${current.step}` : '正在执行任务',
      detail: execution.summary || (next ? `下一步 · ${next.step}` : undefined), action: '查看进展' }
  }
  if (background) return { ...base, status: 'background', label: '后台运行中',
    headline: '后台工作仍在继续', detail: execution?.summary, action: '查看后台任务' }
  if (execution?.status === 'completed') return { ...base, status: 'completed', label: '本轮已完成',
    headline: execution.summary || '本轮执行已结束', action: '查看结果' }
  return { ...base, status: 'idle', label: '尚未开始', headline: '等待第一条指令',
    detail: '描述你希望完成的事情。', action: '开始对话' }
}
