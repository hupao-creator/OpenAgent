import { useState } from 'react'
import type { HarnessOverviewCardModule } from '@openagent/contracts/renderer'
import { composeThreadCard, HarnessThreadCard, ThreadCardProviderStatus, ThreadCardStateLabel, type ThreadCardPresentation, type ThreadCardExtensionProjection, type ThreadCardIdentityUsage } from '@openagent/plugin-kit/renderer'
import { piState } from '../shared/state.js'
import type { PiMessage, PiThreadSettings } from '../shared/types.js'
import { piLogo } from './pi-logo.js'

const EXCERPT_CHARACTERS = 600

/** Collapsed to one paragraph so the Renderer's line clamp ends the preview, not a raw pixel overflow. */
function cardExcerpt(content: string): string {
  const normalized = content.replace(/\s+/gu, ' ').trim()
  const characters = Array.from(normalized)
  return characters.length > EXCERPT_CHARACTERS ? `${characters.slice(0, EXCERPT_CHARACTERS).join('')}…` : normalized
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
  if (prompt > 0) {
    const ratio = usage.cacheRead / prompt
    parts.push({ id: 'cache-read', suffix: 'cached', description: '缓存读取 token 占输入 token 的比例',
      value: `${(ratio * 100).toFixed(1)}%`, numericValue: ratio })
  }
  return { parts }
}

function compactTokens(value: number): string {
  if (value < 1_000) return String(value)
  const [scale, suffix] = value >= 1_000_000_000 ? [1_000_000_000, 'B'] as const
    : value >= 1_000_000 ? [1_000_000, 'M'] as const
      : [1_000, 'K'] as const
  return `${(value / scale).toFixed(1).replace(/\.0$/, '')}${suffix}`
}

export interface PiOverviewView { presentation: ThreadCardPresentation; excerpt: string; model: string; status: string; pendingInteractionId?: string }
export const piOverviewCardModule: HarnessOverviewCardModule<PiOverviewView> = {
  project(input) {
    const state = piState(input.thread.sessionState)
    const excerpt = cardExcerpt(state.messages.findLast(m => m.role === 'assistant' && m.text.trim())?.text || state.messages.findLast(m => m.role === 'user')?.text || '')
    const executionId = state.latestExecutionId
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
    const presentation = composeThreadCard({ kind: 'standard', identity: usage ? { usage } : {}, extensions }, { displayPolicy: input.displayPolicy, availableCols: input.layout.availableColumns })
    return { footprint: { columns: presentation.size.cols, rows: presentation.size.rows }, structureKey: presentation.key, excerpt,
      view: { presentation, excerpt, model: [settings.provider, settings.model].filter(Boolean).join('/') || 'Pi', status: latest?.status || 'idle', pendingInteractionId: pending?.id } }
  },
  Card: function PiOverviewCard({ thread, projection, actions }) {
    const [error, setError] = useState<string>()
    return <><HarnessThreadCard onInterventionResponse={async response => {
      setError(undefined)
      try {
        const latest = thread.observation.latestExecution
        const interaction = latest?.status === 'waiting-for-user' ? latest.interactions.find(i => i.id === projection.pendingInteractionId) : undefined
        if (!interaction || !interaction.actions.some(a => a.id === response.actionId)) throw new Error('Pi request is no longer available')
        await actions.respond({ interactionId: interaction.id, ...response })
      } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    }} presentation={projection.presentation} onOpenThread={actions.openThread} identity={{ title: thread.title,
      providerStatus: <ThreadCardProviderStatus brandKey="pi" statusClassName="provider-theme-pi" label="Pi Agent" logoSource={piLogo} />,
      state: <ThreadCardStateLabel className={projection.status} icon={null}>{projection.status}</ThreadCardStateLabel>, model: projection.model, excerpt: projection.excerpt }} />{error ? <div role="alert">{error}</div> : null}</>
  }
}
