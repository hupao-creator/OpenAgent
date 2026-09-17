// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OverviewLiquidStage } from '../src/renderer/src/liquid/OverviewLiquidStage'

/* 舞台的失效路径全是「衬底上发生了画布自己看不见的变化」。库本身要 WebGPU，测试里
   只留它的形状：`LiquidCanvas` 把 ref 交出来，其余原语照原样渲染子树。 */
const liquid = vi.hoisted(() => ({
  invalidateFrame: vi.fn(), invalidateLayout: vi.fn(), props: {} as Record<string, unknown>
}))

vi.mock('@liquid-dom/react', async () => {
  const { createElement, forwardRef, useImperativeHandle } = await import('react')
  const box = (tag: string) => ({ children }: { children?: ReactNode }) => createElement(tag, null, children)
  return {
    Frame: box('div'),
    ZStack: box('div'),
    Html: box('div'),
    Padding: box('div'),
    GlassContainer: box('div'),
    Glass: () => null,
    LiquidCanvas: forwardRef(function LiquidCanvas(props: { children?: ReactNode }, ref) {
      liquid.props = props
      useImperativeHandle(ref, () => ({
        invalidateFrame: liquid.invalidateFrame, invalidateLayout: liquid.invalidateLayout
      }), [])
      return createElement('div', null, props.children)
    })
  }
})

/* 帧回调自己驱动：舞台的悬停跟帧会连续排下一次 rAF，交给 jsdom 会跑成死循环，
   而「排了一帧」正是这里要断言的东西。 */
let frames: FrameRequestCallback[] = []
let clock = 0
function flush(advance = 0): void {
  clock += advance
  const pending = frames
  frames = []
  for (const callback of pending) callback(clock)
}

beforeEach(() => {
  liquid.invalidateFrame.mockClear()
  liquid.invalidateLayout.mockClear()
  liquid.props = {}
  frames = []
  clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } })
  for (const [name, value] of [['offsetWidth', 800], ['offsetHeight', 600]] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value })
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

interface Stage {
  readonly substrate: HTMLElement
  readonly mounted: ReturnType<typeof vi.fn>
  readonly failed: ReturnType<typeof vi.fn>
}

function draw(props: { onSubtreeMounted?: () => void; onFailure?: () => void } = {}): Stage {
  const { container } = render(
    <OverviewLiquidStage backdropRefs={[]} {...props}>
      <div className="thread-overview-scroll" data-overview-native-scroll />
    </OverviewLiquidStage>
  )
  const substrate = container.querySelector('.overview-liquid-substrate')
  if (!(substrate instanceof HTMLElement)) throw new Error('衬底没有进 DOM')
  return { substrate, mounted: vi.fn(props.onSubtreeMounted), failed: vi.fn(props.onFailure) }
}

describe('overview liquid invalidation', () => {
  it('repaints when the pointer enters and leaves, long enough to outlast the transition', () => {
    const { substrate } = draw()
    flush(700)
    liquid.invalidateFrame.mockClear()
    substrate.dispatchEvent(new Event('pointerover', { bubbles: false }))
    flush()
    expect(liquid.invalidateFrame).toHaveBeenCalled()
    // 140-180ms 的过渡还没走完，画面不能停在第一帧。
    const first = liquid.invalidateFrame.mock.calls.length
    flush(100)
    flush(100)
    expect(liquid.invalidateFrame.mock.calls.length).toBeGreaterThan(first)
    // 跟帧窗口过去之后停下来，别一直重画：最后一帧画完不再排下一帧。
    flush(400)
    const settled = liquid.invalidateFrame.mock.calls.length
    flush(400)
    flush(400)
    expect(liquid.invalidateFrame.mock.calls.length).toBe(settled)
  })

  it('repaints on keyboard focus, which mutates no DOM at all', () => {
    const { substrate } = draw()
    flush(700)
    liquid.invalidateFrame.mockClear()
    substrate.dispatchEvent(new Event('focusin', { bubbles: false }))
    flush()
    expect(liquid.invalidateFrame).toHaveBeenCalled()
  })

  it('repaints when a nested scroll region moves, whose scroll event does not bubble', () => {
    const { substrate } = draw()
    flush(700)
    const nested = substrate.querySelector('[data-overview-native-scroll]')
    if (!(nested instanceof HTMLElement)) throw new Error('嵌套滚动区没有进 DOM')
    liquid.invalidateFrame.mockClear()
    nested.dispatchEvent(new Event('scroll', { bubbles: false }))
    flush()
    expect(liquid.invalidateFrame).toHaveBeenCalled()
  })

  it('reports the substrate once, and stays quiet when a failure replaces it', () => {
    const mounted = vi.fn(), failed = vi.fn()
    draw({ onSubtreeMounted: mounted, onFailure: failed })
    flush(700)
    expect(mounted).toHaveBeenCalledTimes(1)
    /* 失败会把衬底换到画布外那份。调用方拿这个信号去重注册 Bart 的空间滚动容器，
       而重注册会先注销一次 —— 正在准备的转场会因此中止，所以那一趟不能报。 */
    act(() => { (liquid.props.onError as (error: unknown) => void)(new Error('WebGPU unavailable')) })
    flush(700)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(mounted).toHaveBeenCalledTimes(1)
  })
})
