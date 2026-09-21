import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BartDock } from '../../../src/renderer/src/components/BartDock'
import type { BartVisualOperation } from '../../../src/renderer/src/bart-visual-operation'
import type { ThreadInteractionResponseRequest } from '../../../src/shared/desktop-api'
import { initialConfig, inputAttachmentsFor, inputDraftFor, interactionFor, residentActivityFor, residentReplyFor, threadFollowUpFor, validConfig, type LabConfig, type LabEvent, type PreviewMessage } from './scenarios'
import type { BartDraftAttachment } from '../../../src/shared/attachments'
import '@fontsource-variable/inter'
import './preview.css'
import { CadencePreview } from './cadence'
import { useReasoningStream } from './reasoning-stream'
import { RunningPreview } from './running'

function notify(message: PreviewMessage): void {
  if (window.parent !== window) window.parent.postMessage(message, window.location.origin)
}

function record(event: LabEvent): void {
  notify({ source: 'bart-preview', type: 'event', event })
}

function Preview(): React.JSX.Element {
  const [config, setConfig] = useState(initialConfig)
  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return
      if (event.data?.source === 'bart-lab' && event.data.type === 'configure' && validConfig(event.data.config)) {
        setConfig(event.data.config)
      }
    }
    window.addEventListener('message', receive)
    notify({ source: 'bart-preview', type: 'ready' })
    return () => window.removeEventListener('message', receive)
  }, [])
  return config.scene === 'running'
    ? <RunningPreview key={config.replay} config={config} />
    : config.scene === 'cadence'
    ? <CadencePreview key={`${config.variant}:${config.replay}`} config={config} />
    : <ScenePreview key={config.replay} config={config} />
}

interface Session {
  key: string
  draft: string
  attachments: BartDraftAttachment[]
  inputClosed: boolean
  outcome?: { action: 'allow' | 'deny' | 'submit' | 'cancel'; respondedAt: number }
}

function sessionFor(config: LabConfig): Session {
  return {
    key: `${config.scene}:${config.variant}:${config.replay}`,
    draft: inputDraftFor(config),
    attachments: inputAttachmentsFor(config),
    inputClosed: false
  }
}

function ScenePreview({ config }: { config: LabConfig }): React.JSX.Element {
  const streamingActivity = useReasoningStream(config)
  const [session, setSession] = useState(() => sessionFor(config))
  const responseGeneration = useRef(0)
  const nextSession = sessionFor(config)
  if (session.key !== nextSession.key) {
    responseGeneration.current += 1
    setSession(nextSession)
  }
  const sessionKey = useRef(session.key)
  sessionKey.current = nextSession.key
  useEffect(() => () => { sessionKey.current = '' }, [])

  const request = interactionFor(config)
  const operation: BartVisualOperation | undefined = config.scene === 'resident'
    && ['working', 'success', 'error'].includes(config.variant)
    ? {
        id: `bart-work-${config.replay}`,
        kind: 'read',
        phase: config.variant === 'success' ? 'completed' : config.variant === 'error' ? 'failed' : 'running'
      }
    : undefined
  const foregroundActivity = streamingActivity ?? residentActivityFor(config)
  const reply = residentReplyFor(config)
  const bartRunning = config.scene === 'resident'
    && (foregroundActivity !== null || config.variant === 'working')

  const respond = async (response: ThreadInteractionResponseRequest): Promise<void> => {
    const key = session.key
    const generation = responseGeneration.current
    // Simulated response latency exercises the production panel's busy state.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 450))
    if (sessionKey.current !== key || responseGeneration.current !== generation) return
    const action = request?.intervention.actions.find((item) => item.id === response.actionId)
    const intent = action?.intent ?? 'cancel'
    setSession((current) => ({ ...current, outcome: { action: intent, respondedAt: Date.now() } }))
    record({
      title: intent === 'submit' ? '已提交回答' : intent === 'cancel' ? '已取消提问' : intent === 'deny' ? '已拒绝请求' : '已允许请求',
      detail: response.answers
        ? Object.values(response.answers).map((value) => Array.isArray(value) ? value.join('、') : value).join(' · ')
        : action?.label ?? response.actionId,
      payload: response
    })
  }

  return (
    <main className="app-shell bart-preview" data-guides={config.guides}>
      <BartDock
        reasoningOptions={{ length: config.reasoningLength, tilt: config.reasoningTilt,
          gaze: config.reasoningGaze, stream: config.reasoningStreamStyle }}
        activityContext={{ threadKey: 'bart-lab', execution: {
          executionId: 'bart-lab-execution', status: operation || bartRunning ? 'running' : 'completed'
        } }}
        threadOpen={false}
        threadFollowUp={threadFollowUpFor(config)}
        sessionIdle={!operation && !bartRunning}
        inputOpen={config.scene === 'input' && !session.inputClosed}
        inputValue={session.draft}
        inputDisabled={config.scene === 'input' && config.variant === 'disabled'}
        bartAttachments={session.attachments}
        operations={operation ? [operation] : undefined}
        foregroundActivity={foregroundActivity}
        reply={reply}
        onReplyOpen={() => record({ title: '答复定位', detail: '本 Case 只预览形态，未接入真实会话导航。' })}
        running={bartRunning}
        interaction={session.outcome ? undefined : request}
        intervention={session.outcome ? {
          responseStatus: 'responded',
          action: session.outcome.action,
          sourceConversationId: 'bart-lab-thread', sourceRunId: 'bart-lab-run',
          interactionId: request?.intervention.id ?? 'bart-input',
          respondedAt: session.outcome.respondedAt
        } : undefined}
        onThreadOpenChange={() => record({ title: '历史入口', detail: '本 Case 只预览 Bart 状态，历史对话未展开。' })}
        onInputOpenChange={(open) => {
          if (sessionKey.current !== session.key) return
          if (open && config.scene !== 'input') {
            notify({ source: 'bart-preview', type: 'scene', scene: 'input' })
          } else {
            setSession((current) => ({ ...current, inputClosed: !open }))
          }
        }}
        onInputChange={(draft) => setSession((current) => ({ ...current, draft }))}
        onThreadFollowUpClose={() => record({ title: '退出续写', detail: '本 Case 只预览形态。' })}
        onThreadFollowUpSubmit={async (threadId, prompt) => {
          record({ title: '已提交续写', detail: prompt, payload: { threadId, prompt } })
        }}
        onChooseFiles={() => record({ title: '附件入口', detail: '本 Case 只预览输入形态，附件流程未展开。' })}
        onRemoveBartAttachment={(id) => setSession((current) => ({
          ...current, attachments: current.attachments.filter((draft) => draft.id !== id)
        }))}
        onSubmit={() => {
          record({ title: '已提交输入', detail: session.draft.trim(), payload: { prompt: session.draft.trim() } })
          setSession((current) => ({
            ...current, draft: '', inputClosed: true, outcome: { action: 'submit', respondedAt: Date.now() }
          }))
        }}
        onInteractionResponse={respond}
      />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
