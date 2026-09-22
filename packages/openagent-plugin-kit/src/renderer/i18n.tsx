import { createContext, useContext, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'

/** Core-owned Host locale identifiers; the Host settings module widens from these. */
export type OpenAgentLocale = 'zh-CN' | 'en-US'
export type AppLocale = OpenAgentLocale
export type TranslationValues = Record<string, string | number>
export type TranslationDictionary = Readonly<Record<string, string>>
export type TranslationCatalog = Readonly<
  Partial<Record<AppLocale, TranslationDictionary>>
>

const EN_US: Readonly<Record<string, string>> = {
  '思考过程': 'Reasoning',
  '执行过程': 'Execution process',
  '执行失败': 'Failed',
  '消息显示': 'Message display',
  '对话': 'Conversation',
  '对话轮次': 'Conversation turn',
  '显示用户消息': 'Show user messages',
  '隐藏用户消息': 'Hide user messages',
  '显示执行过程': 'Show work',
  '收起执行过程': 'Hide work',
  '回到最新': 'Jump to latest',
  '用时：{duration}': 'Elapsed: {duration}',
  '发送消息': 'Send message',
  后台仍在运行: 'Background work is still running',
  后台运行中: 'Background running',
  需要你处理: 'Needs your attention',
  等你回答: 'Awaiting your answer',
  等你授权: 'Awaiting approval',
  '输入与输出 token 合计，按 Harness 当前上报的统计范围显示': 'Input and output tokens, using the scope reported by the Harness',
  请求详情: 'Request details',
  设置: 'Settings',
  说明: 'Help',
  关闭: 'Close',
  可用: 'Available',
  不可用: 'Unavailable',
  '刷新 {name} 环境': 'Refresh {name} environment',
  取消: 'Cancel',
  '保存中…': 'Saving…',
  '正在保存…': 'Saving…',
  模型: 'Model',
  模型默认: 'Model default',
  推理强度: 'Reasoning effort',
  审批: 'Approval',
  消息时间线: 'Message timeline',
  已加载消息: 'Loaded messages',
  '一只小猫坐在电脑后面，等待新的想法。': 'A cat behind a computer, waiting for a new idea.',
  '显示更早的 {count} 条消息': 'Show {count} older messages',
  计划: 'Plan',
  代码审查: 'Code review',
  正在工作: 'Working',
  '页面路径': 'Page path',
  '历史对话': 'Past conversation',
  '历史执行不可用': 'Historical execution unavailable',
  '无法找到报告关联的历史执行。': 'The historical execution linked by this report could not be found.',
  '完成时间：': 'Completion time:',
  '俯瞰': 'Overview',
  '输入': 'Input',
  '输出': 'Output',
  '缓存读取': 'Cache read',
  '缓存写入': 'Cache write',
  '推理': 'Reasoning',
  等待输入: 'Waiting for input',
  已允许: 'Allowed',
  已拒绝: 'Denied',
  已提交: 'Submitted',
  已取消: 'Cancelled',
  已处理: 'Resolved',
  已中断: 'Interrupted',
  'Thread 配置': 'Thread configuration',
  运行中: 'Running',
  保存: 'Save',
  需处理: 'Needs attention',
  已完成: 'Completed',
  失败: 'Failed',
  上一步: 'Previous',
  下一步: 'Next',
  '其它…': 'Other…',
  输入你的回答: 'Enter your answer',
  输入回答: 'Enter an answer',
  '恢复默认': 'Restore defaults',
  'Bart Host': 'Bart host',
  '提交': 'Submit',
  '该请求已失效。': 'This request has expired.',
  '补充': 'Follow-up',
  '允许一次': 'Allow once',
  '本会话始终允许': 'Always allow for this session',
  '上下文已压缩': 'Context compacted',
  '拒绝': 'Deny',
  '{count} 个后台任务': '{count} background tasks',
  '空闲': 'Idle',
  '在 thread 中处理': 'Handle in thread',
  '阶段': 'Phases',
  '有序定义': 'Ordered',
  '已声明阶段': 'Declared phases',
  '{done}/{total} 完成': '{done}/{total} completed',
  '完成': 'Completed',
  '子 Agent': 'Sub-agent',
  '任务': 'Task',
  '命令': 'Commands',
  '思考': 'Thinking',
  '工具': 'Tools',
  '正在读取': 'Reading',
  你: 'You',
  停止: 'Stop',
  刷新: 'Refresh',
  执行活动: 'Execution activity',
  重试: 'Retry',
  '布局暂未更新，请重试。': 'Layout could not be updated. Please retry.',
  等待开始: 'Waiting to start',
  等待你的响应: 'Waiting for your response',
  文件: 'File',
  搜索: 'Search',
  审查: 'Review',
  可执行文件: 'Executable',
  '该值在 Thread 创建时确定。': 'This value is fixed when the thread is created.',
  使用默认配置: 'Use default configuration',
  '关闭后可自定义新建 Thread 使用的配置。':
    'Turn this off to configure new threads yourself.',
  '该 Thread 正在运行，请等待完成或停止后再修改。':
    'This thread is running. Wait for completion or stop it before making changes.',
  '应用 Thread 配置': 'Apply thread configuration',
  '目录中不可用': 'unavailable in this directory',
  读取: 'Read',
  图表: 'Chart',
  图表源码: 'Chart source',
  'Mermaid 图表': 'Mermaid diagram',
  '正在绘制图表…': 'Drawing diagram…',
  '图表生成中…': 'Generating diagram…',
  复制源码: 'Copy source',
  已复制: 'Copied',
  '复制失败，请手动选择源码。': 'Copy failed. Select the source manually.',
  '图表源码为空。': 'The diagram source is empty.',
  '图表源码超过 50,000 字符，已回退为源码。':
    'The diagram source exceeds 50,000 characters. Showing source instead.',
  '图表需要访问外部资源，已回退为源码。':
    'The diagram needs external resources. Showing source instead.',
  '图表渲染超时，已回退为源码。': 'Rendering the diagram timed out. Showing source instead.',
  '图表加载失败，已回退为源码。': 'The diagram failed to load. Showing source instead.',
  '图表语法有误，已回退为源码。': 'The diagram syntax is invalid. Showing source instead.',
  '图表渲染失败，已回退为源码。': 'The diagram failed to render. Showing source instead.',
  '图表组件出错，已回退为源码。':
    'The chart component failed. Showing source instead.',
  适应宽度: 'Fit width',
  原始大小: 'Actual size'
}

/** Shared component and provider-neutral interaction vocabulary. Product copy is injected by the host. */
export const kitRendererTranslations = {
  'en-US': EN_US
} as const satisfies TranslationCatalog

interface I18nValue {
  locale: AppLocale
  t: (source: string, values?: TranslationValues) => string
  formatNumber: (value: number) => string
  formatDateTime: (value: number | Date) => string
  formatRelativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit) => string
}

