import { flushSync } from 'react-dom'
import type { OpenAgentAppearance } from '../../shared/openagent-settings'

export const THEME_TRANSITION_CLASS = 'theme-transition'

/**
 * Main repaints the resolved scheme within a frame or two of the settings
 * mutation, and a preference only decides the outcome itself when it names a
 * scheme outright. The timeout therefore only bounds the OS-decided case,
 * where an unchanged scheme means there is nothing to animate.
 */
const SCHEME_FLIP_TIMEOUT_MS = 120

interface ViewTransitionLike {
  finished: Promise<unknown>
  skipTransition?: () => void
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => ViewTransitionLike
}

/** Resolves the dark state a preference implies, or null when only the OS decides. */
export function predictsDark(appearance: OpenAgentAppearance): boolean | null {
  return appearance === 'dark' ? true : appearance === 'light' ? false : null
}

export function waitForSchemeFlip(
  query: MediaQueryList, wasDark: boolean, timeoutMs = SCHEME_FLIP_TIMEOUT_MS
): Promise<boolean> {
  if (query.matches !== wasDark) return Promise.resolve(true)
  return new Promise((resolve) => {
    const settle = (flipped: boolean): void => {
      query.removeEventListener('change', onFlip)
      clearTimeout(timer)
      resolve(flipped)
    }
    const onFlip = (): void => settle(query.matches !== wasDark)
    const timer = setTimeout(() => settle(false), timeoutMs)
    query.addEventListener('change', onFlip)
  })
}

/**
 * Cross-fades the window through a blur while Main switches appearance.
 *
 * The renderer owns no theme state: the outgoing frame is captured before the
 * mutation, and the blur class is attached only when the change is expected to
 * move the resolved scheme. A preference that leaves the scheme alone ends with
 * no animation at all — the blur is withheld and Chromium's own cross-fade is
 * skipped — so an unchanged window never dissolves. The returned promise tracks
 * the mutation, not the animation, so settings autosave keeps its own timing.
 */
export function runThemeTransition(
  appearance: OpenAgentAppearance, apply: () => Promise<void>
): Promise<void> {
  const transitionDocument = document as ViewTransitionDocument
  if (!transitionDocument.startViewTransition || typeof window.matchMedia !== 'function') return apply()
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const wasDark = query.matches
  const predicted = predictsDark(appearance)
  if (predicted !== null && predicted === wasDark) return apply()

  const root = document.documentElement
  const cleanup = (): void => { root.classList.remove(THEME_TRANSITION_CLASS) }
  let settleApplied!: () => void
  let failApplied!: (error: unknown) => void
  const applied = new Promise<void>((resolve, reject) => {
    settleApplied = resolve
    failApplied = reject
  })
  let skipTransition: (() => void) | undefined
  try {
    const transition = transitionDocument.startViewTransition(async () => {
      try {
        await apply()
      } catch (error) {
        failApplied(error)
        throw error
      }
      settleApplied()
      if (!await waitForSchemeFlip(query, wasDark) && predicted === null) {
        // The preference left the resolved scheme alone, so both captured frames
        // are the same picture. Chromium would still cross-fade them by default.
        skipTransition?.()
        return
      }
      root.classList.add(THEME_TRANSITION_CLASS)
      flushSync(() => undefined)
    })
    skipTransition = (): void => transition.skipTransition?.()
    void transition.finished.then(cleanup, cleanup)
  } catch {
    // Frame capture failed before the callback could run, so the mutation still
    // has to land; it just arrives without an animation.
    cleanup()
    apply().then(settleApplied, failApplied)
  }
  return applied
}
