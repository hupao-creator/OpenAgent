// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessPresentationResources } from '../src/renderer/src/harness-composition'
import { HARNESS_IDS } from '../src/shared/harnesses'
import type { HarnessInstallationMap } from '../src/shared/openagent-settings'
import { HarnessSettingsPage } from '../src/renderer/src/components/HarnessSettingsPage'
import { AppI18nProvider as I18nProvider } from '../src/renderer/src/i18n'
import {
  createDefaultOpenAgentSettings,
  type OpenAgentSettings
} from '../src/shared/openagent-settings'

afterEach(cleanup)

describe('Settings page', () => {
  it.each(['zh-CN', 'en-US'] as const)('automatically saves appearance and retains failed drafts (%s)', async locale => {
    const pending = deferred<void>()
    const onSave = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockReturnValueOnce(pending.promise)
    const original = { ...settings(), locale }
    render(<I18nProvider locale={locale}><HarnessSettingsPage
      onClearHistory={async () => undefined} onClose={() => undefined}
      onSave={onSave} loadHarnessInstallations={installedHarnesses}
      open resources={presentationResources()}
      defaultCwd="/workspace" value={original}
    /></I18nProvider>)
    fireEvent.click(screen.getByRole('tab', { name: locale === 'zh-CN' ? '通用' : 'General' }))
    const appearance = screen.getByLabelText(locale === 'zh-CN' ? '外观' : 'Appearance')
    expect(appearance).toHaveValue('system')
    expect([...appearance.querySelectorAll('option')].map(option => option.textContent)).toEqual(
      locale === 'zh-CN' ? ['跟随系统', '浅色', '深色'] : ['System', 'Light', 'Dark']
    )
    fireEvent.change(appearance, { target: { value: 'dark' } })
    expect(original.appearance).toBe('system')
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenLastCalledWith({ ...original, appearance: 'dark' })
    expect(appearance).toHaveValue('dark')
    expect(original.appearance).toBe('system')
    // The rejected write keeps its draft, so the page has to say why nothing was
    // stored and offer the write again instead of leaving a silent no-op.
    const notice = await screen.findByRole('alert')
    expect(notice).toHaveTextContent('disk full')
    expect(within(notice).getByRole('button', { name: locale === 'zh-CN' ? '重试保存' : 'Retry save' }))
      .toBeEnabled()
    fireEvent.change(appearance, { target: { value: 'light' } })
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ ...original, appearance: 'light' }))
    expect(appearance).toBeEnabled()
    await act(async () => pending.resolve(undefined))
  })

  it('picks the coordinating agent from the same icon options as the local agent list', async () => {
    const original = settings()
    const onSave = vi.fn(async (_settings: OpenAgentSettings) => undefined)
    const props = { onClearHistory: async () => undefined, onClose: vi.fn(), onSave,
      loadHarnessInstallations: installedHarnesses, open: true,
      resources: presentationResources(), defaultCwd: '/workspace' }
    const view = render(<I18nProvider locale="zh-CN"><HarnessSettingsPage {...props} value={original} /></I18nProvider>)
    fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))

    expect(screen.queryByRole('combobox', { name: '协调 Agent' })).toBeNull()
    const picker = screen.getByRole('radiogroup', { name: '协调 Agent' })
    await waitFor(() => expect(within(picker).getAllByRole('radio')
      .map(option => option.getAttribute('data-state')))
      .toEqual(['installed', 'installed']))
    // An Agent that is not on this machine cannot coordinate, so it is not offered.
    expect(within(picker).getAllByRole('radio').map(option => option.getAttribute('data-agent')))
      .toEqual(HARNESS_IDS.filter(id => id !== 'pi'))
    expect(within(picker).queryByRole('radio', { name: /Pi Agent/ })).toBeNull()
    // Nothing is selected until a host is pinned.
    expect(within(picker).getAllByRole('radio').every(option => option.getAttribute('aria-checked') === 'false')).toBe(true)

    const targets = screen.getByRole('group', { name: '可派发的线程' })
    expect(within(targets).getAllByRole('checkbox').map(option => option.getAttribute('data-agent')))
      .toEqual(HARNESS_IDS.filter(id => id !== 'pi'))
    // Choosing among present Agents carries no install badge; the plate is the click.
    expect(within(picker).getAllByRole('radio').every(option => option.querySelector('.harness-icon-badge') === null)).toBe(true)
    expect(within(targets).getAllByRole('checkbox').every(option => option.querySelector('.harness-icon-badge') === null)).toBe(true)

    fireEvent.click(within(picker).getByRole('radio', { name: 'Codex · 已安装' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      bart: expect.objectContaining({ hostHarnessPreference: 'codex' })
    })))
    const saved = onSave.mock.calls.at(-1)![0]
    view.rerender(<I18nProvider locale="zh-CN"><HarnessSettingsPage {...props} value={saved} /></I18nProvider>)
    const reopened = screen.getByRole('radiogroup', { name: '协调 Agent' })
    expect(within(reopened).getByRole('radio', { name: 'Codex · 已安装' })).toHaveAttribute('aria-checked', 'true')
    expect(within(reopened).getByRole('radio', { name: 'Claude · 已安装' })).toHaveAttribute('aria-checked', 'false')
    expect(within(reopened).queryByRole('radio', { name: /Pi Agent/ })).toBeNull()

    // Installing is the 本地 Agent list's job, so the missing Agent stays there
    // with the badge that says so.
    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    const installTarget = screen.getByRole('button', { name: 'Pi Agent · 未安装 · 点击安装' })
    expect(installTarget).toBeVisible()
    expect(installTarget.querySelector('.harness-icon-badge')).not.toBeNull()
  })

  it('keeps the last dispatchable Harness selected in the icon row', async () => {
    const original = settings()
    const onSave = vi.fn(async (_settings: OpenAgentSettings) => undefined)
    const props = { onClearHistory: async () => undefined, onClose: vi.fn(), onSave,
      loadHarnessInstallations: installedHarnesses, open: true, reportCount: 0,
      resources: presentationResources(), threadCount: 0, defaultCwd: '/workspace' }
    const sole = { ...original, bart: { ...original.bart, targetHarnessIds: ['codex' as const] } }
    const view = render(<I18nProvider locale="zh-CN"><HarnessSettingsPage {...props} value={sole} /></I18nProvider>)
    fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))

    const targets = (): HTMLElement => screen.getByRole('group', { name: '可派发的线程' })
    await waitFor(() => expect(within(targets()).getAllByRole('checkbox')
      .map(option => option.getAttribute('data-state'))).toEqual(['installed', 'installed']))

    const codex = within(targets()).getByRole('checkbox', { name: 'Codex · 已安装' })
    expect(codex).toBeChecked()
    expect(codex).toBeDisabled()
    expect(codex).toHaveAttribute('title', '至少保留一个可派发的 provider')
    // Every other target is still free to leave.
    expect(within(targets()).getByRole('checkbox', { name: 'Claude · 已安装' })).toBeEnabled()

    fireEvent.click(within(targets()).getByRole('checkbox', { name: 'Claude · 已安装' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      bart: expect.objectContaining({ targetHarnessIds: ['codex', 'claude'] })
    })))
    view.rerender(<I18nProvider locale="zh-CN"><HarnessSettingsPage {...props}
      value={onSave.mock.calls.at(-1)![0]} /></I18nProvider>)
    expect(within(targets()).getByRole('checkbox', { name: 'Codex · 已安装' })).toBeEnabled()
    expect(within(targets()).getByRole('checkbox', { name: 'Claude · 已安装' })).toBeEnabled()
  })

  it('ignores an uninstalled target when guarding the last visible one', async () => {
    const original = settings()
    const onSave = vi.fn(async (_settings: OpenAgentSettings) => undefined)
    const props = { onClearHistory: async () => undefined, onClose: vi.fn(), onSave,
      loadHarnessInstallations: installedHarnesses, open: true, reportCount: 0,
      resources: presentationResources(), threadCount: 0, defaultCwd: '/workspace' }
    // Pi is missing on this machine, so its saved ID must not keep Codex, the
    // only remaining target, alive.
    const value = { ...original, bart: { ...original.bart, targetHarnessIds: ['codex', 'pi'] as const } }
    render(<I18nProvider locale="zh-CN"><HarnessSettingsPage {...props} value={value} /></I18nProvider>)
    fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))

    const targets = (): HTMLElement => screen.getByRole('group', { name: '可派发的线程' })
    await waitFor(() => expect(within(targets()).getAllByRole('checkbox')
      .map(option => option.getAttribute('data-agent'))).toEqual(['codex', 'claude']))
    const codex = within(targets()).getByRole('checkbox', { name: 'Codex · 已安装' })
    expect(codex).toBeChecked()
    expect(codex).toBeDisabled()
    expect(codex).toHaveAttribute('title', '至少保留一个可派发的 provider')
  })

  it('reports a coordinator that is no longer installed instead of editing it', async () => {
    const original = settings()
    const props = { onClearHistory: async () => undefined, onClose: vi.fn(),
      onSave: vi.fn(async (_settings: OpenAgentSettings) => undefined),
      loadHarnessInstallations: async (): Promise<HarnessInstallationMap> => ({
        ...installedHarnessesValue(), claude: { status: 'missing' }
      }), open: true, reportCount: 0, resources: presentationResources(),
      threadCount: 0, defaultCwd: '/workspace' }
    const value = { ...original, bart: { ...original.bart, hostHarnessPreference: 'claude' as const } }
    render(<I18nProvider locale="zh-CN"><HarnessSettingsPage {...props} value={value} /></I18nProvider>)
    fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))

    const picker = screen.getByRole('radiogroup', { name: '协调 Agent' })
    await waitFor(() => expect(within(picker).getAllByRole('radio')
      .map(option => option.getAttribute('data-agent'))).toEqual(['codex']))
    expect(screen.getByText('当前 Bart provider 值不可用，请重新选择。')).toBeVisible()
    expect(screen.queryByLabelText('权限模式')).toBeNull()
  })

  it('aligns the Pi provider rows with the shared settings rows', () => {
    const pi = renderHostSettings('pi').container
    const selects = ['Provider', '模型', '推理强度'].map(label => screen.getByLabelText(label))
    for (const select of selects) {
      expect(select.tagName).toBe('SELECT')
      expect(select).toHaveClass('sf-select')
      expect(select.closest('.sf-row')).not.toBeNull()
      expect([...select.querySelectorAll('option')][0]).toHaveTextContent('Pi 原生默认')
    }
    // The model option value encodes the provider so a shared model id stays
    // distinguishable between authenticated providers.
    expect([...selects[1]!.querySelectorAll('option')].map(option => option.getAttribute('value')))
      .toEqual(['', 'deepseek/deepseek-v4-flash', 'open-pug-zen/deepseek-v4-flash-free'])
    // A ready Pi environment stays silent instead of printing a loose status line.
    expect(pi.querySelector('.pi-settings .sf-notice')).toBeNull()
    expect(pi.querySelector('.settings-form-grid')).toBeNull()

    cleanup()
    // Every harness section stacks its rows: the legacy two-column grid would
    // pair unrelated fields, and no section keeps a restore-defaults action.
    for (const host of HARNESS_IDS) {
      const section = renderHostSettings(host).container
      expect(section.querySelector('.settings-form-grid')).toBeNull()
      expect(section.querySelector('.settings-control')).toBeNull()
      expect(screen.queryByRole('button', { name: '恢复默认' })).toBeNull()
      cleanup()
    }
  })

  it('keeps a row description associated with its control while the hint hides it', async () => {
    const onSave = vi.fn(async () => undefined)
    renderHostSettings('codex', onSave)
    const gate = screen.getByLabelText('使用默认配置')
    const description = screen.getByText('关闭后可自定义新建 Thread 使用的配置。')
    // The hover hint trades a permanent second line for a tooltip, so the copy
    // has to stay in the DOM behind the same id the control describes itself
    // with; dropping it would leave the row's explanation unreachable.
    expect(description).toHaveClass('sf-row-description')
    expect(gate).toHaveAttribute('aria-describedby', expect.stringContaining(description.id))
    const hint = description.closest('.sf-row')?.querySelector('.sf-row-hint')
    expect(hint).not.toBeNull()
    expect(hint).toHaveRole('button')
    expect(hint).toHaveAccessibleName('说明')
    expect(hint).toHaveAccessibleDescription(expect.stringContaining(description.textContent!))

    // The hint sits beside the label, never inside it: a label wrapping the
    // mark would turn every hover into an activation of the row's control.
    const gateHint = gate.closest('.sf-row')!.querySelector<HTMLElement>('.sf-row-hint')!
    fireEvent.click(gateHint)
    await act(async () => {})
    expect(onSave).not.toHaveBeenCalled()
    // Clicking the row's own label still reaches the switch.
    fireEvent.click(gate.closest('.sf-row')!.querySelector('label')!)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
  })

  it.each([
    ['claude', '模型', ' sonnet', 'sonnet']
  ] as const)('retains %s plugin validation failures without saving or closing them', async (host, label, invalid, valid) => {
    const original = settings()
    const onSave = vi.fn(async () => undefined)
    const onClose = vi.fn()
    render(<I18nProvider locale="zh-CN"><HarnessSettingsPage
      onClearHistory={async () => undefined} onClose={onClose} onSave={onSave}
      loadHarnessInstallations={installedHarnesses} open
      resources={presentationResources()} defaultCwd="/workspace"
      value={{ ...original, bart: { ...original.bart, hostHarnessPreference: host } }}
    /></I18nProvider>)
    fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))
    const input = screen.getByLabelText(label)
    fireEvent.change(input, { target: { value: invalid } })
    fireEvent.blur(input)
    await act(async () => {})
    expect(input).toBeInvalid()
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(input).toHaveValue(invalid)
    // Refusing to leave is only useful if the page shows what it is waiting for,
    // so the refused close puts the cursor back on the invalid field.
    await waitFor(() => expect(input).toHaveFocus())
    fireEvent.change(input, { target: { value: valid } })
    fireEvent.blur(input)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(input).not.toBeInvalid()
  })

  it('shows compact checking and install icons without exposing CLI details by default', async () => {
    const pending = deferred<HarnessInstallationMap>()
    const loadHarnessInstallations = vi.fn(() => pending.promise)
    render(<HarnessSettingsPage
      onClearHistory={async () => undefined}
      onClose={() => undefined}
      onSave={async () => undefined}
      loadHarnessInstallations={loadHarnessInstallations}
      open
      resources={presentationResources()}
      defaultCwd="/workspace"
      value={settings()}
    />)

    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    expect(screen.getByRole('button', { name: 'Codex · 正在检测…' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.queryByRole('tab', { name: 'Codex' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => pending.resolve(missingHarnesses()))
    await waitFor(() => expect(screen.getByRole('tab', { name: '通用' })).toBeVisible())
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.queryByRole('tab', { name: 'Codex' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getAllByRole('button', { name: /未安装 · 点击安装/ })).toHaveLength(HARNESS_IDS.length)
  })

  it('keeps icon details on demand and follows automatic detection', async () => {
    const first: HarnessInstallationMap = {
      ...missingHarnesses(),
      codex: { status: 'installed', executablePath: '/resolved/codex' },
      claude: { status: 'error', message: 'temporary resolver outage' }
    }
    const second: HarnessInstallationMap = {
      ...first,
      codex: { status: 'error', message: 'temporary resolver outage' },
      claude: { status: 'installed', executablePath: '/resolved/claude' }
    }
    const loadHarnessInstallations = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    render(<HarnessSettingsPage
      onClearHistory={async () => undefined}
      onClose={() => undefined}
      onSave={async () => undefined}
      loadHarnessInstallations={loadHarnessInstallations}
      open
      resources={presentationResources()}
      defaultCwd="/workspace"
      value={settings()}
    />)

    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    fireEvent.mouseEnter(await screen.findByRole('button', { name: 'Codex · 已安装' }))
    const dialog = await screen.findByRole('dialog', { name: 'Codex' })
    // The host auto-detects the CLI, so the popover reports health only: there
    // is no path to edit and nothing to point at a different binary.
    expect(within(dialog).queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Claude' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Claude · 检测失败 · 将自动重试' })).toBeVisible()

    fireEvent.focus(window)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Claude · 已安装' })).toBeVisible())
    expect(screen.getByRole('alert')).toHaveTextContent('temporary resolver outage')
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole('dialog', { name: 'Codex' })).toBe(dialog)
    expect(loadHarnessInstallations).toHaveBeenCalledTimes(2)
  })

  it('localizes the Plugin subtree from the draft locale and saves retained settings', async () => {
    const onSave = vi.fn(async () => undefined)
    render(
      <I18nProvider locale="zh-CN">
        <HarnessSettingsPage
          onClearHistory={async () => undefined}
          onClose={() => undefined}
          onSave={onSave}
          loadHarnessInstallations={installedHarnesses}
          open
          resources={presentationResources()}
          defaultCwd="/workspace"
          value={settings()}
        />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    fireEvent.change(screen.getByLabelText('界面语言'), { target: { value: 'en-US' } })
    expect(await screen.findByRole('button', { name: 'Claude · Installed' })).toBeVisible()
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Bart', 'General'])
    // The Plugin subtree follows the draft locale, and the same draft flush
    // carries the retained Harness slice back to the host.
    fireEvent.change(screen.getByLabelText('Appearance'), { target: { value: 'dark' } })
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      locale: 'en-US',
      appearance: 'dark',
      harnesses: expect.objectContaining({ claude: settings().harnesses.claude })
    })))
  })

  it('saves shared Thread defaults from the Bart surface without crossing Plugin slices', async () => {
    const defaults = settings()
    const original: OpenAgentSettings = {
      ...defaults,
      bart: { ...defaults.bart, hostHarnessPreference: 'codex' },
      harnesses: {
        ...defaults.harnesses,
        codex: {
          useDefaultThreadSettings: false,
          threadSettings: { model: 'host-model', approvalPolicy: 'never', sandbox: 'workspace-write' }
        }
      }
    }
    const onSave = vi.fn(async () => undefined)
    render(<HarnessSettingsPage
      onClearHistory={async () => undefined}
      onClose={() => undefined}
      onSave={onSave}
      loadHarnessInstallations={installedHarnesses}
      open
      resources={presentationResources()}
      defaultCwd="/workspace"
      value={original}
    />)

    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    fireEvent.mouseEnter(await screen.findByRole('button', { name: 'Codex · 已安装' }))
    expect(await screen.findByRole('dialog', { name: 'Codex' })).toBeVisible()
    expect(screen.queryByRole('combobox', { name: 'Codex Thread 默认配置 模型' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))
    fireEvent.change(screen.getByLabelText('Codex Thread 默认配置 模型'), {
      target: { value: 'thread-model' }
    })
    fireEvent.change(screen.getByLabelText('Codex Thread 默认配置 权限模式'), {
      target: { value: 'full-access' }
    })

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      ...original,
      harnesses: {
        ...original.harnesses,
        codex: {
          useDefaultThreadSettings: false,
          threadSettings: {
            model: 'thread-model',
            // Hidden native defaults are retained while the preset is added.
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
            permissionMode: 'full-access'
          }
        }
      }
    }))
  })

  // The payload that returns to the Agent defaults crosses the composition
  // boundary, which rejects any own key holding `undefined`; the flag must be
  // omitted rather than blanked.
  it.each(['codex', 'claude', 'pi'] as const)(
    'clears %s Thread defaults when the switch returns to the Agent defaults', async (host) => {
    const defaults = settings()
    const original: OpenAgentSettings = {
      ...defaults,
      bart: { ...defaults.bart, hostHarnessPreference: host },
      harnesses: {
        ...defaults.harnesses,
        [host]: {
          useDefaultThreadSettings: false,
          threadSettings: { model: `${host}-default` }
        }
      }
    }
    const onSave = vi.fn(async () => undefined)
    render(<I18nProvider locale="zh-CN"><HarnessSettingsPage
      onClearHistory={async () => undefined} onClose={() => undefined}
      onSave={onSave} open defaultCwd="/workspace"
      loadHarnessInstallations={async () => ({
        ...installedHarnessesValue(), pi: { status: 'installed', executablePath: '/resolved/pi' }
      })}
      resources={hostDefaultsResources()}
      value={original}
    /></I18nProvider>)

    fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))
    const gate = await screen.findByLabelText('使用默认配置')
    expect(gate).not.toBeChecked()
    fireEvent.click(gate)

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      ...original,
      harnesses: {
        ...original.harnesses,
        [host]: { threadSettings: {} }
      }
    }))
  })

  // An untouched Harness must execute its own defaults, so the page shows the
  // switch on and stores nothing until the user opts out.
  it.each(['codex', 'claude', 'pi'] as const)(
    'leaves %s on the Agent defaults until the user opts out', async (host) => {
    const defaults = settings()
    const original: OpenAgentSettings = {
      ...defaults,
      bart: { ...defaults.bart, hostHarnessPreference: host },
      harnesses: { ...defaults.harnesses, [host]: { threadSettings: {} } }
    }
    const onSave = vi.fn(async () => undefined)
    render(<I18nProvider locale="zh-CN"><HarnessSettingsPage
      onClearHistory={async () => undefined} onClose={() => undefined}
      onSave={onSave} open defaultCwd="/workspace"
      loadHarnessInstallations={async () => ({
        ...installedHarnessesValue(), pi: { status: 'installed', executablePath: '/resolved/pi' }
      })}
      resources={hostDefaultsResources()}
      value={original}
    /></I18nProvider>)

    fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))
    const gate = await screen.findByLabelText('使用默认配置')
    expect(gate).toBeChecked()
    // While the switch is on the section offers no knobs at all; every Harness
    // exposes its own Thread defaults as a 模型 row once the user opts out.
    expect(rowLabels()).not.toContain('模型')

    fireEvent.click(gate)

    await waitFor(() => expect(rowLabels()).toContain('模型'))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      ...original,
      harnesses: {
        ...original.harnesses,
        [host]: { useDefaultThreadSettings: false, threadSettings: {} }
      }
    }))
    expect(onSave.mock.calls).toHaveLength(1)
    // The complete payload above must keep permission implicit even though the
    // editor displays the provider's default permission choice.
    expect(JSON.stringify(onSave.mock.calls[0])).not.toContain('permissionMode')
  })

  it('flushes the draft on close and lets the user cancel history deletion separately', async () => {
    const original = settings()
    const onSave = vi.fn(async () => undefined)
    const onClearHistory = vi.fn(async () => undefined)
    function Fixture(): React.JSX.Element {
      const [open, setOpen] = useState(true)
      const [value, setValue] = useState(original)
      return <>
        <button onClick={() => setOpen(true)}>Reopen</button>
        <HarnessSettingsPage
          onClearHistory={onClearHistory}
          onClose={() => setOpen(false)}
          onSave={async next => { await onSave(); setValue(next) }}
          loadHarnessInstallations={installedHarnesses}
          open={open}
          resources={presentationResources()}
          defaultCwd="/workspace"
          value={value}
        />
      </>
    }
    render(<Fixture />)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Bart', '通用'])
    const bart = screen.getByRole('tab', { name: 'Bart' })
    expect(bart).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Bart' })).toBeVisible()
    // Arrow navigation follows the new visual order.
    fireEvent.keyDown(bart, { key: 'ArrowDown' })
    expect(screen.getByRole('tab', { name: '通用' })).toHaveFocus()
    expect(screen.getByRole('tabpanel', { name: '通用' })).toBeVisible()
    fireEvent.click(await screen.findByRole('button', { name: '清空全部历史数据' }))
    fireEvent.click(screen.getByRole('button', { name: '取消清空' }))
    expect(screen.getByRole('region')).toBeVisible()
    expect(onClearHistory).not.toHaveBeenCalled()

    expect(screen.getByLabelText('外观')).toHaveValue('system')
    fireEvent.change(screen.getByLabelText('外观'), { target: { value: 'dark' } })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(screen.getByRole('tab', { name: 'Bart' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Bart' })).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    await waitFor(() => expect(screen.getByLabelText('外观')).toHaveValue('dark'))
    expect(onSave).toHaveBeenCalled()
  })

  it('retains installation labels through repeated reopening and silently applies installs and removals', async () => {
    const first = deferred<HarnessInstallationMap>()
    const load = vi.fn(() => first.promise)
    const props = {
      onClearHistory: async () => undefined, onClose: () => undefined,
      onSave: async () => undefined, loadHarnessInstallations: load,
      resources: presentationResources(),
      defaultCwd: '/workspace', value: settings()
    }
    const view = render(<HarnessSettingsPage {...props} open />)
    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    expect(screen.getByRole('button', { name: 'Codex · 正在检测…' }).querySelector('.spin')).not.toBeNull()
    await act(async () => first.resolve(installedHarnessesValue()))
    let previous = installedHarnessesValue()
    const removed = { ...previous, codex: { status: 'missing' as const } }
    for (const next of [previous, removed, previous, previous]) {
      view.rerender(<HarnessSettingsPage {...props} open={false} />)
      expect(screen.queryByRole('region')).toBeNull()
      const pending = deferred<HarnessInstallationMap>()
      load.mockReturnValueOnce(pending.promise)
      const calls = load.mock.calls.length
      view.rerender(<HarnessSettingsPage {...props} open />)
      fireEvent.click(screen.getByRole('tab', { name: '通用' }))
      const label = previous.codex?.status === 'installed' ? '已安装' : '未安装 · 点击安装'
      const codex = screen.getByRole('button', { name: `Codex · ${label}` })
      const claude = screen.getByRole('button', { name: 'Claude · 已安装' })
      expect(view.container.querySelector('.harness-icon-badge .spin')).toBeNull()
      await waitFor(() => expect(load).toHaveBeenCalledTimes(calls + 1))
      expect(codex).toHaveAccessibleName(`Codex · ${label}`)
      await act(async () => pending.resolve(next))
      expect(screen.getByRole('button', { name: next.codex?.status === 'installed'
        ? 'Codex · 已安装' : 'Codex · 未安装 · 点击安装' })).toBe(codex)
      expect(screen.getByRole('button', { name: 'Claude · 已安装' })).toBe(claude)
      expect(view.container.querySelector('.harness-icon-badge .spin')).toBeNull()
      previous = next
    }
    expect(load).toHaveBeenCalledTimes(5)
  })

  it('rechecks installation on reopen and ignores a stale request from a closed dialog', async () => {
    const stale = deferred<HarnessInstallationMap>()
    const current = deferred<HarnessInstallationMap>()
    const loadHarnessInstallations = vi.fn()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise)

    function Fixture(): React.JSX.Element {
      const [open, setOpen] = useState(true)
      return <>
        <button onClick={() => setOpen(true)}>Reopen</button>
        <HarnessSettingsPage
          onClearHistory={async () => undefined}
          onClose={() => setOpen(false)}
          onSave={async () => undefined}
          loadHarnessInstallations={loadHarnessInstallations}
          open={open}
          resources={presentationResources()}
          defaultCwd="/workspace"
          value={settings()}
        />
      </>
    }

    render(<Fixture />)
    await waitFor(() => expect(loadHarnessInstallations).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.queryByRole('region')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() => expect(loadHarnessInstallations).toHaveBeenCalledTimes(2))

    await act(async () => stale.resolve(installedHarnessesValue()))
    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    expect(screen.getByRole('button', { name: 'Codex · 正在检测…' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('tab', { name: 'Codex' })).toBeNull()

    await act(async () => current.resolve(missingHarnesses()))
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2))
    expect(screen.queryByRole('tab', { name: 'Codex' })).toBeNull()
    expect(loadHarnessInstallations).toHaveBeenCalledTimes(2)
  })
})

