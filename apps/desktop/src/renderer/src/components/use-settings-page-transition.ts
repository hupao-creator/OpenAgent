import { useCallback, useLayoutEffect, useRef, useState } from 'react'

export type SettingsPagePhase = 'closed' | 'opening' | 'open' | 'closing'

const OPEN_DURATION = 480
const CLOSE_DURATION = 380
const OPEN_EASING = 'cubic-bezier(.2,.8,.2,1)'
const CLOSE_EASING = 'cubic-bezier(.55,0,.25,1)'
function revealGeometry(root: HTMLElement, opener?: HTMLElement | null) {
  const rect = opener?.isConnected ? opener.getBoundingClientRect() : null
  const viewport = root.getBoundingClientRect()
  const anchored = Boolean(rect && rect.width > 0 && rect.height > 0 &&
    rect.right > viewport.left && rect.left < viewport.right &&
    rect.bottom > viewport.top && rect.top < viewport.bottom)
  const x = anchored && rect ? rect.left + rect.width / 2 - viewport.left : viewport.width / 2
  const y = anchored && rect ? rect.top + rect.height / 2 - viewport.top : viewport.height / 2
  // Cover the farthest corner, including when the button sits at a window edge.
  const radius = Math.hypot(Math.max(x, viewport.width - x), Math.max(y, viewport.height - y)) + 2
  const buttonRadius = anchored && rect ? Math.min(rect.width, rect.height) / 2 : 0
  return {
    anchored,
    collapsedClip: `circle(${buttonRadius}px at ${x}px ${y}px)`,
    expandedClip: `circle(${radius}px at ${x}px ${y}px)`
  }
}

