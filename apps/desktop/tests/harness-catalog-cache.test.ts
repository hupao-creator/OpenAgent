import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCliAvailabilityProbe } from '@openagent/plugin-kit/main'
import { createCodexMainPlugin } from '../../../packages/harness-codex/src/main'
import { createClaudeCatalogSource } from '../../../packages/harness-claude/src/main/catalog'

const codexFixture = resolve('tests/fixtures/fake-codex-app-server.mjs')
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })))
})

describe('Native catalog caching', () => {
  it('answers repeated Codex settings reads from one native catalog', async () => {
    const cwd = await directory('codex-catalog-cache-')
    const log = join(cwd, 'boots.log')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => codexFixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: log,
        FAKE_CODEX_APPROVALS_SUPPORTED: '1',
        FAKE_CODEX_MODELS_JSON: JSON.stringify(codexModels())
      }),
      dataRoot: cwd,
      temporaryWorkspaceRoot: cwd
    })
    const settings = { threadSettings: {} }
    const signal = new AbortController().signal
    try {
      const description = await plugin.settings.describe({ settings, cwd, signal })
      const boots = await bootCount(log)
      expect(boots).toBeGreaterThan(0)

      // The same executable and workspace cannot describe differently twice, so
      // the second read must not boot the native server again.
      await expect(plugin.settings.describe({ settings, cwd, signal })).resolves.toEqual(description)
      expect(await bootCount(log)).toBe(boots)

      const presentation = await plugin.settingsPresentation.load({ settings, cwd, signal })
      const afterPresentation = await bootCount(log)
      await expect(plugin.settingsPresentation.load({ settings, cwd, signal }))
        .resolves.toEqual(presentation)
      expect(await bootCount(log)).toBe(afterPresentation)

      // The Refresh button asks for the catalog as it is now, so it must not be
      // answered with the copy the page already holds.
      await expect(plugin.settingsPresentation.load({ settings, cwd, signal, refresh: true }))
        .resolves.toEqual(presentation)
      expect(await bootCount(log)).toBeGreaterThan(afterPresentation)
    } finally {
      await plugin.dispose?.()
    }
  })

  it('keeps the newest Codex presentation when an older load lands last', async () => {
    const cwd = await directory('codex-presentation-order-')
    const log = join(cwd, 'boots.log')
    const environment = (models?: unknown[]): NodeJS.ProcessEnv => ({
      ...process.env,
      FAKE_CODEX_LOG: log,
      FAKE_CODEX_APPROVALS_SUPPORTED: '1',
      ...(models ? { FAKE_CODEX_MODELS_JSON: JSON.stringify(models) } : {})
    })
    let calls = 0
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => codexFixture,
      environment: async () => {
        calls += 1
        // The first load reaches the app-server first but its handshake is
        // held, so the second one answers while the first is still waiting.
        return calls === 1
          ? { ...environment(codexModels('older')), FAKE_CODEX_INITIALIZE_DELAY_MS: '400' }
          : environment(codexModels('newer'))
      },
      dataRoot: cwd,
      temporaryWorkspaceRoot: cwd
    })
    const input = { settings: { threadSettings: {} }, cwd, signal: new AbortController().signal }
    try {
      const older = plugin.settingsPresentation.load(input)
      await expect(plugin.settingsPresentation.load(input))
        .resolves.toMatchObject({ models: [{ displayName: 'newer' }] })
      await expect(older).resolves.toMatchObject({ models: [{ displayName: 'older' }] })
      // The next ordinary read must not replay the load that started first.
      await expect(plugin.settingsPresentation.load(input))
        .resolves.toMatchObject({ models: [{ displayName: 'newer' }] })
    } finally {
      await plugin.dispose?.()
    }
  })

  it('keeps a refreshed Codex presentation for the reads that follow it', async () => {
    const cwd = await directory('codex-refresh-cache-')
    const log = join(cwd, 'boots.log')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => codexFixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: log,
        FAKE_CODEX_APPROVALS_SUPPORTED: '1',
        FAKE_CODEX_MODELS_JSON: JSON.stringify(codexModels())
      }),
      dataRoot: cwd,
      temporaryWorkspaceRoot: cwd
    })
    const input = { settings: { threadSettings: {} }, cwd, signal: new AbortController().signal }
    try {
      await plugin.settingsPresentation.load(input)
      await plugin.settingsPresentation.load({ ...input, refresh: true })
      const afterRefresh = await bootCount(log)
      // The refresh is the newest truth about this workspace, so it is what the
      // reload that follows it has to be answered from.
      await expect(plugin.settingsPresentation.load(input)).resolves.toMatchObject({ models: [{ displayName: 'Model A' }] })
      expect(await bootCount(log)).toBe(afterRefresh)
    } finally {
      await plugin.dispose?.()
    }
  })

  it('refreshes the Codex validation catalog along with the presentation', async () => {
    const cwd = await directory('codex-refresh-catalog-')
    const log = join(cwd, 'boots.log')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => codexFixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: log,
        FAKE_CODEX_APPROVALS_SUPPORTED: '1',
        FAKE_CODEX_MODELS_JSON: JSON.stringify(codexModels('older'))
      }),
      dataRoot: cwd,
      temporaryWorkspaceRoot: cwd
    })
    const input = { settings: { threadSettings: {} }, cwd, signal: new AbortController().signal }
    try {
      await plugin.settings.describe(input)
      const afterDescribe = await bootCount(log)
      // A reader's refresh replaces the model list the page shows, so the list
      // that validation resolves against has to be replaced with it rather than
      // keeping the snapshot the refresh was meant to retire.
      await plugin.settingsPresentation.load({ ...input, refresh: true })
      const afterRefresh = await bootCount(log)
      expect(afterRefresh).toBeGreaterThan(afterDescribe)
      await plugin.settings.describe(input)
      expect(await bootCount(log)).toBeGreaterThan(afterRefresh)
    } finally {
      await plugin.dispose?.()
    }
  })

  it('answers Codex validation from the listing the presentation read', async () => {
    const cwd = await directory('codex-presentation-catalog-')
    const log = join(cwd, 'boots.log')
    let advertise = namedCodexModels('older')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => codexFixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: log,
        FAKE_CODEX_APPROVALS_SUPPORTED: '1',
        FAKE_CODEX_MODELS_JSON: JSON.stringify(advertise)
      }),
      dataRoot: cwd,
      temporaryWorkspaceRoot: cwd
    })
    const input = { settings: { threadSettings: {} }, cwd, signal: new AbortController().signal }
    try {
      // Validation reads the catalog first and keeps it for the window.
      await plugin.settings.describe(input)
      advertise = namedCodexModels('newer')
      const presentation = await plugin.settingsPresentation.load(input)
      expect(presentation.models.map(model => model.displayName)).toEqual(['newer'])
      const model = presentation.models[0]!.value
      // The page offered this model, so validation must resolve it rather than
      // reject it from the snapshot validation is still holding.
      await expect(plugin.settings.resolveThreadSettings({
        merged: {}, requested: { model }, sessionState: null, cwd, signal: input.signal
      })).resolves.toMatchObject({ model })
    } finally {
      await plugin.dispose?.()
    }
  })

  it('retires the Codex caches when the refresh dies before it resolves', async () => {
    const cwd = await directory('codex-refresh-unresolved-')
    const log = join(cwd, 'boots.log')
    let advertise = codexModels('older')
    let failResolve = false
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => {
        if (failResolve) throw new Error('codex is gone')
        return codexFixture
      },
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: log,
        FAKE_CODEX_APPROVALS_SUPPORTED: '1',
        FAKE_CODEX_MODELS_JSON: JSON.stringify(advertise)
      }),
      dataRoot: cwd,
      temporaryWorkspaceRoot: cwd
    })
    const input = { settings: { threadSettings: {} }, cwd, signal: new AbortController().signal }
    try {
      await plugin.settingsPresentation.load(input)
      await plugin.settings.describe(input)
      advertise = codexModels('restored')
      failResolve = true
      // The refresh dies where the cache key does not exist yet: it never learns
      // which executable the lists it meant to replace were about.
      await expect(plugin.settingsPresentation.load({ ...input, refresh: true })).resolves.toMatchObject({
        cli: { available: false }, models: []
      })
      failResolve = false
      await expect(plugin.settingsPresentation.load(input)).resolves.toMatchObject({
        models: [{ displayName: 'restored' }]
      })
      const afterPresentation = await bootCount(log)
      // Settings validation reads the same native catalog, so it has to have been
      // retired with the presentation rather than keeping the old models.
      await plugin.settings.describe(input)
      expect(await bootCount(log)).toBeGreaterThan(afterPresentation)
    } finally {
      await plugin.dispose?.()
    }
  })

  it('does not let a Codex presentation cache when a newer load died before it resolved', async () => {
    const cwd = await directory('codex-unresolved-order-')
    const log = join(cwd, 'boots.log')
    const release = deferred()
    let advertise = codexModels('older')
    let failResolve = false
    let environmentCalls = 0
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => {
        if (failResolve) throw new Error('codex is gone')
        return codexFixture
      },
      environment: async () => {
        environmentCalls += 1
        // The first load is still resolving when the newer one fails before the
        // key exists, so only the numbering taken at entry can fence it.
        if (environmentCalls === 1) await release.promise
        return {
          ...process.env,
          FAKE_CODEX_LOG: log,
          FAKE_CODEX_APPROVALS_SUPPORTED: '1',
          FAKE_CODEX_MODELS_JSON: JSON.stringify(advertise)
        }
      },
      dataRoot: cwd,
      temporaryWorkspaceRoot: cwd
    })
    const input = { settings: { threadSettings: {} }, cwd, signal: new AbortController().signal }
    try {
      const older = plugin.settingsPresentation.load(input)
      failResolve = true
      await expect(plugin.settingsPresentation.load(input)).resolves.toMatchObject({ cli: { available: false } })
      failResolve = false
      release.resolve()
      await expect(older).resolves.toMatchObject({ models: [{ displayName: 'older' }] })
      const afterBoth = await bootCount(log)
      advertise = codexModels('restored')
      await expect(plugin.settingsPresentation.load(input)).resolves.toMatchObject({
        models: [{ displayName: 'restored' }]
      })
      expect(await bootCount(log)).toBeGreaterThan(afterBoth)
    } finally {
      await plugin.dispose?.()
    }
  })

  it('orders Codex loads that name the same executable differently', async () => {
    const cwd = await directory('codex-presentation-identity-')
    const log = join(cwd, 'boots.log')
    let calls = 0
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => codexFixture,
      environment: async () => {
        calls += 1
        // One read lets the host detect the CLI while the other names the path
        // resolution returns. Both land on one cache entry, so only an ordering
        // kept per resolved identity stops the older one from taking it back.
        return calls === 1
          ? {
              ...process.env,
              FAKE_CODEX_LOG: log,
              FAKE_CODEX_APPROVALS_SUPPORTED: '1',
              FAKE_CODEX_MODELS_JSON: JSON.stringify(codexModels('older')),
              FAKE_CODEX_INITIALIZE_DELAY_MS: '400'
            }
          : {
              ...process.env,
              FAKE_CODEX_LOG: log,
              FAKE_CODEX_APPROVALS_SUPPORTED: '1',
              FAKE_CODEX_MODELS_JSON: JSON.stringify(codexModels('newer'))
            }
      },
      dataRoot: cwd,
      temporaryWorkspaceRoot: cwd
    })
    const detected = { settings: { threadSettings: {} }, cwd, signal: new AbortController().signal }
    const pinned = { ...detected, thread: { settings: { executablePath: codexFixture } } }
    try {
      const older = plugin.settingsPresentation.load(detected)
      await expect(plugin.settingsPresentation.load(pinned))
        .resolves.toMatchObject({ models: [{ displayName: 'newer' }] })
      await expect(older).resolves.toMatchObject({ models: [{ displayName: 'older' }] })
      const afterBoth = await bootCount(log)
      await expect(plugin.settingsPresentation.load(detected))
        .resolves.toMatchObject({ models: [{ displayName: 'newer' }] })
      expect(await bootCount(log)).toBe(afterBoth)
    } finally {
      await plugin.dispose?.()
    }
  })

  it('does not let a superseded Codex load hand its listing to validation', async () => {
    const cwd = await directory('codex-adopt-superseded-')
    const log = join(cwd, 'boots.log')
    let advertise = namedCodexModels('older')
    let slow = false
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => codexFixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: log,
        FAKE_CODEX_APPROVALS_SUPPORTED: '1',
        FAKE_CODEX_MODELS_JSON: JSON.stringify(advertise),
        ...(slow ? { FAKE_CODEX_INITIALIZE_DELAY_MS: '400' } : {})
      }),
      dataRoot: cwd,
      temporaryWorkspaceRoot: cwd
    })
    const input = { settings: { threadSettings: {} }, cwd, signal: new AbortController().signal }
    try {
      // Validation holds a snapshot of the listing as it stands.
      await plugin.settings.describe(input)
      slow = true
      const superseded = plugin.settingsPresentation.load(input)
      slow = false
      advertise = namedCodexModels('newer')
      await expect(plugin.settingsPresentation.load(input))
        .resolves.toMatchObject({ models: [{ displayName: 'newer' }] })
      // The superseded probe carries the listing the page has already moved on
      // from, and it lands last.
      await expect(superseded).resolves.toMatchObject({ models: [{ displayName: 'older' }] })
      // The page stopped offering the older list, so validation has to agree
      // with the page rather than with whichever probe finished last.
      await expect(plugin.settings.resolveThreadSettings({
        merged: {}, requested: { model: 'newer' }, sessionState: null, cwd, signal: input.signal
      })).resolves.toMatchObject({ model: 'newer' })
    } finally {
      await plugin.dispose?.()
    }
  })

  it('hands a detected Codex listing to a Thread that pinned the detected path', async () => {
    const cwd = await directory('codex-adopt-identity-')
    const log = join(cwd, 'boots.log')
    let advertise = namedCodexModels('older')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => codexFixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: log,
        FAKE_CODEX_APPROVALS_SUPPORTED: '1',
        FAKE_CODEX_MODELS_JSON: JSON.stringify(advertise)
      }),
      dataRoot: cwd,
      temporaryWorkspaceRoot: cwd
    })
    const detected = { settings: { threadSettings: {} }, cwd, signal: new AbortController().signal }
    // The Thread pinned the very path detection returns, which is a different
    // name from the one the undecided reader is asked under.
    const pinned = { merged: { executablePath: codexFixture }, sessionState: null, cwd, signal: detected.signal }
    try {
      await expect(plugin.settings.resolveThreadSettings({ ...pinned, requested: { model: 'older' } }))
        .resolves.toMatchObject({ model: 'older' })
      // The page has no executable pinned, auto-detects the same binary, and
      // reads the listing as it stands now.
      advertise = namedCodexModels('newer')
      await expect(plugin.settingsPresentation.load(detected))
        .resolves.toMatchObject({ models: [{ displayName: 'newer' }] })
      // The Thread reads under the path it stored, so the listing has to have
      // reached that name rather than only the one the page was asked with.
      // Answered from the stored snapshot, it names the model the page offers.
      await expect(plugin.settings.resolveThreadSettings({ ...pinned, requested: { model: 'newer' } }))
        .resolves.toMatchObject({ model: 'newer' })
    } finally {
      await plugin.dispose?.()
    }
  })

  it('retires a Codex validation load already in flight when the page reads its own list', async () => {
    const cwd = await directory('codex-adopt-in-flight-')
    const log = join(cwd, 'boots.log')
    const release = deferred()
    const loadStarted = deferred()
    const moved = namedCodexModels('older')
    const advertise = namedCodexModels('newer')
    let advertised = moved
    let boots = 0
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => codexFixture,
      environment: async () => {
        boots += 1
        // Read before anything waits: the listing a boot carries is the one the
        // workspace answered with when it was asked.
        const snapshot = {
          ...process.env,
          FAKE_CODEX_LOG: log,
          FAKE_CODEX_APPROVALS_SUPPORTED: '1',
          FAKE_CODEX_MODELS_JSON: JSON.stringify(advertised)
        }
        // Validation boots twice — the auto-review capability probe, then the
        // catalog load. The load is held here so it is still on its way when the
        // page reads the list that replaced it.
        if (boots === 2) {
          loadStarted.resolve()
          await release.promise
        }
        return snapshot
      },
      dataRoot: cwd,
      temporaryWorkspaceRoot: cwd
    })
    const input = { settings: { threadSettings: {} }, cwd, signal: new AbortController().signal }
    try {
      const inFlight = plugin.settings.resolveThreadSettings({
        merged: {}, requested: { model: 'older' }, sessionState: null, cwd, signal: input.signal
      })
      await loadStarted.promise
      advertised = advertise
      await expect(plugin.settingsPresentation.load(input))
        .resolves.toMatchObject({ models: [{ displayName: 'newer' }] })
      release.resolve()
      // The load that had been on its way carries the listing the page has
      // already moved past, and it lands after the page read its own.
      await expect(inFlight).resolves.toMatchObject({ model: 'older' })
      // Nothing was written for the page's listing to be stored next to, so
      // validation has to read the newer list rather than the older one that
      // finished last.
      await expect(plugin.settings.resolveThreadSettings({
        merged: {}, requested: { model: 'newer' }, sessionState: null, cwd, signal: input.signal
      })).resolves.toMatchObject({ model: 'newer' })
    } finally {
      await plugin.dispose?.()
    }
  })

  it('does not let an older Codex load repopulate what a dead refresh retired', async () => {
    const cwd = await directory('codex-refresh-identity-')
    const log = join(cwd, 'boots.log')
    const release = deferred()
    let advertise = codexModels('older')
    let failResolve = false
    let calls = 0
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => {
        if (failResolve) throw new Error('codex is gone')
        return codexFixture
      },
      environment: async () => {
        calls += 1
        const models = advertise
        // The read on the way is asking under the other name for this binary, so
        // the refresh's own retirement is the only thing that can stop it from
        // filling the cache the refresh just emptied.
        if (calls === 1) await release.promise
        return {
          ...process.env,
          FAKE_CODEX_LOG: log,
          FAKE_CODEX_APPROVALS_SUPPORTED: '1',
          FAKE_CODEX_MODELS_JSON: JSON.stringify(models)
        }
      },
      dataRoot: cwd,
      temporaryWorkspaceRoot: cwd
    })
    const detected = { settings: { threadSettings: {} }, cwd, signal: new AbortController().signal }
    const pinned = { ...detected, thread: { settings: { executablePath: codexFixture } } }
    try {
      const older = plugin.settingsPresentation.load(detected)
      advertise = codexModels('restored')
      failResolve = true
      await expect(plugin.settingsPresentation.load({ ...pinned, refresh: true }))
        .resolves.toMatchObject({ cli: { available: false }, models: [] })
      failResolve = false
      release.resolve()
      await expect(older).resolves.toMatchObject({ models: [{ displayName: 'older' }] })
      // The refresh retired this workspace before it died, and the read that was
      // on its way under another name for the same binary must not put its answer
      // back as the truth this workspace reads from.
      await expect(plugin.settingsPresentation.load(detected))
        .resolves.toMatchObject({ models: [{ displayName: 'restored' }] })
    } finally {
      await plugin.dispose?.()
    }
  })

  it('retries a Codex catalog that failed instead of pinning the failure', async () => {    const cwd = await directory('codex-catalog-retry-')
    const log = join(cwd, 'boots.log')
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => codexFixture,
      // A native catalog that reports no models at all.
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: log,
        FAKE_CODEX_MODELS_JSON: '[]'
      }),
      dataRoot: cwd,
      temporaryWorkspaceRoot: cwd
    })
    const input = { settings: { threadSettings: {} }, cwd, signal: new AbortController().signal }
    try {
      await expect(plugin.settings.describe(input)).rejects.toThrow()
      await expect(plugin.settings.describe(input)).rejects.toThrow()
      expect(await bootCount(log)).toBe(2)
    } finally {
      await plugin.dispose?.()
    }
  })

  it('answers repeated Claude settings reads from one native catalog', async () => {
    const cwd = await directory('claude-catalog-cache-')
    const log = join(cwd, 'boots.log')
    const executable = await claudeFixture(cwd, '[{"value":"opus","displayName":"Opus"}]')
    const source = createClaudeCatalogSource({
      resolveExecutable: async () => executable,
      environment: async () => ({ ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_FAIL: '0' })
    })
    const signal = new AbortController().signal
    const presentation = await source.load({ cwd, signal })
    expect(presentation).toMatchObject({
      cli: { status: 'available', executablePath: executable, version: '1.2.3' }
    })
    expect(presentation.models).toHaveLength(1)
    const boots = await bootCount(log)
    expect(boots).toBeGreaterThan(0)
    await expect(source.load({ cwd, signal })).resolves.toEqual(presentation)
    expect(await bootCount(log)).toBe(boots)
    // The Refresh button asks for the catalog as it is now, so it must not be
    // answered with the copy the page already holds.
    await expect(source.load({ cwd, signal, refresh: true })).resolves.toEqual(presentation)
    expect(await bootCount(log)).toBeGreaterThan(boots)
  })

  it('retries an unavailable Claude catalog instead of caching the failure', async () => {
    const cwd = await directory('claude-catalog-retry-')
    const log = join(cwd, 'boots.log')
    const executable = await claudeFixture(cwd)
    const source = createClaudeCatalogSource({
      resolveExecutable: async () => executable,
      environment: async () => ({ ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_FAIL: '1' })
    })
    const signal = new AbortController().signal
    // A broken installation has to report itself on every read: the message is
    // the only clue the user gets.
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({
      cli: { status: 'unavailable' }
    })
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({
      cli: { status: 'unavailable' }
    })
    expect(await bootCount(log)).toBe(2)
  })

  it('keeps a newer Claude catalog when an older load finishes last', async () => {
    const cwd = await directory('claude-catalog-order-')
    const log = join(cwd, 'boots.log')
    const executable = await claudeFixture(cwd)
    let calls = 0
    const source = createClaudeCatalogSource({
      resolveExecutable: async () => executable,
      environment: async () => {
        calls += 1
        // The first read starts before the second but its transport answers
        // late, so only an explicit ordering stops it from replacing the
        // fresher snapshot once it finally lands.
        return calls === 1
          ? { ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_MODELS_JSON: modelsJson('older'), CLAUDE_DELAY_MS: '400' }
          : { ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_MODELS_JSON: modelsJson('newer') }
      }
    })
    const signal = new AbortController().signal
    const older = source.load({ cwd, signal })
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({ models: [{ value: 'newer' }] })
    await expect(older).resolves.toMatchObject({ models: [{ value: 'older' }] })
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({ models: [{ value: 'newer' }] })
  })

  it('orders overlapping Claude loads by when they started, not when they resolved', async () => {
    const cwd = await directory('claude-catalog-start-order-')
    const log = join(cwd, 'boots.log')
    const executable = await claudeFixture(cwd)
    const release = deferred()
    let calls = 0
    const source = createClaudeCatalogSource({
      resolveExecutable: async () => executable,
      environment: async () => {
        calls += 1
        // Both calls miss the cache on purpose (both are refreshes), so the
        // first one is only stopped by its own start order. Numbering after
        // this await would hand the newer number to the slower, earlier call.
        if (calls === 1) {
          await release.promise
          return { ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_MODELS_JSON: modelsJson('older') }
        }
        return { ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_MODELS_JSON: modelsJson('newer') }
      }
    })
    const signal = new AbortController().signal
    const first = source.load({ cwd, signal, refresh: true })
    await expect(source.load({ cwd, signal, refresh: true }))
      .resolves.toMatchObject({ models: [{ value: 'newer' }] })
    release.resolve()
    await expect(first).resolves.toMatchObject({ models: [{ value: 'older' }] })
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({ models: [{ value: 'newer' }] })
  })

  it('retires the Claude snapshot a refresh replaces', async () => {
    const cwd = await directory('claude-catalog-refresh-')
    const log = join(cwd, 'boots.log')
    const executable = await claudeFixture(cwd, modelsJson('older'))
    let calls = 0
    const source = createClaudeCatalogSource({
      resolveExecutable: async () => executable,
      environment: async () => {
        calls += 1
        // The first read caches a usable catalog; by the refresh the CLI has
        // broken, so the refresh cannot replace it with anything.
        return calls === 1
          ? { ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_MODELS_JSON: modelsJson('older') }
          : { ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_FAIL: '1' }
      }
    })
    const signal = new AbortController().signal
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({ models: [{ value: 'older' }] })
    await expect(source.load({ cwd, signal, refresh: true })).resolves.toMatchObject({ cli: { status: 'unavailable' } })
    const afterRefresh = await bootCount(log)
    // Retirement is the point of the refresh: the models it just showed as gone
    // must not come back from the entry it was meant to replace.
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({ cli: { status: 'unavailable' }, models: [] })
    expect(await bootCount(log)).toBeGreaterThan(afterRefresh)
  })

  it('does not let an older Claude load take the cache back after a newer one failed', async () => {
    const cwd = await directory('claude-catalog-failed-order-')
    const log = join(cwd, 'boots.log')
    const executable = await claudeFixture(cwd)
    const release = deferred()
    let calls = 0
    const source = createClaudeCatalogSource({
      resolveExecutable: async () => executable,
      environment: async () => {
        calls += 1
        // The newer read fails, and a failure writes no snapshot of its own; the
        // older read that was already in flight must not fill the gap with its
        // answer simply because nothing else claimed the key.
        if (calls === 1) {
          await release.promise
          return { ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_MODELS_JSON: modelsJson('older') }
        }
        if (calls === 2) return { ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_FAIL: '1' }
        return { ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_MODELS_JSON: modelsJson('older') }
      }
    })
    const signal = new AbortController().signal
    const older = source.load({ cwd, signal })
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({ cli: { status: 'unavailable' } })
    release.resolve()
    await expect(older).resolves.toMatchObject({ models: [{ value: 'older' }] })
    const afterBoth = await bootCount(log)
    // Nothing was cached, so this read probes again rather than answering from
    // the snapshot the newer failed read already superseded.
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({ models: [{ value: 'older' }] })
    expect(await bootCount(log)).toBeGreaterThan(afterBoth)
  })

  it('retires the Claude snapshot when the refresh dies before it resolves', async () => {
    const cwd = await directory('claude-refresh-unresolved-')
    const log = join(cwd, 'boots.log')
    const executable = await claudeFixture(cwd)
    let advertise = modelsJson('older')
    let resolveCalls = 0
    const source = createClaudeCatalogSource({
      resolveExecutable: async () => {
        resolveCalls += 1
        // The refresh is the read that has to learn nothing here: it is the one
        // asking for the truth, and it dies before it knows whose truth.
        if (resolveCalls === 2) throw new Error('claude is gone')
        return executable
      },
      environment: async () => ({
        ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_MODELS_JSON: advertise
      })
    })
    const signal = new AbortController().signal
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({ models: [{ value: 'older' }] })
    advertise = modelsJson('restored')
    await expect(source.load({ cwd, signal, refresh: true })).resolves.toMatchObject({
      cli: { status: 'unavailable' }
    })
    const afterRefresh = await bootCount(log)
    // The refresh retired the models it set out to replace even though it failed,
    // so this read probes the restored CLI instead of replaying them.
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({ models: [{ value: 'restored' }] })
    expect(await bootCount(log)).toBeGreaterThan(afterRefresh)
  })

  it('does not let a Claude load cache when a newer one died before it resolved', async () => {
    const cwd = await directory('claude-unresolved-order-')
    const log = join(cwd, 'boots.log')
    const executable = await claudeFixture(cwd)
    const release = deferred()
    let advertise = modelsJson('older')
    let failResolve = false
    let environmentCalls = 0
    const source = createClaudeCatalogSource({
      resolveExecutable: async () => {
        if (failResolve) throw new Error('claude is gone')
        return executable
      },
      environment: async () => {
        environmentCalls += 1
        // The first read is still resolving when the newer one fails where the
        // cache key does not exist yet, so the newer failure is only visible in
        // the numbering taken at entry.
        if (environmentCalls === 1) await release.promise
        return { ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_MODELS_JSON: advertise }
      }
    })
    const signal = new AbortController().signal
    const older = source.load({ cwd, signal })
    failResolve = true
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({ cli: { status: 'unavailable' } })
    failResolve = false
    release.resolve()
    await expect(older).resolves.toMatchObject({ models: [{ value: 'older' }] })
    const afterBoth = await bootCount(log)
    advertise = modelsJson('restored')
    // The failed read superseded this one, so the answer it finally produced has
    // to be probed again rather than cached as the newest for the key.
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({ models: [{ value: 'restored' }] })
    expect(await bootCount(log)).toBeGreaterThan(afterBoth)
  })

  it('orders Claude loads that name the same executable differently', async () => {
    const cwd = await directory('claude-catalog-identity-')
    const log = join(cwd, 'boots.log')
    const executable = await claudeFixture(cwd)
    let calls = 0
    const source = createClaudeCatalogSource({
      resolveExecutable: async () => executable,
      environment: async () => {
        calls += 1
        // One read asks for the CLI by name and lets the host detect it, the
        // other names the path resolution returns. Both land on one cache entry,
        // so only an ordering kept per resolved identity stops the older one from
        // taking it back.
        return calls === 1
          ? { ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_MODELS_JSON: modelsJson('older'), CLAUDE_DELAY_MS: '400' }
          : { ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_MODELS_JSON: modelsJson('newer') }
      }
    })
    const signal = new AbortController().signal
    const older = source.load({ cwd, signal })
    await expect(source.load({ cwd, signal, executablePath: executable }))
      .resolves.toMatchObject({ models: [{ value: 'newer' }] })
    await expect(older).resolves.toMatchObject({ models: [{ value: 'older' }] })
    const afterBoth = await bootCount(log)
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({ models: [{ value: 'newer' }] })
    expect(await bootCount(log)).toBe(afterBoth)
  })

  it('does not let an older Claude load repopulate what a dead refresh retired', async () => {
    const cwd = await directory('claude-refresh-identity-')
    const log = join(cwd, 'boots.log')
    const executable = await claudeFixture(cwd)
    const release = deferred()
    let advertise = modelsJson('older')
    let failResolve = false
    let calls = 0
    const source = createClaudeCatalogSource({
      resolveExecutable: async () => {
        if (failResolve) throw new Error('claude is gone')
        return executable
      },
      environment: async () => {
        calls += 1
        const models = advertise
        // The read on the way is asking under the other name for this binary, so
        // the refresh's own retirement is the only thing that can stop it from
        // filling the cache the refresh just emptied.
        if (calls === 1) await release.promise
        return { ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_MODELS_JSON: models }
      }
    })
    const signal = new AbortController().signal
    const older = source.load({ cwd, signal })
    advertise = modelsJson('restored')
    failResolve = true
    await expect(source.load({ cwd, signal, executablePath: executable, refresh: true }))
      .resolves.toMatchObject({ cli: { status: 'unavailable' } })
    failResolve = false
    release.resolve()
    await expect(older).resolves.toMatchObject({ models: [{ value: 'older' }] })
    // The refresh retired this workspace before it died, and the read that was on
    // its way under another name for the same binary must not put its answer back
    // as the truth this workspace reads from.
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({ models: [{ value: 'restored' }] })
  })

  it('retries a Claude catalog that reports no models instead of caching the empty answer', async () => {
    const cwd = await directory('claude-catalog-empty-')
    const log = join(cwd, 'boots.log')
    // A CLI that answers but advertises nothing is read as unavailable by model
    // validation, so caching it would keep rejecting a selection that a later
    // account or CLI version would accept.
    const executable = await claudeFixture(cwd, '[]')
    const source = createClaudeCatalogSource({
      resolveExecutable: async () => executable,
      environment: async () => ({ ...process.env, CLAUDE_BOOT_LOG: log, CLAUDE_FAIL: '0' })
    })
    const signal = new AbortController().signal
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({
      cli: { status: 'available' }, models: []
    })
    await expect(source.load({ cwd, signal })).resolves.toMatchObject({
      cli: { status: 'available' }, models: []
    })
    expect(await bootCount(log)).toBe(2)
  })
})

