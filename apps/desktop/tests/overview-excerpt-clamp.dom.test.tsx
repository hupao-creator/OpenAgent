// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadCardExcerpt } from '../../../packages/openagent-plugin-kit/src/renderer/harness-card/card'

/**
 * 四行裁剪是一份 DOM 契约而不是像素效果：excerpt 把裁剪交给唯一的那块元素，只有
 * 在这条规则生效时才放弃自己的 max-height 硬切。jsdom 不做排版，所以这里把随包
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

async function flushRendering(): Promise<void> {
  for (let pass = 0; pass < 5; pass += 1) {
    await act(async () => {
      await Promise.resolve()
      await vi.dynamicImportSettled()
      vi.advanceTimersByTime(0)
      await Promise.resolve()
    })
  }
}

async function renderExcerpt(content: string, identitySize?: '1x2'): Promise<Element> {
  const view = render(
    identitySize
      ? <div className="thread-card-identity" data-identity-size={identitySize}>
          <ThreadCardExcerpt content={content} />
        </div>
      : <ThreadCardExcerpt content={content} />
  )
  await flushRendering()
  const excerpt = view.container.querySelector('.thread-overview-excerpt')
  if (!excerpt) throw new Error('excerpt did not render')
  return excerpt
}

function markdownBodyOf(excerpt: Element): Element {
  const body = excerpt.querySelector(':scope > .markdown-body')
  if (!body) throw new Error('excerpt has no direct .markdown-body child')
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
  ['list', '- 概览卡片的摘要截断要与其它 harness 对齐']
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

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0)
  )
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle))
  vi.stubGlobal('openAgent', undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe.each(collapsedBlocks)('a collapsed %s excerpt', (_kind, content) => {
  it('line-clamps its sole block instead of hard-cutting the excerpt box', async () => {
    const excerpt = await renderExcerpt(content)
    const body = markdownBodyOf(excerpt)
    expect(body.children).toHaveLength(1)
    expect(escapingRules(excerpt).map(rule => rule.selectorText)).not.toHaveLength(0)

    const clamped = clampMatches(excerpt)
    expect(clamped).toHaveLength(1)
    expect(clamped[0].element).toBe(body.firstElementChild)
    const declarations = clamped[0].rule.style
    expect(declarations.getPropertyValue('display').trim()).toBe('-webkit-box')
    expect(declarations.getPropertyValue('-webkit-box-orient').trim()).toBe('vertical')
    expect(declarations.getPropertyValue('overflow').trim()).toBe('hidden')
    expect(declarations.getPropertyValue('-webkit-line-clamp').trim()).toBe('4')
  })
})

describe('a multi-block excerpt', () => {
  it('stays with the container max-height clip', async () => {
    const excerpt = await renderExcerpt('第一段\n\n第二段')
    expect(markdownBodyOf(excerpt).children).toHaveLength(2)
    expect(escapingRules(excerpt)).toHaveLength(0)
    expect(clampMatches(excerpt)).toHaveLength(0)
  })
})

describe('an excerpt whose identity grows to 1x2', () => {
  it('widens the clamp to eight lines', async () => {
    const excerpt = await renderExcerpt('# 概览卡片的摘要截断要与其它 harness 对齐', '1x2')
    const body = markdownBodyOf(excerpt)
    const clamped = clampMatches(excerpt)
    expect(clamped.map(match => match.element)).toEqual([body.firstElementChild, body.firstElementChild])
    expect(
      clamped.map(match => match.rule.style.getPropertyValue('-webkit-line-clamp').trim())
    ).toEqual(['4', '8'])
    expect(escapingRules(excerpt).length).toBeGreaterThan(1)
  })
})
