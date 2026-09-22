import spawn from 'cross-spawn'
import { HarnessExecutableNotFoundError } from '@openagent/contracts'
import { debugLog } from './debug.js'

type ResolveExecutable = (cwd: string, configuredPath?: string) => Promise<string>
type CodexVersion = readonly [number, number, number, readonly (string | number)[] | undefined]

/**
 * The first candidate is the CLI on PATH. An installed CLI and the ChatGPT
 * desktop bundle may have a newer app-server catalog than that CLI. Select one
 * executable for both model/list and thread execution, so the models we show
 * are also usable by a new thread. A thread's pinned path is never replaced.
 */
export function createCodexExecutableResolver(
  resolve: ResolveExecutable,
  environment: () => Promise<NodeJS.ProcessEnv>,
  alternativePaths: readonly string[]
): ResolveExecutable {
  return async (cwd, configuredPath) => {
    const configured = configuredPath?.trim()
    if (configured && configured !== 'codex') return resolve(cwd, configuredPath)

    const paths: string[] = []
    let primaryError: unknown
    let alternativeError: unknown
    try {
      paths.push(await resolve(cwd))
    } catch (error) {
      if (!(error instanceof HarnessExecutableNotFoundError)) throw error
      primaryError = error
    }

    for (const alternative of alternativePaths) {
      try {
        const path = await resolve(cwd, alternative)
        if (!paths.includes(path)) paths.push(path)
      } catch (error) {
        // A missing optional installation must not mask a working PATH CLI.
        if (!(error instanceof HarnessExecutableNotFoundError)) {
          alternativeError ??= error
          debugLog('codex.executable.alternative-failed', { path: alternative })
        }
      }
    }

    if (paths.length === 0) throw alternativeError || primaryError || new HarnessExecutableNotFoundError('codex')
    if (paths.length === 1) return paths[0]

    const env = await environment()
    const versions = await Promise.all(paths.map(path => codexVersion(path, env)))
    let selected = 0
    for (let index = 1; index < paths.length; index += 1) {
      const current = versions[selected]
      const candidate = versions[index]
      if ((candidate && current && compareVersions(candidate, current) > 0) ||
          (candidate && !current && primaryError)) selected = index
    }
    debugLog('codex.executable.selected', {
      executablePath: paths[selected],
      candidateCount: paths.length
    })
    return paths[selected]
  }
}

async function codexVersion(path: string, environment: NodeJS.ProcessEnv): Promise<CodexVersion | undefined> {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      // cross-spawn also runs npm's codex.cmd shim on Windows. execFile does
      // not, which would leave a working PATH CLI with an unknown version.
      const child = spawn(path, ['--version'], {
        env: environment,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      })
      let stdout = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('Codex version probe timed out'))
      }, 3_000)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString('utf8')).slice(0, 1_024)
      })
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout)
        else reject(new Error(`Codex version probe exited with ${String(code)}`))
      })
    })
    const match = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\s*$/.exec(output.trim())
    if (!match) return undefined
    return [Number(match[1]), Number(match[2]), Number(match[3]),
      match[4]?.split('.').map(part => /^\d+$/.test(part) ? Number(part) : part)]
  } catch {
    return undefined
  }
}

function compareVersions(a: CodexVersion, b: CodexVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Number(a[index]) - Number(b[index])
  }
  const aPre = a[3]
  const bPre = b[3]
  if (!aPre || !bPre) return aPre ? -1 : bPre ? 1 : 0
  for (let index = 0; index < Math.max(aPre.length, bPre.length); index += 1) {
    const left = aPre[index]
    const right = bPre[index]
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1
    if (left === right) continue
    if (typeof left === 'number' && typeof right === 'number') return left - right
    if (typeof left === 'number') return -1
    if (typeof right === 'number') return 1
    return left.localeCompare(right)
  }
  return 0
}
