import type { ReasoningStreamStyle } from '../../../src/renderer/src/bart-motion/reasoning-geometry'
import type { InteractionQuestionSpec } from '@openagent/plugin-kit/renderer'
import type { HarnessBartActivity } from '@openagent/contracts/renderer'
import type { BartDockInteractionRequest, BartDockReply, BartDockThreadFollowUpTarget } from '../../../src/renderer/src/components/BartDock'
import type { BartDraftAttachment } from '../../../src/shared/attachments'
import { bartReplyReadKey } from '../../../src/renderer/src/bart-reply-read-state'

const LAB_EXECUTION_ID = 'bart-lab-execution'
const LAB_REPLY_EXCERPT = '已经修好了。预览现在会监听实际保存的目录，保存后即可看到更新。我也检查了新增、修改和删除文件后的刷新效果，三种情况都正常。改动只涉及预览监听路径，其他页面的行为保持不变。'
const LAB_REASONING: Record<string, string> = {
  reasoning: '先确认 Dock 的锚点没有被装饰移动，再把锁定的弧线和蓝点接上，最后检查窄窗口',
  'reasoning-en': 'Checking the current evidence retrieval approach',
  'reasoning-mixed': '先确认 Harness 的 reasoning delta，再检查最新消息的 Unicode 🧠 边界',
  'reasoning-short': '检查调用链'
}

/**
 * Local stand-in for the harness-provided foreground projection. Production
 * derives this from native events; the Lab pins one snapshot per state.
 */
export function residentActivityFor(config: LabConfig): HarnessBartActivity | null {
  if (config.scene !== 'resident') return null
  if (LAB_REASONING[config.variant]) return {
    kind: 'reasoning',
    text: LAB_REASONING[config.variant],
    sequence: 1,
    executionId: LAB_EXECUTION_ID
  }
  if (config.variant === 'tool' || config.variant === 'tool-long') return {
    kind: 'tool-call',
    callId: `bart-lab-call-${config.variant}`,
    toolName: config.variant === 'tool' ? 'read_file' : 'mcp__github__create_issue',
    sequence: 2,
    executionId: LAB_EXECUTION_ID
  }
  return null
}

/**
 * One completed final answer. Production derives this from the Harness
 * projection; the Lab pins one identity per replay so the read lifecycle can be
 * replayed without clearing browser storage.
 */
export function residentReplyFor(config: LabConfig): BartDockReply | null {
  if (config.scene !== 'resident' || config.variant !== 'reply') return null
  const id = `bart-lab-reply-${config.replay}`
  return {
    id,
    readKey: bartReplyReadKey('bart-lab-thread', 'codex', id),
    excerpt: LAB_REPLY_EXCERPT,
    executionId: LAB_EXECUTION_ID
  }
}

/**
 * Each draft is a list of short lines so the rendered row count is the list
 * length, not whatever the capsule's width happens to wrap to.
 */
const LAB_INPUT_DRAFTS: Record<string, readonly string[]> = {
  filled: ['帮我整理一下下一步。'],
  'multiline-1': ['帮我整理下一步。'],
  'multiline-3': ['先看布局。', '再看动效。', '最后检查窄窗口。'],
  'multiline-5': ['先看布局。', '再看动效。', '最后检查窄窗口。', '别忘了输入态。', '还有附件那一行。'],
  'multiline-6': ['先看布局。', '再看动效。', '最后检查窄窗口。', '别忘了输入态。', '还有附件那一行。', '第六行应该被上限截住。'],
  attachments: ['帮我看下这几个文件。']
}

export function inputDraftFor(config: LabConfig): string {
  if (config.scene !== 'input') return ''
  return (LAB_INPUT_DRAFTS[config.variant] ?? []).join('\n')
}

/** The Dock's other inline composer: continuing an existing Thread, not a new message. */
export function threadFollowUpFor(config: LabConfig): BartDockThreadFollowUpTarget | undefined {
  if (config.scene !== 'input' || config.variant !== 'follow-up') return undefined
  return {
    threadId: 'bart-lab-thread', threadTitle: '预览监听的保存目录',
    provider: 'claude', initialDraft: '', requestKey: config.replay
  }
}

export function inputAttachmentsFor(config: LabConfig): BartDraftAttachment[] {
  if (config.scene !== 'input' || config.variant !== 'attachments') return []
  return [
    {
      id: 'bart-lab-image',
      status: 'ready',
      attachment: {
        id: 'bart-lab-image', path: '/tmp/bart-lab-preview.png', name: '预览截图.png',
        mimeType: 'image/png', size: 486_400, kind: 'image'
      }
    },
    { id: 'bart-lab-doc', status: 'pending', name: '设计说明.pdf', size: 1_248_576, mimeType: 'application/pdf' },
    { id: 'bart-lab-failed', status: 'failed', name: '会议录音.m4a', error: '读取失败' }
  ]
}