function settings(): OpenAgentSettings {
  const defaults = createDefaultOpenAgentSettings()
  return {
    ...defaults,
    harnesses: {
      ...defaults.harnesses,
      // A host whose Thread defaults the page shows for editing; the gated
      // fields stay out of the page while the switch is on.
      codex: { useDefaultThreadSettings: false, threadSettings: {} },
      claude: { useDefaultThreadSettings: false, threadSettings: {} },
      pi: { useDefaultThreadSettings: false, threadSettings: {} },
    }
  }
}

function installedHarnesses(): Promise<HarnessInstallationMap> {
  return Promise.resolve(installedHarnessesValue())
}

function installedHarnessesValue(): HarnessInstallationMap {
  return {
    ...missingHarnesses(),
    codex: { status: 'installed', executablePath: '/resolved/codex' },
    claude: { status: 'installed', executablePath: '/resolved/claude' },
  }
}

function missingHarnesses(): HarnessInstallationMap {
  return Object.fromEntries(HARNESS_IDS.map(id => [id, { status: 'missing' }]))
}

function rowLabels(): (string | null)[] {
  return Array.from(document.querySelectorAll('.sf-row label')).map(label => label.textContent)
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function renderHostSettings(
  host: (typeof HARNESS_IDS)[number],
  onSave: (value: OpenAgentSettings) => Promise<void> = async () => undefined
): ReturnType<typeof render> {
  const original = settings()
  const view = render(<I18nProvider locale="zh-CN"><HarnessSettingsPage
    onClearHistory={async () => undefined} onClose={() => undefined}
    onSave={onSave} loadHarnessInstallations={installedHarnesses} open
    resources={{
      ...presentationResources(),
      pi: {
        status: 'ready',
        value: {
          cli: { status: 'ready', executablePath: '/resolved/pi', version: '0.83.0' },
          models: [
            { provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: true,
              thinkingLevels: ['low', 'high'] },
            { provider: 'open-pug-zen', id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', reasoning: false }
          ]
        },
        reload: async () => undefined
      }
    }}
    defaultCwd="/workspace"
    value={{
      ...original,
      bart: { ...original.bart, hostHarnessPreference: host }
    }}
  /></I18nProvider>)
  fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))
  return view
}

function hostDefaultsResources(): HarnessPresentationResources {
  return {
    ...presentationResources(),
    claude: {
      status: 'ready',
      value: { cli: { status: 'available', executablePath: '/resolved/claude' }, models: [] },
      reload: async () => undefined
    },
    pi: {
      status: 'ready',
      value: {
        cli: { status: 'ready', executablePath: '/resolved/pi', version: '0.83.0' },
        models: [
          { provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: true,
            thinkingLevels: ['low', 'high'] }
        ]
      },
      reload: async () => undefined
    }
  }
}

function presentationResources(): HarnessPresentationResources {
  const loading = { status: 'loading' as const, reload: async () => undefined }
  return {
    codex: {
      status: 'ready',
      value: {
        cli: { available: true, executable: '/resolved/codex' },
        models: ['thread-model', 'host-model', 'next-model'].map((value) => ({
          value, displayName: value, supportedReasoningEfforts: [], serviceTiers: []
        }))
      },
      reload: async () => undefined
    },
    claude: loading
  }
}
