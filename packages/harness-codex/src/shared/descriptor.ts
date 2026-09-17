import type { HarnessPluginDescriptor } from '@openagent/contracts'

export const codexDescriptor = {
  id: 'codex',
  displayName: 'Codex',
  threadCapabilities: {
    instructions: true,
    threadContext: true,
    sendContext: true,
    toolModes: ['extend', 'exclusive']
  }
} as const satisfies HarnessPluginDescriptor<'codex'>
