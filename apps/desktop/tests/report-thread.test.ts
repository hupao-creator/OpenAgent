import { describe, expect, it } from 'vitest'
import {
  MAX_REPORT_HTML_CHARACTERS,
  MAX_REPORT_TITLE_LENGTH,
  parseReportHtml,
  parseReportRelatedExecutions,
  parseReportTitle,
  reportHtmlPreview,
  reportThreadSummary,
  type ReportThreadRecord
} from '../src/shared/report-thread'

const report: ReportThreadRecord = {
  id: 'report-1',
  title: '交付报告',
  tags: ['release', 'desktop'],
  createdAt: 1,
  updatedAt: 2,
  html: '<html><head><title>hidden</title></head><body><h1>交付报告</h1><p>Ready &amp; safe</p></body></html>',
  relatedExecutions: [{ threadId: 'thread-1', executionId: 'execution-1' }],
  archived: false
}

describe('Report Thread value contract', () => {
  it('normalizes bounded titles and validates complete HTML', () => {
    expect(parseReportTitle('  交付   报告  ')).toBe('交付 报告')
    expect(() => parseReportTitle('x'.repeat(MAX_REPORT_TITLE_LENGTH + 1))).toThrow()
    expect(parseReportHtml(report.html)).toBe(report.html)
    expect(() => parseReportHtml('x'.repeat(MAX_REPORT_HTML_CHARACTERS + 1))).toThrow()
  })

  it('deduplicates related thread ids without changing their order', () => {
    expect(parseReportRelatedExecutions([{ threadId: 'b', executionId: 'e1' }, { threadId: 'a', executionId: 'e2' }, { threadId: 'b', executionId: 'e1' }])).toEqual([{ threadId: 'b', executionId: 'e1' }, { threadId: 'a', executionId: 'e2' }])
    expect(() => parseReportRelatedExecutions([{ threadId: 'b', executionId: 'e1' }, { threadId: 'b', executionId: 'e2' }])).toThrow(/只能关联一个/)
    expect(() => parseReportRelatedExecutions(['bad id'])).toThrow()
  })

  it.each([
    '&lt;h2&gt;结论摘要&lt;/h2&gt;\n&lt;p&gt;正文&lt;/p&gt;',
    ' \n&lt;!DOCTYPE html&gt;&lt;html&gt;&lt;body&gt;正文&lt;/body&gt;&lt;/html&gt;',
    '&lt;!-- generated --&gt;&lt;html&gt;&lt;body&gt;正文&lt;/body&gt;&lt;/html&gt;',
    '&lt;br/&gt;正文',
    '&lt;svg/&gt;',
    '&#00060;br/&#00062;正文',
    '&#60;h2&#62;结论摘要&#60;/h2&#62;',
    '&#x3C;h2&#x3E;结论摘要&#x3C;/h2&#x3E;',
    '&#60h2&#62Heading&#60/h2&#62',
    '&#x3ch2&#x3eHeading&#x3c/h2&#x3e',
    '&lth2&gtHeading&lt/h2&gt',
    '&lt;h2>Heading&lt;/h2>',
    '&#60;&#104;&#50;&#62;Heading&#60;/h2&#62;'
  ])('rejects an entity-escaped document with actionable feedback: %s', html => {
    expect(() => parseReportHtml(html)).toThrow(/原始 HTML.*<h2>.*&lt;h2&gt;/)
  })

  it.each([
    '<h2>结论摘要</h2><p>正文</p>',
    '<!doctype html><html><body><pre><code>&lt;h2&gt;示例&lt;/h2&gt;</code></pre></body></html>',
    '<p>Ready &amp; safe; 1 &lt; 2</p>',
    '&lt;h2&gt;示例&lt;/h2&gt;<p>上面是 HTML 代码示例。</p>',
    'Plain text with 1 &lt; 2',
    '&Lt;h2&Gt; is a mathematical comparison',
    '&#600h2&#62; is not an encoded less-than sign',
    '&#x3cbr/&#62; is not an encoded less-than sign',
    '&lt;h2&gtcc;'
  ])('preserves raw HTML and intentional text entities byte-for-byte: %s', html => {
    expect(parseReportHtml(html)).toBe(html)
  })

  it('projects bounded non-executable overview data', () => {
    expect(reportHtmlPreview(report.html, report.title)).toBe('Ready & safe')
    expect(reportThreadSummary(report)).toEqual({
      id: 'report-1',
      title: '交付报告',
      createdAt: 1,
      updatedAt: 2,
      relatedThreadCount: 1,
      tagCount: 2,
      archived: false
    })
  })
})
