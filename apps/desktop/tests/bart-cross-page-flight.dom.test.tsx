// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BartCrossPageFlight } from '../src/renderer/src/components/BartCrossPageFlight'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Reduced motion is the one skip reason that needs no SVG to measure. */
const reducedMotion = (): void => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
}

describe('BartCrossPageFlight', () => {
  it('answers a request it cannot fly, so the caller can drop it', async () => {
    // Left unanswered, the request outlives the flight it never had: the caller
    // only clears on being told the copy is not in the air, and the next request
    // of the same direction is then the identical value, which bails out of the
    // re-render that would have started one. Bart snaps instead of flying.
    reducedMotion()
    const onActiveChange = vi.fn()
    const view = render(<BartCrossPageFlight direction={null} onActiveChange={onActiveChange} />)
    onActiveChange.mockClear()
    view.rerender(<BartCrossPageFlight direction="to-dock" onActiveChange={onActiveChange} />)
    await act(async () => { await Promise.resolve() })
    expect(onActiveChange).toHaveBeenCalledWith(false, 'to-dock')
  })

  it('says nothing when the request is merely withdrawn', () => {
    const onActiveChange = vi.fn()
    const view = render(<BartCrossPageFlight direction="to-seat" onActiveChange={onActiveChange} />)
    onActiveChange.mockClear()
    view.rerender(<BartCrossPageFlight direction={null} onActiveChange={onActiveChange} />)
    expect(onActiveChange).not.toHaveBeenCalled()
  })
})
