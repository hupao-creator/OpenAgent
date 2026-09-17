import { describe, expect, it } from 'vitest'
import {
  normalizeClaudeBartTelemetry,
  normalizeDeepSeekBalanceTelemetry,
  readClaudeBartTelemetry
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

  it('keeps configured DeepSeek monetary balance exact and provider-authored', () => {
    expect(normalizeDeepSeekBalanceTelemetry({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '12.3400',
        granted_balance: '2.3400',
        topped_up_balance: '10.0000'
      }]
    }, observedAt)).toMatchObject({
      availability: 'available',
      limitReached: false,
      balances: [{
        currency: 'CNY',
        total: '12.3400',
        granted: '2.3400',
        toppedUp: '10.0000'
      }]
    })
  })

  it('reads DeepSeek balance only for the exact official HTTPS host', async () => {
    let requested = ''
    let authorization = ''
    let nativeReads = 0
    const exact = await readClaudeBartTelemetry({
      cwd: '/tmp/openagent-claude-telemetry',
      environment: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'deepseek-token'
      },
      signal: new AbortController().signal,
      now: observedAt,
      readNativeUsage: async () => {
        nativeReads += 1
        return {}
      },
      fetchBalance: async (url, init) => {
        requested = String(url)
        authorization = new Headers(init?.headers).get('authorization') || ''
        return {
          ok: true,
          status: 200,
          json: async () => ({
            is_available: true,
            balance_infos: [{
              currency: 'USD',
              total_balance: '3.00',
              granted_balance: '1.00',
              topped_up_balance: '2.00'
            }]
          })
        }
      }
    })
    expect(exact.source).toBe('DeepSeek GET /user/balance')
    expect(requested).toBe('https://api.deepseek.com/user/balance')
    expect(authorization).toBe('Bearer deepseek-token')
    expect(nativeReads).toBe(0)

    let leaked = false
    const proxy = await readClaudeBartTelemetry({
      cwd: '/tmp/openagent-claude-telemetry',
      environment: {
        ANTHROPIC_BASE_URL: 'https://proxy.example/v1',
        ANTHROPIC_AUTH_TOKEN: 'must-not-leak'
      },
      signal: new AbortController().signal,
      now: observedAt,
      readNativeUsage: async () => ({
        subscription_type: null,
        rate_limits_available: false,
        rate_limits: null
      }),
      fetchBalance: async () => {
        leaked = true
        throw new Error('must not run')
      }
    })
    expect(proxy).toMatchObject({
      source: 'Claude Code get_usage',
      availability: 'not_applicable'
    })
    expect(leaked).toBe(false)
  })
})
