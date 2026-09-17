// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownBody } from '@openagent/plugin-kit/renderer'
import { IncrementalMarkdownProcessor } from '../../../packages/openagent-plugin-kit/src/renderer/markdown/incremental-markdown'
import type { MarkdownWorkerRequest, MarkdownWorkerResponse } from '../../../packages/openagent-plugin-kit/src/renderer/markdown/markdown-worker-types'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('keeps newer Markdown busy after a stale worker error until its own response completes', () => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0))
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle))
  const requests: Extract<MarkdownWorkerRequest, { type: 'render' }>[] = []
  const worker = {
    onmessage: null as ((event: { data: MarkdownWorkerResponse }) => void) | null,
    postMessage(request: MarkdownWorkerRequest) { if (request.type === 'render') requests.push(request) }
  }
  vi.stubGlobal('Worker', vi.fn(function () { return worker }))
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const view = render(<MarkdownBody content="old page" streaming={false} />)
  const old = requests.at(-1)!
  view.rerender(<MarkdownBody content="new **page**" streaming={false} />)
  const current = requests.at(-1)!
  const body = view.container.querySelector('.markdown-body')!

  act(() => worker.onmessage?.({ data: { type: 'error', clientId: old.clientId, revision: old.revision, message: 'late failure' } }))
  expect(body.getAttribute('aria-busy')).toBe('true')
  const rendered = new IncrementalMarkdownProcessor().render(current.content, current.reset)
  act(() => {
    worker.onmessage?.({ data: { ...rendered, type: 'rendered', clientId: current.clientId, revision: current.revision, reset: current.reset } })
    vi.runAllTimers()
  })
  expect(body.textContent).toBe('new page')
  expect(body.getAttribute('aria-busy')).toBe('false')

  view.rerender(<MarkdownBody content="failing page" streaming={false} />)
  const failing = requests.at(-1)!
  expect(body.getAttribute('aria-busy')).toBe('true')
  act(() => worker.onmessage?.({ data: { type: 'error', clientId: failing.clientId, revision: failing.revision, message: 'current failure' } }))
  expect(body.getAttribute('aria-busy')).toBe('false')
  expect(error).toHaveBeenCalledWith('Incremental Markdown worker failed:', 'current failure')
})
