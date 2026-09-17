import { isJsonValue, type AgentThreadRecord } from '@openagent/contracts'
import { createInitialRendererState } from '../../../src/shared/renderer-state'
import { createDefaultOpenAgentSettings } from '../../../src/shared/openagent-settings'
import type { RendererAppState } from '../../../src/shared/renderer-state-contracts'
import { fakeSnapshots } from '../../single-thread/src/fake-snapshots'
import { parseSnapshot } from '../../single-thread/src/snapshots'
import { decodeCodexState } from '../../../../../packages/harness-codex/src/shared/state'

const at = 1_789_000_000_000 // 冻结快照共用的时间基点，仅保证先后顺序有意义
const cwd = '/demo/bart-transition'

export const BART_THREAD_ID = 'fake-bart'

const titles = ['梳理搜索交互', '实现项目筛选', '验证键盘导航', '检查空结果提示', '补齐筛选测试', '整理交付说明']
const casts = [
  { harness: 'claude', scenario: 'running' },
  { harness: 'codex', scenario: 'question' },
  { harness: 'codex', scenario: 'completed' },
  { harness: 'claude', scenario: 'completed' },
  { harness: 'codex', scenario: 'running' },
  { harness: 'codex', scenario: 'running' }
] as const

/** 复用 Single Thread Lab 的冻结快照，仅改公共身份字段。
 *  改写逻辑与 overview-motion scenarios.ts 的 sampleThread 同形；出现第三个使用方时再提取共享 helper。 */
function agentThread(index: number): AgentThreadRecord {
  const cast = casts[index % casts.length]!
  const fixture = fakeSnapshots.find(({ harness, scenario }) => harness === cast.harness && scenario === cast.scenario)!
  const thread = fixture.state.threads[0]!
  if (thread.bart) throw new Error('Playground fixtures must contain an Agent Thread')
  return { ...thread, id: `fake-thread-${index + 1}`, title: `${String(index + 1).padStart(2, '0')} · ${titles[index % titles.length]}`,
    createdAt: at + index, archived: false, tags: ['模拟'], cwd }
}

function bartThread(): RendererAppState['threads'][number] {
  const fixture = fakeSnapshots.find(({ harness, scenario }) => harness === 'codex' && scenario === 'completed')!
  const session = decodeCodexState(fixture.state.threads[0]!.sessionState)
  const answer = '## 六个会话，一条线索\n\n我把工作区里的进展整理在这里。已完成的工作、待确认的决定，以及正在推进的任务，都可以沿着这条会话继续追踪。\n\n### 已完成\n\n键盘导航和空结果提示已验证，搜索交互的基础路径已跑通。\n\n### 正在推进\n\n交互梳理、筛选测试和交付说明还在进行。项目筛选正在等待范围确认。\n\n下一步：确认筛选范围，再汇总测试结果和交付说明。'
  const sessionState = {
    ...session,
    turns: session.turns.map((turn) => ({
      ...turn, answer,
      timeline: [{ id: 'fake-bart-answer', itemId: 'fake-bart-answer', kind: 'assistant' as const, content: answer, status: 'complete' as const, createdAt: at + 1000 }]
    }))
  }
  if (!isJsonValue(sessionState)) throw new Error('Playground Bart session must be JSON')
  return {
    id: BART_THREAD_ID,
    bart: true,
    harnessId: 'codex',
    revision: 1,
    sessionState,
    observation: { latestExecution: null, backgroundWork: null },
    title: 'Bart',
    tags: [],
    cwd,
    settings: {},
    transcript: [
      { type: 'message', id: 'fake-bart-user-1', role: 'user', content: '帮我把 overview 里正在跑的会话整理成一条周报草稿。', createdAt: at, status: 'complete' },
      { type: 'message', id: 'fake-bart-assistant-1', role: 'assistant', content: '好的，我看了 6 个会话：3 个在跑、1 个在等确认、2 个已完成。周报草稿稍后放到这里。', createdAt: at + 1000, status: 'complete' }
    ],
    createdAt: at,
    updatedAt: at + 2000
  }
}

export function createFakeRendererState(): RendererAppState {
  const threads: RendererAppState['threads'] = [bartThread(), ...Array.from({ length: 6 }, (_, index) => agentThread(index))]
  const executions = threads.filter((thread): thread is AgentThreadRecord => !thread.bart)
    .flatMap((thread) => {
      const execution = thread.observation.latestExecution
      return execution && (execution.status === 'running' || execution.status === 'waiting-for-user')
        ? [{ threadId: thread.id, executionId: execution.executionId, status: 'running' as const, startedAt: execution.startedAt }]
        : []
    })
  const state: RendererAppState = {
    ...createInitialRendererState(cwd),
    revision: 1,
    threads,
    executions,
    reports: [],
    selectedThreadId: null,
    settings: createDefaultOpenAgentSettings()
  }
  return parseSnapshot(state)
}
