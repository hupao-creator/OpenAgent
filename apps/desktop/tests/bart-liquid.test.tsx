// @vitest-environment jsdom
import { useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { BartLogo } from '../src/renderer/src/components/BartLogo'
import { BartLiquidContext, type BartLiquidRegistration } from '../src/renderer/src/liquid/bart-liquid-context'
import { BartLiquidBoundary, BartLiquidStage } from '../src/renderer/src/liquid/BartLiquidStage'

vi.mock('../src/renderer/src/bart-motion/CharacterCanvas', () => ({ CharacterCanvas: () => null }))
vi.mock('@liquid-dom/react', () => ({
  Frame: () => null, Glass: () => null, GlassContainer: () => null, Html: () => null,
  LiquidCanvas: () => null, Padding: () => null, ZStack: () => null, useFrame: () => undefined
}))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** A host acknowledgement, not a GPU mock: isolates the body-ownership contract. */
function Acknowledged({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const [registration, setRegistration] = useState<BartLiquidRegistration | null>(null)
  const host = useMemo(() => ({ register: (value: BartLiquidRegistration) => {
    setRegistration(value)
    return () => setRegistration(current => current === value ? null : current)
  } }), [])
  const value = useMemo(() => ({ host, painted: new Set(enabled && registration ? [registration.token] : []) }), [host, registration, enabled])
  return <BartLiquidContext.Provider value={value}>{children}</BartLiquidContext.Provider>
}

describe('Bart glass ownership and fallback', () => {
  it('stays solid without an acknowledged host, including requested glass', () => {
    const view = render(<BartLogo size={64} bodyMaterial="liquidGlass" />)
    expect(view.container.querySelector('svg')?.getAttribute('data-body-material')).toBe('solid')
    expect(view.container.querySelector('.bart-bot > path')?.getAttribute('fill')).toBe('#10110f')
  })
  it('uses glass as the body, preserves independent dark eyes and revokes on failure', () => {
    const view = render(<Acknowledged><BartLogo size={64} bodyMaterial="liquidGlass" eyeColor="#000000" /></Acknowledged>)
    expect(view.container.querySelector('svg')?.getAttribute('data-body-material')).toBe('liquidGlass')
    expect(view.container.querySelector('.bart-bot > path')?.getAttribute('fill')).toBe('none')
    expect(view.container.querySelector('.bart-face > rect')?.getAttribute('fill')).toBe('#000000')
    expect(view.container.querySelector('svg')?.style.mixBlendMode).toBe('normal')
    view.rerender(<Acknowledged enabled={false}><BartLogo size={64} bodyMaterial="liquidGlass" eyeColor="#000000" /></Acknowledged>)
    expect(view.container.querySelector('svg')?.getAttribute('data-body-material')).toBe('solid')
    expect(view.container.querySelector('.bart-bot > path')?.getAttribute('fill')).toBe('#10110f')
  })
  it('updates colours and excludes non-circular layouts', () => {
    const view = render(<Acknowledged><BartLogo size={64} bodyMaterial="liquidGlass" /></Acknowledged>)
    view.rerender(<Acknowledged><BartLogo size={64} layout="permission" bodyMaterial="liquidGlass" bodyColor="#123456" eyeColor="#654321" /></Acknowledged>)
    expect(view.container.querySelector('svg')?.getAttribute('data-body-material')).toBe('solid')
    expect(view.container.querySelector('.bart-bot > path')?.getAttribute('fill')).toBe('#123456')
    expect(view.container.querySelector('.bart-face > rect')?.getAttribute('fill')).toBe('#654321')
  })
  it('contains a throwing canvas mount and restores a visible solid body', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new Error('No WebGPU adapter / context')
    function ThrowingCanvas(): null { useLayoutEffect(() => { throw error }, []); return null }
    function Scene() {
      const [failed, setFailed] = useState(false)
      return <>
        {!failed && <BartLiquidBoundary onFailure={() => setFailed(true)}><ThrowingCanvas /></BartLiquidBoundary>}
        <Acknowledged enabled={!failed}><BartLogo size={64} bodyMaterial="liquidGlass" /></Acknowledged>
        <button>still interactive</button>
      </>
    }
    const view = render(<Scene />)
    expect(view.getByRole('button').textContent).toBe('still interactive')
    expect(view.container.querySelector('svg')?.getAttribute('data-body-material')).toBe('solid')
    expect(view.container.querySelector('.bart-bot > path')?.getAttribute('fill')).toBe('#10110f')
  })
  it('missing capture support leaves the backdrop and actor in ordinary DOM', () => {
    vi.stubGlobal('navigator', { gpu: undefined })
    const view = render(<BartLiquidStage backdrop={<div>real backdrop</div>} style={{ width: 640, height: 640 }}>
      <BartLogo size={640} bodyMaterial="liquidGlass" />
    </BartLiquidStage>)
    expect(view.getByText('real backdrop')).toBeTruthy()
    expect(view.container.querySelector('[data-bart-liquid-stage]')?.getAttribute('data-bart-liquid-stage')).toBe('unsupported')
    expect(view.container.querySelector('.bart-logo')?.getAttribute('data-body-material')).toBe('solid')
  })
})
