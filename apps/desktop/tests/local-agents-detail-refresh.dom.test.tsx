// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessPresentationResources } from '../src/renderer/src/harness-composition'
import { LocalAgentsSettings } from '../src/renderer/src/components/LocalAgentsSettings'
import { AppI18nProvider as I18nProvider } from '../src/renderer/src/i18n'
import { HARNESS_IDS } from '../src/shared/harnesses'
import {
  createDefaultOpenAgentSettings,
  type OpenAgentSettings
} from '../src/shared/openagent-settings'
import type { HarnessInstallationMap } from '../src/shared/openagent-settings'

afterEach(cleanup)

describe('Local Agent detail freshness', () => {
  it('asks for a fresh detail when the window comes back to it', async () => {
    mount({ codex: { status: 'installed', executablePath: '/resolved/codex' } })
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }), { detail: 1 })
    await waitFor(() => expect(reload()).toHaveBeenCalledWith({ refresh: true }))
    reload().mockClear()

    // The CLI can be replaced at the very same path while the window is away,
    // which is the one change a cached presentation cannot tell apart.
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(reload()).toHaveBeenCalledWith({ refresh: true }))
  })

  it('asks for a fresh detail after an installation finishes', async () => {
    const installHarness = vi.fn(async () => undefined)
    ;(window as unknown as { openAgent: unknown }).openAgent = { installHarness }
    // The install is what puts the CLI there; until it finishes the page sees a
    // missing Agent with an install target.
    mount({ pi: { status: 'installed', executablePath: '/resolved/pi' } }, {})
    fireEvent.click(screen.getByRole('button', { name: /Pi Agent/ }), { detail: 1 })
    await waitFor(() => expect(installHarness).toHaveBeenCalledWith('pi'))
    // The version the page is about to show is the one the install just placed,
    // not whatever an earlier read of this workspace settled on.
    await waitFor(() => expect(reload()).toHaveBeenLastCalledWith({ refresh: true }))
  })

  it('forces a refresh that arrived while the detail was still loading its first', async () => {
    // The page is still waiting on its own first read when the window comes back
    // to it, which says the CLI may have changed under that read. The detail has
    // not published a settled state to read yet, so the queued request has to be
    // remembered by the refresh itself.
    mount({ codex: { status: 'installed', executablePath: '/resolved/codex' } }, undefined, 'loading')
    let release!: () => void
    reload().mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }), { detail: 1 })
    await waitFor(() => expect(reload()).toHaveBeenCalledTimes(1))
    expect(reload()).toHaveBeenLastCalledWith()
    fireEvent(window, new Event('focus'))
    release()
    await waitFor(() => expect(reload()).toHaveBeenLastCalledWith({ refresh: true }))
  })

  it('forces a refresh that meets an ordinary reload long after the first read', async () => {
    const resources = mount({ codex: { status: 'installed', executablePath: '/resolved/codex' } })
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }), { detail: 1 })
    await waitFor(() => expect(reload()).toHaveBeenCalledWith({ refresh: true }))
    reload().mockClear()

    // A settings change starts an ordinary reload of this detail long after its
    // first read settled, and the window comes back to the detail while that one
    // is still in flight. Which read was the first belongs to the detail, not to
    // whatever happens to be loading when the refresh arrives.
    resources.codex!.status = 'loading'
    let release!: () => void
    reload().mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(reload()).toHaveBeenLastCalledWith({ refresh: true }))
    release()
  })

  it('does not force a second load onto a detail that is still loading its first', async () => {
    // Nothing has answered yet, so the request already in flight is this page's
    // own first read. Forcing another one would boot a second native transport to
    // replace an answer that has not arrived, delaying the open it is meant to
    // make current.
    mount({ codex: { status: 'installed', executablePath: '/resolved/codex' } }, undefined, 'loading')
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }), { detail: 1 })
    await waitFor(() => expect(reload()).toHaveBeenCalled())
    expect(reload().mock.calls.filter(([options]) => options !== undefined)).toEqual([])
  })
})

let resourceReload = vi.fn(async () => undefined)

function reload(): ReturnType<typeof vi.fn> {
  return resourceReload
}

/**
 * `detected` is what the installation probe answers with; `detected` before that
 * is what the page already shows, so a test can start from an Agent the probe
 * has yet to find.
 */
function mount(
  detected: HarnessInstallationMap,
  shown: HarnessInstallationMap = detected,
  resourceStatus: 'ready' | 'loading' = 'ready'
): Record<string, { status: string; reload: () => Promise<void> }> {
  resourceReload = vi.fn(async () => undefined)
  const resources = Object.fromEntries(HARNESS_IDS.map(id => [id, resourceStatus === 'loading'
    ? { status: 'loading' as const, reload: resourceReload }
    : {
        status: 'ready' as const,
        value: { cli: { status: 'ready' as const, executablePath: '/resolved/cli' }, models: [] },
        reload: resourceReload
      }])) as unknown as HarnessPresentationResources
  const defaults = createDefaultOpenAgentSettings()
  const settings: OpenAgentSettings = {
    ...defaults,
    harnesses: {
      ...defaults.harnesses,
      ...Object.fromEntries(HARNESS_IDS.map(id => [id, { useDefaultThreadSettings: true, threadSettings: {} }]))
    }
  }
  const initial = Object.fromEntries(
    HARNESS_IDS.map(id => [id, shown[id] ?? { status: 'missing' as const }])
  ) as HarnessInstallationMap
  render(<I18nProvider locale="zh-CN"><Host
    detected={detected} initial={initial} resources={resources} settings={settings}
  /></I18nProvider>)
  // The page reads a resource when it asks for it, so a test can move one on
  // without a re-render — the way an external reload does.
  return resources as unknown as Record<string, { status: string; reload: () => Promise<void> }>
}

function Host(props: {
  readonly detected: HarnessInstallationMap
  readonly initial: HarnessInstallationMap
  readonly resources: HarnessPresentationResources
  readonly settings: OpenAgentSettings
}): React.JSX.Element {
  const [installations, setInstallations] = useState(props.initial)
  return <LocalAgentsSettings
    installations={installations}
    onInstallationsChange={setInstallations}
    defaultCwd="/workspace"
    resources={props.resources}
    value={props.settings}
    onChange={() => undefined}
    load={async () => props.detected}
  />
}
