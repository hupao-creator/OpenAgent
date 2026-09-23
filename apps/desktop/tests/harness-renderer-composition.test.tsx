// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAgentInput } from '../src/renderer/src/components/BartThreadView'
import { AppI18nProvider as I18nProvider } from '../src/renderer/src/i18n'
import {
  HarnessSettingsHost,
  HarnessPluginBoundary,
  harnessRendererPlugins,
  harnessRendererTranslations,
  threadActions,
  useHarnessPresentationResources,
  type HarnessPresentationLoader,
  type HarnessPresentationResources
} from '../src/renderer/src/harness-composition'
import { HARNESS_IDS, harnessDescriptors, type HarnessId } from '../src/shared/harnesses'
import type { JsonObject, JsonValue } from '@openagent/contracts'
import type { HarnessRendererPlugin } from '@openagent/contracts/renderer'
import {
  createDefaultOpenAgentSettings,
  type OpenAgentSettings
} from '../src/shared/openagent-settings'

// Core receives only contract-shaped modules. New registry entries automatically
// participate without importing provider-specific state or presentation schemas.
vi.mock('../src/generated/harness-registry.renderer', async () => {
  const { HARNESS_IDS, harnessDescriptors } = await import('../src/shared/harnesses')
  return {
    harnessRendererPluginModules: HARNESS_IDS.map(id => ({
      id,
      descriptor: harnessDescriptors[id],
      plugin: {
        logoSource: '',
        ThreadView: () => null,
        ThreadSettings: () => null,
        HarnessSettings: ({ resource }) => <output>{resource.status}</output>,
        OverviewCard: {
          project: () => ({ footprint: { columns: 1, rows: 1 }, structureKey: 'fixture', excerpt: '', view: null }),
          Card: () => null
        }
      } satisfies HarnessRendererPlugin<null, JsonObject, JsonObject, JsonValue>
    }))
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Harness Renderer static composition', () => {

  it('binds generic Harness and Thread actions to the selected identities', async () => {
    const invokeHarnessExtension = vi.fn(async () => null)
    const forkThread = vi.fn(async () => ({ threadId: 'forked-thread' }))
    vi.stubGlobal('openAgent', {
      invokeHarnessExtension,
      forkThread,
      openExternal: async () => undefined
    })
    const respond = vi.fn(async () => undefined)
    const interrupt = vi.fn(async () => undefined)
    const openFollowUp = vi.fn()
    const actions = threadActions({
      harnessId: 'fixture-provider',
      threadId: 'thread-identity',
      interrupt,
      openFollowUp,
      respond
    })

    await actions.invokeHarnessExtension('provider-control', { native: true })
    await actions.forkThread({ checkpointId: 'checkpoint-1' })
    actions.openFollowUp('native follow-up suggestion')

    expect(invokeHarnessExtension).toHaveBeenCalledWith({
      harnessId: 'fixture-provider',
      method: 'provider-control',
      payload: { native: true }
    })
    expect(forkThread).toHaveBeenCalledWith({
      threadId: 'thread-identity',
      request: { checkpointId: 'checkpoint-1' }
    })
    expect(openFollowUp).toHaveBeenCalledWith('native follow-up suggestion')
    expect(() => actions.openFollowUp('   ')).toThrow('不能为空')
    expect(() => actions.openFollowUp('x'.repeat(1_000_001))).toThrow('长度限制')
  })

  it('builds ordered multimodal AgentInput from staged attachments', () => {
    expect(buildAgentInput(' inspect ', [
      {
        id: 'image-1',
        path: '/tmp/image.png',
        name: 'image.png',
        mimeType: 'image/png',
        size: 10,
        kind: 'image'
      },
      {
        id: 'file-1',
        path: '/tmp/notes.txt',
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 20,
        kind: 'document'
      }
    ])).toEqual({
      parts: [
        { kind: 'text', text: 'inspect' },
        {
          kind: 'image',
          file: {
            id: 'image-1',
            path: '/tmp/image.png',
            name: 'image.png',
            mimeType: 'image/png',
            size: 10
          }
        },
        {
          kind: 'local-file',
          file: {
            id: 'file-1',
            path: '/tmp/notes.txt',
            name: 'notes.txt',
            mimeType: 'text/plain',
            size: 20
          }
        }
      ]
    })
  })

  it('preserves plugin state across revisions and remounts it across Thread identities', () => {
    const view = render(
      <HarnessPluginBoundary fallbackTitle="Thread" key="thread-a" recoveryKey={1}>
        <LocalCounter />
      </HarnessPluginBoundary>
    )
    fireEvent.click(view.getByRole('button', { name: 'local count 0' }))
    expect(view.getByRole('button', { name: 'local count 1' })).toBeTruthy()

    view.rerender(
      <HarnessPluginBoundary fallbackTitle="Thread" key="thread-a" recoveryKey={2}>
        <LocalCounter />
      </HarnessPluginBoundary>
    )
    expect(view.getByRole('button', { name: 'local count 1' })).toBeTruthy()

    view.rerender(
      <HarnessPluginBoundary fallbackTitle="Thread" key="thread-b" recoveryKey={2}>
        <LocalCounter />
      </HarnessPluginBoundary>
    )
    expect(view.getByRole('button', { name: 'local count 0' })).toBeTruthy()
  })

  it('retries a failed plugin after a newer committed projection arrives', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = render(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <HarnessPluginBoundary fallbackTitle="Broken Thread" recoveryKey={1}>
          <MaybeBroken broken />
        </HarnessPluginBoundary>
      </I18nProvider>
    )
    expect(view.getByRole('alert')).toHaveTextContent('Broken Thread')
    expect(view.getByRole('alert')).toHaveTextContent(
      'This harness renderer is temporarily unavailable. Other threads are unaffected.'
    )

    view.rerender(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <HarnessPluginBoundary fallbackTitle="Broken Thread" recoveryKey={2}>
          <MaybeBroken broken={false} />
        </HarnessPluginBoundary>
      </I18nProvider>
    )
    await waitFor(() => expect(view.getByText('plugin recovered')).toBeTruthy())
    error.mockRestore()
  })

  it('contains and retries failures from the Harness settings surface', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let broken = true
    const harnessSettings = vi.spyOn(
      harnessRendererPlugins[HARNESS_IDS[0]],
      'renderHarnessSettings'
    ).mockImplementation(() => <MaybeBroken broken={broken} />)
    const settings = normalizedSettings()
    const harnessView = render(
      <HarnessSettingsHost
        cwd="/tmp"
        section="thread"
        change={() => undefined}
        harnessId={HARNESS_IDS[0]}
        resources={loadingPresentationResources()}
        value={settings}
      />
    )
    expect(harnessView.getByRole('alert')).toHaveTextContent(`${harnessDescriptors[HARNESS_IDS[0]].displayName} 设置`)

    broken = false
    harnessView.rerender(
      <HarnessSettingsHost
        cwd="/tmp"
        section="thread"
        change={() => undefined}
        harnessId={HARNESS_IDS[0]}
        resources={errorPresentationResources('new presentation state')}
        value={settings}
      />
    )
    await waitFor(() => expect(harnessView.getByText('plugin recovered')).toBeTruthy())
    harnessView.unmount()
    harnessSettings.mockRestore()

    error.mockRestore()
  })

  it('keeps an in-flight presentation across unrelated global settings changes', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const load = vi.fn<HarnessPresentationLoader>(async request => {
      if (request.scope !== 'global') throw new Error('Expected global request')
      await gate
      return { scope: 'global', harnessId: request.harnessId, value: {} }
    })
    const initial = normalizedSettings()
    const view = render(
      <PresentationFixture defaultCwd="/tmp" harnessId="codex" load={load} settings={initial} />
    )
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    view.rerender(
      <PresentationFixture defaultCwd="/tmp" harnessId="codex" load={load} settings={{
        ...initial,
        bart: { ...initial.bart, routingGuidance: 'Changed Bart guidance' },
        harnesses: { ...initial.harnesses, claude: {
          ...initial.harnesses.claude, threadSettings: { model: 'other-model' }
        } }
      }} />
    )
    await act(async () => { finish(); await gate })
    await waitFor(() => expect(view.getByText('ready')).toBeTruthy())
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps a settled presentation on screen while a same-key re-read travels', async () => {
    let releaseSecond!: () => void
    const second = new Promise<void>(resolve => { releaseSecond = resolve })
    const load = vi.fn<HarnessPresentationLoader>()
      .mockResolvedValueOnce({ scope: 'global', harnessId: 'codex', value: { version: 'v1' } })
      .mockImplementationOnce(async () => {
        await second
        return { scope: 'global', harnessId: 'codex', value: { version: 'v2' } }
      })
    const binding = harnessRendererPlugins['codex']
    const renderSettings = vi.spyOn(binding, 'renderHarnessSettings').mockImplementation(props => {
      const resource = props.resources['codex']
      return (
        <div>
          <output>{resource.status}{resource.status === 'ready' ? ` ${JSON.stringify(resource.value)}` : ''}</output>
          <button onClick={() => void resource.reload()}>reload</button>
        </div>
      )
    })
    try {
      const view = render(
        <PresentationFixture defaultCwd="/tmp" harnessId="codex" load={load} settings={normalizedSettings()} />
      )
      await waitFor(() => expect(view.getByText('ready {"version":"v1"}')).toBeTruthy())

      fireEvent.click(view.getByRole('button', { name: 'reload' }))
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
      // The re-read is in flight, yet the read the user is looking at stays put
      // instead of collapsing to a loading flash.
      expect(view.getByText('ready {"version":"v1"}')).toBeTruthy()
      expect(view.queryByText('loading')).toBeNull()

      await act(async () => { releaseSecond() })
      await waitFor(() => expect(view.getByText('ready {"version":"v2"}')).toBeTruthy())
    } finally {
      renderSettings.mockRestore()
    }
  })

  it('settles a failed same-key re-read into its own error', async () => {
    let rejectSecond!: (cause: Error) => void
    const second = new Promise<never>((_resolve, reject) => { rejectSecond = reject })
    const load = vi.fn<HarnessPresentationLoader>()
      .mockResolvedValueOnce({ scope: 'global', harnessId: 'codex', value: { version: 'v1' } })
      .mockImplementationOnce(() => second)
    const binding = harnessRendererPlugins['codex']
    const renderSettings = vi.spyOn(binding, 'renderHarnessSettings').mockImplementation(props => {
      const resource = props.resources['codex']
      return (
        <div>
          <output>{resource.status}{resource.status === 'ready' ? ` ${JSON.stringify(resource.value)}` : resource.status === 'error' ? ` ${resource.message}` : ''}</output>
          <button onClick={() => void resource.reload()}>reload</button>
        </div>
      )
    })
    try {
      const view = render(
        <PresentationFixture defaultCwd="/tmp" harnessId="codex" load={load} settings={normalizedSettings()} />
      )
      await waitFor(() => expect(view.getByText('ready {"version":"v1"}')).toBeTruthy())

      fireEvent.click(view.getByRole('button', { name: 'reload' }))
      // The failed re-read travels silently too; only its answer is shown.
      expect(view.getByText('ready {"version":"v1"}')).toBeTruthy()
      await act(async () => { rejectSecond(new Error('probe failed')); await second.catch(() => undefined) })
      expect(view.getByText('error probe failed')).toBeTruthy()
      expect(view.queryByText('ready {"version":"v1"}')).toBeNull()
    } finally {
      renderSettings.mockRestore()
    }
  })

  it('automatically loads changed Harness settings and ignores the old request failure', async () => {
    let rejectOld!: (cause: Error) => void
    const old = new Promise<never>((_resolve, reject) => { rejectOld = reject })
    const load = vi.fn<HarnessPresentationLoader>()
      .mockImplementationOnce(() => old)
      .mockResolvedValue({ scope: 'global', harnessId: 'codex', value: { current: true } })
    const initial = normalizedSettings()
    const view = render(
      <PresentationFixture defaultCwd="/tmp" harnessId="codex" load={load} settings={initial} />
    )
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    view.rerender(
      <PresentationFixture defaultCwd="/tmp" harnessId="codex" load={load} settings={{
        ...initial, harnesses: { ...initial.harnesses, codex: {
          ...initial.harnesses.codex, threadSettings: { model: 'new-model' }
        } }
      }} />
    )
    await waitFor(() => expect(view.getByText('ready')).toBeTruthy())
    await act(async () => { rejectOld(new Error('stale settings')); await old.catch(() => undefined) })
    expect(view.getByText('ready')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it.each(HARNESS_IDS)('loads only the mounted %s presentation and invalidates its settings slice', async (harnessId) => {
    const calls: HarnessId[] = []
    const load: HarnessPresentationLoader = async (request) => {
      if (request.scope !== 'global') throw new Error('Expected global presentation request')
      calls.push(request.harnessId)
      return {
        scope: 'global',
        harnessId: request.harnessId,
        value: { source: request.harnessId, models: [] }
      }
    }
    const initial = normalizedSettings()
    const view = render(
      <PresentationFixture defaultCwd="/tmp" harnessId={null} load={load} settings={initial} />
    )
    expect(calls).toEqual([])

    view.rerender(
      <PresentationFixture defaultCwd="/tmp" harnessId={harnessId} load={load} settings={initial} />
    )
    await waitFor(() => expect(calls).toEqual([harnessId]))

    const changed: OpenAgentSettings = {
      ...initial,
      harnesses: {
        ...initial.harnesses,
        [harnessId]: {
          ...initial.harnesses[harnessId],
          threadSettings: { model: 'custom-model' }
        }
      }
    }
    view.rerender(
      <PresentationFixture defaultCwd="/tmp" harnessId={harnessId} load={load} settings={changed} />
    )
    await waitFor(() => expect(calls).toEqual([harnessId, harnessId]))

    view.rerender(
      <PresentationFixture
        defaultCwd="/tmp/another-project"
        harnessId={harnessId}
        load={load}
        settings={changed}
      />
    )
    await waitFor(() => expect(calls).toEqual([harnessId, harnessId, harnessId]))
  })

})

function PresentationFixture(props: {
  readonly defaultCwd: string
  readonly harnessId: HarnessId | null
  readonly settings: OpenAgentSettings
  readonly load: HarnessPresentationLoader
}): React.JSX.Element | null {
  const resources = useHarnessPresentationResources(props.settings, props.load, props.defaultCwd)
  return props.harnessId === null ? null : (
    <HarnessSettingsHost
      cwd={props.defaultCwd}
      section="thread"
      change={() => undefined}
      harnessId={props.harnessId}
      resources={resources}
      value={props.settings}
    />
  )
}

function normalizedSettings(): OpenAgentSettings {
  return createDefaultOpenAgentSettings()
}

function loadingPresentationResources(): HarnessPresentationResources {
  return Object.fromEntries(HARNESS_IDS.map(id => [id, {
    status: 'loading', reload: async () => undefined
  }]))
}

function errorPresentationResources(message: string): HarnessPresentationResources {
  return Object.fromEntries(HARNESS_IDS.map(id => [id, {
    status: 'error', message, reload: async () => undefined
  }]))
}

function LocalCounter(): React.JSX.Element {
  const [count, setCount] = useState(0)
  return (
    <button aria-label={`local count ${count}`} onClick={() => setCount(count + 1)}>
      {count}
    </button>
  )
}

function MaybeBroken(props: { readonly broken: boolean }): React.JSX.Element {
  if (props.broken) throw new Error('broken renderer fixture')
  return <span>plugin recovered</span>
}
