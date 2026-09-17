import type { HarnessProviderOverride } from '@openagent/contracts'

/**
 * 返回 Claude Code `--settings` 中 `env` 段应注入的变量。
 * 端点由 Host 提供，协议路径由 Claude Code 添加。
 */
export function claudeBartHeadlessSettings(
  env: HarnessProviderOverride
): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: env.baseUrl,
    ANTHROPIC_AUTH_TOKEN: env.apiKey,
    ANTHROPIC_API_KEY: env.apiKey,
    ANTHROPIC_MODEL: env.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: env.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: env.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: env.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
  }
}
