// @vitest-environment jsdom
import { useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { BartLogo } from '../src/renderer/src/components/BartLogo'
import { BartLiquidContext, type BartLiquidRegistration } from '../src/renderer/src/liquid/bart-liquid-context'
import { BartLiquidStage } from '../src/renderer/src/liquid/BartLiquidStage'
import { LiquidStageBoundary } from '../src/renderer/src/liquid/liquid-stage-boundary'

/* The stage is the only place that decides whether a Bart may drop its body, so
   the library seams it talks to are replaced with fakes that let the test drive
   one capture -> box -> acknowledge cycle by hand rather than mock the decision. */
const seam = vi.hoisted(() => ({
  painter: null as (() => void) | null,
  layout: 0,
  frames: 0,
  observers: [] as { cb(): void }[]
}))

vi.mock('../src/renderer/src/bart-motion/CharacterCanvas', () => ({ CharacterCanvas: () => null }))
vi.mock('@liquid-dom/react', async () => {
  const { Fragment, createElement, forwardRef, useImperativeHandle } = await import('react')
  const pass = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children ?? null)
  return {
    Frame: pass, GlassContainer: pass, Html: pass, Padding: pass, ZStack: pass, Glass: () => null,
    LiquidCanvas: forwardRef(({ children }: { children?: ReactNode }, ref: unknown) => {
      useImperativeHandle(ref as never, () => ({
        invalidateLayout: () => { seam.layout++ },
        invalidateFrame: () => { seam.frames++ }
      }), [])
      return createElement(Fragment, null, children ?? null)
    }),
    useFrame: (callback: () => void) => { seam.painter = callback }
  }
})
let registrations = 0
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** A host acknowledgement, not a GPU mock: isolates the body-ownership contract. */
function Acknowledged({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const [registration, setRegistration] = useState<BartLiquidRegistration | null>(null)
  const host = useMemo(() => ({ register: (value: BartLiquidRegistration) => {
    registrations++
    setRegistration(value)
    return () => setRegistration(current => current === value ? null : current)
  } }), [])
  const value = useMemo(() => ({ host, painted: new Set(enabled && registration ? [registration.token] : []) }), [host, registration, enabled])
  return <BartLiquidContext.Provider value={value}>{children}</BartLiquidContext.Provider>
}

describe('Bart glass ownership and fallback', () => {
  beforeEach(() => { registrations = 0 })
  it('stays solid without an acknowledged host, including requested glass', () => {
    const view = render(<BartLogo size={64} bodyMaterial="liquidGlass" />)
    expect(view.container.querySelector('svg')?.getAttribute('data-body-material')).toBe('solid')
    expect(view.container.querySelector('.bart-bot > path')?.getAttribute('fill')).toBe('#10110f')
  })
  it('uses glass as the body, preserves independent dark eyes and revokes on failure', () => {
    const view = render(<Acknowledged><BartLogo size={64} bodyMaterial="liquidGlass" eyeColor="#000000" /></Acknowledged>)
    expect(view.container.querySelector('svg')?.getAttribute('data-body-material')).toBe('liquidGlass')
    expect(view.container.querySelector('.bart-bot > path')?.getAttribute('fill')).toBe('none')
    expect(view.container.querySelector('.bart-face > rect')?.getAttribute('fill')).toBe('#000000')
    expect(view.container.querySelector('svg')?.style.mixBlendMode).toBe('normal')
    view.rerender(<Acknowledged enabled={false}><BartLogo size={64} bodyMaterial="liquidGlass" eyeColor="#000000" /></Acknowledged>)
    expect(view.container.querySelector('svg')?.getAttribute('data-body-material')).toBe('solid')
    expect(view.container.querySelector('.bart-bot > path')?.getAttribute('fill')).toBe('#10110f')
  })
  it('updates colours and excludes non-circular layouts', () => {
    const view = render(<Acknowledged><BartLogo size={64} bodyMaterial="liquidGlass" /></Acknowledged>)
    view.rerender(<Acknowledged><BartLogo size={64} layout="permission" bodyMaterial="liquidGlass" bodyColor="#123456" eyeColor="#654321" /></Acknowledged>)
    expect(view.container.querySelector('svg')?.getAttribute('data-body-material')).toBe('solid')
    expect(view.container.querySelector('.bart-bot > path')?.getAttribute('fill')).toBe('#123456')
    expect(view.container.querySelector('.bart-face > rect')?.getAttribute('fill')).toBe('#654321')
  })
  it('does not re-register when only the motion key changes', () => {
    // The acknowledgement is keyed by registration identity. Folding the motion
    // key into it re-registers on every activity change, which revokes the
    // acknowledgement and drops the body back to solid for a frame each time.
    const view = render(<Acknowledged><BartLogo size={64} bodyMaterial="liquidGlass" operation={{ id: 'a', kind: 'read', phase: 'running' }} /></Acknowledged>)
    const before = view.container.querySelector('svg')?.getAttribute('data-motion-key')
    expect(before).toBe('mark:a:running:')
    expect(view.container.querySelector('svg')?.getAttribute('data-body-material')).toBe('liquidGlass')
    view.rerender(<Acknowledged><BartLogo size={64} bodyMaterial="liquidGlass" operation={{ id: 'b', kind: 'start', phase: 'running' }} /></Acknowledged>)
    expect(view.container.querySelector('svg')?.getAttribute('data-motion-key')).toBe('mark:b:running:')
    expect(registrations).toBe(1)
    expect(view.container.querySelector('svg')?.getAttribute('data-body-material')).toBe('liquidGlass')
  })
  it('contains a throwing canvas mount and restores a visible solid body', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new Error('No WebGPU adapter / context')
    function ThrowingCanvas(): null { useLayoutEffect(() => { throw error }, []); return null }
    function Scene() {
      const [failed, setFailed] = useState(false)
      return <>
        {!failed && <LiquidStageBoundary label="test" onFail={() => setFailed(true)}><ThrowingCanvas /></LiquidStageBoundary>}
        <Acknowledged enabled={!failed}><BartLogo size={64} bodyMaterial="liquidGlass" /></Acknowledged>
        <button>still interactive</button>
      </>
    }
    const view = render(<Scene />)
    expect(view.getByRole('button').textContent).toBe('still interactive')
    expect(view.container.querySelector('svg')?.getAttribute('data-body-material')).toBe('solid')
    expect(view.container.querySelector('.bart-bot > path')?.getAttribute('fill')).toBe('#10110f')
  })
  it('missing capture support leaves the backdrop and actor in ordinary DOM', () => {
    vi.stubGlobal('navigator', { gpu: undefined })
    const view = render(<BartLiquidStage backdrop={<div>real backdrop</div>} style={{ width: 640, height: 640 }}>
      <BartLogo size={640} bodyMaterial="liquidGlass" />
    </BartLiquidStage>)
    expect(view.getByText('real backdrop')).toBeTruthy()
    expect(view.container.querySelector('[data-bart-liquid-stage]')?.getAttribute('data-bart-liquid-stage')).toBe('unsupported')
    expect(view.container.querySelector('.bart-logo')?.getAttribute('data-body-material')).toBe('solid')
  })
  it('keeps the layer above the canvas out of the hit test', () => {
    const view = render(<BartLiquidStage backdrop={<div>real backdrop</div>} style={{ width: 640, height: 640 }}>
      <button type="button">dock control</button>
    </BartLiquidStage>)
    // The foreground spans the whole stage. Hit-testable, it would swallow every
    // click on whatever the caller captured as substrate — which, for a stage
    // wrapped around a window, is the entire interactive app.
    expect(view.getByRole('button').parentElement?.style.pointerEvents).toBe('none')
  })
})

