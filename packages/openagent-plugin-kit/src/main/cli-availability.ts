import type { spawn } from 'node:child_process'
import type { HarnessAvailabilityProbe, HarnessProcessEnvironment } from '@openagent/contracts'

/** Presence changes on install/uninstall timescales, not per settings read. */
const AVAILABILITY_TTL_MS = 5 * 60 * 1_000

interface AvailabilityEntry {
  readonly at: number
  readonly probe: Promise<void>
  waiters: number
  /** Ends a probe no caller is waiting on any more. */
  readonly abandon: () => void
}

/**
 * Probe only the executable. The host owns discovery and always auto-detects,
 * so Harness settings carry no path to prefer; model discovery belongs to the
 * settings/catalog API.
 */
export function createCliAvailabilityProbe<Settings>(
  context: {
    resolveExecutable(cwd: string): Promise<string>
    environment(): Promise<HarnessProcessEnvironment>
  },
  launch: typeof spawn
): HarnessAvailabilityProbe<Settings> {
  // Opening settings and leaving them both ask whether the same binary runs, and
  // each answer costs a full CLI start. The cache is per probe instance, so a
  // Harness never reuses another's launcher contract, and it is keyed by
  // executable alone: a `--version` answer does not depend on the workspace.
  const verified = new Map<string, AvailabilityEntry>()
  return {
    async probe({ cwd, signal }) {
      signal.throwIfAborted()
      try {
        const [executable, environment] = await abortable(Promise.all([
          context.resolveExecutable(cwd),
          context.environment()
        ]), signal)
        signal.throwIfAborted()
        let cached = verified.get(executable)
        if (!cached || Date.now() - cached.at >= AVAILABILITY_TTL_MS) {
          const abandoned = new AbortController()
          const entry: AvailabilityEntry = {
            at: Date.now(),
            probe: launchVersion(executable, cwd, environment, launch, abandoned.signal),
            waiters: 0,
            abandon: () => {
              if (verified.get(executable) === entry) verified.delete(executable)
              abandoned.abort()
            }
          }
          verified.set(executable, entry)
          // A failed probe stays out of the cache so a repaired installation is
          // noticed on the next attempt.
          void entry.probe.catch(() => { if (verified.get(executable) === entry) verified.delete(executable) })
          cached = entry
        }
        cached.waiters += 1
        let answered = false
        try {
          // The shared probe outlives one caller, so it cannot own that caller's
          // signal; each caller races it against its own instead.
          await abortable(cached.probe, signal)
          answered = true
        } finally {
          cached.waiters -= 1
          // Every caller can leave — a shutdown aborts them together — and the CLI
          // start they were sharing would then run on for a reader that is gone.
          if (!answered && cached.waiters === 0) cached.abandon()
        }
        signal.throwIfAborted()
        return { available: true }
      } catch (error) {
        signal.throwIfAborted()
        return { available: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
  }
}

function launchVersion(
  executable: string,
  cwd: string,
  environment: HarnessProcessEnvironment,
  launch: typeof spawn,
  abandoned: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Harnesses supply their native launcher, including Windows .cmd support.
    const child = launch(executable, ['--version'], {
      cwd, env: environment, timeout: 10_000,
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    const onAbandon = (): void => { child.kill() }
    abandoned.addEventListener('abort', onAbandon, { once: true })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000) })
    child.once('error', reject)
    child.once('close', (code, terminationSignal) => {
      abandoned.removeEventListener('abort', onAbandon)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `CLI version probe failed (${terminationSignal || code})`))
    })
  })
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => rejectAbort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
