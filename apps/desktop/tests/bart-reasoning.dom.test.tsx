// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BartRoleDecoration } from '../src/renderer/src/components/BartRoleDecoration'
import { BART_REASONING_DEFAULTS, type ReasoningStreamStyle } from '../src/renderer/src/bart-motion/reasoning-geometry'
import { resolveBartRole, type BartDockRole } from '../src/renderer/src/bart-role'
import { useBartDisplay } from '../src/renderer/src/use-bart-display'
import { streamOverlap } from '../src/renderer/src/bart-motion/reasoning-stream-presentation'

const eyes = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn() }))
vi.mock('../src/renderer/src/bart-motion/CharacterCanvas', () => ({
  animateBartEyes: eyes.start.mockImplementation(() => ({ cancel: eyes.cancel }))
}))
const cancelBody = vi.fn()
const animate = vi.fn(() => ({ cancel: cancelBody }))
let reduced = false
let onPreference: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  reduced = false
  onPreference = undefined
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return reduced },
    addEventListener: (_: string, callback: () => void) => { onPreference = callback },
    removeEventListener: () => { onPreference = undefined }
  }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  // jsdom lacks SVG layout. These measurements model a 452px circle arc;
  // browser acceptance checks actual shaped glyphs and geometry separately.
  Object.defineProperties(SVGElement.prototype, {
    getTotalLength: { configurable: true, value: () => 452 },
    getComputedTextLength: { configurable: true, value: function(this: SVGElement) { return Array.from(this.textContent ?? '').length * 10 } },
    getPointAtLength: { configurable: true, value: (distance: number) => {
      const angle = (-254 + distance / 452 * 288) * Math.PI / 180
      return { x: 200 + 90 * Math.cos(angle), y: 160 + 90 * Math.sin(angle) }
    } }
  })
  vi.stubGlobal('Animation', class {})
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  for (const name of ['getTotalLength', 'getComputedTextLength', 'getPointAtLength']) Reflect.deleteProperty(SVGElement.prototype, name)
  Reflect.deleteProperty(Element.prototype, 'animate')
})

function Fixture({ text, active = true, workerReady = true, stream }: { text: string; active?: boolean; workerReady?: boolean; stream?: ReasoningStreamStyle }) {
  const role = resolveBartRole({ kind: 'reasoning', text, sequence: 1, executionId: 'execution-1' }, false)
  return <DecorationFixture role={role} active={active} workerReady={workerReady} stream={stream} />
}
function DecorationFixture({ role, active = true, workerReady = true, stream = BART_REASONING_DEFAULTS.stream }: { role: BartDockRole; active?: boolean; workerReady?: boolean; stream?: ReasoningStreamStyle }) {
  const dock = useRef<HTMLDivElement>(null)
  return <div ref={dock} className="bart-dock">
    <span className="bart-dock-reasoning-motion"><svg className="bart-logo" data-worker-ready={workerReady ? 'true' : undefined} /></span>
    <BartRoleDecoration role={role} dockRef={dock} active={active} reasoningOptions={{ ...BART_REASONING_DEFAULTS, stream }} />
  </div>
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))

it('uses the locked circle and glide defaults, retaining motion across text deltas', () => {
  expect(BART_REASONING_DEFAULTS).toEqual({ length: 200, tilt: -20, gaze: true, stream: 'glide' })
  const f = render(<Fixture text="先确认" />)
  const layer = f.container.querySelector('[data-bart-stream-layer]')!
  const curve = f.container.querySelector('path')!.getAttribute('d')
  expect(eyes.start).toHaveBeenCalledTimes(1)
  expect(animate).toHaveBeenCalledTimes(2)
  advance(100)
  f.rerender(<Fixture text="先确认当前的问题" />)
  expect(f.container.querySelector('[data-bart-stream-layer]')).toBe(layer)
  expect(f.container.querySelector('path')!.getAttribute('d')).toBe(curve)
  expect(eyes.start).toHaveBeenCalledTimes(1)
  expect(cancelBody).not.toHaveBeenCalled()
  const source = f.container.querySelector('.bart-role-arc > text textPath')!
  const displayed = layer.querySelector('textPath')!
  const initial = Number(displayed.getAttribute('startOffset'))
  expect(initial).toBeGreaterThan(Number(source.getAttribute('startOffset')))
  advance(96)
  expect(Number(displayed.getAttribute('startOffset'))).toBeLessThan(initial)
  advance(1200)
  expect(displayed.getAttribute('startOffset')).toBe(source.getAttribute('startOffset'))
  expect(layer.textContent).toBe('先确认当前的问题')
  f.unmount()
  expect(eyes.cancel).toHaveBeenCalled()
  const calls = eyes.start.mock.calls.length
  advance(10_000)
  expect(eyes.start).toHaveBeenCalledTimes(calls)
  expect(vi.getTimerCount()).toBe(0)
})

