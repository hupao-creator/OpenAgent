import { codexProviderInjectionConfig, codexProviderInjectionCatalog } from './provider-injection.js'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CodexAppServer } from './app-server.js'
import {
  debugDetail,
  debugEnvironmentSummary,
  debugError,
  debugFrame,
  debugLog,
  startDebugSpan
} from '../debug.js'
import type { ProviderInjection } from '@openagent/contracts'

export interface CodexMainContext {
  resolveExecutable(cwd: string, configuredPath?: string): Promise<string>
  readonly providers?: import('@openagent/contracts').HarnessProviderAccess
  environment(): Promise<NodeJS.ProcessEnv>
  readonly dataRoot: string
  readonly temporaryWorkspaceRoot: string
}

export type CodexRuntimeProfile =
  | 'standard'
  | 'prompt'
  | { readonly toolMode: 'exclusive'; readonly threadId: string }

const execFileAsync = promisify(execFile)

export class CodexRuntime {
  private readonly providerHomes = new Map<string, Promise<string>>()

  constructor(readonly context: CodexMainContext) {}

  async backend(cwd: string, signal: AbortSignal): Promise<import('@openagent/contracts').HarnessBackend> {
    if (this.context.providers?.explicit) return this.context.providers.explicit
    let server: CodexAppServer | undefined
    try {
      server = (await this.server(cwd, undefined, signal)).server
      const config = await server.readThreadConfiguration(cwd, signal)
      const environment = await this.context.environment()
      signal.throwIfAborted()
      const id = typeof config.model_provider === 'string' ? config.model_provider : 'openai'
      const configured = jsonRecord(jsonRecord(config.model_providers)[id])
      const baseUrl = typeof configured.base_url === 'string' ? configured.base_url : environment.OPENAI_BASE_URL
      const external = id !== 'openai' || baseUrl !== undefined || Boolean(environment.OPENAI_API_KEY)
      if (!external) return { kind: await server.hasNativeSubscription(signal) ? 'native' : 'unknown' }
      return this.context.providers?.resolve({ kind: 'external', baseUrl,
        apiKey: typeof configured.env_key === 'string' ? environment[configured.env_key] : undefined,
        model: typeof config.model === 'string' ? config.model : undefined
      }) ?? { kind: 'unknown' }
    } catch {
      signal.throwIfAborted()
      return { kind: 'unknown' }
    } finally { await server?.dispose() }
  }

  async server(
    cwd: string,
    configuredPath?: string,
    signal?: AbortSignal,
    profile: CodexRuntimeProfile = 'standard',
    debugPurpose = runtimeDebugPurpose(profile)
  ): Promise<{
    readonly executable: string
    readonly server: CodexAppServer
  }> {
    throwIfAborted(signal)
    const resolveSpan = startDebugSpan('codex.resolve-environment', {
      harnessId: 'codex',
      purpose: debugPurpose,
      cwd,
      ...(configuredPath ? { configuredPath } : {})
    })
    let executable: string
    let environment: NodeJS.ProcessEnv
    try {
      executable = await this.context.resolveExecutable(cwd, configuredPath)
      throwIfAborted(signal)
      environment = await this.context.environment()
      throwIfAborted(signal)
      resolveSpan.end({ executable, ...debugEnvironmentSummary(environment) })
    } catch (error) {
      resolveSpan.fail(error)
      debugError('codex.resolve-environment.error', error, {
        harnessId: 'codex',
        purpose: debugPurpose,
        cwd
      })
      throw error
    }
    debugLog('codex.transport.acquire', {
      harnessId: 'codex',
      purpose: debugPurpose,
      cwd,
      executable,
      profile: typeof profile === 'string' ? profile : profile.toolMode
    })
    const providerInjection = this.context.providers?.explicit?.injection
    throwIfAborted(signal)
    if (profile === 'standard') {
      const directory = providerInjection
        ? await this.ensureProviderHome(executable, environment, providerInjection)
        : undefined
      throwIfAborted(signal)
      const standardEnvironment = directory && providerInjection
        ? { ...environment, CODEX_HOME: directory, ...providerEnvironment(providerInjection) }
        : environment
      return {
        executable,
        server: new CodexAppServer(executable, standardEnvironment, { debugPurpose })
      }
    }
    if (typeof profile === 'object' && !profile.threadId.trim()) {
      throw new Error('Codex exclusive tools runtime 缺少所属 Thread id')
    }
    const launch = await exclusiveToolsLaunch(
      executable,
      environment,
      join(this.context.dataRoot, 'application-tools-only'),
      signal,
      typeof profile === 'object' ? profile.threadId : undefined,
      providerInjection,
      cwd
    )
    try {
      // Cancellation can arrive while the isolated home is being written.
      // No caller owns its cleanup until this acquisition returns a server.
      throwIfAborted(signal)
      return {
        executable,
        server: new CodexAppServer(executable, launch.environment, {
          configOverrides: launch.configOverrides,
          dispose: launch.dispose,
          debugPurpose
        })
      }
    } catch (error) {
      await launch.dispose()
      throw error
    }
  }

