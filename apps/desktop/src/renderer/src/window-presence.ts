import { useEffect, useState } from 'react'

/**
 * Whether the page is on screen at all. A window that is hidden — minimised, on
 * another desktop, behind another app's full screen — cannot be read, while a
 * window that is merely not in front of the reader still can be.
 */
export function isWindowVisible(): boolean {
  return document.visibilityState !== 'hidden'
}

/**
 * Whether the reader is actually looking at this window. A visible window in
 * the background presents nothing, so a surface that times a look must ask for
 * this rather than mere visibility.
 */
export function isWindowPresenting(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** Tracks visibility across `visibilitychange`, seeding the current state. */
export function useWindowVisible(): boolean {
  const [visible, setVisible] = useState(isWindowVisible)
  useEffect(() => {
    const sync = (): void => setVisible(isWindowVisible())
    document.addEventListener('visibilitychange', sync)
    sync()
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  return visible
}