/* The enabled path: a real stage, a real registration, and a hand-driven capture
   cycle. Without this the capture -> box -> acknowledge handshake, the off-stage
   guard and the ready gate are only ever exercised in production. */
describe('Bart liquid stage capture', () => {
  const restorers: (() => void)[] = []
  let stageWidth = 640
  let stageHeight = 640
  let logo = { a: 1, b: 0, c: 0, d: 1, e: 20, f: 30 }
  const queued = new Map<number, FrameRequestCallback>()
  let sequence = 0

  const matrix = (value: typeof logo) => ({
    ...value,
    inverse: () => matrix({ a: 1, b: 0, c: 0, d: 1, e: -value.e, f: -value.f }),
    multiply: (other: typeof logo) => matrix({ a: value.a, b: value.b, c: value.c, d: value.d,
      e: value.a * other.e + value.c * other.f + value.e, f: value.b * other.e + value.d * other.f + value.f })
  })
  const override = (target: object, key: string, descriptor: PropertyDescriptor): void => {
    const original = Object.getOwnPropertyDescriptor(target, key)
    Object.defineProperty(target, key, { configurable: true, ...descriptor })
    restorers.push(() => {
      if (original) Object.defineProperty(target, key, original)
      else Reflect.deleteProperty(target, key)
    })
  }
  beforeEach(() => {
    seam.painter = null
    seam.layout = 0
    seam.frames = 0
    seam.observers.length = 0
    stageWidth = 640
    stageHeight = 640
    logo = { a: 1, b: 0, c: 0, d: 1, e: 20, f: 30 }
    sequence = 0
    queued.clear()
    vi.stubGlobal('navigator', { gpu: {} })
    override(HTMLCanvasElement.prototype, 'captureElementImage', { value: () => undefined })
    override(HTMLCanvasElement.prototype, 'layoutSubtree', { value: true })
    override(SVGElement.prototype, 'getScreenCTM', { value(this: Element) {
      const identity = matrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
      return this.classList.contains('bart-logo') ? matrix(logo) : identity
    } })
    override(Element.prototype, 'clientWidth', { get: () => stageWidth })
    override(Element.prototype, 'clientHeight', { get: () => stageHeight })
    override(Element.prototype, 'getBoundingClientRect', { value(this: Element) {
      const box = this.classList?.contains('clipping')
        ? { x: 0, y: 0, width: 100, height: 100 }
        : { x: 0, y: 0, width: stageWidth, height: stageHeight }
      return { ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height } as DOMRect
    } })
    vi.stubGlobal('ResizeObserver', class {
      constructor(readonly cb: () => void) { seam.observers.push({ cb }) }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queued.set(++sequence, callback); return sequence })
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { queued.delete(handle) })
  })
  afterEach(() => { while (restorers.length) restorers.pop()!() })

  const flushFrames = (): void => {
    const batch = [...queued.values()]
    queued.clear()
    for (const callback of batch) callback(performance.now())
  }
  /** One capture cycle: the stage measures, then the library reports the frame. */
  const capture = async (): Promise<void> => {
    await act(async () => { flushFrames() })
    await act(async () => { seam.painter?.() })
  }
  const remeasure = async (): Promise<void> => {
    await act(async () => { for (const observer of seam.observers) observer.cb() })
  }
  const scene = (backdropRevision?: number) =>
    <BartLiquidStage backdrop={<div>real backdrop</div>} backdropRevision={backdropRevision} style={{ width: 640, height: 640 }}>
      <BartLogo size={640} bodyMaterial="liquidGlass" />
    </BartLiquidStage>
  const material = (view: ReturnType<typeof render>): string | null =>
    view.container.querySelector('.bart-logo')?.getAttribute('data-body-material') ?? null

  it('acknowledges an on-stage resident and revokes it once the body leaves the stage', async () => {
    const view = render(scene())
    expect(view.container.querySelector('[data-bart-liquid-stage]')?.getAttribute('data-bart-liquid-stage')).toBe('enabled')
    expect(material(view)).toBe('solid')

    await capture()
    expect(seam.frames).toBeGreaterThan(0)
    expect(material(view)).toBe('liquidGlass')
    expect(view.container.querySelector('.bart-bot > path')?.getAttribute('fill')).toBe('none')

    // Push the body past the stage's bottom-right corner: a clipped disc would
    // leave the face without a full body, so the acknowledgement must be dropped.
    logo = { ...logo, e: 5000, f: 5000 }
    view.rerender(scene(1))
    await capture()
    expect(material(view)).toBe('solid')
    expect(view.container.querySelector('.bart-bot > path')?.getAttribute('fill')).toBe('#10110f')
  })

  it('revokes the acknowledgement while the stage has no size to draw into', async () => {
    const view = render(scene())
    await capture()
    expect(material(view)).toBe('liquidGlass')

    // A collapsed stage keeps no frames flowing, so the acknowledgement must not
    // outlive the canvas that justified it.
    stageHeight = 0
    await remeasure()
    expect(material(view)).toBe('solid')

    stageHeight = 640
    await remeasure()
    await capture()
    expect(material(view)).toBe('liquidGlass')
  })

  it('keeps a clipped body solid instead of spilling a disc past its ancestor', async () => {
    // The disc is drawn on a separate canvas, so a character held inside an
    // `overflow: hidden` / scrolled ancestor would show a full circle outside
    // the clip its face is confined to.
    const view = render(
      <BartLiquidStage backdrop={<div>real backdrop</div>} style={{ width: 640, height: 640 }}>
        <div className="clipping" style={{ overflow: 'hidden' }}>
          <BartLogo size={640} bodyMaterial="liquidGlass" />
        </div>
      </BartLiquidStage>)
    expect(material(view)).toBe('solid')
    await capture()
    expect(material(view)).toBe('solid')
    expect(view.container.querySelector('.bart-bot > path')?.getAttribute('fill')).toBe('#10110f')
  })

  it('keeps the backdrop subtree mounted while the stage collapses and re-measures', async () => {
    const view = render(scene())
    await capture()
    const substrate = view.getByText('real backdrop')
    // The canvas must stay mounted across a size excursion; moving `backdrop`
    // between two parents would remount the caller's subtree and lose whatever
    // state lives inside it.
    stageHeight = 0
    await remeasure()
    stageHeight = 640
    await remeasure()
    await capture()
    expect(view.getByText('real backdrop')).toBe(substrate)
  })
})