export const scenes = [
  { id: 'resident', label: '常驻', english: 'Resident', description: '等待、思考，以及工作的反馈。', hint: '切换右侧状态，观察 Bart 的表情和动作。' },
  { id: 'launch', label: '发起任务', english: 'Input → Running', description: '输入框化为一个光点，三点接上运行。', hint: '按 Enter 或点击发送：输入框收缩成中间光点，左右两点随后出现。重放回到输入态，慢放可检查动作衔接。' },
  { id: 'running', label: '运行中兜底', english: 'Running', description: '三拍接力，环绕一圈，再回到底部。', hint: 'Bart 先向下注意光点，目光跟着绕行，回到底部后轻眨一下，恢复自然。' },
  { id: 'cadence', label: '展示节奏', english: 'Cadence', description: '快速发生，从容呈现。', hint: '调整展示时间与输入速度，观察哪些瞬时活动被自然吸收。设为 0ms 可对照即时切换。' },
  { id: 'input', label: '输入', english: 'Input', description: '编辑消息，查看输入与提交后的变化。', hint: '在 Bart 中输入内容，按 Enter 或点击箭头提交。' },
  { id: 'question', label: 'Question', english: 'Question', description: '选择或填写答案，然后继续。', hint: '直接选择或填写答案；提交后可重放当前场景。' },
  { id: 'permission', label: 'Permission', english: 'Permission', description: '查看请求，决定允许或拒绝。', hint: '允许或拒绝请求，观察 Bart 的结果反馈。' }
] as const

export type Scene = typeof scenes[number]['id']
export const reasoningStreamStyles = [
  { id: 'direct', label: 'A · 即时追加', description: '逐段出现，保留输入节奏' },
  { id: 'glide', label: 'B · 顺滑推进', description: '文字沿圆弧平滑移动' },
  { id: 'soft', label: 'C · 柔和显露', description: '平滑推进，新字依次淡入' }
] as const
export const variants = {
  launch: [['send', '正常速度', 'Send'], ['slow', '慢放 · 0.35×', 'Slow motion']],
  running: [['bottom', '原版 · 彩虹环绕', 'Rainbow orbit']],
  cadence: [
    ['burst', '快速交替', 'Burst'], ['reasoning-stream', '连续思考', 'Reasoning stream'],
    ['tool-stream', '连续工具', 'Tool stream'], ['finish', '快速完成', 'Finish'],
    ['recovery', '输入接管后恢复', 'Recovery']
  ],
  resident: [
    ['idle', '待机', 'Idle'], ['running', '运行中', 'Running'], ['reasoning', '思考', 'Reasoning'],
    ['reasoning-live', '思考 · 流式', 'Reasoning · Live'],
    ['reasoning-en', '思考 · 英文', 'Reasoning · English'],
    ['reasoning-mixed', '思考 · 混合', 'Reasoning · Mixed'],
    ['reasoning-short', '思考 · 短文本', 'Reasoning · Short'],
    ['tool', '工具调用', 'Tool call'],
    ['tool-long', '长工具名', 'Long tool name'], ['working', '工作中', 'Working'],
    ['error', '失败', 'Error'],
    ['reply', '最终答复', 'Final reply']
  ],
  input: [
    ['empty', '空白输入', 'Empty'], ['filled', '预填内容', 'Draft'],
    ['multiline-1', '单行草稿', 'One line'],
    ['multiline-3', '三行草稿', 'Three lines'],
    ['multiline-5', '五行草稿', 'Five lines'],
    ['multiline-6', '六行草稿 · 超上限', 'Six lines · over cap'],
    ['attachments', '带附件', 'With attachments'],
    ['follow-up', 'Thread 续写', 'Thread follow-up'],
    ['disabled', '输入禁用', 'Disabled']
  ],
  question: [['single', '单选', 'Single choice'], ['multiple', '多选', 'Multiple choice'], ['text', '自由输入', 'Free text'], ['steps', '连续提问', 'Multi-step']],
  permission: [['file', '修改文件', 'File change'], ['command', '运行命令', 'Run command']]
} as const

export interface LabConfig {
  scene: Scene
  variant: string
  replay: number
  guides: boolean
  minimumMs: number
  reasoningMs: number
  eventMs: number
  reasoningLength: number
  reasoningTilt: number
  reasoningGaze: boolean
  reasoningStreamPaused: boolean
  reasoningStreamSpeed: number
  reasoningStreamBursts: boolean
  reasoningStreamStyle: ReasoningStreamStyle
  runningIdle: boolean
  runningPaused: boolean
  runningCycle: number
}

