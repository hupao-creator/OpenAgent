import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCodexMainPlugin } from '../src/main/index.js'
import {
  CodexAppServer,
  type CodexNativeActivityEvent
} from '../src/main/runtime/app-server.js'
import { CodexRuntime } from '../src/main/runtime/index.js'
import { openCodexThread } from '../src/main/thread/thread-handle.js'
import { codexSessionState } from '../src/shared/session-state.js'
import {
  createEmptyCodexState,
  decodeCodexState,
  latestCodexTurn,
  reduceCodexEvent,
  settleCodexExecution,
  stageCodexExecution,
  updateCodexNativeActivity
} from '../src/shared/state.js'
import type {
  CodexNativeEvent,
  CodexThreadSettings
} from '../src/shared/types.js'
import {
  type AgentThreadRecord,
  type HarnessThreadHandle,
  type HarnessThreadOpenContext
} from '@openagent/contracts'
import {
  createAgentOpenContext,
  type TestAgentChange
} from '@openagent/test-kit'

const fixture = resolve(import.meta.dirname, '../../../apps/desktop/tests/fixtures/fake-codex-app-server.mjs')
const directories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('Codex Main regression coverage', () => {
  it.each([
    ['unsupported effort', 'low,medium,high', 'gpt-test', 'minimal', undefined, false],
    ['supported effort', 'minimal,high', 'gpt-test', 'minimal', 'minimal', false],
    ['empty capability list preserves open effort', ',', 'gpt-test', 'high', 'high', false],
    ['model absent preserves open effort', 'high', 'missing-model', 'xhigh', 'xhigh', false],
    ['catalog failure preserves open effort', 'high', 'gpt-test', 'ultra', 'ultra', true],
    ['empty capability list rejects minimal fallback', ',', 'gpt-test', 'minimal', undefined, false],
    ['catalog failure rejects minimal fallback', 'high', 'gpt-test', 'minimal', undefined, true]
  ] as const)(
    'filters turn/start effort against model capabilities: %s',
    async (_case, supportedEfforts, model, requestedEffort, expectedEffort, catalogFails) => {
      await chmod(fixture, 0o755)
      const directory = await temporaryDirectory('codex-effort-wire-')
      const logPath = join(directory, 'wire.jsonl')
      const server = new CodexAppServer(fixture, {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_MODEL_EFFORTS: supportedEfforts,
        ...(catalogFails ? { FAKE_CODEX_MODEL_LIST_ERROR: '1' } : {}),
        FAKE_CODEX_STATUS_STUCK: '1'
      })
      const signal = new AbortController().signal

      try {
        await server.startTurn({
          executionId: `execution-effort-${supportedEfforts}`,
          cwd: directory,
          inputs: [{ type: 'text', text: 'Check effort compatibility', text_elements: [] }],
          settings: { model, effort: requestedEffort },
          signal,

          emit: () => undefined
        })

        const wire = await readLog(logPath)
        const modelListIndex = wire.findIndex((message) => message.method === 'model/list')
        const turnStartIndex = wire.findIndex((message) => message.method === 'turn/start')
        expect(modelListIndex).toBeGreaterThanOrEqual(0)
        expect(turnStartIndex).toBeGreaterThan(modelListIndex)
        const turnStart = wire[turnStartIndex]
        expect(turnStart?.params).toMatchObject({ model })
        if (expectedEffort) expect(turnStart?.params?.effort).toBe(expectedEffort)
        else expect(turnStart?.params).not.toHaveProperty('effort')
      } finally {
        await server.dispose()
      }
    }
  )

  it('keeps CLI health available when model catalog discovery fails', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-presentation-catalog-')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({ ...process.env, FAKE_CODEX_MODEL_LIST_ERROR: '1' }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    await expect(plugin.settingsPresentation.load({
      settings: { threadSettings: {} },
      cwd: directory,
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      cli: {
        available: true,
        executable: fixture,
        version: 'fake-codex 0.150.1'
      },
      models: [],
      modelsError: 'model catalog unavailable'
    })
  })

  it('loads a Thread presentation from its pinned executable and cwd', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-presentation-pinned-')
    const executableA = await catalogExecutable(directory, 'codex-a.mjs', [{
      id: 'model-a-id',
      model: 'model-a',
      displayName: 'Model A',
      supportedReasoningEfforts: [],
      serviceTiers: []
    }])
    const executableB = await catalogExecutable(directory, 'codex-b.mjs', [{
      id: 'model-b-id',
      model: 'model-b',
      displayName: 'Model B',
      supportedReasoningEfforts: [],
      serviceTiers: []
    }])
    const calls: Array<readonly [string, string | undefined]> = []
    const plugin = createCodexMainPlugin({
      resolveExecutable: async (cwd, configuredPath) => {
        calls.push([cwd, configuredPath])
        // No Harness-level executable: the host auto-detects the default binary.
        if (configuredPath === undefined) return executableB
        if (configuredPath === '/pinned/codex-a') return executableA
        throw new Error(`unexpected Codex executable: ${String(configuredPath)}`)
      },
      environment: async () => ({ ...process.env }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    const signal = new AbortController().signal
    const harnessSettings = { threadSettings: {} }

    const globalPresentation = await plugin.settingsPresentation.load({
      settings: harnessSettings,
      cwd: directory,
      signal
    })
    const threadPresentation = await plugin.settingsPresentation.load({
      settings: harnessSettings,
      cwd: '/thread/pinned-cwd',
      thread: {
        settings: { executablePath: '/pinned/codex-a' }
      },
      signal
    })

    expect(globalPresentation.models.map((model) => model.value)).toEqual(['model-b'])
    expect(threadPresentation.models.map((model) => model.value)).toEqual(['model-a'])
    expect(calls).toEqual([
      [directory, undefined],
      ['/thread/pinned-cwd', '/pinned/codex-a']
    ])
    // A Harness-level executablePath cannot influence the resolved binary: it is
    // rejected outright, so the host still auto-detects instead of honouring it.
    await expect(plugin.settingsPresentation.load({
      settings: { threadSettings: { executablePath: '/global/codex-b' } },
      cwd: directory,
      signal
    })).rejects.toThrow(/executablePath/)
    expect(calls).toEqual([
      [directory, undefined],
      ['/thread/pinned-cwd', '/pinned/codex-a']
    ])
    await plugin.dispose?.()
  })

  it('isolates application-tools-only CODEX_HOME and restricts the native model catalog', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-application-tools-only-')
    const sourceHome = join(directory, 'source-home')
    const dataRoot = join(directory, 'session-state')
    const logPath = join(directory, 'wire.jsonl')
    await mkdir(sourceHome, { recursive: true })
    await writeFile(join(sourceHome, 'auth.json'), '{"token":"fake-auth"}')
    await writeFile(join(sourceHome, 'config.toml'), '[features]\nshell_tool = true\n')
    const runtime = new CodexRuntime({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        CODEX_HOME: sourceHome,
        FAKE_CODEX_LOG: logPath
      }),
      dataRoot,
      temporaryWorkspaceRoot: directory
    })
    const acquired = await runtime.server(
      directory,
      undefined,
      new AbortController().signal,
      'prompt'
    )
    const isolationRoot = join(dataRoot, 'application-tools-only')
    const [sessionName] = await readdir(isolationRoot)
    expect(sessionName).toMatch(/^session-/)
    const isolatedHome = join(isolationRoot, sessionName!)

    try {
      expect((await stat(isolationRoot)).mode & 0o777).toBe(0o700)
      expect((await stat(isolatedHome)).mode & 0o777).toBe(0o700)
      // The runtime reports native configuration, so the isolated home carries
      // the inherited subset alongside auth and the restricted catalog.
      expect((await readdir(isolatedHome)).sort())
        .toEqual(['auth.json', 'config.toml', 'models.json'])
      expect(await readFile(join(isolatedHome, 'config.toml'), 'utf8'))
        .toBe('"approvals_reviewer" = "user"\n')
      expect((await stat(join(isolatedHome, 'config.toml'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(isolatedHome, 'auth.json'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(isolatedHome, 'models.json'))).mode & 0o777).toBe(0o600)
      expect(await readFile(join(isolatedHome, 'auth.json'), 'utf8')).toBe('{"token":"fake-auth"}')
      expect(JSON.parse(await readFile(join(isolatedHome, 'models.json'), 'utf8')))
        .toMatchObject({
          models: [{
            tool_mode: 'direct',
            shell_type: 'disabled',
            apply_patch_tool_type: null,
            supports_search_tool: false
          }]
        })

      await acquired.server.listModels(new AbortController().signal)
      const launch = (await readLog(logPath)).findLast((message) => Array.isArray(message.argv))
      expect(launch?.argv).toEqual([
        '-c',
        `model_catalog_json=${JSON.stringify(join(isolatedHome, 'models.json'))}`,
        'app-server',
        '--listen',
        'stdio://'
      ])
    } finally {
      await acquired.server.dispose()
    }
    expect(await readdir(isolationRoot)).toEqual([])
  })

  it('uses a provider key without reading native login material in exclusive sessions', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-key-only-')
    const sourceHome = join(directory, 'source-home')
    // Reading this as a login file would fail; explicit provider mode must not touch it.
    await mkdir(join(sourceHome, 'auth.json'), { recursive: true })
    const dataRoot = join(directory, 'state')
    const runtime = new CodexRuntime({
      resolveExecutable: async () => fixture,
      environment: async () => ({ ...process.env, CODEX_HOME: sourceHome }),
      providerOverride: { provider: 'deepseek', apiKey: 'test-provider-key', baseUrl: 'http://127.0.0.1:12345', model: 'deepseek-v4-pro' },
      dataRoot, temporaryWorkspaceRoot: directory
    })
    const acquired = await runtime.server(directory, undefined, undefined, { toolMode: 'exclusive', threadId: 'key-only' })
    try {
      const isolationRoot = join(dataRoot, 'application-tools-only')
      const [home] = await readdir(isolationRoot)
      await expect(stat(join(isolationRoot, home!, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(isolationRoot, home!, 'config.toml'), 'utf8')).toContain('requires_openai_auth = false')
      expect(await readFile(join(isolationRoot, home!, 'config.toml'), 'utf8')).toContain('features.shell_snapshot = false')
    } finally { await acquired.server.dispose() }
  })

  it('preserves isolated exclusive-tool rollouts across disposal/reopen without retaining copied auth', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-exclusive-home-')
    const sourceHome = join(directory, 'source-home')
    const dataRoot = join(directory, 'session-state')
    await mkdir(sourceHome)
    await writeFile(join(sourceHome, 'auth.json'), '{"token":"test-auth-one"}')
    await writeFile(join(sourceHome, 'config.toml'), '[mcp_servers.private]\ncommand="private"\n')
    const context = {
      resolveExecutable: async () => fixture,
      environment: async () => ({ ...process.env, CODEX_HOME: sourceHome }),
      dataRoot,
      temporaryWorkspaceRoot: directory
    }
    const owner = { toolMode: 'exclusive' as const, threadId: 'bart-thread-a' }
    const first = await new CodexRuntime(context).server(directory, undefined, undefined, owner)
    const isolationRoot = join(dataRoot, 'application-tools-only')
    const [firstName] = await readdir(isolationRoot)
    const nativeHome = join(isolationRoot, firstName!)
    const rollout = join(nativeHome, 'sessions', 'rollout.jsonl')
    await mkdir(join(nativeHome, 'sessions'))
    await writeFile(rollout, 'durable native conversation\n')
    await first.server.dispose()
    expect(await readFile(rollout, 'utf8')).toBe('durable native conversation\n')
    await expect(stat(join(nativeHome, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(join(sourceHome, 'auth.json'), '{"token":"test-auth-two"}')
    const reopened = await new CodexRuntime(context).server(directory, undefined, undefined, owner)
    try {
      expect(await readdir(isolationRoot)).toEqual([firstName])
      expect(await readFile(join(nativeHome, 'auth.json'), 'utf8')).toBe('{"token":"test-auth-two"}')
      expect(await readFile(rollout, 'utf8')).toBe('durable native conversation\n')
      // Only the inherited native subset is copied: the source home's private
      // MCP server configuration must not reach the exclusive-tools home.
      expect(await readFile(join(nativeHome, 'config.toml'), 'utf8'))
        .toBe('"approvals_reviewer" = "user"\n')

      const other = await new CodexRuntime(context).server(directory, undefined, undefined, {
        toolMode: 'exclusive', threadId: 'bart-thread-b'
      })
      try {
        const otherName = (await readdir(isolationRoot)).find(name => name !== firstName)!
        await expect(stat(join(isolationRoot, otherName, 'sessions')))
          .rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await other.server.dispose()
      }
    } finally {
      await reopened.server.dispose()
    }

    // Failure while refreshing credentials cannot delete the saved rollout.
    await rm(join(sourceHome, 'auth.json'))
    await mkdir(join(sourceHome, 'auth.json'))
    await expect(new CodexRuntime(context).server(directory, undefined, undefined, owner))
      .rejects.toThrow()
    expect(await readFile(rollout, 'utf8')).toBe('durable native conversation\n')
  })

  it('describes GUI catalog examples without an evaluation prerequisite', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-live-settings-')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_MODELS_JSON: JSON.stringify(fakeCatalogModels()),
        FAKE_CODEX_APPROVALS_SUPPORTED: '1'
      }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    const settings = { threadSettings: {} }
    const signal = new AbortController().signal
    try {
      const description = await plugin.settings.describe({ settings, cwd: directory, signal })
      const presentation = await plugin.settingsPresentation.load({ settings, cwd: directory, signal })
      expect(description).toMatchObject({
        additionalProperties: false,
        properties: {
          model: { examples: presentation.models.map(model => model.value) },
          effort: { examples: ['low', 'ultra'] },
          serviceTier: { examples: ['default', 'priority'] },
          permissionMode: { enum: ['ask-for-approval', 'approve-for-me', 'full-access'] }
        }
      })
      // No permission preset: resolution injects the approve-for-me defaults.
      await expect(plugin.settings.resolveThreadSettings({
        merged: { model: 'model-b' }, requested: { model: 'model-b' },
        cwd: directory, sessionState: null, signal
      })).resolves.toEqual({
        model: 'model-b', sandbox: 'workspace-write',
        approvalPolicy: 'on-request', approvalsReviewer: 'auto_review'
      })
      await expect(plugin.settings.resolveThreadSettings({
        merged: { model: 'model-b', effort: 'ultra' },
        requested: { model: 'model-b', effort: 'ultra' },
        cwd: directory, sessionState: null, signal
      })).rejects.toThrow(/model-b.*ultra/)
      await expect(plugin.settings.resolveThreadSettings({
        merged: { model: 'unknown-model' }, requested: { model: 'unknown-model' },
        cwd: directory, sessionState: null, signal
      })).rejects.toThrow(/unknown-model/)
      expect(plugin).not.toHaveProperty('bart')
      expect(plugin).not.toHaveProperty('openBartThread')
    } finally {
      await plugin.dispose?.()
    }
  })

  it('allows native choices from an alternate executable that are absent from the description environment', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-settings-environments-')
    const executableA = await catalogExecutable(directory, 'codex-a.mjs', [{
      id: 'model-a-id', model: 'model-a', displayName: 'Model A', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      serviceTiers: [{ id: 'default', name: 'Default' }]
    }])
    const executableB = await catalogExecutable(directory, 'codex-b.mjs', [{
      id: 'model-b-id', model: 'model-b', displayName: 'Model B', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
      serviceTiers: [{ id: 'flex', name: 'Flex' }]
    }])
    const plugin = createCodexMainPlugin({
      resolveExecutable: async (_cwd, configuredPath) => configuredPath ?? executableA,
      environment: async () => ({ ...process.env, FAKE_CODEX_APPROVALS_SUPPORTED: '1' }),
      dataRoot: directory, temporaryWorkspaceRoot: directory
    })
    // The Harness cannot pin an executable; the host auto-detects A here.
    const settings = { threadSettings: {} }
    const requested = { model: 'model-b', effort: 'high', serviceTier: 'flex' }
    const signal = new AbortController().signal
    try {
      const description = await plugin.settings.describe({ settings, cwd: directory, signal })
      const targetPresentation = await plugin.settingsPresentation.load({
        settings, thread: { settings: { executablePath: executableB, ...requested } }, cwd: directory, signal
      })
      expect(targetPresentation.models).toMatchObject([{
        value: 'model-b', supportedReasoningEfforts: [{ value: 'high' }], serviceTiers: [{ value: 'flex' }]
      }])
      // A Thread pins its own binary, so the resolved settings keep B.
      await expect(plugin.settings.resolveThreadSettings({
        merged: { executablePath: executableB, ...requested },
        requested, cwd: directory, sessionState: null, signal
      })).resolves.toEqual({
        executablePath: executableB, ...requested, sandbox: 'workspace-write',
        approvalPolicy: 'on-request', approvalsReviewer: 'auto_review'
      })

      // A catalog observed for executable A cannot forbid valid target-B choices.
      const properties = description.properties as Record<string, unknown>
      for (const field of ['model', 'effort', 'serviceTier']) {
        expect(properties[field]).not.toHaveProperty('enum')
        expect(properties[field]).not.toHaveProperty('const')
        expect(properties[field]).toMatchObject({ type: 'string' })
      }
      expect(description.allOf).toBeUndefined()
      expect(properties).toMatchObject({
        model: { examples: ['model-a'] },
        effort: { examples: ['low'] },
        serviceTier: { examples: ['default'] },
        permissionMode: { enum: ['ask-for-approval', 'approve-for-me', 'full-access'] }
      })

      // Actual target validation remains authoritative even though description is open.
      await expect(plugin.settings.resolveThreadSettings({
        merged: { executablePath: executableB, ...requested, effort: 'low' }, requested: { ...requested, effort: 'low' },
        cwd: directory, sessionState: null, signal
      })).rejects.toThrow(/model-b.*low/)
      await expect(plugin.settings.resolveThreadSettings({
        merged: { executablePath: executableB, ...requested, model: 'model-a' }, requested: { ...requested, model: 'model-a' },
        cwd: directory, sessionState: null, signal
      })).rejects.toThrow(/model-a/)
    } finally {
      await plugin.dispose?.()
    }
  })

  it('validates live model capabilities and clears inherited siblings on model changes', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-live-settings-')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_MODELS_JSON: JSON.stringify(fakeCatalogModels()),
        FAKE_CODEX_APPROVALS_SUPPORTED: '1'
      }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    const signal = new AbortController().signal
    await expect(plugin.settings.resolveThreadSettings({
      merged: {
        model: 'model-b',
        effort: 'ultra',
        serviceTier: 'priority'
      },
      requested: { model: 'model-b' },
      sessionState: null,
      cwd: directory,
      signal
    })).resolves.toEqual({
      model: 'model-b', sandbox: 'workspace-write',
      approvalPolicy: 'on-request', approvalsReviewer: 'auto_review'
    })
    await expect(plugin.settings.resolveThreadSettings({
      merged: { model: 'model-b', effort: 'ultra' },
      requested: { model: 'model-b', effort: 'ultra' },
      sessionState: null,
      cwd: directory,
      signal
    })).rejects.toThrow(/model-b.*ultra/)
    await expect(plugin.settings.applyThreadSettingsUpdate({
      current: { model: 'model-a', effort: 'ultra', serviceTier: 'priority' },
      defaults: {},
      update: { model: 'model-b' },
      hasContent: false,
      cwd: directory,
      signal
    })).resolves.toEqual({ model: 'model-b' })
    await expect(plugin.settings.applyThreadSettingsUpdate({
      current: { model: 'model-a', effort: 'ultra', serviceTier: 'priority' },
      defaults: {},
      update: { model: 'model-b', serviceTier: 'priority' },
      hasContent: false,
      cwd: directory,
      signal
    })).rejects.toThrow(/model-b.*priority/)
  })

  it('fails closed for explicit model settings when the live catalog is unavailable', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-live-settings-error-')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_MODEL_LIST_ERROR: '1'
      }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    await expect(plugin.settings.resolveThreadSettings({
      merged: { model: 'gpt-test' },
      sessionState: null,
      cwd: directory,
      signal: new AbortController().signal
    })).rejects.toThrow(/model catalog unavailable/)
  })

  it.each(['cancelled', 'interrupted'] as const)(
    'persists background item/completed status %s as cancelled',
    async (nativeStatus) => {
      await chmod(fixture, 0o755)
      const directory = await temporaryDirectory(`codex-background-${nativeStatus}-`)
      const plugin = createCodexMainPlugin({
        resolveExecutable: async () => fixture,
        environment: async () => ({
          ...process.env,
          FAKE_CODEX_BACKGROUND_TERMINAL: '1',
          FAKE_CODEX_BACKGROUND_STALE_AFTER_COMPLETION: '1',
          FAKE_CODEX_BACKGROUND_COMPLETION_STATUS: nativeStatus
        }),
        dataRoot: directory,
        temporaryWorkspaceRoot: directory
      })
      let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
        id: `thread-background-${nativeStatus}`,
        harnessId: 'codex',
        archived: false,
        revision: 0,
        title: 'Codex background status',
        tags: [],
        cwd: directory,
        settings: {},
        sessionState: null,
        observation: { latestExecution: null, backgroundWork: null },
        createdAt: 1,
        updatedAt: 1
      }
      const handle = await plugin.openThread(createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: (next) => { record = next }
      }))

      try {
        await handle.send({
          executionId: `execution-background-${nativeStatus}`,
          input: { parts: [{ kind: 'text', text: 'Start background work.' }] },
          signal: new AbortController().signal
        })
        await waitFor(() => {
          const state = decodeCodexState(record.sessionState)
          return state.turns[0]?.activities.some((activity) =>
            activity.id === 'background-command-1' && activity.status === 'cancelled' &&
              activity.detail === 'background complete'
          ) === true && state.backgroundTerminals.length === 0 &&
            record.observation.latestExecution?.status === 'completed' &&
            record.observation.backgroundWork === null
        })

        const state = decodeCodexState(record.sessionState)
        expect(state.turns[0]?.activities).toContainEqual(expect.objectContaining({
          id: 'background-command-1',
          status: 'cancelled',
          detail: 'background complete'
        }))
        expect(state.backgroundTerminals).toEqual([])
        expect(record.observation).toMatchObject({
          latestExecution: { status: 'completed' },
          backgroundWork: null
        })
      } finally {
        await handle.dispose()
      }
    }
  )

  it('retries background listing, persists authoritative work, and clears it on dispose', async () => {
    const { handle, readRecord, logPath } = await openFakeThread({
      FAKE_CODEX_BACKGROUND_TERMINAL: '1',
      FAKE_CODEX_BACKGROUND_LIST_FAILURES: '1',
      FAKE_CODEX_BACKGROUND_STAYS_RUNNING: '1'
    }, 'background-retry')
    try {
      await handle.send({
        executionId: 'execution-background-retry',
        input: { parts: [{ kind: 'text', text: 'Keep work in the background.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => {
        const record = readRecord()
        const state = decodeCodexState(record.sessionState)
        return record.observation.latestExecution?.status === 'completed' &&
          record.observation.backgroundWork?.status === 'running' &&
          state.backgroundTerminals.some((terminal) => terminal.id === 'background-command-1')
      })
    } finally {
      await handle.dispose()
    }
    const record = readRecord()
    const state = decodeCodexState(record.sessionState)
    expect(state.backgroundTerminals).toEqual([])
    expect(state.turns).toHaveLength(1)
    expect(state.turns[0]?.activities).toContainEqual(expect.objectContaining({
      id: 'background-command-1',
      status: 'cancelled'
    }))
    expect(record.observation.backgroundWork).toBeNull()
    expect((await readLog(logPath)).filter((message) => message.method === 'turn/start'))
      .toHaveLength(1)
  })

  it('claims a Core execution identity for an idle background-completion wake', async () => {
    const admissions: Array<{ executionId: string; publicStatus: string | undefined }> = []
    const { handle, readRecord, logPath } = await openFakeThread({
      FAKE_CODEX_BACKGROUND_TERMINAL: '1',
      FAKE_CODEX_BACKGROUND_WAKE_RESPONSE: '1'
    }, 'background-wake', () => 'public-background-execution', false, {
      wrapContext: context => ({
        ...context,
        executionAdmission: {
          admit: async executionId => {
            admissions.push({
              executionId,
              publicStatus: context.thread.read().observation.latestExecution?.status
            })
          }
        }
      })
    })
    try {
      await handle.send({
        executionId: 'foreground-execution',
        input: { parts: [{ kind: 'text', text: 'Start background work.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => {
        const record = readRecord()
        const state = decodeCodexState(record.sessionState)
        return record.observation.latestExecution?.executionId ===
          'public-background-execution' &&
          record.observation.latestExecution.status === 'completed' &&
          state.turns.some((turn) =>
            turn.executionId === 'public-background-execution' &&
            turn.answer === 'BACKGROUND_WOKE_CODEX'
          )
      })
      const state = decodeCodexState(readRecord().sessionState)
      expect(state.turns.map((turn) => turn.executionId)).toEqual([
        'foreground-execution',
        'public-background-execution'
      ])
      expect(JSON.stringify(state)).not.toContain('native-background-execution')
      const turns = (await readLog(logPath)).filter((message) => message.method === 'turn/start')
      expect(turns).toHaveLength(2)
      expect(turns[1]?.params).toMatchObject({
        threadId: 'thread-1',
        input: [expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('<task-notification>')
        })]
      })
      expect(JSON.stringify(turns[1]?.params)).toContain('background complete')
      expect(admissions).toEqual([{
        executionId: 'public-background-execution',
        publicStatus: 'running'
      }])
    } finally {
      await handle.dispose()
    }
  })

  it('requeues a claimed wake when Core native admission fails before Codex starts', async () => {
    const admissions: string[] = []
    let sequence = 0
    const { handle, readRecord, logPath } = await openFakeThread({
      FAKE_CODEX_BACKGROUND_TERMINAL: '1',
      FAKE_CODEX_BACKGROUND_WAKE_RESPONSE: '1'
    }, 'background-admission-retry', () => `background-admission-${++sequence}`, false, {
      wrapContext: context => ({
        ...context,
        executionAdmission: {
          admit: async executionId => {
            admissions.push(executionId)
            if (admissions.length === 1) {
              throw new Error('Core rejected claimed Codex wake')
            }
          }
        }
      })
    })
    try {
      await handle.send({
        executionId: 'foreground-before-admission-retry',
        input: { parts: [{ kind: 'text', text: 'Start background work.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => {
        const execution = readRecord().observation.latestExecution
        return execution?.executionId === 'background-admission-2' &&
          execution.status === 'completed'
      })

      expect(admissions).toEqual([
        'background-admission-1',
        'background-admission-2'
      ])
      const state = decodeCodexState(readRecord().sessionState)
      expect(state.turns.find((turn) => turn.executionId === 'background-admission-1'))
        .toMatchObject({ status: 'failed', error: 'Core rejected claimed Codex wake' })
      expect(state.turns.find((turn) => turn.executionId === 'background-admission-2'))
        .toMatchObject({ status: 'completed', answer: 'BACKGROUND_WOKE_CODEX' })
      const nativeStarts = (await readLog(logPath)).filter(
        (message) => message.method === 'turn/start'
      )
      expect(nativeStarts).toHaveLength(2)
      expect(JSON.stringify(nativeStarts)).not.toContain('background-admission-1')
      expect(JSON.stringify(nativeStarts)).toContain('background-admission-2')
    } finally {
      await handle.dispose()
    }
  })

  it('steers background completion into the active public execution without claiming another identity', async () => {
    const { handle, readRecord, logPath } = await openFakeThread({
      FAKE_CODEX_BACKGROUND_TERMINAL: '1',
      FAKE_CODEX_BACKGROUND_STAYS_RUNNING: '1',
      FAKE_CODEX_BACKGROUND_ACTIVE_STEER: '1'
    }, 'background-active-steer', () => 'must-not-be-claimed')
    try {
      await handle.send({
        executionId: 'foreground-background-owner',
        input: { parts: [{ kind: 'text', text: 'Start background work.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() =>
        readRecord().observation.latestExecution?.status === 'completed' &&
        readRecord().observation.backgroundWork?.status === 'running'
      )
      await handle.send({
        executionId: 'active-public-execution',
        input: { parts: [{ kind: 'text', text: 'Wait for the background result.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => {
        const record = readRecord()
        const turn = decodeCodexState(record.sessionState).turns.find(
          (candidate) => candidate.executionId === 'active-public-execution'
        )
        return record.observation.latestExecution?.executionId === 'active-public-execution' &&
          record.observation.latestExecution.status === 'completed' &&
          turn?.answer === 'BACKGROUND_STEERED_CODEX'
      })
      const state = decodeCodexState(readRecord().sessionState)
      expect(state.turns.map((turn) => turn.executionId)).toEqual([
        'foreground-background-owner',
        'active-public-execution'
      ])
      expect(JSON.stringify(state)).not.toContain('must-not-be-claimed')
      const wire = await readLog(logPath)
      expect(wire.filter((message) => message.method === 'turn/start')).toHaveLength(2)
      expect(wire.find((message) => message.method === 'turn/steer')?.params).toMatchObject({
        threadId: 'thread-1',
        expectedTurnId: 'turn-2',
        input: [expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('<task-notification>')
        })]
      })
    } finally {
      await handle.dispose()
    }
  })

  it('retains a rejected active notification until the active turn ends, then claims an idle wake', async () => {
    const { handle, readRecord, logPath } = await openFakeThread({
      FAKE_CODEX_BACKGROUND_TERMINAL: '1',
      FAKE_CODEX_BACKGROUND_STAYS_RUNNING: '1',
      FAKE_CODEX_BACKGROUND_ACTIVE_STEER_REJECT: '1',
      FAKE_CODEX_BACKGROUND_WAKE_RESPONSE: '1'
    }, 'background-active-rejected', () => 'public-recovered-background-execution')
    try {
      await handle.send({
        executionId: 'background-owner-before-rejection',
        input: { parts: [{ kind: 'text', text: 'Start background work.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() =>
        readRecord().observation.latestExecution?.status === 'completed' &&
        readRecord().observation.backgroundWork?.status === 'running'
      )
      await handle.send({
        executionId: 'active-rejecting-notification',
        input: { parts: [{ kind: 'text', text: 'Keep this turn active.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => {
        const record = readRecord()
        return record.observation.latestExecution?.executionId ===
          'public-recovered-background-execution' &&
          record.observation.latestExecution.status === 'completed'
      })
      const state = decodeCodexState(readRecord().sessionState)
      expect(state.turns.map((turn) => turn.executionId)).toEqual([
        'background-owner-before-rejection',
        'active-rejecting-notification',
        'public-recovered-background-execution'
      ])
      const rejectedActive = state.turns[1]
      expect(JSON.stringify(rejectedActive?.messages)).not.toContain('<task-notification>')
      expect(JSON.stringify(rejectedActive?.notices)).not.toContain('未接受补充消息')
      const wire = await readLog(logPath)
      expect(wire.filter((message) => message.method === 'turn/steer')).toHaveLength(1)
      expect(wire.filter((message) => message.method === 'turn/start')).toHaveLength(3)
    } finally {
      await handle.dispose()
    }
  })

  it('does not redeliver a fast claimed wake when the public observation advances', async () => {
    let spoofNextRead = false
    const opened = await openFakeThread({
      FAKE_CODEX_BACKGROUND_TERMINAL: '1',
      FAKE_CODEX_BACKGROUND_WAKE_RESPONSE: '1',
      FAKE_CODEX_BACKGROUND_ABA_USER_TURN: '1'
    }, 'background-wake-aba', (() => {
      let sequence = 0
      return () => `public-background-aba-${++sequence}`
    })(), false, {
      onChange: change => {
        if (
          change.lifecycle?.type === 'terminal' &&
          change.lifecycle.executionId === 'public-background-aba-1'
        ) {
          spoofNextRead = true
        }
      },
      wrapContext: context => ({
        ...context,
        thread: {
          ...context.thread,
          read: () => {
            const record = context.thread.read()
            if (!spoofNextRead) return record
            spoofNextRead = false
            return {
              ...record,
              observation: {
                ...record.observation,
                latestExecution: {
                  executionId: 'new-user-execution',
                  startedAt: Date.now(),
                  status: 'running' as const
                }
              }
            }
          }
        }
      })
    })
    const { handle, readRecord, logPath } = opened
    try {
      await handle.send({
        executionId: 'foreground-before-aba',
        input: { parts: [{ kind: 'text', text: 'Start background work.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => {
        const execution = readRecord().observation.latestExecution
        return execution?.executionId === 'public-background-aba-1' &&
          execution.status === 'completed'
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect((await readLog(logPath)).filter((message) => message.method === 'turn/start'))
        .toHaveLength(2)
      expect(decodeCodexState(readRecord().sessionState).turns.map((turn) => turn.executionId))
        .toEqual(['foreground-before-aba', 'public-background-aba-1'])
    } finally {
      await handle.dispose()
    }
  })

  it('drops an idle native wake when Core refuses the execution claim', async () => {
    const { handle, readRecord, logPath } = await openFakeThread({
      FAKE_CODEX_BACKGROUND_TERMINAL: '1'
    }, 'background-claim-rejected', undefined, true)
    try {
      await handle.send({
        executionId: 'foreground-claim-rejected',
        input: { parts: [{ kind: 'text', text: 'Start background work.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => {
        const record = readRecord()
        const state = decodeCodexState(record.sessionState)
        return record.observation.latestExecution?.executionId === 'foreground-claim-rejected' &&
          record.observation.latestExecution.status === 'completed' &&
          record.observation.backgroundWork === null &&
          state.turns[0]?.activities.some((activity) =>
            activity.id === 'background-command-1' && activity.status === 'completed'
          ) === true
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(decodeCodexState(readRecord().sessionState).turns.map((turn) => turn.executionId))
        .toEqual(['foreground-claim-rejected'])
      expect((await readLog(logPath)).filter((message) => message.method === 'turn/start'))
        .toHaveLength(1)
    } finally {
      await handle.dispose()
    }
  })

  it('recovers final agent messages from turn.items without item/completed notifications', async () => {
    const { handle, readRecord } = await openFakeThread({
      FAKE_CODEX_FINAL_ITEMS_ONLY: '1'
    }, 'final-items')
    try {
      await handle.send({
        executionId: 'execution-final-items',
        input: { parts: [{ kind: 'text', text: 'Return two updates.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => readRecord().observation.latestExecution?.status === 'completed')
      const state = decodeCodexState(readRecord().sessionState)
      expect(state.turns[0]?.timeline.flatMap((item) =>
        item.kind === 'assistant' ? [item.content] : []
      )).toEqual(['First final-only answer.', 'Second final-only answer.'])
    } finally {
      await handle.dispose()
    }
  })

  it.each([false, true])('keeps paragraph boundaries across separate assistant items (native newlines: %s)', async (newlines) => {
    const { handle, readRecord } = await openFakeThread({
      FAKE_CODEX_SPLIT_MESSAGES: '1',
      ...(newlines ? { FAKE_CODEX_SPLIT_MESSAGE_NEWLINES: '1' } : {})
    }, 'split-messages')
    try {
      await handle.send({
        executionId: 'execution-split-messages',
        input: { parts: [{ kind: 'text', text: 'Return two updates.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => readRecord().observation.latestExecution?.status === 'completed')
      expect(decodeCodexState(readRecord().sessionState).turns[0]?.answer).toBe(
        'First update.\n\nSecond update.'
      )
    } finally {
      await handle.dispose()
    }
  })

  it('keeps every assistant item in Prompt Completion output', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-prompt-split-')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_SPLIT_MESSAGES: '1',
        FAKE_CODEX_SPLIT_MESSAGE_NEWLINES: '1'
      }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })

    await expect(plugin.prompt.complete({
      messages: [{ role: 'user', content: 'Return two updates.' }],
      outputFormat: { type: 'text' },
      signal: new AbortController().signal
    })).resolves.toEqual({
      output: { type: 'text', text: 'First update.\n\nSecond update.' },
      finishReason: 'stop'
    })
  })

  it('uses turn.items as the sole authoritative final for JSON Prompt output', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-prompt-revised-final-')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_FINAL_MESSAGE_REVISION: '1'
      }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })
    await expect(plugin.prompt.complete({
      messages: [{ role: 'user', content: 'Return final JSON.' }],
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
          additionalProperties: false
        }
      },
      signal: new AbortController().signal
    })).resolves.toEqual({
      output: { type: 'json', value: { status: 'final' } },
      finishReason: 'stop'
    })
  })

  it('serves Thread metadata Prompt Completion without interrupt-only fixture flags', async () => {
    await chmod(fixture, 0o755)
    const directory = await temporaryDirectory('codex-prompt-metadata-')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({ ...process.env }),
      dataRoot: directory,
      temporaryWorkspaceRoot: directory
    })

    try {
      await expect(plugin.prompt.complete({
        messages: [{
          role: 'user',
          content: '<thread_metadata_context>{"initialUserIntent":[]}</thread_metadata_context>'
        }],
        outputFormat: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'tags'],
            properties: {
              title: { type: 'string' },
              tags: { type: 'array' }
            }
          }
        },
        signal: new AbortController().signal
      })).resolves.toEqual({
        output: {
          type: 'json',
          value: {
            title: 'Codex task',
            tags: [{
              name: 'Codex',
              description: 'Work handled by the Codex Harness.'
            }]
          }
        },
        finishReason: 'stop'
      })
    } finally {
      await plugin.dispose?.()
    }
  })

  it('keeps every assistant item in Thread Read output', async () => {
    const { handle, readRecord } = await openFakeThread({
      FAKE_CODEX_SPLIT_MESSAGES: '1'
    }, 'split-read')
    try {
      await handle.send({
        executionId: 'execution-split-read',
        input: { parts: [{ kind: 'text', text: 'Create the primary session.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => readRecord().observation.latestExecution?.status === 'completed')
      await expect(handle.read(
        'Return two updates from the Thread.',
        new AbortController().signal
      )).resolves.toBe('First update.\n\nSecond update.')
    } finally {
      await handle.dispose()
    }
  })

  it('fills reasoning suffixes and command detail from streamed output', async () => {
    const { handle, readRecord, logPath } = await openFakeThread({
      FAKE_CODEX_COMPLETION_FALLBACKS: '1'
    }, 'completion-fallbacks')
    try {
      await handle.send({
        executionId: 'execution-completion-fallbacks',
        input: { parts: [{ kind: 'text', text: 'Exercise completion fallbacks.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => readRecord().observation.latestExecution?.status === 'completed')
      const turn = decodeCodexState(readRecord().sessionState).turns[0]
      expect(turn?.reasoning).toBe('Partial suffix')
      expect(turn?.activities).toContainEqual(expect.objectContaining({
        id: 'fallback-command-1',
        status: 'completed',
        detail: 'streamed command output'
      }))
      expect(decodeCodexState(readRecord().sessionState).turns).toHaveLength(1)
      expect((await readLog(logPath)).filter((message) => message.method === 'turn/start'))
        .toHaveLength(1)
    } finally {
      await handle.dispose()
    }
  })

  it('auto-cancels expiring native user input without inventing an answer', async () => {
    const { handle, readRecord, logPath } = await openFakeThread({
      FAKE_CODEX_AUTO_RESOLUTION_MS: '20'
    }, 'auto-resolution')
    try {
      await handle.send({
        executionId: 'execution-auto-resolution',
        input: { parts: [{ kind: 'text', text: 'Request expiring user input.' }] },
        signal: new AbortController().signal
      })
      await waitFor(() => readRecord().observation.latestExecution?.status === 'completed')
      expect((await readLog(logPath)).find((message) =>
        message.id === 'wire-nonblocking-input' && message.result
      )?.result).toEqual({ answers: {} })
      expect(decodeCodexState(readRecord().sessionState).turns[0]?.interactions)
        .toContainEqual(expect.objectContaining({ status: 'cancelled' }))
    } finally {
      await handle.dispose()
    }
  })

  it('coalesces one fixed window of 100 native deltas into one durable write', async () => {
    vi.useFakeTimers()
    const harness = await openBufferedDeltaHarness('delta-window')
    const baselineWrites = harness.stateWriteCount()

    for (let index = 0; index < 100; index += 1) {
      harness.emit({ type: 'text-delta', itemId: 'message-1', delta: 'x' })
    }
    await flushMicrotasks()
    expect(harness.stateWriteCount()).toBe(baselineWrites)

    await vi.advanceTimersByTimeAsync(49)
    await flushMicrotasks()
    expect(harness.stateWriteCount()).toBe(baselineWrites)

    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(harness.stateWriteCount() - baselineWrites).toBe(1)
    expect(latestCodexTurn(decodeCodexState(harness.readRecord().sessionState))?.answer)
      .toBe('x'.repeat(100))

    await harness.handle.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves separate native message identities across delta batching and finalization', async () => {
    vi.useFakeTimers()
    const harness = await openBufferedDeltaHarness('delta-identities')
    harness.emit({ type: 'text-delta', itemId: 'answer-a', delta: 'A' })
    harness.emit({ type: 'text-delta', itemId: 'answer-b', delta: 'B' })
    harness.emit({ type: 'text-delta', itemId: 'answer-a', delta: ' tail' })
    harness.emit({ type: 'text-final', itemId: 'answer-b', text: 'B final' })
    harness.emit({ type: 'text-final', itemId: 'answer-a', text: 'A final' })
    harness.emit({ type: 'done', outcome: 'completed' })

    await vi.waitFor(() => {
      expect(harness.readRecord().observation.latestExecution?.status).toBe('completed')
    })
    const turn = latestCodexTurn(decodeCodexState(harness.readRecord().sessionState))
    expect(turn?.status).toBe('completed')
    expect(turn?.timeline.filter((item) => item.kind === 'assistant')).toMatchObject([
      { itemId: 'answer-a', content: 'A final', status: 'complete' },
      { itemId: 'answer-b', content: 'B final', status: 'complete' }
    ])
    expect(turn?.answer).toBe('A final\n\nB final')
    await harness.handle.dispose()
  })

  it('flushes the final delta batch immediately at a native terminal boundary', async () => {
    vi.useFakeTimers()
    const harness = await openBufferedDeltaHarness('delta-terminal')
    harness.emit({ type: 'text-delta', itemId: 'message-1', delta: 'First ' })
    harness.emit({ type: 'text-delta', itemId: 'message-1', delta: 'complete tail.' })
    harness.emit({ type: 'reasoning-delta', delta: 'final reasoning' })
    harness.emit({ type: 'done', outcome: 'completed' })

    await flushMicrotasks()
    const turn = latestCodexTurn(decodeCodexState(harness.readRecord().sessionState))
    expect(harness.readRecord().observation.latestExecution?.status).toBe('completed')
    expect(turn?.answer).toBe('First complete tail.')
    expect(turn?.reasoning).toBe('final reasoning')
    const writesAtTerminal = harness.stateWriteCount()
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(100)
    await flushMicrotasks()
    expect(harness.stateWriteCount()).toBe(writesAtTerminal)
    await harness.handle.dispose()
  })

  it('drains buffered deltas on dispose and leaves no late timer write', async () => {
    vi.useFakeTimers()
    const harness = await openBufferedDeltaHarness('delta-dispose')
    harness.emit({ type: 'text-delta', itemId: 'message-1', delta: 'dispose tail' })
    harness.emit({ type: 'reasoning-delta', delta: 'dispose reasoning' })

    await harness.handle.dispose()
    const turn = latestCodexTurn(decodeCodexState(harness.readRecord().sessionState))
    expect(turn?.answer).toBe('dispose tail')
    expect(turn?.reasoning).toBe('dispose reasoning')
    expect(turn?.status).toBe('interrupted')
    const writesAtDispose = harness.stateWriteCount()
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(100)
    await flushMicrotasks()
    expect(harness.stateWriteCount()).toBe(writesAtDispose)
  })

  it('flushes deltas at interaction, respond, follow-up, read, and interrupt boundaries', async () => {
    vi.useFakeTimers()
    const harness = await openBufferedDeltaHarness('delta-boundaries')

    harness.emit({ type: 'text-delta', itemId: 'message-1', delta: 'interaction' })
    harness.emit({
      type: 'interaction-opened',
      interaction: {
        id: 'native-boundary-approval',
        kind: 'command-approval',
        title: 'Approve boundary test',
        blocksTurn: true,
        status: 'pending',
        actions: [{ id: 'allow-once', intent: 'allow', label: 'Allow once' }],
        questions: []
      }
    })
    await flushMicrotasks()
    expect(latestCodexTurn(decodeCodexState(harness.readRecord().sessionState))?.answer)
      .toBe('interaction')
    const waiting = harness.readRecord().observation.latestExecution
    if (waiting?.status !== 'waiting-for-user') throw new Error('expected public interaction')

    harness.emit({ type: 'text-delta', itemId: 'message-1', delta: '-respond' })
    await harness.handle.respond({
      interactionId: waiting.interactions[0]!.id,
      actionId: 'allow-once'
    })
    expect(latestCodexTurn(decodeCodexState(harness.readRecord().sessionState))?.answer)
      .toBe('interaction-respond')

    harness.emit({ type: 'text-delta', itemId: 'message-1', delta: '-follow-up' })
    await harness.handle.send({
      executionId: 'execution-delta-boundaries',
      input: { parts: [{ kind: 'text', text: 'Continue.' }] },
      signal: new AbortController().signal
    })
    expect(latestCodexTurn(decodeCodexState(harness.readRecord().sessionState))?.answer)
      .toBe('interaction-respond-follow-up')

    harness.emit({ type: 'text-delta', itemId: 'message-1', delta: '-read' })
    await expect(harness.handle.read(
      'Read without losing the primary stream.',
      new AbortController().signal
    )).resolves.toBe('auxiliary read answer')
    expect(latestCodexTurn(decodeCodexState(harness.readRecord().sessionState))?.answer)
      .toBe('interaction-respond-follow-up-read')

    harness.emit({ type: 'text-delta', itemId: 'message-1', delta: '-interrupt' })
    await harness.handle.interrupt()
    const terminal = latestCodexTurn(decodeCodexState(harness.readRecord().sessionState))
    expect(terminal?.answer).toBe('interaction-respond-follow-up-read-interrupt')
    expect(terminal?.status).toBe('interrupted')
    expect(vi.getTimerCount()).toBe(0)
    await harness.handle.dispose()
  })

  it('settles non-background activities by outcome and clears stale native activity', () => {
    let state = stageCodexExecution(
      createEmptyCodexState(1),
      'execution-state-settle',
      { parts: [{ kind: 'text', text: 'Run a command.' }] },
      2,
      'message-state-settle'
    )
    state = reduceCodexEvent(state, 'execution-state-settle', {
      type: 'activity-start',
      activity: {
        id: 'foreground-command',
        kind: 'command',
        label: 'false',
        status: 'running'
      }
    }, 3, 'event-state-settle')
    state = updateCodexNativeActivity(state, 'systemError', 'native failed', 4)
    const failed = settleCodexExecution(state, 'execution-state-settle', 'failed', 5, 'failed')
    expect(failed.nativeActivity).toBeUndefined()
    expect(failed.turns[0]?.activities).toContainEqual(expect.objectContaining({
      id: 'foreground-command',
      status: 'failed'
    }))
  })

  it('merges terminal retry into newer Session facts without changing the original finish time', async () => {
    vi.useFakeTimers()
    let terminalAttempts = 0
    let rejectedFinishedAt: number | undefined
    const harness = await openBufferedDeltaHarness('terminal-background-retry', {
      createExecutionId: () => { throw new Error('Core rejects background wake for this test') },
      onChange: change => {
        if (change.lifecycle?.type !== 'terminal' ||
          change.lifecycle.executionId !== 'retry-successor') return
        terminalAttempts += 1
        if (terminalAttempts !== 1) return
        rejectedFinishedAt = decodeCodexState(change.state).turns.at(-1)?.finishedAt
        throw new Error('reject terminal transaction')
      }
    })
    try {
      harness.emit({
        type: 'activity-start',
        activity: { id: 'older-background', kind: 'command', label: 'build', status: 'running' }
      })
      harness.emitNativeActivity({
        type: 'background-terminals',
        threadId: 'native-terminal-background-retry',
        at: Date.now(),
        terminals: [{ id: 'older-background', command: 'build', cwd: '/workspace' }]
      })
      await flushMicrotasks()
      harness.emit({ type: 'done', outcome: 'completed' })
      await flushMicrotasks()
      const olderFinishedAt = decodeCodexState(harness.readRecord().sessionState).turns[0]?.finishedAt
      expect(harness.readRecord().observation.backgroundWork).toEqual({ status: 'running' })

      await harness.handle.send({
        executionId: 'retry-successor',
        input: { parts: [{ kind: 'text', text: 'Next task.' }] },
        signal: new AbortController().signal
      })
      harness.emit({ type: 'done', outcome: 'completed' })
      await flushMicrotasks()
      expect(terminalAttempts).toBe(1)
      expect(harness.readRecord().observation.latestExecution?.status).toBe('running')
      expect(decodeCodexState(harness.readRecord().sessionState).turns.at(-1)?.finishedAt)
        .toBeUndefined()

      const later = rejectedFinishedAt! + 100
      harness.emitNativeActivity({
        type: 'background-terminals', threadId: 'native-terminal-background-retry',
        terminals: [], at: later
      })
      harness.emitNativeActivity({
        type: 'background-activity-completed', threadId: 'native-terminal-background-retry',
        activityId: 'older-background', status: 'completed', detail: 'new background result',
        at: later + 1
      })
      harness.emitNativeActivity({
        type: 'status', threadId: 'native-terminal-background-retry',
        status: 'background-active', detail: 'new Session status', at: later + 2
      })
      await flushMicrotasks()
      expect(harness.readRecord().observation).toMatchObject({
        latestExecution: { executionId: 'retry-successor', status: 'running' },
        backgroundWork: null
      })

      await harness.handle.interrupt()
      const final = decodeCodexState(harness.readRecord().sessionState)
      expect(terminalAttempts).toBe(2)
      expect(final.turns[0]).toMatchObject({
        finishedAt: olderFinishedAt,
        activities: [{ id: 'older-background', status: 'completed', detail: 'new background result' }]
      })
      expect(final.turns.at(-1)).toMatchObject({
        executionId: 'retry-successor', status: 'completed', finishedAt: rejectedFinishedAt
      })
      expect(final.nativeActivity).toMatchObject({
        status: 'background-active', detail: 'new Session status'
      })
      expect(harness.readRecord().observation).toMatchObject({
        latestExecution: {
          executionId: 'retry-successor', status: 'completed', finishedAt: rejectedFinishedAt
        },
        backgroundWork: null
      })
    } finally {
      await harness.handle.dispose()
    }
  })
})

interface WireMessage {
  readonly id?: number | string
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: unknown
  readonly argv?: readonly string[]
}

async function readLog(path: string): Promise<WireMessage[]> {
  const text = await readFile(path, 'utf8')
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as WireMessage)
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function openBufferedDeltaHarness(suffix: string, options?: {
  readonly onChange?: (change: TestAgentChange) => void | Promise<void>
  readonly createExecutionId?: () => string
}): Promise<{
  readonly handle: HarnessThreadHandle
  readonly emit: (event: CodexNativeEvent) => void
  readonly emitNativeActivity: (event: CodexNativeActivityEvent) => void
  readonly readRecord: () => AgentThreadRecord<'codex', CodexThreadSettings>
  readonly stateWriteCount: () => number
}> {
  let emitEvent: ((event: CodexNativeEvent) => void) | undefined
  let emitNativeActivity: ((event: CodexNativeActivityEvent) => void) | undefined
  let nativeTerminal = false
  const primaryServer = {
    async startTurn(options: { readonly emit: (event: CodexNativeEvent) => void }) {
      emitEvent = options.emit
      options.emit({ type: 'session', sessionId: `native-${suffix}` })
      return {
        sessionId: `native-${suffix}`,
        steer: async () => undefined,
        cancel: async () => {
          if (nativeTerminal) return
          nativeTerminal = true
          options.emit({ type: 'done', outcome: 'interrupted' })
        }
      }
    },
    subscribeNativeActivity: (emit: (event: CodexNativeActivityEvent) => void) => {
      emitNativeActivity = emit
      return () => { emitNativeActivity = undefined }
    },
    respond: (interactionId: string) => {
      emitEvent?.({
        type: 'interaction-closed',
        interactionId,
        resolution: 'allowed'
      })
      return true
    },
    dispose: async () => undefined
  } as unknown as CodexAppServer
  const auxiliaryServer = {
    async startTurn(options: { readonly emit: (event: CodexNativeEvent) => void }) {
      options.emit({ type: 'session', sessionId: `auxiliary-${suffix}` })
      queueMicrotask(() => {
        options.emit({ type: 'text-delta', itemId: 'message-1', delta: 'auxiliary read answer' })
        options.emit({ type: 'done', outcome: 'completed' })
      })
      return {
        sessionId: `auxiliary-${suffix}`,
        steer: async () => undefined,
        cancel: async () => undefined
      }
    },
    dispose: async () => undefined
  } as unknown as CodexAppServer
  let serverAcquisitions = 0
  const runtime = {
    server: async () => ({
      executable: '/fake/codex',
      server: serverAcquisitions++ === 0 ? primaryServer : auxiliaryServer
    })
  } as unknown as CodexRuntime
  let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
    id: `thread-${suffix}`,
    harnessId: 'codex',
    archived: false,
    revision: 0,
    title: suffix,
    tags: [],
    cwd: '/fake/workspace',
    settings: {},
    sessionState: null,
    observation: { latestExecution: null, backgroundWork: null },
    createdAt: 1,
    updatedAt: 1
  }
  const changes: TestAgentChange[] = []
  const handle = await openCodexThread(runtime, createAgentOpenContext({
    sessionState: codexSessionState,
    getRecord: () => record,
    setRecord: (next) => { record = next },
    changes,
    ...(options?.onChange ? { onChange: options.onChange } : {}),
    ...(options?.createExecutionId ? { createExecutionId: options.createExecutionId } : {})
  }))
  await handle.send({
    executionId: `execution-${suffix}`,
    input: { parts: [{ kind: 'text', text: 'Stream many deltas.' }] },
    signal: new AbortController().signal
  })
  if (!emitEvent) throw new Error('fake Codex delta server was not started')
  return {
    handle,
    emit: event => {
      if (!emitEvent) throw new Error('fake Codex delta server was not started')
      emitEvent(event)
    },
    emitNativeActivity: event => {
      if (!emitNativeActivity) throw new Error('fake Codex native activity is not subscribed')
      emitNativeActivity(event)
    },
    readRecord: () => record,
    stateWriteCount: () => changes.filter(
      (change) => change.state !== undefined
    ).length
  }
}

async function flushMicrotasks(turns = 30): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

async function catalogExecutable(
  directory: string,
  name: string,
  models: readonly unknown[]
): Promise<string> {
  const executable = join(directory, name)
  const source = [
    '#!/usr/bin/env node',
    `process.env.FAKE_CODEX_MODELS_JSON = ${JSON.stringify(JSON.stringify(models))}`,
    `await import(${JSON.stringify(pathToFileURL(fixture).href)})`
  ].join('\n')
  await writeFile(executable, source, { mode: 0o755 })
  await chmod(executable, 0o755)
  return executable
}

async function openFakeThread(
  environment: Readonly<Record<string, string>>,
  suffix: string,
  createExecutionId?: () => string,
  rejectExecutionClaims = false,
  contextOptions?: {
    readonly onChange?: (change: TestAgentChange) => void | Promise<void>
    readonly wrapContext?: (
      context: HarnessThreadOpenContext<'codex', CodexThreadSettings>
    ) => HarnessThreadOpenContext<'codex', CodexThreadSettings>
  }
): Promise<{
  readonly handle: Awaited<ReturnType<ReturnType<typeof createCodexMainPlugin>['openThread']>>
  readonly readRecord: () => AgentThreadRecord<'codex', CodexThreadSettings>
  readonly logPath: string
}> {
  await chmod(fixture, 0o755)
  const directory = await temporaryDirectory(`codex-${suffix}-`)
  const logPath = join(directory, 'wire.jsonl')
  const plugin = createCodexMainPlugin({
    resolveExecutable: async () => fixture,
    environment: async () => ({ ...process.env, FAKE_CODEX_LOG: logPath, ...environment }),
    dataRoot: directory,
    temporaryWorkspaceRoot: directory
  })
  let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
    id: `thread-${suffix}`,
    harnessId: 'codex',
    archived: false,
    revision: 0,
    title: suffix,
    tags: [],
    cwd: directory,
    settings: {},
    sessionState: null,
    observation: { latestExecution: null, backgroundWork: null },
    createdAt: 1,
    updatedAt: 1
  }
  const openContext = createAgentOpenContext({
    sessionState: plugin.sessionState,
    getRecord: () => record,
    setRecord: (next) => { record = next },
    ...(createExecutionId ? { createExecutionId } : {}),
    ...(contextOptions?.onChange ? { onChange: contextOptions.onChange } : {})
  })
  const configuredContext = contextOptions?.wrapContext?.(openContext) ?? openContext
  const handle = await plugin.openThread(rejectExecutionClaims
    ? {
        ...configuredContext,
        executionClaims: {
          claim: () => { throw new Error('Core rejected native claim') }
        }
      }
    : configuredContext)
  return { handle, readRecord: () => record, logPath }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for fake Codex event')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function fakeCatalogModels(): unknown[] {
  return [
    {
      id: 'model-a-id',
      model: 'model-a',
      displayName: 'Model A',
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'ultra' }
      ],
      serviceTiers: [
        { id: 'default', name: 'Default' },
        { id: 'priority', name: 'Priority' }
      ]
    },
    {
      id: 'model-b-id',
      model: 'model-b',
      displayName: 'Model B',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      serviceTiers: [{ id: 'default', name: 'Default' }]
    }
  ]
}

vi.mock('@openagent/plugin-kit/bart/main', async importOriginal => ({
  ...await importOriginal<typeof import('@openagent/plugin-kit/bart/main')>(),
  acquireBartEvaluationSource: () => ({
    waitForBootstrap: async () => ({
      source: 'unavailable-test-evaluator', availability: 'unavailable', releases: []
    }),
    dispose: async () => {}
  })
}))
