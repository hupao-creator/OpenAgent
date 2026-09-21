import { useEffect, useState } from 'react'
import type { HarnessBartActivity } from '@openagent/contracts/renderer'
import { BartDock } from '../../../src/renderer/src/components/BartDock'
import { residentReplyFor, type LabConfig } from './scenarios'

const EXECUTION = 'bart-lab-execution'
const TOOLS = ['read_file', 'search', 'write_file', 'mcp__github__create_issue']
const BURST = ['reasoning', 'tool-call', 'reasoning', 'tool-call', 'assistant-text', 'tool-call'] as const
const noop = (): void => {}

/** Only the input is simulated. Production BartDock owns all presentation timing. */
export function CadencePreview({ config }: { config: LabConfig }): React.JSX.Element {
  const [step, setStep] = useState(0)
  const finished = config.variant === 'finish' && step >= 6
  const covered = config.variant === 'recovery' && step % 40 >= 8 && step % 40 < 24
  useEffect(() => {
    if (finished) return
    const timer = window.setInterval(() => setStep((current) => current + 1), config.eventMs)
    return () => window.clearInterval(timer)
  }, [config.eventMs, finished])

  const kind = config.variant === 'reasoning-stream' ? 'reasoning'
    : config.variant === 'tool-stream' ? 'tool-call' : BURST[step % BURST.length]
  const identity = { executionId: EXECUTION, sequence: step + 1 }
  const activity: HarnessBartActivity = kind === 'reasoning'
    ? { ...identity, kind, text: `先确认输入，再核对执行结果；正在检查第 ${step + 1} 段内容` }
    : kind === 'tool-call'
      ? { ...identity, kind, callId: `call-${step}`, toolName: TOOLS[step % TOOLS.length] }
      : { ...identity, kind: 'assistant-text' }
  const label = finished ? '本轮已完成' : kind === 'reasoning' ? '思考'
    : activity.kind === 'tool-call' ? activity.toolName : '输出正文'

  return <main className="app-shell bart-preview" data-guides={config.guides}>
    <div className="cadence-source" aria-hidden="true">
      <span>真实活动 · {label}</span><small>每 {config.eventMs}ms 输入一项 · 已接收 {step + 1} 项</small>
    </div>
    <BartDock
      activityContext={{ threadKey: 'bart-cadence-lab', execution: {
        executionId: EXECUTION, status: finished ? 'completed' : 'running'
      } }}
      displayTiming={{ running: { minimumDisplayMs: config.minimumMs }, reasoning: { minimumDisplayMs: config.reasoningMs }, tool: { minimumDisplayMs: config.minimumMs } }}
      foregroundActivity={finished ? null : activity}
      running={!finished} sessionIdle={finished} threadOpen={false}
      inputOpen={covered} inputValue={covered ? '输入接管期间，真实活动仍继续前进' : ''}
      bartAttachments={[]}
      reply={finished ? residentReplyFor({ ...config, scene: 'resident', variant: 'reply' }) : null}
      onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
      onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop}
    />
  </main>
}
