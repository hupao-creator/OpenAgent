import { describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../src/shared/desktop-api'
import type { AgentAttachment } from '../src/shared/attachments'
import { createBartComposerStore } from '../src/renderer/src/bart-composer-store'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const attachment = (id: string): AgentAttachment => ({
  id, kind: 'file', path: '/staged/' + id, name: id, mimeType: 'text/plain', size: 1
})
function api(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return { submitBartMessage: vi.fn(async () => undefined),
    clearBartSession: vi.fn(async () => undefined), ...overrides } as unknown as DesktopApi
}

describe('Bart shared composer', () => {
  it('locks duplicate submission and preserves edits including A → B → A during the request', async () => {
    const pending = deferred()
    const host = api({ submitBartMessage: vi.fn(() => pending.promise) as DesktopApi['submitBartMessage'] })
    const store = createBartComposerStore()
    store.setText('A')
    const sent = store.submit(host, 'workspace')
    await store.submit(host, '')
    expect(host.submitBartMessage).toHaveBeenCalledOnce()
    expect(host.submitBartMessage).toHaveBeenCalledWith({
      input: { parts: [{ kind: 'text', text: 'A' }] }, directoryTag: 'workspace'
    })
    store.setText('B')
    store.setText('A')
    pending.resolve()
    await sent
    expect(store.getState()).toMatchObject({ text: 'A', submitting: false })
  })

  it('keeps failed drafts and removes only submitted attachments after success', async () => {
    const store = createBartComposerStore()
    const first = attachment('first')
    const newer = attachment('newer')
    const host = api({ chooseFiles: vi.fn(async () => [first]) })
    await store.chooseFiles(host, '')
    store.setText('draft')
    const failed = api({ submitBartMessage: vi.fn(async () => { throw new Error('offline') }) })
    await expect(store.submit(failed, '')).rejects.toThrow('offline')
    expect(store.getState()).toMatchObject({ text: 'draft', submitting: false })
    expect(store.getState().attachments).toHaveLength(1)
    const pending = deferred()
    const sending = store.submit(api({ submitBartMessage: vi.fn(() => pending.promise) as DesktopApi['submitBartMessage'] }), '')
    await store.chooseFiles(api({ chooseFiles: vi.fn(async () => [newer]) }), '')
    store.setText('next')
    pending.resolve()
    await sending
    expect(store.getState().text).toBe('next')
    expect(store.getState().attachments).toEqual([{ id: 'newer', status: 'ready', attachment: newer }])
  })

  it('blocks sending pending imports, keeps removed pending items removed, and enforces capacity', async () => {
    const staged = deferred<AgentAttachment[]>()
    const host = api({ stageBartAttachments: vi.fn(() => staged.promise) })
    const store = createBartComposerStore()
    store.setText('draft')
    const importing = store.pasteFiles(host, [{ name: 'file', size: 1, type: 'text/plain' } as File])
    await store.submit(host, '')
    expect(host.submitBartMessage).not.toHaveBeenCalled()
    await expect(store.chooseFiles(host, '')).rejects.toThrow('附件正在处理中')
    const draft = store.getState().attachments[0]
    store.removeAttachment(draft.id)
    staged.resolve([attachment('first')])
    await importing
    expect(store.getState().attachments).toEqual([])
    await expect(store.pasteFiles(host, Array(21).fill({}))).rejects.toThrow('附件数量')
    expect(host.stageBartAttachments).toHaveBeenCalledOnce()
  })

  it.each(['stage-first', 'clear-first', 'failure-first'] as const)(
    'clears captured pending attachments with %s completion', async (order) => {
      const staged = deferred<AgentAttachment[]>(), cleared = deferred()
      const store = createBartComposerStore()
      const host = api({
        stageBartAttachments: vi.fn(() => staged.promise),
        clearBartSession: vi.fn(() => cleared.promise) as DesktopApi['clearBartSession']
      })
      const importing = store.pasteFiles(host, [{ name: 'old', size: 1, type: 'text/plain' } as File])
      const imported = importing.catch(() => undefined)
      const clearing = store.clear(host)
      if (order === 'clear-first') {
        cleared.resolve()
        await clearing
      }
      if (order === 'failure-first') staged.reject(new Error('staging failed'))
      else staged.resolve([attachment('old')])
      await imported
      if (order !== 'clear-first') {
        expect(store.getState().attachments).toHaveLength(1)
        cleared.resolve()
        await clearing
      }
      expect(store.getState().attachments).toEqual([])
    }
  )

  it('clears only the captured draft and isolates independently created stores', async () => {
    const store = createBartComposerStore()
    const other = createBartComposerStore()
    const pending = deferred()
    const host = api({ clearBartSession: vi.fn(() => pending.promise) as DesktopApi['clearBartSession'] })
    store.setText('old')
    const clearing = store.clear(host)
    await store.clear(host)
    store.setText('new')
    expect(other.getState().text).toBe('')
    pending.resolve()
    await clearing
    expect(host.clearBartSession).toHaveBeenCalledOnce()
    expect(store.getState()).toMatchObject({ text: 'new', clearing: false })
    await store.clear(api())
    expect(store.getState().text).toBe('')
  })
})
