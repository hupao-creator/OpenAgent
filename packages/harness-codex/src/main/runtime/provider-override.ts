import type { HarnessProviderOverride } from '@openagent/contracts'

/**
 * 返回 Codex 隔离 `CODEX_HOME/config.toml` 的内容。
 * 模型元数据通过 model_catalog_json 提供；provider 配置本身不注册模型。
 */
export function codexProviderOverrideConfig(
  env: HarnessProviderOverride,
  catalogPath: string
): string {
  const lines = [
    `model = ${tomlString(env.model)}`,
    `model_provider = ${tomlString(env.provider)}`,
    `model_reasoning_effort = "high"`,
    `model_catalog_json = ${tomlString(catalogPath)}`,
    // Native shell snapshots persist exported environment values, including
    // the provider key. An isolated API-key run does not need a login snapshot.
    'features.shell_snapshot = false',
    '',
    `[model_providers.${tomlString(env.provider)}]`,
    `name = ${tomlString(env.provider)}`,
    `base_url = ${tomlString(env.baseUrl + '/v1')}`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    `env_key = "OPENAGENT_PROVIDER_API_KEY"`
  ]
  return lines.join('\n') + '\n'
}

/**
 * Keep the installed CLI's catalog schema, replacing provider-specific capabilities.
 */
export function codexProviderOverrideCatalog(
  catalog: Record<string, unknown>,
  env: HarnessProviderOverride
): Record<string, unknown> {
  const template = Array.isArray(catalog.models) ? catalog.models[0] : undefined
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new Error('Codex bundled model catalog 为空')
  }
  const models = [env.model]
  return {
    ...catalog,
    models: models.map((model, priority) => ({
      ...template,
      slug: model,
      display_name: model,
      description: model,
      priority,
      visibility: 'list',
      supported_in_api: true,
      prefer_websockets: false,
      use_responses_lite: false,
      default_reasoning_level: 'high',
      supported_reasoning_levels: ['low', 'high', 'max'].map((effort) => ({
        effort, description: effort
      })),
      default_reasoning_summary: 'none',
      supports_reasoning_summaries: false,
      input_modalities: model.includes('vision') ? ['text', 'image'] : ['text'],
      supports_image_detail_original: false,
      context_window: 1_048_576,
      max_context_window: 1_048_576,
      auto_compact_token_limit: null,
      effective_context_window_percent: 95,
      tool_mode: null,
      shell_type: 'shell_command',
      apply_patch_tool_type: 'freeform',
      experimental_supported_tools: [],
      supports_search_tool: false,
      upgrade: null,
      availability_nux: null,
      auto_review_model_override: null,
      default_service_tier: null
    }))
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}
