import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join, resolve, win32 } from 'node:path'
import { homedir } from 'node:os'
import spawn from 'cross-spawn'
import { HarnessExecutableNotFoundError } from '@openagent/contracts'
import {
  createDebugTrace,
  debugError,
  debugLog,
  getDebugContext,
  startDebugSpan,
  withDebugContext
} from '@openagent/plugin-kit/main'

type DebugContext = ReturnType<typeof createDebugTrace>

export class CliResolver {
  /** Headless acceptance supplies a closed snapshot instead of loading login-shell credentials. */
  constructor(private readonly suppliedEnvironment?: NodeJS.ProcessEnv) {}

  private environmentPromise?: Promise<NodeJS.ProcessEnv>
  private readonly executableCache = new Map<string, string>()
  private readonly pendingResolutions = new Map<string, Promise<string>>()

  private refreshingEnvironment?: Promise<void>
  private resolutionGeneration = 0

  /** A foreground discovery pass re-reads PATH and drops executable choices. */
  refreshEnvironment(): Promise<void> {
    if (this.refreshingEnvironment) return this.refreshingEnvironment
    this.environmentPromise = undefined
    this.resolutionGeneration += 1
    this.executableCache.clear()
    this.pendingResolutions.clear()
    this.refreshingEnvironment = this.environment().then(() => undefined).finally(() => {
      this.refreshingEnvironment = undefined
    })
    return this.refreshingEnvironment
  }

  async environment(): Promise<NodeJS.ProcessEnv> {
    const reused = this.environmentPromise !== undefined
    const span = withDebugContext(ensureDebugContext({}), () => startDebugSpan(
      'environment.load',
      { reusedCache: reused }
    ))
    if (!this.environmentPromise) {
      this.environmentPromise = withDebugContext(span.context, () =>
        this.loadShellEnvironment()
      )
    }
    return this.environmentPromise.then(environment => {
      // Each provider may customize its launch environment without changing
      // the cached shell snapshot used by other providers or discovery.
      span.end({ reusedCache: reused, variableCount: Object.keys(environment).length })
      return { ...environment }
    }, error => {
      debugError('environment.load.failed', error, { reusedCache: reused })
      span.fail(error, { reusedCache: reused })
      throw error
    })
  }

  async resolve(commandName: string, customPath?: string, cwd = process.cwd()): Promise<string> {
    const command = customPath?.trim() || commandName
    const cacheKey = cwd + '\0' + command
    const pending = this.pendingResolutions.get(cacheKey)
    const cached = this.executableCache.get(cacheKey)
    const span = withDebugContext(
      ensureDebugContext({}),
      () => startDebugSpan('cli.resolve', {
        command,
        reuse: pending ? 'pending' : cached ? 'cache-candidate' : 'miss'
      })
    )
    const resolution = pending ?? withDebugContext(span.context, () =>
      this.resolveExecutable(command, cacheKey, this.resolutionGeneration, cwd)
    )
    if (!pending) this.pendingResolutions.set(cacheKey, resolution)
    const tracked = resolution.then(result => {
      span.end({
        command,
        reuse: pending ? 'pending' : cached ? 'cache-candidate' : 'miss',
        resolved: true
      })
      return result
    }, error => {
      debugError('cli.resolve.failed', error, {
        command,
        reuse: pending ? 'pending' : cached ? 'cache-candidate' : 'miss'
      })
      span.fail(error, { command })
      throw error
    })
    if (pending) return tracked
    return tracked.finally(() => {
      // Failed lookups must remain retryable after the user installs a CLI.
      if (this.pendingResolutions.get(cacheKey) === resolution) this.pendingResolutions.delete(cacheKey)
    })
  }

  private async resolveExecutable(command: string, cacheKey: string, generation: number, cwd: string): Promise<string> {
    const cached = this.executableCache.get(cacheKey)
    if (cached && (await isExecutable(cached))) {
      debugLog('cli.resolve.cache-hit', { cacheKey, executablePath: cached })
      return cached
    }
    if (cached) {
      debugLog('cli.resolve.cache-stale', { cacheKey, executablePath: cached })
      this.executableCache.delete(cacheKey)
    }
    const environment = await this.environment()
    const executable = await this.findExecutable(command, environment, cwd)
    if (!executable) throw new HarnessExecutableNotFoundError(command)
    if (generation === this.resolutionGeneration) this.executableCache.set(cacheKey, executable)
    return executable
  }

