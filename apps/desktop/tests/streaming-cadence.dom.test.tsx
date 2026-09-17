// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useStreamingCadence } from '../../../packages/openagent-plugin-kit/src/renderer/hooks/useStreamingCadence'

/**
 * Renders the hook's value and forces an urgent render right after each change.
 * A publication is handed to the consumer through `startTransition`, so that
 * second render is the one that lands before the transition commits — the window
 * a consumer would otherwise be handed superseded text inside.
 */
function Probe({ content, values }: { content: string; values: string[] }): null {
  const cadenced = useStreamingCadence(content, true)
  values.push(cadenced)
  const [, setTick] = useState(0)
  useEffect(() => {
    setTick((current) => current + 1)
  }, [content])
  return null
}

afterEach(cleanup)

describe('streaming cadence', () => {
  it('never hands back the superseded message after a replacement publication', () => {
    const values: string[] = []
    const view = render(<Probe content="first message" values={values} />)

    act(() => {
      view.rerender(<Probe content="a completely different message" values={values} />)
    })

    const seenReplacement = values.indexOf('a completely different message')
    expect(seenReplacement).toBeGreaterThanOrEqual(0)
    // Anything after the replacement has been shown must at least still be the
    // replacement: going back reads as the message reverting, and makes the
    // incremental renderer reset the whole tree twice.
    expect(values.slice(seenReplacement).filter((value) => value === 'first message')).toEqual([])
  })

  it('never hands back the longer text a truncation cut short', () => {
    // The other way the deferred value misses the publication: the message is
    // cut back to a strict prefix of itself, so the stale value extends the new
    // one rather than being extended by it.
    const values: string[] = []
    const view = render(<Probe content="first message" values={values} />)

    act(() => {
      view.rerender(<Probe content="first" values={values} />)
    })

    const seenTruncation = values.indexOf('first')
    expect(seenTruncation).toBeGreaterThanOrEqual(0)
    expect(values.slice(seenTruncation).filter((value) => value === 'first message')).toEqual([])
  })
})