  private ensureProviderHome(
    executable: string,
    environment: NodeJS.ProcessEnv,
    env: ProviderInjection
  ): Promise<string> {
    const key = JSON.stringify([executable, env])
    let home = this.providerHomes.get(key)
    if (!home) {
      home = this.createProviderHome(executable, environment, env, key).catch((error) => {
        this.providerHomes.delete(key)
        throw error
      })
      this.providerHomes.set(key, home)
    }
    return home
  }

  private async createProviderHome(
    executable: string,
    environment: NodeJS.ProcessEnv,
    env: ProviderInjection,
    key: string
  ): Promise<string> {
    const directory = join(this.context.dataRoot, 'provider-override',
      createHash('sha256').update(key).digest('hex'))
    const { stdout } = await execFileAsync(executable, ['debug', 'models', '--bundled'], {
      env: environment,
      maxBuffer: 8 * 1024 * 1024
    })
    const catalog = codexProviderInjectionCatalog(jsonRecord(JSON.parse(stdout)), env)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const catalogPath = join(directory, 'models.json')
    await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 })
    await chmod(catalogPath, 0o600)
    const configPath = join(directory, 'config.toml')
    await writeFile(configPath, codexProviderInjectionConfig(env, catalogPath), { mode: 0o600 })
    await chmod(configPath, 0o600)
    return directory
  }
}

