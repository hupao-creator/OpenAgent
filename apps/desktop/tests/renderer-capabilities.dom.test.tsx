// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RendererCapabilitiesProvider,
  useRendererFirstCommitDiagnostics
} from '@openagent/plugin-kit/renderer'

type DiagnosticInput = Parameters<typeof useRendererFirstCommitDiagnostics>[0]

function DiagnosticProbe(props: DiagnosticInput): null {
  useRendererFirstCommitDiagnostics(props)
  return null
}

const initialInput: DiagnosticInput = {
  threadId: 'thread-1',
  executionId: 'execution-1',
  active: true,
  hasReasoning: false,
  hasText: false
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('openAgent', undefined)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0)
  )
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('independent renderer capabilities', () => {
  it('reports first reasoning and final text once to its injected host under StrictMode', () => {
    const report = vi.fn()
    const view = render(<DiagnosticProbe {...initialInput} />, {
      wrapper: ({ children }) => <StrictMode>
        <RendererCapabilitiesProvider capabilities={{ reportRendererFirstCommit: report }}>
          {children}
        </RendererCapabilitiesProvider>
      </StrictMode>
    })
    view.rerender(<DiagnosticProbe {...initialInput} hasReasoning />)
    act(() => vi.runAllTimers())
    view.rerender(<DiagnosticProbe {...initialInput} active={false} hasReasoning hasText />)
    act(() => vi.runAllTimers())
    expect(report.mock.calls.map(([input]) => input.kind)).toEqual(['reasoning', 'text'])
    expect(report).toHaveBeenLastCalledWith({
      kind: 'text', threadId: 'thread-1', executionId: 'execution-1', durationMs: expect.any(Number)
    })
    view.rerender(<DiagnosticProbe {...initialInput} hasReasoning hasText />)
    act(() => vi.runAllTimers())
    expect(report).toHaveBeenCalledTimes(2)
    expect(window.openAgent).toBeUndefined()
  })

  it('ignores completed history and cancels stale frames when execution changes or unmounts', () => {
    const report = vi.fn()
    const view = render(<DiagnosticProbe {...initialInput} active={false} hasText />, {
      wrapper: ({ children }) => <RendererCapabilitiesProvider capabilities={{ reportRendererFirstCommit: report }}>
        {children}
      </RendererCapabilitiesProvider>
    })
    act(() => vi.runAllTimers())
    expect(report).not.toHaveBeenCalled()
    view.rerender(<DiagnosticProbe {...initialInput} hasText />)
    view.rerender(<DiagnosticProbe {...initialInput} executionId="execution-2" hasReasoning />)
    act(() => vi.runAllTimers())
    expect(report).toHaveBeenCalledExactlyOnceWith({
      kind: 'reasoning', threadId: 'thread-1', executionId: 'execution-2', durationMs: expect.any(Number)
    })
    view.rerender(<DiagnosticProbe {...initialInput} executionId="execution-2" hasReasoning hasText />)
    view.unmount()
    act(() => vi.runAllTimers())
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('scopes diagnostic sinks to each independent host', () => {
    const firstHost = vi.fn()
    const secondHost = vi.fn()
    render(<>
      <RendererCapabilitiesProvider capabilities={{ reportRendererFirstCommit: firstHost }}>
        <DiagnosticProbe {...initialInput} hasText />
      </RendererCapabilitiesProvider>
      <RendererCapabilitiesProvider capabilities={{ reportRendererFirstCommit: secondHost }}>
        <DiagnosticProbe {...initialInput} threadId="thread-2" hasText />
      </RendererCapabilitiesProvider>
    </>)
    act(() => vi.runAllTimers())
    expect(firstHost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ threadId: 'thread-1' }))
    expect(secondHost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ threadId: 'thread-2' }))
  })

  it('does not schedule diagnostic work without an installed sink', () => {
    render(<DiagnosticProbe {...initialInput} hasReasoning hasText />)
    expect(vi.getTimerCount()).toBe(0)
    expect(window.openAgent).toBeUndefined()
  })
})
