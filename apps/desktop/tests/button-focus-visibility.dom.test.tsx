// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { focusForKeyboardNavigation, installButtonFocusVisibility } from '../src/renderer/src/button-focus-visibility'

let dispose: (() => void) | undefined
let first: HTMLButtonElement
let second: HTMLButtonElement
const quiet = (element: HTMLElement): boolean => element.hasAttribute('data-quiet-focus')
const key = (key: string, options: KeyboardEventInit = {}): void => {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }))
}

beforeEach(() => {
  document.body.innerHTML = '<button>First</button><button>Second</button><input aria-label="Draft">'
  first = document.querySelectorAll('button')[0]!
  second = document.querySelectorAll('button')[1]!
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

describe('application button focus cues', () => {
  it('keeps automatic focus quiet, including autoFocus before the app layout effect', () => {
    first.focus()
    dispose = installButtonFocusVisibility(document)
    expect(first).toHaveFocus()
    expect(quiet(first)).toBe(true)
    second.focus()
    expect(second).toHaveFocus()
    expect(quiet(second)).toBe(true)
    expect(quiet(first)).toBe(false)
    second.blur()
    expect(quiet(second)).toBe(false)
  })

  it('applies the same policy to disclosure, link and custom button controls', () => {
    dispose = installButtonFocusVisibility(document)
    const surface = document.createElement('div')
    surface.innerHTML = '<details><summary>Details</summary></details><a href="#">Link</a><span role="button" tabindex="0">Action</span>'
    document.body.append(surface)
    for (const control of surface.querySelectorAll<HTMLElement>('summary, a, [role="button"]')) {
      control.focus()
      expect(control).toHaveFocus()
      expect(quiet(control)).toBe(true)
    }
    const input = document.querySelector('input')!
    input.focus()
    expect(input).toHaveFocus()
    expect(quiet(input)).toBe(false)
  })

  it('preserves cues through Tab, Enter and Escape, and clears them on pointer input', () => {
    dispose = installButtonFocusVisibility(document)
    first.focus()
    key('Tab')
    second.focus()
    expect(quiet(second)).toBe(false)
    key('Enter')
    first.focus()
    expect(quiet(first)).toBe(false)
    key('Escape')
    second.focus()
    expect(quiet(second)).toBe(false)
    second.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(second).toHaveFocus()
    expect(quiet(second)).toBe(true)
    key('Tab', { shiftKey: true })
    first.focus()
    expect(quiet(first)).toBe(false)
  })

  it.each(['metaKey', 'ctrlKey', 'altKey'] as const)('silences page commands using %s after keyboard navigation', modifier => {
    dispose = installButtonFocusVisibility(document)
    key('Tab')
    first.focus()
    expect(quiet(first)).toBe(false)
    key(',', { [modifier]: true })
    expect(first).toHaveFocus()
    expect(quiet(first)).toBe(true)
    second.focus()
    expect(quiet(second)).toBe(true)
  })

  it('treats arrows as control navigation, but not caret movement or composition', () => {
    dispose = installButtonFocusVisibility(document)
    const input = document.querySelector('input')!
    input.focus()
    key('ArrowLeft')
    second.focus()
    expect(quiet(second)).toBe(true)
    key('ArrowDown', { isComposing: true })
    expect(quiet(second)).toBe(true)
    for (const navigation of ['ArrowDown', 'Home', 'End']) {
      second.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      key(navigation)
      expect(quiet(second)).toBe(false)
    }
    key('Meta', { metaKey: true })
    expect(quiet(second)).toBe(false)
  })

  it('lets an explicit navigation command opt back into cues and continue navigating', () => {
    dispose = installButtonFocusVisibility(document)
    first.focus()
    key('k', { metaKey: true })
    focusForKeyboardNavigation(second)
    expect(second).toHaveFocus()
    expect(quiet(second)).toBe(false)
    expect(second).toHaveAttribute('data-keyboard-focus')
    key('Enter')
    first.focus()
    expect(quiet(first)).toBe(false)
    expect(first).toHaveAttribute('data-keyboard-focus')
    expect(second).not.toHaveAttribute('data-keyboard-focus')
    key(',', { metaKey: true })
    expect(first).not.toHaveAttribute('data-keyboard-focus')
    expect(quiet(first)).toBe(true)
  })

  it('cleans up markers and listeners before a remount', () => {
    dispose = installButtonFocusVisibility(document)
    first.focus()
    dispose()
    expect(quiet(first)).toBe(false)
    second.focus()
    expect(quiet(second)).toBe(false)
    dispose = installButtonFocusVisibility(document)
    expect(quiet(second)).toBe(true)
    key('Tab')
    expect(quiet(second)).toBe(false)
    expect(second).toHaveAttribute('data-keyboard-focus')
    dispose()
    expect(second).not.toHaveAttribute('data-keyboard-focus')
  })
})
