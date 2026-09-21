import { useState } from 'react'
import { BartDock } from '../../../src/renderer/src/components/BartDock'
import type { LabConfig, LabEvent } from './scenarios'
import './launch.css'

const DRAFT = '帮我整理这个项目的待办事项'
const noop = (): void => {}
export function LaunchPreview({ config, record }: { config: LabConfig; record(event: LabEvent): void }): React.JSX.Element {
  const [inputOpen, setInputOpen] = useState(true)
  const [draft, setDraft] = useState(DRAFT)
  const [running, setRunning] = useState(false)
  const submit = (): void => {
    record({ title: '发起任务', detail: draft.trim() })
    setRunning(true)
    setDraft('')
  }
  return <main className="app-shell bart-preview launch-preview" data-guides={config.guides}>
    <div className="cadence-source"><span>输入 → 运行中</span><output>{running ? '运行中' : '输入任务'}</output></div>
    <BartDock
      activityContext={{ threadKey: 'bart-launch-lab', execution: {
        executionId: running ? 'bart-launch-execution' : 'previous-execution', status: running ? 'running' : 'completed'
      } }}
      launchSpeed={config.variant === 'slow' ? .35 : 1}
      threadOpen={false} sessionIdle={!running} running={running}
      inputOpen={inputOpen} inputValue={draft} inputDisabled={false} bartAttachments={[]}
      onInputChange={setDraft} onInputOpenChange={open => {
        if (open) { setRunning(false); setDraft(DRAFT) }
        setInputOpen(open)
      }}
      onThreadOpenChange={noop} onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={submit}
    />
    <div className="launch-hint">{running ? '重放可重新体验输入到运行的过渡' : '按 Enter 或点击发送'}</div>
  </main>
}
