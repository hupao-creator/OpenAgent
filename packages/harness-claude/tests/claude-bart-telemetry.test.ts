import { describe, expect, it } from 'vitest'
import {
  normalizeClaudeBartTelemetry
} from '../src/bart/usage.js'

const observedAt = Date.UTC(2026, 7, 10, 2, 0, 0)

describe('Claude Bart account telemetry', () => {
  it('normalizes Claude current shared, family, and model-scoped usage', () => {
    const snapshot = normalizeClaudeBartTelemetry({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: {
          utilization: 25.125,
          resets_at: '2026-08-10T05:00:00Z'
        },
        seven_day_opus: {
          utilization: 100,
          resets_at: '2026-08-14T00:00:00Z'
        },
        model_scoped: [{
          display_name: 'Fable',
          utilization: 72.5,
          resets_at: '2026-08-15T00:00:00Z'
        }]
      }
    }, observedAt)

    expect(snapshot).toMatchObject({
      availability: 'available',
      plan: 'max',
      limitReached: false
    })
    expect(snapshot.windows).toMatchObject([
      {
        id: 'five_hour',
        scope: 'provider',
        usedPercent: 25.13,
        remainingPercent: 74.87,
        pace: {
          expectedUsedPercent: 40,
          deltaPercent: -14.87,
          stage: 'far_under_pace',
          willLastToReset: true
        }
      },
      {
        id: 'seven_day_opus',
        scope: 'model',
        selector: 'opus',
        exhausted: true
      },
      {
        id: 'model_scoped:fable',
        selector: 'Fable',
        usedPercent: 72.5
      }
    ])
  })

})
