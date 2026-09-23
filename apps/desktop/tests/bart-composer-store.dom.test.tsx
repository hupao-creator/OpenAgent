import { describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../src/shared/desktop-api'
import type { AgentAttachment } from '../src/shared/attachments'
import { createBartComposerStore } from '../src/renderer/src/bart-composer-store'
import { PublicAgentInputSchema } from '@openagent/contracts'

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
  it('keeps the largest mention draft with all attachments inside the public input limit', async () => {
    const store = createBartComposerStore()
    for (let index = 0; index < 50; index++) {
      const start = store.getState().text.length
      store.setText(store.getState().text + '@')
      expect(store.insertMention({ start, end: start + 1, query: '' }, { name: 'project', path: '/work/project' })).toBeDefined()
    }
    const start = store.getState().text.length
    store.setText(store.getState().text + '@')
    const previous = store.getState()
    expect(store.insertMention({ start, end: start + 1, query: '' }, { name: 'extra', path: '/work/extra' })).toBeUndefined()
    expect(store.getState()).toBe(previous)
    const host = api({ chooseFiles: vi.fn(async () => Array.from({ length: 20 }, (_, index) => attachment(String(index)))) })
    await store.chooseFiles(host, '')
    await store.submit(host, '')
    const input = vi.mocked(host.submitBartMessage).mock.calls[0][0].input
    expect(input.parts.filter(part => part.kind === 'mention')).toHaveLength(50)
    expect(input.parts.filter(part => part.kind === 'local-file')).toHaveLength(20)
    expect(PublicAgentInputSchema.safeParse(input).success).toBe(true)
  })

  it('retains failed mentions, tracks surrounding edits, and removes references edited into ordinary text', async () => {
    const store = createBartComposerStore()
    const directory = { name: 'project', path: '/work/project' }
    store.setText('Read @')
    store.insertMention({ start: 5, end: 6, query: '' }, directory)
    const failed = api({ submitBartMessage: vi.fn(async () => { throw new Error('offline') }) })
    await expect(store.submit(failed, '')).rejects.toThrow('offline')
    expect(store.getState().mentions).toHaveLength(1)
    store.setText('Please ' + store.getState().text)
    const host = api()
    await store.submit(host, '')
    expect(host.submitBartMessage).toHaveBeenCalledWith({ input: { parts: [
      { kind: 'text', text: 'Please Read ' }, { kind: 'mention', pathType: 'directory', ...directory }
    ] } })
    store.setText('@')
    store.insertMention({ start: 0, end: 1, query: '' }, directory)
    store.setText(store.getState().text.replace('project', 'other'))
    await store.submit(host, '')
    expect(host.submitBartMessage).toHaveBeenLastCalledWith({ input: { parts: [{ kind: 'text', text: '@"/work/other"' }] } })
  })

  it('preserves mentions edited during an in-flight send, including a second reference', async () => {
    const store = createBartComposerStore(), pending = deferred()
    store.setText('@')
    store.insertMention({ start: 0, end: 1, query: '' }, { name: 'a', path: '/work/a' })
    const sending = store.submit(api({ submitBartMessage: vi.fn(() => pending.promise) as DesktopApi['submitBartMessage'] }), '')
    const start = store.getState().text.length
    store.setText(store.getState().text + '@')
    store.insertMention({ start, end: start + 1, query: '' }, { name: 'b', path: '/work/b' })
    pending.resolve(); await sending
    const host = api()
    await store.submit(host, '')
    expect(host.submitBartMessage).toHaveBeenCalledWith({ input: { parts: [
      { kind: 'mention', pathType: 'directory', name: 'a', path: '/work/a' }, { kind: 'text', text: ' ' }, { kind: 'mention', pathType: 'directory', name: 'b', path: '/work/b' }
    ] } })
  })

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
