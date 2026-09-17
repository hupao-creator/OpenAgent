// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessSettingsPage } from '../src/renderer/src/components/HarnessSettingsPage'
import { AppI18nProvider as I18nProvider } from '../src/renderer/src/i18n'
import { HARNESS_IDS } from '../src/shared/harnesses'
import {
  createDefaultOpenAgentSettings,
  type HarnessInstallationMap,
  type OpenAgentSettings
} from '../src/shared/openagent-settings'

afterEach(() => { cleanup() })

describe('Coordinator seat', () => {
  it('holds the landing roster while a probe finishes, then applies its latest result', async () => {
    const probes = deferredInstallations()
    const view = render(page(true, probes.load, true))
    await settled()
    const rail = (): string | undefined => document.querySelector<HTMLElement>('.bart-coordinator-rail')?.style.transform
    const original = rail()
    await probes.answer(0, { ...completeRoster(), claude: { status: 'missing' } })
    expect(rail()).toBe(original)
    expect(document.querySelector('[data-row="host"] [data-agent="claude"]')).not.toBeNull()
    expect(document.querySelector<HTMLElement>('.bart-host-character')?.style.visibility).toBe('hidden')
    view.rerender(page(true, probes.load, false))
    expect(document.querySelector('[data-row="host"] [data-agent="claude"]')).toBeNull()
    expect(rail()).not.toBe(original)
    expect(document.querySelector<HTMLElement>('.bart-host-character')?.style.visibility).toBe('')
  })
  it('stays provisional while a probe is out, even holding a roster that reads complete', async () => {
    const probes = deferredInstallations()
    const view = render(page(true, probes.load))
    await settled()

    // The probe has not answered: an unknown status reads as installed, so the seat
    // is laid out across every Harness and is the first to say so.
    expect(pending()).toBe(true)

    await probes.answer(0)
    expect(pending()).toBe(false)

    // Focusing the window re-probes. The roster on screen is complete for as long as
    // the probe is out, so a flight reading only the statuses would call this seat
    // final and hand over — and then watch it slide when the answer lands.
    window.dispatchEvent(new Event('focus'))
    await settled()
    expect(pending()).toBe(true)

    await probes.answer(1)
    expect(pending()).toBe(false)
    view.unmount()
  })

  it('ignores a probe that finishes after the page has closed and reopened', async () => {
    const probes = deferredInstallations()
    const view = render(page(true, probes.load))
    await settled()
    await probes.answer(0)
    expect(pending()).toBe(false)

    // A refresh leaves a probe out, and the page closes on it. The probe's own child
    // unmounts with the page — the page returns null — but the page itself keeps both
    // the roster and this flag across that.
    window.dispatchEvent(new Event('focus'))
    await settled()
    expect(pending()).toBe(true)
    await act(async () => { view.rerender(page(false, probes.load)) })

    // Reopening starts a probe of its own, against the roster the last one answered.
    await act(async () => { view.rerender(page(true, probes.load)) })
    await settled()
    expect(pending()).toBe(true)

    // The probe the closed page left behind now lands. It speaks for a child that no
    // longer exists: letting it clear the flag would declare the seat final while the
    // probe the reopened page just started is still out.
    await probes.answer(1)
    expect(pending()).toBe(true)

    await probes.answer(2)
    expect(pending()).toBe(false)
    view.unmount()
  })
})

const page = (open: boolean, load: () => Promise<HarnessInstallationMap>, inFlight = false): React.JSX.Element =>
  <I18nProvider locale="zh-CN"><HarnessSettingsPage
    onClearHistory={async () => undefined} onClose={vi.fn()}
    onSave={vi.fn(async () => undefined)} loadHarnessInstallations={load}
    open={open} bartInFlight={inFlight} resources={resources()} defaultCwd="/workspace" value={settings()} /></I18nProvider>

/** Whether the seat says its place is not final yet. */
function pending(): boolean {
  const seat = document.querySelector('[data-bart-coordinator]')?.closest('.bart-coordinator-anchor')
  if (!seat) throw new Error('the coordinator seat did not render')
  return seat.hasAttribute('data-position-pending')
}

/** Lets the effects, the probe's own microtasks and the resulting commits run out. */
const settled = (): Promise<void> => act(async () => undefined)

/** Answers on demand, so a probe can be left in the air across an assertion. */
function deferredInstallations(): {
  load: () => Promise<HarnessInstallationMap>
  answer: (index: number, roster?: HarnessInstallationMap) => Promise<void>
} {
  const waiting: Array<(value: HarnessInstallationMap) => void> = []
  return {
    load: () => new Promise<HarnessInstallationMap>((resolve) => {
      waiting.push(resolve)
    }),
    answer: async (index: number, roster = completeRoster()) => {
      const next = waiting[index]
      if (!next) throw new Error(`no probe ${index} is outstanding`)
      await act(async () => { next(roster) })
    }
  }
}

/** Every Harness accounted for: nothing here is missing, so nothing reads as pending. */
function completeRoster(): HarnessInstallationMap {
  return Object.fromEntries(HARNESS_IDS.map((id) => [id, {
    status: 'installed' as const, executablePath: `/resolved/${id}`
  }]))
}

function resources(): Parameters<typeof HarnessSettingsPage>[0]['resources'] {
  const loading = { status: 'loading' as const, reload: async () => undefined }
  return Object.fromEntries(HARNESS_IDS.map((id) => [id, loading]))
}

function settings(): OpenAgentSettings {
  const defaults = createDefaultOpenAgentSettings()
  return {
    ...defaults,
    harnesses: Object.fromEntries(HARNESS_IDS.map((id) => [id, { useDefaultThreadSettings: false, threadSettings: {} }])),
    bart: { ...defaults.bart, hostHarnessPreference: 'codex' as const }
  }
}
