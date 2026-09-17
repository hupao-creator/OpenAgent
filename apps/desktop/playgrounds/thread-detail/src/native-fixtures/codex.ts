import { localConversation } from './local-conversation'
import { toPublicInteraction } from '../../../../../../packages/harness-codex/src/shared/public-interactions'
import { isJsonValue, type ThreadPublicObservation } from '@openagent/contracts'
import type {
  CodexHarnessState,
  CodexInteraction,
  CodexTimelineItem,
  CodexTurn
} from '../../../../../../packages/harness-codex/src/shared/types'
import type { NativePreviewFixture, NativePreviewInput } from './types'

const BASE_AT = Date.parse('2026-09-07T06:32:00Z')

/** Native presentation data only; the preview host owns simulated responses and transitions. */
export function createCodexPreview(input: NativePreviewInput): NativePreviewFixture {
  const count = input.phase === 'empty' ? 0 : input.history ? 160 : 1
  const turns = input.localFive ? localConversation.map((entry, index): CodexTurn => {
    const executionId = `local-five-${index}`
    const createdAt = Date.parse(entry.createdAt)
    const finishedAt = Date.parse(entry.completedAt)
    return {
      executionId, createdAt, updatedAt: finishedAt, finishedAt, status: 'completed',
      messages: [{ id: `${executionId}:prompt`, role: 'user', kind: 'prompt', content: entry.prompt, createdAt, attachments: [] }],
      timeline: [
        { id: `${executionId}:user`, kind: 'user-message', messageId: `${executionId}:prompt`, createdAt },
        { id: `${executionId}:answer`, kind: 'assistant', itemId: `${executionId}:answer`, content: entry.answer, status: 'complete', createdAt: finishedAt }
      ],
      answer: entry.answer, reasoning: '', plan: [], activities: [], interactions: [], notices: []
    }
  }) : Array.from({ length: count }, (_, index) => createTurn({
    ...input,
    phase: index === count - 1 ? input.phase : 'completed',
    answer: index === count - 1 ? input.answer :
      `已完成第 ${index + 1} 轮调整。搜索与筛选保持独立，项目列表会保留当前选择。`
  }, index, BASE_AT - (count - index - 1) * 120_000))
  const latest = turns.at(-1)
  const state: CodexHarnessState = {
    schema: 'openagent.harness.codex.thread.v1',
    primarySessionId: 'codex-preview-native-session',
    updatedAt: latest?.updatedAt ?? BASE_AT,
    turns,
    backgroundTerminals: input.phase === 'background' ? [{
      id: `${latest!.executionId}:verify`,
      command: 'pnpm dev',
      cwd: '/workspace/OpenAgent'
    }] : []
  }
  if (!isJsonValue(state)) throw new Error('Codex preview state must be JSON')
  return {
    sessionState: state,
    observation: {
      latestExecution: latest ? executionObservation(latest) : null,
      backgroundWork: input.phase === 'background' ? { status: 'running' } : null
    }
  }
}

