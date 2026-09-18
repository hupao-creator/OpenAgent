import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode } from 'react'
import { Frame, Glass, GlassContainer, Html, LiquidCanvas, Padding, ZStack, useFrame,
  type LiquidCanvasRef } from '@liquid-dom/react'
import { canvasDrawElementGap, installLiquidCaptureCompat } from './capture-compat'
import { useLiquidTheme, type LiquidTheme } from './glass-recipe'
import { BART_BODY_DIAMETER, bartGlassBox, bartGlassFor, type BartGlassBox } from './bart-glass-recipe'
import { BartLiquidContext, type BartLiquidRegistration } from './bart-liquid-context'
import { createLiquidFollow } from './liquid-follow'

installLiquidCaptureCompat()
const EMPTY: ReadonlySet<string> = new Set()

export class BartLiquidBoundary extends Component<{ children: ReactNode; onFailure(error: unknown): void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: true } { return { failed: true } }
  componentDidCatch(error: unknown): void { this.props.onFailure(error) }
  render(): ReactNode { return this.state.failed ? null : this.props.children }
}

interface BodyBox extends BartGlassBox { registration: BartLiquidRegistration }

/** useFrame runs before render. Publish only after that synchronous frame has
 * returned; an onError in that frame revokes the acknowledgement first. */
function PaintedFrame({ onPaint }: { onPaint(): void }): null {
  const alive = useRef(false)
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useFrame(() => { queueMicrotask(() => { if (alive.current) onPaint() }) })
  return null
}

function BodyGlass({ box, theme }: { box: BodyBox; theme: LiquidTheme }): React.JSX.Element {
  // Tint is an immutable, memoized object; eye/state changes do not rewrite optics.
  const params = useMemo(() => bartGlassFor(theme, box.registration.color, box.diameter / BART_BODY_DIAMETER),
    [theme, box.registration.color, box.diameter])
  return <Padding insets={{ left: box.left, top: box.top }}>
    <GlassContainer {...params}>
      <Frame width={box.diameter} height={box.diameter}>
        <Glass cornerRadius={box.diameter / 2} cornerSmoothing={0} />
      </Frame>
    </GlassContainer>
  </Padding>
}

function visibleWithin(element: Element, stop: Element): boolean {
  for (let node: Element | null = element; node && node !== stop; node = node.parentElement) {
    const style = getComputedStyle(node)
    // Keep fades/handoffs in their owning DOM/Worker scene, not a detached glass disc.
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
      || Number(style.opacity || 1) < 0.999) return false
  }
  return true
}

export interface BartLiquidStageProps {
  /** Real scene substrate. Bart/eyes must NOT be part of this captured subtree. */
  backdrop: ReactNode
  /** Ordinary DOM foreground, containing opt-in BartLogo instances. */
  children: ReactNode
  className?: string
  style?: CSSProperties
  /** For external paints that do not mutate DOM (for example a caller-owned canvas). */
  backdropRevision?: string | number
  onFailure?: (error: unknown) => void
}

/** One WebGPU surface for all opted-in resident Barts in this scene. Foreground
 * stays outside Html, preserving normal alpha, events, refs and Worker ownership.
 * Without a stage (or after failure), BartLogo always renders the solid fallback. */
