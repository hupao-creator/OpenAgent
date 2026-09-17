import type { HarnessMainPluginModule } from '@openagent/contracts'
import { piDescriptor } from '../shared/descriptor.js'
import { piJson, piSessionAdapter, piState } from '../shared/state.js'
import type { PiHarnessSettings, PiSettingsPresentation, PiThreadSettings, PiThreadSettingsUpdate } from '../shared/types.js'
import { createPiSettings } from './settings.js'
import { createPiPrompt } from './prompt.js'
import { openPiThread } from './thread/handle.js'

export const piMainModule: HarnessMainPluginModule<'pi', PiHarnessSettings, PiThreadSettings, PiThreadSettingsUpdate, PiThreadSettingsUpdate, PiThreadSettings, PiSettingsPresentation> = {
  id: 'pi', descriptor: piDescriptor, defaultHarnessSettings: { threadSettings: {} },
  createMainPlugin(host) {
    return {
      ...createPiSettings(host), sessionState: piSessionAdapter, prompt: createPiPrompt(host),
      openThread: context => openPiThread(host, context),
      async forkThread({ source, request, signal }) {
        signal.throwIfAborted()
        if (request !== null && (typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length)) throw new Error('Pi forks clone the current branch; historical selectors are unsupported')
        const state = piState(source.sessionState)
        if (state.executions.some(e => ['running', 'waiting-for-user'].includes(e.status))) throw new Error('Wait for the Pi Execution to finish before forking')
        if (!state.nativeSessionJsonl) throw new Error('Pi has no persisted native session to fork; complete a conversation first')
        state.forkSource = { jsonl: state.nativeSessionJsonl }
        delete state.sessionFile
        state.latestExecutionId = null
        return { sessionState: piJson(state) }
      }
    }
  }
}
export default piMainModule
