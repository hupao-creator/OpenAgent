import type { HarnessTranslationCatalog } from '@openagent/contracts/renderer'

export const codexRendererTranslations = {
  'en-US': {
    '该 Codex 请求已失效。': 'This Codex request has expired.',
    'Codex 消息时间线': 'Codex message timeline',
    'Codex 线程发生系统错误': 'A system error occurred in the Codex thread',
    '后台终端': 'Background terminals',
    '保存后的设置在下一次 Codex 操作时生效；Primary Native Session 不会被替换。':
      'Saved settings take effect on the next Codex operation; the primary native session is preserved.',
    '用于新建 Thread 的原生配置默认值，包括 Bart 宿主。':
      'Native defaults for new threads, including the Bart host.',
    '跟随 Codex 默认模型': 'Use the Codex default model',
    '服务层级': 'Service tier',
    'OpenAgent 默认': 'OpenAgent default',
    'OpenAgent 默认（approve-for-me）': 'OpenAgent default (approve-for-me)',
    'ask-for-approval · 按需询问用户': 'ask-for-approval · ask the user as needed',
    'approve-for-me · 原生自动审批': 'approve-for-me · native auto review',
    'full-access · 完全访问': 'full-access · full access',
    '未知模型': 'Unknown model',
    '内容必须是有效 JSON。': 'Content must be valid JSON.',
    '内容必须是 JSON object。': 'Content must be a JSON object.',
    '正在读取 Codex 环境…': 'Loading the Codex environment…',
    '已读取 Codex 环境': 'Codex environment loaded',
    'Codex CLI 不可用': 'Codex CLI unavailable',
    'Codex Thread 默认配置': 'Codex Thread defaults',
    'Codex Thread': 'Codex thread'
  }
} as const satisfies HarnessTranslationCatalog
