import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderConnections } from '@openagent/plugin-kit/main'
import { ArtificialAnalysisModelFacts, createBartEvaluationContext, providerTelemetryContext } from '@openagent/plugin-kit/bart/main'
import deepseek, { normalizeDeepSeekBalanceTelemetry } from '@openagent/provider-deepseek/main'
import mock from '@openagent/provider-mock/main'
import type { ProviderHarnessTarget } from '@openagent/contracts'
import { createAcceptanceLlm } from './mock-llm/server.mjs'
import { piBackend } from '../../../packages/harness-pi/src/main/backend'
import { bindMainHarnessComposition } from '../src/main/harness-composition'
import { piMainModule } from '@openagent/harness-pi/main'
import { claudeBackend } from '../../../packages/harness-claude/src/main/backend'
import { createClaudeMainPlugin } from '../../../packages/harness-claude/src/main'
import { loadProviderConnections } from '../src/main/harness-execution-environment'
import { CodexRuntime } from '../../../packages/harness-codex/src/main/runtime'
import { CodexAppServer } from '../../../packages/harness-codex/src/main/runtime/app-server'

const cleanup: (() => unknown)[] = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
const signal = () => AbortSignal.timeout(10_000)
const target = (id: string): ProviderHarnessTarget => deepseek.descriptor.harnesses.find(entry => entry.harnessId === id)!
const balance = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.3400', granted_balance: '2.3400', topped_up_balance: '10.0000' }] }
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'openagent-providers-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}

