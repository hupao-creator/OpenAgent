import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writePrivateFileAtomically } from '../src/main/services/atomic-file'
import { BartTelemetryLedger } from '../src/main/services/bart-telemetry-ledger'

const directories: string[] = []
const observedAt = Date.UTC(2026, 7, 30, 2, 0, 0)

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('BartTelemetryLedger', () => {
  it('opens empty and quarantines corrupt or non-current snapshots without legacy fallback', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'ledger.json')
    const empty = await BartTelemetryLedger.open(path)
    expect(empty.read()).toEqual({ windows: [] })
    await empty.dispose()

    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      generatedAt: observedAt,
      providerId: 'legacy-provider',
      windows: []
    }))
    const currentOnly = await BartTelemetryLedger.open(path, { now: () => 123 })
    expect(currentOnly.read()).toEqual({ windows: [] })
    expect(await readdir(directory)).toContain('ledger.json.corrupt-123')
    await currentOnly.dispose()

    await writeFile(path, '{not-json')
    const corrupt = await BartTelemetryLedger.open(path, { now: () => 124 })
    expect(corrupt.read()).toEqual({ windows: [] })
    expect(await readdir(directory)).toContain('ledger.json.corrupt-124')
    await corrupt.dispose()
  })

  it('keeps independently pre-scoped files isolated without persisting a provider identity', async () => {
    const directory = await temporaryDirectory()
    const firstPath = join(directory, 'first.json')
    const secondPath = join(directory, 'second.json')
    const first = await BartTelemetryLedger.open(firstPath)
    const second = await BartTelemetryLedger.open(secondPath)

    await first.record(windowSample(observedAt, [{ id: 'five-hour', usedPercent: 10 }]))
    await second.record(windowSample(observedAt, [{ id: 'weekly', usedPercent: 20 }]))
    await first.record(generation('first-model', 11, observedAt + 1))
    await second.record(generation('second-model', 22, observedAt + 1))
    await Promise.all([first.flush(), second.flush()])

    const firstSerialized = JSON.parse(await readFile(firstPath, 'utf8')) as Record<string, unknown>
    expect(firstSerialized).not.toHaveProperty('providerId')
    expect(JSON.stringify(firstSerialized)).not.toContain('second-model')
    expect(JSON.stringify(await readFile(secondPath, 'utf8'))).not.toContain('first-model')

    const [reloadedFirst, reloadedSecond] = await Promise.all([
      BartTelemetryLedger.open(firstPath),
      BartTelemetryLedger.open(secondPath)
    ])
    expect(reloadedFirst.read().windows.map(({ id }) => id)).toEqual(['five-hour'])
    expect(reloadedSecond.read().windows.map(({ id }) => id)).toEqual(['weekly'])
    await Promise.all([
      first.dispose(),
      second.dispose(),
      reloadedFirst.dispose(),
      reloadedSecond.dispose()
    ])
  })

  it('accumulates generation facts, keeps raw input as fallback, and treats summary/context safely', async () => {
    const ledger = await openTemporaryLedger()
    await ledger.record(windowSample(observedAt, [
      { id: 'tokens', usedPercent: 20, metering: 'token' },
      { id: 'spend', usedPercent: 30, metering: 'monetary' }
    ]))
    await ledger.record({
      type: 'execution-usage',
      sampleId: 'sample-generation-1',
      executionId: 'execution-1',
      observedAt: observedAt + 1,
      model: '  model-a  ',
      usageKind: 'generation',
      inputTokens: 1_000,
      uncachedInputTokens: 800,
      cachedReadTokens: 100,
      cacheWriteTokens: 50,
      outputTokens: 200,
      reasoningTokens: 25,
      costUsd: 1.25
    })
    await ledger.record({
      type: 'execution-usage',
      sampleId: 'sample-summary-1',
      executionId: 'execution-1',
      observedAt: observedAt + 2,
      model: 'model-a',
      usageKind: 'summary',
      inputTokens: 9_999,
      outputTokens: 9_999,
      costUsd: 0.75
    })
    await ledger.record({
      type: 'execution-usage',
      sampleId: 'sample-context-1',
      executionId: 'execution-1',
      observedAt: observedAt + 3,
      model: 'model-a',
      usageKind: 'context',
      inputTokens: 999_999,
      outputTokens: 999_999,
      costUsd: 99
    })

    const snapshot = ledger.read()
    expect(snapshot.windows.find(({ id }) => id === 'tokens')?.ledger.currentCycle.byModel)
      .toEqual([{
        model: 'model-a',
        usageEvents: 1,
        uncachedInputTokens: 800,
        cachedReadTokens: 100,
        cacheWriteTokens: 50,
        outputTokens: 200,
        reasoningTokens: 25,
        costUsd: 2
      }])
    expect(snapshot.windows.find(({ id }) => id === 'spend')?.ledger.currentCycle.byModel)
      .toEqual([{ model: 'model-a', usageEvents: 1, costUsd: 2 }])

    // read() returns fresh DTOs rather than exposing authoritative rows.
    const mutable = snapshot as unknown as {
      windows: Array<{ ledger: { currentCycle: { byModel: Array<{ model: string }> } } }>
    }
    mutable.windows[0].ledger.currentCycle.byModel[0].model = 'tampered'
    expect(ledger.read().windows[0].ledger.currentCycle.byModel[0].model).toBe('model-a')
    expect(ledger.read().windows[0].ledger.currentCycle.firstReading.at)
      .toBe(new Date(observedAt).toISOString())
    await ledger.dispose()
  })

  it('detects reset boundaries and retains only the three newest completed usage cycles', async () => {
    const ledger = await openTemporaryLedger()
    await ledger.record(windowSample(observedAt, [{
      id: 'rolling',
      usedPercent: 70,
      usedUnits: 700,
      durationMinutes: 1
    }]))

    // Boundary from duration.
    await ledger.record(generation('cycle-1', 1, observedAt + 1))
    await ledger.record(windowSample(observedAt + 61_000, [{
      id: 'rolling', usedPercent: 3, usedUnits: 30, durationMinutes: 1
    }]))
    // A >=30 percentage decline closes the next cycle.
    await ledger.record(generation('cycle-2', 2, observedAt + 61_001))
    await ledger.record(windowSample(observedAt + 62_000, [{
      id: 'rolling', usedPercent: 40, usedUnits: 400
    }]))
    await ledger.record(windowSample(observedAt + 63_000, [{
      id: 'rolling', usedPercent: 10, usedUnits: 100
    }]))
    // Absolute-unit decline plus a one-point percentage decline is a reset.
    await ledger.record(generation('cycle-3', 3, observedAt + 63_001))
    await ledger.record(windowSample(observedAt + 64_000, [{
      id: 'rolling', usedPercent: 25, usedUnits: 250
    }]))
    await ledger.record(windowSample(observedAt + 65_000, [{
      id: 'rolling', usedPercent: 24, usedUnits: 240
    }]))
    // One more completed cycle proves oldest-first retention is capped at 3.
    await ledger.record(generation('cycle-4', 4, observedAt + 65_001))
    await ledger.record(windowSample(observedAt + 66_000, [{
      id: 'rolling', usedPercent: 80, usedUnits: 800
    }]))
    await ledger.record(windowSample(observedAt + 67_000, [{
      id: 'rolling', usedPercent: 49, usedUnits: 490
    }]))

    const cycles = ledger.read().windows[0].ledger.completedCycles
    expect(cycles).toHaveLength(3)
    expect(cycles.map((cycle) => cycle.byModel[0]?.model)).toEqual([
      'cycle-4',
      'cycle-3',
      'cycle-2'
    ])
    await ledger.dispose()
  })

  it('excludes request windows, rejects oversized ids, and bounds model-cardinality growth', async () => {
    const ledger = await openTemporaryLedger()
    await ledger.record(windowSample(observedAt, [
      { id: 'requests', usedPercent: 20, metering: 'request' },
      { id: 'x'.repeat(513), usedPercent: 20 },
      { id: 'tokens', usedPercent: 20 }
    ]))
    for (let index = 0; index < 40; index += 1) {
      await ledger.record(generation(
        `model-${String(index).padStart(2, '0')}`,
        1,
        observedAt + index + 1
      ))
    }

    const snapshot = ledger.read()
    expect(snapshot.windows.map(({ id }) => id)).toEqual(['tokens'])
    const rows = snapshot.windows[0].ledger.currentCycle.byModel
    expect(rows).toHaveLength(32)
    expect(rows.at(-1)).toEqual({
      model: '(other models)',
      usageEvents: 9,
      outputTokens: 9
    })
    await ledger.dispose()
  })

  it('bounds distinct native window growth and retains the most recently observed windows', async () => {
    const ledger = await openTemporaryLedger()
    for (let index = 0; index < 300; index += 1) {
      await ledger.record(windowSample(observedAt + index, [{
        id: `window-${String(index).padStart(3, '0')}`,
        usedPercent: index % 100
      }]))
    }

    const ids = ledger.read().windows.map(({ id }) => id)
    expect(ids).toHaveLength(256)
    expect(ids).not.toContain('window-043')
    expect(ids).toContain('window-044')
    expect(ids).toContain('window-299')
    await ledger.dispose()
  })

  it('uses a 15-second debounce and writes an owner-only atomic snapshot reloadably', async () => {
    vi.useFakeTimers()
    const directory = await temporaryDirectory()
    const path = join(directory, 'ledger.json')
    const writes: string[] = []
    const ledger = await BartTelemetryLedger.open(path, {
      writeSnapshot: async (target, serialized) => {
        writes.push(serialized)
        await writePrivateFileAtomically(target, serialized)
      }
    })
    await ledger.record(windowSample(observedAt, [{ id: 'tokens', usedPercent: 5 }]))
    await vi.advanceTimersByTimeAsync(14_999)
    expect(writes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await ledger.flush()
    expect(writes).toHaveLength(1)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])

    const reloaded = await BartTelemetryLedger.open(path)
    expect(reloaded.read()).toEqual(ledger.read())
    await Promise.all([ledger.dispose(), reloaded.dispose()])
  })

  it('serializes flushes and retains dirty state after a failed write for shutdown retry', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'ledger.json')
    let attempts = 0
    const ledger = await BartTelemetryLedger.open(path, {
      writeSnapshot: async (target, serialized) => {
        attempts += 1
        if (attempts === 1) throw new Error('transient write failure')
        await writePrivateFileAtomically(target, serialized)
      }
    })
    await ledger.record(windowSample(observedAt, [{ id: 'tokens', usedPercent: 5 }]))
    await ledger.record(generation('model-a', 10, observedAt + 1))
    await expect(ledger.flush()).rejects.toThrow('transient write failure')
    await expect(ledger.drain()).resolves.toBeUndefined()
    expect(attempts).toBe(2)

    const reloaded = await BartTelemetryLedger.open(path)
    expect(reloaded.read().windows[0].ledger.currentCycle.byModel).toEqual([{
      model: 'model-a', usageEvents: 1, outputTokens: 10
    }])
    await Promise.all([ledger.dispose(), reloaded.dispose()])
  })

  it('deduplicates opaque execution samples across restart and failed atomic writes', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'ledger.json')
    let attempts = 0
    const ledger = await BartTelemetryLedger.open(path, {
      writeSnapshot: async (target, serialized) => {
        attempts += 1
        if (attempts === 1) throw new Error('first atomic write rejected')
        await writePrivateFileAtomically(target, serialized)
      }
    })
    await ledger.record(windowSample(observedAt, [{ id: 'tokens', usedPercent: 5 }]))
    const first = generation('model-a', 10, observedAt + 1, 'opaque-sample-a')
    await ledger.record(first)
    await expect(ledger.flush()).rejects.toThrow('first atomic write rejected')
    // The failed write leaves both totals and the exact idempotency key
    // authoritative in memory; retrying the event cannot double-count it.
    await ledger.record(first)
    await ledger.drain()

    const reloaded = await BartTelemetryLedger.open(path)
    await reloaded.record({
      ...first,
      // The Core treats sampleId as the complete opaque idempotency boundary;
      // a restarted Thread may legitimately have a different public execution.
      executionId: 'reclaimed-public-execution'
    })
    await reloaded.record(generation(
      'model-a',
      10,
      observedAt + 2,
      'opaque-sample-b'
    ))
    expect(reloaded.read().windows[0].ledger.currentCycle.byModel).toEqual([{
      model: 'model-a', usageEvents: 2, outputTokens: 20
    }])
    await Promise.all([ledger.dispose(), reloaded.dispose()])
  })

  it('persists a no-window sample and backfills it exactly once when the first window arrives', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'ledger.json')
    const first = await BartTelemetryLedger.open(path)
    const unattributed = generation(
      'model-a', 10, observedAt + 1, 'unattributed-before-window'
    )

    await first.record(unattributed)
    await first.flush()
    const queued = JSON.parse(await readFile(path, 'utf8')) as {
      recentSampleIds: string[]
      pendingExecutionSamples: Array<Record<string, unknown>>
    }
    expect(queued.recentSampleIds).toEqual([])
    expect(queued.pendingExecutionSamples).toEqual([expect.objectContaining({
      sampleId: 'unattributed-before-window',
      model: 'model-a',
      usageKind: 'generation',
      outputTokens: 10
    })])
    expect(queued.pendingExecutionSamples[0]).not.toHaveProperty('executionId')
    await first.dispose()

    const reloaded = await BartTelemetryLedger.open(path)
    await reloaded.record(windowSample(observedAt + 2, [{
      id: 'tokens',
      usedPercent: 5
    }]))
    await reloaded.record(unattributed)
    expect(reloaded.read().windows[0].ledger.currentCycle.byModel).toEqual([{
      model: 'model-a', usageEvents: 1, outputTokens: 10
    }])

    await reloaded.record(generation(
      'model-a', 10, observedAt + 3, 'new-after-window'
    ))
    expect(reloaded.read().windows[0].ledger.currentCycle.byModel).toEqual([{
      model: 'model-a', usageEvents: 2, outputTokens: 20
    }])
    await reloaded.dispose()
  })

  it('retains a pending sample across an atomic failure and commits replay plus identity together', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'ledger.json')
    let attempts = 0
    const sample = generation(
      'model-a', 10, observedAt + 1, 'pending-atomic-sample'
    )
    const first = await BartTelemetryLedger.open(path, {
      writeSnapshot: async (target, serialized) => {
        attempts += 1
        if (attempts === 1) throw new Error('pending atomic write rejected')
        await writePrivateFileAtomically(target, serialized)
      }
    })
    await first.record(sample)
    await expect(first.flush()).rejects.toThrow('pending atomic write rejected')
    await first.record(sample)
    await first.drain()
    await first.dispose()

    const second = await BartTelemetryLedger.open(path)
    await second.record(windowSample(observedAt + 2, [{
      id: 'tokens', usedPercent: 5
    }]))
    expect(second.read().windows[0].ledger.currentCycle.byModel).toEqual([{
      model: 'model-a', usageEvents: 1, outputTokens: 10
    }])
    await second.flush()
    await second.dispose()

    const third = await BartTelemetryLedger.open(path)
    await third.record({
      ...sample,
      executionId: 'reclaimed-after-pending-replay'
    })
    expect(third.read().windows[0].ledger.currentCycle.byModel).toEqual([{
      model: 'model-a', usageEvents: 1, outputTokens: 10
    }])
    await third.dispose()
  })

  it('consumes an exact-once sample when every current window is inapplicable', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'ledger.json')
    const first = await BartTelemetryLedger.open(path)
    await first.record(windowSample(observedAt, [{
      id: 'spend',
      metering: 'monetary',
      usedPercent: 5
    }]))
    const tokenOnly = generation(
      'model-a', 10, observedAt + 1, 'token-only-before-token-window'
    )

    await first.record(tokenOnly)
    expect(first.read().windows[0].ledger.currentCycle.byModel).toEqual([])
    await first.flush()
    await first.dispose()

    const reloaded = await BartTelemetryLedger.open(path)
    await reloaded.record(windowSample(observedAt + 2, [{
      id: 'tokens',
      usedPercent: 5
    }]))
    await reloaded.record(tokenOnly)
    expect(reloaded.read().windows.find(({ id }) => id === 'tokens')
      ?.ledger.currentCycle.byModel).toEqual([])

    await reloaded.record(generation(
      'model-a', 10, observedAt + 3, 'new-token-window-sample'
    ))
    expect(reloaded.read().windows.find(({ id }) => id === 'tokens')
      ?.ledger.currentCycle.byModel).toEqual([{
      model: 'model-a', usageEvents: 1, outputTokens: 10
    }])
    await reloaded.dispose()
  })

  it('bounds persisted opaque sample ids and evicts only the oldest identities', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'ledger.json')
    const ledger = await BartTelemetryLedger.open(path)
    await ledger.record(windowSample(observedAt, [{ id: 'tokens', usedPercent: 5 }]))
    for (let index = 0; index < 4_100; index += 1) {
      await ledger.record(generation(
        'bounded-model',
        1,
        observedAt + index + 1,
        `opaque-${index}`
      ))
    }
    await ledger.flush()

    const persisted = JSON.parse(await readFile(path, 'utf8')) as {
      recentSampleIds: string[]
    }
    expect(persisted.recentSampleIds).toHaveLength(4_096)
    expect(persisted.recentSampleIds[0]).toBe('opaque-4')
    expect(persisted.recentSampleIds.at(-1)).toBe('opaque-4099')

    const reloaded = await BartTelemetryLedger.open(path)
    await reloaded.record(generation(
      'bounded-model', 1, observedAt + 5_000, 'opaque-4099'
    ))
    await reloaded.record(generation(
      'bounded-model', 1, observedAt + 5_001, 'opaque-0'
    ))
    expect(reloaded.read().windows[0].ledger.currentCycle.byModel[0]).toEqual({
      model: 'bounded-model', usageEvents: 4_101, outputTokens: 4_101
    })
    await Promise.all([ledger.dispose(), reloaded.dispose()])
  })

  it('bounds pending no-window samples and consumes only overflow identities', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'ledger.json')
    const first = await BartTelemetryLedger.open(path)
    for (let index = 0; index < 4_100; index += 1) {
      await first.record(generation(
        'pending-model',
        1,
        observedAt + index + 1,
        `pending-${index}`
      ))
    }
    await first.flush()

    const persisted = JSON.parse(await readFile(path, 'utf8')) as {
      recentSampleIds: string[]
      pendingExecutionSamples: Array<{ sampleId: string }>
    }
    expect(persisted.recentSampleIds).toEqual([
      'pending-0', 'pending-1', 'pending-2', 'pending-3'
    ])
    expect(persisted.pendingExecutionSamples).toHaveLength(4_096)
    expect(persisted.pendingExecutionSamples[0]?.sampleId).toBe('pending-4')
    expect(persisted.pendingExecutionSamples.at(-1)?.sampleId).toBe('pending-4099')

    await first.dispose()
    const reloaded = await BartTelemetryLedger.open(path)
    await reloaded.record(generation(
      'pending-model', 1, observedAt + 5_001, 'pending-0'
    ))
    await reloaded.record(windowSample(observedAt + 5_000, [{
      id: 'tokens', usedPercent: 5
    }]))
    await reloaded.record(generation(
      'pending-model', 1, observedAt + 5_002, 'pending-new'
    ))
    expect(reloaded.read().windows[0].ledger.currentCycle.byModel).toEqual([{
      model: 'pending-model', usageEvents: 4_097, outputTokens: 4_097
    }])
    await reloaded.dispose()
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bart-telemetry-ledger-'))
  directories.push(directory)
  return directory
}