  private async loadShellEnvironment(): Promise<NodeJS.ProcessEnv> {
    if (this.suppliedEnvironment) return cleanEnvironment({ ...this.suppliedEnvironment })
    if (process.platform === 'win32') return cleanEnvironment({ ...process.env })

    const shell = process.env.SHELL || '/bin/zsh'
    try {
      const loaded = await new Promise<NodeJS.ProcessEnv>((resolvePromise, reject) => {
        const child = spawn(shell, ['-ilc', 'env -0'], {
          env: process.env,
          stdio: ['ignore', 'pipe', 'ignore']
        })
        const chunks: Buffer[] = []
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          reject(new Error('读取登录 shell 环境超时'))
        }, 4000)

        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
        child.once('error', error => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          if (code !== 0) return reject(new Error('登录 shell 退出码 ' + String(code)))
          const environment: NodeJS.ProcessEnv = { ...process.env }
          for (const entry of Buffer.concat(chunks).toString('utf8').split('\0')) {
            const separator = entry.indexOf('=')
            if (separator > 0) environment[entry.slice(0, separator)] = entry.slice(separator + 1)
          }
          resolvePromise(environment)
        })
      })
      return cleanEnvironment(loaded)
    } catch (error) {
      // Keep the fallback silent for callers while recording why cold shell
      // discovery fell back. Environment values themselves stay out of logs.
      debugLog('environment.load.fallback', {
        reason: error instanceof Error ? error.message : String(error)
      })
      return cleanEnvironment({ ...process.env })
    }
  }

  private async findExecutable(command: string, environment: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
    const expanded = /^~[\\/]/.test(command) ? join(homedir(), command.slice(2)) : command
    if (isAbsolute(expanded) || expanded.includes('/') || expanded.includes('\\')) {
      const candidate = isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
      return (await isExecutable(candidate)) ? candidate : null
    }

    const extensions = executableExtensions(command, environment)
    const pathDelimiter = process.platform === 'win32' ? win32.delimiter : delimiter
    const pathValue = environmentValue(environment, 'PATH') || ''
    for (const rawDirectory of pathValue.split(pathDelimiter).filter(Boolean)) {
      const directory = unquotePathEntry(rawDirectory.trim())
      for (const extension of extensions) {
        for (const suffix of extensionVariants(extension)) {
          const candidate = join(directory, command + suffix)
          if (await isExecutable(candidate)) return candidate
        }
      }
    }
    return null
  }

}

function ensureDebugContext(fields: Partial<DebugContext>): DebugContext {
  const current = getDebugContext()
  return current.traceId
    ? { ...current, ...fields }
    : createDebugTrace(fields)
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    const metadata = await stat(path)
    return metadata.isFile() || metadata.isSymbolicLink()
  } catch {
    return false
  }
}

function cleanEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  deleteEnvironmentValue(environment, 'ELECTRON_RUN_AS_NODE')
  deleteEnvironmentValue(environment, 'NODE_OPTIONS')
  return {
    ...environment,
    TERM: 'dumb',
    NO_COLOR: '1',
    FORCE_COLOR: '0'
  }
}

function executableExtensions(
  command: string,
  environment: NodeJS.ProcessEnv
): string[] {
  if (process.platform !== 'win32') return ['']
  if (win32.extname(command)) return ['']
  const configured = environmentValue(environment, 'PATHEXT') || '.EXE;.CMD;.BAT;.COM'
  return [...new Set(configured
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`))]
}

function extensionVariants(extension: string): string[] {
  return [...new Set([extension, extension.toLowerCase(), extension.toUpperCase()])]
}

function unquotePathEntry(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  if (process.platform !== 'win32') return environment[name]
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() === name.toLowerCase() && value !== undefined) return value
  }
  return undefined
}

function deleteEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): void {
  if (process.platform !== 'win32') {
    delete environment[name]
    return
  }
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === name.toLowerCase()) delete environment[key]
  }
}
