import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode } from 'react'
import { Frame, Glass, GlassContainer, Html, LiquidCanvas, Padding, ZStack, useFrame,
  type LiquidCanvasRef } from '@liquid-dom/react'
import { canvasDrawElementGap, installLiquidCaptureCompat } from './capture-compat'
import { useLiquidTheme, type LiquidTheme } from './glass-recipe'
import { BART_BODY_DIAMETER, bartGlassBox, bartGlassCorner, bartGlassFor, type BartGlassBox } from './bart-glass-recipe'
import { BartLiquidContext, type BartLiquidRegistration } from './bart-liquid-context'
import { createLiquidFollow } from './liquid-follow'
import { LiquidStageBoundary } from './liquid-stage-boundary'

installLiquidCaptureCompat()
const EMPTY: ReadonlySet<string> = new Set()

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
        <Glass {...bartGlassCorner(box.diameter)} />
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

/** The disc is drawn on a canvas that knows nothing about the foreground's
 * clipping, and `getScreenCTM()` carries no clip information. A character inside
 * an `overflow: hidden` or scrolled ancestor therefore keeps its solid body: the
 * disc would spill past the edge its face is held inside, or stay behind after
 * the character scrolled out of a nested scroll container. `disc` is the screen
 * -space box, so it compares directly against ancestor rects. */
function unclippedWithin(element: Element, stop: Element, disc: BartGlassBox): boolean {
  const right = disc.left + disc.diameter, bottom = disc.top + disc.diameter
  for (let node = element.parentElement; node && node !== stop; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (![style.overflow, style.overflowX, style.overflowY].some(value => value && value !== 'visible')) continue
    const rect = node.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    if (disc.left < rect.left || disc.top < rect.top || right > rect.right || bottom > rect.bottom) return false
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
  // The acknowledgement dies with the frames that justify it: when the canvas is
  // not mounted nothing repaints, so a token left in `painted` would keep a Bart
  // body-free with no glass behind it.
  const ready = capable && !failed && size.width > 0 && size.height > 0
  const context = useMemo(() => ({ host: ready ? host : null, painted: ready ? painted : EMPTY }),
    [ready, host, painted])

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

  /* Re-run only when the observation set changes — capability, failure, a
     registration, the substrate node, the measured size, or an explicit
     backdrop revision. `backdrop` is deliberately absent: it is an element the
     caller usually writes inline, so depending on it would tear this down and
     re-arm the follow window on every parent render. */
  useEffect(() => {
    if (!capable || failed || !foreground.current) return
    const layer = foreground.current
    const follow = createLiquidFollow(() => {
      if (failure.current) return
      try {
        const base = coordinates.current?.getScreenCTM()
        // A collapsed ancestor makes the CTM singular; inverse() throws rather
        // than returning null, and a transient collapse must not latch glass off.
        const inverse = base && base.a * base.d - base.b * base.c !== 0 ? base.inverse() : null
        const next: BodyBox[] = []
        if (inverse) {
          for (const registration of registrations.current.values()) {
            const matrix = registration.element.getScreenCTM()
            if (!matrix || !registration.element.isConnected || !visibleWithin(registration.element, layer)) continue
            // The screen-space disc is the same circle before the inverse, and it
            // is what the ancestor clip rects are expressed against.
            const screen = bartGlassBox(matrix)
            if (!screen || !unclippedWithin(registration.element, layer, screen)) continue
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
  }, [capable, failed, revision, size.width, size.height, substrate, backdropRevision, fail])

  const acknowledge = useCallback((): void => {
    if (failure.current) return
    const next = new Set(boxes.filter(box => registrations.current.get(box.registration.id) === box.registration)
      .map(box => box.registration.token))
    setPainted(current => current.size === next.size && [...current].every(token => next.has(token)) ? current : next)
  }, [boxes])
  return <div ref={root} className={className} data-bart-liquid-stage={failed ? 'failed' : capable ? 'enabled' : 'unsupported'}
    style={{ ...style, position: style?.position ?? 'relative', isolation: 'isolate', padding: 0, border: 0 }}>
    <div style={{ position: 'absolute', inset: 0 }}>
      {capable && !failed ? <LiquidStageBoundary label="bart-liquid" onFail={fail}>
        <LiquidCanvas ref={canvas} frameloop="demand" onError={fail}
          style={{ width: '100%', height: '100%' }} canvasStyle={{ display: 'block', width: '100%', height: '100%' }}>
          {/* The canvas mounts as soon as the stage is capable and stays mounted
              across resizes: `backdrop` is the caller's subtree, and moving it
              between two parents would remount it (and lose any video, canvas
              or focus state inside it) every time the stage re-measures. */}
          <Frame width={Math.max(size.width, 1)} height={Math.max(size.height, 1)}>
            <ZStack alignment="topLeading">
              <Html sizing="fill"><div ref={bindSubstrate} style={{ width: '100%', height: '100%' }}>{backdrop}</div></Html>
              {boxes.map(box => <BodyGlass key={box.registration.id} box={box} theme={theme} />)}
            </ZStack>
          </Frame>
          <PaintedFrame onPaint={acknowledge} />
        </LiquidCanvas>
      </LiquidStageBoundary> : <div style={{ width: '100%', height: '100%' }}>{backdrop}</div>}
    </div>
    <svg ref={coordinates} aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', visibility: 'hidden', pointerEvents: 'none' }} />
    {/* The foreground layer only decides what draws above the canvas; its own box
        must not decide what is clickable. It covers the whole stage, and the
        substrate beneath it is the caller's interactive subtree whenever the
        caller captured one — a window-sized workspace, say — so the layer itself
        stays transparent to the pointer. Interactive foreground elements keep
        working because they already have to opt in with `pointer-events: auto`:
        the layer they sit above is `none` on every stage that has one. */}
    <div ref={foreground} style={{ position: 'relative', width: '100%', height: '100%', mixBlendMode: 'normal', pointerEvents: 'none' }}>
      <BartLiquidContext.Provider value={context}>{children}</BartLiquidContext.Provider>
    </div>
  </div>
}
