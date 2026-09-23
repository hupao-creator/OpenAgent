import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPiVersion, retirePiVersions, startPiRpc, type PiRpc } from '../src/main/runtime/rpc.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-pi-rpc.mjs', import.meta.url))
const clients: PiRpc[] = []
async function start(signal = new AbortController().signal): Promise<PiRpc> {
  // Executable fixture accepts the same --mode rpc arguments as the real CLI.
  const rpc = await startPiRpc({ executablePath: fixture, cwd: process.cwd(), env: process.env, args: [], signal })
  clients.push(rpc)
  return rpc
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(clients.splice(0).map((rpc) => rpc.dispose())) })

/** How many times the fixture was asked for its version. */
async function probes(marker: string): Promise<number> {
  return (await readFile(marker, 'utf8').catch(() => '')).split('\n').filter(Boolean).length
}

describe('Pi RPC subprocess protocol', () => {
  it('handshakes and correlates requests while preserving UTF-8 and Unicode separators', async () => {
    const rpc = await start()
    expect(await rpc.request({ type: 'get_state' })).toMatchObject({ sessionId: 'fixture' })
    const [split, echo] = await Promise.all([rpc.request({ type: 'split' }), rpc.request({ type: 'echo', value: 'second' })])
    expect(split).toEqual({ value: 'a\u2028b\u2029中' })
    expect(echo).toEqual({ value: 'second' })
  })
  it('prompt acknowledgement precedes completion and UI replies do not need responses', async () => {
    const rpc = await start()
    const events: Record<string, unknown>[] = []
    rpc.subscribe((event) => { events.push(event) })
    const settled = new Promise<void>((resolve) => rpc.subscribe((event) => { if (event.type === 'agent_settled') resolve() }))
    await rpc.request({ type: 'prompt' })
    expect(events).toEqual([])
    await settled
    const replied = new Promise<Record<string, unknown>>((resolve) => rpc.subscribe((event) => { if (event.type === 'received_ui') resolve(event) }))
    await rpc.write({ type: 'extension_ui_response', id: 'dialog', value: 'answer' })
    expect(await replied).toMatchObject({ value: 'answer' })
  })
  it('isolates throwing and rejecting event callbacks', async () => {
    const rpc = await start()
    rpc.subscribe(() => { throw new Error('consumer') })
    rpc.subscribe(async () => { throw new Error('async consumer') })
    await expect(rpc.request({ type: 'event' })).resolves.toEqual({})
    await expect(rpc.request({ type: 'echo', value: 'alive' })).resolves.toEqual({ value: 'alive' })
  })
  it('cancels an individual request without disconnecting the session', async () => {
    const rpc = await start()
    const controller = new AbortController()
    const pending = rpc.request({ type: 'hang' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
    await expect(rpc.request({ type: 'echo', value: 1 })).resolves.toEqual({ value: 1 })
  })
  it.each(['exit', 'invalid', 'oversized'])('fails all pending requests on %s without exposing native text', async (type) => {
    const rpc = await start()
    const errors: Error[] = []
    rpc.onFailure((error) => { errors.push(error); throw new Error('consumer') })
    const pending = rpc.request({ type: 'hang' })
    const broken = rpc.request({ type })
    const results = await Promise.allSettled([pending, broken])
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).not.toContain('SECRET')
    await expect(rpc.request({ type: 'echo' })).rejects.toThrow()
  })
  it('keeps command rejection private and leaves the process usable', async () => {
    const rpc = await start()
    await expect(rpc.request({ type: 'reject' })).rejects.toThrow('Pi RPC command rejected')
    await expect(rpc.request({ type: 'get_state' })).resolves.toMatchObject({ sessionId: 'fixture' })
  })
  it('aborts the process lifecycle and rejects in-flight requests', async () => {
    const controller = new AbortController()
    const rpc = await start(controller.signal)
    const pending = rpc.request({ type: 'hang' })
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
    await rpc.dispose()
    await rpc.dispose()
  })
  it('bounds silent command waits', async () => {
    const rpc = await start()
    vi.useFakeTimers()
    const pending = rpc.request({ type: 'hang' })
    const rejected = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    vi.useRealTimers()
  })
  it('rejects missing executable and already-cancelled startup', async () => {
    const options = { executablePath: '/does-not-exist/pi', cwd: process.cwd(), env: process.env, args: [], signal: new AbortController().signal }
    await expect(startPiRpc(options)).rejects.toThrow('could not start')
    await expect(startPiRpc({ ...options, signal: AbortSignal.abort() })).rejects.toThrow('cancelled')
  })
  it('bounds startup when the process never acknowledges the handshake', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-rpc-timeout-'))
    const marker = join(directory, 'handshake')
    vi.useFakeTimers()
    const startup = startPiRpc({ executablePath: fixture, cwd: process.cwd(), env: { ...process.env, PI_RPC_FIXTURE_NO_HANDSHAKE: '1', PI_RPC_FIXTURE_HANDSHAKE_MARKER: marker }, args: [], signal: new AbortController().signal })
    const rejected = expect(startup).rejects.toThrow('startup timed out')
    await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('ready'))
    await vi.advanceTimersByTimeAsync(17_001)
    await rejected
    vi.useRealTimers()
    await rm(directory, { recursive: true, force: true })
  })
  it('kills a process that ignores graceful termination and rejects pending work on disposal', async () => {
    const rpc = await startPiRpc({ executablePath: fixture, cwd: process.cwd(), env: { ...process.env, PI_RPC_FIXTURE_IGNORE_TERM: '1' }, args: [], signal: new AbortController().signal })
    clients.push(rpc)
    const pending = rpc.request({ type: 'hang' })
    const rejected = expect(pending).rejects.toThrow('disposed')
    await rpc.dispose()
    await rejected
    await expect(rpc.write({ type: 'echo' })).rejects.toThrow('disposed')
  })

  it.each(['0.82.9', '0.84.0', '1.0.0', 'SECRET_NOT_A_VERSION', '0.83.0-beta'])('rejects unsupported version %s before RPC startup', async version => {
    await expect(startPiRpc({ executablePath: fixture, cwd: process.cwd(), env: { ...process.env, PI_RPC_FIXTURE_VERSION: version }, args: [], signal: new AbortController().signal })).rejects.toThrow('install Pi 0.83.x')
  })

  it('reports a supported patch version without starting a session', async () => {
    await expect(getPiVersion({ executablePath: fixture, cwd: process.cwd(), env: { ...process.env, PI_RPC_FIXTURE_VERSION: '0.83.7' }, signal: new AbortController().signal })).resolves.toBe('0.83.7')
  })

  it('cancels a hung version probe', async () => {
    const controller = new AbortController()
    const pending = getPiVersion({ executablePath: fixture, cwd: process.cwd(), env: { ...process.env, PI_RPC_FIXTURE_VERSION_HANG: '1' }, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('version probe cancelled')
  })

  it('bounds a silent version probe', async () => {
    await expect(getPiVersion({ executablePath: fixture, cwd: process.cwd(), env: { ...process.env, PI_RPC_FIXTURE_VERSION_HANG: '1' }, signal: new AbortController().signal })).rejects.toThrow('version probe timed out after 15000 ms')
  }, 20_000)

  it('accepts a supported version after a cold start longer than five seconds', async () => {
    await expect(getPiVersion({ executablePath: fixture, cwd: process.cwd(), env: { ...process.env, PI_RPC_FIXTURE_VERSION_DELAY: '5500' }, signal: new AbortController().signal })).resolves.toBe('0.83.0')
  }, 20_000)

  it.each([
    ['PI_RPC_FIXTURE_VERSION_ERROR', 'exited with code 1'],
    ['PI_RPC_FIXTURE_VERSION_SIGNAL', 'terminated by SIGTERM'],
    ['PI_RPC_FIXTURE_VERSION_OVERSIZED', 'exceeded the 1024-byte output limit']
  ])('reports %s without exposing process output or suggesting reinstall', async (mode, message) => {
    const error = await getPiVersion({ executablePath: fixture, cwd: process.cwd(), env: { ...process.env, [mode]: '1' }, signal: new AbortController().signal }).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain(message)
    expect(error.message).not.toMatch(/SECRET|install Pi/)
    expect(error.cause).toBeUndefined()
  })

  it('retries a failed probe instead of caching the failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-version-retry-'))
    const marker = join(directory, 'probes.log')
    const options = { executablePath: fixture, cwd: process.cwd(), env: { ...process.env, PI_RPC_FIXTURE_VERSION_ERROR: '1', PI_RPC_FIXTURE_VERSION_MARKER: marker }, signal: new AbortController().signal }
    try {
      await expect(getPiVersion(options)).rejects.toThrow('exited with code 1')
      await expect(getPiVersion(options)).rejects.toThrow('exited with code 1')
      expect(await probes(marker)).toBe(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('cancels one waiter without cancelling another caller sharing the probe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-version-shared-'))
    const marker = join(directory, 'probes.log')
    const options = { executablePath: fixture, cwd: process.cwd(), env: { ...process.env, PI_RPC_FIXTURE_VERSION_DELAY: '100', PI_RPC_FIXTURE_VERSION_MARKER: marker } }
    const controller = new AbortController()
    try {
      const first = getPiVersion({ ...options, signal: controller.signal })
      const second = getPiVersion({ ...options, signal: new AbortController().signal })
      controller.abort()
      await expect(first).rejects.toThrow('cancelled')
      await expect(second).resolves.toBe('0.83.0')
      expect(await probes(marker)).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reads the version again for a caller asking about the installation as it is now', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-version-refresh-'))
    const installed = join(directory, 'version.txt')
    const executable = join(directory, 'pi')
    const marker = join(directory, 'probes.log')
    await writeFile(installed, '0.83.7\n')
    // A stand-in for a CLI replaced in place: same path, same environment, and
    // whatever version is installed there now.
    await writeFile(executable, `#!/bin/sh\ncat "${installed}"\nprintf 'probe\\n' >> "${marker}"\n`, { mode: 0o755 })
    const options = { executablePath: executable, cwd: process.cwd(), env: process.env, signal: new AbortController().signal }
    try {
      await expect(getPiVersion(options)).resolves.toBe('0.83.7')
      await writeFile(installed, '0.84.0\n')
      // The gate is the only thing between an unsupported CLI and a native
      // session, so a reader that has just learned the installation may have
      // changed must not be answered from the memo — and the answer it retires
      // must not come back for the reads that follow.
      retirePiVersions()
      await expect(getPiVersion(options)).rejects.toThrow('0.83.x')
      // Every read after the retirement asked the installation rather than the
      // memo it retired.
      expect(await probes(marker)).toBe(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reuses a version answer only until it expires', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-version-cache-'))
    const marker = join(directory, 'probes.log')
    const env = { ...process.env, PI_RPC_FIXTURE_VERSION: '0.83.7', PI_RPC_FIXTURE_VERSION_MARKER: marker }
    const options = { executablePath: fixture, cwd: process.cwd(), env, signal: new AbortController().signal }
    try {
      await expect(getPiVersion(options)).resolves.toBe('0.83.7')
      await expect(getPiVersion(options)).resolves.toBe('0.83.7')
      expect(await probes(marker)).toBe(1)
      // The executable can be replaced in place, so an expired answer is read
      // again rather than pinned for the life of the app.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 5 * 60 * 1_000 + 1)
      await expect(getPiVersion(options)).resolves.toBe('0.83.7')
      expect(await probes(marker)).toBe(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