async function openTemporaryLedger(): Promise<BartTelemetryLedger> {
  const directory = await temporaryDirectory()
  return BartTelemetryLedger.open(join(directory, 'ledger.json'))
}

function windowSample(
  at: number,
  windows: Array<{
    id: string
    usedPercent: number | null
    metering?: 'token' | 'request' | 'monetary' | 'credit'
    usedUnits?: number
    limitUnits?: number
    resetsAt?: string | null
    durationMinutes?: number
  }>
) {
  return {
    type: 'window-reading' as const,
    observedAt: at,
    windows: windows.map((window) => ({
      id: window.id,
      metering: window.metering ?? 'token',
      usedPercent: window.usedPercent,
      ...(window.usedUnits === undefined ? {} : { usedUnits: window.usedUnits }),
      ...(window.limitUnits === undefined ? {} : { limitUnits: window.limitUnits }),
      resetsAt: window.resetsAt ?? null,
      ...(window.durationMinutes === undefined
        ? {}
        : { durationMinutes: window.durationMinutes })
    }))
  }
}

function generation(
  model: string,
  outputTokens: number,
  at: number,
  sampleId = `sample:${model}:${at}`
) {
  return {
    type: 'execution-usage' as const,
    sampleId,
    executionId: `execution-${model}`,
    observedAt: at,
    model,
    usageKind: 'generation' as const,
    outputTokens
  }
}
