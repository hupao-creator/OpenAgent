import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Duplex } from 'node:stream'
import { connectPiHostBridge, type PiHostBridgeOptions } from './host-bridge.js'

type Message = Record<string, unknown>
export interface PiRpc {
  readonly version?: string
  request(command: Message, signal?: AbortSignal): Promise<Message>
  write(message: Message): Promise<void>
  subscribe(listener: (event: Message) => void): () => void
  onFailure(listener: (error: Error) => void): () => void
  dispose(): Promise<void>
}

const MAX_LINE_BYTES = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000

type PiProcessOptions = {
  executablePath: string
  cwd: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
}

/**
 * The gate is paid on every RPC start, so the answer is memoized per
 * (executable, cwd, environment). Sharing one probe across callers means the
 * probe cannot own a caller's signal; each caller races the shared promise
 * against its own instead.
 */
const VERSION_TTL_MS = 5 * 60 * 1_000
const versionProbes = new Map<string, { at: number; probe: Promise<string> }>()

/**
 * Forgets every memoized version. This gate is all that stands between an
 * unsupported CLI and a native session, and the binary behind a path can be
 * replaced in place. A caller that has just learned the installation may have
 * changed retires the memo before it asks anything else: the answers are keyed
 * by executable, cwd and environment, and resolving those is itself the step
 * that can fail, so the caller cannot name the key it needs retired yet.
 */
export function retirePiVersions(): void {
  versionProbes.clear()
}

/** This adapter relies on the 0.83 RPC agent_settled and native clone contracts. */
export async function getPiVersion(options: PiProcessOptions): Promise<string> {
  if (options.signal.aborted) throw new Error('Pi CLI version probe cancelled')
  const key = versionKey(options)
  const cached = versionProbes.get(key)
  let entry = cached
  if (!entry || Date.now() - entry.at >= VERSION_TTL_MS) {
    // The executable can be replaced in place, so an expired answer is re-read
    // rather than pinned for the life of the app. Failures stay uncached so a
    // fixed installation is retried.
    const probe = probeVersion(options.executablePath, options.cwd, options.env)
    entry = { at: Date.now(), probe }
    versionProbes.set(key, entry)
    void probe.catch(() => { if (versionProbes.get(key) === entry) versionProbes.delete(key) })
  }
  return await abortable(entry.probe, options.signal)
}

function probeVersion(executablePath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(executablePath, ['--version'], {
      cwd, env, encoding: 'utf8',
      timeout: 5_000, maxBuffer: 1_024, killSignal: 'SIGKILL', windowsHide: true
    }, (error, stdout) => {
      if (error) {
        reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Pi CLI version probe could not start' :
          'Pi CLI version could not be verified; install Pi 0.83.x so the detected executable reports a supported version'))
      } else resolve(stdout.trim())
    })
  }).then(output => {
    if (!/^0\.83\.\d+$/.test(output)) throw new Error('Unsupported Pi CLI version; install Pi 0.83.x (tested with 0.83.0) for the required RPC completion protocol')
    return output
  })
}

/** Environment values may hold credentials, so only their digest is retained. */
function versionKey(options: PiProcessOptions): string {
  const environment = Object.keys(options.env).sort()
    .map(key => `${key}=${options.env[key] ?? ''}`).join('\n')
  return createHash('sha256')
    .update(options.executablePath).update('\0')
    .update(options.cwd).update('\0')
    .update(environment).digest('hex')
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Pi CLI version probe cancelled'))
  let cancel!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Error('Pi CLI version probe cancelled'))
    signal.addEventListener('abort', cancel, { once: true })
  })
  return Promise.race([operation, aborted]).finally(() => signal.removeEventListener('abort', cancel))
}

