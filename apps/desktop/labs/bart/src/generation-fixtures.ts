import { isJsonValue, ThreadPublicObservationSchema, type AgentThreadRecord } from '@openagent/contracts'
import { createEmptyCodexState, decodeCodexState } from '../../../../../packages/harness-codex/src/shared/state'

/** Invented, Lab-owned Codex data. No IPC, model request or user snapshot. */
export type GenerationSample = 'short' | 'long' | 'english'
export function generationFixture(sample: GenerationSample = 'short'): AgentThreadRecord {
  const at = Date.now()
  const prompt = sample === 'long'
    ? '为项目列表添加搜索，支持按名称与描述筛选。输入时保留当前选中项；没有结果时，给出清晰的空状态提示。\n\n再检查中文、英文与混合输入的体验，确保搜索结果稳定、键盘操作流畅。'
    : sample === 'english'
      ? 'Add search to the project list. Match names and descriptions, keep the selection stable, and show a helpful message when nothing matches.'
      : '为项目列表添加搜索，支持按名称与描述筛选，并保留清晰的空结果提示。'
  const state = decodeCodexState({
    ...createEmptyCodexState(at),
    turns: [{
      executionId: 'lab-generation-execution', createdAt: at, updatedAt: at,
      status: 'running',
      messages: [{ id: 'lab-prompt', role: 'user', kind: 'prompt', content: prompt,
        createdAt: at, attachments: [] }],
      answer: '', reasoning: '', activities: [], notices: [], timeline: [], interactions: [], plan: []
    }]
  })
  if (!isJsonValue(state)) throw new Error('Lab fixture must be JSON')
  return {
    id: 'lab-generation-thread', harnessId: 'codex', revision: 1, archived: false,
    title: sample === 'english' ? 'Add search to the project list' : '为项目列表添加搜索', tags: [], cwd: '/demo/projects/OpenAgent',
    settings: { model: 'gpt-5.5', effort: 'high' }, sessionState: state,
    createdAt: at, updatedAt: at,
    observation: ThreadPublicObservationSchema.parse({
      latestExecution: { executionId: 'lab-generation-execution', startedAt: at,
        status: 'running' },
      backgroundWork: null
    })
  }
}