export function BartLiquidStage({ backdrop, children, className, style, backdropRevision, onFailure }: BartLiquidStageProps): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const foreground = useRef<HTMLDivElement>(null)
  const coordinates = useRef<SVGSVGElement>(null)
  const canvas = useRef<LiquidCanvasRef>(null)
  const [substrate, bindSubstrate] = useState<HTMLDivElement | null>(null)
  const registrations = useRef(new Map<string, BartLiquidRegistration>())
  const [revision, setRevision] = useState(0)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [boxes, setBoxes] = useState<readonly BodyBox[]>([])
  const [painted, setPainted] = useState<ReadonlySet<string>>(EMPTY)
  const [capable] = useState(() => typeof navigator !== 'undefined' && !!navigator.gpu && canvasDrawElementGap() === null)
  const [failed, setFailed] = useState(false)
  const failure = useRef(false)
  const theme = useLiquidTheme()
  const reportFailure = useRef(onFailure)
  reportFailure.current = onFailure
  const fail = useCallback((error: unknown): void => {
    if (failure.current) return
    failure.current = true
    setFailed(true)
    console.error('[bart-liquid] Glass unavailable; restoring solid Bart', error)
    reportFailure.current?.(error)
  }, [])
  const register = useCallback((value: BartLiquidRegistration): (() => void) => {
    registrations.current.set(value.id, value)
    setRevision(current => current + 1)
    return () => {
      if (registrations.current.get(value.id) !== value) return
      registrations.current.delete(value.id)
      setRevision(current => current + 1)
    }
  }, [])
  const host = useMemo(() => ({ register }), [register])
  const context = useMemo(() => ({ host: capable && !failed ? host : null, painted: failed ? EMPTY : painted }),
    [capable, failed, host, painted])

  useLayoutEffect(() => {
    if (!capable || failed || !root.current) return
    const element = root.current
    const measure = (): void => {
      const width = element.clientWidth, height = element.clientHeight
      setSize(current => current.width === width && current.height === height ? current : { width, height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [capable, failed])

  useEffect(() => {
    if (!capable || failed || !foreground.current) return
    const layer = foreground.current
    const follow = createLiquidFollow(() => {
      if (failure.current) return
      try {
        const base = coordinates.current?.getScreenCTM()
        const next: BodyBox[] = []
        if (base) {
          const inverse = base.inverse()
          for (const registration of registrations.current.values()) {
            const matrix = registration.element.getScreenCTM()
            if (!matrix || !registration.element.isConnected || !visibleWithin(registration.element, layer)) continue
            const box = bartGlassBox(inverse.multiply(matrix))
            // A clipped glass disc would leave the face without a full body.
            if (!box || box.left < 0 || box.top < 0 || box.left + box.diameter > size.width
              || box.top + box.diameter > size.height) continue
            next.push({ ...box, registration })
          }
        }
        setBoxes(current => current.length === next.length && current.every((box, index) => {
          const other = next[index]
          return box.registration === other.registration && box.left === other.left
            && box.top === other.top && box.diameter === other.diameter
        }) ? current : next)
        canvas.current?.invalidateLayout()
        canvas.current?.invalidateFrame()
      } catch (error) { fail(error) }
    })
    const invalidate = (): void => follow.invalidate()
    const mutation = new MutationObserver(invalidate)
    mutation.observe(layer, { subtree: true, attributes: true, childList: true, characterData: true })
    if (substrate) mutation.observe(substrate, { subtree: true, attributes: true, childList: true, characterData: true })
    const resize = new ResizeObserver(invalidate)
    resize.observe(layer)
    if (substrate) resize.observe(substrate)
    for (const value of registrations.current.values()) resize.observe(value.element)
    const events = ['scroll', 'pointerover', 'pointerout', 'focusin', 'focusout', 'transitionrun', 'transitionend', 'animationstart', 'animationend'] as const
    for (const event of events) root.current?.addEventListener(event, invalidate, { capture: true, passive: true })
    const stage = root.current
    let disposed = false
    void document.fonts?.ready.then(() => { if (!disposed) invalidate() })
    document.fonts?.addEventListener('loadingdone', invalidate)
    window.addEventListener('resize', invalidate)
    follow.invalidate()
    return () => {
      disposed = true
      follow.dispose()
      mutation.disconnect()
      resize.disconnect()
      for (const event of events) stage?.removeEventListener(event, invalidate, { capture: true })
      document.fonts?.removeEventListener('loadingdone', invalidate)
      window.removeEventListener('resize', invalidate)
    }
  }, [capable, failed, revision, size.width, size.height, substrate, theme, backdrop, backdropRevision, fail])

  const acknowledge = useCallback((): void => {
    if (failure.current) return
    const next = new Set(boxes.filter(box => registrations.current.get(box.registration.id) === box.registration)
      .map(box => box.registration.token))
    setPainted(current => current.size === next.size && [...current].every(token => next.has(token)) ? current : next)
  }, [boxes])
  const ready = capable && !failed && size.width > 0 && size.height > 0
  return <div ref={root} className={className} data-bart-liquid-stage={failed ? 'failed' : capable ? 'enabled' : 'unsupported'}
    style={{ ...style, position: style?.position ?? 'relative', isolation: 'isolate', padding: 0, border: 0 }}>
    <div style={{ position: 'absolute', inset: 0 }}>
      {ready ? <BartLiquidBoundary onFailure={fail}>
        <LiquidCanvas ref={canvas} frameloop="demand" onError={fail}
          style={{ width: '100%', height: '100%' }} canvasStyle={{ display: 'block', width: '100%', height: '100%' }}>
          <Frame width={size.width} height={size.height}>
            <ZStack alignment="topLeading">
              <Html sizing="fill"><div ref={bindSubstrate} style={{ width: '100%', height: '100%' }}>{backdrop}</div></Html>
              {boxes.map(box => <BodyGlass key={box.registration.id} box={box} theme={theme} />)}
            </ZStack>
          </Frame>
          <PaintedFrame onPaint={acknowledge} />
        </LiquidCanvas>
      </BartLiquidBoundary> : <div style={{ width: '100%', height: '100%' }}>{backdrop}</div>}
    </div>
    <svg ref={coordinates} aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', visibility: 'hidden', pointerEvents: 'none' }} />
    <div ref={foreground} style={{ position: 'relative', width: '100%', height: '100%', mixBlendMode: 'normal' }}>
      <BartLiquidContext.Provider value={context}>{children}</BartLiquidContext.Provider>
    </div>
  </div>
}
