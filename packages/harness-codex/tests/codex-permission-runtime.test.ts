import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCodexMainPlugin } from '../src/main/index.js'
import { CodexRuntime } from '../src/main/runtime/index.js'
import type { CodexThreadSettings } from '../src/shared/types.js'

const fixture = resolve(import.meta.dirname, '../../../apps/desktop/tests/fixtures/fake-codex-app-server.mjs')
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const signal = new AbortController().signal
async function setup(environment: NodeJS.ProcessEnv = {}) {
  await chmod(fixture, 0o755)
  const directory = await mkdtemp(join(tmpdir(), 'codex-permission-wire-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const log = join(directory, 'wire.jsonl')
  const context = { resolveExecutable: async () => fixture, environment: async () => ({ ...process.env,
    FAKE_CODEX_INTERRUPT_COMPLETES: '1', FAKE_CODEX_LOG: log, FAKE_CODEX_STATUS_STUCK: '1', ...environment }),
    dataRoot: directory, temporaryWorkspaceRoot: directory }
  const runtime = new CodexRuntime(context)
  const plugin = createCodexMainPlugin(context)
  const acquire = async () => {
    const { server } = await runtime.server(directory, undefined, signal)
    cleanups.push(() => server.dispose())
    return server
  }
  const wire = async (): Promise<{ method?: string; params?: Record<string, unknown> }[]> =>
    (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { directory, plugin, acquire, wire }
}

describe('Codex permission presets on the native runtime', () => {
  it.each([
    ['ask-for-approval', 'workspace-write', 'on-request', 'user', 'workspaceWrite'],
    ['approve-for-me', 'workspace-write', 'on-request', 'auto_review', 'workspaceWrite'],
    ['full-access', 'danger-full-access', 'never', 'user', 'dangerFullAccess']
  ] as const)('carries %s through start, subsequent turn, process reconstruction and fork', async (permissionMode, sandbox, approvalPolicy, approvalsReviewer, policyType) => {
    const { directory, plugin, acquire, wire } = await setup()
    const settings = await plugin.settings.resolveThreadSettings({
      merged: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
      requested: { permissionMode }, cwd: directory, sessionState: null, signal
    })
    let completed = false
    const options = { executionId: 'one', cwd: directory, settings, signal, emit: (event: { type: string }) => { if (event.type === 'done') completed = true },
      inputs: [{ type: 'text' as const, text: 'Check permissions', text_elements: [] }] }
    const first = await acquire()
    const handle = await first.startTurn(options)
    await handle.cancel()
    await vi.waitFor(() => expect(completed).toBe(true))
    await first.startTurn({ ...options, executionId: 'two', sessionId: handle.sessionId })
    await first.dispose()
    // Persisted settings must survive a reconstructed native process.
    const restoredSettings = JSON.parse(JSON.stringify(settings)) as CodexThreadSettings
    const resumed = await acquire()
    await resumed.startTurn({ ...options, settings: restoredSettings, sessionId: handle.sessionId })
    const forked = await acquire()
    await forked.startTurn({ ...options, settings: restoredSettings, forkFromSessionId: handle.sessionId })
    const messages = await wire()
    for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
      expect(messages.find(message => message.method === method)?.params).toMatchObject({ sandbox, approvalPolicy, approvalsReviewer })
    }
    if (sandbox === 'workspace-write') {
      expect(messages.find(message => message.method === 'thread/start')?.params).toMatchObject({
        config: { sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false } }
      })
    }
    const turns = messages.filter(message => message.method === 'turn/start')
    expect(turns).toHaveLength(4)
    for (const turn of turns) {
      expect(turn.params).toMatchObject({ approvalPolicy, approvalsReviewer, sandboxPolicy: { type: policyType } })
      expect(turn.params).not.toHaveProperty('permissionMode')
    }
  })

  it.each([
    { FAKE_CODEX_USER_AGENT: 'fake-codex/0.150.1' },
    { FAKE_CODEX_NO_REVIEWER: '1' },
    { FAKE_CODEX_DENY_AUTO_REVIEW: '1' }
  ])('rejects unavailable automatic approval at resolution and runtime: %j', async environment => {
    const { directory, plugin, acquire, wire } = await setup(environment)
    await expect(plugin.settings.resolveThreadSettings({ merged: {}, requested: { permissionMode: 'approve-for-me' },
      cwd: directory, sessionState: null, signal })).rejects.toThrow(/自动审批不可用/)
    const server = await acquire()
    await expect(server.startTurn({ executionId: 'blocked', cwd: directory, inputs: [], signal,
      settings: { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
      emit: () => undefined })).rejects.toThrow(/自动审批不可用/)
    expect((await wire()).some(message => message.method === 'thread/start' || message.method === 'turn/start')).toBe(false)
  })

  it.each(['user', 'auto_review'] as const)('rejects a runtime that silently ignores reviewer %s', async approvalsReviewer => {
    const { directory, acquire, wire } = await setup({ FAKE_CODEX_IGNORE_REVIEWER: '1' })
    const server = await acquire()
    await expect(server.startTurn({ executionId: 'ignored', cwd: directory, inputs: [], signal,
      settings: { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer },
      emit: () => undefined })).rejects.toThrow(/未确认请求的权限配置/)
    expect((await wire()).some(message => message.method === 'turn/start')).toBe(false)
  })
})
