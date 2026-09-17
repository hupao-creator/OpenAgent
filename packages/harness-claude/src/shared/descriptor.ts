import type { HarnessPluginDescriptor } from '@openagent/contracts'

export const claudeDescriptor = {
  id: 'claude',
  displayName: 'Claude',
  threadCapabilities: {
    instructions: true,
    threadContext: true,
    sendContext: true,
    toolModes: ['extend', 'exclusive']
  }
} as const satisfies HarnessPluginDescriptor<'claude'>
