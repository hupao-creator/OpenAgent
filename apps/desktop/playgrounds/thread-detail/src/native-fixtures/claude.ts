import { localConversation } from './local-conversation'
import { toPublicClaudeInteraction } from '../../../../../../packages/harness-claude/src/shared/public-interactions'
import { isJsonValue } from '@openagent/contracts'
import type {
  ClaudeActivity,
  ClaudeInteraction,
  ClaudeThreadState,
  ClaudeTimelineItem,
  ClaudeTurn
} from '../../../../../../packages/harness-claude/src/shared/state'
import { activities, attachment, plan, prompt } from '../fixtures'
import type { NativePreviewFixture, NativePreviewInput } from './types'

const STARTED_AT = Date.UTC(2026, 8, 7, 6, 30)
/** Real Claude renderer data. No transport or command is invoked by the preview. */
export function createClaudePreview(input: NativePreviewInput): NativePreviewFixture {
  const turnCount = input.phase === 'empty' ? 0 : input.history ? 160 : 1
  const turns = input.localFive ? localConversation.map((entry, index): ClaudeTurn => {
    const executionId = `local-five-${index}`
    const createdAt = Date.parse(entry.createdAt)
    const finishedAt = Date.parse(entry.completedAt)
    return {
      executionId, createdAt, updatedAt: finishedAt, finishedAt, status: 'completed',
      prompts: [entry.prompt], promptAttachments: [[]],
      text: entry.answer, reasoning: '', plan: [], activities: [], interactions: [], notices: [],
      timeline: [
        { id: `${executionId}:user`, kind: 'user-message', promptIndex: 0, createdAt },
        { id: `${executionId}:answer`, kind: 'assistant', content: entry.answer, status: 'complete', createdAt: finishedAt }
      ]
    }
  }) : Array.from({ length: turnCount }, (_, index) => createTurn(
    index,
    index === turnCount - 1 ? input.phase : 'completed',
    index === turnCount - 1 ? input.answer : `第 ${index + 1} 轮已完成。搜索和筛选沿用相同的页面布局。`
  ))
  const latestTurn = turns.at(-1)
  const state: ClaudeThreadState = {
    version: 1,
    ...(latestTurn ? { primarySessionId: 'claude-preview-session' } : {}),
    turns,
    nativeNotifications: [],
    runtime: {
      model: '示例模型 B',
      cwd: '/workspace/OpenAgent',
      permissionMode: '按需询问',
      ...(input.phase === 'background' ? {
        backgroundTasks: [{
          id: 'claude-preview-background',
          type: 'agent',
          description: '检查页面在窄屏下的布局',
          status: 'running'
        }]
      } : {})
    }
  }
  if (!isJsonValue(state)) throw new Error('Claude preview state must be JSON')
  if (!latestTurn) {
    return { sessionState: state, observation: { latestExecution: null, backgroundWork: null } }
  }
  const execution = {
    executionId: latestTurn.executionId,
    startedAt: latestTurn.createdAt
  }
  const pending = latestTurn.interactions.find((interaction) => interaction.status === 'pending')
  return {
    sessionState: state,
    observation: {
      latestExecution: pending ? {
        ...execution,
        status: 'waiting-for-user',
        interactions: [toPublicClaudeInteraction(latestTurn.executionId, pending)]
      } : input.phase === 'running' ? {
        ...execution,
        status: 'running'
      } : {
        ...execution,
        status: input.phase === 'failed' ? 'failed'
          : input.phase === 'interrupted' ? 'interrupted' : 'completed',
        finishedAt: latestTurn.finishedAt!,
        ...(latestTurn.error ? { error: latestTurn.error } : {})
      },
      backgroundWork: input.phase === 'background' ? { status: 'running' } : null
    }
  }
}

