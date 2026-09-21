// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessBartActivity } from '@openagent/contracts/renderer'
import { BartLogo } from '../src/renderer/src/components/BartLogo'
import { BartDock, interventionVisualState } from '../src/renderer/src/components/BartDock'

let frameTime = 0

function flushFrames(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function eyeCenters(svg: HTMLElement): { left: { x: number; y: number }; right: { x: number; y: number } } {
  const eyes = svg.querySelectorAll('.bart-face rect')
  if (eyes.length !== 2) {
    throw new Error(`Expected 2 eyes, found ${eyes.length}`)
  }
  const left = eyes[0]
  const right = eyes[1]
  const leftX = Number(left.getAttribute('x'))
  const leftY = Number(left.getAttribute('y'))
  const rightX = Number(right.getAttribute('x'))
  const rightY = Number(right.getAttribute('y'))
  const leftW = Number(left.getAttribute('width'))
  const leftH = Number(left.getAttribute('height'))
  const rightW = Number(right.getAttribute('width'))
  const rightH = Number(right.getAttribute('height'))
  return {
    left: { x: leftX + leftW / 2, y: leftY + leftH / 2 },
    right: { x: rightX + rightW / 2, y: rightY + rightH / 2 }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frameTime += 16
    return window.setTimeout(() => callback(frameTime), 16)
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => clearTimeout(id)))
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  frameTime = 0
  vi.restoreAllMocks()
})

describe('BartLogo idle eye behavior', () => {
  it('keeps the resident eye proportions beneath the tool pose for both short and long names', () => {
    const noop = (): void => {}
    const element = (foregroundActivity?: HarnessBartActivity): React.JSX.Element => (
      <BartDock
        activityContext={{ threadKey: 'bart-logo-test', execution: foregroundActivity ? {
          executionId: foregroundActivity.executionId, status: 'running'
        } : null }}
        threadOpen={false} sessionIdle={!foregroundActivity}
        inputOpen={false} inputValue="" bartAttachments={[]}
        foregroundActivity={foregroundActivity} running={Boolean(foregroundActivity)}
        onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
        onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop}
      />
    )
    const view = render(element())
    const dimensions = (): number[][] => Array.from(view.container.querySelectorAll('.bart-face rect'),
      (eye) => [Number(eye.getAttribute('width')), Number(eye.getAttribute('height'))])
    const resident = dimensions()
    for (const [index, toolName] of ['read_file', 'mcp__github__create_issue'].entries()) {
      view.rerender(element({
        kind: 'tool-call', toolName, callId: `call-${index}`,
        sequence: index + 1, executionId: 'execution-1'
      }))
      flushFrames(2000)
      // The shared CSS compacts these upright eyes. Reusing the old thinking
      // circles instead would yield two wide, unequal ovals after the squeeze.
      expect(dimensions()).toEqual(resident)
      expect(Number(view.container.querySelector('.bart-status-dot')?.getAttribute('r'))).toBeCloseTo(19, 1)
      expect(view.container.querySelector('.bart-role-tool-name')?.textContent).toBe(toolName)
    }
  })

  it('holds the focus pose instead of launching a provider token for a running start', () => {
    const logo = render(
      <BartLogo
        size={210}
        operation={{
          id: 'start-codex-thread',
          kind: 'start',
          phase: 'running',
          harnessId: 'codex'
        }}
      />
    )

    const svg = logo.container.querySelector('.bart-logo')
    expect(svg).toHaveAttribute('data-activity', 'start')
    expect(svg).toHaveAttribute('data-phase', 'running')
    // The Dock flight and the Thread card generation already acknowledge the
    // start; the old body recoil and launched token duplicated it.
    expect(logo.container.querySelector('.bart-provider-dispatch')).toBeNull()
    expect(logo.container.querySelector('.bart-provider-dispatch-trail')).toBeNull()
    expect(logo.container.querySelector('.bart-provider-dispatch-logo')).toBeNull()
    expect(logo.container.querySelector('.bart-provider-dispatch-fallback')).toBeNull()

    const centers = eyeCenters(logo.container)
    expect(Math.abs(centers.left.y - 300)).toBeLessThan(12)
    expect(Math.abs(centers.right.y - 300)).toBeLessThan(12)
  })

  it('does not bounce at the dock when a start operation completes', () => {
    const logo = render(
      <BartLogo
        size={210}
        operation={{
          id: 'completed-start',
          kind: 'start',
          phase: 'completed',
          harnessId: 'codex'
        }}
      />
    )

    flushFrames(320)
    const transform = logo.container.querySelector('.bart-bot')?.getAttribute('transform') ?? ''
    const translateY = Number(/translate\(0 (-?[\d.]+)\)/.exec(transform)?.[1])

    expect(translateY).toBeGreaterThanOrEqual(-4.1)
    expect(translateY).toBeLessThanOrEqual(4.1)
  })

  it.each(['processing', 'allow', 'deny', 'answer'] as const)(
    'renders the request-transit visual for %s',
    (interventionState) => {
      const logo = render(
        <BartLogo
          size={210}
          interventionState={interventionState}
          interventionKey={`decision:${interventionState}`}
        />
      )

      const svg = logo.container.querySelector('.bart-logo')
      expect(svg).toHaveAttribute('data-intervention-state', interventionState)
      expect(logo.container.querySelector('.bart-intervention-request-token')).toBeInTheDocument()
      expect(logo.container.querySelector('.bart-intervention-answer-token')).toBeInTheDocument()
    }
  )

  it('maps structured auto-intervention results to the four production visuals', () => {
    const base = {
      mode: 'auto' as const,
      sourceConversationId: 'conversation-1',
      sourceRunId: 'run-1',
      interactionId: 'interaction-1',
      threadTitle: 'Thread',
      interventionTitle: 'Permission'
    }

    expect(interventionVisualState({ ...base, responseStatus: 'pending' })).toBe('processing')
    expect(
      interventionVisualState({ ...base, responseStatus: 'responded', action: 'allow' })
    ).toBe('allow')
    expect(
      interventionVisualState({ ...base, responseStatus: 'responded', action: 'deny' })
    ).toBe('deny')
    expect(
      interventionVisualState({ ...base, responseStatus: 'responded', action: 'submit' })
    ).toBe('answer')
    expect(interventionVisualState({ ...base, responseStatus: 'fallback' })).toBeUndefined()
  })

})
