import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { COMMAND_CHANNELS, createChannelHandlers, type CommandChannel } from '../src/main/command-router'
import { startHeadlessControl, type HeadlessControl } from '../src/main/headless-control'
import type { OpenAgentService } from '../src/main/openagent-service'
import { AttachmentRepository } from '../src/main/services/attachment-repository'
import { MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS } from '@openagent/contracts'
import type { HarnessExtensionRequest } from '@openagent/contracts'

const temporaryRoots: string[] = []
const controls: HeadlessControl[] = []

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.close()))
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ))
})

describe('Harness Plugin public command boundary', () => {
  it('is a closed provider-neutral command set', () => {
    expect(COMMAND_CHANNELS).toEqual([
      'bart:submit',
      'bart:clear',
      'bart:stage-attachments',
      'bart:cancel',
      'history:clear',
      'thread:follow-up',
      'thread:interrupt',
      'thread:interaction-respond',
      'thread:read',
      'thread:fork',
      'thread:update-settings',
      'app:update-settings',
      'harness:detect-installations',
      'workspace:list-known-directories',
      'harness:install',
      'harness:settings-presentation',
      'harness:extension',
      'thread:set-archived',
      'report:set-archived',
      'state:load',
      'state:update-ui',
      'shell:open-external'
    ])
  })

  it('does not expose deleted provider Chrome and command capabilities', () => {
    const channels = new Set<string>(COMMAND_CHANNELS)
    expect([
      'app:provider-health',
      'claude:update-runtime',
      'claude:refresh-runtime',
      'claude:mcp',
      'claude:mcp-authenticate',
      'claude:task-stop',
      'claude:tasks-background',
      'conversation:fork',
      'conversation:update-provider-config',
      'codex:hub'
    ].filter((channel) => channels.has(channel))).toEqual([])
  })

  it('accepts the empty current UI-state update as a no-op command', async () => {
    const updateUiState = vi.fn(async () => undefined)
    const service = { updateUiState } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-ipc-attachments')
    )
    const handlers = createChannelHandlers(service, { attachmentStore, openExternal: async () => undefined })

    await handlers['state:update-ui']({})

    expect(updateUiState).toHaveBeenCalledWith({})
  })

  it('routes only a bounded overview directory hint with Bart input', async () => {
    const submitBartMessage = vi.fn(async () => undefined)
    const service = { submitBartMessage } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-ipc-bart-submit')
    )
    const handlers = createChannelHandlers(service, { attachmentStore, openExternal: async () => undefined })
    const input = { parts: [{ kind: 'text', text: 'Work here.' }] }

    await handlers['bart:submit']({ input, directoryTag: '  Workspace  ' })
    expect(submitBartMessage).toHaveBeenCalledWith({
      input,
      directoryTag: 'Workspace'
    })
    await expect(handlers['bart:submit']({
      input,
      directoryTag: '',
      provider: 'codex'
    })).rejects.toThrow('包含未支持字段：provider')
    await expect(handlers['bart:submit']({
      input,
      directoryTag: '   '
    })).rejects.toThrow('无效字段：directoryTag')
  })

  it('shares the closed bounded interaction response envelope with headless', async () => {
    const respondToThreadInteraction = vi.fn(async () => undefined)
    const service = {
      respondToThreadInteraction,
      onStateMutation: () => () => undefined
    } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-interaction-response')
    )
    const handlers = createChannelHandlers(service, { attachmentStore, openExternal: async () => undefined })
    const request = {
      threadId: 'thread-1',
      interactionId: 'interaction-1',
      actionId: 'deny-action',
      answers: { choices: ['second', 'first', 'second'] },
      message: 'Use the read-only operation instead.'
    }

    await expect(handlers['thread:interaction-respond'](request))
      .resolves.toBeUndefined()
    expect(respondToThreadInteraction).toHaveBeenLastCalledWith(request)
    await expect(handlers['thread:interaction-respond']({
      ...request,
      message: 'x'.repeat(MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS + 1)
    })).rejects.toThrow('message')
    await expect(handlers['thread:interaction-respond']({
      ...request,
      message: 'unsafe\0feedback'
    })).rejects.toThrow('message')
    await expect(handlers['thread:interaction-respond']({
      ...request,
      message: null
    })).rejects.toThrow('message')
    await expect(handlers['thread:interaction-respond']({
      ...request,
      nativeFeedback: 'not current'
    })).rejects.toThrow('未支持字段')

    const control = await startHeadlessControl(service, { attachmentStore, openExternal: async () => undefined }, 0)
    controls.push(control)
    const response = await fetch(
      `http://127.0.0.1:${control.port}/invoke/thread%3Ainteraction-respond`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
      }
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, result: null })
    expect(respondToThreadInteraction).toHaveBeenNthCalledWith(2, request)
  })

  it('routes exact global or Thread-scoped settings presentation requests', async () => {
    const loadHarnessSettingsPresentation = vi.fn(async () => ({
      scope: 'global' as const,
      harnessId: 'codex' as const,
      value: null
    }))
    const service = { loadHarnessSettingsPresentation } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-ipc-settings-presentation')
    )
    const handlers = createChannelHandlers(service, { attachmentStore, openExternal: async () => undefined })

    await handlers['harness:settings-presentation']({
      scope: 'global',
      harnessId: 'codex'
    })
    await handlers['harness:settings-presentation']({
      scope: 'thread',
      threadId: 'thread-1'
    })
    expect(loadHarnessSettingsPresentation).toHaveBeenNthCalledWith(1, {
      scope: 'global',
      harnessId: 'codex'
    })
    expect(loadHarnessSettingsPresentation).toHaveBeenNthCalledWith(2, {
      scope: 'thread',
      threadId: 'thread-1'
    })

    await expect(handlers['harness:settings-presentation']({
      harnessId: 'codex'
    })).rejects.toThrow('scope 无效')
    await expect(handlers['harness:settings-presentation']({
      scope: 'thread',
      threadId: 'thread-1',
      harnessId: 'kimi'
    })).rejects.toThrow('未支持字段：harnessId')
    await expect(handlers['harness:settings-presentation']({
      scope: 'global',
      harnessId: 'codex',
      provider: 'kimi'
    })).rejects.toThrow('未支持字段：provider')

    // A Refresh button is carried as its own flag, and stays absent from the
    // page-open request that does not ask for a fresh probe.
    await handlers['harness:settings-presentation']({
      scope: 'global',
      harnessId: 'codex',
      refresh: true
    })
    expect(loadHarnessSettingsPresentation).toHaveBeenNthCalledWith(3, {
      scope: 'global',
      harnessId: 'codex',
      refresh: true
    })
  })

  it('routes provider-neutral Harness installation detection without a request payload', async () => {
    const detectHarnessInstallations = vi.fn(async () => ({
      codex: { status: 'installed' as const, executablePath: '/bin/codex' },
      claude: { status: 'missing' as const },
    }))
    const service = { detectHarnessInstallations } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-ipc-installation-detection')
    )
    const handlers = createChannelHandlers(service, { attachmentStore, openExternal: async () => undefined })

    await expect(handlers['harness:detect-installations']()).resolves.toEqual({
      codex: { status: 'installed', executablePath: '/bin/codex' },
      claude: { status: 'missing' },
    })
    expect(detectHarnessInstallations).toHaveBeenCalledOnce()
  })

  it('routes only harnessId, method, and opaque JSON through the extension boundary', async () => {
    const invokeHarnessExtension = vi.fn(async () => ({ native: { ok: true } }))
    const service = { invokeHarnessExtension } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-ipc-attachments')
    )
    const handlers = createChannelHandlers(service, { attachmentStore, openExternal: async () => undefined })
    const payload = {
      codexSpecific: {
        method: 'skills/list',
        params: { cwds: ['/workspace'] }
      }
    }

    await expect(handlers['harness:extension']({
      harnessId: 'codex',
      method: 'rpc',
      payload
    })).resolves.toEqual({ native: { ok: true } })
    expect(invokeHarnessExtension).toHaveBeenCalledWith({
      harnessId: 'codex',
      method: 'rpc',
      payload
    })

    await expect(handlers['harness:extension']({
      harnessId: 'codex',
      method: 'rpc'
    })).rejects.toThrow('缺少字段：payload')
    await expect(handlers['harness:extension']({
      harnessId: 'codex',
      method: 'rpc',
      payload: null,
      params: {}
    })).rejects.toThrow('包含未支持字段：params')
    await expect(handlers['harness:extension']({
      harnessId: 'codex',
      method: ' rpc ',
      payload: null
    })).rejects.toThrow('无效字段：method')
    await expect(handlers['harness:extension']({
      harnessId: 'codex',
      method: 'rpc',
      payload: new Date()
    })).rejects.toThrow('payload 必须是 JSON')
    await expect(handlers['harness:extension']({
      harnessId: 'codex',
      method: 'rpc',
      payload: new Map([['method', 'skills/list']])
    })).rejects.toThrow('payload 必须是 JSON')
  })

  it('binds fork requests to a Core Thread identity', async () => {
    const forkThread = vi.fn(async () => ({ threadId: 'forked-thread' }))
    const service = {
      forkThread
    } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-ipc-thread-actions')
    )
    const handlers = createChannelHandlers(service, { attachmentStore, openExternal: async () => undefined })


    await expect(handlers['thread:fork']({
      threadId: 'source-thread',
      request: { checkpointId: 'checkpoint-1' }
    })).resolves.toEqual({ threadId: 'forked-thread' })
    expect(forkThread).toHaveBeenCalledWith({
      threadId: 'source-thread',
      request: { checkpointId: 'checkpoint-1' }
    })

    await expect(handlers['thread:fork']({
      threadId: 'source-thread'
    })).rejects.toThrow('缺少字段：request')
    await expect(handlers['thread:fork']({
      threadId: 'source-thread',
      request: null,
      provider: 'claude'
    })).rejects.toThrow('包含未支持字段：provider')
  })

  it('bounds the opaque Harness extension envelope', async () => {
    const invokeHarnessExtension = vi.fn(async () => null)
    const service = {
      invokeHarnessExtension
    } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-opaque-boundary')
    )
    const handlers = createChannelHandlers(service, { attachmentStore, openExternal: async () => undefined })
    const maximumPayload = opaquePayloadWithJsonBytes(8 * 1024 * 1024)

    await expect(handlers['harness:extension']({
      harnessId: 'codex',
      method: 'rpc',
      payload: maximumPayload
    })).resolves.toBeNull()
    expect(invokeHarnessExtension).toHaveBeenCalledTimes(1)

    const oversizedPayload = opaquePayloadWithJsonBytes(8 * 1024 * 1024 + 1)
    await expect(handlers['harness:extension']({
      harnessId: 'codex',
      method: 'rpc',
      payload: oversizedPayload
    })).rejects.toThrow('字段过大：payload')
    expect(invokeHarnessExtension).toHaveBeenCalledTimes(1)
  })

  it('exposes the same opaque harness extension envelope over headless transport', async () => {
    const invokeHarnessExtension = vi.fn(async (request: HarnessExtensionRequest) => ({
      method: request.method,
      mirrored: request.payload
    }))
    const service = {
      invokeHarnessExtension,
      onStateMutation: () => () => undefined
    } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-headless-attachments')
    )
    const control = await startHeadlessControl(service, { attachmentStore, openExternal: async () => undefined }, 0)
    controls.push(control)

    const response = await fetch(
      `http://127.0.0.1:${control.port}/invoke/harness%3Aextension`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          harnessId: 'codex',
          method: 'rpc',
          payload: { method: 'account/read', params: { refreshToken: false } }
        })
      }
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      result: {
        method: 'rpc',
        mirrored: { method: 'account/read', params: { refreshToken: false } }
      }
    })
    expect(invokeHarnessExtension).toHaveBeenCalledWith({
      harnessId: 'codex',
      method: 'rpc',
      payload: { method: 'account/read', params: { refreshToken: false } }
    })
  })

  it('rejects the removed Thread action channel and preserves fork over headless transport', async () => {
    const forkThread = vi.fn(async () => ({ threadId: 'headless-fork' }))
    const service = {
      forkThread,
      onStateMutation: () => () => undefined
    } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-headless-thread-actions')
    )
    const control = await startHeadlessControl(service, { attachmentStore, openExternal: async () => undefined }, 0)
    controls.push(control)

    const actionResponse = await fetch(
      `http://127.0.0.1:${control.port}/invoke/thread%3Aaction`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: 'source-thread',
          method: 'task/stop',
          payload: { nativeTaskId: 'task-1' }
        })
      }
    )
    expect(actionResponse.status).toBe(404)
    await expect(actionResponse.json()).resolves.toEqual({
      ok: false,
      error: '未知 channel: thread:action'
    })

    const forkResponse = await fetch(
      `http://127.0.0.1:${control.port}/invoke/thread%3Afork`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: 'source-thread',
          request: { checkpointId: 'checkpoint-1' }
        })
      }
    )
    expect(forkResponse.status).toBe(200)
    await expect(forkResponse.json()).resolves.toEqual({
      ok: true,
      result: { threadId: 'headless-fork' }
    })
    expect(forkThread).toHaveBeenCalledTimes(1)
  })

  it('keeps an attachment-import array as one headless command payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-headless-attachments-'))
    temporaryRoots.push(root)
    const source = join(root, 'note.txt')
    await writeFile(source, 'headless attachment')
    const attachmentStore = new AttachmentRepository(join(root, 'staged'))
    const service = {
      onStateMutation: () => () => undefined
    } as unknown as OpenAgentService
    const control = await startHeadlessControl(service, { attachmentStore, openExternal: async () => undefined }, 0)
    controls.push(control)

    const response = await fetch(
      `http://127.0.0.1:${control.port}/invoke/bart:stage-attachments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ source: 'path', path: source, displayName: 'note.txt' }])
      }
    )
    const payload = await response.json() as {
      readonly ok: boolean
      readonly result: readonly { readonly name: string }[]
    }

    expect(response.status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(payload.result).toEqual([expect.objectContaining({ name: 'note.txt' })])
  })

  it('accepts a maximum-size AgentInput envelope and leaves inner overflow to the shared parser', async () => {
    const submitBartMessage = vi.fn(async () => undefined)
    const service = {
      submitBartMessage,
      onStateMutation: () => () => undefined
    } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-large-headless-input')
    )
    const handlers = createChannelHandlers(service, { attachmentStore, openExternal: async () => undefined })
    const control = await startHeadlessControl(service, { attachmentStore, openExternal: async () => undefined }, 0)
    controls.push(control)
    const maximumInput = textInputWithJsonBytes(8 * 1024 * 1024)

    await expect(handlers['bart:submit']({ input: maximumInput })).resolves.toBeUndefined()
    const accepted = await fetch(
      `http://127.0.0.1:${control.port}/invoke/bart:submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: maximumInput })
      }
    )
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toEqual({ ok: true, result: null })
    expect(submitBartMessage).toHaveBeenCalledTimes(2)

    const oversizedInput = textInputWithJsonBytes(8 * 1024 * 1024 + 1)
    const rejected = await fetch(
      `http://127.0.0.1:${control.port}/invoke/bart:submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: oversizedInput })
      }
    )
    expect(rejected.status).toBe(400)
    await expect(rejected.json()).resolves.toEqual({
      ok: false,
      error: '字段过大：input'
    })
    expect(submitBartMessage).toHaveBeenCalledTimes(2)
  })

  it('drains a complete headless attachment request outside the Service queue', async () => {
    let releaseHandler!: () => void
    let markHandlerEntered!: () => void
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve
    })
    const handlerEntered = new Promise<void>((resolve) => {
      markHandlerEntered = resolve
    })
    const service = {
      onStateMutation: () => () => undefined
    } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-headless-drain')
    )
    const stageAttachments = vi.spyOn(attachmentStore, 'stage').mockImplementation(async () => {
      markHandlerEntered()
      await handlerGate
      return []
    })
    const control = await startHeadlessControl(service, { attachmentStore, openExternal: async () => undefined }, 0)
    controls.push(control)
    const requestSettled = fetch(
      `http://127.0.0.1:${control.port}/invoke/bart:stage-attachments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{
          source: 'path',
          path: join(tmpdir(), 'headless-drain-note.txt'),
          displayName: 'note.txt'
        }])
      }
    ).then(
      () => 'responded' as const,
      () => 'disconnected' as const
    )

    await handlerEntered
    let closeSettled = false
    const closePromise = control.close().then(() => {
      closeSettled = true
    })
    try {
      // Closing the transport disconnects the socket, but the accepted command
      // remains owned by headless shutdown until its async handler has settled.
      await expect(requestSettled).resolves.toBe('disconnected')
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(closeSettled).toBe(false)
      expect(stageAttachments).toHaveBeenCalledTimes(1)
    } finally {
      releaseHandler()
      await closePromise
    }
    expect(closeSettled).toBe(true)
  })

  it('closes promptly with an incomplete headless request body', async () => {
    const loadRendererState = vi.fn(async () => ({ revision: 1 }))
    const service = {
      loadRendererState,
      onStateMutation: () => () => undefined
    } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-headless-attachments')
    )
    const control = await startHeadlessControl(service, { attachmentStore, openExternal: async () => undefined }, 0)
    controls.push(control)
    const socket = new Socket()
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.connect(control.port, '127.0.0.1', () => {
        socket.removeListener('error', reject)
        resolve()
      })
    })
    socket.write([
      'POST /invoke/state:load HTTP/1.1',
      `Host: 127.0.0.1:${control.port}`,
      'Content-Type: application/json',
      'Content-Length: 100',
      '',
      '{'
    ].join('\r\n'))
    await new Promise<void>(resolve => setImmediate(resolve))

    try {
      const result = await Promise.race([
        control.close().then(() => 'closed' as const),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 500))
      ])
      expect(result).toBe('closed')
      expect(loadRendererState).not.toHaveBeenCalled()
    } finally {
      socket.destroy()
    }
  })

  it('releases its mutation subscription when the headless listener cannot open', async () => {
    const occupied = createServer()
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
    const address = occupied.address()
    if (!address || typeof address !== 'object') throw new Error('missing occupied port')
    const removeListener = vi.fn()
    const service = {
      onStateMutation: vi.fn(() => removeListener)
    } as unknown as OpenAgentService
    try {
      await expect(startHeadlessControl(service, {
        attachmentStore: new AttachmentRepository(join(tmpdir(), 'unused-listen-failure')),
        openExternal: async () => undefined
      }, address.port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(removeListener).toHaveBeenCalledOnce()
    } finally {
      await new Promise<void>(resolve => occupied.close(() => resolve()))
    }
  })

  it('keeps a healthy event subscriber connected after a snapshot larger than 64 KiB', async () => {
    let emitMutation: ((mutation: unknown) => void) | undefined
    const service = {
      onStateMutation: (listener: (mutation: unknown) => void) => {
        emitMutation = listener
        return () => {
          emitMutation = undefined
        }
      }
    } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-headless-attachments')
    )
    const control = await startHeadlessControl(service, { attachmentStore, openExternal: async () => undefined }, 0)
    controls.push(control)
    const abort = new AbortController()
    const response = await fetch(`http://127.0.0.1:${control.port}/events`, {
      signal: abort.signal
    })
    const reader = response.body?.getReader()
    expect(response.status).toBe(200)
    expect(reader).toBeDefined()

    try {
      emitMutation?.({
        type: 'state-patched',
        baseRevision: 0, revision: 1, probe: 'x'.repeat(96 * 1024)
      })
      const first = JSON.parse(await readNdjsonLine(reader!)) as {
        readonly payload: { readonly probe: string }
      }
      expect(first.payload.probe).toHaveLength(96 * 1024)

      // The previous write crosses ServerResponse's high-water mark. A false
      // write return must wait for drain rather than closing the healthy stream.
      emitMutation?.({ type: 'state-patched', baseRevision: 1, revision: 2 })
      const second = JSON.parse(await readNdjsonLine(reader!)) as {
        readonly payload: { readonly revision: number }
      }
      expect(second.payload.revision).toBe(2)
    } finally {
      abort.abort()
      await reader?.cancel().catch(() => undefined)
    }
  })

  it('retains every one-shot effect across deterministic backpressure', async () => {
    let emitMutation: ((mutation: unknown) => void) | undefined
    const service = {
      onStateMutation: (listener: (mutation: unknown) => void) => {
        emitMutation = listener
        return () => { emitMutation = undefined }
      }
    } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-headless-effect-backpressure')
    )
    const control = await startHeadlessControl(service, { attachmentStore, openExternal: async () => undefined }, 0)
    controls.push(control)
    const abort = new AbortController()
    const response = await fetch(`http://127.0.0.1:${control.port}/events`, {
      signal: abort.signal
    })
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()

    const originalWrite = ServerResponse.prototype.write
    let blockedResponse: ServerResponse | undefined
    let forceBackpressure = true
    const writeSpy = vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<ServerResponse['write']>
    ) {
      const accepted = originalWrite.apply(this, args)
      const chunk = args[0]
      if (forceBackpressure && String(chunk).includes('"channel":"state:mutation"')) {
        forceBackpressure = false
        // 要的是调用点的 this（ServerResponse 实例），改用箭头函数会丢掉它。
        // oxlint-disable-next-line typescript/no-this-alias
        blockedResponse = this
        return false
      }
      return accepted
    })

    try {
      emitMutation?.(headlessMutation(1))
      emitMutation?.(headlessMutation(2, true))
      emitMutation?.(headlessMutation(3))
      emitMutation?.(headlessMutation(4, true))
      emitMutation?.(headlessMutation(5))
      expect(blockedResponse).toBeDefined()

      blockedResponse!.emit('drain')
      const events = await readNdjsonEvents(reader!, 4)
      expect(events.map(event => event.payload.revision)).toEqual([1, 2, 4, 5])
      expect(events.map(event => event.payload.effect?.target.id ?? null)).toEqual([
        null,
        'thread-2',
        'thread-4',
        null
      ])
    } finally {
      writeSpy.mockRestore()
      abort.abort()
      await reader?.cancel().catch(() => undefined)
    }
  })

  it('disconnects instead of silently dropping an overflowing effect queue', async () => {
    let emitMutation: ((mutation: unknown) => void) | undefined
    const service = {
      onStateMutation: (listener: (mutation: unknown) => void) => {
        emitMutation = listener
        return () => { emitMutation = undefined }
      }
    } as unknown as OpenAgentService
    const attachmentStore = new AttachmentRepository(
      join(tmpdir(), 'openagent-unused-headless-effect-overflow')
    )
    const control = await startHeadlessControl(service, { attachmentStore, openExternal: async () => undefined }, 0)
    controls.push(control)
    const abort = new AbortController()
    const response = await fetch(`http://127.0.0.1:${control.port}/events`, {
      signal: abort.signal
    })
    const reader = response.body?.getReader()
    const originalWrite = ServerResponse.prototype.write
    let blockedResponse: ServerResponse | undefined
    const writeSpy = vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<ServerResponse['write']>
    ) {
      const accepted = originalWrite.apply(this, args)
      const chunk = args[0]
      if (!blockedResponse && String(chunk).includes('"channel":"state:mutation"')) {
        // 同理，要的是调用点的 this（ServerResponse 实例），箭头函数拿不到。
        // oxlint-disable-next-line typescript/no-this-alias
        blockedResponse = this
        return false
      }
      return accepted
    })

    try {
      emitMutation?.(headlessMutation(1))
      for (let revision = 2; revision <= 66; revision += 1) {
        emitMutation?.(headlessMutation(revision, true))
      }
      expect(blockedResponse?.destroyed).toBe(true)
    } finally {
      writeSpy.mockRestore()
      abort.abort()
      await reader?.cancel().catch(() => undefined)
    }
  })
})