async function exclusiveToolsLaunch(
  executable: string,
  environment: NodeJS.ProcessEnv,
  dataRoot: string,
  signal?: AbortSignal,
  ownerThreadId?: string,
  providerInjection?: ProviderInjection,
  cwd?: string
): Promise<{
  readonly environment: NodeJS.ProcessEnv
  readonly configOverrides: readonly string[]
  readonly dispose: () => Promise<void>
}> {
  throwIfAborted(signal)
  const span = startDebugSpan('codex.catalog.probe', {
    harnessId: 'codex',
    purpose: 'application-tools-launch',
    executable,
    ownerThreadId: ownerThreadId || null
  })
  let stdout: string
  try {
    const result = await execFileAsync(
      executable,
      ['debug', 'models', ...(providerInjection ? ['--bundled'] : [])],
      {
        env: environment,
        ...(cwd ? { cwd } : {}),
        maxBuffer: 8 * 1024 * 1024,
        ...(signal ? { signal } : {})
      }
    )
    stdout = result.stdout
  } catch (error) {
    span.fail(error)
    debugError('codex.catalog.error', error, {
      harnessId: 'codex',
      purpose: 'application-tools-launch',
      executable
    })
    throw error
  }
  try {
    throwIfAborted(signal)
  } catch (error) {
    span.fail(error)
    throw error
  }
  let catalog: Record<string, unknown>
  try {
    catalog = jsonRecord(JSON.parse(stdout))
  } catch (error) {
    span.fail(error)
    debugError('codex.catalog.error', error, {
      harnessId: 'codex',
      purpose: 'application-tools-launch',
      executable,
      phase: 'parse'
    })
    throw error
  }
  debugDetail('codex.catalog.bundled-models', {
    harnessId: 'codex',
    purpose: 'application-tools-launch',
    catalog: debugFrame(catalog)
  })
  if (providerInjection) catalog = codexProviderInjectionCatalog(catalog, providerInjection)
  const models = Array.isArray(catalog.models) ? catalog.models : []
  span.end({ modelCount: models.length })
  if (models.length === 0) throw new Error('Codex bundled model catalog 为空')
  const restrictedCatalog = {
    ...catalog,
    models: models.map((value) => ({
      ...jsonRecord(value),
      tool_mode: 'direct',
      shell_type: 'disabled',
      apply_patch_tool_type: null,
      supports_search_tool: false
    }))
  }

  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  await chmod(dataRoot, 0o700)
  // A Thread native rollout must outlive its process. One-shot metadata
  // prompts still use disposable homes; neither profile imports user tools.
  const directory = ownerThreadId
    ? join(dataRoot, `thread-${createHash('sha256').update(ownerThreadId).digest('hex')}`)
    : await mkdtemp(join(dataRoot, 'session-'))
  const authTarget = join(directory, 'auth.json')
  const dispose = ownerThreadId
    ? async () => {
        await Promise.all([authTarget, join(directory, 'config.toml')]
          .map(path => rm(path, { force: true })))
      }
    : () => rm(directory, { recursive: true, force: true })
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const catalogPath = join(directory, 'models.json')
    await writeFile(catalogPath, JSON.stringify(restrictedCatalog), { mode: 0o600 })
    await chmod(catalogPath, 0o600)
    if (!providerInjection && cwd) {
      const source = new CodexAppServer(executable, environment, { debugPurpose: 'thread-configuration' })
      try {
        const nativeConfiguration = await source.readThreadConfiguration(cwd, signal)
        if (Object.keys(nativeConfiguration).length) {
          const configPath = join(directory, 'config.toml')
          await writeFile(configPath, Object.entries(nativeConfiguration)
            .map(([key, value]) => `${JSON.stringify(key)} = ${tomlValue(value)}`).join('\n') + '\n', { mode: 0o600 })
          await chmod(configPath, 0o600)
        } else {
          await rm(join(directory, 'config.toml'), { force: true })
        }
      } finally {
        await source.dispose()
      }
    }
    if (providerInjection) {
      const configPath = join(directory, 'config.toml')
      await writeFile(configPath, codexProviderInjectionConfig(providerInjection, catalogPath), { mode: 0o600 })
      await chmod(configPath, 0o600)
    }
    if (providerInjection) {
      // Explicit API-key execution must never import a native login session.
      await rm(authTarget, { force: true })
    } else {
      const sourceCodexHome = environment.CODEX_HOME?.trim() || join(homedir(), '.codex')
      const authSource = join(sourceCodexHome, 'auth.json')
      try {
        // Read before replacing the target. Reopens also create a fresh regular
        // auth file, without following a leftover target symlink.
        const auth = await readFile(authSource)
        await rm(authTarget, { force: true })
        await writeFile(authTarget, auth, { mode: 0o600, flag: 'wx' })
        await chmod(authTarget, 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await rm(authTarget, { force: true })
      }
    }
    return {
      environment: {
        ...environment,
        CODEX_HOME: directory,
        ...(providerInjection
          ? { ...providerEnvironment(providerInjection) }
          : {})
      },
      configOverrides: [`model_catalog_json=${JSON.stringify(catalogPath)}`],
      dispose
    }
  } catch (error) {
    // A failed reopen must never remove an existing native conversation.
    await dispose()
    throw error
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
}

function runtimeDebugPurpose(profile: CodexRuntimeProfile): string {
  if (profile === 'standard') return 'thread'
  if (profile === 'prompt') return 'prompt'
  return 'thread'
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).filter(([, child]) => child !== null && child !== undefined)
      .map(([key, child]) => `${JSON.stringify(key)} = ${tomlValue(child)}`).join(', ')} }`
  }
  throw new Error('Codex native Thread configuration is not representable in TOML')
}

function providerEnvironment(value: ProviderInjection): Readonly<Record<string, string>> {
  return value.environment
}
