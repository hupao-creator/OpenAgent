// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadCardExcerpt } from '../../../packages/openagent-plugin-kit/src/renderer/harness-card/card'

function textBody(content: string): Element {
  const view = render(<ThreadCardExcerpt content={content} />)
  const body = view.container.querySelector('.thread-card-excerpt-text')
  if (!body) throw new Error('excerpt has no text body')
  return body
}

const collapsedBlocks = [
  ['prose', '概览卡片的摘要截断要与其它 harness 对齐，并补上 token 用量。', '概览卡片的摘要截断要与其它 harness 对齐，并补上 token 用量。'],
  ['heading', '# 概览卡片的摘要截断要与其它 harness 对齐', '# 概览卡片的摘要截断要与其它 harness 对齐'],
  ['blockquote', '> 概览卡片的摘要截断要与其它 harness 对齐', '> 概览卡片的摘要截断要与其它 harness 对齐'],
  ['list', '- 概览卡片的摘要截断要与其它 harness 对齐', '- 概览卡片的摘要截断要与其它 harness 对齐'],
  ['inline markup', '**粗体** `query` [链接](https://example.com)', '粗体 `query` 链接'],
  ['HTML source', '<img src="example.png" onerror="alert(1)">', '<img src="example.png" onerror="alert(1)">']
] as const

afterEach(cleanup)

describe.each(collapsedBlocks)('a collapsed %s excerpt', (_kind, content, expected) => {
  it('renders the expected preview as text without creating markup elements', () => {
    const body = textBody(content)
    expect(body.textContent).toBe(expected)
    expect(body.children).toHaveLength(0)
  })
})

describe('a multi-block excerpt', () => {
  it('keeps newlines in one raw string', () => {
    const body = textBody('第一段\n\n第二段')
    expect(body.textContent).toBe('第一段\n\n第二段')
    expect(body.children).toHaveLength(0)
  })
})
