// 本文件的标题字母表刻意包含全角空格与 NBSP（见 titleParts 上方的说明）：它们是被测
// 输入而非误输入，故整个文件关闭该规则。
/* oxlint-disable eslint/no-irregular-whitespace */
import fc from 'fast-check'
import { expect, it } from 'vitest'
import {
  MAX_REPORT_RELATED_THREADS,
  MAX_REPORT_TITLE_LENGTH,
  exceedsUnicodeLength,
  parseReportHtml,
  parseReportRelatedExecutions,
  parseReportTitle,
  type ReportExecutionReference
} from '../../src/shared/report-thread'
import { checkAsync } from './check'

const timeout = process.env.FC_EXPLORE ? 130_000 : 35_000
const budget = process.env.FC_EXPLORE ? 120_000 : 30_000
// Every property here calls a pure module: no process, socket, clock or file.
const samples = { normal: 100, explore: 1000 }

/**
 * Title alphabet mixing ASCII, full-width and non-BMP characters with the
 * whitespace classes the normalizer folds. ` ` and `　` are matched by
 * JavaScript's `\s`, so a code-unit-based length check and a code-point-based
 * one disagree on inputs built from these parts.
 */
const titleParts = fc.constantFrom(
  'a', 'B', '7', '-', '_', '中', '文', '𝄞', '😀', ' ', '\t', '\n', ' ', '　'
)
const textNoWhitespace = fc.constantFrom('a', 'B', '中', '𝄞', '😀')

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim()
const codePoints = (value: string): string[] => Array.from(value)

const reference = (threadId: string, executionId: string): ReportExecutionReference =>
  ({ threadId, executionId })

const threadIds = ['t0', 't1', 't2', 't3'] as const

/** First-occurrence deduplication is the documented behavior of the parser. */
function dedupeByThread(input: readonly ReportExecutionReference[]): ReportExecutionReference[] {
  const seen = new Map<string, string>()
  const result: ReportExecutionReference[] = []
  for (const item of input) {
    if (seen.has(item.threadId)) continue
    seen.set(item.threadId, item.executionId)
    result.push(item)
  }
  return result
}

it('Report titles are normalized to a fixed point', async () => {
  await checkAsync('Report titles are normalized to a fixed point', fc.asyncProperty(
    fc.array(titleParts, { minLength: 0, maxLength: 80 }),
    async parts => {
      const raw = parts.join('')
      const collapsed = collapse(raw)
      const accepted = collapsed.length > 0 && codePoints(collapsed).length <= MAX_REPORT_TITLE_LENGTH
      if (!accepted) {
        expect(() => parseReportTitle(raw)).toThrow()
        return
      }
      const parsed = parseReportTitle(raw)
      expect(parsed).toBe(collapsed)
      // Normalization is idempotent: an accepted title parses to itself.
      expect(parseReportTitle(parsed)).toBe(parsed)
      expect(codePoints(parsed).length).toBeLessThanOrEqual(MAX_REPORT_TITLE_LENGTH)
    }
  ), 'collapse every whitespace run, trim, then count Unicode code points', budget, samples)
}, timeout)

it('Report title limits count Unicode code points, not UTF-16 units', async () => {
  await checkAsync('Report title limits count Unicode code points, not UTF-16 units', fc.asyncProperty(
    fc.array(textNoWhitespace, { minLength: 55, maxLength: 65 }),
    async parts => {
      const title = parts.join('')
      const points = codePoints(title).length
      if (points <= MAX_REPORT_TITLE_LENGTH) {
        expect(parseReportTitle(title)).toBe(title)
        return
      }
      expect(() => parseReportTitle(title)).toThrow(
        `报告 title 不能超过 ${MAX_REPORT_TITLE_LENGTH} 个字符`
      )
    }
  ), 'generate 55..65 whitespace-free code points from a mix of BMP and non-BMP characters', budget, samples)
}, timeout)

it('exceedsUnicodeLength counts the same code points as iteration', async () => {
  await checkAsync('exceedsUnicodeLength counts the same code points as iteration', fc.asyncProperty(
    fc.array(titleParts, { minLength: 0, maxLength: 12 }),
    fc.integer({ min: 0, max: 8 }),
    async (parts, limit) => {
      const value = parts.join('')
      expect(exceedsUnicodeLength(value, limit)).toBe(codePoints(value).length > limit)
    }
  ), 'generated string and limit; the guard must agree with Array.from length', budget, samples)
}, timeout)

it('Related executions keep caller order and deduplicate by first occurrence', async () => {
  await checkAsync('Related executions keep caller order and deduplicate by first occurrence', fc.asyncProperty(
    fc.array(fc.record({
      threadId: fc.constantFrom(...threadIds),
      executionId: fc.constantFrom('e0', 'e1')
    }), { minLength: 0, maxLength: 12 }),
    async items => {
      // Each thread keeps one canonical execution in this generator, so the input
      // is legal and only the repeated pairs are collapsed.
      const canonical = new Map<string, string>()
      const input = items.map(({ threadId, executionId }) => {
        if (!canonical.has(threadId)) canonical.set(threadId, executionId)
        return reference(threadId, canonical.get(threadId)!)
      })
      const parsed = parseReportRelatedExecutions(input)
      expect(parsed).toEqual(dedupeByThread(input))
      expect(parsed.length).toBe(canonical.size)
      for (const item of parsed) expect(item.executionId).toBe(canonical.get(item.threadId))
    }
  ), 'generated reference array with repeated thread/execution pairs, valid by construction', budget, samples)
}, timeout)

