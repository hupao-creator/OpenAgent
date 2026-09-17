import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { createRequire } from 'node:module'
import { applyRendererStatePatch } from '../../src/shared/renderer-state-patch.ts'
import {
  assertRecord,
  bounded,
  delay,
  findThread,
  latestExecution
} from './support.mjs'

const require = createRequire(import.meta.url)

const STARTUP_TIMEOUT_MS = 60_000
const SHUTDOWN_GRACE_MS = 10_000
const SHUTDOWN_KILL_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 500
const PROCESS_EXIT_POLL_MS = 25
const LISTENING_PATTERN =
  /OpenAgent headless control listening on http:\/\/127\.0\.0\.1:(\d+)/

/**
 * One isolated headless Electron process. Every worker owns exactly one, so a
 * parallel run never shares a Bart conversation or a persisted thread store.
 */
export async function startHeadless(input) {
  input.signal?.throwIfAborted()
  const electronBinary = input.electronBinary || require('electron')
  const spawnProcess = input.spawnProcess || spawn
  const child = spawnProcess(
    electronBinary,
    [input.electronMain, `--user-data-dir=${input.userData}`],
    {
      cwd: input.desktopRoot,
      detached: process.platform !== 'win32',
      env: createHeadlessEnvironment(input, input.environment || process.env),
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const log = createWriteStream(input.processLog, { flags: 'a' })
  let logError
  log.on('error', error => { logError ??= error })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })

  let output = ''
  let port
  try {
    port = await new Promise((resolvePort, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`headless startup timed out; see ${input.processLog}`))
      }, input.startupTimeoutMs ?? STARTUP_TIMEOUT_MS)
      const inspect = chunk => {
        output = `${output}${chunk.toString('utf8')}`.slice(-16_384)
        const match = output.match(LISTENING_PATTERN)
        if (!match) return
        clearTimeout(timeout)
        cleanup()
        resolvePort(Number(match[1]))
      }
      const exited = (code, signal) => {
        clearTimeout(timeout)
        cleanup()
        reject(new Error(
          `headless exited during startup (code=${code}, signal=${signal}); see ${input.processLog}`
        ))
      }
      const failed = error => {
        clearTimeout(timeout)
        cleanup()
        reject(error)
      }
      const aborted = () => failed(input.signal.reason)
      const cleanup = () => {
        input.signal?.removeEventListener('abort', aborted)
        child.stdout.off('data', inspect)
        child.stderr.off('data', inspect)
        child.off('exit', exited)
        child.off('error', failed)
        log.off('error', failed)
      }
      child.stdout.on('data', inspect)
      child.stderr.on('data', inspect)
      child.once('exit', exited)
      child.once('error', failed)
      log.once('error', failed)
      input.signal?.addEventListener('abort', aborted, { once: true })
      if (input.signal?.aborted) aborted()
    })
  } catch (error) {
    await closeHeadlessProcess(child, log, input).catch(cleanupError => {
      throw new AggregateError(
        [error, cleanupError],
        'headless startup and process-tree cleanup both failed'
      )
    })
    throw error
  }

  let closed = false
  return {
    port,
    processLog: input.processLog,
    close: async () => {
      if (closed) return
      closed = true
      await closeHeadlessProcess(child, log, input)
      if (logError) throw new Error(`headless process log failed: ${input.processLog}`, {
        cause: logError
      })
    }
  }
}

/** Keep every OpenAgent-owned mutable path inside this acceptance worker. */
export function createHeadlessEnvironment(input, environment = process.env) {
  const next = {
    ...environment,
    OPENAGENT_HEADLESS: '1',
    OPENAGENT_HEADLESS_PORT: '0',
    OPENAGENT_HEADLESS_USER_DATA: input.userData,
    OPENAGENT_HEADLESS_HOME: input.openAgentHome,
    OPENAGENT_DEV_CWD: input.repositoryRoot
  }
  if (input.provider) {
    next.OPENAGENT_BART_HEADLESS_PROVIDER = input.provider
  }
  return next
}

/**
 * The public observation client. It reads only committed renderer state and
 * the loopback command surface, exactly like the GUI renderer does.
 */
