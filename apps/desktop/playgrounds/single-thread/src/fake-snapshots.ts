import { isJsonValue, ThreadPublicObservationSchema, type AgentThreadRecord, type PublicInteraction } from '@openagent/contracts'
import { createInitialRendererState } from '../../../src/shared/renderer-state'
import { emptyClaudeThreadState, parseClaudeThreadState, type ClaudeInteraction, type ClaudeThreadState } from '../../../../../packages/harness-claude/src/shared/state'
import { toPublicClaudeInteraction } from '../../../../../packages/harness-claude/src/shared/public-interactions'
import { createEmptyCodexState, decodeCodexState } from '../../../../../packages/harness-codex/src/shared/state'
import type { CodexInteraction, CodexHarnessState } from '../../../../../packages/harness-codex/src/shared/types'
import { toPublicInteraction } from '../../../../../packages/harness-codex/src/shared/public-interactions'
import { agentScenarios, combinations, harnesses, reportScenarios } from './scenarios'
import { parseSnapshot } from './snapshots'

const at = 1_789_000_000_000
const cwd = '/demo/search-project'
const prompt = '为项目列表实现搜索功能'
const question = '搜索需要覆盖哪些内容？'
const options = [{ id: 'name', label: '项目名称' }, { id: 'description', label: '名称与描述' }]
const actions = [{ id: 'allow-once', intent: 'allow', label: '允许一次' }, { id: 'deny', intent: 'deny', label: '拒绝' }] as const

/** Lab-only authored data. Never derive fixtures from a user's captured session. */
function fakeThread(harness: string, scenario: string, suffix = ''): AgentThreadRecord {
  const id = `fake-${harness}-${scenario}${suffix}`
  const executionId = `${id}-execution`
  const background = scenario.startsWith('background')
  const phase = scenario === 'background' ? 'completed' : scenario.replace('background-', '')
  const waiting = phase === 'question' || phase === 'approval'
  const status: 'running' | 'completed' | 'failed' | 'interrupted' = phase === 'failed' || phase === 'interrupted' || phase === 'completed' ? phase : 'running'
  const terminal = status !== 'running'
  const title = phase === 'question' ? question : '允许执行搜索测试？'
  const interactionId = `${id}-interaction`
  const common = {
    executionId, createdAt: at, updatedAt: at + 1000, status,
    usage: { inputTokens: 11_000, outputTokens: 1_800 },
    ...(terminal ? { finishedAt: at + 1000 } : {}),
    ...(phase === 'failed' ? { error: '模拟错误：搜索测试未通过，请检查查询条件。' } : {}),
    reasoning: '', plan: [{ step: '确认搜索范围', status: 'completed' as const },
      { step: '实现搜索', status: terminal ? 'completed' as const : 'inProgress' as const },
      { step: '验证结果', status: terminal ? 'completed' as const : 'pending' as const }],
    activities: [], notices: [], timeline: []
  }
  const answer = phase === 'completed' ? '搜索功能已完成，支持按项目名称与描述筛选。' : ''
  const messages = [{ id: `${id}-message`, role: 'user' as const, kind: 'prompt' as const,
    content: prompt, createdAt: at, status: 'complete' as const, attachments: [] }]
  let session: unknown
  let publicInteraction: PublicInteraction | undefined
  if (harness === 'claude') {
    const interaction: ClaudeInteraction = { id: interactionId, kind: phase === 'question' ? 'question' : 'permission',
      title, status: 'pending', ...(phase === 'question' ? { questions: [{ question, header: '搜索范围', multiSelect: false, options: options.map(({ label }) => ({ label })) }] }
        : { toolName: 'Bash', input: { command: 'pnpm test search' } }) }
    if (waiting) publicInteraction = toPublicClaudeInteraction(executionId, interaction)
    const value: ClaudeThreadState = { ...emptyClaudeThreadState(), turns: phase === 'empty' ? [] : [{ ...common,
      prompts: [prompt], promptAttachments: [[]], text: answer, interactions: waiting ? [interaction] : [] }],
      ...(background ? { runtime: { backgroundTasks: [{ id: 'fake-background', type: 'local_bash', description: '运行搜索回归测试', status: 'running' }] } } : {}) }
    session = parseClaudeThreadState(value)
  } else if (harness === 'codex') {
    const interaction: CodexInteraction = { id: interactionId, kind: phase === 'question' ? 'user-input' : 'command-approval',
      title, detail: 'pnpm test search', blocksTurn: true, status: 'pending',
      actions: phase === 'question' ? [{ id: 'submit', intent: 'submit', label: '提交' }] : actions,
      questions: phase === 'question' ? [{ id: 'scope', prompt: question, secret: false, allowOther: true, options }] : [] }
    if (waiting) publicInteraction = toPublicInteraction(interaction)
    const value: CodexHarnessState = { ...createEmptyCodexState(at + 1000), turns: phase === 'empty' ? [] : [{ ...common, messages: messages.map(({ status: _status, ...message }) => message), answer, interactions: waiting ? [interaction] : [] }],
      backgroundTerminals: background ? [{ id: 'fake-background', command: 'pnpm test search', cwd }] : [] }
    try { session = decodeCodexState(value) } catch { throw new Error(`Invalid fake Codex scenario: ${scenario}`) }
  }
  if (!isJsonValue(session)) throw new Error('Fake session must be JSON')
  return { id, harnessId: harness, revision: 1, archived: false, title: prompt, tags: ['模拟'], cwd,
    settings: {}, sessionState: session, createdAt: at, updatedAt: at + 1000,
    observation: ThreadPublicObservationSchema.parse({ latestExecution: phase === 'empty' ? null : {
      executionId, startedAt: at, status: waiting ? 'waiting-for-user' : status,
      ...(terminal ? { finishedAt: at + 1000 } : {}),
      ...(publicInteraction ? { interactions: [publicInteraction] } : {}),
      ...(answer ? { summary: answer } : {}),
      ...(phase === 'failed' ? { error: '模拟错误：搜索测试未通过。' } : {})
    }, backgroundWork: background ? { status: 'running' } : null }) }
}

