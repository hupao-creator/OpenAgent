// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BartDock } from '../src/renderer/src/components/BartDock'

const noop = (): void => {}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => clearTimeout(id)))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * jsdom has no PointerEvent and no pointer capture, so both are carried by hand:
 * a MouseEvent wearing the event's name, and the two capture methods stubbed.
 * A press is therefore only ever delivered to the surface it was aimed at, which
 * is what pointer capture would have guaranteed anyway.
 */
function pointer(type: string, clientX: number, clientY: number, pointerId = 1): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  return event
}

function fixture(props: { inputOpen?: boolean } = {}) {
  const onThreadOpenChange = vi.fn()
  const view = render(
    // The Dock resolves the box it is placed against from its `.app-shell`
    // ancestor when the spatial registry has no stage of its own.
    <div className="app-shell">
      <BartDock
        activityContext={{ threadKey: 'bart-dock-tap', execution: null }}
        threadOpen={false}
        sessionIdle
        inputOpen={props.inputOpen ?? false}
        inputValue=""
        bartAttachments={[]}
        foregroundActivity={null}
        running={false}
        onThreadOpenChange={onThreadOpenChange}
        onInputOpenChange={noop}
        onInputChange={noop}
        onChooseFiles={noop}
        onRemoveBartAttachment={noop}
        onSubmit={noop}
      />
    </div>
  )
  const surface = view.container.querySelector<HTMLElement>('.bart-dock-drag-surface')!
  surface.setPointerCapture = noop
  surface.hasPointerCapture = () => false
  return {
    onThreadOpenChange,
    send: (type: string, clientX: number, clientY: number, pointerId = 1): void => {
      act(() => { surface.dispatchEvent(pointer(type, clientX, clientY, pointerId)) })
    }
  }
}

it('进入会话：按下后原地松开就是点 Bart 自己', () => {
  const f = fixture()
  f.send('pointerdown', 100, 100)
  f.send('pointerup', 100, 100)
  expect(f.onThreadOpenChange).toHaveBeenCalledTimes(1)
  expect(f.onThreadOpenChange).toHaveBeenCalledWith(true)
})

it('进入会话：手在几像素内抖了一下仍然算点击', () => {
  const f = fixture()
  f.send('pointerdown', 100, 100)
  // 位移 3.6px，仍在 Dock 判定拖动的 4px 之内。
  f.send('pointermove', 103, 102)
  f.send('pointerup', 103, 102)
  expect(f.onThreadOpenChange).toHaveBeenCalledTimes(1)
  expect(f.onThreadOpenChange).toHaveBeenCalledWith(true)
})

it('只拖动：位移越过阈值后松开，不进入会话', () => {
  const f = fixture()
  f.send('pointerdown', 100, 100)
  f.send('pointermove', 260, 190)
  f.send('pointerup', 260, 190)
  expect(f.onThreadOpenChange).not.toHaveBeenCalled()
})

it('不进会话：手势被系统取消时，没有移动也不当作点击', () => {
  const f = fixture()
  f.send('pointerdown', 100, 100)
  f.send('pointercancel', 100, 100)
  expect(f.onThreadOpenChange).not.toHaveBeenCalled()
})

it('不进会话：胶囊打开时，同样的按下属于胶囊所在的布局而不是角色', () => {
  const f = fixture({ inputOpen: true })
  f.send('pointerdown', 100, 100)
  f.send('pointerup', 100, 100)
  expect(f.onThreadOpenChange).not.toHaveBeenCalled()
})

it('不进会话：第二根手指按住 Bart，抬指不冒充点击', () => {
  const f = fixture()
  f.send('pointerdown', 100, 100, 1)
  f.send('pointermove', 260, 190, 1)
  // 第二根手指既没有接手已有手势，也没有在拖动中途把自己换进去，
  // 所以它自己的抬指落在一个已经被判定为拖动的按下上。
  f.send('pointerdown', 260, 190, 2)
  f.send('pointerup', 260, 190, 2)
  expect(f.onThreadOpenChange).not.toHaveBeenCalled()
})

it('仍然拖动：越过阈值的位移照旧落位并被记住', () => {
  // jsdom reports every box as zero, so the Dock has nothing to clamp against
  // and no drag would ever land. Sizes are handed out by class to give the box
  // it is placed against and the box being placed distinct extents.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const shell = this.classList.contains('app-shell')
    const width = shell ? 1000 : 400
    const height = shell ? 800 : 210
    return { left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) }
  })
  const f = fixture()
  f.send('pointerdown', 100, 100)
  f.send('pointermove', 260, 190)
  f.send('pointerup', 260, 190)
  expect(f.onThreadOpenChange).not.toHaveBeenCalled()
  expect(JSON.parse(localStorage.getItem('openagent.bart-dock-position.v3')!)).toEqual({ left: 160, top: 90 })
})
