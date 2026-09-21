import { useState } from 'react'
import { ArrowUpRight, Check, CheckCircle2, CircleHelp, CirclePause, CircleX, CornerDownRight, Folder, ShieldCheck, SquareTerminal } from 'lucide-react'
import type { DeepReadonly, HarnessThreadRecord, PublicInteraction } from '@openagent/contracts'
import { comparisonCardModel } from './comparison-model'

export function AfterThreadCard({ thread, compact, record }: {
  thread: DeepReadonly<HarnessThreadRecord>
  compact: boolean
  record(action: string): void
}): React.JSX.Element {
  const model = comparisonCardModel(thread)
  const [answer, setAnswer] = useState('')
  const [custom, setCustom] = useState(false)
  const [responded, setResponded] = useState(false)
  const interaction = model.interaction
  const question = interaction?.questions[0]
  const submit = interaction?.actions.find(action => action.intent === 'submit')
  const inlineQuestion = interaction?.kind === 'question' && interaction.questions.length === 1
    && question && !question.secret && !question.multiple && submit
  const inlinePermission = interaction?.kind === 'permission' && !interaction.questions.length
  const inline = !compact && (inlineQuestion || inlinePermission)
  const provider = thread.harnessId === 'claude' ? 'Claude Code' : 'Codex'
  const cwd = thread.cwd?.split(/[\\/]/).filter(Boolean).at(-1)
  const StatusIcon = model.status === 'question' ? CircleHelp : model.status === 'permission' ? ShieldCheck
    : model.status === 'failed' ? CircleX : model.status === 'interrupted' ? CirclePause
      : model.status === 'completed' ? CheckCircle2 : null
  const respond = (actionId: string, pending: PublicInteraction): void => {
    record(`记录回应：${JSON.stringify({ interactionId: pending.id, actionId,
      ...(inlineQuestion && actionId === submit?.id && question ? { answers: { [question.id]: answer.trim() } } : {}) })}`)
    setResponded(true)
  }
  return <article className={`after-thread-card ${compact ? 'is-compact' : ''}`} data-after-status={model.status} aria-label="After 任务卡片">
    <header className="after-thread-identity">
      <SquareTerminal size={16} aria-hidden="true" />
      <h2>{thread.title}</h2>
    </header>
    <div className="after-thread-content">
      <div className="after-thread-status">
        {StatusIcon ? <StatusIcon size={15} aria-hidden="true" /> : <span className="after-status-dot" aria-hidden="true" />}
        <span>{model.label}</span>
      </div>
      <h3>{model.headline}</h3>
      {!compact && model.detail && <p className={model.status === 'permission' ? 'after-thread-command' : 'after-thread-detail'}>{model.detail}</p>}
      {!compact && model.status === 'running' && model.plan.length > 0 && <ol className="after-thread-plan" aria-label="执行计划">
        {model.plan.map((step, index) => <li key={`${index}:${step.step}`} data-state={step.status} aria-current={step.status === 'inProgress' ? 'step' : undefined}>
          <span aria-hidden="true">{step.status === 'completed' ? <Check size={11} /> : index + 1}</span>
          {step.step}
        </li>)}
      </ol>}
      {inline && interaction && <div className="after-thread-response">
        {inlineQuestion && question && <fieldset disabled={responded} className="after-thread-options">
          <legend className="after-sr-only">{question.prompt}</legend>
          {question.options.map(option => <label className="after-thread-option" key={option.value}>
            <input type="radio" name={`after-${interaction.id}`} value={option.value} checked={!custom && answer === option.value}
              onChange={() => { setCustom(false); setAnswer(option.value) }} />
            <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          </label>)}
          {question.allowOther && <label className="after-thread-option">
            <input type="radio" name={`after-${interaction.id}`} checked={custom} onChange={() => { setCustom(true); setAnswer('') }} />
            <span><strong>自定义回答</strong></span>
          </label>}
          {(custom || question.options.length === 0) && <input className="after-thread-input" aria-label="自定义回答内容" placeholder="输入你的回答" value={answer} onChange={event => setAnswer(event.target.value)} />}
        </fieldset>}
        {responded ? <p className="after-response-recorded" role="status"><CheckCircle2 size={16} />已记录模拟回应 <span>重置后可再次体验</span></p>
          : <div className="after-thread-actions">
            {interaction.actions.filter(action => inlinePermission || action.intent === 'submit' || action.intent === 'cancel').map(action => <button
              className={action.intent === 'submit' || action.intent === 'allow' ? 'after-action-primary' : 'after-action-secondary'}
              key={action.id} type="button" disabled={action.intent === 'submit' && !answer.trim()}
              onClick={() => respond(action.id, interaction)}>{action.intent === 'submit' ? '提交回答'
                : action.intent === 'cancel' ? '取消' : action.intent === 'deny' ? '拒绝'
                  : action.id === 'allow-session' ? '本会话始终允许' : '允许一次'}</button>)}
          </div>}
      </div>}
      {model.background && model.status !== 'background' && <p className="after-thread-background"><CornerDownRight size={13} aria-hidden="true" />另有后台工作运行中</p>}
    </div>
    <footer className="after-thread-footer">
      <button className="after-thread-open" type="button" onClick={() => record(`记录打开 Agent Thread：${model.action}`)}>
        {inline ? '查看任务' : model.action}<ArrowUpRight size={15} aria-hidden="true" />
      </button>
      <span className="after-thread-location" title={thread.cwd}><Folder size={12} aria-hidden="true" />{cwd}</span>
    </footer>
    <span className="after-thread-provider">{provider}</span>
  </article>
}