function fakeCase(harness: string, scenario: string) {
  const state = { ...createInitialRendererState(cwd) }
  state.revision = 1
  let threadId: string
  if (harness === 'report') {
    const threads = Array.from({ length: scenario === 'overflow' ? 6 : 1 }, (_, i) => fakeThread(harnesses[i % harnesses.length]!.id, 'completed', `-${i}`))
    state.threads = scenario === 'empty' || scenario === 'missing' ? [] : threads
    threadId = `fake-report-${scenario}`
    state.reports = [{ id: threadId, title: scenario === 'overflow' ? '搜索功能、权限交互与跨 Harness 回归验证完整交付报告' : '搜索功能交付报告',
      tags: ['模拟'], relatedExecutions: scenario === 'empty' ? [] : threads.map(t => ({ threadId: t.id, executionId: t.observation.latestExecution!.executionId })),
      createdAt: at, updatedAt: at + 1000, archived: scenario === 'archived',
      previewText: scenario === 'empty' ? '' : '搜索功能已完成，已验证项目名称与描述筛选、空结果和权限交互。'.repeat(scenario === 'overflow' ? 12 : 1) }]
  } else {
    const thread = fakeThread(harness, scenario)
    state.threads = [thread]
    threadId = thread.id
    if (thread.observation.latestExecution?.status === 'running' || thread.observation.latestExecution?.status === 'waiting-for-user') state.executions = [{ threadId, executionId: thread.observation.latestExecution.executionId, status: 'running', startedAt: at }]
  }
  state.selectedThreadId = threadId
  return { harness, scenario, threadId, snapshot: `fake-${harness}-${scenario}`, state: parseSnapshot(state) }
}

export const fakeSnapshots = [
  ...harnesses.flatMap(h => [...agentScenarios, ...combinations].map(s => fakeCase(h.id, s.id))),
  ...reportScenarios.map(s => fakeCase('report', s.id))
]
