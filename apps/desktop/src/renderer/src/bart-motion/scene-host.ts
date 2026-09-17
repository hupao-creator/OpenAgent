import { getBartPresenceCoordinator } from './presence'
import { MOTION_LIMITS } from './runtime-limits'

// Shared cameras, scroll ancestors and masks are resources even when the actors
// differ. A token owns all of them until the matching DOM handoff or safe abort.
const owners = new WeakMap<Element, symbol>()
let sequence = 0
type SavedStyle = { element: HTMLElement; property: string; value: string; priority: string; ownedValue: string }

/** Wait without a scene lease. Late decodes must still observe the AbortSignal. */
export async function prepareWithinBudget<T>(
  prepare: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  milliseconds: number = MOTION_LIMITS.preparationTimeout
): Promise<T> {
  const controller = new AbortController()
  const abort = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timeout = setTimeout(() => controller.abort(new Error('Bart preparation exceeded its budget')), milliseconds)
  let onAbort: (() => void) | undefined
  try {
    controller.signal.throwIfAborted()
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([aborted, prepare(controller.signal)])
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Acquire immediately before the final DOM measurement. There is no queue here:
 * callers prewarm without this lock and use the existing overview FIFO to wait.
 * Native scroll and keyboard ownership stay fixed even while Host JS is blocked.
 */
export function sealMotionScene({ root, canvas, covered, interactions = covered, resources = [], scroll = [], freezeTransforms = [], onExpire }: {
  root: HTMLElement
  canvas: HTMLCanvasElement
  covered: readonly HTMLElement[]
  /** Regions can remain visible while their prepared camera owns interaction. */
  interactions?: readonly HTMLElement[]
  resources?: readonly HTMLElement[]
  scroll?: readonly HTMLElement[]
  freezeTransforms?: readonly HTMLElement[]
  onExpire?: () => void
}) {
  const token = Symbol('bart-scene'), id = `bart-scene-${++sequence}`
  const claims = [...new Set([root, canvas, ...covered, ...interactions, ...resources, ...scroll, ...freezeTransforms])]
  if (claims.some(element => owners.has(element))) throw new Error('Bart scene resources already owned')
  if (claims.some(element => !element.isConnected)) throw new Error('Bart scene resource detached')
  claims.forEach(element => owners.set(element, token))
  const sealedAt = performance.now()
  const styles: SavedStyle[] = []
  const previousInert = interactions.map(element => ({ element, inert: element.inert }))
  const previousFocus = document.activeElement instanceof HTMLElement && interactions.some(element => element.contains(document.activeElement))
    ? document.activeElement as HTMLElement : null
  let closed = false, presented = false, expired = false
  let releasePresence: (() => void) | undefined
  let preparationTimer: ReturnType<typeof setTimeout> | undefined
  const owned = (): boolean => !closed && claims.every(element => owners.get(element) === token)
  const write = (element: HTMLElement, property: string, value: string): void => {
    const saved = { element, property, value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property), ownedValue: '' }
    element.style.setProperty(property, value, 'important')
    saved.ownedValue = element.style.getPropertyValue(property)
    styles.push(saved)
  }
  const release = ({ restoreInteraction = true }: { restoreInteraction?: boolean } = {}): boolean => {
    if (!owned()) return false
    clearTimeout(preparationTimer)
    // All native ownership writes are in one Host task. The canvas is hidden
    // before its Worker is released; a late Worker message cannot blank new UI.
    canvas.hidden = true
    root.removeAttribute('data-bart-scene')
    for (const { element, property, value, priority, ownedValue } of styles.reverse()) {
      // A newer business commit may have replaced an inline value while the
      // scene was being aborted. Never restore its older captured value over it.
      if (element.style.getPropertyValue(property) !== ownedValue || element.style.getPropertyPriority(property) !== 'important') continue
      if (value) element.style.setProperty(property, value, priority)
      else element.style.removeProperty(property)
    }
    if (restoreInteraction) previousInert.forEach(({ element, inert }) => { element.inert = inert })
    claims.forEach(element => owners.delete(element))
    closed = true
    releasePresence?.()
    // Do not steal focus if the user moved it to an unrelated live region.
    if (previousFocus?.isConnected && !previousFocus.closest('[inert]') &&
        (document.activeElement === document.body || document.activeElement === null)) previousFocus.focus({ preventScroll: true })
    return true
  }
  try {
    canvas.hidden = true
    for (const element of new Set(freezeTransforms)) {
      // Read before disabling a transition, otherwise getComputedStyle would
      // already report its destination. Important values also pin WAAPI effects.
      const computed = getComputedStyle(element)
      const values = ['transform', 'translate', 'rotate', 'scale'].map(property => [property, computed.getPropertyValue(property)] as const)
      write(element, 'transition', 'none')
      values.forEach(([property, value]) => { if (value) write(element, property, value) })
    }
    for (const element of new Set(scroll)) {
      write(element, 'scrollbar-gutter', 'stable')
      write(element, 'overflow', 'hidden')
      write(element, 'overscroll-behavior', 'none')
    }
    previousFocus?.blur()
    previousInert.forEach(({ element }) => { element.inert = true })
  } catch (error) { release(); throw error }
  const expire = (): void => { expired = true; release(); onExpire?.() }
  preparationTimer = setTimeout(expire, MOTION_LIMITS.sealTimeout)
  return {
    id,
    sealedAt,
    owns: owned,
    show(): boolean {
      if (expired) throw new Error('Bart scene sealing exceeded its budget')
      if (!owned() || presented || claims.some(element => !element.isConnected)) return false
      if (performance.now() - sealedAt > MOTION_LIMITS.sealTimeout) {
        expire()
        throw new Error('Bart scene sealing exceeded its budget')
      }
      clearTimeout(preparationTimer)
      presented = true
      covered.forEach(element => write(element, 'visibility', 'hidden'))
      if (covered.some(element => element.closest('.bart-dock') || element.querySelector('.bart-dock'))) releasePresence = getBartPresenceCoordinator().hold(token)
      root.setAttribute('data-bart-scene', id)
      canvas.hidden = false
      return true
    },
    /** A revision check belongs to the caller; release always reveals current business DOM. */
    release,
    get presented(): boolean { return presented }
  }
}

/** Final measurements are invalid if any contributing ancestor moves or resizes. */
export function sealGeometry(elements: readonly HTMLElement[], revision = () => elements.map(element => element.textContent).join('\0')): () => boolean {
  const version = revision()
  const snapshot = elements.map(element => ({ element, rect: element.getBoundingClientRect() }))
  return () => revision() === version && snapshot.every(({ element, rect }) => {
    if (!element.isConnected) return false
    const current = element.getBoundingClientRect()
    return Math.max(Math.abs(current.x - rect.x), Math.abs(current.y - rect.y),
      Math.abs(current.width - rect.width), Math.abs(current.height - rect.height)) < .5
  })
}
