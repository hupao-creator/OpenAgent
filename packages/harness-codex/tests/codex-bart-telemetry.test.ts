import { describe, expect, it } from 'vitest'
import {
  createCodexBartTelemetryContributor,
  normalizeCodexBartTelemetry
} from '../src/bart/usage.js'
import {
  type BartTelemetryLedgerSample
} from '@openagent/contracts'

const observedAt = Date.UTC(2026, 7, 10, 2, 0, 0)

describe('Codex Bart account telemetry', () => {
  it('normalizes Codex shared and model-scoped native account windows', () => {
    const snapshot = normalizeCodexBartTelemetry({
      rateLimits: {
        limitId: 'codex',
        primary: {
          usedPercent: 80,
          windowDurationMins: 10_080,
          resetsAt: 1_800_000_000
        },
        planType: 'pro'
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: {
            usedPercent: 80,
            windowDurationMins: 10_080,
            resetsAt: 1_800_000_000
          },
          planType: 'pro'
        },
        codex_spark: {
          limitId: 'codex_spark',
          limitName: 'GPT-5.3-Codex-Spark',
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: 1_800_003_600
          },
          rateLimitReachedType: 'primary'
        }
      }
    }, observedAt)

    expect(snapshot).toMatchObject({
      availability: 'available',
      plan: 'pro',
      limitReached: false
    })
    expect(snapshot.windows).toMatchObject([
      {
        id: 'codex:primary',
        scope: 'provider',
        usedPercent: 80,
        remainingPercent: 20,
        durationMinutes: 10_080,
        exhausted: false,
        metering: 'token'
      },
      {
        id: 'codex_spark:primary',
        scope: 'model',
        selector: 'GPT-5.3-Codex-Spark',
        usedPercent: 100,
        exhausted: true
      }
    ])
  })

  it('records normalized windows and exposes only the scoped Core ledger', async () => {
    const recorded: BartTelemetryLedgerSample[] = []
    const contributor = createCodexBartTelemetryContributor({
      now: () => observedAt,
      telemetryLedger: {
        async record(sample) {
          recorded.push(sample)
        },
        read: () => ({
          windows: [{
            id: 'codex:primary',
            metering: 'token',
            ledger: {
              currentCycle: {
                firstReading: {
                  at: new Date(observedAt).toISOString(),
                  usedPercent: 25
                },
                latestReading: {
                  at: new Date(observedAt).toISOString(),
                  usedPercent: 25
                },
                byModel: []
              },
              completedCycles: []
            }
          }]
        })
      },
      readUsage: async () => ({
        rateLimits: {
          limitId: 'codex',
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: Math.floor((observedAt + 60_000) / 1_000)
          }
        }
      })
    })

    const result = JSON.parse(
      (await contributor({ signal: new AbortController().signal })) || '{}'
    ) as { windows: Array<{ ledger?: unknown }> }
    expect(recorded).toEqual([{
      type: 'window-reading',
      observedAt,
      windows: [{
        id: 'codex:primary',
        metering: 'token',
        usedPercent: 25,
        resetsAt: new Date(observedAt + 60_000).toISOString(),
        durationMinutes: 300
      }]
    }])
    expect(result.windows[0]?.ledger).toBeDefined()
  })

  it('distinguishes unknown native payloads from read errors', async () => {
    // The retired OpenCode variant (connected accounts with no usable windows) covered this same 'unknown' availability path and was removed with its harness, so the codex empty-payload path now carries the unknown-vs-error distinction.
    expect(normalizeCodexBartTelemetry({}, observedAt)).toMatchObject({
      availability: 'unknown',
      limitReached: null,
      windows: []
    })

    const contributor = createCodexBartTelemetryContributor({
      now: () => observedAt,
      readUsage: async () => { throw new Error('account endpoint unavailable') }
    })
    const telemetry = JSON.parse(
      (await contributor({ signal: new AbortController().signal })) || '{}'
    ) as Record<string, unknown>
    expect(telemetry).toMatchObject({
      namespace: 'codex',
      availability: 'error',
      error: 'account endpoint unavailable',
      limitReached: null
    })
  })
})