describe('Provider connection authority', () => {
  it('shares one mock account across compatible Harnesses using the real HTTP server', async () => {
    const server = await createAcceptanceLlm()
    cleanup.push(() => server.close())
    const connections = new ProviderConnections([mock], [server.connection])
    cleanup.push(() => connections.dispose())
    const bindings = ['claude', 'codex', 'pi'].map(id => connections.forHarness(target(id), server.connection.id).explicit!)
    const contexts = await Promise.all(bindings.map(binding => providerTelemetryContext(binding, signal())))
    expect(server.accountRequests).toBe(1)
    for (const context of contexts) expect(JSON.parse(context!)).toMatchObject({
      connectionId: server.connection.id, authority: 'independent-provider', availability: 'available'
    })
    for (const binding of bindings) expect(binding.injection?.model).toBe('mock-model')
    expect(bindings[1]!.injection?.configuration).toMatchObject({ config: { model_providers: { mock: { base_url: server.url + '/v1' } } } })
    expect(bindings[2]!.injection?.configuration).toMatchObject({ provider: 'mock' })
  })

  it('isolates credentials, balances and endpoint configuration between connections', async () => {
    const first = await createAcceptanceLlm({ apiKey: 'first-key', remaining: 8 })
    const second = await createAcceptanceLlm({ apiKey: 'second-key', remaining: 19 })
    cleanup.push(() => first.close(), () => second.close())
    const connections = new ProviderConnections([mock], [{ ...first.connection, id: 'first' }, { ...second.connection, id: 'second' }])
    cleanup.push(() => connections.dispose())
    const a = connections.forHarness(target('claude'), 'first').explicit!
    const b = connections.forHarness(target('claude'), 'second').explicit!
    const snapshots = await Promise.all([a.readTelemetry(signal()), b.readTelemetry(signal())])
    expect(snapshots.map(value => value.balances?.[0]?.total)).toEqual(['8', '19'])
    expect(a.injection?.environment.ANTHROPIC_BASE_URL).toBe(first.url)
    expect(b.injection?.environment.ANTHROPIC_BASE_URL).toBe(second.url)
    expect(JSON.stringify(snapshots)).not.toMatch(/first-key|second-key/)
  })

  it('validates both Harness and Provider scope declarations without silently changing scope', () => {
    const connections = new ProviderConnections([deepseek], [{ id: 'account', providerId: 'deepseek', apiKey: 'key', scope: 'thread' }])
    cleanup.push(() => connections.dispose())
    expect(() => connections.forHarness(target('claude'), 'account')).toThrow(/scope/)
    expect(() => connections.forHarness({ ...target('claude'), format: 'unsupported' }, 'account')).toThrow(/injection/)
    expect(() => connections.forHarness(target('claude'), 'missing')).toThrow(/Unknown/)
  })

  it('recognizes only official service endpoints and preserves decimal balance values', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => balance }))
    const connections = new ProviderConnections([deepseek], [], { fetch })
    cleanup.push(() => connections.dispose())
    const access = connections.forHarness(target('claude'))
    for (const url of ['http://api.deepseek.com', 'https://api.deepseek.com.evil.test', 'https://proxy.example', 'https://api.deepseek.com:8443', 'https://api.deepseek.com/unrelated']) {
      expect(access.resolve({ kind: 'external', baseUrl: url, apiKey: 'must-not-leak' })).toEqual({ kind: 'unknown' })
    }
    expect(fetch).not.toHaveBeenCalled()
    const resolved = access.resolve({ kind: 'external', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'provider-key' })
    expect(resolved.kind).toBe('provider')
    if (resolved.kind !== 'provider') throw new Error('missing provider')
    expect(resolved.injection).toBeUndefined()
    expect(await resolved.readTelemetry(signal())).toMatchObject({ balances: [{ total: '12.3400', granted: '2.3400', toppedUp: '10.0000' }] })
    expect(fetch).toHaveBeenCalledWith('https://api.deepseek.com/user/balance', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer provider-key' }), redirect: 'error'
    }))
    expect(normalizeDeepSeekBalanceTelemetry(balance).limitReached).toBe(false)
    expect(() => normalizeDeepSeekBalanceTelemetry({ ...balance, balance_infos: [{ ...balance.balance_infos[0], total_balance: 12.34 }] })).toThrow()
  })

  it('reads existing Claude settings without rewriting them and gives explicit bindings precedence', async () => {
    const cwd = await directory()
    await mkdir(join(cwd, '.claude'))
    const path = join(cwd, '.claude', 'settings.json')
    const source = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'native-key', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash', ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash' } })
    await writeFile(path, source)
    const connections = new ProviderConnections([deepseek], [{ id: 'explicit', providerId: 'deepseek', apiKey: 'explicit-key' }])
    cleanup.push(() => connections.dispose())
    const observed = await claudeBackend({ cwd, environment: { CLAUDE_CONFIG_DIR: cwd }, providers: connections.forHarness(target('claude')), signal: signal() })
    expect(observed.kind).toBe('provider')
    if (observed.kind !== 'provider') throw new Error('missing provider')
    expect(observed.identify('sonnet').evaluationRelease).toBe('deepseek-v4-1-flash')
    expect(observed.identify('opusplan').evaluationRelease).toBe('deepseek-v4-1-flash')
    const explicit = await claudeBackend({ cwd, environment: {}, providers: connections.forHarness(target('claude'), 'explicit'), signal: signal() })
    expect(explicit).toMatchObject({ kind: 'provider', connectionId: 'explicit' })
    expect(await readFile(path, 'utf8')).toBe(source)
  })

  it('discovers Pi environment-reference credentials without treating variable names or commands as keys', async () => {
    const cwd = await directory()
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => balance }))
    const connections = new ProviderConnections([deepseek], [], { fetch })
    cleanup.push(() => connections.dispose())
    const host = { environment: async () => ({ PI_CODING_AGENT_DIR: cwd, DS_KEY: 'pi-private-key' }),
      providers: connections.forHarness(target('pi')), harnessDataRoot: cwd, temporaryWorkspaceRoot: cwd,
      resolveExecutable: async () => '/bin/pi' }
    await writeFile(join(cwd, 'models.json'), JSON.stringify({ providers: { deepseek: { apiKey: '${DS_KEY}' } } }))
    const model = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', id: 'deepseek-flash' }
    const backend = await piBackend(host, model)
    expect(backend.kind).toBe('provider')
    if (backend.kind !== 'provider') throw new Error('missing provider')
    expect(backend.identify('deepseek-flash').evaluationRelease).toBe('deepseek-v4-1-flash')
    await backend.readTelemetry(signal())
    expect(fetch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer pi-private-key' }) }))
    fetch.mockClear()
    await writeFile(join(cwd, 'models.json'), JSON.stringify({ providers: { deepseek: { apiKey: '!must-not-execute' } } }))
    const shellCredential = await piBackend(host, model)
    expect(shellCredential.kind).toBe('provider')
    if (shellCredential.kind !== 'provider') throw new Error('missing provider')
    expect(await shellCredential.readTelemetry(signal())).toMatchObject({ availability: 'error' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the effective Codex credential for discovered default-provider telemetry', async () => {
    const cwd = await directory()
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => balance }))
    const connections = new ProviderConnections([deepseek], [], { fetch })
    cleanup.push(() => connections.dispose())
    const runtime = new CodexRuntime({ resolveExecutable: async () => '/unused',
      environment: async () => ({ OPENAI_BASE_URL: 'https://api.deepseek.com', OPENAI_API_KEY: 'default-key', CUSTOM_KEY: 'custom-key' }),
      providers: connections.forHarness(target('codex')), dataRoot: cwd, temporaryWorkspaceRoot: cwd })
    const server = new CodexAppServer('/unused', {})
    const read = vi.spyOn(server, 'readThreadConfiguration')
    const native = vi.spyOn(server, 'hasNativeSubscription')
    try {
      for (const envKey of [undefined, 'CUSTOM_KEY']) {
        read.mockResolvedValue({ model: 'deepseek-flash', model_providers: { openai: envKey ? { env_key: envKey } : {} } })
        const backend = await runtime.backendForServer(server, cwd, signal())
        expect(backend.kind).toBe('provider')
        if (backend.kind !== 'provider') throw new Error('missing provider')
        expect(await backend.readTelemetry(signal())).toMatchObject({ availability: 'available' })
        expect(fetch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `Bearer ${envKey ? 'custom-key' : 'default-key'}` })
        }))
      }
      expect(native).not.toHaveBeenCalled()
    } finally { read.mockRestore(); native.mockRestore(); await server.dispose() }
  })

  it.each(['deepseek-flash', 'deepseek-v4-pro'])('maps every explicit Claude family alias to %s', model => {
    const connections = new ProviderConnections([deepseek], [{ id: 'a', providerId: 'deepseek', apiKey: 'key', model }])
    cleanup.push(() => connections.dispose())
    const binding = connections.forHarness(target('claude'), 'a').explicit!
    for (const alias of ['default', 'opusplan', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'haiku[1m]']) {
      expect(binding.identify(alias)).toEqual({ ...binding.identify(model), selector: alias })
    }
  })

  it('binds a Provider through the production composition and rejects unknown Harness bindings', async () => {
    const server = await createAcceptanceLlm()
    cleanup.push(() => server.close())
    const connections = new ProviderConnections([mock], [server.connection])
    cleanup.push(() => connections.dispose())
    const deps = { providerConnections: connections, providerBindings: { pi: server.connection.id } }
    const composition = bindMainHarnessComposition([piMainModule], deps)
    cleanup.push(() => composition.pi!.dispose())
    const entries = composition.pi!.contextEntries({ harnesses: {} } as never, '/workspace')
    const text = await entries.telemetry!({ signal: signal() } as never)
    expect(JSON.parse(text!)).toMatchObject({ connectionId: server.connection.id, authority: 'independent-provider' })
    expect(() => bindMainHarnessComposition([piMainModule], { ...deps, providerBindings: { typo: server.connection.id } })).toThrow(/unregistered Harness/)
  })

  it('never calls native subscription quota for a known external service, including failures', async () => {
    const cwd = await directory()
    const connections = new ProviderConnections([deepseek], [], { fetch: async () => { throw new Error('offline') } })
    cleanup.push(() => connections.dispose())
    const resolveExecutable = vi.fn(async () => { throw new Error('native subscription must not be queried') })
    const plugin = createClaudeMainPlugin({ resolveExecutable, providers: connections.forHarness(target('claude')),
      environment: async () => ({ CLAUDE_CONFIG_DIR: cwd, ANTHROPIC_BASE_URL: 'https://api.deepseek.com', ANTHROPIC_AUTH_TOKEN: 'secret' }) })
    cleanup.push(() => plugin.dispose?.())
    const context = await plugin.bartContextEntries!.telemetry!({ cwd, settings: { threadSettings: {} }, signal: signal(),
      telemetryLedger: { record: async () => undefined, read: () => ({ windows: [] }) } })
    expect(JSON.parse(context!)).toMatchObject({ authority: 'independent-provider', availability: 'error' })
    expect(context).not.toContain('secret')
    expect(resolveExecutable).not.toHaveBeenCalled()
  })

  it('does not let one cancelled reader cancel shared account acquisition', async () => {
    let release!: (value: { ok: boolean; status: number; json: () => Promise<typeof balance> }) => void
    const fetch = vi.fn(() => new Promise<{ ok: boolean; status: number; json: () => Promise<typeof balance> }>(resolve => { release = resolve }))
    const connections = new ProviderConnections([deepseek], [{ id: 'a', providerId: 'deepseek', apiKey: 'key' }], { fetch })
    cleanup.push(() => connections.dispose())
    const binding = connections.forHarness(target('claude'), 'a').explicit!
    const cancelled = new AbortController()
    const first = binding.readTelemetry(cancelled.signal)
    const second = binding.readTelemetry(signal())
    cancelled.abort(new Error('caller cancelled'))
    await expect(first).rejects.toThrow('caller cancelled')
    release({ ok: true, status: 200, json: async () => balance })
    expect(await second).toMatchObject({ availability: 'available' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects remote Mock endpoints and excludes the test plugin from production configuration', async () => {
    expect(() => new ProviderConnections([mock], [{ id: 'mock', providerId: 'mock', apiKey: 'key', baseUrl: 'https://example.com' }])).toThrow(/loopback/)
    const cwd = await directory()
    const path = join(cwd, 'providers.json')
    await writeFile(path, JSON.stringify({ connections: [{ id: 'mock', providerId: 'mock', apiKeyEnv: 'KEY', baseUrl: 'http://127.0.0.1:1234' }], bindings: { claude: 'mock' } }))
    await expect(loadProviderConnections({ cwd, environment: { OPENAGENT_PROVIDER_CONFIG: path, KEY: 'key' }, headless: false })).rejects.toThrow(/Unregistered/)
  })
})

