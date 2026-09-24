import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterEach, expect, it, vi } from 'vitest'
import { startPiRpc, type PiRpc } from '../../../../packages/harness-pi/src/main/runtime/rpc'
import { checkAsync } from './check'

type Message = Record<string, unknown>

const fixture = fileURLToPath(new URL('../fixtures/fake-pi-rpc.mjs', import.meta.url))

// Cleanup is owned by the sample that took the resource: `connect` hands back a `close`
// and every property body awaits it from a `finally`. fast-check's time limit abandons a
// sample without cancelling it, though, so a body blocked past the budget cannot reach
// its own `finally`. This registry is the safety net for exactly that case — it drains
// whatever an interrupted sample left behind, and is empty on every ordinary run.
const stranded = new Set<() => Promise<void>>()

afterEach(async () => {
  // The fake-timer property restores the real clock even when its own sample fails.
  vi.useRealTimers()
  const leftovers = [...stranded]
  stranded.clear()
  await Promise.all(leftovers.map(close => close().catch(() => undefined)))
})

/** Real `startPiRpc` against the programmable fixture; the marker proves the process double exited. */
async function connect(env: NodeJS.ProcessEnv = {}, signal = new AbortController().signal) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-rpc-property-'))
  const marker = join(directory, 'exited')
  let rpc: PiRpc
  try {
    rpc = await startPiRpc({ executablePath: fixture, cwd: directory, env: { ...process.env, PI_RPC_FIXTURE_EXIT_MARKER: marker, ...env }, args: [], signal })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  // Each sample closes its own connection and temporary root, so a run never holds more
  // than the one subprocess it drives and shrinking cannot inherit a live child. The entry
  // stays registered until disposal and removal are done, because the sample fast-check's
  // time limit abandons can be blocked inside `dispose` rather than before it; the memoised
  // promise lets the sample's own `finally` and the safety net's drain share one closure.
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await rpc.dispose().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
      stranded.delete(close)
    })()
    return closing
  }
  stranded.add(close)
  return { rpc, marker, close }
}

// Raw multi-byte text: JSON escaping would hide the UTF-8 boundaries this family splits on.
const text = fc.array(fc.oneof(
  fc.integer({ min: 0x20, max: 0x7e }).map(code => String.fromCharCode(code)),
  fc.constantFrom('中', '文', '🙂', 'e' + String.fromCharCode(0x301), String.fromCharCode(0x2028)),
  fc.integer({ min: 0x4e00, max: 0x9fff }).map(code => String.fromCodePoint(code))
), { maxLength: 10 }).map(units => units.join(''))

const chunkPlan = fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 6 })
const nativeBudget = process.env.FC_EXPLORE ? 120_000 : 30_000
const nativeTimeout = process.env.FC_EXPLORE ? 130_000 : 35_000
// Subprocess startup dominates: these sample counts are declared per property, not inherited.
const samples = { normal: 8, explore: 60 }

const failureModes = ['exit', 'halt', 'invalid', 'oversized', 'break', 'truncate', 'dispose', 'context-abort'] as const
// Two of these properties run on Vitest's virtual clock, so anything that has to measure
// real time — waiting for a subprocess to exit, or the guard below — keeps the genuine
// timers this module captured before any fake one was installed. A guard built on the
// virtual clock could never fire, which turns a hung sample into a budget overrun instead
// of the failure it is.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realDelay = (ms: number): Promise<void> => new Promise(resolve => realSetTimeout(resolve, ms))

/** Waits on the real clock for the process double's own exit marker. */
async function waitForExited(marker: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if (await readFile(marker, 'utf8') === 'exited') return } catch { /* Not written yet. */ }
    await realDelay(25)
  }
  expect(await readFile(marker, 'utf8')).toBe('exited')
}

/** A property that would hang is a failed property, not a slow one. */
async function settledWithin<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = realSetTimeout(() => reject(new Error(`${label}: controlled work did not settle`)), 5_000)
    })])
  } finally { if (timer) realClearTimeout(timer) }
}

it('pi rpc assembles records identically under generated chunk boundaries', async () => {
  await checkAsync('pi rpc chunk boundary assembly', fc.asyncProperty(
    fc.record({ value: text, crlf: fc.boolean(), handshake: chunkPlan, plans: fc.array(chunkPlan, { minLength: 2, maxLength: 4 }) }),
    async scenario => {
      // The handshake split is decided at spawn time; every later record chooses its own.
      const { rpc, close } = await connect({ PI_RPC_FIXTURE_HANDSHAKE_SPLIT: JSON.stringify(scenario.handshake) })
      try {
        for (const split of scenario.plans) {
          const result = await rpc.request({ type: 'echo', value: scenario.value, split, crlf: scenario.crlf })
          expect(result.value).toBe(scenario.value)
        }
        // The same reader frames events: the identical record under every generated
        // chunking must arrive as the identical event, once per request.
        const events: Message[] = []
        rpc.subscribe(event => { events.push(event) })
        for (const split of scenario.plans) await rpc.request({ type: 'event', value: scenario.value, split, crlf: scenario.crlf })
        expect(events).toHaveLength(scenario.plans.length)
        for (const event of events) {
          expect(event.type).toBe('extension_ui_request')
          expect(event.value).toBe(scenario.value)
        }
        // A connection with generated chunk boundaries still correlates a later request.
        const final = await rpc.request({ type: 'echo', value: scenario.value })
        expect(final.value).toBe(scenario.value)
      } finally { await close() }
    }
  ), 'connect with a chunked handshake → one echo per generated byte-chunk plan → final unchunked echo', nativeBudget, samples)
}, nativeTimeout)

