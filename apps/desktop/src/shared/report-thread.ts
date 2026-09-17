import { decodeHTML } from 'entities/decode'

/**
 * Report Thread：Bart 交付的持久化、用户侧只读汇报单元。
 *
 * 它是一等领域对象，不是 Agent Thread：没有 Harness、cwd、model、
 * run、状态或消息时间线。本模块只承载数据契约与纯校验，是共享层的叶子模块
 * （不 import state/state-contracts），因此持久化解析器与 reducer 都能依赖它
 * 而不成环。
 */

/** 沿用普通 thread title 的 60 字符（Unicode code point）上限。 */
export const MAX_REPORT_TITLE_LENGTH = 60
/** 完整 HTML 文档上限：1,000,000 个 Unicode 字符。 */
export const MAX_REPORT_HTML_CHARACTERS = 1_000_000
/** 俯瞰卡片的非执行式纯文本预览上限。 */
export const MAX_REPORT_PREVIEW_LENGTH = 220
/** 一份报告能关联的 agent thread 数量上限；标签快照本身不设上限。 */
export const MAX_REPORT_RELATED_THREADS = 256

export interface ReportExecutionReference {
  readonly threadId: string
  readonly executionId: string
}

/** Main 与持久化层的完整 Report Thread 权威记录。 */
export interface ReportThreadRecord {
  id: string
  /** Bart 拥有；必填非空。 */
  title: string
  /** Service 拥有；创建/替换关联集合时固化的标签快照。 */
  tags: string[]
  createdAt: number
  updatedAt: number
  /** Bart 拥有；完整 HTML 文档，应用不做 sanitize。 */
  html: string
  /** Bart 拥有；关联已完成 Execution 的有序列表，同一 Thread 至多一个目标，允许为空。 */
  relatedExecutions: ReportExecutionReference[]
  /**
   * 软归档标记：归档只把报告移出默认俯瞰，HTML、tags、relatedExecutions 与
   * 时间戳一律原样保留，与 openagent_report_delete 的硬删除语义分离。
   */
  archived: boolean
}

/**
 * 从任意完整 HTML 中提取卡片可显示的纯文本。这里只做展示投影，不试图修复、
 * sanitize 或解释报告文档；结果最终仍由 React 作为 text node 转义。
 */
export function reportHtmlPreview(html: string, title = ''): string {
  let text = reportVisibleText(html)
    .replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z][\da-z]+));/gi, decodeReportEntity)
    .replace(/\s+/g, ' ')
    .trim()

  const normalizedTitle = title.replace(/\s+/g, ' ').trim()
  if (normalizedTitle && text.startsWith(normalizedTitle)) {
    const remainder = text.slice(normalizedTitle.length)
    if (!remainder || /^[\s:：|·—–-]/.test(remainder)) text = remainder.replace(/^[\s:：|·—–-]+/, '')
  }

  const characters = Array.from(text)
  return characters.length > MAX_REPORT_PREVIEW_LENGTH
    ? `${characters.slice(0, MAX_REPORT_PREVIEW_LENGTH - 1).join('').trimEnd()}…`
    : text
}

const REPORT_PREVIEW_HIDDEN_TAGS = new Set([
  'head', 'script', 'style', 'template', 'noscript', 'svg'
])

/** 单次线性扫描，避免在最大尺寸 HTML 上用跨文档回溯正则。 */
function reportVisibleText(html: string): string {
  const lowerHtml = html.toLowerCase()
  const fragments: string[] = []
  let cursor = 0
  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor)
    if (tagStart < 0) {
      fragments.push(html.slice(cursor))
      break
    }
    fragments.push(html.slice(cursor, tagStart))
    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4)
      cursor = commentEnd < 0 ? html.length : commentEnd + 3
      fragments.push(' ')
      continue
    }

    const tagEnd = reportTagEnd(html, tagStart + 1)
    if (tagEnd < 0) {
      fragments.push(html.slice(tagStart))
      break
    }
    const tagSource = html.slice(tagStart + 1, tagEnd)
    const match = /^\s*(\/?)\s*([a-z][\w:-]*)/i.exec(tagSource)
    if (!match) {
      // 保留普通文本里的比较符号；doctype / processing instruction 则丢弃。
      fragments.push(/^\s*[!?]/.test(tagSource) ? ' ' : html.slice(tagStart, tagEnd + 1))
      cursor = tagEnd + 1
      continue
    }

    const closing = Boolean(match[1])
    const tag = match[2].toLowerCase()
    const selfClosing = /\/\s*$/.test(tagSource)
    if (!closing && !selfClosing && REPORT_PREVIEW_HIDDEN_TAGS.has(tag)) {
      const closingStart = reportClosingTagStart(lowerHtml, tag, tagEnd + 1)
      if (closingStart < 0) break
      const closingEnd = reportTagEnd(html, closingStart + 1)
      cursor = closingEnd < 0 ? html.length : closingEnd + 1
      fragments.push(' ')
      continue
    }
    fragments.push(' ')
    cursor = tagEnd + 1
  }
  return fragments.join('')
}

function reportTagEnd(html: string, start: number): number {
  let quote = ''
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]
    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  return -1
}

