// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessSettingsPage } from '../src/renderer/src/components/HarnessSettingsPage'
import { AppI18nProvider } from '../src/renderer/src/i18n'
import { createDefaultOpenAgentSettings, type OpenAgentSettings } from '../src/shared/openagent-settings'

vi.mock('../src/renderer/src/harness-composition', () => ({
  HarnessSettingsHost: () => null,
  harnessRendererTranslations: {},
  harnessLogoSource: () => 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'
}))

// jsdom has no layout, so the page's scrollIntoView calls are recorded here
// instead of moving anything.
const revealed: Element[] = []
const scrollIntoView = function (this: Element) { revealed.push(this) }
const originalScrollIntoView = Element.prototype.scrollIntoView
beforeEach(() => { revealed.length = 0; Element.prototype.scrollIntoView = scrollIntoView })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView
  else delete (Element.prototype as Partial<Element>).scrollIntoView
})

function fixture(
  save: (value: OpenAgentSettings) => Promise<void> = async () => undefined,
  clear: () => Promise<void> = async () => undefined
) {
  const defaults = createDefaultOpenAgentSettings()
  const initial: OpenAgentSettings = { ...defaults, bart: { ...defaults.bart, routingGuidance: 'Original rule' } }
  const onClose = vi.fn()
  const onClear = vi.fn(clear)
  const onSaveError = vi.fn()
  let noticeText = ''
  let persisted = initial
  const onSave = vi.fn(async (next: OpenAgentSettings) => { await save(next); persisted = next })
  function Fixture() {
    const [open, setOpen] = useState(true)
    const [value, setValue] = useState(initial)
    // The app-wide notice is Main's own state, so the fixture holds it the way
    // Main does — every write stamped, so a report can be retired by identity
    // rather than by the text it shares with a newer failure.
    const [notice, setNotice] = useState('')
    const stamps = useRef(0)
    noticeText = notice
    const report = (message: string): void => { stamps.current += 1; setNotice(message) }
    return <AppI18nProvider locale="zh-CN">
      <button onClick={() => setOpen(true)}>Reopen</button>
      <button onClick={() => report('Codex 安装失败')}>Another failure</button>
      <button onClick={() => report('Codex auto_review 执行不可用')}>Execution failure</button>
      <button onClick={() => report('disk full')}>Another failure with the same text</button>
      <HarnessSettingsPage open={open} value={value} defaultCwd="/workspace" resources={{}}
        loadHarnessInstallations={async () => ({})}
        onSave={async next => { await onSave(next); setValue(next) }}
        onSaveError={message => {
          onSaveError(message)
          report(message)
          const stamp = stamps.current
          return () => { if (stamps.current === stamp) setNotice('') }
        }}
        onClose={() => { onClose(); setOpen(false) }} onClearHistory={onClear} />
    </AppI18nProvider>
  }
  render(<Fixture />)
  return { onSave, onClose, onClear, onSaveError, persisted: () => persisted, notice: () => noticeText, initial }
}
function guidance() {
  fireEvent.click(screen.getByRole('tab', { name: 'Bart' }))
  return screen.getByRole('textbox', { name: 'Bart 模型路由指导' })
}
function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('Settings automatic save', () => {
  it('keeps a successful save separate from a later execution failure', async () => {
    // Service tests cover the real resolver/store chain; this test only checks
    // that an independent execution notice never becomes an autosave error.
    const f = fixture()
    const input = guidance()
    fireEvent.change(input, { target: { value: 'Persisted before execution' } })
    fireEvent.blur(input)
    await waitFor(() => expect(f.persisted().bart.routingGuidance).toBe('Persisted before execution'))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => expect(f.onClose).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Execution failure' }))
    expect(f.notice()).toBe('Codex auto_review 执行不可用')
    expect(screen.queryByRole('button', { name: '重试保存' })).toBeNull()
    expect(f.onSaveError).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(guidance()).toHaveValue('Persisted before execution')
    expect(f.onSave).toHaveBeenCalledOnce()
  })

  it('uses default guidance when enabled empty, then saves a completed rule', async () => {
    const f = fixture()
    guidance()
    const toggle = screen.getByRole('switch', { name: '自定义模型路由指导' })
    fireEvent.click(toggle)
    await waitFor(() => expect(f.persisted().bart.routingGuidance).toBeNull())
    fireEvent.click(toggle)
    const input = screen.getByRole('textbox', { name: 'Bart 模型路由指导' })
    expect(input).toHaveValue('')
    expect(input).not.toBeInvalid()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(f.persisted().bart.routingGuidance).toBeNull()
    fireEvent.blur(input)
    expect(input).not.toBeInvalid()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(input, { target: { value: 'Prefer a small model for routine work' } })
    fireEvent.blur(input)
    await waitFor(() => expect(f.persisted().bart.routingGuidance).toBe('Prefer a small model for routine work'))
    expect(input).not.toBeInvalid()
  })

  it('allows closing with newly enabled empty guidance and keeps the default', async () => {
    const f = fixture()
    guidance()
    const toggle = screen.getByRole('switch', { name: '自定义模型路由指导' })
    fireEvent.click(toggle)
    await waitFor(() => expect(f.persisted().bart.routingGuidance).toBeNull())
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => expect(f.onClose).toHaveBeenCalledTimes(1))
    expect(f.onSaveError).not.toHaveBeenCalled()
    expect(f.persisted().bart.routingGuidance).toBeNull()
  })

  it.each(['', ' \n\t ', '  First rule\nSecond rule\n '])('normalizes guidance %j on save and immediate close', async value => {
    const f = fixture()
    fireEvent.change(guidance(), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => expect(f.onClose).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(f.persisted().bart.routingGuidance).toBe(value.trim() || null))
    expect(f.onSaveError).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect((screen.getByRole('switch', { name: '自定义模型路由指导' }) as HTMLInputElement).checked).toBe(Boolean(value.trim()))
    if (value.trim()) expect(guidance()).toHaveValue(value.trim())
  })

  it('serializes rapid multi-field choices and never replaces newer drafts with old responses', async () => {
    const first = deferred()
    const second = deferred()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const f = fixture(save)
    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    const appearance = screen.getByLabelText('外观')
    fireEvent.change(appearance, { target: { value: 'dark' } })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    fireEvent.change(appearance, { target: { value: 'light' } })
    fireEvent.change(screen.getByLabelText('界面语言'), { target: { value: 'en-US' } })
    expect(appearance).toBeEnabled()
    expect(save).toHaveBeenCalledTimes(1)
    await act(async () => first.resolve())
    expect(save).toHaveBeenCalledTimes(2)
    expect(appearance).toHaveValue('light')
    expect(screen.getByLabelText('Interface language')).toHaveValue('en-US')
    expect(save).toHaveBeenLastCalledWith({ ...f.initial, appearance: 'light', locale: 'en-US' })
    await act(async () => second.resolve())
    expect(f.persisted()).toEqual({ ...f.initial, appearance: 'light', locale: 'en-US' })
    expect(screen.getByRole('region', { name: 'Settings' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    expect(screen.queryByText('Unsaved changes')).toBeNull()
  })

  it('debounces text, submits on blur, and does not let a choice response flush unfinished text', async () => {
    vi.useFakeTimers()
    const first = deferred()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const f = fixture(save)
    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    fireEvent.change(screen.getByLabelText('外观'), { target: { value: 'dark' } })
    await act(async () => {})
    const input = guidance()
    fireEvent.change(input, { target: { value: 'First' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300); first.resolve() })
    expect(f.onSave).toHaveBeenCalledTimes(1)
    expect(input).toHaveValue('First')
    fireEvent.change(input, { target: { value: 'Finished rule' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(f.onSave).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(f.persisted().bart.routingGuidance).toBe('Finished rule')
    fireEvent.change(input, { target: { value: 'Blurred rule' } })
    fireEvent.blur(input)
    await act(async () => {})
    expect(f.persisted().bart.routingGuidance).toBe('Blurred rule')
  })

  it.each(['返回', 'Escape'])('starts the pending write before %s without waiting for it, then restores it on reopen', async close => {
    const pending = deferred()
    const f = fixture(() => pending.promise)
    fireEvent.change(guidance(), { target: { value: 'Keep this completed rule' } })
    if (close === 'Escape') fireEvent.keyDown(document, { key: 'Escape' })
    else fireEvent.click(screen.getByRole('button', { name: close }))
    // Leaving the page cannot be held hostage by the write it just started: the
    // page is already gone while the request is still in flight, and the draft
    // survives because the flush cancelled the debounce first.
    await waitFor(() => expect(f.onClose).toHaveBeenCalledTimes(1))
    expect(f.onSave).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('region', { name: '设置' })).toBeNull()
    await act(async () => pending.resolve())
    await waitFor(() => expect(f.persisted().bart.routingGuidance).toBe('Keep this completed rule'))
    expect(f.onSaveError).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(guidance()).toHaveValue('Keep this completed rule')
  })

  it('keeps invalid input visible without overwriting valid guidance, while saving other preferences', async () => {
    const f = fixture()
    const input = guidance()
    const tooLong = 'x'.repeat(12_001)
    fireEvent.change(input, { target: { value: tooLong } })
    fireEvent.blur(input)
    await act(async () => {})
    expect(input).toBeInvalid()
    expect(input).toHaveAccessibleDescription('模型路由指导最多 12000 个字符（UTF-16 计数），当前 12001 个。')
    expect(input).not.toHaveAttribute('maxlength')
    expect(screen.queryByRole('button', { name: '重试保存' })).toBeNull()
    expect(f.onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    fireEvent.change(screen.getByLabelText('外观'), { target: { value: 'dark' } })
    await waitFor(() => expect(f.persisted().appearance).toBe('dark'))
    expect(f.persisted().bart.routingGuidance).toBe('Original rule')
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await act(async () => {})
    expect(f.onClose).not.toHaveBeenCalled()
    expect(guidance()).toHaveValue(tooLong)
    fireEvent.change(input, { target: { value: 'Corrected rule' } })
    fireEvent.blur(input)
    await waitFor(() => expect(f.persisted().bart.routingGuidance).toBe('Corrected rule'))
    expect(input).not.toBeInvalid()
  })

  it('reports a write that fails after the page already closed', async () => {
    const first = deferred()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const f = fixture(save)
    const input = guidance()
    fireEvent.change(input, { target: { value: 'First attempted rule' } })
    fireEvent.blur(input)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { value: 'Latest rule' } })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await act(async () => first.reject(new Error('disk full')))

    // The page that used to hold the reason is gone, so the failure has to be
    // named where the reader still is rather than scroll past silently.
    await waitFor(() => expect(f.onSaveError).toHaveBeenCalledWith('disk full'))
    expect(f.onClose).toHaveBeenCalledTimes(1)
    expect(f.persisted().bart.routingGuidance).toBe('Original rule')
  })

  it('keeps a pending change when the page is reopened before its write lands', async () => {
    const first = deferred()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const f = fixture(save)
    const input = guidance()
    fireEvent.change(input, { target: { value: 'Changed rule' } })
    fireEvent.blur(input)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))

    // Closing no longer waits for the write, so the reopened page can base a
    // later edit on a value Main has not accepted yet. Resetting to it would
    // make the finishing write's drain loop save it back over the change.
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => expect(f.onClose).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await act(async () => first.resolve())
    await act(async () => {})
    expect(save).toHaveBeenCalledTimes(1)
    expect(f.persisted().bart.routingGuidance).toBe('Changed rule')
  })

  it('keeps the failed draft and its notice when the page is reopened', async () => {
    const first = deferred()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const f = fixture(save)
    const input = guidance()
    fireEvent.change(input, { target: { value: 'First attempted rule' } })
    fireEvent.blur(input)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { value: 'Latest rule' } })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => expect(f.onClose).toHaveBeenCalledTimes(1))
    await act(async () => first.reject(new Error('disk full')))
    await waitFor(() => expect(f.onSaveError).toHaveBeenCalledWith('disk full'))

    // The reader comes back to the edit the failure left behind, not to the
    // value Main still holds: a base of props.value would make the retry save
    // the rejected draft back over the change, and dropping the notice would
    // leave them with no reason for the difference.
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    const reopened = guidance()
    expect(reopened).toHaveValue('Latest rule')
    const notice = screen.getByRole('alert')
    expect(notice).toHaveTextContent('disk full')
    fireEvent.click(within(notice).getByRole('button', { name: '重试保存' }))
    await waitFor(() => expect(f.persisted().bart.routingGuidance).toBe('Latest rule'))
    expect(screen.queryByRole('alert')).toBeNull()
    // That same notice outlives the page, and Main has since taken the draft it
    // names. Leaving it up would keep reporting a failure the retry has answered.
    await waitFor(() => expect(f.notice()).toBe(''))
    // One report, and the notice it named is the one that went away: retiring it
    // is the app's own dismissal, not another thing said to the notice.
    expect(f.onSaveError).toHaveBeenCalledTimes(1)
    expect(f.onSaveError).toHaveBeenCalledWith('disk full')
  })

  it('leaves a notice another operation put up in its place', async () => {
    const first = deferred()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const f = fixture(save)
    const input = guidance()
    fireEvent.change(input, { target: { value: 'First attempted rule' } })
    fireEvent.blur(input)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { value: 'Latest rule' } })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await act(async () => first.reject(new Error('disk full')))
    await waitFor(() => expect(f.notice()).toBe('disk full'))

    // Another operation fails while the reader is on the page the save left.
    fireEvent.click(screen.getByRole('button', { name: 'Another failure' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    const notice = screen.getByRole('alert')
    expect(notice).toHaveTextContent('disk full')
    fireEvent.click(within(notice).getByRole('button', { name: '重试保存' }))
    await waitFor(() => expect(f.persisted().bart.routingGuidance).toBe('Latest rule'))
    // The retry answers the failure this page reported, not the one the reader
    // is left looking at: taking that one down would hide a live problem.
    expect(f.notice()).toBe('Codex 安装失败')
  })

  it('leaves a notice another operation replaced with the same text', async () => {
    const first = deferred()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const f = fixture(save)
    const input = guidance()
    fireEvent.change(input, { target: { value: 'First attempted rule' } })
    fireEvent.blur(input)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { value: 'Latest rule' } })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await act(async () => first.reject(new Error('disk full')))
    await waitFor(() => expect(f.notice()).toBe('disk full'))

    // An unrelated operation fails with the very same words. The reader is
    // looking at a live problem now, and matching text is not this page's claim
    // on it.
    fireEvent.click(screen.getByRole('button', { name: 'Another failure with the same text' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    const notice = screen.getByRole('alert')
    fireEvent.click(within(notice).getByRole('button', { name: '重试保存' }))
    await waitFor(() => expect(f.persisted().bart.routingGuidance).toBe('Latest rule'))
    // The retry's own retirement has to have run for this to prove anything.
    await act(async () => {})
    expect(f.notice()).toBe('disk full')
  })

  it('names a failed write and retries the draft it kept, without closing the page', async () => {
    const first = deferred()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const f = fixture(save)
    const input = guidance()
    fireEvent.change(input, { target: { value: 'Retried rule' } })
    fireEvent.blur(input)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    await act(async () => first.reject(new Error('disk full')))

    // A retained draft the user cannot see the reason for is a dead end, so the
    // page states the failure and offers the same write again.
    const notice = screen.getByRole('alert')
    expect(notice).toHaveTextContent('disk full')
    expect(input).toHaveValue('Retried rule')
    fireEvent.click(within(notice).getByRole('button', { name: '重试保存' }))
    await waitFor(() => expect(f.persisted().bart.routingGuidance).toBe('Retried rule'))
    expect(f.onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    // This failure never reached the app-wide notice, so its recovery must not
    // reach it either: the page only takes down a notice it put up itself.
    expect(f.onSaveError).not.toHaveBeenCalled()
  })

  it('brings a failed write back into view instead of reporting it off-screen', async () => {
    const first = deferred()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const f = fixture(save)
    const input = guidance()
    fireEvent.change(input, { target: { value: 'Retried rule' } })
    fireEvent.blur(input)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    await act(async () => first.reject(new Error('disk full')))

    // The notice lives above the fields, so a failure reported while the reader
    // sits on the field below the fold has to be scrolled back to.
    const notice = screen.getByRole('alert')
    expect(notice).toHaveTextContent('disk full')
    expect(f.persisted().bart.routingGuidance).toBe('Original rule')
    expect(revealed.some(node => node.contains(notice))).toBe(true)
  })

  it('keeps the field an invalid close points at in view after switching tabs', async () => {
    fixture()
    const input = guidance()
    fireEvent.change(input, { target: { value: 'x'.repeat(12_001) } })
    fireEvent.blur(input)
    await act(async () => {})
    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    await act(async () => {})
    const body = document.getElementById('settings-panel')!
    body.scrollTop = 480
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await act(async () => {})

    // Revealing the blocked field is the whole explanation for the refused close,
    // so the tab switch must not scroll it away again.
    expect(screen.getByRole('tab', { name: 'Bart' })).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveFocus()
    expect(body.scrollTop).toBe(480)
    expect(revealed).toContain(input)
  })

  it('does not submit IME composition or close over it, then saves completed composition', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const input = guidance()
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '未完成' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    fireEvent.blur(input)
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(f.onClose).not.toHaveBeenCalled()
    expect(f.onSave).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    fireEvent.change(input, { target: { value: '完成后的规则' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(f.persisted().bart.routingGuidance).toBe('完成后的规则')
  })

  it('does not autosave history actions and still requires a second explicit deletion click', async () => {
    const f = fixture()
    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    fireEvent.click(screen.getByRole('button', { name: '清空全部历史数据' }))
    expect(f.onClear).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消清空' }))
    expect(f.onClear).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '清空全部历史数据' }))
    fireEvent.click(screen.getByRole('button', { name: '确认永久删除' }))
    await act(async () => {})
    expect(f.onClear).toHaveBeenCalledTimes(1)
    expect(f.onSave).not.toHaveBeenCalled()
  })

  it('names a rejected history clear instead of returning to an unchanged page', async () => {
    const f = fixture(undefined, async () => { throw new Error('database is locked') })
    fireEvent.click(screen.getByRole('tab', { name: '通用' }))
    fireEvent.click(screen.getByRole('button', { name: '清空全部历史数据' }))
    fireEvent.click(screen.getByRole('button', { name: '确认永久删除' }))

    // The confirmation resets either way, so a refused clear would otherwise look
    // exactly like a page the user simply chose not to touch.
    const notice = await screen.findByRole('alert')
    expect(notice).toHaveTextContent('database is locked')
    expect(f.onClear).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '清空全部历史数据' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '确认永久删除' })).toBeNull()
  })
})
