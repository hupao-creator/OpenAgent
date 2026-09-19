const QUIET_FOCUS = 'data-quiet-focus'
const KEYBOARD_FOCUS = 'data-keyboard-focus'
const BUTTONS = 'button, summary, a[href], [role="button"]'
const TEXT_ENTRY = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift'])
const KEYBOARD_FOCUS_REQUEST = 'openagent-keyboard-focus-request'

/** Explicit navigation commands (such as Cmd/Ctrl+K) opt into the same cue as Tab. */
export function focusForKeyboardNavigation(target: HTMLElement | null | undefined): void {
  if (!target) return
  target.dispatchEvent(new Event(KEYBOARD_FOCUS_REQUEST, { bubbles: true }))
  target.focus()
}

/** Keep real focus, but reserve button focus rings for intentional keyboard navigation. */
export function installButtonFocusVisibility(doc: Document): () => void {
  let navigating = false
  let marked: HTMLElement | null = null
  const clear = (): void => {
    marked?.removeAttribute(QUIET_FOCUS)
    marked?.removeAttribute(KEYBOARD_FOCUS)
    marked = null
  }
  const update = (): void => {
    const active = doc.activeElement
    if (marked !== active) clear()
    if (active instanceof HTMLElement && active.matches(BUTTONS)) {
      // Put the marker on the control so liquid capture's subtree observer also
      // sees a changed focus cue when the active element itself stays the same.
      active.toggleAttribute(QUIET_FOCUS, !navigating)
      // Chromium may withhold :focus-visible after a modified shortcut that
      // follows pointer input. Explicit keyboard navigation still needs a cue.
      active.toggleAttribute(KEYBOARD_FOCUS, navigating)
      marked = active
    }
  }
  const onPointer = (): void => { navigating = false; update() }
  const onKeyboardFocusRequest = (): void => { navigating = true; update() }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || MODIFIER_KEYS.has(event.key)) return
    if (event.metaKey || event.ctrlKey || event.altKey) {
      navigating = false
    } else if (event.key === 'Tab' || (NAVIGATION_KEYS.has(event.key) &&
      !(event.target instanceof Element && event.target.closest(TEXT_ENTRY)))) {
      navigating = true
    } else {
      // Enter/Space activation and Escape restoration inherit navigation intent.
      return
    }
    update()
  }
  doc.addEventListener('keydown', onKeyDown, true)
  doc.addEventListener('pointerdown', onPointer, true)
  doc.addEventListener('focusin', update, true)
  doc.addEventListener('focusout', clear, true)
  doc.addEventListener(KEYBOARD_FOCUS_REQUEST, onKeyboardFocusRequest, true)
  // Also cover descendant autoFocus/layout effects that ran before installation.
  update()
  return () => {
    doc.removeEventListener('keydown', onKeyDown, true)
    doc.removeEventListener('pointerdown', onPointer, true)
    doc.removeEventListener('focusin', update, true)
    doc.removeEventListener('focusout', clear, true)
    doc.removeEventListener(KEYBOARD_FOCUS_REQUEST, onKeyboardFocusRequest, true)
    clear()
  }
}