it('pi rpc correlates out-of-order responses to their own requests', async () => {
  await checkAsync('pi rpc out-of-order response correlation', fc.asyncProperty(
    fc.record({
      // Only orders that differ from the request order are generated: a correlator that
      // simply answered in arrival order must not be able to pass a sample.
      values: fc.uniqueArray(text, { minLength: 3, maxLength: 5 }),
      order: fc.constantFrom('reverse', 'alternate'),
      // At least one: an empty draw would never forge a response, leaving the
      // "unknown identifiers are dropped" claim unexercised for that whole run.
      ghosts: fc.array(fc.string({ maxLength: 6 }), { minLength: 1, maxLength: 3 })
    }),
    async scenario => {
      const { rpc, close } = await connect()
      try {
        const events: Message[] = []
        rpc.subscribe(event => { events.push(event) })
        const settled: number[] = []
        const pending = scenario.values.map((value, index) =>
          rpc.request({ type: 'echo', value, hold: true }).then(result => { settled.push(index); return result }))
        // The double emits responses for identifiers this adapter never issued; the
        // reader must drop them rather than deliver them as events.
        for (const ghost of scenario.ghosts) await rpc.write({ type: 'forge', id: `ghost-${ghost}`, value: ghost })
        const release = rpc.request({ type: 'release', order: scenario.order })
        const results = await settledWithin(Promise.all(pending), 'held echo requests')
        results.forEach((result, index) => expect(result.value).toBe(scenario.values[index]))
        const indices = scenario.values.map((_, index) => index)
        const expected = scenario.order === 'reverse' ? [...indices].reverse()
          : [...indices.filter(index => index % 2 === 0), ...indices.filter(index => index % 2 === 1)]
        // The observed arrival order is the evidence that the responses really were reordered.
        expect(settled).toEqual(expected)
        expect(settled).not.toEqual(indices)
        expect(await release).toMatchObject({ released: scenario.values.length })
        expect(events).toEqual([])
      } finally { await close() }
    }
  ), 'connect → held echoes → forged responses → release out of request order → per-request values in arrival order', nativeBudget, samples)
}, nativeTimeout)

it('pi rpc cancels only the requested work and keeps the session usable', async () => {
  await checkAsync('pi rpc targeted request cancellation', fc.asyncProperty(
    fc.record({ entries: fc.array(fc.record({ value: text, cancel: fc.boolean() }), { minLength: 2, maxLength: 5 }) }),
    async scenario => {
      const { rpc, close } = await connect()
      try {
        let failures = 0
        rpc.onFailure(() => { failures += 1 })
        const controllers = scenario.entries.map(() => new AbortController())
        const pending = scenario.entries.map((entry, index) =>
          rpc.request({ type: 'echo', value: entry.value, hold: true }, controllers[index]!.signal))
        // Settle handlers attach before any abort so a cancelled request is never unhandled.
        const settled = Promise.allSettled(pending)
        scenario.entries.forEach((entry, index) => { if (entry.cancel) controllers[index]!.abort() })
        await rpc.request({ type: 'release', order: 'forward' })
        const results = await settledWithin(settled, 'cancelled echo requests')
        results.forEach((result, index) => {
          if (scenario.entries[index]!.cancel) {
            expect(result.status).toBe('rejected')
            expect((result as PromiseRejectedResult).reason.message).toContain('cancelled')
          } else {
            expect(result.status).toBe('fulfilled')
            expect((result as PromiseFulfilledResult<Message>).value.value).toBe(scenario.entries[index]!.value)
          }
        })
        // A late response for cancelled work and a repeated abort change nothing.
        for (const controller of controllers) controller.abort()
        expect(failures).toBe(0)
        const after = await rpc.request({ type: 'echo', value: 'still open' })
        expect(after.value).toBe('still open')
        // Aborting an already-resolved request leaves its value intact.
        const controller = new AbortController()
        const answered = await rpc.request({ type: 'echo', value: 'answered' }, controller.signal)
        controller.abort()
        expect(answered.value).toBe('answered')
      } finally { await close() }
    }
  ), 'connect → held echoes → generated cancellations → release → repeated abort → fresh request → abort after resolution', nativeBudget, samples)
}, nativeTimeout)