it('resolves moving API aliases before AA acquisition and final context matching', async () => {
  const current = { slug: 'deepseek-v4-1-flash-max', name: 'DeepSeek V4.1 Flash (Max)', isReasoning: true,
    effort: { slug: 'max' }, release: { slug: 'deepseek-v4-1-flash', name: 'DeepSeek V4.1 Flash' } }
  const old = { ...current, slug: 'deepseek-v4-flash-max', release: { slug: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' } }
  const embed = (value: unknown) => JSON.stringify(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const fetch = vi.fn(async input => String(input).endsWith('/models/')
    ? new Response(`<script>self.__next_f.push([1,"c:\\"models\\":${embed([old, current])}"])</script>`)
    : new Response(`<script>self.__next_f.push([1,"c:\\"currentModel\\":${embed({ ...current,
      intelligenceIndex: 39, timescaleData: { medianOutputSpeed: 200 }, intelligenceIndexCostPerTask: { cost: { total: 0.27 } } })}"])</script>`))
  const facts = new ArtificialAnalysisModelFacts({ fetchImplementation: fetch as typeof globalThis.fetch,
    store: { load: async () => null, save: async () => undefined } })
  cleanup.push(() => facts.dispose())
  const connections = new ProviderConnections([deepseek], [{ id: 'account', providerId: 'deepseek', apiKey: 'key' }])
  cleanup.push(() => connections.dispose())
  const provider = connections.forHarness(target('claude'), 'account').explicit!
  const context = createBartEvaluationContext({ source: facts, loadBackend: async () => provider,
    loadIdentities: async () => ['deepseek-flash', 'deepseek-v4-flash', 'future-model'].map(selector => ({ selector })) })
  const text = await context({ settings: {}, cwd: '/repo', signal: signal(), telemetryLedger: { record: async () => undefined, read: () => ({ windows: [] }) } })
  expect(text).toContain('Canonical evaluation release: deepseek-v4-1-flash')
  expect(text).not.toContain('Canonical evaluation release: deepseek-v4-flash ')
  expect(text).toContain('configuration=reasoning:true,effort:max')
  expect(text).toContain('future-model')
  expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain('https://artificialanalysis.ai/models/deepseek-v4-flash-max')
  expect(provider.injection?.model).toBe('deepseek-flash')
})
