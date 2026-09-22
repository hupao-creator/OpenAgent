import type { ProviderPluginDescriptor } from '@openagent/contracts'

export default {
  id: 'deepseek', displayName: 'DeepSeek',
  harnesses: [
    { harnessId: 'claude', format: 'claude-settings-env-v1', scopes: ['harness'] },
    { harnessId: 'codex', format: 'codex-config-v1', scopes: ['harness'] },
    { harnessId: 'pi', format: 'pi-models-v1', scopes: ['harness'] }
  ]
} as const satisfies ProviderPluginDescriptor
