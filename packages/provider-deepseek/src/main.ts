import type {
  BartTelemetrySnapshot, JsonObject, ProviderConnectionConfiguration,
  ProviderInjection, ProviderModelIdentity, ProviderPluginModule
} from '@openagent/contracts'
import descriptor from './manifest.js'

const source = 'https://api-docs.deepseek.com/quick_start/pricing/'
const verifiedAt = '2026-09-22T00:00:00.000Z'
const flashAliases = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])

function identity(selector: string, harnessId = ''): ProviderModelIdentity {
  let call = selector
  if (harnessId === 'claude') {
    if (selector.startsWith('claude-opus') || selector === 'opus' || selector === 'opusplan') call = 'deepseek-v4-pro'
    else if (/^claude-(sonnet|haiku)/.test(selector) || /^(sonnet|haiku)(\[1m\])?$/.test(selector)) call = 'deepseek-flash'
  }
  if (flashAliases.has(call)) return {
    selector, displayName: 'DeepSeek V4.1 Flash', evaluationRelease: 'deepseek-v4-1-flash', source, verifiedAt
  }
  if (call === 'deepseek-v4-pro') return {
    selector, displayName: 'DeepSeek V4 Pro 0813', evaluationRelease: 'deepseek-v4-pro',
    source: 'https://artificialanalysis.ai/models/deepseek-v4-pro', verifiedAt: '2026-09-23T00:00:00.000Z'
  }
  return {
    selector, displayName: selector, evaluationRelease: null, source, verifiedAt
  }
}

function official(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? '')
    return url.protocol === 'https:' && url.hostname === 'api.deepseek.com' &&
      !url.port && !url.username && !url.password && !url.search && !url.hash &&
      ['/', '/v1', '/v1/', '/anthropic', '/anthropic/'].includes(url.pathname)
  } catch { return false }
}

const plugin: ProviderPluginModule = {
  descriptor,
  recognizes: observation => observation.kind === 'external' && official(observation.baseUrl),
  connect(configuration, host) {
    if (configuration.baseUrl !== undefined && !official(configuration.baseUrl)) {
      throw new Error('DeepSeek Provider requires the official HTTPS service')
    }
    const model = configuration.model ?? 'deepseek-flash'
    if (!flashAliases.has(model) && model !== 'deepseek-v4-pro') throw new Error('Unsupported DeepSeek call identifier')
    return {
      models: Object.freeze(['deepseek-flash', 'deepseek-v4-pro'].map(value => Object.freeze(identity(value)))),
      identify: identity,
      injection: harnessId => injection(configuration, model, harnessId),
      async readTelemetry(signal) {
        signal.throwIfAborted()
        if (!configuration.apiKey) throw new Error('DeepSeek connection has no readable credential')
        const response = await host.fetch('https://api.deepseek.com/user/balance', {
          headers: { Accept: 'application/json', Authorization: `Bearer ${configuration.apiKey}` },
          redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(7_500)])
        })
        signal.throwIfAborted()
        if (!response.ok) throw new Error(`DeepSeek balance HTTP ${response.status}`)
        return normalizeDeepSeekBalanceTelemetry(await response.json(), host.now())
      }
    }
  }
}

function injection(config: ProviderConnectionConfiguration, model: string, harnessId: string): ProviderInjection {
  if (harnessId === 'claude') return {
    format: 'claude-settings-env-v1', model,
    modelAliases: Object.fromEntries(['default', 'opusplan', ...['opus', 'sonnet', 'haiku'].flatMap(family => [family, `${family}[1m]`])].map(alias => [alias, model])),
    environment: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: config.apiKey, ANTHROPIC_API_KEY: config.apiKey,
      ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    }, configuration: {}
  }
  if (harnessId === 'codex') return {
    format: 'codex-config-v1', model,
    environment: { OPENAGENT_PROVIDER_API_KEY: config.apiKey },
    configuration: {
      config: {
        model, model_provider: 'deepseek', model_reasoning_effort: 'high', web_search: 'disabled',
        features: { shell_snapshot: false },
        model_providers: { deepseek: {
          name: 'DeepSeek', base_url: 'https://api.deepseek.com/', wire_api: 'responses',
          requires_openai_auth: false, env_key: 'OPENAGENT_PROVIDER_API_KEY'
        } }
      },
      model: codexModel(model)
    }
  }
  if (harnessId === 'pi') return {
    format: 'pi-models-v1', model,
    environment: { OPENAGENT_PROVIDER_API_KEY: config.apiKey },
    configuration: {
      provider: 'deepseek',
      models: { providers: { deepseek: {
        baseUrl: 'https://api.deepseek.com', api: 'openai-completions', apiKey: '$OPENAGENT_PROVIDER_API_KEY',
        models: [{ id: model, name: identity(model).displayName, reasoning: true,
          input: flashAliases.has(model) ? ['text', 'image'] : ['text'],
          contextWindow: 1_000_000, maxTokens: 384_000,
          compat: { supportsDeveloperRole: false, thinkingFormat: 'deepseek' } }]
      } } }
    }
  }
  throw new Error('DeepSeek does not support this Harness')
}

function codexModel(model: string): JsonObject {
  return {
    slug: model, display_name: identity(model).displayName, description: identity(model).displayName,
    priority: 0, visibility: 'list', supported_in_api: true, prefer_websockets: false, use_responses_lite: false,
    default_reasoning_level: 'high',
    supported_reasoning_levels: ['high', 'max'].map(effort => ({ effort, description: effort })),
    default_reasoning_summary: 'none', supports_reasoning_summaries: false,
    input_modalities: flashAliases.has(model) ? ['text', 'image'] : ['text'],
    supports_image_detail_original: false, context_window: 1_000_000, max_context_window: 1_000_000,
    auto_compact_token_limit: null, effective_context_window_percent: 95,
    tool_mode: null, shell_type: 'shell_command', apply_patch_tool_type: 'freeform',
    experimental_supported_tools: [], supports_search_tool: false, upgrade: null,
    availability_nux: null, auto_review_model_override: null, default_service_tier: null, service_tiers: [], additional_speed_tiers: []
  }
}

export function normalizeDeepSeekBalanceTelemetry(payload: unknown, observedAt = Date.now()): BartTelemetrySnapshot {
  if (!record(payload) || typeof payload.is_available !== 'boolean' || !Array.isArray(payload.balance_infos)) {
    throw new Error('Invalid DeepSeek balance response')
  }
  const balances = payload.balance_infos.map(value => {
    if (!record(value) || typeof value.currency !== 'string' || !value.currency.trim()) throw new Error('Invalid DeepSeek currency')
    return { currency: value.currency, total: decimal(value.total_balance),
      granted: decimal(value.granted_balance), toppedUp: decimal(value.topped_up_balance) }
  })
  return {
    source: 'DeepSeek GET /user/balance', observedAt, availability: 'available',
    limitReached: !payload.is_available, windows: [], balances,
    note: payload.is_available ? 'This DeepSeek connection balance is the account capacity authority.' : 'DeepSeek reports this account unavailable for requests.'
  }
}

function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid DeepSeek decimal amount')
  return value
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

export default plugin
