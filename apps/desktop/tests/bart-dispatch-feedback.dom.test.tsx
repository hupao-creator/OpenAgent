// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import React, { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessSettingsPage } from '../src/renderer/src/components/HarnessSettingsPage'
import {
  useBartDispatchFeedback,
  type BartDispatchFeedback
} from '../src/renderer/src/components/use-bart-dispatch-feedback'
import { AppI18nProvider as I18nProvider } from '../src/renderer/src/i18n'
import { HARNESS_IDS } from '../src/shared/harnesses'
import {
  createDefaultOpenAgentSettings,
  type HarnessInstallationMap,
  type OpenAgentSettings
} from '../src/shared/openagent-settings'

interface FakeAnimation {
  cancel: () => void
  playState: string
  onfinish: (() => void) | null
}

const originalAnimate = Element.prototype.animate
const originalGetClientRects = Element.prototype.getClientRects
const originalMatchMedia = window.matchMedia
let acknowledgmentClips: number[] = []
let acknowledgmentAnimations: FakeAnimation[] = []

beforeEach(() => {
  acknowledgmentClips = []
  acknowledgmentAnimations = []
  // jsdom reports no layout, which makes the motion code opt out; the settings
  // page needs real client rects to reach its acknowledgment path at all.
  Element.prototype.getClientRects = function (this: Element) {
    return [{ x: 0, y: 0, width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 }] as unknown as DOMRectList
  }
  // jsdom ships no matchMedia at all; the page reads the resolved color scheme.
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
  Element.prototype.animate = function (this: Element, _keyframes: unknown, _options: unknown) {
    const animation: FakeAnimation = { cancel: () => undefined, playState: 'running', onfinish: null }
    if (this.classList.contains('bart-host-character')) {
      acknowledgmentClips.push(performance.now())
      acknowledgmentAnimations.push(animation)
    }
    return animation as unknown as Animation
  }
})

afterEach(() => {
  cleanup()
  Element.prototype.animate = originalAnimate
  Element.prototype.getClientRects = originalGetClientRects
  window.matchMedia = originalMatchMedia
})

