// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ThreadCardExcerpt } from '../../../packages/openagent-plugin-kit/src/renderer/harness-card/card'

/**
 * 五行裁剪是一份 DOM 契约而不是像素效果：excerpt 把裁剪交给原始文本元素，保留
 * Markdown 标记与换行。jsdom 不做排版，所以这里把随包
 * 发布的 CSS 注入文档，断言它对真实渲染出的 markup 生效——覆盖选择器与行为，不
 * 覆盖像素。
 *
 * 构建脚本用 cpSync 原样复制这份 CSS（见 packages/openagent-plugin-kit 的 build），
 * 因此源码就是发布产物。CSS 用 fs 读源码而不是 import：vitest 默认不处理 CSS 导入，
 * 连 ?raw 也会拿到空串。路径取自 testPath，不依赖调用时的 cwd。
 */
function readExcerptCss(): string {
  const testPath = expect.getState().testPath
  if (!testPath) throw new Error('vitest did not report the current test path')
  return readFileSync(
    resolve(dirname(testPath), '../../../packages/openagent-plugin-kit/src/renderer/components.css'),
    'utf8'
  )
}

interface ClampMatch {
  readonly rule: CSSStyleRule
  readonly element: Element
}

function collectStyleRules(rules: CSSRuleList): CSSStyleRule[] {
  return Array.from(rules).flatMap(rule => {
    if ('selectorText' in rule) return [rule as CSSStyleRule]
    if ('cssRules' in rule) return collectStyleRules((rule as CSSGroupingRule).cssRules)
    return []
  })
}

function renderExcerpt(content: string, identitySize?: '1x2'): Element {
  const view = render(
    identitySize
      ? <div className="thread-card-identity" data-identity-size={identitySize}>
          <ThreadCardExcerpt content={content} />
        </div>
      : <ThreadCardExcerpt content={content} />
  )
  const excerpt = view.container.querySelector('.thread-overview-excerpt')
  if (!excerpt) throw new Error('excerpt did not render')
  return excerpt
}

function textBodyOf(excerpt: Element): Element {
  const body = excerpt.querySelector(':scope > .thread-card-excerpt-text')
  if (!body) throw new Error('excerpt has no direct text body')
  return body
}

let excerptRules: CSSStyleRule[] = []

/** 让 excerpt 放弃硬切、把裁剪交给内层元素的规则。 */
function escapingRules(excerpt: Element): CSSStyleRule[] {
  return excerptRules.filter(
    rule =>
      rule.style.getPropertyValue('max-height').trim() === 'none' &&
      excerpt.matches(rule.selectorText)
  )
}

/** excerpt 内被声明了 -webkit-line-clamp 的元素，连同声明它的规则。 */
function clampMatches(excerpt: Element): ClampMatch[] {
  const candidates = [excerpt, ...Array.from(excerpt.querySelectorAll('*'))]
  return excerptRules
    .filter(rule => rule.style.getPropertyValue('-webkit-line-clamp').trim())
    .flatMap(rule =>
      candidates
        .filter(element => element.matches(rule.selectorText))
        .map(element => ({ rule, element }))
    )
}

const collapsedBlocks = [
  ['prose', '概览卡片的摘要截断要与其它 harness 对齐，并补上 token 用量。'],
  ['heading', '# 概览卡片的摘要截断要与其它 harness 对齐'],
  ['blockquote', '> 概览卡片的摘要截断要与其它 harness 对齐'],
  ['list', '- 概览卡片的摘要截断要与其它 harness 对齐'],
  ['inline markup', '**粗体** `query` [链接](https://example.com)'],
  ['HTML source', '<img src="example.png" onerror="alert(1)">']
] as const

beforeAll(() => {
  const style = document.createElement('style')
  style.textContent = readExcerptCss()
  document.head.append(style)
  const sheet = style.sheet
  expect(sheet, 'injected stylesheet is unavailable').not.toBeNull()
  excerptRules = collectStyleRules((sheet as CSSStyleSheet).cssRules).filter(rule =>
    rule.selectorText.includes('thread-overview-excerpt')
  )
  expect(
    excerptRules.length,
    'components.css excerpt rules did not survive CSSOM parsing'
  ).toBeGreaterThan(5)
})

afterAll(() => {
  document.head.querySelectorAll('style').forEach(element => element.remove())
})

afterEach(() => {
  cleanup()
})

describe.each(collapsedBlocks)('a collapsed %s excerpt', (_kind, content) => {
  it('renders literal text and clamps complete lines without interpreting markup', () => {
    const excerpt = renderExcerpt(content)
    const body = textBodyOf(excerpt)
    expect(body.textContent).toBe(content)
    expect(body.children).toHaveLength(0)
    expect(escapingRules(excerpt).map(rule => rule.selectorText)).not.toHaveLength(0)

    const clamped = clampMatches(excerpt)
    expect(clamped).toHaveLength(1)
    expect(clamped[0].element).toBe(body)
    const declarations = clamped[0].rule.style
    expect(declarations.getPropertyValue('display').trim()).toBe('-webkit-box')
    expect(declarations.getPropertyValue('-webkit-box-orient').trim()).toBe('vertical')
    expect(declarations.getPropertyValue('overflow').trim()).toBe('hidden')
    expect(declarations.getPropertyValue('-webkit-line-clamp').trim()).toBe('5')
  })
})

describe('a multi-block excerpt', () => {
  it('keeps newlines in one raw string with the same line clamp', () => {
    const excerpt = renderExcerpt('第一段\n\n第二段')
    const body = textBodyOf(excerpt)
    expect(body.textContent).toBe('第一段\n\n第二段')
    expect(body.children).toHaveLength(0)
    expect(clampMatches(excerpt)).toHaveLength(1)
    expect(getComputedStyle(body).whiteSpace).toBe('pre-wrap')
  })
})

describe('an excerpt whose identity grows to 1x2', () => {
  it('widens the clamp to eight lines', () => {
    const excerpt = renderExcerpt('# 概览卡片的摘要截断要与其它 harness 对齐', '1x2')
    const body = textBodyOf(excerpt)
    const clamped = clampMatches(excerpt)
    expect(clamped.map(match => match.element)).toEqual([body, body])
    expect(
      clamped.map(match => match.rule.style.getPropertyValue('-webkit-line-clamp').trim())
    ).toEqual(['5', '8'])
    expect(escapingRules(excerpt).length).toBeGreaterThan(1)
  })
})
