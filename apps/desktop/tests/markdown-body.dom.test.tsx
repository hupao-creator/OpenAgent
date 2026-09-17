// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownBody, RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { getStreamingMarkdownCadence } from '../../../packages/openagent-plugin-kit/src/renderer/hooks/useStreamingCadence'
import type { MarkdownRenderTelemetry } from '../../../packages/openagent-plugin-kit/src/renderer/markdown/useIncrementalMarkdownDom'

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

describe('MarkdownBody incremental rendering', () => {
  it('shows the first token without cadence delay and publishes the trailing value', async () => {
    const telemetry: MarkdownRenderTelemetry[] = []
    const view = render(
      <MarkdownBody content="" streaming onRenderTelemetry={(value) => telemetry.push(value)} />
    )
    await flushRendering()

    view.rerender(
      <MarkdownBody content="first" streaming onRenderTelemetry={(value) => telemetry.push(value)} />
    )
    await flushRendering()
    expect(screen.getByText('first')).toBeInTheDocument()
    const leadingCount = telemetry.length

    view.rerender(
      <MarkdownBody
        content="first trailing"
        streaming
        onRenderTelemetry={(value) => telemetry.push(value)}
      />
    )
    await flushRendering()
    expect(screen.queryByText('first trailing')).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(getStreamingMarkdownCadence('first trailing'.length)))
    await flushRendering()
    expect(screen.getByText('first trailing')).toBeInTheDocument()
    expect(telemetry.length).toBe(leadingCount + 1)
  })

  it('renders final content without a cadence timer and rejects stale work after a switch', async () => {
    const view = render(<MarkdownBody content="old" streaming />)
    await flushRendering()
    view.rerender(<MarkdownBody content="old pending" streaming />)
    view.rerender(<MarkdownBody content="new **message**" streaming />)
    await flushRendering()
    expect(screen.getByText('message').tagName).toBe('STRONG')

    view.rerender(<MarkdownBody content="final **complete**" streaming={false} />)
    await flushRendering()
    act(() => vi.runAllTimers())
    await flushRendering()
    expect(screen.queryByText('old pending')).not.toBeInTheDocument()
    expect(screen.getByText('complete').tagName).toBe('STRONG')
  })

  it('cancels work on unmount and survives StrictMode effect replay', async () => {
    const telemetry = vi.fn()
    const view = render(
      <StrictMode>
        <MarkdownBody content="strict" streaming onRenderTelemetry={telemetry} />
      </StrictMode>
    )
    await flushRendering()
    view.rerender(
      <StrictMode>
        <MarkdownBody content="strict trailing" streaming onRenderTelemetry={telemetry} />
      </StrictMode>
    )
    act(() => vi.advanceTimersByTime(getStreamingMarkdownCadence('strict trailing'.length)))
    await flushRendering()
    expect(screen.getByText('strict trailing')).toBeInTheDocument()

    const beforeUnmount = telemetry.mock.calls.length
    view.rerender(
      <StrictMode>
        <MarkdownBody content="strict pending" streaming onRenderTelemetry={telemetry} />
      </StrictMode>
    )
    view.unmount()
    act(() => vi.runAllTimers())
    await Promise.resolve()
    expect(telemetry).toHaveBeenCalledTimes(beforeUnmount)
  })

  it('restarts streaming without replacing an unchanged settled DOM', async () => {
    const view = render(<MarkdownBody content="settled text" streaming={false} />)
    await flushRendering()
    const paragraph = screen.getByText('settled text')

    view.rerender(<MarkdownBody content="settled text" streaming />)
    await flushRendering()
    expect(screen.getByText('settled text')).toBe(paragraph)

    view.rerender(<MarkdownBody content="settled text appended" streaming />)
    act(() => vi.advanceTimersByTime(getStreamingMarkdownCadence('settled text appended'.length)))
    await flushRendering()
    expect(screen.getByText('settled text appended')).toBe(paragraph)
  })

  it('preserves links, GFM tables/code, selection, scroll, and composition during append', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const markdown = [
      '# Result',
      '',
      '| name | value |',
      '| --- | --- |',
      '| alpha | `const x = 1` |',
      '',
      '[Open docs](https://example.com/docs)',
      '',
      'select this text'
    ].join('\n')
    const { container, rerender } = render(<MarkdownBody content={markdown} streaming />, {
      wrapper: ({ children }) => <RendererCapabilitiesProvider capabilities={{ openExternal }}>
        {children}
      </RendererCapabilitiesProvider>
    })
    await flushRendering()

    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(container.querySelector('code')).toHaveTextContent('const x = 1')
    fireEvent.click(screen.getByRole('link', { name: 'Open docs' }))
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs')

    const body = container.querySelector('.markdown-body') as HTMLElement
    const paragraph = screen.getByText('select this text')
    const text = paragraph.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 6)
    const selection = window.getSelection() as Selection
    selection.removeAllRanges()
    selection.addRange(range)
    body.scrollTop = 240
    const compositionStart = vi.fn()
    const compositionEnd = vi.fn()
    body.addEventListener('compositionstart', compositionStart)
    body.addEventListener('compositionend', compositionEnd)
    fireEvent.compositionStart(body, { data: '拼' })

    rerender(<MarkdownBody content={`${markdown}\n\npending`} streaming />)
    act(() => vi.advanceTimersByTime(getStreamingMarkdownCadence(markdown.length + 9)))
    await flushRendering()
    expect(screen.getByText('select this text')).toBe(paragraph)
    expect(selection.toString()).toBe('select')
    expect(body.scrollTop).toBe(240)
    fireEvent.compositionEnd(body, { data: '拼音' })
    expect(compositionStart).toHaveBeenCalledOnce()
    expect(compositionEnd).toHaveBeenCalledOnce()
  })

  it('matches settled ReactMarkdown DOM including references, HTML text, and safe URLs', async () => {
    const markdown = [
      '# Heading',
      '',
      '- [x] done',
      '- [ ] pending',
      '',
      '| a | b |',
      '| :- | -: |',
      '| one | two |',
      '',
      '[reference][ref] and [unsafe](javascript:alert(1))',
      '',
      '[ref]: https://example.com "Example"',
      '',
      '<span>raw html stays text</span>',
      '',
      '```ts',
      'const value = 1',
      '```'
    ].join('\n')
    const settled = render(<MarkdownBody content={markdown} streaming={false} />)
    await flushRendering()
    render(
      <div data-testid="direct">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    )

    const actual = settled.container.querySelector('.markdown-body') as HTMLElement
    const expected = screen.getByTestId('direct')
    expect(actual.childNodes).toHaveLength(expected.childNodes.length)
    expect(
      Array.from(actual.childNodes).every((node, index) => node.isEqualNode(expected.childNodes[index]))
    ).toBe(true)
    const unsafe = Array.from(actual.querySelectorAll('a')).find(
      (link) => link.textContent === 'unsafe'
    ) as HTMLAnchorElement
    expect(fireEvent.click(unsafe)).toBe(false)
    expect(window.openAgent).toBeUndefined()
  })

  it('uses scoped host navigation and updates it without a Desktop global', async () => {
    const firstHost = vi.fn()
    const secondHost = vi.fn()
    const view = render(<>
      <RendererCapabilitiesProvider capabilities={{ openExternal: firstHost }}>
        <MarkdownBody content="[First host](https://first.example)" streaming={false} />
      </RendererCapabilitiesProvider>
      <RendererCapabilitiesProvider capabilities={{ openExternal: secondHost }}>
        <MarkdownBody content="[Second host](https://second.example)" streaming={false} />
      </RendererCapabilitiesProvider>
    </>)
    await flushRendering()
    fireEvent.click(screen.getByRole('link', { name: 'First host' }))
    fireEvent.click(screen.getByRole('link', { name: 'Second host' }))
    expect(firstHost).toHaveBeenCalledExactlyOnceWith('https://first.example')
    expect(secondHost).toHaveBeenCalledExactlyOnceWith('https://second.example')

    view.rerender(<>
      <RendererCapabilitiesProvider capabilities={{ openExternal: secondHost }}>
        <MarkdownBody content="[Updated host](https://updated.example)" streaming={false} />
      </RendererCapabilitiesProvider>
      <RendererCapabilitiesProvider capabilities={{ openExternal: secondHost }}>
        <MarkdownBody content="[Second host](https://second.example)" streaming={false} />
      </RendererCapabilitiesProvider>
    </>)
    await flushRendering()
    fireEvent.click(screen.getByRole('link', { name: 'Updated host' }))
    expect(secondHost).toHaveBeenLastCalledWith('https://updated.example')
    expect(firstHost).toHaveBeenCalledTimes(1)
    expect(window.openAgent).toBeUndefined()
  })

  it('preserves browser link navigation when no host capability is installed', async () => {
    const nativeClick = vi.fn((event: React.MouseEvent) => {
      expect(event.defaultPrevented).toBe(false)
      // Stop jsdom navigation after observing the Markdown component's behavior.
      event.preventDefault()
    })
    render(<div onClick={nativeClick}>
      <MarkdownBody content="[Browser docs](https://example.com/docs)" streaming={false} />
    </div>)
    await flushRendering()
    fireEvent.click(screen.getByRole('link', { name: 'Browser docs' }))
    expect(nativeClick).toHaveBeenCalledOnce()
    expect(window.openAgent).toBeUndefined()
  })

  it('matches ReactMarkdown DOM when container definitions change reference links and images', async () => {
    const corpus = [
      {
        prefix: '[x]\n\n> ',
        final: '[x]\n\n> [x]: /'
      },
      {
        prefix: '[link][target] and ![image][asset]\n\n- item\n  ',
        final:
          '[link][target] and ![image][asset]\n\n- item\n  [target]: /list-link\n  [asset]: /list-image.png\n'
      },
      {
        prefix:
          '> [target]: /early-link\n> [asset]: /early-image.png\n\nclosed paragraph\n\n',
        final:
          '> [target]: /early-link\n> [asset]: /early-image.png\n\nclosed paragraph\n\n[link][target] and ![image][asset]\n'
      },
      {
        prefix: '[link][target] and ![image][asset]\n\n> > ',
        final:
          '[link][target] and ![image][asset]\n\n> > [target]: /nested-link\n> > [asset]: /nested-image.png\n'
      }
    ]

    for (const { prefix, final } of corpus) {
      const incremental = render(<MarkdownBody content={prefix} streaming />)
      await flushRendering()
      incremental.rerender(<MarkdownBody content={final} streaming />)
      act(() => vi.advanceTimersByTime(getStreamingMarkdownCadence(final.length)))
      await flushRendering()

      const direct = render(
        <div className="markdown-body" aria-busy="false">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{final}</ReactMarkdown>
        </div>
      )
      const actual = incremental.container.querySelector('.markdown-body') as HTMLElement
      const expected = direct.container.querySelector('.markdown-body') as HTMLElement
      expect(actual.isEqualNode(expected)).toBe(true)

      incremental.unmount()
      direct.unmount()
    }
  })
})
