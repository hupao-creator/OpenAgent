import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { ThreadStateStore } from '../src/main/services/thread-state-store'
import { createOpenAgentState } from '../src/shared/openagent-state'
import { createDefaultOpenAgentSettings } from '../src/shared/openagent-settings'

// Opt-in, identical public-store workload before and after the storage switch.
// OPENAGENT_STATE_BENCH=/absolute/result.json pnpm --dir apps/desktop exec vitest run tests/state-persistence-benchmark.test.ts
it.skipIf(!process.env.OPENAGENT_STATE_BENCH)('measures application-state persistence under large concurrent content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-storage-bench-'))
  const transactionMs: number[] = []
  const store = new ThreadStateStore(directory, { persistenceDebounceMs: 10, persistenceMaxWaitMs: 50,
    onTransaction: duration => { transactionMs.push(duration) } })
  let peakDiskBytes = 0
  let diskSample = Promise.resolve()
  const diskSampler = setInterval(() => {
    diskSample = diskSample.then(async () => { peakDiskBytes = Math.max(peakDiskBytes, await diskBytes(directory)) })
  }, 25)
  const lag = monitorEventLoopDelay({ resolution: 5 })
  const memoryStart = process.memoryUsage().rss
  let peakRss = memoryStart
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 5)
  lag.enable()
  const timed = async (operation: () => Promise<unknown>) => {
    const start = performance.now()
    await operation()
    return performance.now() - start
  }
  try {
    const initial = createOpenAgentState({ bartThreadId: 'bart', hostHarnessId: 'codex',
      bartThreadSettings: {}, bartCwd: '/workspace/.bart', createdAt: 1,
      selectedThreadId: 'bart', settings: createDefaultOpenAgentSettings() })
    const payload = 's'.repeat(1024 * 1024)
    const threads = Array.from({ length: 12 }, (_, index) => ({
      id: `thread-${index}`, harnessId: 'codex' as const, archived: false, revision: 0,
      title: 'Storage benchmark', emoji: '🧪', tags: [], cwd: '/workspace', settings: {},
      sessionState: { payload: index === 0 ? payload.repeat(8) : payload },
      observation: { latestExecution: null, backgroundWork: null }, createdAt: 1, updatedAt: 1
    }))
    const initialSaveMs = await timed(() => store.save({ ...initial, threads: [...initial.threads, ...threads] }))
    // 999,999 Unicode characters / almost 4 MB each; aggregate exceeds 50 MiB.
    const reports = Array.from({ length: 16 }, (_, index) => ({
      id: `report-${index}`, title: 'Large report', html: '🧪'.repeat(999_999), tags: [],
      relatedExecutions: [], archived: false, createdAt: 1, updatedAt: 1
    }))
    const streamingMs: number[] = []
    const terminalMs: number[] = []
    const admissionMs: number[] = []
    const reportStart = performance.now()
    const reportWrite = store.commit({ type: 'replace-reports', reports }).then(() => performance.now() - reportStart)
    for (let round = 0; round < 12; round++) {
      await Promise.all(threads.map(async thread => {
        const current = store.read().threads.find(value => value.id === thread.id)!
        streamingMs.push(await timed(() => store.commit({ type: 'replace-thread-session-state',
          threadId: thread.id, expectedRevision: current.revision,
          sessionState: { payload: thread.sessionState.payload, round },
          observation: { latestExecution: { executionId: 'execution', status: 'running', startedAt: 1,
            summary: `Round ${round}` }, backgroundWork: null }, updatedAt: round + 2 })))
      }))
      admissionMs.push(await timed(() => store.flushThread('thread-11')))
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    for (const thread of threads) {
      const current = store.read().threads.find(value => value.id === thread.id)!
      terminalMs.push(await timed(() => store.commit({ type: 'replace-thread-session-state',
        threadId: thread.id, expectedRevision: current.revision, sessionState: current.sessionState,
        observation: { latestExecution: { executionId: 'execution', status: 'completed', startedAt: 1,
          finishedAt: 20, summary: 'Complete' }, backgroundWork: null }, updatedAt: 20 })))
    }
    const reportWriteMs = await reportWrite
    const flushMs = await timed(() => store.flush())
    const shutdownMs = await timed(() => store.close())
    const reopened = new ThreadStateStore(directory)
    const startupMs = await timed(async () => {
      const loaded = await reopened.load()
      expect(loaded?.threads).toHaveLength(13)
      expect(loaded?.reports).toHaveLength(16)
      expect(loaded?.threads.find(thread => thread.id === 'thread-11')?.observation.latestExecution?.status).toBe('completed')
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    clearInterval(diskSampler)
    await diskSample
    const result = { transactionMs: distribution(transactionMs), peakDiskBytes, shutdownMs, runtime: process.versions, platform: process.platform, arch: process.arch,
      workload: { threads: 12, sessionMiB: 19, rounds: 12, reports: 16, reportCharacters: 999_999 },
      initialSaveMs, reportWriteMs, streamingMs: distribution(streamingMs),
      terminalMs: distribution(terminalMs), admissionMs: distribution(admissionMs), flushMs, startupMs,
      eventLoopMs: { p95: lag.percentile(95) / 1e6, p99: lag.percentile(99) / 1e6, max: lag.max / 1e6 },
      memory: { startRss: memoryStart, peakRss, finalRss: process.memoryUsage().rss }, diskBytes: await diskBytes(directory) }
    await writeFile(process.env.OPENAGENT_STATE_BENCH!, JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result))
  } finally {
    clearInterval(sampler)
    lag.disable()
    clearInterval(diskSampler)
    await diskSample
    await store.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)

function distribution(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return { count: sorted.length, p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1)! }
}

async function diskBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true })
  const sizes = await Promise.all(entries.map(async entry => entry.isDirectory()
    ? diskBytes(join(directory, entry.name)) : (await stat(join(directory, entry.name)).catch(error => { if (error.code === 'ENOENT') return { size: 0 }; throw error })).size))
  return sizes.reduce((sum, size) => sum + size, 0)
}
