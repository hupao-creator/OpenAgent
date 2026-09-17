import { isJsonValue, ThreadPublicObservationSchema, type AgentThreadRecord } from '@openagent/contracts'
import { createEmptyCodexState, decodeCodexState } from '../../../../../packages/harness-codex/src/shared/state'

/** Invented, Lab-owned Codex data. No IPC, model request or user snapshot. */
export function generationFixture(): AgentThreadRecord {
  const at = Date.now()
  const prompt = '为项目列表添加搜索，支持按名称与描述筛选，并保留清晰的空结果提示。'
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
    title: '为项目列表添加搜索', tags: [], cwd: '/demo/projects/OpenAgent',
    settings: { model: 'gpt-5.5', effort: 'high' }, sessionState: state,
    createdAt: at, updatedAt: at,
    observation: ThreadPublicObservationSchema.parse({
      latestExecution: { executionId: 'lab-generation-execution', startedAt: at,
        status: 'running' },
      backgroundWork: null
    })
  }
}
