import { acquireBartEvaluationSource } from '@openagent/plugin-kit/bart/main'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  ArtificialAnalysisModelFacts,
  parsePersistedArtificialAnalysisSnapshot
} from '@openagent/plugin-kit/bart/main'
import { BartEvaluationFactsStore } from '@openagent/plugin-kit/bart/main'
import { type BartEvaluationFactsSnapshot, type BartEvaluationRelease } from '@openagent/plugin-kit/bart'
import {
  formatBartEvaluationFactsPreamble,
  formatBartEvaluationFactsForNativeModels,
  formatBartEvaluationReleaseFacts,
  MAX_BART_EVALUATION_FORMATTED_BYTES,
  matchBartEvaluationRelease
} from '@openagent/plugin-kit/bart'

function embed(value: unknown): string {
  return JSON.stringify(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

interface IndexConfiguration {
  readonly slug: string
  readonly name: string
  readonly isReasoning: boolean
  readonly effort?: { readonly slug: string }
  readonly release: { readonly slug: string; readonly name: string }
}

function indexPage(configurations: readonly IndexConfiguration[]): string {
  return `<script>self.__next_f.push([1,"c:\\"models\\":${embed(configurations)}"])</script>`
}

function detailPage(model: Record<string, unknown>): string {
  return `<script>self.__next_f.push([1,"c:\\"currentModel\\":${embed(model)}"])</script>`
}

const MODEL: IndexConfiguration = {
  slug: 'zenith-9-1-high',
  name: 'Zenith 9.1 (High)',
  isReasoning: true,
  effort: { slug: 'high' },
  release: { slug: 'zenith-9-1', name: 'Zenith 9.1' }
}

const SECOND_MODEL: IndexConfiguration = {
  slug: 'nova-2-standard',
  name: 'Nova 2',
  isReasoning: false,
  release: { slug: 'nova-2', name: 'Nova 2' }
}

function completeDetail(): Record<string, unknown> {
  return {
    ...MODEL,
    intelligenceIndex: 52.4,
    timescaleData: { medianOutputSpeed: 91.3 },
    intelligenceIndexCostPerTask: { cost: { total: 0.047 } },
    timeToFirstAnswerToken: { total: 1.2 },
    price1mInputTokens: 2.5,
    price1mOutputTokens: 10,
    hle: 0.41,
    terminalbenchV21: 0.72,
    tauBanking: 0.63
  }
}

function release(slug: string, name: string): BartEvaluationRelease {
  return {
    slug,
    name,
    aliases: [],
    evaluations: [{
      slug: `${slug}-evaluation`,
      evaluatedModel: name,
      configuration: { reasoning: true },
      deprecated: false,
      intelligenceIndex: 1,
      medianOutputTokensPerSecond: 1,
      costPerIntelligenceIndexTaskUsd: 1,
      benchmarkScores: { hleText: null, terminalBenchV21: null, tau3Banking: null },
      medianTimeToFirstAnswerTokenSeconds: null,
      inputUsdPer1MTokens: null,
      outputUsdPer1MTokens: null
    }]
  }
}

function available(...releases: BartEvaluationRelease[]): BartEvaluationFactsSnapshot {
  return {
    source: 'test-evaluator',
    observedAt: '2026-08-30T00:00:00.000Z',
    availability: 'available',
    releases
  }
}

describe('provider-neutral Bart evaluation facts', () => {
  it('matches the most-specific canonical release and refuses a tie', () => {
    expect(matchBartEvaluationRelease(
      available(
        release('mimo-v2-5', 'MiMo V2.5'),
        release('mimo-v2-5-pro', 'MiMo V2.5 Pro')
      ),
      { selector: 'opencode-go/mimo-v2.5-pro' }
    )).toMatchObject({ status: 'matched', release: { slug: 'mimo-v2-5-pro' } })

    expect(matchBartEvaluationRelease(
      available(
        release('qwen3-8-max', 'Qwen3.8 Max'),
        release('qwen3-max-preview', 'Qwen3 Max Preview')
      ),
      { selector: 'qwen3.8-max-preview' }
    )).toEqual({ status: 'ambiguous' })
  })

  it('never matches an unavailable snapshot', () => {
    const unavailable = {
      source: 'test-evaluator',
      observedAt: null,
      availability: 'unavailable' as const,
      releases: [release('zenith-9-1', 'Zenith 9.1')]
    }
    expect(matchBartEvaluationRelease(
      unavailable,
      { selector: 'zenith-9.1' }
    )).toEqual({ status: 'unmatched' })
    expect(formatBartEvaluationReleaseFacts(unavailable, { status: 'unmatched' }))
      .toContain('native-supported configurations remain selectable')
  })

  it('omits incomplete and ambiguous evaluation matches without restricting native choices', () => {
    const incomplete: BartEvaluationRelease = {
      slug: 'zenith-9-1',
      name: 'Zenith 9.1',
      aliases: [],
      evaluations: []
    }
    expect(matchBartEvaluationRelease(
      available(incomplete),
      { selector: 'zenith-9.1' }
    )).toEqual({ status: 'unmatched' })
    expect(matchBartEvaluationRelease(
      available(
        release('qwen3-8-max', 'Qwen3.8 Max'),
        release('qwen3-max-preview', 'Qwen3 Max Preview')
      ),
      { selector: 'qwen3.8-max-preview' }
    )).toEqual({ status: 'ambiguous' })
    expect(formatBartEvaluationReleaseFacts(available(), { status: 'unmatched' }))
      .toContain('remains selectable')
    expect(formatBartEvaluationReleaseFacts(available(), { status: 'ambiguous' }))
      .toContain('remains selectable')
  })

  it('runtime-freezes shared facts before a Plugin consumes them', async () => {
    const facts = new ArtificialAnalysisModelFacts({
      store: { load: async () => null, save: async () => undefined },
      now: () => new Date('2026-08-30T00:00:00.000Z'),
      fetchImplementation: vi.fn(async input => String(input).endsWith('/models/')
        ? new Response(indexPage([MODEL]))
        : new Response(detailPage(completeDetail()))) as typeof fetch
    })
    await facts.refresh([['Zenith 9.1']])
    const snapshot = facts.snapshot()

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.releases)).toBe(true)
    expect(Object.isFrozen(snapshot.releases[0].evaluations[0].benchmarkScores)).toBe(true)
  })

  it('formats complete comparison evidence without provider interpretation', () => {
    const snapshot = available(release('zenith-9-1', 'Zenith 9.1'))
    const matched = matchBartEvaluationRelease(snapshot, { selector: 'zenith-9.1' })
    const preamble = formatBartEvaluationFactsPreamble(snapshot)
    const facts = formatBartEvaluationReleaseFacts(snapshot, matched)

    expect(preamble).toContain('Evaluation knowledge observed at: 2026-08-30T00:00:00.000Z')
    expect(preamble).toContain('terminalBenchV21: Terminal-Bench 2.1')
    expect(preamble).toContain('Benchmark score meaning:')
    expect(preamble).toContain('deprecated is evaluator source metadata only')
    expect(preamble).toContain('prefer high-intelligence models for complex planning')
    expect(facts).toContain('deprecated=false')
    expect(facts).toContain('medianOutputTokensPerSecond=1')
    expect(facts).toContain('costPerIntelligenceIndexTaskUsd=1')
    expect(facts).toContain('medianTimeToFirstAnswerTokenSeconds=null')
    expect(facts).toContain('inputUsdPer1MTokens=null')
    expect(facts).toContain('outputUsdPer1MTokens=null')
    expect(facts).toContain('benchmarkScores=hleText:null,terminalBenchV21:null,tau3Banking:null')

    const catalogFacts = formatBartEvaluationFactsForNativeModels(snapshot, [
      { label: 'primary', identity: { selector: 'zenith-9.1' } },
      { label: 'alias', identity: { selector: 'vendor/zenith-9.1' } }
    ])
    expect(catalogFacts.match(/Canonical evaluation release:/g)).toHaveLength(1)
    expect(catalogFacts).toContain('Native catalog identities: primary, alias.')
  })

  it('bounds formatted native facts by UTF-8 bytes for multi-byte labels', () => {
    const snapshot = available(release('zenith-9-1', 'Zenith 9.1'))
    const catalogFacts = formatBartEvaluationFactsForNativeModels(
      snapshot,
      Array.from({ length: 512 }, (_, index) => ({
        label: `${String(index)}-${'模型'.repeat(300)}`,
        identity: { selector: `unmatched-${String(index)}` }
      }))
    )

    expect(Buffer.byteLength(catalogFacts, 'utf8'))
      .toBeLessThanOrEqual(MAX_BART_EVALUATION_FORMATTED_BYTES)
    expect(catalogFacts).toContain(
      'Additional evaluation knowledge omitted by the bounded formatter.'
    )
    expect(catalogFacts).not.toContain('\uFFFD')

    const surrogateBoundary = formatBartEvaluationFactsForNativeModels(snapshot, [{
      label: `${'x'.repeat(510)}${'😀'.repeat(10)}`,
      identity: { selector: 'still-unmatched' }
    }])
    expect(surrogateBoundary).not.toContain('\uFFFD')
  })
})