function createTurn(input: NativePreviewInput, index: number, createdAt: number): CodexTurn {
  const executionId = `codex-preview-execution-${index}`
  const id = (value: string): string => `${executionId}:${value}`
  const waiting = input.phase === 'approval' || input.phase === 'question'
  const complete = input.phase === 'completed' || input.phase === 'background'
  const status: CodexTurn['status'] = waiting ? 'waiting-input'
    : input.phase === 'running' ? 'running'
      : input.phase === 'failed' ? 'failed'
        : input.phase === 'interrupted' ? 'interrupted' : 'completed'
  const interaction = input.phase === 'approval' ? approval(id('approval'))
    : input.phase === 'question' ? question(id('question')) : undefined
  const updatedAt = createdAt + 52_000
  const answerStatus = input.phase === 'running' ? 'streaming'
    : input.phase === 'failed' ? 'failed'
      : input.phase === 'interrupted' ? 'cancelled' : 'complete'
  const timeline: CodexTimelineItem[] = [
    { id: id('user-row'), kind: 'user-message', messageId: id('prompt'), createdAt },
    {
      id: id('commentary-row'), kind: 'assistant', itemId: id('commentary'), createdAt: createdAt + 1_000,
      content: '我会先确认项目列表的数据来源，再把搜索与状态筛选接到现有视图。',
      status: 'complete'
    },
    {
      id: id('reasoning-row'), kind: 'reasoning', createdAt: createdAt + 2_000,
      content: '筛选应与项目选择状态分开，并提供清晰的空结果提示。'
    },
    { id: id('plan-row'), kind: 'plan', createdAt: createdAt + 3_000 },
    { id: id('search-row'), kind: 'activity', activityId: id('search'), createdAt: createdAt + 4_000 },
    { id: id('read-row'), kind: 'activity', activityId: id('read'), createdAt: createdAt + 5_000 },
    { id: id('verify-row'), kind: 'activity', activityId: id('verify'), createdAt: createdAt + 6_000 },
    { id: id('answer-row'), kind: 'assistant', itemId: id('answer'), content: input.answer, status: answerStatus, createdAt: createdAt + 7_000 }
  ]
  if (interaction) timeline.push({
    id: id('interaction-row'), kind: 'interaction', interactionId: interaction.id,
    createdAt: createdAt + 8_000
  })
  if (complete) timeline.push({ id: id('diff-row'), kind: 'diff', createdAt: createdAt + 9_000 })
  if (input.phase === 'failed') timeline.push({
    id: id('error-row'), kind: 'error', createdAt: createdAt + 9_000
  })
  return {
    executionId,
    createdAt,
    updatedAt,
    ...(['completed', 'failed', 'interrupted'].includes(status) ? { finishedAt: updatedAt } : {}),
    status,
    runtimeModel: '示例模型 A',
    messages: [{
      id: id('prompt'),
      role: 'user',
      kind: 'prompt',
      content: '为项目列表添加搜索与筛选，并保持现有项目卡片的布局。',
      createdAt,
      attachments: [{
        id: id('attachment'), name: '项目列表参考.png', mimeType: 'image/png',
        size: 82_000, kind: 'image'
      }]
    }],
    timeline,
    answer: input.answer,
    reasoning: '筛选应与项目选择状态分开，并提供清晰的空结果提示。',
    plan: [
      { step: '确认项目列表的数据与组件结构', status: 'completed' },
      { step: '加入搜索与状态筛选', status: complete ? 'completed' : 'inProgress' },
      { step: '检查空结果与窄屏布局', status: complete ? 'completed' : 'pending' }
    ],
    activities: [
      { id: id('search'), kind: 'search', label: '查找项目列表入口', status: 'completed', detail: 'rg ProjectList apps/desktop/src' },
      { id: id('read'), kind: 'file', label: '阅读项目列表组件', status: 'completed', detail: 'apps/desktop/src/renderer/src/components/ProjectList.tsx' },
      {
        id: id('verify'), kind: 'command', label: input.phase === 'background' ? '开发服务' : '检查类型',
        status: input.phase === 'running' || input.phase === 'background' ? 'running'
          : input.phase === 'failed' ? 'failed'
            : input.phase === 'interrupted' ? 'cancelled' : 'completed',
        detail: input.phase === 'background' ? 'pnpm dev' : 'pnpm typecheck'
      }
    ],
    interactions: interaction ? [interaction] : [],
    notices: [],
    ...(complete ? {
      usage: { inputTokens: 2840, cachedInputTokens: 1024, outputTokens: 840 },
      diff: 'diff --git a/ProjectList.tsx b/ProjectList.tsx\n+ const visibleProjects = filterProjects(projects, query, status)\n+ <ProjectSearch value={query} onChange={setQuery} />'
    } : {}),
    ...(input.phase === 'failed' ? { error: '依赖服务连接超时。可以保留当前改动后重试。' } : {})
  }
}

function approval(id: string): CodexInteraction {
  return {
    id,
    kind: 'command-approval',
    title: '允许安装项目依赖？',
    detail: 'pnpm install',
    blocksTurn: true,
    status: 'pending',
    actions: [
      { id: 'allow-once', intent: 'allow', label: '允许一次' },
      { id: 'allow-session', intent: 'allow', label: '本会话始终允许' },
      { id: 'deny', intent: 'deny', label: '拒绝' },
      { id: 'cancel', intent: 'cancel', label: '取消' }
    ],
    questions: []
  }
}

function question(id: string): CodexInteraction {
  return {
    id,
    kind: 'user-input',
    title: '搜索需要覆盖哪些内容？',
    detail: '这会决定用户输入关键词时的匹配范围。',
    blocksTurn: true,
    status: 'pending',
    actions: [
      { id: 'submit', intent: 'submit', label: '提交' },
      { id: 'cancel', intent: 'cancel', label: '取消' }
    ],
    questions: [{
      id: `${id}:scope`,
      prompt: '选择搜索范围',
      secret: false,
      allowOther: true,
      options: [
        { id: 'name', label: '仅项目名称', description: '匹配更精确，列表结果更容易预期。' },
        { id: 'name-description', label: '项目名称和描述', description: '覆盖更多内容，适合用关键词查找。' }
      ]
    }]
  }
}

function executionObservation(turn: CodexTurn): ThreadPublicObservation['latestExecution'] {
  const base = { executionId: turn.executionId, startedAt: turn.createdAt }
  if (turn.status === 'waiting-input') return {
    ...base, status: 'waiting-for-user', interactions: turn.interactions.map(toPublicInteraction)
  }
  if (turn.status === 'running') return { ...base, status: 'running' }
  return {
    ...base, status: turn.status, finishedAt: turn.finishedAt!,
    ...(turn.error ? { error: turn.error } : {})
  }
}
