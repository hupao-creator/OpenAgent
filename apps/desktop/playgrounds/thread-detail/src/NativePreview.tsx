import { useEffect, useMemo, useState } from 'react'
import type { AgentThreadRecord } from '@openagent/contracts'
import { AgentThreadWorkspace } from '../../../src/renderer/src/components/AgentThreadWorkspace'
import { BartThreadView } from '../../../src/renderer/src/components/BartThreadView'
import type { ThreadInteractionResponseRequest } from '../../../src/shared/desktop-api'
import { answer, type Phase, type PreviewHarness, type Scenario, type ThreadKind } from './fixtures'
import { localConversation } from './native-fixtures/local-conversation'
import { createCodexPreview } from './native-fixtures/codex'
import { createClaudePreview } from './native-fixtures/claude'
import { browserRendererCapabilities } from './browser-capabilities'

const fixtures = { codex: createCodexPreview, claude: createClaudePreview }

// Preview supports local interactions and browser navigation, with no preload bridge.
const previewHostActions = {
  invokeHarnessExtension: async (): Promise<never> => { throw new Error('此原生操作请在桌面应用中使用。') },
  forkThread: async (): Promise<never> => { throw new Error('会话分支请在桌面应用中创建。') },
  openExternal: browserRendererCapabilities.openExternal
}

/** Uses production Core composition and Plugin renderers; only input data/actions are simulated. */
export function NativePreview(props: {
  readonly harness: PreviewHarness
  readonly scenario: Scenario
  readonly kind: ThreadKind
  readonly onBack: () => void
  readonly onNotice: (message: string) => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>(props.scenario.phase)
  const [progress, setProgress] = useState(phase === 'running' ? .08 : phase === 'interrupted' ? .4 : 1)
  const [playing, setPlaying] = useState(true)
  const [draft, setDraft] = useState('')
  const [followUp, setFollowUp] = useState(false)
  const [lastResponse, setLastResponse] = useState('')
  const active = phase === 'running'
  useEffect(() => {
    if (!active || !playing) return
    const timer = window.setInterval(() => setProgress((value) => Math.min(1, value + .018)), 240)
    return () => window.clearInterval(timer)
  }, [active, playing])
  useEffect(() => {
    if (active && progress >= 1) setPhase('completed')
  }, [active, progress])
  const threadId = `preview:${props.harness.id}:${props.kind}:${props.scenario.id}`
  const fixture = useMemo(() => fixtures[props.harness.id]({
    threadId,
    phase,
    history: props.scenario.id === 'history',
    localFive: props.scenario.id === 'local-five',
    answer: active || phase === 'interrupted' ? answer.slice(0, Math.floor(answer.length * progress)) : answer
  }), [threadId, props.harness.id, props.scenario.id, phase, progress, active])
  const thread: AgentThreadRecord = {
    id: threadId,
    archived: false,
    harnessId: props.harness.id,
    title: props.scenario.id === 'local-five' ? 'Message List Playground 的五轮迭代' : '为项目列表添加搜索与筛选',
    cwd: '/workspace/OpenAgent',
    tags: ['开发任务'], settings: {}, revision: Math.floor(progress * 1_000),
    createdAt: Date.parse(props.scenario.id === 'local-five' ? localConversation[0].createdAt : '2026-09-07T06:28:00Z'),
    updatedAt: Date.parse(props.scenario.id === 'local-five' ? localConversation[4].completedAt : '2026-09-07T06:32:00Z'),
    ...fixture
  }
  const start = (): void => { setProgress(.04); setPlaying(true); setPhase('running') }
  const stop = async (): Promise<void> => { setPhase('interrupted') }
  const respond = async (request: ThreadInteractionResponseRequest): Promise<void> => {
    const execution = fixture.observation.latestExecution
    const interaction = execution?.status === 'waiting-for-user'
      ? execution.interactions.find((item) => item.id === request.interactionId) : undefined
    const action = interaction?.actions.find((item) => item.id === request.actionId)
    if (!action) throw new Error('该样例请求已结束，请重置场景。')
    setLastResponse(JSON.stringify(request, null, 2))
    if (action.intent === 'deny' || action.intent === 'cancel') await stop()
    else start()
    props.onNotice('插件已提交回应；执行状态由本地样例继续模拟。')
  }
  const send = (): void => {
    if (props.scenario.id === 'local-five') { props.onNotice('这是五轮历史摘录，不能继续执行。'); return }
    if (!draft.trim()) return
    setLastResponse(JSON.stringify({ input: draft.trim() }, null, 2))
    setDraft(''); setFollowUp(false); start()
    props.onNotice('已接收本地样例输入，回复使用固定演示内容。')
  }
  const openFollowUp = (_threadId: string, initialDraft = ''): void => {
    if (props.scenario.id === 'local-five') { props.onNotice('这是五轮历史摘录，不能继续执行。'); return }
    setDraft(initialDraft); setFollowUp(true)
  }
  return <div className="pg-native-shell">
    <div className="pg-native-controls">
      <span>{props.scenario.id === 'local-five' ? '本机 Codex 记录 · 5 轮 · 当前 Harness 展示适配 · 无 token 统计' : '正式插件渲染 · 固定协议数据（含用量样例）'}</span>
      {active ? <button type="button" onClick={() => setPlaying(!playing)}>
        {playing ? '暂停演示' : '继续演示'}
      </button> : null}
      {phase === 'failed' || phase === 'interrupted' ? <button type="button" onClick={start}>重试演示</button> : null}
      {lastResponse ? <details><summary>最近提交</summary><pre>{lastResponse}</pre></details> : null}
    </div>
    <div className="pg-native-content">
      {props.kind === 'bart' ? <BartThreadView
        hostActions={previewHostActions}
        thread={{ ...thread, bart: true, transcript: [] }}
        execution={null} inputValue={draft} attachments={[]} submitting={false} clearing={false} error=""
        backLabel="Thread 详情" onBack={props.onBack}
        onSettings={() => props.onNotice('插件设置请在桌面应用中调整。')}
        onInputChange={setDraft}
        onChooseFiles={() => props.onNotice('本地样例已包含附件，请通过“显示用户消息”查看。')}
        onPasteFiles={() => props.onNotice('文件操作请在桌面应用中使用。')}
        onRemoveAttachment={() => undefined}
        onSubmit={send} onCancel={stop} onClear={() => { setPhase('empty'); setLastResponse('') }} respond={respond}
      /> : <AgentThreadWorkspace
        hostActions={previewHostActions}
        thread={thread} backLabel="Thread 详情" onBack={props.onBack} interrupt={stop} respond={respond} onFollowUp={openFollowUp}
      />}
      {followUp ? <form className="pg-native-followup" onSubmit={(event) => { event.preventDefault(); send() }}>
        <label>通过 Bart 续写<textarea autoFocus value={draft} rows={3} onChange={(event) => setDraft(event.currentTarget.value)} /></label>
        <div><button type="button" onClick={() => setFollowUp(false)}>取消</button><button disabled={!draft.trim()} type="submit">发送样例消息</button></div>
      </form> : null}
    </div>
  </div>
}