describe('ArtificialAnalysisModelFacts', () => {
  it('waits for first live facts and publishes quality, speed, cost, and benchmarks', async () => {
    let resolveIndex: ((response: Response) => void) | undefined
    const requested: string[] = []
    const index = new Promise<Response>(resolve => { resolveIndex = resolve })
    const facts = new ArtificialAnalysisModelFacts({
      store: { load: async () => null, save: async () => undefined },
      now: () => new Date('2026-08-30T01:02:03.000Z'),
      fetchImplementation: vi.fn(async input => {
        requested.push(String(input))
        return String(input).endsWith('/models/')
          ? index
          : new Response(detailPage(completeDetail()))
      }) as typeof fetch
    })
    await facts.initialize()
    let settled = false
    const waiting = facts.waitForBootstrap(
      [['native/zenith-9.1', 'Zenith 9.1']],
      new AbortController().signal
    ).finally(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    resolveIndex?.(new Response(indexPage([MODEL, {
      slug: 'unrelated-1',
      name: 'Unrelated 1',
      isReasoning: false,
      release: { slug: 'unrelated-1', name: 'Unrelated 1' }
    }])))

    await expect(waiting).resolves.toEqual({
      source: 'artificial-analysis',
      observedAt: '2026-08-30T01:02:03.000Z',
      availability: 'available',
      releases: [{
        slug: 'zenith-9-1',
        name: 'Zenith 9.1',
        aliases: [],
        evaluations: [{
          slug: 'zenith-9-1-high',
          evaluatedModel: 'Zenith 9.1 (High)',
          configuration: { reasoning: true, effort: 'high' },
          deprecated: false,
          intelligenceIndex: 52.4,
          medianOutputTokensPerSecond: 91.3,
          costPerIntelligenceIndexTaskUsd: 0.047,
          benchmarkScores: {
            hleText: 0.41,
            terminalBenchV21: 0.72,
            tau3Banking: 0.63
          },
          medianTimeToFirstAnswerTokenSeconds: 1.2,
          inputUsdPer1MTokens: 2.5,
          outputUsdPer1MTokens: 10
        }]
      }]
    })
    expect(requested.some(url => url.endsWith('/unrelated-1'))).toBe(false)
  })

  it('reports unavailable facts without a current cache or a usable live index', async () => {
    const facts = new ArtificialAnalysisModelFacts({
      store: { load: async () => null, save: async () => undefined },
      fetchImplementation: vi.fn(async () => new Response('<html>empty</html>')) as typeof fetch
    })
    await facts.initialize()
    await expect(facts.waitForBootstrap(
      [['Zenith 9.1']],
      new AbortController().signal
    )).resolves.toEqual({
      source: 'artificial-analysis',
      observedAt: null,
      availability: 'unavailable',
      releases: []
    })
  })

  it('serializes a distinct cold catalog behind the active generation instead of returning unavailable', async () => {
    let releaseFirstIndex!: () => void
    const firstIndexGate = new Promise<void>(resolve => { releaseFirstIndex = resolve })
    let indexRequests = 0
    const facts = new ArtificialAnalysisModelFacts({
      store: { load: async () => null, save: async () => undefined },
      now: () => new Date('2026-08-30T01:02:03.000Z'),
      fetchImplementation: vi.fn(async input => {
        const url = String(input)
        if (url.endsWith('/models/')) {
          indexRequests += 1
          if (indexRequests === 1) await firstIndexGate
          return new Response(indexPage([MODEL, SECOND_MODEL]))
        }
        return url.endsWith(`/${SECOND_MODEL.slug}`)
          ? new Response(detailPage({ ...completeDetail(), ...SECOND_MODEL }))
          : new Response(detailPage(completeDetail()))
      }) as typeof fetch
    })

    const first = facts.waitForBootstrap(
      [['native/zenith-9.1']],
      new AbortController().signal
    )
    await vi.waitFor(() => expect(indexRequests).toBe(1))
    let secondSettled = false
    const second = facts.waitForBootstrap(
      [['native/nova-2']],
      new AbortController().signal
    ).finally(() => { secondSettled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(secondSettled).toBe(false)

    releaseFirstIndex()
    await expect(first).resolves.toMatchObject({
      availability: 'available',
      releases: [{ slug: 'zenith-9-1' }]
    })
    await expect(second).resolves.toMatchObject({
      availability: 'available',
      releases: expect.arrayContaining([
        expect.objectContaining({ slug: 'zenith-9-1' }),
        expect.objectContaining({ slug: 'nova-2' })
      ])
    })
    expect(indexRequests).toBe(2)
  })

  it('aborts and drains an in-flight cold-start refresh during disposal', async () => {
    let fetchStarted = false
    let fetchAborted = false
    const facts = new ArtificialAnalysisModelFacts({
      store: { load: async () => null, save: async () => undefined },
      fetchImplementation: vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
        fetchStarted = true
        init?.signal?.addEventListener('abort', () => {
          fetchAborted = true
          reject(init.signal?.reason)
        }, { once: true })
      })) as typeof fetch
    })
    const refresh = facts.refresh([['Zenith 9.1']])
    await vi.waitFor(() => expect(fetchStarted).toBe(true))
    await facts.dispose()

    await expect(refresh).resolves.toBe(false)
    expect(fetchAborted).toBe(true)
    expect(facts.snapshot().availability).toBe('unavailable')
  })

  it('uses a current last-known-good cache and rejects every older schema', async () => {
    let stored: unknown
    const seed = new ArtificialAnalysisModelFacts({
      store: { load: async () => null, save: async value => { stored = value } },
      now: () => new Date('2026-08-30T00:00:00.000Z'),
      fetchImplementation: vi.fn(async input => String(input).endsWith('/models/')
        ? new Response(indexPage([MODEL]))
        : new Response(detailPage(completeDetail()))) as typeof fetch
    })
    await seed.refresh([['Zenith 9.1']])

    const warm = new ArtificialAnalysisModelFacts({
      store: { load: async () => stored, save: async () => undefined },
      now: () => new Date('2026-08-30T12:00:00.000Z'),
      fetchImplementation: vi.fn(async () => { throw new Error('must not fetch') }) as typeof fetch
    })
    await warm.initialize()
    await expect(warm.waitForBootstrap(
      [['Zenith 9.1']],
      new AbortController().signal
    )).resolves.toMatchObject({ availability: 'available', releases: [{ slug: 'zenith-9-1' }] })

    expect(parsePersistedArtificialAnalysisSnapshot({
      ...(stored as Record<string, unknown>),
      schemaVersion: 2
    })).toBeUndefined()
    expect(parsePersistedArtificialAnalysisSnapshot({
      ...(stored as Record<string, unknown>),
      legacyModels: []
    })).toBeUndefined()
  })

  it('returns a due warm LKG immediately and publishes the refresh for the next contribution', async () => {
    let stored: unknown
    const seed = new ArtificialAnalysisModelFacts({
      store: { load: async () => null, save: async value => { stored = value } },
      now: () => new Date('2026-08-28T00:00:00.000Z'),
      fetchImplementation: vi.fn(async input => String(input).endsWith('/models/')
        ? new Response(indexPage([MODEL]))
        : new Response(detailPage(completeDetail()))) as typeof fetch
    })
    await seed.refresh([['Zenith 9.1']])

    let resolveIndex: ((response: Response) => void) | undefined
    const deferredIndex = new Promise<Response>(resolve => { resolveIndex = resolve })
    const warm = new ArtificialAnalysisModelFacts({
      store: { load: async () => stored, save: async value => { stored = value } },
      now: () => new Date('2026-08-30T00:00:00.000Z'),
      fetchImplementation: vi.fn(async input => String(input).endsWith('/models/')
        ? deferredIndex
        : new Response(detailPage({
            ...completeDetail(),
            intelligenceIndex: 61
          }))) as typeof fetch
    })
    await warm.initialize()

    const currentFacts = await warm.waitForBootstrap(
      [['Zenith 9.1']],
      new AbortController().signal
    )
    expect(currentFacts.observedAt).toBe('2026-08-28T00:00:00.000Z')
    expect(currentFacts.releases[0].evaluations[0].intelligenceIndex).toBe(52.4)

    const published = warm.refresh([['Zenith 9.1']])
    resolveIndex?.(new Response(indexPage([MODEL])))
    await expect(published).resolves.toBe(true)
    const nextFacts = await warm.waitForBootstrap(
      [['Zenith 9.1']],
      new AbortController().signal
    )
    expect(nextFacts.observedAt).toBe('2026-08-30T00:00:00.000Z')
    expect(nextFacts.releases[0].evaluations[0].intelligenceIndex).toBe(61)
  })

  it('queues a different warm catalog while returning the current LKG immediately', async () => {
    let stored: unknown
    const seed = new ArtificialAnalysisModelFacts({
      store: { load: async () => null, save: async value => { stored = value } },
      now: () => new Date('2026-08-28T00:00:00.000Z'),
      fetchImplementation: vi.fn(async input => String(input).endsWith('/models/')
        ? new Response(indexPage([MODEL]))
        : new Response(detailPage(completeDetail()))) as typeof fetch
    })
    await seed.refresh([['Zenith 9.1']])

    let releaseFirstIndex!: () => void
    const firstIndexGate = new Promise<void>(resolve => { releaseFirstIndex = resolve })
    let indexRequests = 0
    const warm = new ArtificialAnalysisModelFacts({
      store: { load: async () => stored, save: async value => { stored = value } },
      now: () => new Date('2026-08-30T00:00:00.000Z'),
      fetchImplementation: vi.fn(async input => {
        const url = String(input)
        if (url.endsWith('/models/')) {
          indexRequests += 1
          if (indexRequests === 1) await firstIndexGate
          return new Response(indexPage([MODEL, SECOND_MODEL]))
        }
        return url.endsWith(`/${SECOND_MODEL.slug}`)
          ? new Response(detailPage({ ...completeDetail(), ...SECOND_MODEL }))
          : new Response(detailPage(completeDetail()))
      }) as typeof fetch
    })
    await warm.initialize()

    const oldGeneration = await warm.waitForBootstrap(
      [['native/zenith-9.1']],
      new AbortController().signal
    )
    await vi.waitFor(() => expect(indexRequests).toBe(1))
    const concurrentCatalog = await warm.waitForBootstrap(
      [['native/nova-2']],
      new AbortController().signal
    )
    expect(oldGeneration.observedAt).toBe('2026-08-28T00:00:00.000Z')
    expect(concurrentCatalog.releases.map(candidate => candidate.slug))
      .toEqual(['zenith-9-1'])

    const queued = warm.refresh([['native/nova-2']])
    releaseFirstIndex()
    await expect(queued).resolves.toBe(true)
    expect(warm.snapshot().releases.map(candidate => candidate.slug))
      .toEqual(['nova-2', 'zenith-9-1'])
    expect(indexRequests).toBe(2)
  })

  it('keeps last-known-good facts on detail failure but revokes them on valid incomplete evidence', async () => {
    let stored: unknown
    const seed = new ArtificialAnalysisModelFacts({
      store: { load: async () => null, save: async value => { stored = value } },
      now: () => new Date('2026-08-28T00:00:00.000Z'),
      fetchImplementation: vi.fn(async input => String(input).endsWith('/models/')
        ? new Response(indexPage([MODEL]))
        : new Response(detailPage(completeDetail()))) as typeof fetch
    })
    await seed.refresh([['Zenith 9.1']])

    const transientFailure = new ArtificialAnalysisModelFacts({
      store: { load: async () => stored, save: async value => { stored = value } },
      now: () => new Date('2026-08-30T00:00:00.000Z'),
      fetchImplementation: vi.fn(async input => String(input).endsWith('/models/')
        ? new Response(indexPage([MODEL]))
        : new Response('<html>temporarily malformed detail</html>')) as typeof fetch
    })
    await transientFailure.initialize()
    await expect(transientFailure.refresh([['Zenith 9.1']])).resolves.toBe(true)
    expect(transientFailure.snapshot().releases[0].evaluations[0].intelligenceIndex)
      .toBe(52.4)

    const revoked = new ArtificialAnalysisModelFacts({
      store: { load: async () => stored, save: async value => { stored = value } },
      now: () => new Date('2026-08-31T00:00:00.000Z'),
      fetchImplementation: vi.fn(async input => String(input).endsWith('/models/')
        ? new Response(indexPage([MODEL]))
        : new Response(detailPage({
            ...MODEL,
            intelligenceIndex: 52.4,
            timescaleData: { medianOutputSpeed: 91.3 }
          }))) as typeof fetch
    })
    await revoked.initialize()
    await expect(revoked.refresh([['Zenith 9.1']])).resolves.toBe(true)
    expect(revoked.snapshot()).toMatchObject({ availability: 'available', releases: [] })
  })

  it('keeps deprecated complete evidence matchable and deletes a configuration on 410', async () => {
    let stored: unknown
    const seed = new ArtificialAnalysisModelFacts({
      store: { load: async () => null, save: async value => { stored = value } },
      now: () => new Date('2026-08-28T00:00:00.000Z'),
      fetchImplementation: vi.fn(async input => String(input).endsWith('/models/')
        ? new Response(indexPage([MODEL]))
        : new Response(detailPage({ ...completeDetail(), deprecated: true }))) as typeof fetch
    })
    await expect(seed.refresh([['Zenith 9.1']])).resolves.toBe(true)
    const deprecated = seed.snapshot()
    expect(deprecated.releases[0].evaluations[0].deprecated).toBe(true)
    expect(matchBartEvaluationRelease(
      deprecated,
      { selector: 'native/zenith-9.1' }
    )).toMatchObject({ status: 'matched', release: { slug: 'zenith-9-1' } })

    const removed = new ArtificialAnalysisModelFacts({
      store: { load: async () => stored, save: async value => { stored = value } },
      now: () => new Date('2026-08-30T00:00:00.000Z'),
      fetchImplementation: vi.fn(async input => String(input).endsWith('/models/')
        ? new Response(indexPage([MODEL]))
        : new Response(null, { status: 410 })) as typeof fetch
    })
    await removed.initialize()
    await expect(removed.refresh([['Zenith 9.1']])).resolves.toBe(true)
    expect(removed.snapshot()).toMatchObject({ availability: 'available', releases: [] })
  })
})

