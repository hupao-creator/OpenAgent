// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTextSwap } from '../../../packages/openagent-plugin-kit/src/renderer/harness-card/text-swap'

function Probe({ title }: { title: React.ReactNode }): React.JSX.Element {
  const swap = useTextSwap<HTMLHeadingElement>(title)
  return <h2 ref={swap.ref} className={swap.className || undefined}>{swap.content}</h2>
}

function swapDuration(value: string): void {
  vi.stubGlobal('getComputedStyle', () => ({ transitionDuration: value }) as CSSStyleDeclaration)
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('title text swap', () => {
  it('holds the outgoing title until the incoming one is ready', async () => {
    vi.useFakeTimers()
    swapDuration('0.15s')
    const view = render(<Probe title="首次标题" />)
    const heading = (): HTMLHeadingElement => view.container.querySelector('h2')!
    expect(heading().textContent).toBe('首次标题')

    view.rerender(<Probe title="重新设计的数据库查询计划器" />)
    expect(heading().textContent).toBe('首次标题')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(heading().textContent).toBe('重新设计的数据库查询计划器')
  })

  it('replaces the title in the same commit when the stylesheet gives no duration', () => {
    swapDuration('0s')
    const view = render(<Probe title="首次标题" />)
    view.rerender(<Probe title="重新设计的数据库查询计划器" />)

    const heading = view.container.querySelector('h2')!
    expect(heading.textContent).toBe('重新设计的数据库查询计划器')
  })

  it('tracks the latest title when several arrive before the outgoing one finishes', async () => {
    vi.useFakeTimers()
    swapDuration('0.15s')
    const view = render(<Probe title="首个标题" />)
    view.rerender(<Probe title="中间标题" />)
    view.rerender(<Probe title="最终标题" />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(view.container.querySelector('h2')!.textContent).toBe('最终标题')
  })

  it('renders a title a harness composed as an element without swapping it', () => {
    swapDuration('0.15s')
    const view = render(<Probe title={<span>Composed title</span>} />)
    view.rerender(<Probe title={<span>Another composed title</span>} />)

    const heading = view.container.querySelector('h2')!
    expect(heading.textContent).toBe('Another composed title')
  })
})
