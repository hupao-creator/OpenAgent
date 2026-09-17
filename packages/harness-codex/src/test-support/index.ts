import type { JsonValue } from '@openagent/contracts'
import { isJsonObject } from '@openagent/contracts'
import type { HarnessNativeTestAdapter } from '@openagent/test-kit'
import { codexDescriptor as descriptor } from '../shared/descriptor.js'

/**
 * Codex 原生测试 Adapter：只承载真实 Codex CLI 的协议事实（headless 验收与
 * 透明原生协议录制得来的知识），供通用 runner 驱动流程、断言与会话治理。
 * 生产代码不得导入本模块。
 */
const codexNativeTestAdapter: HarnessNativeTestAdapter = {
  id: 'codex',
  displayName: 'Codex',
  descriptor,
  // 真实 Codex CLI 在 headless 验收里能覆盖的场景：纯回答、shell、权限交互、后台任务。
  scenarioCapabilities: ['plain', 'shell', 'permission', 'background'],
  // 观测场景的最小权限 Thread 设置（Codex 原生 app-server 配置字段）。
  observationThreadSettings: { permissionMode: 'ask-for-approval' },
  // 原生代理要直接触碰文件系统时必须显式要到的 Thread 设置，绕开权限交互。
  permissiveThreadSettings: { permissionMode: 'full-access' },
  // Codex 的原生工具名：permission shell；question/plan 来自真实 CLI 工具集，
  // 供场景采集使用（它们不在验收矩阵 capabilities 里，属于能力 profile 而非绝对能力）。
  nativeTools: { permission: 'shell', question: 'experimental_request_user_input', plan: 'update_plan' },
  llmShellCall({ command, toolNames, permission, background }) {
    const name = ['exec_command', 'shell_command', 'shell'].find(tool => toolNames.includes(tool))
    if (!name) return null
    return { name, args: {
      ...(name === 'exec_command' ? { cmd: command, yield_time_ms: background ? 1000 : 10000 }
        : name === 'shell' ? { command: ['sh', '-c', command] } : { command }),
      ...(permission ? { sandbox_permissions: 'require_escalated', justification: 'Execute the native permission acceptance proof.' } : {})
    } }
  },
  llmNotificationReply({ lastMessage, messages }) {
    if (!lastMessage.startsWith('<task-notification>\nOne or more Codex background commands completed.')) return null
    const activities = [...lastMessage.matchAll(/- activity: ([^;]+); status: (\w+)/g)]
    if (!activities.length) throw new Error('Background notification omitted activity facts')
    for (const [, id] of activities) {
      if (!messages.some(message => message.role === 'tool' && message.toolCallId === id)) {
        throw new Error('Background notification references an absent native tool result')
      }
    }
    return activities.map(([, id, status]) => `Observed ${id}: ${status}`).join('\n')
  },
  llmContinueShellCall({ result, toolNames }) {
    const session = result.match(/Process running with session ID (\d+)/)?.[1]
    return session && toolNames.includes('write_stdin')
      ? { name: 'write_stdin', args: { session_id: Number(session), chars: '', yield_time_ms: 1000 } } : null
  },
  llmMetadataContext: ({ format, messages }) => format === 'responses'
    ? { content: messages.map(message => message.content).join('\n') } : null,
  scenarioDialect: {
    permissionEscalation: '设置 sandbox_permissions 为 require_escalated 并给出权限理由。',
    backgroundTool: 'exec_command',
    backgroundLaunchFlags: 'yield_time_ms 1000',
    backgroundFollowUp: '请执行 sleep 30，不要放入后台，等待它完成。',
  },
  // 透明原生协议录制 wrapper 不需要 Codex 特有的额外参数。
  recorderArgs: [],
  nativeSessionIdentity(sessionState) {
    // 插件发布的 Codex 会话状态把 Primary Session id 放在顶层；结构化收窄，
    // 缺失或非字符串一律视为未发布。
    if (typeof sessionState !== 'object' || sessionState === null || Array.isArray(sessionState)) {
      return null
    }
    const { primarySessionId } = sessionState as { primarySessionId?: JsonValue }
    return typeof primarySessionId === 'string' && primarySessionId ? primarySessionId : null
  },
  nativeModelEvidence(events) {
    // 只解析 stdout 方向的 JSONL 帧。wrapper 可能分片写同一个进程的 stdout，
    // 先按 wrapper 进程聚合再逐行解析，避免半帧解析失败。
    const stdoutByProcess = new Map<number | undefined, string>()
    for (const event of events) {
      if (event.direction !== 'stdout') continue
      stdoutByProcess.set(event.wrapperPid, (stdoutByProcess.get(event.wrapperPid) ?? '') + (event.text ?? ''))
    }
    const models = new Set<string>()
    for (const stdout of stdoutByProcess.values()) {
      for (const line of stdout.split('\n')) {
        let frame: unknown
        try {
          frame = JSON.parse(line)
        } catch {
          continue
        }
        if (typeof frame !== 'object' || frame === null) continue
        const model = (frame as { result?: { model?: unknown } }).result?.model
        if (typeof model === 'string') models.add(model)
      }
    }
    return [...models].filter(model => model && model !== 'unknown')
  },
  sessionModelEvidence(state) {
    if (!isJsonObject(state)) return []
    return [...new Set([
      isJsonObject(state.runtime) ? state.runtime.model : undefined,
      ...(Array.isArray(state.turns) ? state.turns.filter(isJsonObject).map(turn => turn.runtimeModel) : [])
    ].filter((model): model is string => typeof model === 'string' && Boolean(model)))]
  },
  // Codex 按请求原样上报模型名；未指定模型时交给原生默认。
  qualifyRequestedModel: ({ model }) => model,
  // Codex 没有"原生别名在运行期落到具体模型"的行为，模型名可以精确相等。
  isNativeAliasModel: () => false,
  // Codex 的动态工具 schema 绑定在 Thread 上：替换 schema 必须轮换原生会话。
  rotatesSessionOnSchemaChange: true,
  missingExecutableThreadSettings: (harnessId) => ({
    // 缺失可执行文件失败场景：Thread 设置指向一个不存在的路径。
    executablePath: `missing-${harnessId}-executable`
  })
}

export default codexNativeTestAdapter
