import { spawn, type ChildProcess } from 'node:child_process'

export interface RunGitOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly terminationGraceMs?: number
}

/** Runs Git without a shell and resolves with trimmed stdout. */
export function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {}
): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const timeoutMs = options.timeoutMs
    const maxOutputBytes = options.maxOutputBytes
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      reject(new Error('git timeoutMs 必须是正数'))
      return
    }
    if (maxOutputBytes !== undefined &&
        (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)) {
      reject(new Error('git maxOutputBytes 必须是正整数'))
      return
    }
    if (options.signal?.aborted) {
      reject(options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('git command aborted'))
      return
    }
    const isolateProcessGroup = process.platform !== 'win32' && (
      options.signal !== undefined ||
      timeoutMs !== undefined ||
      maxOutputBytes !== undefined
    )
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      detached: isolateProcessGroup,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // Acquire ownership while spawning the detached leader, not when a later
    // abort happens: by then the leader may have exited with live descendants.
    const processGroup = isolateProcessGroup ? observeOwnedProcessGroup(child) : undefined
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false
    let terminationError: Error | undefined
    let timeout: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      processGroup?.dispose()
      options.signal?.removeEventListener('abort', onAbort)
    }
    const settle = (error?: unknown, value?: string): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error !== undefined) reject(error)
      else resolveCommand(value ?? '')
    }
    const terminate = (error: Error): void => {
      if (settled || terminationError) return
      terminationError = error
      signalProcessTree(child, processGroup, 'SIGTERM')
      // One grace timer owns both the group fallback and Promise settlement.
      // Never retain an independent raw PGID timer after ownership is retired.
      killTimer = setTimeout(() => {
        signalProcessTree(child, processGroup, 'SIGKILL')
        settle(error)
      }, options.terminationGraceMs ?? 1_000)
      if (process.platform === 'win32') killTimer.unref()
    }
    const onAbort = (): void => {
      const reason = options.signal?.reason
      terminate(reason instanceof Error ? reason : new Error('git command aborted'))
    }
    const appendOutput = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (settled) return
      outputBytes += chunk.byteLength
      if (maxOutputBytes !== undefined && outputBytes > maxOutputBytes) {
        terminate(new Error(`git ${args[0] ?? ''} 输出超过安全上限`))
        return
      }
      if (target === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
    }
    child.stdout.on('data', (chunk: Buffer) => {
      appendOutput('stdout', chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      appendOutput('stderr', chunk)
    })
    child.once('error', error => settle(error))
    child.once('close', (code) => {
      if (settled) return
      if (terminationError) {
        if (process.platform === 'win32' || !processGroup?.isAlive()) {
          settle(terminationError)
          return
        }
        // The detached leader can exit while one of its descendants still
        // owns the stdio/process group. Let the termination grace callback
        // signal the captured PGID before resolving the operation.
        if (!killTimer) settle(terminationError)
      }
      else if (code === 0) settle(undefined, stdout.trim())
      else settle(new Error(stderr.trim() || `git ${args[0]} 执行失败`))
    })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        terminate(new Error(`git ${args[0] ?? ''} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      timeout.unref()
    }
  })
}

interface OwnedProcessGroup {
  isAlive(): boolean
  signal(signal: NodeJS.Signals): boolean
  dispose(): void
}

function observeOwnedProcessGroup(child: ChildProcess): OwnedProcessGroup | undefined {
  if (!child.pid) return
  const processGroupId = child.pid
  let retired = false
  let monitor: NodeJS.Timeout | undefined
  const retire = (): void => {
    retired = true
    if (monitor) clearInterval(monitor)
    child.removeListener('exit', onLeaderExit)
  }
  const isAlive = (): boolean => {
    if (retired) return false
    if (isProcessGroupAlive(processGroupId)) return true
    // An observed gap permanently revokes this numeric identity. A recycled
    // group is never adopted by a later cancellation or fallback timer.
    retire()
    return false
  }
  const onLeaderExit = (): void => {
    if (!isAlive()) return
    // `exit`, unlike `close`, does not wait for inherited descendant pipes.
    monitor = setInterval(isAlive, 25)
    monitor.unref()
  }
  child.once('exit', onLeaderExit)
  return {
    isAlive,
    signal: signal => {
      if (!isAlive()) return false
      if (signalProcessGroup(processGroupId, signal)) return true
      isAlive()
      return false
    },
    dispose: retire
  }
}

function signalProcessTree(
  child: ChildProcess,
  processGroup: OwnedProcessGroup | undefined,
  signal: NodeJS.Signals
): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    if (!isChildRunning(child)) return
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.unref()
    return
  }

  if (processGroup?.signal(signal)) return
  if (isChildRunning(child)) child.kill(signal)
}

function isChildRunning(child: ChildProcess): boolean {
  return !!child.pid && child.exitCode === null && child.signalCode === null
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return !isNoSuchProcessError(error)
  }
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-processGroupId, signal)
    return true
  } catch {
    return false
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH'
}