export class HeadlessClient {
  constructor(input) {
    this.signal = input.signal
    this.port = input.port
    this.timeoutMs = input.timeoutMs
    this.revision = -1
    this.state = undefined
    this.transitionLog = new Map()
    this.streamAbort = undefined
    this.streamClosed = undefined
    this.waiters = new Set()
    this.stopped = false
  }

  /**
   * Mutation events are a latency optimisation and a transition recorder, never
   * the source of truth: every wait still polls committed state.
   */
  start() {
    if (this.streamClosed) return
    this.streamClosed = this.consumeEvents()
  }

  async stop() {
    this.stopped = true
    this.streamAbort?.abort()
    await this.streamClosed?.catch(() => undefined)
    this.streamClosed = undefined
  }

  async invoke(channel, payload, signal) {
    const response = await fetch(
      `http://127.0.0.1:${this.port}/invoke/${encodeURIComponent(channel)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.any([
          AbortSignal.timeout(Math.min(this.timeoutMs, 600_000)),
          ...(this.signal ? [this.signal] : []),
          ...(signal ? [signal] : [])
        ])
      }
    )
    const body = await response.json()
    if (!response.ok || body.ok !== true) {
      throw new Error(`${channel} failed: ${bounded(body)}`)
    }
    return body.result
  }

  async loadState(signal) {
    const response = await this.invoke('state:load', undefined, signal)
    assertRecord(response, 'state:load response')
    if (!Array.isArray(response.threads)) {
      throw new Error(`state:load returned invalid threads: ${bounded(response)}`)
    }
    this.observe(response)
    return response
  }

  async observeMutation(mutation, signal) {
    assertRecord(mutation, 'state:mutation payload')
    if (mutation.type !== 'state-patched') throw new Error('Invalid renderer mutation type')
    if (!this.state || mutation.baseRevision > this.revision) await this.loadState(signal)
    this.observe(applyRendererStatePatch(this.state, mutation))
  }

  observe(state) {
    if (typeof state?.revision !== 'number' || state.revision <= this.revision) return
    this.revision = state.revision
    this.state = state
    for (const thread of state.threads) {
      if (thread.bart === true) continue
      const execution = latestExecution(thread)
      const key = execution
        ? `${execution.executionId}:${execution.status}`
        : 'none'
      const log = this.transitionLog.get(thread.id) || []
      if (log[log.length - 1]?.key !== key) {
        log.push({
          key,
          status: execution?.status,
          executionId: execution?.executionId,
          backgroundWork: thread.observation?.backgroundWork?.status ?? null
        })
        this.transitionLog.set(thread.id, log)
      }
    }
    for (const waiter of this.waiters) waiter()
  }

  /** Ordered execution status observations recorded for one Agent Thread. */
  statusTransitions(threadId) {
    return (this.transitionLog.get(threadId) || [])
      .map(entry => entry.status)
      .filter(status => status !== undefined)
  }

  async waitForState(predicate, label, timeoutMs = this.timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs
    let latest
    let streamedMatch
    let streamedError
    // Evaluate stream-delivered snapshots synchronously. A fast Bart turn can
    // enter and leave `state.executions` between two authoritative polls; that
    // transient running snapshot is still required to bind a directive to its
    // exact executionId.
    const inspectLatest = () => {
      if (streamedMatch || streamedError || !this.state) return
      try {
        const value = predicate(this.state)
        if (value !== undefined) streamedMatch = { value }
      } catch (error) {
        streamedError = error
      }
    }
    this.waiters.add(inspectLatest)
    try {
      while (Date.now() < deadline) {
        this.signal?.throwIfAborted()
        signal?.throwIfAborted()
        inspectLatest()
        if (streamedError) throw streamedError
        if (streamedMatch) return streamedMatch.value
        latest = await this.loadState(signal)
        inspectLatest()
        if (streamedError) throw streamedError
        if (streamedMatch) return streamedMatch.value
        const result = predicate(latest)
        if (result !== undefined) return result
        await this.nextChange(POLL_INTERVAL_MS)
      }
      this.signal?.throwIfAborted()
      signal?.throwIfAborted()
      throw new Error(`${label} timed out after ${timeoutMs}ms; state=${bounded(latest)}`)
    } finally {
      this.waiters.delete(inspectLatest)
    }
  }

  async waitForThread(threadId, predicate, label = `thread ${threadId}`, timeoutMs) {
    return this.waitForState(state => {
      const thread = findThread(state, threadId)
      return thread ? predicate(thread) : undefined
    }, label, timeoutMs)
  }

  /** Resolves when the Bart has no process-local Execution in flight. */
  async waitForBartIdle(label = 'Bart idle', timeoutMs) {
    return this.waitForState(
      state => (state.executions.length === 0 ? state : undefined),
      label,
      timeoutMs
    )
  }

  nextChange(maximumWaitMs) {
    return new Promise(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.waiters.delete(finish)
        resolve()
      }
      const timer = setTimeout(finish, maximumWaitMs)
      this.waiters.add(finish)
    })
  }

  async consumeEvents() {
    while (!this.stopped) {
      const controller = new AbortController()
      this.streamAbort = controller
      try {
        const response = await fetch(
          `http://127.0.0.1:${this.port}/events`,
          { signal: controller.signal }
        )
        if (!response.ok || !response.body) throw new Error('events stream unavailable')
        // Subscribe before hydration so intervening deltas stay in the stream.
        // A reconnect must rebase before accepting a possibly coalesced patch.
        await this.loadState(controller.signal)
        let buffer = ''
        for await (const chunk of response.body) {
          buffer += Buffer.from(chunk).toString('utf8')
          let index = buffer.indexOf('\n')
          while (index >= 0) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            index = buffer.indexOf('\n')
            if (!line.trim()) continue
            try {
              const event = JSON.parse(line)
              if (event.channel === 'state:mutation') await this.observeMutation(event.payload, controller.signal)
            } catch {
              // A malformed line never invalidates polled committed state.
            }
          }
        }
      } catch {
        // The control plane drops slow subscribers by design; reconnecting keeps
        // transition recording alive without ever gating a wait on the stream.
      } finally {
        // Hydration can fail before iteration owns the response body. The
        // attempt still owns that socket and must close it before reconnecting.
        controller.abort()
        if (this.streamAbort === controller) this.streamAbort = undefined
      }
      if (this.stopped) return
      await delay(250)
    }
  }
}

function signalProcessTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
      // Fall through when only the group disappeared but the leader is live.
    }
  }
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    child.kill(signal)
  }
}

async function closeHeadlessProcess(child, log, input) {
  let cleanupError
  try {
    signalProcessTree(child, 'SIGTERM')
    const graceMs = input.shutdownGraceMs ?? SHUTDOWN_GRACE_MS
    if (!(await processTreeExitsWithin(child, graceMs))) {
      signalProcessTree(child, 'SIGKILL')
      const killTimeoutMs = input.shutdownKillTimeoutMs ?? SHUTDOWN_KILL_TIMEOUT_MS
      if (!(await processTreeExitsWithin(child, killTimeoutMs))) {
        cleanupError = new Error(`headless process group ${child.pid || 'unknown'} did not exit`)
      }
    }
  } catch (error) {
    cleanupError = error
  } finally {
    child.stdout?.unpipe(log)
    child.stderr?.unpipe(log)
    await endLog(log)
  }
  if (cleanupError) throw cleanupError
}

function processTreeExitsWithin(child, milliseconds) {
  if (!processTreeIsAlive(child)) return Promise.resolve(true)
  return new Promise(resolveExit => {
    const deadline = Date.now() + milliseconds
    const inspect = () => {
      if (!processTreeIsAlive(child)) {
        resolveExit(true)
        return
      }
      if (Date.now() >= deadline) {
        resolveExit(false)
        return
      }
      setTimeout(inspect, PROCESS_EXIT_POLL_MS)
    }
    inspect()
  })
}

function processTreeIsAlive(child) {
  if (!child.pid) return false
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      if (error?.code === 'ESRCH') return false
      if (error?.code === 'EPERM') return true
    }
  }
  return child.exitCode === null && child.signalCode === null
}

function endLog(log) {
  if (log.destroyed || log.closed) return Promise.resolve()
  return new Promise(resolveLog => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      log.off('error', finish)
      resolveLog()
    }
    log.once('error', finish)
    log.end(finish)
  })
}
