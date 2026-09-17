// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownBody } from '@openagent/plugin-kit/renderer'

const CHART = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n'

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

describe('Mermaid charts in MarkdownBody', () => {
  it('holds the chart back until the fence closes, then draws it', async () => {
    const view = render(<MarkdownBody content={'```mermaid\ngraph TD\n  A-->B\n'} streaming />)
    await settle()

    const openHost = view.container.querySelector('.markdown-mermaid')
    expect(openHost).not.toBeNull()
    // A half-typed fence keeps its source on screen and asks for no chart.
    expect(openHost?.querySelector('svg')).toBeNull()
    expect(openHost?.querySelector('.markdown-mermaid-source')?.textContent).toBe('graph TD\n  A-->B\n')
    // It reads as still generating rather than as a failure.
    expect(openHost?.querySelector('.markdown-mermaid-status')?.textContent).toBe('图表生成中…')

    view.rerender(<MarkdownBody content={CHART} streaming={false} />)
    await settle()

    const closedHost = await waitForSvg(view.container)
    expect(closedHost.querySelector('svg')).not.toBeNull()
    expect(closedHost.querySelector('.markdown-mermaid-source')).toBeNull()
  })

  it('reports busy from the first revision until the chart is drawn', async () => {
    const view = render(<MarkdownBody content={CHART} streaming={false} />)
    // The worker has not answered yet: nothing is committed and the surface is
    // not readable, so it must still read as busy.
    expect(view.container.querySelector('.markdown-body')).toHaveAttribute('aria-busy', 'true')

    await waitForSvg(view.container)
    expect(view.container.querySelector('.markdown-body')).toHaveAttribute('aria-busy', 'false')
  })

  it('falls back to the source when a chart cannot be drawn', async () => {
    const view = render(
      <MarkdownBody content={'```mermaid\nthis is not a diagram\n```\n'} streaming={false} />
    )
    await waitForText('图表语法有误，已回退为源码。')

    const host = view.container.querySelector('.markdown-mermaid')
    expect(host?.querySelector('svg')).toBeNull()
    expect(host?.querySelector('.markdown-mermaid-source')?.textContent).toBe('this is not a diagram\n')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(view.container.querySelector('.markdown-body')).toHaveAttribute('aria-busy', 'false')
  })

  it('draws again when a failed chart gets corrected source', async () => {
    // An unfinished fence still draws outside a stream, so this one is asked
    // for a chart and fails on it.
    const view = render(
      <MarkdownBody content={'```mermaid\ngraph TD\n  A --> '} streaming={false} />
    )
    await waitForText('图表语法有误，已回退为源码。')
    const slot = view.container.querySelector('.markdown-mermaid-figure')

    // The text only grows, so the worker repairs the same fence in place: the
    // slot keeps its identity and the chart has to notice that the source it
    // failed on is not the source it has now.
    view.rerender(<MarkdownBody content={'```mermaid\ngraph TD\n  A --> B'} streaming={false} />)
    await waitForSvg(view.container)

    expect(view.container.querySelector('.markdown-mermaid-figure')).toBe(slot)
    expect(view.container.querySelector('.markdown-mermaid-status')).toBeNull()
    expect(view.container.querySelector('.markdown-body')).toHaveAttribute('aria-busy', 'false')
  })

  it('refuses charts that would fetch while Mermaid lays them out', async () => {
    const charts = [
      // `img:` makes Mermaid request the URL during layout, before any cleanup.
      'graph TD\n  A@{ img: "http://evil.example/icon.png", label: "远程图标" }\n  A --> B[本地]\n',
      // The browser trims the padding again before it fetches, so padding the
      // value must not read as a local reference.
      'graph TD\n  A@{ img: "   https://evil.example/icon.png   ", label: "远程图标" }\n  A --> B[本地]\n',
      // A brace inside a quoted label is data to Mermaid, so the object still
      // reaches the `img:` field that follows it.
      'graph TD\n  A@{ label: "}", img: "https://evil.example/x.png" }\n  A --> B[本地]\n',
      // This diagram type resolves its icons from an online service.
      'architecture-beta\n  service api(cloud)[订单服务]\n',
      // The same, with the keyword hidden behind a directive that spans lines.
      '%%{\ninit: {}\n}%%\narchitecture-beta\n  service api(cloud)[订单服务]\n'
    ]
    const view = render(
      <>
        {charts.map((chart) => (
          <MarkdownBody key={chart} content={`\`\`\`mermaid\n${chart}\`\`\`\n`} streaming={false} />
        ))}
      </>
    )
    await waitFor(
      () => (view.container.querySelectorAll('.markdown-mermaid-status').length === charts.length ? true : null),
      'every chart to be refused'
    )

    for (const host of view.container.querySelectorAll('.markdown-mermaid')) {
      expect(host.querySelector('svg')).toBeNull()
      expect(host.querySelector('.markdown-mermaid-status')?.textContent).toBe(
        '图表需要访问外部资源，已回退为源码。'
      )
      expect(host.querySelector('.markdown-mermaid-source')).not.toBeNull()
    }
    expect(view.container.querySelector('.markdown-body')).toHaveAttribute('aria-busy', 'false')
  })

  it('draws a chart that only mentions a resource field in its text', async () => {
    // Only a resource object names a file to fetch. The same words in a comment
    // or a label are text, and reading them as a fetch would turn a local
    // diagram into a code block.
    const source = [
      'graph TD',
      '  %% 参考 img: https://docs.example/help',
      '  A["见文档, icon: https://docs.example/help"] --> B[本地]'
    ].join('\n')
    const view = render(<MarkdownBody content={`\`\`\`mermaid\n${source}\n\`\`\`\n`} streaming={false} />)
    await waitForSvg(view.container)

    expect(view.container.querySelector('.markdown-mermaid-status')).toBeNull()
    expect(view.container.querySelector('.markdown-body')).toHaveAttribute('aria-busy', 'false')
  })

  it('draws a chart whose object label mentions a resource field', async () => {
    // The field name sits in the label's prose rather than in a field of the
    // object, so the diagram stays local and must be drawn. The second case
    // opens its prose with the field name, right after the quote.
    const labels = ['见文档 img: https://docs.example/help', 'icon: https://docs.example/help']
    const view = render(
      <>
        {labels.map((label) => (
          <MarkdownBody
            key={label}
            content={`\`\`\`mermaid\ngraph TD\n  A@{ shape: rect, label: "${label}" } --> B[本地]\n\`\`\`\n`}
            streaming={false}
          />
        ))}
      </>
    )
    await waitFor(
      () => (view.container.querySelectorAll('.markdown-mermaid svg').length === labels.length ? true : null),
      'every local chart to be drawn'
    )

    for (const host of view.container.querySelectorAll('.markdown-mermaid')) {
      expect(host.querySelector('.markdown-mermaid-status')).toBeNull()
    }
    expect(view.container.querySelector('.markdown-body')).toHaveAttribute('aria-busy', 'false')
  })

  it('strips what a drawn chart tries to inject', async () => {
    const source = [
      '---',
      'config:',
      '  securityLevel: loose',
      '  htmlLabels: true',
      '  themeCSS: "body { display: none !important }"',
      '---',
      'graph TD',
      '  A[入口] --> B[下单]',
      '  click A "javascript:window.oaClicked = true"',
      '  click B href "http://evil.example/leak.png" "外链"'
    ].join('\n')
    const view = render(<MarkdownBody content={`\`\`\`mermaid\n${source}\n\`\`\`\n`} streaming={false} />)
    const host = await waitForSvg(view.container)
    const svg = host.querySelector('svg') as SVGElement

    expect(svg.querySelectorAll('script, foreignObject, image')).toHaveLength(0)
    const attributes = [...svg.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].map((attribute) => `${element.tagName.toLowerCase()}.${attribute.name}=${attribute.value}`)
    )
    expect(attributes.filter((value) => /\son[a-z]+=/i.test(` ${value}`))).toEqual([])
    expect(attributes.filter((value) => /(?:href|src)=https?:/i.test(value))).toEqual([])
    // The frontmatter asked for `display: none` on the host document.
    expect(document.body.getAttribute('style')).toBe(null)

    fireEvent.click(svg.querySelector('.node') as Element)
    expect('oaClicked' in window).toBe(false)
  })

  it('keeps the top bar to the mark, the view toggle and the copy action', async () => {
    const view = render(<MarkdownBody content={CHART} streaming={false} />)
    await waitForSvg(view.container)

    const toolbar = view.container.querySelector('.markdown-mermaid-toolbar')
    expect(toolbar?.querySelector('.markdown-mermaid-label')?.textContent).toBe('Mermaid 图表')
    const actions = [...(toolbar?.querySelectorAll('button') ?? [])].map((button) => button.textContent)
    expect(actions).toEqual(['图表源码', '复制源码'])
    // Sizing lives with the chart, not in the top bar.
    expect(view.container.querySelector('.markdown-mermaid-viewbar button')?.textContent).toBe('原始大小')
  })

  it('switches between the chart and its source and copies the source', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const view = render(<MarkdownBody content={CHART} streaming={false} />)
    await waitForSvg(view.container)

    fireEvent.click(screen.getByRole('button', { name: '图表源码' }))
    expect(view.container.querySelector('.markdown-mermaid-source')?.textContent).toBe(
      'graph TD\n  A[Start] --> B[End]\n'
    )
    expect(screen.getByRole('button', { name: '图表' })).toHaveAttribute('aria-pressed', 'true')
    // The canvas keeps its drawing while the source view is up.
    expect(view.container.querySelector('svg')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '复制源码' }))
    await act(async () => {})
    expect(writeText).toHaveBeenCalledWith('graph TD\n  A[Start] --> B[End]\n')
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument()
  })

  it('keeps the chart in place while later blocks stream in after it', async () => {
    const view = render(<MarkdownBody content={CHART} streaming={false} />)
    const host = await waitForSvg(view.container)
    const chart = host.querySelector('svg')

    view.rerender(<MarkdownBody content={`${CHART}\nappended paragraph\n`} streaming />)
    await settle()

    expect(view.container.querySelectorAll('.markdown-mermaid')).toHaveLength(1)
    expect(view.container.querySelector('.markdown-mermaid svg')).toBe(chart)
    expect(view.container.querySelector('.markdown-body')?.textContent).toContain('appended paragraph')
  })

  it('drops a replaced chart host instead of leaving it behind', async () => {
    const view = render(<MarkdownBody content={CHART} streaming={false} />)
    await waitForSvg(view.container)

    view.rerender(<MarkdownBody content="no charts here" streaming={false} />)
    await settle()

    expect(view.container.querySelectorAll('.markdown-mermaid')).toHaveLength(0)
    expect(view.container.querySelector('.markdown-body')?.textContent).toBe('no charts here')
  })

  it('leaves nothing behind when a chart is replaced mid-render', async () => {
    // A wide graph takes real time to lay out, so the replacement below lands
    // while the first render is still in flight.
    const heavy = `\`\`\`mermaid\ngraph LR\n${Array.from(
      { length: 60 },
      (_, index) => `  n${index} --> n${(index + 1) % 60}`
    ).join('\n')}\n\`\`\`\n`
    const view = render(<MarkdownBody content={heavy} streaming={false} />)
    // Replaced on the first revision, before the chart can have been drawn.
    view.rerender(<MarkdownBody content="a replacement with no chart" streaming={false} />)
    await settle()

    expect(view.container.querySelectorAll('.markdown-mermaid')).toHaveLength(0)
    expect(view.container.querySelector('.markdown-body svg')).toBeNull()
    expect(view.container.querySelector('.markdown-body')?.textContent).toBe('a replacement with no chart')
    expect(view.container.querySelector('.markdown-body')).toHaveAttribute('aria-busy', 'false')
  })

  it('draws every chart when several messages are on screen at once', async () => {
    const view = render(
      <>
        <MarkdownBody content={CHART} streaming={false} />
        <MarkdownBody content={CHART.replace('Start', 'Second')} streaming={false} />
        <MarkdownBody content={CHART.replace('Start', 'Third')} streaming={false} />
      </>
    )
    await waitFor(
      () => (view.container.querySelectorAll('.markdown-mermaid svg').length === 3 ? true : null),
      'all three charts to be drawn'
    )

    for (const host of view.container.querySelectorAll('.markdown-mermaid')) {
      expect(host.querySelector('svg')).not.toBeNull()
      expect(host.querySelector('.markdown-mermaid-status')).toBeNull()
    }
  })

  it('leaves mermaid fences as code where charts are turned off', async () => {
    const view = render(<MarkdownBody content={CHART} streaming={false} mermaid={false} />)
    await settle()

    expect(view.container.querySelectorAll('.markdown-mermaid')).toHaveLength(0)
    expect(view.container.querySelector('pre code')?.textContent).toBe('graph TD\n  A[Start] --> B[End]\n')
    expect(view.container.querySelector('.markdown-body')).toHaveAttribute('aria-busy', 'false')
  })

  it('re-decides its fences when charts are turned on or off in place', async () => {
    const view = render(<MarkdownBody content={CHART} streaming={false} />)
    await waitForSvg(view.container)

    // The content never changes here: only the option does, which is what a
    // settings toggle does to a message already on screen.
    view.rerender(<MarkdownBody content={CHART} streaming={false} mermaid={false} />)
    await settle()
    expect(view.container.querySelectorAll('.markdown-mermaid')).toHaveLength(0)
    expect(view.container.querySelector('pre code')?.textContent).toBe('graph TD\n  A[Start] --> B[End]\n')

    view.rerender(<MarkdownBody content={CHART} streaming={false} />)
    await waitForSvg(view.container)
    expect(view.container.querySelectorAll('.markdown-mermaid')).toHaveLength(1)
  })

  it('names a chart for assistive technology', async () => {
    const view = render(<MarkdownBody content={CHART} streaming={false} />)
    await waitForSvg(view.container)

    const svg = view.container.querySelector('.markdown-mermaid svg')
    expect(svg).toHaveAttribute('role', 'img')
    expect(svg).toHaveAttribute('aria-label', 'Mermaid 图表')
  })

  it("keeps a chart's own accessible title when its source declares one", async () => {
    const view = render(
      <MarkdownBody
        content={'```mermaid\ngraph TD\n  accTitle: 下单流程\n  accDescr: 从下单到发货\n  A-->B\n```\n'}
        streaming={false}
      />
    )
    await waitForSvg(view.container)

    const svg = view.container.querySelector('.markdown-mermaid svg')
    // Mermaid's own naming wins; the generic fallback must not shadow it.
    expect(svg?.querySelector(':scope > title')?.textContent).toBe('下单流程')
    expect(svg?.hasAttribute('aria-label')).toBe(false)
  })

  it('draws every diagram type the first version promises', async () => {
    const diagrams = [
      'graph TD\n  A[开始] --> B{验证}\n  B -->|通过| C[结束]\n',
      'sequenceDiagram\n  participant A as 客户端\n  participant B as 服务端\n  A->>B: 请求\n  B-->>A: 响应\n',
      'classDiagram\n  class 订单 {\n    +提交()\n  }\n  订单 --> 支付\n',
      'stateDiagram-v2\n  [*] --> 待处理\n  待处理 --> 已完成\n',
      'erDiagram\n  客户 ||--o{ 订单 : 下单\n'
    ]
    const view = render(
      <>
        {diagrams.map((diagram) => (
          <MarkdownBody key={diagram} content={`\`\`\`mermaid\n${diagram}\`\`\`\n`} streaming={false} />
        ))}
      </>
    )
    await waitFor(
      () => (view.container.querySelectorAll('.markdown-mermaid svg').length === diagrams.length ? true : null),
      'all five diagram types to be drawn'
    )

    for (const host of view.container.querySelectorAll('.markdown-mermaid')) {
      expect(host.querySelector('.markdown-mermaid-status')).toBeNull()
      expect(host.querySelector('svg')?.textContent).toBeTruthy()
    }
  })

  it('re-renders from scratch when streamed content is replaced by something shorter', async () => {
    const view = render(<MarkdownBody content={'first draft\n\nsecond line\n'} streaming />)
    await settle()

    view.rerender(<MarkdownBody content="second line\n" streaming />)
    await settle()

    const text = view.container.querySelector('.markdown-body')?.textContent ?? ''
    expect(text).toContain('second line')
    expect(text).not.toContain('first draft')
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

async function waitForText(text: string): Promise<void> {
  await waitFor(() => (screen.queryByText(text) ? true : null), `the text ${text}`)
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