it('One report cannot relate a thread to two different executions', async () => {
  await checkAsync('One report cannot relate a thread to two different executions', fc.asyncProperty(
    fc.uniqueArray(fc.constantFrom(...threadIds), { minLength: 1, maxLength: 4 }),
    fc.array(fc.constantFrom('e0', 'e1'), { minLength: 1, maxLength: 4 }),
    async (threads, executions) => {
      const conflict = threads[0]!
      const input = threads.map(threadId => reference(threadId, executions[0]!))
      // The same pair repeated is not ambiguous: only a different target is.
      const repeated = [...input, reference(conflict, executions[0]!)]
      expect(parseReportRelatedExecutions(repeated).length).toBe(input.length)
      const other = executions.find(executionId => executionId !== executions[0]!) ?? 'e-other'
      expect(() => parseReportRelatedExecutions([...input, reference(conflict, other)])).toThrow(
        '同一报告对同一 Thread 只能关联一个 Execution'
      )
    }
  ), 'one thread carrying a second, different execution target in a generated reference array', budget, samples)
}, timeout)

it('Related-execution input is rejected before any deduplication', async () => {
  await checkAsync('Related-execution input is rejected before any deduplication', fc.asyncProperty(
    fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant({ threadId: 't0', executionId: 'e0' }),
      fc.array(fc.constantFrom(
        reference('t0', 'e0'),
        reference('t0', ''),
        reference('', 'e0'),
        reference('t 0', 'e0'),
        reference('t0', 'e\n0')
      ), { minLength: 1, maxLength: 4 }),
      fc.constant([{ threadId: 't0', executionId: 'e0', extra: true }]),
      // Two oversize shapes, because either one alone leaves a hole. Distinct
      // Thread ids have nothing to collapse, so the limit check is reached
      // whichever order the parser applies; an array that repeats legal pairs
      // (two of them here, `t0`/`e0` and `t1`/`e0`) is oversize raw and size 2
      // once collapsed, so a parser regressed to deduplicate before enforcing
      // the limit would accept it and return two references instead of refusing
      // the input.
      fc.constant(Array.from({ length: MAX_REPORT_RELATED_THREADS + 1 }, (_, index) =>
        reference(`t${index}`, 'e0'))),
      fc.constant(Array.from({ length: MAX_REPORT_RELATED_THREADS + 2 }, (_, index) =>
        reference(`t${index % 2}`, 'e0'))),
      fc.constant([reference('t0'.repeat(129), 'e0')]),
      fc.constant([reference('t0', 'e0'.repeat(129))])
    ),
    async value => {
      const legal = (input: unknown): boolean => input === undefined ||
        (Array.isArray(input) && input.length <= MAX_REPORT_RELATED_THREADS && input.every(item =>
          typeof item === 'object' && item !== null && !Array.isArray(item) &&
          Object.keys(item).every(key => key === 'threadId' || key === 'executionId') &&
          [item.threadId, item.executionId].every(id =>
            typeof id === 'string' && id.length > 0 && !id.includes('\0') && !/\s/.test(id) &&
            codePoints(id).length <= 128)))
      if (legal(value)) {
        const parsed = parseReportRelatedExecutions(value)
        expect(Array.isArray(parsed)).toBe(true)
        if (value === undefined) expect(parsed).toEqual([])
        return
      }
      expect(() => parseReportRelatedExecutions(value)).toThrow()
    }
  ), 'one illegal reference shape or an oversize array — distinct or collapsing to a legal size — per sample; undefined is the only absent form', budget, samples)
}, timeout)

it('Accepted HTML is returned unchanged and escaped documents are refused', async () => {
  await checkAsync('Accepted HTML is returned unchanged and escaped documents are refused', fc.asyncProperty(
    fc.array(fc.constantFrom('标题', '结论 <p>摘要</p>', '𝄞 emoji'), { minLength: 1, maxLength: 3 }),
    fc.constantFrom('h2', 'div', 'script', 'pre'),
    async (bodies, tag) => {
      const body = bodies.join('')
      const raw = `<${tag}>${body}</${tag}>`
      expect(parseReportHtml(raw)).toBe(raw)
      // A document whose only markup was escaped on the way in is refused, even
      // though the decoded text would look like markup.
      const escaped = `&lt;${tag}&gt;${body.replace(/</g, '&lt;')}&lt;/${tag}&gt;`
      expect(() => parseReportHtml(escaped)).toThrow(/必须提交原始 HTML/)
      // Escaping a code sample inside real markup stays legal and unchanged.
      const withExample = `<pre><code>${escaped}</code></pre>`
      expect(parseReportHtml(withExample)).toBe(withExample)
    }
  ), 'generated body text placed in a real element, then the same text fully entity-escaped', budget, samples)
}, timeout)

it('Non-string and blank report HTML is refused', async () => {
  await checkAsync('Non-string and blank report HTML is refused', fc.asyncProperty(
    fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant(42),
      fc.constant(true),
      fc.array(fc.constant('<p>x</p>'), { maxLength: 2 }),
      fc.string({ maxLength: 6 }).map(value => value.replace(/[^\s]/g, ' ')),
      fc.constant('<h2>正文</h2>').map(value => `${value}\n \t`)
    ),
    async value => {
      if (typeof value === 'string' && value.trim().length > 0) {
        // Padding an accepted document must not change it.
        expect(parseReportHtml(value)).toBe(value)
        return
      }
      expect(() => parseReportHtml(value)).toThrow()
    }
  ), 'generated non-string, empty, whitespace-only or trailing-padded HTML candidate', budget, samples)
}, timeout)