describe('CLI availability caching', () => {
  it('reuses a verified CLI for later probes of the same executable', async () => {
    const launch = launchStub()
    const probe = createCliAvailabilityProbe<{ threadSettings: unknown }>(
      { resolveExecutable: async () => '/resolved/cli', environment: async () => ({}) },
      launch.spawn
    )
    const input = {
      settings: { threadSettings: {} },
      cwd: '/workspace',
      signal: new AbortController().signal
    }
    await expect(probe.probe(input)).resolves.toEqual({ available: true })
    // Leaving settings asks again about a binary whose presence cannot have
    // changed in between.
    await expect(probe.probe(input)).resolves.toEqual({ available: true })
    expect(launch.invocations).toEqual(['/resolved/cli'])
  })

  it('retries a CLI that does not run instead of pinning the failure', async () => {
    const launch = launchStub()
    launch.failing = true
    const probe = createCliAvailabilityProbe<{ threadSettings: unknown }>(
      { resolveExecutable: async () => '/resolved/cli', environment: async () => ({}) },
      launch.spawn
    )
    const input = {
      settings: { threadSettings: {} },
      cwd: '/workspace',
      signal: new AbortController().signal
    }
    await expect(probe.probe(input)).resolves.toMatchObject({ available: false })
    await expect(probe.probe(input)).resolves.toMatchObject({ available: false })
    expect(launch.invocations).toEqual(['/resolved/cli', '/resolved/cli'])
  })
})