function createTurn(index: number, phase: NativePreviewInput['phase'], answer: string): ClaudeTurn {
  const id = `claude-preview-execution-${index}`
  const createdAt = STARTED_AT + index * 60_000
  const waiting = phase === 'approval' || phase === 'question'
  const running = phase === 'running'
  const status = waiting || running ? 'running'
    : phase === 'failed' ? 'failed'
      : phase === 'interrupted' ? 'interrupted' : 'completed'
  const tools: ClaudeActivity[] = activities.map((activity, toolIndex) => ({
    id: `${id}:activity:${toolIndex}`,
    kind: activity.kind === 'terminal' ? 'command'
      : activity.kind === 'search' ? 'search'
        : activity.kind === 'edit' ? 'file' : 'tool',
    label: activity.label,
    detail: activity.detail,
    status: toolIndex === activities.length - 1
      ? phase === 'failed' ? 'failed'
        : phase === 'interrupted' ? 'cancelled'
          : running ? 'running' : 'completed'
      : 'completed'
  }))
  const steps: ClaudeTurn['plan'] = plan.map((step, stepIndex) => ({
    step,
    status: (running || waiting || phase === 'failed' || phase === 'interrupted') && stepIndex === plan.length - 1
      ? 'inProgress' : 'completed'
  }))
  const interaction: ClaudeInteraction | undefined = phase === 'approval' ? {
    id: `${id}:permission`,
    kind: 'permission',
    title: '允许安装项目依赖？',
    description: '需要连接包服务，安装这个项目所需的依赖。',
    toolName: 'Bash',
    input: { command: 'pnpm install', cwd: '/workspace/OpenAgent' },
    canRemember: false,
    status: 'pending'
  } : phase === 'question' ? {
    id: `${id}:question`,
    kind: 'question',
    title: '搜索需要覆盖哪些内容？',
    description: '确认搜索范围后，我会继续完成筛选逻辑。',
    status: 'pending',
    questions: [{
      question: '选择搜索范围',
      multiSelect: false,
      options: [{
        label: '仅项目名称',
        description: '匹配更精确，列表结果更容易预期。'
      }, {
        label: '项目名称和描述',
        description: '覆盖更多内容，适合用关键词查找。'
      }]
    }]
  } : undefined
  const finalText = waiting ? '' : answer
  const timeline: ClaudeTimelineItem[] = [{
    id: `${id}:prompt`, kind: 'user-message', createdAt, promptIndex: 0,
    checkpointId: `${id}:checkpoint`
  }, {
    id: `${id}:reasoning`, kind: 'reasoning', createdAt: createdAt + 1_000,
    content: '先检查现有列表与 URL 状态，再补充搜索、筛选和键盘操作。'
  }, {
    id: `${id}:commentary`, kind: 'assistant', createdAt: createdAt + 2_000,
    content: '已找到项目列表的入口，正在沿用已有的搜索组件。', status: 'complete'
  }, {
    id: `${id}:plan`, kind: 'plan', createdAt: createdAt + 3_000, plan: steps
  }, ...tools.map((activity, toolIndex): ClaudeTimelineItem => ({
    id: `${id}:tool:${toolIndex}`, kind: 'activity', createdAt: createdAt + 4_000 + toolIndex * 1_000,
    activity
  }))]
  if (interaction) {
    timeline.push({ id: `${id}:request`, kind: 'interaction', createdAt: createdAt + 10_000, interaction })
  }
  if (finalText) {
    timeline.push({
      id: `${id}:answer`, kind: 'assistant', createdAt: createdAt + 11_000, content: finalText,
      status: running ? 'streaming' : phase === 'failed' ? 'failed'
        : phase === 'interrupted' ? 'cancelled' : 'complete'
    })
  }
  const error = phase === 'failed' ? '依赖服务暂时不可用，请稍后重试。已有修改和回复已保留。' : undefined
  if (error) timeline.push({ id: `${id}:error`, kind: 'error', createdAt: createdAt + 12_000, message: error })
  return {
    executionId: id, createdAt, updatedAt: createdAt + 18_000,
    ...(status !== 'running' ? { finishedAt: createdAt + 18_000 } : {}),
    prompts: [index === 0 ? prompt : `继续第 ${index + 1} 轮检查。`],
    promptAttachments: [[{
      id: `${id}:attachment`, name: attachment.name, mimeType: 'text/markdown',
      size: 256, kind: 'file'
    }]],
    text: finalText, reasoning: '', status, plan: steps, activities: tools,
    interactions: interaction ? [interaction] : [], notices: [], timeline,
    ...(error ? { error } : {}),
    ...(status === 'completed' ? { usage: { inputTokens: 1240, cachedTokens: 100, cacheWriteTokens: 60, outputTokens: 860, reasoningTokens: 40 } } : {})
  }
}
