// @vitest-environment jsdom
// A9: the harnesses do not each wire Mermaid up themselves — Codex, Pi and Bart
// render through `ThreadTimelineMarkdown` and Claude through its Markdown
// primitive, and both delegate to the shared `MarkdownBody`. Rendering those
// entry points is what proves a chart reaches a real Thread, as opposed to the
// `MarkdownBody` test proving only that the seam works when called directly.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadCardExcerpt, ThreadTimelineMarkdown } from '@openagent/plugin-kit/renderer'
import { Markdown as ClaudeMarkdown } from '../../../packages/harness-claude/src/renderer/primitives'

const CHART = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n'
const OPEN_CHART = '```mermaid\ngraph TD\n  A-->B\n'

beforeEach(() => {
  // Mermaid measures text through SVG geometry APIs jsdom does not implement.
  Object.assign(SVGElement.prototype, {
    getBBox: () => ({ x: 0, y: 0, width: 120, height: 20 }),
    getComputedTextLength: () => 120,
    getScreenCTM: () => null
  })
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0)
  )
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle))
  vi.stubGlobal('openAgent', undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Mermaid through the harness entry points', () => {
  it('draws a chart inside the shared timeline markdown Codex, Pi and Bart use', async () => {
    const view = render(<ThreadTimelineMarkdown>{CHART}</ThreadTimelineMarkdown>)
    await waitForSvg(view.container)

    const host = view.container.querySelector('.markdown-mermaid')
    expect(host?.querySelector('svg')).not.toBeNull()
    expect(host?.querySelector('.markdown-mermaid-status')).toBeNull()
    expect(view.container.querySelector('.markdown-body')).toHaveAttribute('aria-busy', 'false')
  })

  it('holds a streaming turn back and labels the open fence as still generating', async () => {
    const view = render(<ThreadTimelineMarkdown streaming>{OPEN_CHART}</ThreadTimelineMarkdown>)
    await settle()

    const host = view.container.querySelector('.markdown-mermaid')
    expect(host?.querySelector('svg')).toBeNull()
    expect(host?.querySelector('.markdown-mermaid-source')?.textContent).toBe('graph TD\n  A-->B\n')
    expect(host?.querySelector('.markdown-mermaid-status')?.textContent).toBe('图表生成中…')
    // An unfinished fence is a settled fallback, not an unsettled surface.
    expect(view.container.querySelector('.markdown-body')).toHaveAttribute('aria-busy', 'false')

    view.rerender(<ThreadTimelineMarkdown>{CHART}</ThreadTimelineMarkdown>)
    await waitForSvg(view.container)
    expect(view.container.querySelector('.markdown-mermaid-status')).toBeNull()
  })

  it("draws a chart in the Claude renderer's markdown primitive", async () => {
    const view = render(<ClaudeMarkdown content={CHART} streaming={false} />)
    await waitForSvg(view.container)

    expect(view.container.querySelector('.markdown-mermaid svg')).not.toBeNull()
  })

  it('keeps the entire raw fence as literal text in an overview excerpt', async () => {
    const view = render(<ThreadCardExcerpt content={CHART} />)
    await settle()

    expect(view.container.querySelectorAll('.markdown-mermaid')).toHaveLength(0)
    expect(view.container.querySelector('.thread-card-excerpt-text')?.textContent).toBe(CHART)
    expect(view.container.querySelector('pre, code, .markdown-body')).toBeNull()
  })
})

async function settle(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await act(async () => {
      await Promise.resolve()
      await vi.dynamicImportSettled()
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

async function waitForSvg(container: HTMLElement): Promise<Element> {
  return waitFor(
    () => container.querySelector('.markdown-mermaid svg')?.closest('.markdown-mermaid') ?? null,
    'the chart to be drawn'
  )
}

async function waitFor<T>(read: () => T | null, description: string, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await settle()
  }
}
