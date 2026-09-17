import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isJsonObject } from '@openagent/contracts'
import type { HarnessNativeTestAdapter, NativeProtocolEvent } from '@openagent/test-kit'
import { claudeDescriptor as descriptor } from '../shared/descriptor.js'

/**
 * Claude Code native test adapter. This file owns the real Claude CLI facts the
 * native acceptance suites used to keep in Desktop scripts: the permission
 * modes Claude headless runs under, the native tool names the acceptance
 * scenarios drive, and the model/session identities Claude publishes in its
 * stream-json protocol. It describes the real system only — no fake transport,
 * no simulated tools, and no expected result derived from output under test.
 */
const claudeNativeTestAdapter: HarnessNativeTestAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  descriptor,
  // Scenarios the real Claude CLI supports headless. `question`/`question-cancel`
  // ride on the native AskUserQuestion tool.
  scenarioCapabilities: ['plain', 'shell', 'permission', 'question', 'question-cancel'],
  // Least-privilege observation runs still surface the native permission prompt.
  observationThreadSettings: { permissionMode: 'manual' },
  // Lets the native agent touch the filesystem without a permission interaction.
  permissiveThreadSettings: { permissionMode: 'bypassPermissions' },
  nativeTools: { permission: 'Bash', question: 'AskUserQuestion', plan: 'TodoWrite' },
  llmShellCall: ({ command, toolNames, background }) => toolNames.includes('Bash')
    ? { name: 'Bash', args: { command, ...(background ? { run_in_background: true } : {}) } } : null,
  llmReadCall: ({ path, toolNames }) => toolNames.includes('Read')
    ? { name: 'Read', args: { file_path: path } } : null,
  llmQuestionCall: ({ toolNames, options, multiple }) => toolNames.includes('AskUserQuestion')
    ? { name: 'AskUserQuestion', args: { questions: [{ question: multiple ? 'Select two acceptance values' : 'Select the acceptance value',
      header: 'Choice', multiSelect: multiple, options: options.map(label => ({ label, description: label })) }] } } : null,
  llmMetadataContext: ({ format, messages, toolNames }) => format === 'anthropic'
    ? { content: messages.map(message => message.content).join('\n'), replyTool: toolNames.find(name => name === 'StructuredOutput') } : null,
  scenarioDialect: {
    backgroundLaunchFlags: '设置 run_in_background=true',
    backgroundFollowUp: '请调用原生问答工具，询问“是否继续后台检查？”，提供“继续”和“稍后”选项。等待回答。',
  },
  // Claude's stream-json protocol is line-delimited JSON on stdout already, so
  // the transparent recorder wrapper needs no extra CLI arguments.
  recorderArgs: [],
  nativeSessionIdentity: sessionState => {
    // The plugin publishes an opaque JsonValue session state; Claude's native
    // identity is the top-level primarySessionId string.
    if (!isJsonObject(sessionState)) return null
    const primarySessionId = sessionState.primarySessionId
    return typeof primarySessionId === 'string' ? primarySessionId : null
  },
  nativeModelEvidence: events => collectClaudeNativeModels(events),
  sessionModelEvidence(state) {
    if (!isJsonObject(state)) return []
    return [...new Set([
      isJsonObject(state.runtime) ? state.runtime.model : undefined,
      ...(Array.isArray(state.turns) ? state.turns.filter(isJsonObject).map(turn => turn.runtimeModel) : [])
    ].filter((model): model is string => typeof model === 'string' && Boolean(model)))]
  },
  qualifyRequestedModel: ({ model }) => model,
  // Claude resolves these aliases (including the 1m-context variants) to dated
  // concrete models at runtime, so native evidence never matches them verbatim.
  isNativeAliasModel: requested => /^(default|sonnet|opus|haiku)(\[1m\])?$/.test(requested ?? ''),
  rotatesSessionOnSchemaChange: false,
  missingExecutableThreadSettings: harnessId => ({
    // A path that cannot exist: the scenario expects the failure the missing
    // CLI produces, not a directory or an unrelated executable.
    executablePath: join(tmpdir(), `openagent-missing-${harnessId}-executable`)
  })
}

export default claudeNativeTestAdapter

/**
 * Collect the concrete model identities Claude actually reported in its native
 * protocol frames: the `system`/`init` frame carries the session model, and
 * every key of a `result` frame's `modelUsage` is a model the execution used.
 */
function collectClaudeNativeModels(events: readonly NativeProtocolEvent[]): string[] {
  // Stdout arrives chunked per wrapper process; gather each process's stream
  // before splitting it into protocol frames.
  const stdoutByProcess = new Map<number, string>()
  for (const event of events) {
    if (event.direction !== 'stdout') continue
    const wrapperPid = event.wrapperPid ?? 0
    stdoutByProcess.set(wrapperPid, (stdoutByProcess.get(wrapperPid) ?? '') + (event.text ?? ''))
  }
  const models = new Set<string>()
  for (const stdout of stdoutByProcess.values()) {
    for (const line of stdout.split('\n')) {
      let frame: unknown
      try { frame = JSON.parse(line) } catch { continue }
      if (!isJsonObject(frame)) continue
      if (frame.type === 'system' && frame.subtype === 'init' && typeof frame.model === 'string') {
        models.add(frame.model)
      }
      if (frame.type === 'result' && isJsonObject(frame.modelUsage)) {
        for (const model of Object.keys(frame.modelUsage)) models.add(model)
      }
    }
  }
  return [...models].filter(model => model !== '' && model !== 'unknown')
}
