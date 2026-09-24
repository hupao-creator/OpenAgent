// 本文件的标题字母表刻意包含全角空格与 NBSP（见 titleParts 上方的说明）：它们是被测
// 输入而非误输入，故整个文件关闭该规则。
/* oxlint-disable eslint/no-irregular-whitespace */
import fc from 'fast-check'
import { expect, it } from 'vitest'
import {
  MAX_REPORT_TITLE_LENGTH,
  exceedsUnicodeLength,
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