/** Owns only the page transition and background/focus lifecycle, never form state. */
export function useSettingsPageTransition({ open, origin, onClose }: {
  open: boolean; origin?: HTMLElement | null; onClose: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const returnRef = useRef<HTMLButtonElement>(null)
  const [phase, setPhase] = useState<SettingsPagePhase>('closed')
  const phaseRef = useRef<SettingsPagePhase>('closed')
  const animationsRef = useRef<Animation[]>([])
  const materialLayersRef = useRef<HTMLElement[]>([])
  const finishRef = useRef<(() => void) | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const originRef = useRef(origin)

  const transition = useCallback((closing: boolean) => {
    const root = rootRef.current
    const content = contentRef.current
    const background = surfaceRef.current
    if (!root || !content || !background) return

    // Capture the actual composited frame before interrupting an opening motion.
    const currentRoot = getComputedStyle(root)
    const currentContent = getComputedStyle(content)
    const currentClip = currentRoot.clipPath
    const currentOpacity = currentRoot.opacity
    const currentContentOpacity = currentContent.opacity
    const currentColor = getComputedStyle(background).backgroundColor
    const continuing = closing || phaseRef.current === 'closing'
    const currentTints = continuing ? materialLayersRef.current.map(layer => {
      const clone = layer.cloneNode(true) as HTMLElement
      clone.style.opacity = getComputedStyle(layer).opacity
      return clone
    }) : []
    const reversing = phaseRef.current === 'opening' || phaseRef.current === 'closing'
    const progress = reversing
      ? Number(animationsRef.current[0]?.effect?.getComputedTiming().progress ?? 1)
      : 1
    const previousAnimations = animationsRef.current
    finishRef.current = null

    const opener = originRef.current
    const { anchored, collapsedClip, expandedClip } = revealGeometry(root, opener)
    const pageColor = currentRoot.getPropertyValue('--settings-page-surface-color').trim() || 'rgba(242, 245, 249, .5)'
    // Preserve the trigger's actual theme/hover color and alpha rather than
    // introducing a white disk at the start (or end) of the reveal.
    const buttonColor = opener ? getComputedStyle(opener).backgroundColor : 'transparent'
    const fromColor = continuing ? currentColor : buttonColor
    const toColor = closing ? buttonColor : pageColor

    const fromClip = continuing ? currentClip === 'none' ? expandedClip : currentClip : anchored ? collapsedClip : expandedClip
    const toClip = closing && anchored ? collapsedClip : expandedClip
    const fromOpacity = continuing ? currentOpacity : '0'
    const toOpacity = closing ? '0' : '1'
    const fromContentOpacity = continuing ? currentContentOpacity : '0'

    // Pin the starting frame before canceling old effects. React phase changes do
    // not alter any visual property; CSS and WAAPI never compete for the endpoint.
    root.style.clipPath = fromClip
    root.style.opacity = fromOpacity
    background.style.backgroundColor = fromColor
    content.style.opacity = fromContentOpacity
    // Keep both possible Bart landing seats fixed while the page clips/fades.
    content.style.transform = 'none'
    for (const animation of previousAnimations) animation.cancel()
    materialLayersRef.current.forEach(layer => layer.remove())
    materialLayersRef.current = []
    animationsRef.current = []
    root.style.visibility = 'visible'
    root.style.willChange = 'clip-path, opacity'
    content.style.willChange = 'opacity'
    phaseRef.current = closing ? 'closing' : 'opening'
    setPhase(phaseRef.current)

    const finish = () => {
      if (finishRef.current !== finish) return
      finishRef.current = null
      // Write the terminal frame synchronously BEFORE removing fill effects.
      // A closed page remains hidden even if its parent unmount is deferred.
      root.style.visibility = closing ? 'hidden' : 'visible'
      root.style.clipPath = closing ? toClip : revealGeometry(root, originRef.current).expandedClip
      root.style.opacity = toOpacity
      background.style.backgroundColor = toColor
      materialLayersRef.current.forEach(layer => layer.remove())
      materialLayersRef.current = []
      content.style.opacity = closing ? '0' : '1'
      content.style.transform = 'none'
      for (const animation of animationsRef.current) animation.cancel()
      animationsRef.current = []
      root.style.willChange = ''
      content.style.willChange = ''
      phaseRef.current = closing ? 'closed' : 'open'
      setPhase(phaseRef.current)
      if (closing) onCloseRef.current()
      else if (document.activeElement === root || !root.contains(document.activeElement)) {
        returnRef.current?.focus({ preventScroll: true })
      }
    }
    finishRef.current = finish
    if (typeof root.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { finish(); return }

    const duration = anchored
      ? (closing ? CLOSE_DURATION : OPEN_DURATION) * (reversing ? Math.max(.25, progress) : 1)
      : 160
    const timing: KeyframeAnimationOptions = {
      duration,
      easing: closing ? CLOSE_EASING : OPEN_EASING,
      fill: 'both'
    }
    // Reach the trigger BEFORE dissolving. With clip-path only at offsets 0/1,
    // the .88 opacity keyframe starts fading a still-large circle (~210px at
    // 1369x994), making the visible surface disappear short of the button.
    const surface = root.animate(closing ? [
      { clipPath: fromClip, opacity: fromOpacity, offset: 0 },
      { clipPath: toClip, opacity: fromOpacity, offset: .88 },
      { clipPath: toClip, opacity: 0, offset: 1 }
    ] : [
      { clipPath: fromClip, opacity: fromOpacity, offset: 0 },
      { opacity: 1, offset: .12 },
      { clipPath: toClip, opacity: 1, offset: 1 }
    ], timing)
    // Two static tints cross-fade on compositor opacity tracks. Animating the
    // background-color itself could ask the blocked Renderer to repaint it.
    background.style.backgroundColor = 'transparent'
    const material = [fromColor, toColor].map((color, index) => {
      const layer = document.createElement('div')
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none'
      layer.style.backgroundColor = color
      if (index === 0) layer.append(...currentTints)
      background.append(layer)
      materialLayersRef.current.push(layer)
      const from = index ? 0 : 1, to = index ? 1 : 0
      return layer.animate(closing ? [{ opacity: from, offset: 0 }, { opacity: from, offset: .88 }, { opacity: to, offset: 1 }]
        : [{ opacity: from }, { opacity: to }], timing)
    })
    const contents = content.animate(closing ? [
      { opacity: fromContentOpacity, offset: 0 },
      { opacity: Number(fromContentOpacity) * .85, offset: .55 },
      { opacity: 0, offset: 1 }
    ] : [
      { opacity: fromContentOpacity, offset: 0 },
      { opacity: Math.max(Number(fromContentOpacity), .7), offset: .45 },
      { opacity: 1, offset: 1 }
    ], timing)
    animationsRef.current = [surface, contents, ...material]
    Promise.all(animationsRef.current.map((animation) => animation.finished))
      .then(finish, () => undefined)
  }, [])

  const close = useCallback(() => {
    if (phaseRef.current === 'closing' || phaseRef.current === 'closed') return
    transition(true)
  }, [transition])

  useLayoutEffect(() => {
    if (!open || !rootRef.current) return
    const root = rootRef.current
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    originRef.current = origin ?? null
    const background = Array.from(root.parentElement?.children ?? [])
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== root)
      .map((element) => ({ element, inert: element.hasAttribute('inert'), hidden: element.getAttribute('aria-hidden') }))
    transition(false)
    returnRef.current?.focus({ preventScroll: true })
    for (const { element } of background) {
      element.setAttribute('inert', '')
      element.setAttribute('aria-hidden', 'true')
    }
    const resize = () => {
      if (finishRef.current) finishRef.current()
      else if (phaseRef.current === 'open') root.style.clipPath = revealGeometry(root, originRef.current).expandedClip
    }
    // The parent keeps this page mounted until Bart lands. Its background is
    // inert, so Cmd+, must remain a live reopen command during that return.
    const reopen = (event: KeyboardEvent): void => {
      const modifier = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
      if (modifier && event.key === ',' && !event.isComposing &&
        (phaseRef.current === 'closing' || phaseRef.current === 'closed')) {
        event.preventDefault()
        transition(false)
      }
    }
    window.addEventListener('keydown', reopen)
    window.addEventListener('resize', resize)
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const motionChanged = (): void => { if (reduced?.matches) finishRef.current?.() }
    reduced?.addEventListener?.('change', motionChanged)
    return () => {
      window.removeEventListener('keydown', reopen)
      window.removeEventListener('resize', resize)
      reduced?.removeEventListener?.('change', motionChanged)
      finishRef.current = null
      root.style.visibility = 'hidden'
      for (const animation of animationsRef.current) animation.cancel()
      animationsRef.current = []
      materialLayersRef.current.forEach(layer => layer.remove())
      materialLayersRef.current = []
      phaseRef.current = 'closed'
      for (const { element, inert, hidden } of background) {
        if (!inert) element.removeAttribute('inert')
        if (hidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', hidden)
      }
      const target = originRef.current?.isConnected ? originRef.current : active
      if (target?.isConnected) target.focus({ preventScroll: true })
    }
  }, [open, transition])

  return { rootRef, surfaceRef, contentRef, returnRef, phase, close }
}
