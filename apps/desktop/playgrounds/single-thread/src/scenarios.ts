import { z } from 'zod'
export const harnesses = [
  { id: 'codex', label: 'Codex' }, { id: 'claude', label: 'Claude Code' }
] as const
export const agentScenarios = [
  { id: 'completed', label: '已完成' }, { id: 'running', label: '运行中' },
  { id: 'approval', label: '等待授权' }, { id: 'question', label: '等待回答' },
  { id: 'background', label: '后台任务' }, { id: 'failed', label: '失败' },
  { id: 'interrupted', label: '已停止' }, { id: 'empty', label: '空任务' }
] as const
export const combinations = [
  { id: 'background-running', label: '后台任务 + 运行中' },
  { id: 'background-approval', label: '后台任务 + 等待授权' },
  { id: 'background-question', label: '后台任务 + 等待回答' },
  { id: 'background-interrupted', label: '后台任务 + 已停止' },
  { id: 'background-failed', label: '后台任务 + 失败' }
] as const
export const reportScenarios = [
  { id: 'summary', label: '正文 + 关联任务' }, { id: 'empty', label: '空预览 / 无关联' },
  { id: 'overflow', label: '长内容 / 关联溢出' }, { id: 'missing', label: '关联已删除' },
  { id: 'archived', label: '已归档' }
] as const
export interface CapturedCase {
  harness: string
  scenario: string
  threadId: string
  snapshot: string
}
export interface ScenarioCatalog { cases: CapturedCase[] }

/** Catalog data is local input, not a trusted selector or URL. */
export function parseScenarioCatalog(value: unknown): ScenarioCatalog {
  const catalog = z.object({ cases: z.array(z.object({
    harness: z.enum(['codex', 'claude', 'report']),
    scenario: z.string().min(1), threadId: z.string().min(1),
    snapshot: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict()) }).strict().parse(value)
  const keys = new Set<string>()
  for (const item of catalog.cases) {
    const allowed = item.harness === 'report' ? reportScenarios : [...agentScenarios, ...combinations]
    const key = `${item.harness}/${item.scenario}`
    if (!allowed.some(({ id }) => id === item.scenario) || keys.has(key)) throw new Error('场景目录包含未知或重复场景')
    keys.add(key)
  }
  return catalog
}