export async function startPiRpc(options: PiProcessOptions & {
  args: string[]
  hostBridge?: PiHostBridgeOptions
}): Promise<PiRpc> {
  if (options.signal.aborted) throw new Error('Pi RPC startup cancelled')
  const version = await getPiVersion(options)
  if (options.signal.aborted) throw new Error('Pi RPC startup cancelled')
  const child = spawn(options.executablePath, ['--mode', 'rpc', ...options.args], {
    cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe', ...(options.hostBridge ? ['pipe' as const] : [])], windowsHide: true, detached: process.platform !== 'win32'
  })
  const killTree = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch (error) {
      // macOS may report EPERM for an already exited detached group. Still
      // attempt the direct child without letting cleanup mask the RPC failure.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        try { child.kill(signal) } catch { /* Process already unavailable. */ }
      }
    }
  }
  const events = new Set<(event: Message) => void>()
  const failures = new Set<(error: Error) => void>()
  const pending = new Map<string, { resolve: (value: Message) => void; reject: (error: Error) => void; clean: () => void }>()
  let failure: Error | undefined
  let sequence = 0
  let buffered = ''
  let disposal: Promise<void> | undefined
  let bridge: ReturnType<typeof connectPiHostBridge> | undefined
  let closed = false
  const decoder = new StringDecoder('utf8')
  const closedPromise = new Promise<void>((resolve) => child.once('close', () => { closed = true; resolve() }))
  // Listener failures are isolated from native protocol handling (including async callbacks).
  const notify = <T>(listener: (value: T) => void, value: T): void => {
    try { void Promise.resolve(listener(value)).catch(() => {}) } catch { /* Consumer owns its callback. */ }
  }
  const fail = (error: Error): void => {
    if (failure) return
    failure = error
    for (const entry of pending.values()) { entry.clean(); entry.reject(error) }
    pending.clear()
    for (const listener of failures) notify(listener, error)
    void dispose()
  }
  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    disposal = (async () => {
      options.signal.removeEventListener('abort', abort)
      bridge?.dispose()
      if (!failure) {
        failure = new Error('Pi RPC disposed')
        for (const entry of pending.values()) { entry.clean(); entry.reject(failure) }
        pending.clear()
      }
      events.clear()
      failures.clear()
      killTree('SIGTERM')
      if (closed) { killTree('SIGKILL'); return }
      child.stdin.destroy()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([closedPromise, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000) })])
      if (timer) clearTimeout(timer)
      if (!closed) {
        killTree('SIGKILL')
        await Promise.race([closedPromise, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000) })])
        if (timer) clearTimeout(timer)
      }
      killTree('SIGKILL')
      child.stdout.destroy()
      child.stderr.destroy()
    })()
    return disposal
  }
  const abort = (): void => fail(new Error('Pi RPC cancelled'))
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) abort()
  child.on('error', () => fail(new Error('Pi RPC process could not start')))
  child.on('exit', (code, signal) => fail(new Error(`Pi RPC process exited (${signal ?? code ?? 'unknown'})`)))
  child.stdin.on('error', () => fail(new Error('Pi RPC input disconnected')))
  child.stdout.on('error', () => fail(new Error('Pi RPC output disconnected')))
  child.stdout.on('end', () => fail(new Error('Pi RPC output disconnected')))
  // Drain stderr without retaining or surfacing potentially credential-bearing native text.
  child.stderr.resume()
  child.stderr.on('error', () => {})
  child.stdout.on('data', (chunk: Buffer) => {
    if (failure) return
    buffered += decoder.write(chunk)
    let index: number
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index).replace(/\r$/, '')
      buffered = buffered.slice(index + 1)
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { fail(new Error('Pi RPC record exceeds size limit')); return }
      let message: Message
      try {
        const parsed: unknown = JSON.parse(line)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as Message).type !== 'string') throw new Error()
        message = parsed as Message
      } catch { fail(new Error('Pi RPC returned an invalid JSON record')); return }
      if (message.type === 'response') {
        const entry = typeof message.id === 'string' ? pending.get(message.id) : undefined
        if (!entry) continue
        pending.delete(message.id as string)
        entry.clean()
        if (message.success === true) {
          const data = message.data
          entry.resolve(data && typeof data === 'object' && !Array.isArray(data) ? data as Message : {})
        } else entry.reject(new Error('Pi RPC command rejected'))
      } else for (const listener of events) notify(listener, message)
    }
    if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) fail(new Error('Pi RPC record exceeds size limit'))
  })
  const write = async (message: Message): Promise<void> => {
    if (failure) throw failure
    const line = `${JSON.stringify(message)}\n`
    await new Promise<void>((resolve, reject) => child.stdin.write(line, (error) => {
      if (error) { fail(new Error('Pi RPC input disconnected')); reject(failure) } else resolve()
    }))
  }
  const request = (command: Message, signal?: AbortSignal): Promise<Message> => {
    if (failure) return Promise.reject(failure)
    if (signal?.aborted) return Promise.reject(new Error('Pi RPC request cancelled'))
    const id = `oa-${++sequence}`
    return new Promise<Message>((resolve, reject) => {
      const cancel = (): void => {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id); entry.clean(); reject(new Error('Pi RPC request cancelled'))
      }
      const timer = setTimeout(() => fail(new Error('Pi RPC request timed out')), REQUEST_TIMEOUT_MS)
      pending.set(id, { resolve, reject, clean: () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel) } })
      signal?.addEventListener('abort', cancel, { once: true })
      void write({ ...command, id }).catch(() => fail(new Error('Pi RPC request could not be written')))
    })
  }
  const rpc: PiRpc = {
    version,
    request, write, dispose,
    subscribe(listener) { if (!failure) events.add(listener); return () => { events.delete(listener) } },
    onFailure(listener) {
      if (failure) notify(listener, failure)
      else failures.add(listener)
      return () => { failures.delete(listener) }
    }
  }
  if (options.hostBridge) bridge = connectPiHostBridge(child.stdio[3] as Duplex, options.hostBridge, fail)
  const startupTimer = setTimeout(() => fail(new Error('Pi RPC startup timed out')), 15_000)
  try { await request({ type: 'get_state' }); await bridge?.ready; return rpc }
  catch (error) { await dispose(); throw error }
  finally { clearTimeout(startupTimer) }
}
