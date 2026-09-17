import { describe, expect, it, vi } from 'vitest'
import { createChannelHandlers, type CommandService } from '../src/main/command-router'

function boundary() {
  const methods = {
    submitBartMessage: vi.fn(), followUpThread: vi.fn(), respondToThreadInteraction: vi.fn(),
    readThread: vi.fn(), forkThread: vi.fn(), updateThreadSettings: vi.fn(), updateAppSettings: vi.fn(),
    loadHarnessSettingsPresentation: vi.fn(), invokeHarnessExtension: vi.fn(), updateUiState: vi.fn(),
    interruptThread: vi.fn(), setReportArchived: vi.fn()
  }
  const attachmentStore = { stage: vi.fn(), isManagedPath: (path: string) => path.startsWith('/managed/') }
  return { methods, attachmentStore, handlers: createChannelHandlers(methods as unknown as CommandService, {
    attachmentStore, openExternal: vi.fn()
  }) }
}
const input = { parts: [{ kind: 'text', text: 'hello' }] }

describe('command schema behavior', () => {
  it('preserves absent, undefined, null and normalized optional command fields', async () => {
    const { handlers, methods } = boundary()
    for (const extra of [{}, { directoryTag: undefined }]) {
      await handlers['bart:submit']({ input, ...extra })
      expect(methods.submitBartMessage).toHaveBeenLastCalledWith({ input })
    }
    await handlers['bart:submit']({ input, directoryTag: '  workspace  ' })
    expect(methods.submitBartMessage).toHaveBeenLastCalledWith({ input, directoryTag: 'workspace' })
    for (const directoryTag of [null, '', '  ', 'a\0b']) {
      await expect(handlers['bart:submit']({ input, directoryTag })).rejects.toThrow()
    }
    await handlers['state:update-ui']({})
    expect(methods.updateUiState).toHaveBeenLastCalledWith({})
    await handlers['state:update-ui']({ selectedThreadId: null })
    expect(methods.updateUiState).toHaveBeenLastCalledWith({ selectedThreadId: null })
    await expect(handlers['state:update-ui']({ selectedThreadId: undefined })).rejects.toThrow()
    await handlers['thread:interaction-respond']({ threadId: 't', interactionId: 'i', actionId: 'a', answers: undefined, message: '' })
    expect(methods.respondToThreadInteraction).toHaveBeenLastCalledWith({ threadId: 't', interactionId: 'i', actionId: 'a' })
    await expect(handlers['thread:interaction-respond']({ threadId: 't', interactionId: 'i', actionId: 'a', message: null })).rejects.toThrow()
  })

  it('keeps own required keys and exact opaque JSON envelopes', async () => {
    const { handlers, methods } = boundary()
    for (const request of [{ threadId: 't' }, { threadId: 't', request: undefined }, { threadId: 't', request: null, extra: undefined }]) {
      await expect(handlers['thread:fork'](request)).rejects.toThrow()
    }
    await expect(handlers['thread:fork'](Object.assign(Object.create({ request: null }), { threadId: 't' }))).rejects.toThrow()
    for (const payload of [null, 'opaque', [1, true], { native: { unknown: 'preserved' } }]) {
      await handlers['harness:extension']({ harnessId: 'codex', method: 'rpc', payload })
      expect(methods.invokeHarnessExtension).toHaveBeenLastCalledWith({ harnessId: 'codex', method: 'rpc', payload })
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    // 空洞是该用例的输入本身（稀疏结构必须被 IPC 拒绝），不能补成普通数组。
    // oxlint-disable-next-line eslint/no-sparse-arrays
    for (const payload of [undefined, NaN, Infinity, { value: undefined }, new Date(), cycle, [,'hole']]) {
      await expect(handlers['harness:extension']({ harnessId: 'codex', method: 'rpc', payload })).rejects.toThrow()
    }
    const original = { nested: ['value'] }
    await handlers['thread:fork']({ threadId: 't', request: original })
    expect(methods.forkThread.mock.lastCall?.[0].request).not.toBe(original)
  })

  it('retains historical own-key and sparse transport-array behavior without weakening opaque JSON', async () => {
    const { handlers, methods, attachmentStore } = boundary()
    await handlers['state:update-ui'](Object.create({ selectedThreadId: 'inherited' }))
    expect(methods.updateUiState).toHaveBeenLastCalledWith({})
    await handlers['state:update-ui'](Object.defineProperty({}, 'selectedThreadId', { value: 'own' }))
    expect(methods.updateUiState).toHaveBeenLastCalledWith({ selectedThreadId: 'own' })
    // 首元素刻意留空：下方断言 Object.hasOwn(forwarded, 0) === false。
    // oxlint-disable-next-line eslint/no-sparse-arrays
    const parts = [, { kind: 'text', text: 'hello' }]
    await handlers['bart:submit']({ input: { parts } })
    const forwarded = methods.submitBartMessage.mock.lastCall?.[0].input.parts
    expect(forwarded).toHaveLength(2)
    expect(Object.hasOwn(forwarded, 0)).toBe(false)
    expect(forwarded[1]).toEqual({ kind: 'text', text: 'hello' })
    // 同上：空洞必须原样送达 stage-attachments。
    // oxlint-disable-next-line eslint/no-sparse-arrays
    await handlers['bart:stage-attachments']([,])
    const imports = attachmentStore.stage.mock.lastCall?.[0]
    expect(imports).toHaveLength(1)
    expect(Object.hasOwn(imports, 0)).toBe(false)
    await expect(handlers['thread:fork']({ threadId: 't', request: parts })).rejects.toThrow()
    await expect(handlers['bart:submit']({ input: { parts: [undefined, { kind: 'text', text: 'hello' }] } })).rejects.toThrow()
  })

  it('counts command string limits in UTF-16 and serialized opaque limits in UTF-8', async () => {
    const { handlers, methods } = boundary()
    await handlers['thread:interrupt']('😀'.repeat(64))
    expect(methods.interruptThread).toHaveBeenLastCalledWith('😀'.repeat(64))
    await expect(handlers['thread:interrupt']('😀'.repeat(64) + 'x')).rejects.toThrow()
    await handlers['thread:read']({ threadId: 't', question: '  question  ' })
    expect(methods.readThread).toHaveBeenLastCalledWith({ threadId: 't', question: 'question' })
    // JSON object shell {"s":""} is 8 bytes; each CJK character is 3 UTF-8 bytes.
    const exact = { s: '界'.repeat(333330) + 'xx' }
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(1_000_000)
    await handlers['thread:update-settings']({ harnessId: 'codex', threadId: 't', change: exact })
    await expect(handlers['thread:update-settings']({ harnessId: 'codex', threadId: 't', change: { s: exact.s + 'x' } })).rejects.toThrow('字段过大')
  })

  it('preserves attachment defaults, staging ownership, media normalization and visible input intent', async () => {
    const { handlers, methods, attachmentStore } = boundary()
    for (const value of [undefined, null, []]) {
      await handlers['bart:stage-attachments'](value)
      expect(attachmentStore.stage).toHaveBeenLastCalledWith([])
    }
    for (const displayName of [undefined, null, '']) {
      await handlers['bart:stage-attachments']([{ source: 'path', path: '/some/file', displayName }])
      expect(attachmentStore.stage).toHaveBeenLastCalledWith([{ source: 'path', path: '/some/file', displayName: '附件' }])
    }
    await expect(handlers['bart:stage-attachments']([{ source: 'path', path: '/some/file' }])).rejects.toThrow()
    const file = { id: 'f', path: '/managed/file', name: 'name', mimeType: 'text/plain', size: 0 }
    await handlers['bart:submit']({ input: { parts: [{ kind: 'image', file, detail: undefined }, { kind: 'image-url', url: 'https://EXAMPLE.com', detail: 'auto' }], presentation: undefined } })
    expect(methods.submitBartMessage).toHaveBeenLastCalledWith({ input: { parts: [{ kind: 'image', file }, { kind: 'image-url', url: 'https://example.com/', detail: 'auto' }] } })
    for (const path of ['relative', '/unmanaged/file']) {
      await expect(handlers['bart:submit']({ input: { parts: [{ kind: 'audio', file: { ...file, path } }] } })).rejects.toThrow()
    }
    for (const presentation of ['internal', null]) {
      await expect(handlers['bart:submit']({ input: { ...input, presentation } })).rejects.toThrow()
    }
    await expect(handlers['bart:submit']({ input: { parts: [{ kind: 'text', text: ' \n ' }] } })).rejects.toThrow()
  })
})