function reportClosingTagStart(lowerHtml: string, tag: string, start: number): number {
  const prefix = `</${tag}`
  let candidate = lowerHtml.indexOf(prefix, start)
  while (candidate >= 0) {
    const boundary = lowerHtml[candidate + prefix.length]
    if (boundary === undefined || /[\s/>]/.test(boundary)) return candidate
    candidate = lowerHtml.indexOf(prefix, candidate + prefix.length)
  }
  return -1
}

function decodeReportEntity(
  entity: string,
  decimal: string | undefined,
  hexadecimal: string | undefined,
  named: string | undefined
): string {
  if (decimal || hexadecimal) {
    const codePoint = Number.parseInt(decimal || hexadecimal || '', decimal ? 10 : 16)
    if (Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return ' '
      }
    }
    return ' '
  }
  const decoded: Record<string, string> = {
    amp: '&', apos: "'", copy: '©', gt: '>', hellip: '…', lt: '<',
    mdash: '—', middot: '·', nbsp: ' ', ndash: '–', quot: '"', reg: '®'
  }
  return decoded[(named || '').toLowerCase()] ?? entity
}

/** report_list 的轻量摘要：不含 HTML、完整关联 ID 或完整标签。 */
export interface ReportThreadSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  relatedThreadCount: number
  tagCount: number
  archived: boolean
}

export function exceedsUnicodeLength(value: string, limit: number): boolean {
  if (value.length <= limit) return false
  let count = 0
  for (const _character of value) {
    count += 1
    if (count > limit) return true
  }
  return false
}

/**
 * 校验并规范化报告标题。空白折叠后必须非空且不超过 60 个字符；越界即失败，
 * 不做静默截断。
 */
export function parseReportTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('报告 title 必须是字符串')
  const title = value.replace(/\s+/g, ' ').trim()
  if (!title) throw new Error('报告 title 不能为空')
  if (exceedsUnicodeLength(title, MAX_REPORT_TITLE_LENGTH)) {
    throw new Error(`报告 title 不能超过 ${MAX_REPORT_TITLE_LENGTH} 个字符`)
  }
  return title
}

/**
 * 校验提交的 HTML：非空、不超过 1,000,000 个 Unicode 字符，拒绝明显的整篇
 * 实体转义文档。不截断、不修复、不自动解码；HTML 内的文本实体原样保留。
 * 仅创建/替换正文时使用，历史记录仍可原样读取并由 Bart 显式更新。
 */
export function parseReportHtml(value: unknown): string {
  if (typeof value !== 'string') throw new Error('报告 html 必须是字符串')
  if (!value.trim()) throw new Error('报告 html 不能为空')
  if (exceedsUnicodeLength(value, MAX_REPORT_HTML_CHARACTERS)) {
    throw new Error(`报告 html 不能超过 ${MAX_REPORT_HTML_CHARACTERS} 个 Unicode 字符`)
  }
  // 仅对无原始标记的输入构造检测文本，遵循 HTML 字符引用规则（含省略分号、
  // 最长匹配和大小写）。检测结果绝不用于保存/渲染，正文与代码示例不被解码。
  const markupStart = /^\s*<(?:[!?]|\/?[a-z][^\s/>]*(?=[\s/>]))/i
  if (!/<(?:[!?]|\/?[a-z])/i.test(value) && markupStart.test(decodeHTML(value))) {
    throw new Error('报告 html 必须提交原始 HTML，例如 <h2>结论摘要</h2>，不能将整篇标签转义成 &lt;h2&gt;。请使用原始 HTML 重试；如需展示代码示例，请放在 <pre><code> 中并仅转义示例内容。')
  }
  return value
}

/**
 * 校验显式 Execution 关联并按首次出现去重，保留调用方给出的稳定顺序。
 * 同一 Thread 的不同目标拒绝为歧义输入；归属、存在性和 completed 由 Service 判定。
 */
export function parseReportRelatedExecutions(value: unknown): ReportExecutionReference[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('报告 relatedExecutions 必须是关联数组')
  if (value.length > MAX_REPORT_RELATED_THREADS) {
    throw new Error(`报告 relatedExecutions 不能超过 ${MAX_REPORT_RELATED_THREADS} 项`)
  }
  const result: ReportExecutionReference[] = []
  const seen = new Map<string, string>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item) ||
        Object.keys(item).some(key => key !== 'threadId' && key !== 'executionId')) {
      throw new Error('报告关联必须包含 threadId 和 executionId')
    }
    const { threadId, executionId } = item
    for (const id of [threadId, executionId]) {
      if (typeof id !== 'string' || !id || id.includes('\0') || /\s/.test(id) ||
          exceedsUnicodeLength(id, 128)) throw new Error('报告关联含无效的 Thread 或 Execution ID')
    }
    const previous = seen.get(threadId)
    if (previous !== undefined) {
      if (previous !== executionId) throw new Error('同一报告对同一 Thread 只能关联一个 Execution')
      continue
    }
    seen.set(threadId, executionId)
    result.push({ threadId, executionId })
  }
  return result
}

export function reportThreadSummary(report: ReportThreadRecord): ReportThreadSummary {
  return {
    id: report.id,
    title: report.title,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    relatedThreadCount: report.relatedExecutions.length,
    tagCount: report.tags.length,
    archived: report.archived
  }
}
