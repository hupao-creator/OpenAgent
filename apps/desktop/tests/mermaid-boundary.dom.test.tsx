// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, MarkdownBody } from '@openagent/plugin-kit/renderer'

// A chart that throws while rendering must not take the message down with it.
const behaviour = vi.hoisted(() => ({ throwing: new Set<string>(), mounts: [] as string[] }))

vi.mock(
  '../../../packages/openagent-plugin-kit/dist/renderer/markdown/MermaidBlock.js',
  async () => {
    const { useEffect } = await import('react')
    return {
      default: function MockMermaidBlock({ source }: { source: string }): null {
        useEffect(() => {
          behaviour.mounts.push(source)
        }, [])
        if ([...behaviour.throwing].some((marker) => source.includes(marker))) {
          throw new Error('chart failed to render')
        }
        return null
      }
    }
  }
)

/** The fence's own source arrives with the trailing newline the block holds. */
const BROKEN = 'A[Start]'
const HEALTHY = 'C[Done]'
const CHART = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n'
const BOTH = `${CHART}\n\`\`\`mermaid\ngraph TD\n  B[End] --> C[Done]\n\`\`\`\n`

beforeEach(() => {
  behaviour.throwing = new Set([BROKEN])
  behaviour.mounts = []
  vi.stubGlobal('openAgent', undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('a chart component that throws', () => {
  it('keeps the failure inside its own slot and settles the message', async () => {
    const view = render(<MarkdownBody content={CHART} streaming={false} />)

    await waitFor(() => {
      expect(view.container.querySelector('.markdown-mermaid-status')?.textContent).toBe(
        '图表组件出错，已回退为源码。'
      )
    })
    // The fence stays readable, and the message is not left waiting on a chart
    // that will never report.
    expect(view.container.querySelector('.markdown-mermaid-source')?.textContent).toBe(
      'graph TD\n  A[Start] --> B[End]\n'
    )
    expect(view.container.querySelector('.markdown-body')).toHaveAttribute('aria-busy', 'false')
  })

  it('mounts the chart again when the retry is clicked', async () => {
    const view = render(<MarkdownBody content={CHART} streaming={false} />)
    await waitFor(() => {
      expect(view.container.querySelector('.markdown-mermaid-status')).not.toBeNull()
    })

    behaviour.throwing.clear()
    screen.getByRole('button', { name: '重试' }).click()

    // The boundary is remounted rather than cleared in place, so the chart gets
    // a fresh render instead of the failure state it already holds.
    await waitFor(() => {
      expect(view.container.querySelector('.markdown-mermaid-status')).toBeNull()
    })
  })

  it('remounts only the chart that failed', async () => {
    const view = render(<MarkdownBody content={BOTH} streaming={false} />)
    await waitFor(() => {
      expect(view.container.querySelector('.markdown-mermaid-status')).not.toBeNull()
    })
    const before = behaviour.mounts.filter((source) => source.includes(HEALTHY)).length

    behaviour.throwing.clear()
    screen.getByRole('button', { name: '重试' }).click()
    await waitFor(() => {
      expect(view.container.querySelector('.markdown-mermaid-status')).toBeNull()
    })

    // Remounting the other chart would drop its drawn SVG and send it back
    // through the render queue behind this one.
    expect(behaviour.mounts.filter((source) => source.includes(HEALTHY)).length).toBe(before)
  })

  it('falls back to English copy for an en-US reader', async () => {
    const view = render(
      <I18nProvider locale="en-US">
        <MarkdownBody content={CHART} streaming={false} />
      </I18nProvider>
    )
    await waitFor(() => {
      expect(view.container.querySelector('.markdown-mermaid-status')).not.toBeNull()
    })

    expect(view.container.querySelector('.markdown-mermaid-status')?.textContent).toBe(
      'The chart component failed. Showing source instead.'
    )
    expect(view.container.innerHTML).not.toMatch(/[\u3400-\u9fff]/u)
  })
})