describe('BartEvaluationFactsStore', () => {
  it('writes only the current v4 sidecar with owner-private permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openagent-evaluation-'))
    const store = new BartEvaluationFactsStore(directory)
    const current = {
      schemaVersion: 1,
      source: 'artificial-analysis',
      observedAt: '2026-08-30T00:00:00.000Z',
      fetchedAt: '2026-08-30T00:00:00.000Z',
      configurations: []
    }
    await store.save(current)

    expect(store.path).toBe(join(
      directory,
      'bart-evaluation-facts.json'
    ))
    expect(JSON.parse(await readFile(store.path, 'utf8'))).toEqual(current)
    expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    await expect(store.save({ ...current, schemaVersion: 2 }))
      .rejects.toThrow('不符合当前格式')
    await expect(store.save({ ...current, legacyModels: [] }))
      .rejects.toThrow('不符合当前格式')
  })
})


describe('Plugin-owned evaluation source leases', () => {
  it('shares one acquisition across leases, keeps the remaining Plugin alive and restores a warm cache', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plugin-evaluation-leases-'))
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).endsWith('/models/')
      ? new Response(indexPage([MODEL])) : new Response(detailPage(completeDetail())))
    const first = acquireBartEvaluationSource(directory)
    const second = acquireBartEvaluationSource(directory)
    const signal = new AbortController().signal
    try {
      const snapshots = await Promise.all([
        first.waitForBootstrap([['Zenith 9.1']], signal),
        second.waitForBootstrap([['Zenith 9.1']], signal)
      ])
      expect(snapshots[0].releases[0].slug).toBe('zenith-9-1')
      expect(snapshots[1]).toEqual(snapshots[0])
      expect(fetcher).toHaveBeenCalledTimes(2)
      await first.dispose()
      expect((await second.waitForBootstrap([['Zenith 9.1']], signal)).availability).toBe('available')
      await second.dispose()
      fetcher.mockImplementation(async () => { throw new Error('offline') })
      const restarted = acquireBartEvaluationSource(directory)
      try {
        expect((await restarted.waitForBootstrap([['Zenith 9.1']], signal)).releases[0].slug).toBe('zenith-9-1')
        expect(fetcher).toHaveBeenCalledTimes(2)
      } finally { await restarted.dispose() }
    } finally {
      await Promise.all([first.dispose(), second.dispose()])
      fetcher.mockRestore()
    }
  })

  it('discovers a newly enabled Plugin catalog despite a fresh warm cache', async () => {
    let stored: unknown
    const first = new ArtificialAnalysisModelFacts({
      store: { load: async () => null, save: async value => { stored = value } },
      fetchImplementation: vi.fn(async input => String(input).endsWith('/models/')
        ? new Response(indexPage([MODEL, SECOND_MODEL])) : new Response(detailPage(completeDetail()))) as typeof fetch
    })
    await first.refresh([['Zenith 9.1']])
    await first.dispose()
    const fetcher = vi.fn(async input => String(input).endsWith('/models/')
      ? new Response(indexPage([MODEL, SECOND_MODEL]))
      : new Response(detailPage({ ...completeDetail(), ...SECOND_MODEL }))) as typeof fetch
    const warm = new ArtificialAnalysisModelFacts({
      store: { load: async () => stored, save: async value => { stored = value } }, fetchImplementation: fetcher
    })
    try {
      await warm.initialize()
      const immediate = await warm.waitForBootstrap([['Nova 2']], new AbortController().signal)
      expect(immediate.releases.map(entry => entry.slug)).toEqual(['zenith-9-1'])
      await vi.waitFor(() => expect(warm.snapshot().releases.map(entry => entry.slug)).toContain('nova-2'))
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally { await warm.dispose() }
  })

  it('cancels one Plugin wait without aborting the peer shared acquisition', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plugin-evaluation-peer-'))
    let finishIndex: (() => void) | undefined
    let requestSignal: AbortSignal | undefined
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/models/')) {
        requestSignal = init?.signal ?? undefined
        await new Promise<void>(resolve => { finishIndex = resolve })
        return new Response(indexPage([MODEL]))
      }
      return new Response(detailPage(completeDetail()))
    })
    const first = acquireBartEvaluationSource(directory)
    const second = acquireBartEvaluationSource(directory)
    try {
      const firstWait = expect(first.waitForBootstrap([['Zenith 9.1']], new AbortController().signal)).rejects.toThrow('disposed')
      const secondWait = second.waitForBootstrap([['Zenith 9.1']], new AbortController().signal)
      await vi.waitFor(() => expect(finishIndex).toBeDefined())
      await first.dispose()
      await firstWait
      expect(requestSignal?.aborted).toBe(false)
      finishIndex!()
      expect((await secondWait).availability).toBe('available')
    } finally {
      finishIndex?.()
      await Promise.all([first.dispose(), second.dispose()])
      fetcher.mockRestore()
    }
  })

  it('last Plugin release aborts and joins in-flight acquisition', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plugin-evaluation-stop-'))
    let requestSignal: AbortSignal | undefined
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined
      requestSignal?.addEventListener('abort', () => reject(requestSignal!.reason), { once: true })
    }))
    const client = acquireBartEvaluationSource(directory)
    try {
      const pending = expect(client.waitForBootstrap([['Zenith 9.1']], new AbortController().signal)).rejects.toThrow('disposed')
      await vi.waitFor(() => expect(requestSignal).toBeDefined())
      await client.dispose()
      expect(requestSignal?.aborted).toBe(true)
      await pending
      await expect(client.waitForBootstrap([], new AbortController().signal)).rejects.toThrow('disposed')
    } finally { await client.dispose(); fetcher.mockRestore() }
  })
})
