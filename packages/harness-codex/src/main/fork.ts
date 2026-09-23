import { isJsonValue, type HarnessThreadForkRequest, type HarnessThreadForkResult } from '@openagent/contracts'
import { createEmptyCodexState, decodeCodexState, MAX_CODEX_TURNS } from '../shared/state.js'
import type { CodexThreadSettings } from '../shared/types.js'
import type { CodexRuntime } from './runtime/index.js'

export async function forkCodexThread(
  runtime: CodexRuntime,
  input: HarnessThreadForkRequest<'codex', CodexThreadSettings>
): Promise<HarnessThreadForkResult<CodexThreadSettings>> {
  const { source, signal, request } = input
  signal.throwIfAborted()
  if (request === null || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length) {
    throw new Error('Codex fork request 必须是空 object；只支持当前会话')
  }
  const state = decodeCodexState(source.sessionState)
  if (!state.primarySessionId) throw new Error('Codex source Thread 尚未绑定 Primary Native Session')
  if (state.nativeToolConfiguration || state.nativeToolMode) {
    throw new Error('Codex 不支持 fork 带有注入工具的 Thread')
  }
  if (state.backgroundTerminals.length || state.turns.some(turn =>
    turn.status === 'running' || turn.status === 'waiting-input' ||
    turn.activities.some(activity => activity.status === 'running') ||
    turn.interactions.some(interaction => interaction.status === 'pending'))) {
    throw new Error('等待 Codex Thread 工作结束后才能 fork')
  }
  const { server } = await runtime.server(source.cwd, source.settings.executablePath, signal)
  try {
    const primarySessionId = await server.forkThread({
      sourceSessionId: state.primarySessionId,
      cwd: source.cwd,
      settings: source.settings,
      signal
    })
    signal.throwIfAborted()
    if (primarySessionId === state.primarySessionId) throw new Error('Codex fork 未创建独立 Native Session')
    const sessionState = {
      ...createEmptyCodexState(state.updatedAt),
      primarySessionId,
      ...(state.nativeHistorySeed ? { nativeHistorySeed: state.nativeHistorySeed } : {}),
      forkHistory: [...(state.forkHistory ?? []), ...state.turns].slice(-MAX_CODEX_TURNS)
    }
    if (!isJsonValue(sessionState)) throw new Error('Codex fork sessionState 无效')
    return { sessionState, title: `${Array.from(source.title).slice(0, 53).join('')} (Fork)` }
  } finally {
    await server.dispose()
  }
}
