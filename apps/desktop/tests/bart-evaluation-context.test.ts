import type { BartTelemetryLedgerCapability } from '@openagent/contracts'
import {
  MAX_BART_EVALUATION_FORMATTED_BYTES,
  type BartEvaluationFactsSnapshot,
  type BartEvaluationModelIdentity,
  type BartEvaluationRelease
} from '@openagent/plugin-kit/bart'
import { createBartEvaluationContext } from '@openagent/plugin-kit/bart/main'
import { describe, expect, it, vi } from 'vitest'

function release(slug: string, name: string): BartEvaluationRelease {
  return {
    slug,
    name,
    aliases: [],
    evaluations: [{
      slug: `${slug}-high`,
      evaluatedModel: name,
      configuration: { reasoning: true, effort: 'high' },
      deprecated: true,
      intelligenceIndex: 0,
      medianOutputTokensPerSecond: 1,
      costPerIntelligenceIndexTaskUsd: 20,
      benchmarkScores: { hleText: 0, terminalBenchV21: null, tau3Banking: 0 },
      medianTimeToFirstAnswerTokenSeconds: null,
      inputUsdPer1MTokens: null,
      outputUsdPer1MTokens: null
    }]
  }
}

function available(...releases: BartEvaluationRelease[]): BartEvaluationFactsSnapshot {
  return {
    source: 'test-evaluator',
    observedAt: '2026-09-08T00:00:00.000Z',
    availability: 'available',
    releases
  }
}

function input(signal = new AbortController().signal) {
  const telemetryLedger: BartTelemetryLedgerCapability = {
    record: vi.fn(async () => undefined),
    read: vi.fn(() => ({ windows: [] }))
  }
  return { settings: { model: 'native/zenith-9.1' }, cwd: '/repo', signal, telemetryLedger }
}