function headlessMutation(revision: number, withEffect = false) {
  return {
    type: 'state-patched',
    baseRevision: revision - 1,
    revision,
    ...(withEffect ? {
      effect: {
        type: 'bart-generation',
        target: { kind: 'thread', id: `thread-${revision}` }
      }
    } : {})
  }
}

async function readNdjsonEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
  timeoutMs = 2_000
): Promise<Array<{
  readonly payload: {
    readonly revision: number
    readonly effect?: { readonly target: { readonly id: string } }
  }
}>> {
  const read = async () => {
    let buffer = ''
    const events: Array<{
      readonly payload: {
        readonly revision: number
        readonly effect?: { readonly target: { readonly id: string } }
      }
    }> = []
    while (events.length < count) {
      const result = await reader.read()
      if (result.done) throw new Error(`event stream closed after ${events.length} events`)
      buffer += Buffer.from(result.value).toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) events.push(JSON.parse(line))
        if (events.length === count) return events
        newline = buffer.indexOf('\n')
      }
    }
    return events
  }
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out reading events')), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readNdjsonLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 2_000
): Promise<string> {
  let buffer = ''
  const read = async (): Promise<string> => {
    while (true) {
      const result = await reader.read()
      if (result.done) throw new Error('event stream closed before a complete line')
      buffer += Buffer.from(result.value).toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline >= 0) return buffer.slice(0, newline)
    }
  }
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out reading event stream')), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function textInputWithJsonBytes(targetBytes: number) {
  const parts = Array.from({ length: 8 }, () => ({
    kind: 'text' as const,
    text: 'x'.repeat(1_000_000)
  }))
  const before = Buffer.byteLength(JSON.stringify({ parts }), 'utf8')
  const withEmptyTail = Buffer.byteLength(JSON.stringify({
    parts: [...parts, { kind: 'text', text: '' }]
  }), 'utf8')
  const tailLength = targetBytes - before - (withEmptyTail - before)
  if (tailLength < 1 || tailLength > 1_000_000) {
    throw new Error(`cannot build ${targetBytes}-byte AgentInput`)
  }
  const input = {
    parts: [...parts, { kind: 'text' as const, text: 'x'.repeat(tailLength) }]
  }
  expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBe(targetBytes)
  return input
}

