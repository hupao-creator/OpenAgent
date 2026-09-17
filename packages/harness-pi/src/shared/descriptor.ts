import type { HarnessPluginDescriptor } from '@openagent/contracts'

export const piDescriptor = {
  id: 'pi', displayName: 'Pi Agent',
  threadCapabilities: {
    instructions: true, threadContext: true, sendContext: true, toolModes: ['exclusive']
  }
} as const satisfies HarnessPluginDescriptor<'pi'>
