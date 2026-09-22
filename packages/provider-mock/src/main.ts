import type { BartTelemetrySnapshot, JsonObject, ProviderInjection, ProviderPluginModule } from '@openagent/contracts'
import descriptor from './manifest.js'

/** A real Provider Plugin for the scripted HTTP server. It can never target a remote service. */
const plugin: ProviderPluginModule = {
  descriptor,
  recognizes: () => false,
  connect(config, host) {
    const url = new URL(config.baseUrl ?? '')
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Mock Provider requires an HTTP loopback origin with an explicit port')
    }
    const model = config.model ?? 'mock-model'
    const identity = (selector: string) => ({ selector, displayName: selector,
      evaluationRelease: null, source: 'local scripted LLM server', verifiedAt: '2026-09-22T00:00:00.000Z' })
    return {
      models: [identity(model)], identify: identity,
      injection(harnessId): ProviderInjection {
        const keyEnvironment = { OPENAGENT_PROVIDER_API_KEY: config.apiKey }
        if (harnessId === 'claude') return {
          format: 'claude-settings-env-v1', model, configuration: {},
          modelAliases: Object.fromEntries(['default', 'opus', 'sonnet', 'haiku'].map(alias => [alias, model])),
          environment: { ANTHROPIC_BASE_URL: url.origin, ANTHROPIC_AUTH_TOKEN: config.apiKey,
            ANTHROPIC_API_KEY: config.apiKey, ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
        }
        if (harnessId === 'codex') return {
          format: 'codex-config-v1', model, environment: keyEnvironment,
          configuration: { config: {
            model, model_provider: 'mock', model_reasoning_effort: 'high', features: { shell_snapshot: false },
            model_providers: { mock: { name: 'Mock', base_url: url.origin + '/v1', wire_api: 'responses',
              requires_openai_auth: false, env_key: 'OPENAGENT_PROVIDER_API_KEY' } }
          }, model: modelMetadata(model) }
        }
        if (harnessId === 'pi') return {
          format: 'pi-models-v1', model, environment: keyEnvironment,
          configuration: { provider: 'mock', models: { providers: { mock: {
            baseUrl: url.origin + '/v1', api: 'openai-completions', apiKey: '$OPENAGENT_PROVIDER_API_KEY',
            models: [{ id: model, name: model, reasoning: false, input: ['text'], contextWindow: 1_048_576,
              maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
          } } } }
        }
        throw new Error('Mock Provider does not support this Harness')
      },
      async readTelemetry(signal) {
        const response = await host.fetch(new URL('/openagent-test/telemetry', url), {
          headers: { Authorization: `Bearer ${config.apiKey}` }, redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(7_500)])
        })
        signal.throwIfAborted()
        if (!response.ok) throw new Error('Mock telemetry unavailable')
        const body: unknown = await response.json()
        if (!body || typeof body !== 'object' || !('remaining' in body) || typeof body.remaining !== 'number' ||
          !Number.isFinite(body.remaining) || body.remaining < 0) throw new Error('Invalid mock telemetry')
        return { source: 'Local mock account', observedAt: host.now(), availability: 'available',
          limitReached: body.remaining === 0, windows: [],
          balances: [{ currency: 'TEST', total: String(body.remaining) }] } satisfies BartTelemetrySnapshot
      }
    }
  }
}

function modelMetadata(model: string): JsonObject {
  return {
    slug: model, display_name: model, description: model, priority: 0, visibility: 'list', supported_in_api: true,
    prefer_websockets: false, use_responses_lite: false, default_reasoning_level: 'high',
    supported_reasoning_levels: ['low', 'high', 'max'].map(effort => ({ effort, description: effort })),
    default_reasoning_summary: 'none', supports_reasoning_summaries: false, input_modalities: ['text'],
    supports_image_detail_original: false, context_window: 1_048_576, max_context_window: 1_048_576,
    auto_compact_token_limit: null, effective_context_window_percent: 95, tool_mode: null,
    shell_type: 'shell_command', apply_patch_tool_type: 'freeform', experimental_supported_tools: [],
    supports_search_tool: false, upgrade: null, availability_nux: null, auto_review_model_override: null, default_service_tier: null
  }
}

export default plugin