function opaquePayloadWithJsonBytes(targetBytes: number) {
  const shell = {
    method: 'native/read',
    params: '',
    path: '/provider/native/path'
  }
  const fixedBytes = Buffer.byteLength(JSON.stringify(shell), 'utf8')
  const payload = { ...shell, params: 'x'.repeat(targetBytes - fixedBytes) }
  expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBe(targetBytes)
  return payload
}


describe('schema migration transport behavior', () => {
  it('preserves acceptance and service arguments for equivalent GUI and HTTP JSON inputs', async () => {
    const invoke = vi.fn(async (value: unknown) => value)
    const service = {
      submitBartMessage: invoke,
      followUpThread: invoke,
      readThread: invoke,
      forkThread: invoke,
      updateThreadSettings: invoke,
      updateUiState: invoke,
      respondToThreadInteraction: invoke,
      invokeHarnessExtension: invoke,
      loadHarnessSettingsPresentation: invoke,
      onStateMutation: () => () => undefined
    } as unknown as OpenAgentService
    const runtime = {
      attachmentStore: {
        stage: vi.fn(async () => []),
        isManagedPath: (path: string) => path.startsWith('/managed/')
      },
      openExternal: async () => undefined
    }
    const handlers = createChannelHandlers(service, runtime)
    const control = await startHeadlessControl(service, runtime, 0)
    controls.push(control)
    const input = { parts: [{ kind: 'text', text: 'Fix the parser' }] }
    const response = { threadId: 't', interactionId: 'i', actionId: 'a' }
    const extension = { harnessId: 'codex', method: 'rpc' }
    const file = { id: 'a', path: '/managed/a', name: 'a', mimeType: 'text/plain', size: 0 }
    // Each expected outcome is fixed from the pre-migration public boundary.
    const cases: Array<[CommandChannel, unknown, boolean]> = [
      ['bart:submit', { input }, true],
      ['bart:submit', { input, directoryTag: '  Workspace  ' }, true],
      ['bart:submit', { input, directoryTag: null }, false],
      ['bart:submit', { input, directoryTag: '😀'.repeat(128) }, true],
      ['bart:submit', { input, directoryTag: '😀'.repeat(128) + 'a' }, false],
      ['bart:submit', { input, extra: null }, false],
      ['bart:submit', {}, false],
      ['bart:submit', { input: { parts: [] } }, false],
      ['bart:submit', { input: { parts: [{ kind: 'text', text: '  ' }] } }, false],
      ['bart:submit', { input: { parts: [{ kind: 'text', text: 'bad\0text' }] } }, false],
      ['bart:submit', { input: { parts: [{ kind: 'text', text: '' }, { kind: 'local-file', file }] } }, true],
      ['bart:submit', { input: { parts: [{ kind: 'local-file', file: { ...file, path: '/outside/a' } }] } }, false],
      ['bart:submit', { input: { parts: [{ kind: 'local-file', file: { ...file, size: 0.5 } }] } }, false],
      ['bart:submit', { input: { parts: [{ kind: 'image-url', url: 'https://example.com', detail: 'original' }] } }, true],
      ['bart:submit', { input: { parts: [{ kind: 'audio-url', url: 'file:///tmp/a' }] } }, false],
      ['thread:follow-up', { threadId: '😀'.repeat(64), input }, true],
      ['thread:follow-up', { threadId: '😀'.repeat(64) + 'a', input }, false],
      ['thread:follow-up', { threadId: '', input }, false],
      ['thread:follow-up', { threadId: ' ', input }, true],
      ['thread:follow-up', { input }, false],
      ['thread:read', { threadId: 't', question: '  explain  ' }, true],
      ['thread:read', { threadId: 't', question: '  ' }, false],
      ['thread:read', { threadId: 't', question: null }, false],
      ['thread:fork', { threadId: 't', request: null }, true],
      ['thread:fork', { threadId: 't' }, false],
      ['thread:fork', { threadId: 't', request: { native: { arbitrary: ['x', null, 1] } } }, true],
      ['state:update-ui', {}, true],
      ['state:update-ui', { selectedThreadId: null }, true],
      ['state:update-ui', { selectedThreadId: '' }, false],
      ['state:update-ui', { extra: true }, false],
      ['thread:interaction-respond', { ...response, message: '' }, true],
      ['thread:interaction-respond', { ...response, message: null }, false],
      ['thread:interaction-respond', { ...response, answers: {} }, true],
      ['thread:interaction-respond', { ...response, answers: null }, false],
      ['thread:interaction-respond', { ...response, answers: { q: ['a', 'a', 'b'] } }, true],
      ['thread:interaction-respond', { ...response, answers: { q: [1] } }, false],
      ['thread:interaction-respond', { ...response, answers: JSON.parse('{"__proto__":42}') }, false],
      ['harness:extension', { ...extension, payload: null }, true],
      ['harness:extension', { ...extension, payload: { privateSettings: { anyNativeKey: 7 } } }, true],
      ['harness:extension', extension, false],
      ['harness:extension', { ...extension, method: ' rpc', payload: {} }, false],
      ['harness:settings-presentation', { scope: 'global', harnessId: 'codex' }, true],
      ['harness:settings-presentation', { scope: 'global', harnessId: 'codex', refresh: true }, true],
      ['harness:settings-presentation', { scope: 'global', harnessId: 'codex', refresh: 'yes' }, false],
      ['harness:settings-presentation', { scope: 'thread', threadId: 't' }, true],
      ['harness:settings-presentation', { scope: 'thread', threadId: 't', refresh: false }, true],
      ['harness:settings-presentation', { scope: 'thread', threadId: 't', harnessId: 'codex' }, false],
      ['thread:update-settings', { harnessId: 'codex', threadId: 't', change: [] }, false],
      ['thread:update-settings', { harnessId: 'codex', threadId: 't', change: { nativeUnknownOption: true } }, true]
    ]
    // JSON punctuation counts toward the UTF-8 byte cap; the CJK fixture has
    // far fewer UTF-16 units than bytes and catches character-count substitutions.
    const exactChange = { x: '界'.repeat(333_330) + 'aa' }
    expect(Buffer.byteLength(JSON.stringify(exactChange))).toBe(1_000_000)
    cases.push(
      ['thread:update-settings', { harnessId: 'codex', threadId: 't', change: exactChange }, true],
      ['thread:update-settings', { harnessId: 'codex', threadId: 't', change: { x: exactChange.x + 'a' } }, false]
    )
    for (const [channel, payload, accepted] of cases) {
      invoke.mockClear()
      let guiAccepted = true
      try { await handlers[channel](payload) } catch { guiAccepted = false }
      expect(guiAccepted, `GUI ${channel}`).toBe(accepted)
      const guiCalls = structuredClone(invoke.mock.calls)
      invoke.mockClear()
      const result = await fetch(`http://127.0.0.1:${control.port}/invoke/${encodeURIComponent(channel)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
      })
      expect(result.status, `HTTP ${channel}`).toBe(accepted ? 200 : 400)
      const body = await result.json() as { ok: boolean; error?: string }
      expect(body.ok).toBe(accepted)
      expect(invoke.mock.calls, `service ${channel}`).toEqual(guiCalls)
      if (!accepted) expect(invoke).not.toHaveBeenCalled()
    }
  })
})
