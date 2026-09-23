// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useCallback, useState } from 'react'
import { useStore } from 'zustand'
import { afterEach, expect, it, vi } from 'vitest'
import { BartDock } from '../src/renderer/src/components/BartDock'
import { createBartComposerStore } from '../src/renderer/src/bart-composer-store'
import type { DesktopApi } from '../src/shared/desktop-api'

const directories = [{ name: 'project', path: '/work/one/project' }, { name: 'project', path: '/work/two/project' }, { name: '中文 项目', path: '/work/中文 项目' }]
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function fixture(load = vi.fn(async () => directories)) {
  const store = createBartComposerStore()
  const submit = vi.fn(async () => undefined)
  const api = { submitBartMessage: submit } as unknown as DesktopApi
  const close = vi.fn()
  function View() {
    const text = useStore(store, state => state.text)
    const [inputOpen, setInputOpen] = useState(true)
    const onInputOpenChange = useCallback((open: boolean) => { close(open); setInputOpen(open) }, [])
    return <div className="app-shell"><BartDock
      activityContext={{ threadKey: 'mention-test', execution: null }} threadOpen={false} sessionIdle inputOpen={inputOpen}
      inputValue={text} bartAttachments={[]} onInputChange={store.setText} onThreadOpenChange={() => {}}
      onInputOpenChange={onInputOpenChange} onChooseFiles={() => {}} onRemoveBartAttachment={() => {}}
      onSubmit={() => store.submit(api, '')} loadMentionDirectories={load} onMentionSelect={store.insertMention}
    /></div>
  }
  render(<View />)
  const input = screen.getByRole('combobox') as HTMLTextAreaElement
  const type = (text: string, caret = text.length) => {
    fireEvent.change(input, { target: { value: text, selectionStart: caret, selectionEnd: caret } })
    fireEvent.select(input, { target: { selectionStart: caret, selectionEnd: caret } })
  }
  return { store, api, submit, close, input, type }
}

it('selects the exact same-named directory with arrows and Enter, then sends a mention through the real store', async () => {
  const f = fixture()
  f.type('Inspect @pro')
  await screen.findByText('/work/two/project')
  fireEvent.keyDown(f.input, { key: 'ArrowDown' })
  fireEvent.keyDown(f.input, { key: 'Enter' })
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.input.value).toBe('Inspect @"/work/two/project" ')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(f.submit).toHaveBeenCalledWith({ input: { parts: [
    { kind: 'text', text: 'Inspect ' }, { kind: 'mention', pathType: 'directory', name: 'project', path: '/work/two/project' }
  ] } }))
  expect(f.store.getState().mentions).toEqual([])
})

it('filters by full path and uses Tab without sending or replacing surrounding text', async () => {
  const f = fixture()
  const prefix = 'Compare @/work/two'
  f.type(prefix + ' with another', prefix.length)
  await screen.findByText('/work/two/project')
  expect(screen.getAllByRole('option')).toHaveLength(1)
  fireEvent.keyDown(f.input, { key: 'Tab' })
  expect(f.input.value).toBe('Compare @"/work/two/project"  with another')
  expect(f.submit).not.toHaveBeenCalled()
})

it('supports mouse selection and paths with spaces and Chinese characters', async () => {
  const f = fixture()
  f.type('@中文')
  const option = await screen.findByRole('option')
  fireEvent.pointerDown(screen.getByText('/work/中文 项目'))
  expect(f.close).not.toHaveBeenCalled()
  expect(screen.getByRole('listbox')).toBeInTheDocument()
  fireEvent.click(option)
  expect(f.input.value).toBe('@"/work/中文 项目" ')
  await act(() => f.store.submit(f.api, ''))
  expect(f.submit).toHaveBeenCalledWith({ input: { parts: [{ kind: 'mention', pathType: 'directory', name: '中文 项目', path: '/work/中文 项目' }] } })
})

it('still closes the composer when the pointer is outside both the dock and its menu', async () => {
  const f = fixture()
  f.type('@')
  await screen.findByRole('listbox')
  fireEvent.pointerDown(document.body)
  expect(f.close).toHaveBeenCalledWith(false)
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
})

it('Escape dismisses the menu before closing the composer and editing reopens it', async () => {
  const f = fixture()
  f.type('@')
  await screen.findByRole('listbox')
  fireEvent.keyDown(f.input, { key: 'Escape' })
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(f.close).not.toHaveBeenCalled()
  f.type('@pro')
  expect(screen.getByRole('listbox')).toBeInTheDocument()
})

it('keeps IME confirmation and Shift+Enter out of selection and submission', async () => {
  const f = fixture()
  f.type('@')
  await screen.findByRole('option', { name: '中文 项目 /work/中文 项目' })
  fireEvent.compositionStart(f.input)
  fireEvent.keyDown(f.input, { key: 'Enter', isComposing: true })
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.store.getState().mentions).toEqual([])
  fireEvent.compositionEnd(f.input)
  fireEvent.keyDown(f.input, { key: 'Enter', shiftKey: true })
  fireEvent.keyDown(f.input, { key: 'Enter', keyCode: 229 })
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.store.getState().mentions).toEqual([])
})

it('does not complete email addresses, selected text, or already inserted references', async () => {
  const f = fixture()
  f.type('mail@example.com')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  f.type('@')
  await screen.findByText('/work/one/project')
  fireEvent.keyDown(f.input, { key: 'Tab' })
  fireEvent.select(f.input, { target: { selectionStart: 5, selectionEnd: 5 } })
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  f.type('@project')
  fireEvent.select(f.input, { target: { selectionStart: 0, selectionEnd: 8 } })
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
})

it('shows an empty state and does not send on a selection attempt with no matches', async () => {
  const f = fixture()
  f.type('@missing')
  await screen.findByText('没有匹配的目录')
  fireEvent.keyDown(f.input, { key: 'Enter' })
  expect(f.submit).not.toHaveBeenCalled()
  fireEvent.keyDown(f.input, { key: 'Escape' })
  expect(f.input.value).toBe('@missing')
})

it('bounds rendered options for large histories while still searching all known paths', async () => {
  const many = Array.from({ length: 2000 }, (_, index) => ({ name: `project-${index}`, path: `/work/project-${index}` }))
  const f = fixture(vi.fn(async () => many))
  f.type('@')
  await screen.findByText('仅显示前 50 项，继续输入以缩小范围')
  expect(screen.getAllByRole('option')).toHaveLength(50)
  f.type('@project-1999')
  expect(screen.getAllByRole('option')).toHaveLength(1)
  fireEvent.keyDown(f.input, { key: 'Enter' })
  expect(f.store.getState().mentions[0]?.path).toBe('/work/project-1999')
})

it('explains the mention limit in the input without submitting or discarding the draft', async () => {
  const f = fixture()
  act(() => {
    for (let index = 0; index < 50; index++) {
      const start = f.store.getState().text.length
      f.store.setText(f.store.getState().text + '@')
      f.store.insertMention({ start, end: start + 1, query: '' }, directories[0])
    }
  })
  f.type(f.store.getState().text + '@')
  await screen.findByText('/work/one/project')
  fireEvent.keyDown(f.input, { key: 'Enter' })
  expect(screen.getByText('每条消息最多引用 50 个目录')).toBeVisible()
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.store.getState().mentions).toHaveLength(50)
  expect(f.store.getState().text).toMatch(/@$/)
})
