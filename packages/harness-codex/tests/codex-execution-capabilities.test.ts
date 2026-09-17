import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessPluginHostContext } from '@openagent/contracts'
import { codexMainPluginModule } from '../src/main/module.js'
import { CodexRuntime } from '../src/main/runtime/index.js'
import { createCodexSettingsApi } from '../src/main/settings.js'

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Codex execution capabilities', () => {
  it('uses user approval for an API-key provider and restores that default on reset', async () => {
    const api = createCodexSettingsApi(undefined, 'ask-for-approval')
    const signal = new AbortController().signal
    const current = await api.resolveThreadSettings({ merged: {}, sessionState: null, cwd: tmpdir(), signal })
    expect(current).toMatchObject({ approvalsReviewer: 'user', approvalPolicy: 'on-request' })
    expect(await api.applyThreadSettingsUpdate({ current, defaults: {}, update: { permissionMode: null }, hasContent: false, cwd: tmpdir(), signal })).toMatchObject({ approvalsReviewer: 'user', approvalPolicy: 'on-request' })
  })
  // 探活只验证可执行文件本身：不打开展示层，也不为模型目录启动 app-server。
  it('probes execution without loading settings presentation or a model catalog', async () => {
    const context = hostContext()
    const resolveExecutable = vi.spyOn(context, 'resolveExecutable')
    const bundle = codexMainPluginModule.createMainPlugin(context)
    const presentation = vi.spyOn(bundle.settingsPresentation, 'load')
      .mockRejectedValue(new Error('catalog unavailable'))
    try {
      await expect(bundle.availability.probe({
        settings: { threadSettings: {} }, cwd: tmpdir(), signal: new AbortController().signal
      })).resolves.toEqual({ available: true })
      expect(presentation).not.toHaveBeenCalled()
      expect(resolveExecutable).toHaveBeenCalledWith(codexMainPluginModule.id, tmpdir(), undefined)
    } finally {
      await bundle.dispose?.()
    }
  })

  // Host 负责自动发现 CLI，可用性探活绝不能被持久化的路径带偏：只有创建
  // Thread 时才固定可执行文件，而那不是 settings 的事。
  it('auto-detects the CLI instead of carrying a configured path', async () => {
    const resolveExecutable = vi.fn(async (_command: string, _cwd: string, configuredPath?: string) => {
      if (configuredPath !== undefined) throw new Error('availability carried a configured executable')
      return process.execPath
    })
    const bundle = codexMainPluginModule.createMainPlugin({ ...hostContext(), resolveExecutable })
    try {
      await expect(bundle.availability.probe({
        settings: { threadSettings: {} },
        cwd: tmpdir(), signal: new AbortController().signal
      })).resolves.toEqual({ available: true })
      expect(resolveExecutable.mock.calls).toEqual([[codexMainPluginModule.id, tmpdir(), undefined]])
    } finally {
      await bundle.dispose?.()
    }
  })

  it('reports an unavailable CLI and propagates cancellation while resolving it', async () => {
    const missing = codexMainPluginModule.createMainPlugin({
      ...hostContext(), resolveExecutable: async () => '/does-not-exist/probe-cli'
    })
    try {
      await expect(missing.availability.probe({
        settings: { threadSettings: {} }, cwd: tmpdir(), signal: new AbortController().signal
      })).resolves.toMatchObject({ available: false })
    } finally {
      await missing.dispose?.()
    }

    const controller = new AbortController()
    const pending = codexMainPluginModule.createMainPlugin({
      ...hostContext(), resolveExecutable: () => new Promise<string>(() => undefined)
    })
    const result = pending.availability.probe({
      settings: { threadSettings: {} }, cwd: tmpdir(), signal: controller.signal
    })
    const rejected = expect(result).rejects.toThrow('probe cancelled')
    try {
      controller.abort(new Error('probe cancelled'))
      await rejected
    } finally {
      controller.abort(new Error('probe cancelled'))
      await rejected
      await pending.dispose?.()
    }
  })

  it('keeps ordinary Codex acquisition isolated from process-wide headless policy', async () => {
    vi.stubEnv('OPENAGENT_BART_HEADLESS_PROVIDER', 'unsupported-global-provider')
    const runtime = new CodexRuntime({
      ...hostContext(), dataRoot: tmpdir()
    })
    const result = await runtime.server(tmpdir())
    expect(result.executable).toBe(process.execPath)
    await result.server.dispose()
  })
})

function hostContext(): HarnessPluginHostContext {
  return {
    resolveExecutable: async () => process.execPath,
    environment: async () => ({}),
    harnessDataRoot: tmpdir(),
    temporaryWorkspaceRoot: tmpdir()
  }
}
