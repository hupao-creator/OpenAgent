import { isJsonObject } from '@openagent/contracts'
import type { HarnessNativeTestAdapter, NativeProtocolEvent } from '@openagent/test-kit'
import { piDescriptor as descriptor } from '../shared/descriptor.js'

/**
 * Pi Agent native test adapter. This file owns the real Pi CLI facts the native
 * acceptance suites used to keep in Desktop scripts: the headless scenarios Pi
 * genuinely supports, the fd3 bridge argument the transparent recorder wrapper
 * needs, and the session/model identities Pi publishes in its RPC protocol. It
 * describes the real system only — no fake transport, no simulated tools, and
 * no expected result derived from output under test.
 */
const piNativeTestAdapter: HarnessNativeTestAdapter = {
  id: 'pi',
  displayName: 'Pi Agent',
  descriptor,
  // Scenarios the real Pi CLI supports headless. Pi has no built-in per-tool
  // permission prompt and no native question/background acceptance scenario.
  scenarioCapabilities: ['plain', 'shell'],
  // Pi's Agent defaults are already least-privilege, and its settings reject
  // every additional Thread field, so both configurations stay empty.
  observationThreadSettings: {},
  permissiveThreadSettings: {},
  nativeTools: {},
  llmShellCall: ({ command, toolNames }) => toolNames.includes('bash')
    ? { name: 'bash', args: { command } } : null,
  llmMetadataContext: ({ format, messages }) => format === 'openai' ? {
    content: messages.map(message => message.content.split('\n').map(line => {
      try {
        const decoded = JSON.parse(line)
        return typeof decoded.content === 'string' ? decoded.content : line
      } catch { return line }
    }).join('\n')).join('\n')
  } : null,
  // Pi bridges the recorder's fd3 to its RPC transport, so the wrapper must
  // preserve that descriptor for the Host pipe to survive the wrapper.
  recorderArgs: ['--preserve-fd3'],
  nativeSessionIdentity: sessionState => {
    // The plugin publishes an opaque JsonValue session state; Pi's native
    // identity is the top-level sessionFile string of the live native session.
    if (!isJsonObject(sessionState)) return null
    const sessionFile = sessionState.sessionFile
    return typeof sessionFile === 'string' && sessionFile ? sessionFile : null
  },
  nativeModelEvidence: events => collectPiNativeModels(events),
  sessionModelEvidence(state) {
    if (!isJsonObject(state) || !Array.isArray(state.messages)) return []
    return [...new Set(state.messages.filter(isJsonObject)
      .filter(message => message.role === 'assistant' && typeof message.provider === 'string' && typeof message.model === 'string')
      .map(message => `${message.provider}/${message.model}`))]
  },
  // Pi reports provider-qualified models, so the requested model is rendered
  // the way the native protocol echoes it back.
  qualifyRequestedModel: ({ model, provider }) =>
    model ? (provider ? `${provider}/${model}` : model) : undefined,
  // Pi resolves exact provider/model pairs only; it has no native aliases.
  isNativeAliasModel: () => false,
  rotatesSessionOnSchemaChange: false,
  missingExecutableThreadSettings: () => {
    // Pi rejects unknown Thread fields, and the host always auto-detects its
    // executable: the missing-CLI failure cannot be expressed through Thread
    // options. Declaring the scenario unsupported makes generic runners
    // diagnose it instead of failing differently per harness.
    return null
  }
}

export default piNativeTestAdapter

/**
 * Collect the concrete model identities Pi actually reported in its native
 * protocol frames: every `message_end` assistant frame carries the provider
 * and model the execution used.
 */
function collectPiNativeModels(events: readonly NativeProtocolEvent[]): string[] {
  // Stdout arrives chunked per wrapper process; gather each process's stream
  // before splitting it into protocol frames.
  const stdoutByProcess = new Map<number | undefined, string>()
  for (const event of events) {
    if (event.direction !== 'stdout') continue
    stdoutByProcess.set(event.wrapperPid, (stdoutByProcess.get(event.wrapperPid) ?? '') + (event.text ?? ''))
  }
  const models = new Set<string>()
  for (const stdout of stdoutByProcess.values()) {
    for (const line of stdout.split('\n')) {
      let frame: unknown
      try { frame = JSON.parse(line) } catch { continue }
      if (!isJsonObject(frame)) continue
      if (frame.type === 'message_end' && isJsonObject(frame.message) &&
          frame.message.role === 'assistant' &&
          typeof frame.message.provider === 'string' && typeof frame.message.model === 'string') {
        models.add(`${frame.message.provider}/${frame.message.model}`)
      }
    }
  }
  return [...models].filter(model => model !== '' && model !== 'unknown')
}
