// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as harnessRegistry from '../src/shared/harnesses'
import type { BartThreadRecord } from '@openagent/contracts'
import { createDefaultOpenAgentSettings } from '../src/shared/openagent-settings'
import type { HarnessInstallationMap } from '../src/shared/openagent-settings'
import type { HarnessPresentationResources } from '../src/renderer/src/harness-composition'
import { ThreadDetailSurface } from '@openagent/plugin-kit/renderer'
import { AgentThreadWorkspace } from '../src/renderer/src/components/AgentThreadWorkspace'
import { BartThreadView } from '../src/renderer/src/components/BartThreadView'
import { HarnessSettingsPage } from '../src/renderer/src/components/HarnessSettingsPage'
import { AppI18nProvider as I18nProvider } from '../src/renderer/src/i18n'

vi.mock('../src/renderer/src/harness-composition', () => ({
  HarnessSettingsHost: () => null,
  HarnessThreadViewHost: ({ thread }: { thread: { id: string; title: string } }) => <ThreadDetailSurface
    threadId={thread.id} title={thread.title} running={false} rows={[]} />,
  harnessRendererTranslations: {},
  harnessLogoSource: () => 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
  threadActions: () => ({
    interrupt: async () => undefined,
    respond: async () => undefined
  })
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Core Renderer shell localization', () => {
  it('disables unsupported Bart Hosts while preserving their independent dispatch checkbox', async () => {
    vi.spyOn(harnessRegistry, 'harnessSupportsBartHost').mockImplementation(id => id !== 'pi')
    const defaults = createDefaultOpenAgentSettings()
    const onSave = vi.fn(async () => undefined)
    render(
      <I18nProvider locale="en-US">
        <HarnessSettingsPage
          onClearHistory={async () => undefined}
          onClose={() => undefined}
          onSave={onSave}
          loadHarnessInstallations={installedHarnesses}
          open
          resources={{} as HarnessPresentationResources}
          defaultCwd="/workspace"
          value={{
            ...defaults,
            locale: 'en-US',
            bart: { ...defaults.bart, targetHarnessIds: ['codex'] }
          }}
        />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))
    const host = screen.getByRole('radiogroup', { name: 'Coordinating agent' })
    expect(within(host).getByRole('radio', { name: 'Pi Agent (Bart Host unsupported)' }))
      .toBeDisabled()
    expect(within(host).getByRole('radio', { name: /^Codex/ })).toBeEnabled()
    const target = screen.getByRole('checkbox', { name: /^Pi Agent/ })
    expect(target).toBeEnabled()
    expect(target).not.toBeChecked()
    fireEvent.click(target)
    expect(target).toBeChecked()
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      bart: expect.objectContaining({
        hostHarnessPreference: 'auto',
        targetHarnessIds: ['codex', 'pi']
      })
    })))
  })

  it.each([
    ['zh-CN', '当前 Bart provider 值不可用，请重新选择。'],
    ['en-US', 'The current Bart provider is unavailable. Choose another provider.']
  ] as const)('explains a persisted unsupported Host preference in %s', (locale, message) => {
    vi.spyOn(harnessRegistry, 'harnessSupportsBartHost').mockImplementation(id => id !== 'pi')
    const defaults = createDefaultOpenAgentSettings()
    render(
      <I18nProvider locale={locale}>
        <HarnessSettingsPage
          onClearHistory={async () => undefined}
          onClose={() => undefined}
          onSave={async () => undefined}
          loadHarnessInstallations={installedHarnesses}
          open
          resources={{} as HarnessPresentationResources}
          defaultCwd="/workspace"
          value={{
            ...defaults,
            locale,
            bart: { ...defaults.bart, hostHarnessPreference: 'pi' }
          }}
        />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))
    expect(screen.getByText(message)).toBeVisible()
    expect(screen.getByRole('checkbox', { name: /^Pi Agent/ })).toBeEnabled()
  })

  it('switches the new settings shell to en-US, including Bart', async () => {
    const pendingSave = deferred<void>()
    const onSave = vi.fn(() => pendingSave.promise)
    render(
      <I18nProvider locale="zh-CN">
        <HarnessSettingsPage
          onClearHistory={async () => undefined}
          onClose={() => undefined}
          onSave={onSave}
          loadHarnessInstallations={installedHarnesses}
          open
          resources={{} as HarnessPresentationResources}
          defaultCwd="/workspace"
          value={createDefaultOpenAgentSettings()}
        />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    fireEvent.change(screen.getByLabelText('界面语言'), {
      target: { value: 'en-US' }
    })

    expect(screen.getByRole('region', { name: 'Settings' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Back' })).toBeVisible()
    expect(screen.getByRole('tablist', { name: 'Settings categories' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Clear all history' })).toBeDisabled()

    fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))
    expect(screen.getByRole('radiogroup', { name: 'Coordinating agent' })).toBeVisible()
    expect(screen.getByRole('group', { name: 'Dispatchable threads' })).toBeVisible()
    expect(screen.queryByRole('switch', { name: 'Automatic approvals and answers' })).not.toBeInTheDocument()
    expect(screen.getByText('Custom model routing guidance')).toBeVisible()

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en-US' })))
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()

    await act(async () => pendingSave.resolve())
    expect(screen.getByRole('region', { name: 'Settings' })).toBeVisible()
  })

  it('preserves page busy guards, destructive-confirm reset, and vertical tab keys', async () => {
    const pendingSave = deferred<void>()
    const pendingClear = deferred<void>()
    const onClose = vi.fn()
    const view = render(
      <I18nProvider locale="zh-CN">
        <HarnessSettingsPage
          onClearHistory={() => pendingClear.promise}
          onClose={onClose}
          onSave={() => pendingSave.promise}
          loadHarnessInstallations={installedHarnesses}
          open
          resources={{} as HarnessPresentationResources}
          defaultCwd="/workspace"
          value={createDefaultOpenAgentSettings()}
        />
      </I18nProvider>
    )

    const tabs = screen.getByRole('tablist', { name: '设置分类' })
    expect(tabs).toHaveAttribute('aria-orientation', 'vertical')
    const general = screen.getByRole('tab', { name: '通用' })
    fireEvent.keyDown(general, { key: 'ArrowDown' })
    const bart = screen.getByRole('tab', { name: 'Bart' })
    expect(bart).toHaveFocus()
    expect(bart).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tab')).toEqual([bart, general])
    fireEvent.keyDown(bart, { key: 'End' })
    const lastTab = screen.getAllByRole('tab').at(-1)!
    expect(lastTab).toHaveFocus()
    expect(lastTab).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(lastTab, { key: 'Home' })
    expect(bart).toHaveFocus()

    fireEvent.click(general)
    fireEvent.click(screen.getByRole('button', { name: '清空全部历史数据' }))
    expect(screen.getByRole('button', { name: '确认永久删除' })).toBeVisible()
    fireEvent.click(bart)
    fireEvent.click(general)
    expect(screen.getByRole('button', { name: '清空全部历史数据' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '清空全部历史数据' }))
    fireEvent.click(screen.getByRole('button', { name: '确认永久删除' }))
    expect(screen.getByRole('button', { name: '返回' })).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.mouseDown(view.container.querySelector('.settings-page') as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => pendingClear.resolve())
    await waitFor(() => expect(
      screen.getByRole('button', { name: '清空全部历史数据' })
    ).toBeEnabled())

    fireEvent.change(screen.getByLabelText('界面语言'), {
      target: { value: 'en-US' }
    })
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    // The choice saves immediately, but the page no longer waits for that write
    // to land before it leaves.
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.mouseDown(view.container.querySelector('.settings-page') as HTMLElement)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    await act(async () => pendingSave.resolve())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('focuses the page, hides the underlay, and restores the opener', () => {
    function SettingsFixture(): React.JSX.Element {
      const [open, setOpen] = React.useState(false)
      const origin = React.useRef<HTMLButtonElement>(null)
      return (
        <I18nProvider locale="zh-CN">
          <button ref={origin} onClick={() => setOpen(true)} type="button">打开设置</button>
          <button type="button">底层操作</button>
          <HarnessSettingsPage
            onClearHistory={async () => undefined}
            onClose={() => setOpen(false)}
            onSave={async () => undefined}
            loadHarnessInstallations={installedHarnesses}
            open={open}
            origin={origin.current}
            resources={{} as HarnessPresentationResources}
            defaultCwd="/workspace"
            value={createDefaultOpenAgentSettings()}
          />
        </I18nProvider>
      )
    }

    render(<SettingsFixture />)
    const opener = screen.getByRole('button', { name: '打开设置' })
    const underlayAction = screen.getByRole('button', { name: '底层操作' })
    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByRole('region', { name: '设置' })
    const close = screen.getByRole('button', { name: '返回' })
    expect(close).toHaveFocus()
    expect(opener).toHaveAttribute('inert')
    expect(opener).toHaveAttribute('aria-hidden', 'true')
    expect(underlayAction).toHaveAttribute('inert')
    expect(underlayAction).toHaveAttribute('aria-hidden', 'true')

    expect(dialog).not.toHaveAttribute('aria-modal')

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: '设置' })).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
    expect(opener).not.toHaveAttribute('inert')
    expect(opener).not.toHaveAttribute('aria-hidden')
    expect(underlayAction).not.toHaveAttribute('inert')
    expect(underlayAction).not.toHaveAttribute('aria-hidden')
  })

  it.each(['canvas', 'input', 'removed-input', 'inert-input', 'disabled-input', 'hidden-input'] as const)('restores settings focus after opening from %s', focus => {
    const onClose = vi.fn()
    function SettingsFixture({ open, changed = false }: {
      open: boolean; changed?: boolean
    }): React.JSX.Element {
      const origin = React.useRef<HTMLButtonElement>(null)
      return (
        <I18nProvider locale="zh-CN">
          <button ref={origin} type="button">打开设置</button>
          <div>
            <div inert={changed && focus === 'inert-input'}>
              {(!changed || focus !== 'removed-input') && <input
                aria-label="消息"
                disabled={changed && focus === 'disabled-input'}
                type={changed && focus === 'hidden-input' ? 'hidden' : 'text'}
              />}
            </div>
          </div>
          <HarnessSettingsPage
            onClearHistory={async () => undefined}
            onClose={onClose}
            onSave={async () => undefined}
            loadHarnessInstallations={installedHarnesses}
            open={open}
            origin={origin.current}
            resources={{} as HarnessPresentationResources}
            defaultCwd="/workspace"
            value={createDefaultOpenAgentSettings()}
          />
        </I18nProvider>
      )
    }

    const view = render(<SettingsFixture open={false} />)
    const opener = screen.getByRole('button', { name: '打开设置' })
    const target = focus === 'canvas' ? document.body : screen.getByRole('textbox', { name: '消息' })
    if (focus !== 'canvas') target.focus()
    expect(target).toHaveFocus()
    // A shortcut opens settings without first moving focus to its animation anchor.
    view.rerender(<SettingsFixture open />)
    expect(screen.getByRole('button', { name: '返回' })).toHaveFocus()
    // Live interaction controls can disappear or stop accepting focus.
    view.rerender(<SettingsFixture open changed />)
    fireEvent.keyDown(screen.getByRole('region', { name: '设置' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    view.rerender(<SettingsFixture open={false} changed />)
    const fallback = focus !== 'canvas' && focus !== 'input'
    expect(fallback ? opener : target).toHaveFocus()
    if (!fallback) expect(opener).not.toHaveFocus()
  })

  it('localizes the Bart workspace navigation and running clear status', () => {
    const props = bartProps()
    const view = render(
      <I18nProvider locale="en-US">
        <BartThreadView {...props} />
      </I18nProvider>
    )

    expect(screen.getByRole('button', { name: 'Clear Bart session' }))
      .toHaveAttribute('title', 'Clear Bart session')
    expect(screen.getByRole('button', { name: 'Overview' }))
      .toHaveAttribute('title', 'Overview')
    expect(screen.getByRole('button', { name: 'Settings' }))
      .toHaveAttribute('title', 'Settings (⌘/Ctrl ,)')

    view.rerender(
      <I18nProvider locale="en-US">
        <BartThreadView
          {...props}
          execution={{
            threadId: props.thread.id,
            executionId: 'execution-1',
            status: 'running',
            startedAt: 1
          }}
        />
      </I18nProvider>
    )
    const clear = screen.getByRole('button', { name: 'Clear Bart session' })
    expect(clear).toHaveAttribute('title', 'Stop Bart before clearing the session')
    expect(clear).toBeDisabled()

    view.rerender(
      <I18nProvider locale="en-US">
        <BartThreadView
          {...props}
          thread={{
            ...props.thread,
            observation: {
              latestExecution: {
                executionId: 'execution-waiting',
                status: 'waiting-for-user',
                startedAt: 1,
                interactions: [{
                  id: 'question-1',
                  kind: 'question',
                  title: 'Native question',
                  actions: [{ id: 'submit', label: 'Submit', intent: 'submit' }],
                  questions: []
                }]
              },
              backgroundWork: null
            }
          }}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('button', { name: 'Clear Bart session' })).toBeDisabled()

    view.rerender(
      <I18nProvider locale="en-US">
        <BartThreadView
          {...props}
          thread={{
            ...props.thread,
            observation: {
              latestExecution: null,
              backgroundWork: { status: 'running' }
            }
          }}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('button', { name: 'Clear Bart session' }))
      .toHaveAttribute('title', 'Stop Bart before clearing the session')
    expect(screen.getByRole('button', { name: 'Clear Bart session' })).toBeDisabled()
  })

  it('localizes the shared Agent breadcrumb without a second back control', () => {
    const onBack = vi.fn()
    render(
      <I18nProvider locale="en-US">
        <AgentThreadWorkspace
          interrupt={async () => undefined}
          onBack={onBack}
          onFollowUp={() => undefined}
          respond={async () => undefined}
          thread={agentThread()}
        />
      </I18nProvider>
    )

    expect(screen.getByRole('button', { name: 'Overview' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
    expect(onBack).toHaveBeenCalledOnce()
    expect(screen.getAllByRole('navigation', { name: 'Page path' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Stop current task' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Read thread' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Thread settings' })).not.toBeInTheDocument()
  })
})

function bartProps(): React.ComponentProps<typeof BartThreadView> {
  return {
    thread: {
      id: 'bart',
      bart: true,
      harnessId: 'codex',
      revision: 1,
      sessionState: {},
      observation: { latestExecution: null, backgroundWork: null },
      title: 'Bart',
      tags: [],
      cwd: '/workspace',
      settings: {},
      transcript: [],
      createdAt: 1,
      updatedAt: 1
    } satisfies BartThreadRecord,
    execution: null,
    inputValue: '',
    attachments: [],
    submitting: false,
    clearing: false,
    error: '',
    onBack: () => undefined,
    onSettings: () => undefined,
    onInputChange: () => undefined,
    onChooseFiles: () => undefined,
    onPasteFiles: () => undefined,
    onRemoveAttachment: () => undefined,
    onSubmit: () => undefined,
    onCancel: async () => undefined,
    onClear: () => undefined,
    respond: async () => undefined
  }
}

function agentThread(): React.ComponentProps<typeof AgentThreadWorkspace>['thread'] {
  return {
    id: 'agent-thread',
    harnessId: 'codex',
    revision: 1, archived: false,
    sessionState: {},
    observation: {
      latestExecution: {
        executionId: 'execution-1',
        status: 'running',
        startedAt: 1
      },
      backgroundWork: null
    },
    title: 'Agent task',
    tags: [],
    cwd: '/workspace',
    settings: {},
    createdAt: 1,
    updatedAt: 1
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function installedHarnesses(): Promise<HarnessInstallationMap> {
  return Promise.resolve({
    ...Object.fromEntries(harnessRegistry.HARNESS_IDS.map(id => [id, { status: 'missing' as const }])),
    codex: { status: 'installed', executablePath: '/resolved/codex' },
    claude: { status: 'installed', executablePath: '/resolved/claude' },
  })
}
