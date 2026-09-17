import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessPluginHostContext, HarnessProviderOverride } from '@openagent/contracts'
import { createPiPrompt } from '../src/main/prompt.js'
import { startPiRpc } from '../src/main/runtime/rpc.js'
vi.mock('../src/main/runtime/rpc.js', () => ({ startPiRpc: vi.fn() }))
const roots: string[] = []
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(events: Record<string, unknown>[], providerOverride?: HarnessProviderOverride) {
  const root = await mkdtemp(join(tmpdir(), 'pi-prompt-')); roots.push(root)
  let listener: (event: Record<string, unknown>) => void = () => {}
  const dispose = vi.fn(async () => {})
  const request = vi.fn(async (command: Record<string, unknown>) => {
    if (command.type === 'prompt') queueMicrotask(() => events.forEach(listener))
    return {}
  })
  vi.mocked(startPiRpc).mockResolvedValue({ request, dispose, write: vi.fn(), subscribe: fn => { listener = fn; return () => {} }, onFailure: () => () => {} })
  const host: HarnessPluginHostContext = { harnessDataRoot: root, temporaryWorkspaceRoot: root, resolveExecutable: async () => '/bin/pi', environment: async () => ({}), providerOverride }
  return { api: createPiPrompt(host), root, request, dispose }
}
const message = (text: string, stopReason = 'stop') => ({ type: 'message_end', message: { role: 'assistant', stopReason, content: [{ type: 'text', text }] } })
it('uses the Host provider for metadata without native defaults or login', async () => {
  const f = await fixture([message('Title'), { type: 'agent_settled' }], { provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'metadata-key', baseUrl: 'http://127.0.0.1:12345' })
  await f.api.complete({ messages: [], outputFormat: { type: 'text' }, signal: new AbortController().signal })
  expect(vi.mocked(startPiRpc).mock.calls[0]?.[0]).toMatchObject({
    env: { OPENAGENT_PROVIDER_API_KEY: 'metadata-key' }, args: expect.arrayContaining(['--provider', 'deepseek', '--model', 'deepseek-v4-flash'])
  })
})
it('waits through native retry and returns the final isolated JSON response', async () => {
  const f = await fixture([message('transient', 'error'), { type: 'agent_end', willRetry: true }, message('{"title":"Pi"}'), { type: 'agent_settled' }])
  const result = await f.api.complete({ messages: [{ role: 'user', content: 'Title' }], outputFormat: { type: 'json_schema', schema: { type: 'object' } }, signal: new AbortController().signal, settings: { provider: 'native', model: 'm', thinkingLevel: 'low' } })
  expect(result).toEqual({ output: { type: 'json', value: { title: 'Pi' } }, finishReason: 'stop' })
  expect(vi.mocked(startPiRpc).mock.calls[0]?.[0].args).toEqual(expect.arrayContaining(['--no-session', '--no-tools', '--no-extensions']))
  expect(vi.mocked(startPiRpc).mock.calls[0]?.[0].args).toEqual(expect.arrayContaining(['--provider', 'native', '--model', 'm', '--thinking', 'low']))
  expect(f.request.mock.calls.every(([command]) => command.type === 'prompt')).toBe(true)
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(await readdir(f.root)).toEqual([])
})
it.each(['error', 'aborted'])('rejects final native %s and cleans up', async status => {
  const f = await fixture([message('', status), { type: 'agent_settled' }])
  await expect(f.api.complete({ messages: [], outputFormat: { type: 'text' }, signal: new AbortController().signal })).rejects.toThrow('failed or was interrupted')
  expect(f.dispose).toHaveBeenCalledOnce(); expect(await readdir(f.root)).toEqual([])
})
it('keeps native length finish reason and rejects malformed JSON', async () => {
  const f = await fixture([message('cut off', 'length'), { type: 'agent_settled' }])
  expect(await f.api.complete({ messages: [], outputFormat: { type: 'text' }, signal: new AbortController().signal })).toEqual({ output: { type: 'text', text: 'cut off' }, finishReason: 'length' })
  await expect(f.api.complete({ messages: [], outputFormat: { type: 'json_schema', schema: {} }, signal: new AbortController().signal })).rejects.toThrow()
})
