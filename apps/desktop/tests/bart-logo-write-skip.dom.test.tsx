// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BartLogo } from '../src/renderer/src/components/BartLogo'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Bart renderer frame isolation', () => {
  it('does not schedule a renderer frame loop, including running micro logos', () => {
    const frame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', frame)
    const view = render(<BartLogo size={11} running />)
    expect(view.container.querySelector('path')?.getAttribute('d')).toBeTruthy()
    view.rerender(<BartLogo size={210} operation={{ id: 'send', kind: 'send', phase: 'running' }} />)
    expect(frame).not.toHaveBeenCalled()
  })

  it('leaves a static character when OffscreenCanvas is unavailable', () => {
    vi.stubGlobal('Worker', undefined)
    const view = render(<BartLogo size={210} running />)
    const svg = view.container.querySelector('.bart-logo')!
    expect(svg.getAttribute('data-worker-ready')).toBeNull()
    expect(svg.querySelector('.bart-face rect')).not.toBeNull()
    expect(svg.querySelector('.bart-bot path')?.getAttribute('d')).toMatch(/^M /)
  })
})