it('hands off to covered views and reduced motion without stale layers or scheduled cycles', () => {
  const f = render(<Fixture text="检查边界" />)
  f.rerender(<Fixture text="检查边界" active={false} />)
  expect(f.container.querySelector('[data-bart-stream-layer]')).toBeNull()
  expect(f.container.querySelector<SVGTextElement>('.bart-role-arc > text')!.style.visibility).toBe('')
  expect(vi.getTimerCount()).toBe(0)
  f.rerender(<Fixture text="检查最新边界" />)
  expect(eyes.start).toHaveBeenCalledTimes(2)
  act(() => { reduced = true; onPreference?.() })
  expect(f.container.querySelector('[data-bart-stream-layer]')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  f.rerender(<Fixture text="减少动态效果仍显示最新文字" />)
  expect(f.container.querySelector('textPath')!.textContent).toBe('减少动态效果仍显示最新文字')
  expect(eyes.start).toHaveBeenCalledTimes(2)
})

it('starts when empty reasoning first receives text and cancels when the text clears', () => {
  const f = render(<Fixture text="" />)
  expect(eyes.start).not.toHaveBeenCalled()
  f.rerender(<Fixture text="开始" />)
  expect(eyes.start).toHaveBeenCalledTimes(1)
  f.rerender(<Fixture text="" />)
  expect(f.container.querySelector('.bart-role-arc')).toBeNull()
  expect(eyes.cancel).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps fallback eyes attached by stopping body motion whenever the Worker is unavailable', async () => {
  const f = render(<Fixture text="检查回退" workerReady={false} />)
  expect(animate).not.toHaveBeenCalled()
  expect(eyes.start).not.toHaveBeenCalled()
  await act(async () => { f.rerender(<Fixture text="检查回退" />) })
  expect(animate).toHaveBeenCalledTimes(2)
  expect(eyes.start).toHaveBeenCalledTimes(1)
  await act(async () => { f.rerender(<Fixture text="检查回退" workerReady={false} />) })
  expect(cancelBody).toHaveBeenCalledTimes(2)
  expect(eyes.cancel).toHaveBeenCalledTimes(1)
  advance(10_000)
  expect(eyes.start).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('matches Unicode graphemes through tail truncation and resets unrelated text', () => {
  const segment = (value: string) => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), part => part.segment)
  expect(streamOverlap(segment('检查👩‍💻e\u0301'), segment('👩‍💻e\u0301完成'))).toBe(2)
  expect(streamOverlap(segment('完成上一轮。'), segment('新的思考'))).toBe(0)
})

it('paces large batches like small batches while keeping visible text in place', () => {
  const sample = (start: number, size: number) => Array.from({ length: size }, (_, index) => String.fromCodePoint(0x4e00 + start + index)).join('')
  const f = render(<Fixture text={sample(0, 56)} />)
  const displayed = () => f.container.querySelector('[data-bart-stream-layer] textPath')!
  const offset = () => Number(displayed().getAttribute('startOffset'))
  const position = (character: string) => offset() - Array.from(displayed().textContent!).length * 10 +
    Array.from(displayed().textContent!).indexOf(character) * 10
  const marker = sample(20, 1)
  const original = position(marker)
  f.rerender(<Fixture text={sample(2, 56)} />)
  expect(position(marker)).toBeCloseTo(original)
  let before = offset()
  advance(48)
  const smallTravel = before - offset()
  const beforeBurst = position(marker)
  f.rerender(<Fixture text={sample(22, 56)} />)
  expect(position(marker)).toBeCloseTo(beforeBurst)
  before = offset()
  advance(48)
  expect(before - offset()).toBeCloseTo(smallTravel)
  expect(before - offset()).toBeLessThanOrEqual(120 * .048 + .001)
  advance(4000)
  expect(displayed().textContent).toBe(sample(22, 56))
  expect(offset()).toBe(452)
})

it('rebases disjoint same-segment snapshots instead of joining missing text', () => {
  const sample = (start: number) => Array.from({ length: 56 }, (_, index) => String.fromCodePoint(0x4e00 + start + index)).join('')
  const f = render(<Fixture text={sample(0)} />)
  const displayed = () => f.container.querySelector('[data-bart-stream-layer] textPath')!
  // Each burst skips more than a source window. The missing characters cannot
  // be reconstructed by joining the previous visible text to the latest tail.
  for (let batch = 1; batch <= 50; batch++) {
    advance(160)
    f.rerender(<Fixture text={sample(batch * 80)} />)
    expect(displayed().textContent).toBe(sample(batch * 80))
    expect(Number(displayed().getAttribute('startOffset'))).toBe(452)
  }
  advance(6000)
  expect(displayed().textContent).toBe(sample(50 * 80))
  expect(Number(displayed().getAttribute('startOffset'))).toBe(452)
  f.rerender(<Fixture text={sample(51 * 80)} active={false} />)
  expect(f.container.querySelector('[data-bart-stream-layer]')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['glide', 'soft'] as const)('keeps %s burst frames contiguous with the original reasoning', (stream) => {
  const transcript = [
    '先确认当前的问题，再沿着调用链检查上下文，找到真正影响结果的部分。',
    'Checking the latest reasoning delta and comparing the original input with its output. ',
    '接下来检查边界情况：短句、标点、中英文混排，以及 emoji 👩‍💻 和组合字符 e\u0301。',
    'Read the configuration, inspect the implementation, then verify each change against the source. ',
    '确认这些细节之后，再整理结论，给出清晰的下一步，并记录已经完成的验证。'
  ].join('')
  const points = Array.from(transcript)
  const f = render(<Fixture text={points.slice(0, 56).join('')} stream={stream} />)
  const displayed = () => f.container.querySelector('[data-bart-stream-layer] textPath')!
  // Overlapping windows still accumulate faster than the readable glide. Do
  // not silently delete the middle to stitch visible text to the latest tail.
  for (let end = 68; end < points.length + 12; end += 12) {
    const received = points.slice(0, end).join('')
    f.rerender(<Fixture text={received} stream={stream} />)
    for (let frame = 0; frame < 10; frame++) {
      expect(received).toContain(displayed().textContent)
      expect(Array.from(displayed().textContent!).length).toBeLessThanOrEqual(56 + Math.ceil(452 / 10) + 1)
      advance(16)
    }
  }
  advance(6000)
  expect(displayed().textContent).toBe(f.container.querySelector('.bart-role-arc > text textPath')!.textContent)
})


it('clears pending text at real segment and execution boundaries without restarting the pose', () => {
  function Scheduled({ text, sequence = 1, executionId = 'execution-1' }: { text: string; sequence?: number; executionId?: string }) {
    const latest = resolveBartRole({ kind: 'reasoning', text, sequence, executionId }, false)
    const role = useBartDisplay(latest, true, {
      threadKey: 'test', execution: { executionId, status: 'running' }
    }, true)
    return <DecorationFixture role={role} />
  }
  const sample = (start: number) => Array.from({ length: 56 }, (_, index) => String.fromCodePoint(0x4e00 + start + index)).join('')
  const f = render(<Scheduled text={sample(0)} />)
  const layer = f.container.querySelector('[data-bart-stream-layer] textPath')!
  const source = f.container.querySelector('.bart-role-arc > text textPath')!
  f.rerender(<Scheduled text={sample(12)} />)
  advance(150)
  expect(layer.textContent).not.toBe(sample(12))
  expect(layer.getAttribute('startOffset')).not.toBe(source.getAttribute('startOffset'))
  // Equal text must still cross the display scheduler when the identity changes.
  f.rerender(<Scheduled text={sample(12)} sequence={2} />)
  advance(150)
  expect(layer.textContent).toBe(sample(12))
  expect(layer.getAttribute('startOffset')).toBe(source.getAttribute('startOffset'))
  f.rerender(<Scheduled text={sample(24)} sequence={2} />)
  advance(150)
  expect(layer.textContent).not.toBe(sample(24))
  f.rerender(<Scheduled text={'丁'.repeat(56)} sequence={2} executionId="execution-2" />)
  expect(layer.textContent).toBe('丁'.repeat(56))
  expect(layer.getAttribute('startOffset')).toBe(source.getAttribute('startOffset'))
  expect(f.container.querySelector('[data-bart-stream-layer] textPath')).toBe(layer)
  expect(eyes.start).toHaveBeenCalledTimes(1)
  expect(animate).toHaveBeenCalledTimes(2)
})