export const initialConfig: LabConfig = {
  scene: 'resident', variant: 'idle', replay: 0, guides: false,
  minimumMs: 800, reasoningMs: 150, eventMs: 80,
  reasoningLength: 200, reasoningTilt: -20, reasoningGaze: true,
  reasoningStreamPaused: false, reasoningStreamSpeed: 1, reasoningStreamBursts: false, reasoningStreamStyle: 'glide',
  runningIdle: false, runningPaused: false, runningCycle: 2.8
}

export interface LabEvent {
  title: string
  detail: string
  payload?: unknown
}

export type PreviewMessage =
  | { source: 'bart-preview'; type: 'ready' }
  | { source: 'bart-preview'; type: 'event'; event: LabEvent }
  | { source: 'bart-preview'; type: 'scene'; scene: Scene }

export interface ConfigMessage {
  source: 'bart-lab'
  type: 'configure'
  config: LabConfig
}

export function validConfig(value: unknown): value is LabConfig {
  if (!value || typeof value !== 'object') return false
  const config = value as Partial<LabConfig>
  return scenes.some((scene) => scene.id === config.scene)
    && variants[config.scene!].some(([id]) => id === config.variant)
    && Number.isSafeInteger(config.replay) && config.replay! >= 0
    && typeof config.guides === 'boolean'
    && Number.isFinite(config.minimumMs) && config.minimumMs! >= 0 && config.minimumMs! <= 2000
    && Number.isFinite(config.reasoningMs) && config.reasoningMs! >= 0 && config.reasoningMs! <= 500
    && Number.isFinite(config.eventMs) && config.eventMs! >= 20 && config.eventMs! <= 1000
    && Number.isFinite(config.reasoningLength) && config.reasoningLength! >= 60 && config.reasoningLength! <= 200
    && Number.isFinite(config.reasoningTilt) && config.reasoningTilt! >= -45 && config.reasoningTilt! <= 45
    && typeof config.reasoningGaze === 'boolean'
    && typeof config.reasoningStreamPaused === 'boolean'
    && typeof config.reasoningStreamBursts === 'boolean'
    && reasoningStreamStyles.some(style => style.id === config.reasoningStreamStyle)
    && Number.isFinite(config.reasoningStreamSpeed) && config.reasoningStreamSpeed! >= .5 && config.reasoningStreamSpeed! <= 2
    && typeof config.runningIdle === 'boolean'
    && typeof config.runningPaused === 'boolean'
    && Number.isFinite(config.runningCycle) && config.runningCycle! >= 1.5 && config.runningCycle! <= 4
}

export function interactionFor(config: LabConfig): BartDockInteractionRequest | undefined {
  const id = `bart-${config.scene}-${config.variant}-${config.replay}`
  if (config.scene === 'permission') return {
    threadId: 'bart-lab-thread',
    threadTitle: '整理项目',
    intervention: {
      id,
      title: config.variant === 'file' ? '允许修改这两个文件吗？' : '允许运行构建命令吗？',
      detail: config.variant === 'file'
        ? '更新 src/App.tsx 和 src/styles.css，调整页面的布局与间距。'
        : 'pnpm build\n检查当前项目能否正常构建。',
      actions: [
        { id: 'deny', label: '拒绝', intent: 'deny' },
        { id: 'allow-always', label: '始终允许', intent: 'allow' },
        { id: 'allow-once', label: '本次允许', intent: 'allow' }
      ]
    }
  }
  if (config.scene !== 'question') return undefined
  const question: InteractionQuestionSpec = {
    id: 'direction',
    header: config.variant === 'multiple' ? '这次想先完善哪些部分？' : '你希望先从哪里开始？',
    prompt: config.variant === 'multiple' ? '可以选择多项。' : '选择一个方向，也可以补充自己的想法。',
    multiple: config.variant === 'multiple',
    allowOther: true,
    secret: false,
    options: [
      { id: 'layout', value: 'layout', label: '页面布局', description: '先调整结构、留白和内容层级。' },
      { id: 'motion', value: 'motion', label: '交互动效', description: '先打磨状态切换与动作反馈。' }
    ]
  }
  const textQuestion: InteractionQuestionSpec = {
    id: 'notes', header: '还有什么想让 Bart 知道的？', prompt: '写下一句补充说明。',
    multiple: false, allowOther: true, secret: false, options: []
  }
  return {
    threadId: 'bart-lab-thread', threadTitle: '一起完善页面',
    intervention: {
      id, title: '确认接下来的方向',
      questions: config.variant === 'text' ? [textQuestion]
        : config.variant === 'steps' ? [question, textQuestion] : [question],
      submitActionId: 'submit',
      actions: [{ id: 'cancel', label: '取消', intent: 'cancel' }, { id: 'submit', label: '确认', intent: 'submit' }]
    }
  }
}