function modelsJson(value: string): string {
  return JSON.stringify([{ value, displayName: value }])
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}

async function directory(prefix: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), prefix))
  directories.push(created)
  return created
}

/** One line per process start; the wire log adds further lines per message. */
async function bootCount(log: string): Promise<number> {
  const lines = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  return lines.filter((line) => {
    try {
      return JSON.parse(line)?.argv !== undefined
    } catch {
      return false
    }
  }).length
}

function codexModels(displayName = 'Model A'): unknown[] {
  return [{
    id: 'model-a-id',
    model: 'model-a',
    displayName,
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
    serviceTiers: [{ id: 'default', name: 'Default' }]
  }]
}

/** The same model under a distinct identity, so two listings can disagree. */
function namedCodexModels(name: string): unknown[] {
  return [{
    id: `${name}-id`,
    model: name,
    displayName: name,
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
    serviceTiers: [{ id: 'default', name: 'Default' }]
  }]
}

/** Records every process start so a reused catalog is observable. */
async function claudeFixture(directory: string, models = '[]'): Promise<string> {
  const executable = join(directory, 'claude-fixture')
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(process.env.CLAUDE_BOOT_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + String.fromCharCode(10))
if (process.env.CLAUDE_FAIL === '1') process.exit(1)
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line)
  if (value.type === 'control_request') setTimeout(() => process.stdout.write(JSON.stringify({
    type: 'control_response', response: {
      subtype: 'success', request_id: value.request_id,
      response: { models: JSON.parse(process.env.CLAUDE_MODELS_JSON || ${JSON.stringify(models)}), claudeVersion: '1.2.3' }
    }
  }) + String.fromCharCode(10)), Number(process.env.CLAUDE_DELAY_MS || 0))
})
`, { mode: 0o755 })
  await chmod(executable, 0o755)
  return executable
}

function launchStub(): {
  readonly invocations: string[]
  readonly spawn: typeof spawn
  failing: boolean
} {
  const invocations: string[] = []
  const stub = { invocations, failing: false, spawn: undefined as unknown as typeof spawn }
  stub.spawn = ((executable: string) => {
    invocations.push(executable)
    const closes: Array<(code: number) => void> = []
    setTimeout(() => { for (const close of closes) close(stub.failing ? 1 : 0) }, 0)
    return {
      stderr: { on: () => undefined },
      once(event: string, listener: (code: number) => void) {
        if (event === 'close') closes.push(listener)
      }
    }
  }) as unknown as typeof spawn
  return stub
}