// Every failure mode must end the controlled pending set and leave no live process double behind.
it('pi rpc ends pending work and releases its process for every failure mode', async () => {
  await checkAsync('pi rpc failure termination and cleanup', fc.asyncProperty(
    fc.record({
      mode: fc.constantFrom(...failureModes),
      pending: fc.integer({ min: 1, max: 3 }),
      disposals: fc.integer({ min: 2, max: 4 })
    }),
    async scenario => {
      const controller = new AbortController()
      const { rpc, marker, close } = await connect({}, controller.signal)
      try {
        const events: Message[] = []
        let failures = 0
        rpc.subscribe(event => { events.push(event) })
        rpc.onFailure(() => { failures += 1 })
        // Fake timers start after the handshake, as in the timeout property below, so the
        // request bounds are virtual and their survival is observable.
        vi.useFakeTimers()
        const pending = Array.from({ length: scenario.pending }, () => rpc.request({ type: 'hang' }))
        const settled = settledWithin(Promise.allSettled(pending), `${scenario.mode} pending requests`)
        const explicitDispose = scenario.mode === 'dispose'
        let trigger: Promise<unknown> | undefined
        if (explicitDispose) await rpc.dispose()
        else if (scenario.mode === 'context-abort') controller.abort()
        else trigger = rpc.request({ type: scenario.mode })
        const results = await settled
        expect(results).toHaveLength(scenario.pending)
        for (const result of results) {
          expect(result.status).toBe('rejected')
          expect((result as PromiseRejectedResult).reason.message).not.toContain('SECRET')
        }
        // The command that caused the failure ends too, without leaking native text.
        if (trigger) {
          const reported = await settledWithin(Promise.allSettled([trigger]), 'triggering command')
          expect(reported[0]!.status).toBe('rejected')
          expect((reported[0] as PromiseRejectedResult).reason.message).not.toContain('SECRET')
        }
        // Explicit disposal is not itself a failure; every native failure is reported exactly once.
        expect(failures).toBe(explicitDispose ? 0 : 1)
        expect(events).toEqual([])
        // The failure path released its own process. This assertion precedes every explicit
        // disposal below, which would write the marker whether or not `fail()` had released it.
        await waitForExited(marker)
        // A failure has to clean each pending wait, not only reject it. Awaiting the disposal
        // the failure started settles every grace timer that disposal owns, so a live request
        // bound is the only timer that can still be registered: rejecting and clearing the map
        // while leaving the timers running is invisible to every assertion above.
        await rpc.dispose()
        expect(vi.getTimerCount()).toBe(0)
        // Real timers return before the process is waited for again: the disposal grace races
        // run on the clock, and an advanced virtual one would escalate to SIGKILL before the
        // double can run its own exit path.
        vi.useRealTimers()
        await Promise.all(Array.from({ length: scenario.disposals }, () => rpc.dispose()))
        await expect(rpc.request({ type: 'echo', value: 'late' })).rejects.toThrow()
        await expect(rpc.write({ type: 'echo', value: 'late' })).rejects.toThrow()
        // Repeated disposal left the double terminal and no late record mutates the closed connection.
        await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('exited'))
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(events).toEqual([])
        expect(failures).toBe(explicitDispose ? 0 : 1)
      } finally { vi.useRealTimers(); await close() }
    }
  ), 'connect → pending native work → generated failure mode → all pending reject → failure released its own process → disposal settles every bound → repeated dispose → late request/write reject → exited double', nativeBudget, { normal: 12, explore: 60 })
}, nativeTimeout)

it('pi rpc bounds silent requests and releases the pending set', async () => {
  await checkAsync('pi rpc request timeout', fc.asyncProperty(
    fc.record({ pending: fc.integer({ min: 1, max: 3 }), disposals: fc.integer({ min: 2, max: 4 }) }),
    async scenario => {
      const { rpc, marker, close } = await connect()
      try {
        let failures = 0
        rpc.onFailure(() => { failures += 1 })
        // Fake timers start after the handshake; fast-check binds its own clock at import.
        vi.useFakeTimers()
        const settled = Promise.allSettled(Array.from({ length: scenario.pending }, () => rpc.request({ type: 'hang' })))
        await vi.advanceTimersByTimeAsync(30_001)
        const results = await settledWithin(settled, 'timed-out requests')
        expect(results).toHaveLength(scenario.pending)
        for (const result of results) {
          expect(result.status).toBe('rejected')
          expect((result as PromiseRejectedResult).reason.message).toContain('timed out')
        }
        expect(failures).toBe(1)
        await expect(rpc.request({ type: 'echo', value: 'late' })).rejects.toThrow()
        // Real timers return before disposal: an advanced virtual clock would escalate to
        // SIGKILL before the double can run its own exit path.
        vi.useRealTimers()
        await Promise.all(Array.from({ length: scenario.disposals }, () => rpc.dispose()))
        await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('exited'))
      } finally { vi.useRealTimers(); await close() }
    }
  ), 'connect → silent requests → 30 s virtual advance → every request rejects once → late request rejects → exited double', nativeBudget, { normal: 6, explore: 30 })
}, nativeTimeout)
