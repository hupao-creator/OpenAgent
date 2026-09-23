import { useState } from 'react'
import type { HarnessOverviewCardModule } from '@openagent/contracts/renderer'
import type { DeepReadonly, HarnessThreadRecord } from '@openagent/contracts'
import { composeThreadCard, HarnessThreadCard, ThreadCardStatus, type ThreadCardPresentation, type ThreadCardExtensionProjection, type ThreadCardIdentityUsage, type ThreadCardIdentityView } from '@openagent/plugin-kit/renderer'
import { piState } from '../shared/state.js'
import type { PiMessage, PiThreadSettings } from '../shared/types.js'
import { piLogo } from './pi-logo.js'

const EXCERPT_CHARACTERS = 600

/** Preserve literal message text; the Renderer clamps complete visual lines. */
function cardExcerpt(content: string): string {
  const text = content.trim()
  const characters = Array.from(text)
  return characters.length > EXCERPT_CHARACTERS ? `${characters.slice(0, EXCERPT_CHARACTERS).join('')}…` : text
}

/**
 * Pi reports cache outside `input`, so the prompt total is the three-part sum
 * the Thread detail already counts. Only the latest Execution's usage reaches
 * the card, so a fresh run never shows the previous run's numbers.
 */
function cardUsage(usage: PiMessage['usage']): ThreadCardIdentityUsage | undefined {
  if (!usage) return undefined
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  const parts: ThreadCardIdentityUsage['parts'][number][] = [{
    id: 'total', suffix: 'tokens', description: '输入与输出 token 合计，按 Harness 当前上报的统计范围显示',
    value: compactTokens(prompt + usage.output), numericValue: prompt + usage.output
  }]
  return { parts }
}

function compactTokens(value: number): string {
  if (value < 1_000) return String(value)
  const [scale, suffix] = value >= 1_000_000_000 ? [1_000_000_000, 'B'] as const
    : value >= 1_000_000 ? [1_000_000, 'M'] as const
      : [1_000, 'K'] as const
  return `${(value / scale).toFixed(1)}${suffix}`
}

export interface PiOverviewView { presentation: ThreadCardPresentation; excerpt: string; message?: ThreadCardIdentityView['message']; model: string; status: string; pendingInteractionId?: string }
export const piOverviewCardModule: HarnessOverviewCardModule<PiOverviewView> = {
  executionTokenUsage(thread: DeepReadonly<HarnessThreadRecord>, executionId: string) {
    const state = piState(thread.sessionState)
    const part = cardUsage(state.messages.findLast(message =>
      message.executionId === executionId && message.role === 'assistant' && message.usage)?.usage)
      ?.parts.find(item => item.id === 'total')
    return part?.numericValue === undefined ? undefined : { value: part.value, count: part.numericValue, suffix: part.suffix ?? '' }
  },
  project(input) {
    const state = piState(input.thread.sessionState)
    const executionId = state.latestExecutionId
    const current = state.messages.filter(message => executionId === null || message.executionId === executionId)
    const latestMessage = current.findLast(message => message.role === 'assistant' && message.text.trim()) || current.findLast(message => message.role === 'user')
    const excerpt = cardExcerpt(latestMessage?.text ?? '')
    const message = latestMessage ? { id: JSON.stringify([latestMessage.executionId, latestMessage.role, latestMessage.id]), text: latestMessage.text.trim() } : undefined
    const usage = executionId === null ? undefined : cardUsage(state.messages.findLast(m =>
      m.executionId === executionId && m.role === 'assistant' && m.usage)?.usage)
    const settings = input.thread.settings as PiThreadSettings
    const latest = input.thread.observation.latestExecution
    const pending = latest?.status === 'waiting-for-user' ? latest.interactions[0] : undefined
    const extensions: ThreadCardExtensionProjection[] = pending && !pending.questions.some(q => q.secret) ? [{ kind: 'intervention', intervention: {
      id: pending.id, title: pending.title, detail: pending.description, actions: pending.actions,
      ...(pending.questions.length && !pending.questions.some(q => q.secret) ? {
        questions: pending.questions.map(q => ({ ...q, options: q.options.map(o => ({ ...o, id: o.value })) })),
        submitActionId: pending.actions.find(a => a.intent === 'submit')?.id
      } : {})
    } }] : []
    if (latest?.status === 'running' || latest?.status === 'waiting-for-user') {
      const todos = state.messages.findLast(message => message.executionId === latest.executionId &&
        message.role === 'tool' && message.toolName === 'todo' && message.todos !== undefined)?.todos
      if (todos?.some(todo => !todo.done)) extensions.push({ kind: 'todo', steps: todos.map(todo => ({
        step: todo.text, status: todo.done ? 'completed' : 'pending'
      })) })
    }
    const presentation = composeThreadCard({ kind: 'standard', identity: usage ? { usage } : {}, extensions }, { displayPolicy: input.displayPolicy, availableCols: input.layout.availableColumns })
    return { footprint: { columns: presentation.size.cols, rows: presentation.size.rows }, structureKey: presentation.key, excerpt,
      view: { presentation, excerpt, message, model: [settings.provider, settings.model].filter(Boolean).join('/') || 'Pi', status: latest?.status || 'idle', pendingInteractionId: pending?.id } }
  },
  Card: function PiOverviewCard({ thread, projection, actions }) {
    const [error, setError] = useState<string>()
    const execution = thread.observation.latestExecution
    return <><HarnessThreadCard onInterventionResponse={async response => {
      setError(undefined)
      try {
        const latest = thread.observation.latestExecution
        const interaction = latest?.status === 'waiting-for-user' ? latest.interactions.find(i => i.id === projection.pendingInteractionId) : undefined
        if (!interaction || !interaction.actions.some(a => a.id === response.actionId)) throw new Error('Pi request is no longer available')
        await actions.respond({ interactionId: interaction.id, ...response })
      } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    }} presentation={projection.presentation} onOpenThread={actions.openThread} identity={{ title: thread.title,
      providerStatus: <ThreadCardStatus brandKey="pi" className="provider-theme-pi" label="Pi Agent" logoSource={piLogo} observation={thread.observation} />,
      ...(execution ? { runtime: { startedAt: execution.startedAt, ...('finishedAt' in execution ? { endedAt: execution.finishedAt } : {}) } } : {}),
      model: projection.model, excerpt: projection.excerpt, message: projection.message }} />{error ? <div role="alert">{error}</div> : null}</>
  }
}
