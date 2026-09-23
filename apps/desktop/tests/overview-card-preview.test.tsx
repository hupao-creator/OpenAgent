// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { excerptPreview } from '../../../packages/openagent-plugin-kit/src/renderer/harness-card/excerpt-preview'
import { ThreadCardExcerpt, ThreadCardIdentity } from '../../../packages/openagent-plugin-kit/src/renderer/harness-card/card'
import { I18nProvider } from '../../../packages/openagent-plugin-kit/src/renderer/i18n'

afterEach(cleanup)

describe('thread card preview', () => {
  it('shortens complete links and inline emphasis in prose', () => {
    const source = '**Inspecting files broadly**。检查 [use-settings-autosave.ts:86](/Users/felixwang/Desktop/work/OpenAgent-clone/apps/desktop/src/renderer/src/components/use-settings-autosave.ts:86) 、 [HarnessSettingsPage.tsx:274](/Users/felixwang/Desktop/work/OpenAgent-clone/apps/desktop/src/renderer/src/components/HarnessSettingsPage.tsx:274)。'
    expect(excerptPreview(source)).toBe('Inspecting files broadly。检查 use-settings-autosave.ts:86 、 HarnessSettingsPage.tsx:274。')
    expect(excerptPreview(source)).not.toContain('](')
  })

  it.each([
    ['literal bracket punctuation', 'before ](literal) after', 'before ](literal) after'],
    ['missing link opener', 'ts:86](/Users/felix/file.ts:86)', 'ts:86](/Users/felix/file.ts:86)'],
    ['unfinished link', '[file](/Users/felix/file…', '[file](/Users/felix/file…'],
    ['path with parentheses', '[file](/Users/felix/work(v2)/file.ts)', 'file'],
    ['block markers and whitespace', ' \n# Heading\n> quote\n- list\n\n tail\t  ', ' \n# Heading\n> quote\n- list\n\n tail\t  '],
    ['CRLF', '  first\r\n\r\nsecond  ', '  first\r\n\r\nsecond  '],
    ['code span', '`**raw** [file](/tmp/file)` **prose**', '`**raw** [file](/tmp/file)` prose'],
    ['long code delimiter', '`` ` **raw** [file](/tmp/file) `` **prose**', '`` ` **raw** [file](/tmp/file) `` prose'],
    ['indented code', '    **raw** [file](/tmp/file)\n**prose**', '    **raw** [file](/tmp/file)\nprose'],
    ['fenced code', '```md\n**raw** [file](/tmp/file)\n```\n**prose**', '```md\n**raw** [file](/tmp/file)\n```\nprose'],
    ['unfinished fence', '```md\n**raw** [file](/tmp/file)\n', '```md\n**raw** [file](/tmp/file)\n'],
    ['long tilde fence', '~~~~md\n~~~\n**raw** [file](/tmp/file)\n~~~~\n**prose**', '~~~~md\n~~~\n**raw** [file](/tmp/file)\n~~~~\nprose'],
    ['escaped emphasis', '\\*\\*raw\\*\\* **prose**', '\\*\\*raw\\*\\* prose']
  ])('preserves %s', (_name, source, expected) => {
    expect(excerptPreview(source)).toBe(expected)
  })

  it('leaves the selected window intact without adding a sentence or character cutoff', () => {
    const source = '  ' + '😀 tail\n'.repeat(100) + '  '
    expect(excerptPreview(source)).toBe(source)
  })

  it('keeps code literal when its opening fence is before the visible window', () => {
    const message = '```md\n' + 'x'.repeat(600) + '\n**raw** [file](/tmp/file)\n'
    const view = render(<ThreadCardExcerpt content={'…**raw** [file](/tmp/file)\n'} messageId="code" messageText={message} />)
    const body = view.container.querySelector('.thread-card-excerpt-text')
    expect(body?.textContent).toBe('…**raw** [file](/tmp/file)\n')
    view.rerender(<ThreadCardExcerpt content="bounded" messageId="code" messageText={message + 'next'} />)
    expect(body?.textContent).toBe('x'.repeat(573) + '\n**raw** [file](/tmp/file)\n')
  })

  it.each(['`', '``'])('carries inline delimiter %s across preview windows and newlines', delimiter => {
    const literal = '**raw** [file](/tmp/file)'
    expect(excerptPreview(literal + delimiter + ' **prose**', delimiter + 'earlier '))
      .toBe(literal + delimiter + ' prose')
    expect(excerptPreview(delimiter + 'earlier\n' + literal + delimiter + ' **prose**'))
      .toBe(delimiter + 'earlier\n' + literal + delimiter + ' prose')
    const message = delimiter + 'x'.repeat(600) + literal + delimiter
    const view = render(<ThreadCardExcerpt content={'…' + literal + delimiter}
      messageId="inline-code" messageText={message} />)
    expect(view.container.querySelector('.thread-card-excerpt-text')?.textContent)
      .toBe('…' + literal + delimiter)
  })

  it('keeps mismatched and escaped backticks literal within a code span', () => {
    expect(excerptPreview('` **raw** [file](/tmp/file) `` **prose**', '``earlier\n'))
      .toBe('` **raw** [file](/tmp/file) `` prose')
    expect(excerptPreview('\\` **prose**', '`earlier ')).toBe('\\` prose')
    expect(excerptPreview('[file](/tmp/a\\)b) **prose**')).toBe('file prose')
  })

  it('uses natural wrapping and a line clamp for the rendered text', () => {
    const testPath = expect.getState().testPath!
    const css = readFileSync(resolve(dirname(testPath), '../../../packages/openagent-plugin-kit/src/renderer/components.css'), 'utf8')
    expect(css).toMatch(/\.thread-overview-excerpt \.thread-card-excerpt-text \{[^}]*word-break: normal;[^}]*overflow-wrap: break-word;/)
    expect(css).toMatch(/\.thread-overview-excerpt \.thread-card-excerpt-text \{[^}]*-webkit-line-clamp: 5;/)
  })
})

describe.each([
  ['high', 'high'], [undefined, '默认'], [null, '默认'], ['default', '默认'], ['', '默认']
])('effort %s', (effort, expected) => {
  it('keeps a complete factual model detail row', () => {
    const view = render(<ThreadCardIdentity identity={{ title: 'Task', excerpt: '', model: 'gpt-6-sol', effort }} selectedSize={{ cols: 1, rows: 1 }} />)
    const row = view.container.querySelector('small')
    expect(row?.textContent).toBe(`gpt-6-sol · ${expected}`)
  })

  it('localizes the fallback in an English kit provider', () => {
    const view = render(<I18nProvider locale="en-US">
      <ThreadCardIdentity identity={{ title: 'Task', excerpt: '', model: 'gpt-6-sol', effort }} selectedSize={{ cols: 1, rows: 1 }} />
    </I18nProvider>)
    expect(view.container.querySelector('small')?.textContent).toBe(`gpt-6-sol · ${expected === '默认' ? 'Default' : expected}`)
  })
})
