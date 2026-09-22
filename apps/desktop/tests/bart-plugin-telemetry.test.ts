import { describe, expect, it } from 'vitest'
import type { BartTelemetryLedgerCapability } from '@openagent/contracts'
import {
  calculateBartTelemetryPace
} from '@openagent/plugin-kit/bart'
import { createOpaqueTelemetrySampleId } from '@openagent/plugin-kit/bart/main'
import { createCodexMainPlugin } from '../../../packages/harness-codex/src/main'
import { createClaudeMainPlugin } from '../../../packages/harness-claude/src/main'
import { DEFAULT_CLAUDE_HARNESS_SETTINGS } from '../../../packages/harness-claude/src/shared/settings'

const observedAt = Date.UTC(2026, 7, 10, 2, 0, 0)
const emptyTelemetryLedger: BartTelemetryLedgerCapability = {
  async record() {},
  read: () => ({ windows: [] })
}

describe('Plugin-owned Bart account telemetry', () => {
  it('derives stable opaque sample ids without delimiter collisions or native-id leakage', () => {
    const first = createOpaqueTelemetrySampleId([
      'alpha',
      'thread-1',
      'native-session-1',
      'response-1'
    ])
    expect(first).toBe(
      createOpaqueTelemetrySampleId([
        'alpha',
        'thread-1',
        'native-session-1',
        'response-1'
      ])
    )
    expect(first).not.toBe(
      createOpaqueTelemetrySampleId([
        'alpha',
        'thread-1',
        'native-session-1',
        'response-2'
      ])
    )
    expect(first).not.toBe(
      createOpaqueTelemetrySampleId([
        'alpha',
        'thread-2',
        'native-session-1',
        'response-1'
      ])
    )
    expect(first).not.toBe(
      createOpaqueTelemetrySampleId([
        'alpha',
        'thread-1',
        'native-session-2',
        'response-1'
      ])
    )
    expect(
      createOpaqueTelemetrySampleId(['ab', 'c'])
    ).not.toBe(createOpaqueTelemetrySampleId(['a', 'bc']))
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first).not.toContain('response-1')
    expect(first).not.toContain('native-session-1')
  })

  it('reports unknown capacity when setup fails before backend authority is established', async () => {
    const unavailable = async (): Promise<string> => {
      throw new Error('native unavailable')
    }
    const entries = [
      {
        namespace: 'codex',
        settings: { threadSettings: {} },
        plugin: createCodexMainPlugin({
          dataRoot: '/tmp/openagent-codex-test',
          temporaryWorkspaceRoot: '/tmp/openagent-codex-test',
          resolveExecutable: unavailable,
          environment: async () => ({})
        })
      },
      {
        namespace: 'claude',
        settings: DEFAULT_CLAUDE_HARNESS_SETTINGS,
        plugin: createClaudeMainPlugin({
          resolveExecutable: async () => '/unused/claude',
          environment: async () => { throw new Error('native unavailable') }
        })
      }
    ] as const

    for (const entry of entries) {
      const text = await entry.plugin.bartContextEntries?.telemetry?.({
        settings: entry.settings as never,
        cwd: '/tmp/openagent-telemetry-test',
        telemetryLedger: emptyTelemetryLedger,
        signal: new AbortController().signal
      })
      expect(JSON.parse(text || '{}')).toMatchObject({
        namespace: 'external-provider',
        availability: 'unknown'
      })
      await entry.plugin.dispose?.()
    }
  })

  it('uses one provider-neutral linear pace algorithm', () => {
    expect(calculateBartTelemetryPace(
      50,
      10_080,
      new Date(observedAt + 4 * 24 * 60 * 60 * 1_000).toISOString(),
      observedAt
    )).toEqual({
      expectedUsedPercent: 42.86,
      deltaPercent: 7.14,
      stage: 'over_pace',
      willLastToReset: false,
      etaSeconds: 259_200,
      projectedExhaustionAt: '2026-08-13T02:00:00.000Z',
      sustainableRateMultiplier: 0.75
    })
  })
})