describe('Dispatch acknowledgment', () => {
  it('plays one acknowledgment for a burst of clicks instead of restarting on every click', async () => {
    vi.useFakeTimers()
    try {
      const { targets } = await stageDispatchRow()

      const codex = within(targets).getByRole('checkbox', { name: 'Codex · 已安装' })
      const claude = within(targets).getByRole('checkbox', { name: 'Claude · 已安装' })
      for (let index = 0; index < 5; index += 1) {
        fireEvent.click(index % 2 ? claude : codex)
        await act(async () => { await vi.advanceTimersByTimeAsync(60) })
      }
      expect(acknowledgmentClips).toHaveLength(0)

      // The acknowledgment lands once the clicks stop, not while they are still coming.
      await act(async () => { await vi.advanceTimersByTimeAsync(400) })
      expect(acknowledgmentClips).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it('keeps the quiet window at 200ms when an earlier clip finishes mid-wait', async () => {
    vi.useFakeTimers()
    try {
      const { targets } = await stageDispatchRow()
      const codex = within(targets).getByRole('checkbox', { name: 'Codex · 已安装' })
      const claude = within(targets).getByRole('checkbox', { name: 'Claude · 已安装' })

      // Both clicks select a target, so neither row disables the other.
      fireEvent.click(claude)
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(acknowledgmentClips).toHaveLength(1)

      fireEvent.click(codex)
      await act(async () => { await vi.advanceTimersByTimeAsync(60) })
      // The earlier acknowledgment settles before the new click's quiet window is up;
      // that internal update must not push the new one out.
      await act(async () => { acknowledgmentAnimations[0]!.onfinish?.() })
      await act(async () => { await vi.advanceTimersByTimeAsync(140) })
      expect(acknowledgmentClips).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })

  it('does not start a stale acknowledgment when a handoff clears mid-wait', async () => {
    vi.useFakeTimers()
    try {
      const first: BartDispatchFeedback = { sequence: 1, harnessId: 'codex', enabled: true, gazeX: 0 }
      const second: BartDispatchFeedback = { sequence: 2, harnessId: 'claude', enabled: false, gazeX: 9 }
      const view = render(<FeedbackHarness feedback={null} ready={false} />)

      // Clicking during a host handoff arms the click but `ready` holds the clip back.
      view.rerender(<FeedbackHarness feedback={first} ready={false} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(acknowledgmentClips).toHaveLength(0)

      // A second click supersedes it shortly before the handoff finishes.
      view.rerender(<FeedbackHarness feedback={second} ready={false} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(150) })
      view.rerender(<FeedbackHarness feedback={second} ready={true} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })

      // Only the latest click is acknowledged, and only once.
      expect(acknowledgmentClips).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it('holds the acknowledgment back while a Bart is still flying to the seat', async () => {
    vi.useFakeTimers()
    try {
      // The settings page opens its controls well before the outbound flight is over,
      // so this click lands on a seat that is empty: the acknowledgment has to wait
      // rather than play to a character hidden behind the copy.
      const { targets, setInFlight } = await stageDispatchRow(true)
      fireEvent.click(within(targets).getByRole('checkbox', { name: 'Claude · 已安装' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(400) })
      expect(acknowledgmentClips).toHaveLength(0)

      await setInFlight(false)
      expect(acknowledgmentClips).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })
})

function FeedbackHarness({ feedback, ready }: { feedback: BartDispatchFeedback | null; ready: boolean }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  useBartDispatchFeedback(ref, feedback, ready)
  return <span ref={ref}><span className="bart-host-character"><svg className="bart-face" /></span></span>
}

interface StagedRow {
  readonly targets: HTMLElement
  /** Lands the flying copy, so the seat is Bart's again. */
  setInFlight: (inFlight: boolean) => Promise<void>
}

/** Opens the Bart tab with the dispatch targets and clears the motion log. */
async function stageDispatchRow(bartInFlight = false): Promise<StagedRow> {
  // One `value` for every rerender: a fresh object would read as a settings change
  // and put the autosave on the fake clock in the middle of the assertions.
  const value = { ...settings(), bart: { ...settings().bart, hostHarnessPreference: 'codex' as const,
    targetHarnessIds: ['codex'] as const } }
  const page = (inFlight: boolean): React.JSX.Element => <I18nProvider locale="zh-CN"><HarnessSettingsPage
    onClearHistory={async () => undefined} onClose={vi.fn()}
    onSave={vi.fn(async () => undefined)} loadHarnessInstallations={installedHarnesses}
    open resources={presentationResources()} defaultCwd="/workspace"
    bartInFlight={inFlight} value={value} /></I18nProvider>
  // Prepare the known roster before simulating a flight. A flight now pins its
  // departure roster, including provisional entries if detection is unfinished.
  const view = render(page(false))
  fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))

  const targets = screen.getByRole('group', { name: '可派发的线程' })
  // The install probes resolve through promises; flush them without leaving the fake
  // clock, since waitFor cannot poll it here.
  for (let index = 0; index < 20 && !within(targets).queryByRole('checkbox', { name: 'Claude · 已安装' }); index += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  }
  // Pi is not on this machine, so the dispatch row drops it.
  expect(within(targets).getAllByRole('checkbox')).toHaveLength(2)
  if (bartInFlight) await act(async () => { view.rerender(page(true)) })
  // Nothing that ran while the page settled belongs to the clicks.
  acknowledgmentClips = []
  acknowledgmentAnimations = []
  return {
    targets,
    setInFlight: async (inFlight: boolean) => {
      await act(async () => { view.rerender(page(inFlight)) })
    }
  }
}

function settings(): OpenAgentSettings {
  const defaults = createDefaultOpenAgentSettings()
  return {
    ...defaults,
    harnesses: {
      ...defaults.harnesses,
      codex: { useDefaultThreadSettings: false, threadSettings: {} },
      claude: { useDefaultThreadSettings: false, threadSettings: {} },
      pi: { useDefaultThreadSettings: false, threadSettings: {} }
    }
  }
}

function installedHarnesses(): Promise<HarnessInstallationMap> {
  return Promise.resolve({
    ...Object.fromEntries(HARNESS_IDS.map(id => [id, { status: 'missing' as const }])),
    codex: { status: 'installed', executablePath: '/resolved/codex' },
    claude: { status: 'installed', executablePath: '/resolved/claude' }
  })
}

function presentationResources(): Parameters<typeof HarnessSettingsPage>[0]['resources'] {
  const loading = { status: 'loading' as const, reload: async () => undefined }
  return {
    codex: {
      status: 'ready',
      value: {
        cli: { available: true, executable: '/resolved/codex' },
        models: ['host-model'].map((value) => ({
          value, displayName: value, supportedReasoningEfforts: [], serviceTiers: []
        }))
      },
      reload: async () => undefined
    },
    claude: loading,
    pi: loading
  }
}
