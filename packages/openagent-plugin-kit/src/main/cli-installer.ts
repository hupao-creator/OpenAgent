import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { stripVTControlCharacters } from 'node:util'
import { HarnessExecutableNotFoundError } from '@openagent/contracts'

/**
 * Native installers can finish before the login shell's PATH includes them.
 * `command` is the Harness' own command name: a Harness default that names the
 * command is auto-detection, not a configured binary, so it still falls back.
 */
export function cliResolverWithInstallPath(
  resolve: (cwd: string, configuredPath?: string) => Promise<string>,
  installPath: string,
  command?: string
): (cwd: string, configuredPath?: string) => Promise<string> {
  return async (cwd, configuredPath) => {
    try {
      return await resolve(cwd, configuredPath)
    } catch (error) {
      const configured = configuredPath?.trim()
      if ((configured && configured !== command) || !(error instanceof HarnessExecutableNotFoundError)) throw error
      try {
        return await resolve(cwd, installPath)
      } catch (installedError) {
        if (installedError instanceof HarnessExecutableNotFoundError) throw error
        throw installedError
      }
    }
  }
}

/** Commands are package-owned constants, never Renderer input. */
export async function runCliInstaller(input: {
  readonly unix: string
  readonly windows: string
  readonly environment: NodeJS.ProcessEnv
  readonly signal: AbortSignal
}): Promise<void> {
  input.signal.throwIfAborted()
  const windows = process.platform === 'win32'
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10 * 60_000)])
  await new Promise<void>((resolve, reject) => {
    const child = spawn(windows ? 'powershell.exe' : '/bin/bash', windows
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', input.windows]
      : ['-o', 'pipefail', '-c', input.unix], {
      cwd: homedir(),
      env: { ...input.environment, SHELL: input.environment.SHELL || '/bin/bash', CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !windows,
      windowsHide: true
    })
    let output = ''
    const capture = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-8_000) }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const abort = (): void => {
      if (!child.pid) return
      // Stop the download and installer descendants too, including on app quit.
      if (windows) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill())
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.once('error', (error) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) {
        reject(new Error(input.signal.aborted ? '安装已取消' : '安装超时，请检查网络后重试'))
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(stripVTControlCharacters(output).trim() || `安装失败（退出码 ${code}）`))
      }
    })
  })
}