function interpolate(message: string, values?: TranslationValues): string {
  if (!values) return message
  return message.replace(/\{([^{}]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  )
}

export function translate(
  locale: AppLocale,
  source: string,
  values?: TranslationValues,
  additionalTranslations?: TranslationCatalog
): string {
  const message = locale === 'en-US'
    ? additionalTranslations?.[locale]?.[source] || EN_US[source] || source
    : source
  return interpolate(message, values)
}

export function formatRelativeTime(
  locale: AppLocale,
  value: number,
  unit: Intl.RelativeTimeFormatUnit
): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit)
}

export function createI18n(
  locale: AppLocale,
  additionalTranslations?: TranslationCatalog
): I18nValue {
  return {
    locale,
    t: (source, values) => translate(locale, source, values, additionalTranslations),
    formatNumber: (value) => new Intl.NumberFormat(locale).format(value),
    formatDateTime: (value) =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(value),
    formatRelativeTime: (value, unit) => formatRelativeTime(locale, value, unit),
  }
}

interface I18nContextValue {
  readonly catalog?: TranslationCatalog
  readonly value: I18nValue
}

const I18nContext = createContext<I18nContextValue>({
  value: createI18n('zh-CN')
})

export function I18nProvider(props: {
  locale: AppLocale
  translations?: TranslationCatalog
  children: ReactNode
}): React.JSX.Element {
  const context = useMemo<I18nContextValue>(() => ({
    catalog: props.translations,
    value: createI18n(props.locale, props.translations)
  }), [props.locale, props.translations])

  useEffect(() => {
    document.documentElement.lang = props.locale
  }, [props.locale])

  return <I18nContext.Provider value={context}>{props.children}</I18nContext.Provider>
}

export function useI18n(localeOverride?: AppLocale): I18nValue {
  const current = useContext(I18nContext)
  return useMemo(
    () => localeOverride
      ? createI18n(localeOverride, current.catalog)
      : current.value,
    [current, localeOverride]
  )
}