describe('Plugin-owned evaluation context', () => {
  it('loads native identities and contributes final matching facts without passing settings to acquisition', async () => {
    const request = input()
    const identities = [{
      selector: 'native/zenith-current',
      displayName: 'Zenith 9.1',
      aliases: ['zenith-9.1']
    }]
    const loadIdentities = vi.fn(async () => identities)
    const waitForBootstrap = vi.fn(async () => available(release('zenith-9-1', 'Zenith 9.1')))
    const contributor = createBartEvaluationContext({ source: { waitForBootstrap }, loadIdentities })

    const content = await contributor(request)

    expect(loadIdentities).toHaveBeenCalledWith({
      settings: request.settings, cwd: request.cwd, signal: request.signal
    })
    expect(waitForBootstrap).toHaveBeenCalledWith([
      ['native/zenith-current', 'Zenith 9.1', 'zenith-9.1']
    ], request.signal)
    expect(typeof content).toBe('string')
    expect(content).toContain('native/zenith-current')
    expect(content).toContain('Canonical evaluation release: zenith-9-1 (Zenith 9.1).')
    expect(content).toContain('configuration=reasoning:true,effort:high')
    expect(content).toContain('intelligenceIndex=0')
    expect(content).toContain('costPerIntelligenceIndexTaskUsd=20')
    expect(request.telemetryLedger.record).not.toHaveBeenCalled()
    expect(request.telemetryLedger.read).not.toHaveBeenCalled()
  })

  it('leaves missing, ambiguous and poorly evaluated native models available for selection', async () => {
    const request = input()
    const identities = [
      { selector: 'native/zenith-9.1' },
      { selector: 'native/no-evaluation' },
      { selector: 'native/qwen3.8-max-preview' }
    ]
    const contributor = createBartEvaluationContext({
      source: { waitForBootstrap: async () => available(
        release('zenith-9-1', 'Zenith 9.1'),
        release('qwen3-8-max', 'Qwen3.8 Max'),
        release('qwen3-max-preview', 'Qwen3 Max Preview')
      ) },
      loadIdentities: async () => identities
    })

    const content = await contributor(request)

    expect(content).toContain('intelligenceIndex=0')
    expect(content).toContain('deprecated=true')
    expect(content).toContain('Unmeasured native catalog identities: native/no-evaluation.')
    expect(content).toContain('Ambiguous evaluation matches: native/qwen3.8-max-preview.')
    expect(content).toContain('Native-supported models remain selectable regardless of missing or poor evaluation results.')
    expect(content).not.toMatch(/ineligible|admission|native-default|refused/i)
    expect(identities.map(identity => identity.selector)).toEqual([
      'native/zenith-9.1', 'native/no-evaluation', 'native/qwen3.8-max-preview'
    ])
    expect(request.settings).toEqual({ model: 'native/zenith-9.1' })
  })

  it('keeps completed advice unchanged when later source observations change', async () => {
    let facts = available(release('zenith-9-1', 'Zenith 9.1'))
    const contributor = createBartEvaluationContext({
      source: { waitForBootstrap: async () => facts },
      loadIdentities: async () => [{ selector: 'zenith-9.1' }, { selector: 'nova-2' }]
    })
    const first = await contributor(input())
    facts = available(release('nova-2', 'Nova 2'))
    const second = await contributor(input())

    expect(first).toContain('Canonical evaluation release: zenith-9-1')
    expect(first).not.toContain('Canonical evaluation release: nova-2')
    expect(second).toContain('Canonical evaluation release: nova-2')
    expect(second).not.toContain('Canonical evaluation release: zenith-9-1')
  })

  it('omits unavailable advice and isolates acquisition failures from another contributor', async () => {
    const unavailable = createBartEvaluationContext({
      source: { waitForBootstrap: async () => ({ ...available(), availability: 'unavailable', observedAt: null }) },
      loadIdentities: async () => [{ selector: 'zenith-9.1' }]
    })
    const failed = createBartEvaluationContext({
      source: { waitForBootstrap: async () => { throw new Error('evaluator offline') } },
      loadIdentities: async () => [{ selector: 'zenith-9.1' }]
    })
    const healthy = createBartEvaluationContext({
      source: { waitForBootstrap: async () => available(release('zenith-9-1', 'Zenith 9.1')) },
      loadIdentities: async () => [{ selector: 'zenith-9.1' }]
    })

    const [missing, omitted, content] = await Promise.all([
      unavailable(input()), failed(input()), healthy(input())
    ])
    expect(missing).toBeUndefined()
    expect(omitted).toBeUndefined()
    expect(content).toContain('Canonical evaluation release: zenith-9-1')
  })

  it('omits advice if native identities cannot load, without starting acquisition', async () => {
    const waitForBootstrap = vi.fn(async () => available())
    const contributor = createBartEvaluationContext({
      source: { waitForBootstrap },
      loadIdentities: async () => { throw new Error('native catalog unavailable') }
    })

    await expect(contributor(input())).resolves.toBeUndefined()
    expect(waitForBootstrap).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'empty', identities: [] },
    { name: 'noncanonical', identities: [{ selector: ' noncanonical ' }] },
    { name: 'oversized', identities: Array.from({ length: 4097 }, (_, index) => ({ selector: `native/${index}` })) }
  ])('omits $name identity input without starting acquisition', async ({ identities }) => {
    const waitForBootstrap = vi.fn(async () => available())
    const contributor = createBartEvaluationContext({
      source: { waitForBootstrap },
      loadIdentities: async () => identities
    })

    await expect(contributor(input())).resolves.toBeUndefined()
    expect(waitForBootstrap).not.toHaveBeenCalled()
  })

  it('bounds final advice in UTF-8 bytes even for a large multibyte native catalog', async () => {
    const contributor = createBartEvaluationContext({
      source: { waitForBootstrap: async () => available() },
      loadIdentities: async () => Array.from({ length: 512 }, (_, index) => ({
        selector: `native/${index}-${'模'.repeat(240)}`
      }))
    })
    const content = await contributor(input())

    expect(content).toBeDefined()
    expect(Buffer.byteLength(content!, 'utf8')).toBeLessThanOrEqual(MAX_BART_EVALUATION_FORMATTED_BYTES)
    expect(content).toContain('Additional evaluation knowledge omitted by the bounded formatter.')
    expect(content).not.toContain('\uFFFD')
  })

  it('honors a pre-aborted request before loading native identities', async () => {
    const controller = new AbortController()
    const reason = new Error('context cancelled')
    controller.abort(reason)
    const loadIdentities = vi.fn(async () => [{ selector: 'zenith-9.1' }])
    const contributor = createBartEvaluationContext({
      source: { waitForBootstrap: async () => available() }, loadIdentities
    })

    await expect(contributor(input(controller.signal))).rejects.toBe(reason)
    expect(loadIdentities).not.toHaveBeenCalled()
  })

  it('honors cancellation while native identity loading is pending', async () => {
    const controller = new AbortController()
    const reason = new Error('context cancelled')
    let finish!: (value: readonly BartEvaluationModelIdentity[]) => void
    const waitForBootstrap = vi.fn(async () => available())
    const contributor = createBartEvaluationContext({
      source: { waitForBootstrap },
      loadIdentities: () => new Promise(resolve => { finish = resolve })
    })
    const pending = expect(contributor(input(controller.signal))).rejects.toBe(reason)

    controller.abort(reason)
    await pending
    finish([{ selector: 'zenith-9.1' }])
    expect(waitForBootstrap).not.toHaveBeenCalled()
  })

  it('honors cancellation while evaluation acquisition is pending', async () => {
    const controller = new AbortController()
    const reason = new Error('context cancelled')
    let finish!: (value: BartEvaluationFactsSnapshot) => void
    const waitForBootstrap = vi.fn(() => new Promise<BartEvaluationFactsSnapshot>(resolve => { finish = resolve }))
    const contributor = createBartEvaluationContext({
      source: { waitForBootstrap },
      loadIdentities: async () => [{ selector: 'zenith-9.1' }]
    })
    const pending = expect(contributor(input(controller.signal))).rejects.toBe(reason)
    await vi.waitFor(() => expect(waitForBootstrap).toHaveBeenCalledOnce())

    controller.abort(reason)
    await pending
    finish(available())
  })
})
