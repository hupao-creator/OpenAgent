import { useState } from 'react'
import type { HarnessOverviewCardModule } from '@openagent/contracts/renderer'
import { composeThreadCard, HarnessThreadCard, ThreadCardProviderStatus, ThreadCardStateLabel, type ThreadCardPresentation, type ThreadCardExtensionProjection } from '@openagent/plugin-kit/renderer'
import { piState } from '../shared/state.js'
import type { PiThreadSettings } from '../shared/types.js'
import { piLogo } from './pi-logo.js'

export interface PiOverviewView { presentation: ThreadCardPresentation; excerpt: string; model: string; status: string; pendingInteractionId?: string }
export const piOverviewCardModule: HarnessOverviewCardModule<PiOverviewView> = {
  project(input) {
    const state = piState(input.thread.sessionState)
    const excerpt = (state.messages.findLast(m => m.role === 'assistant' && m.text.trim())?.text || state.messages.findLast(m => m.role === 'user')?.text || '').slice(0, 600)
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
    const presentation = composeThreadCard({ kind: 'standard', identity: {}, extensions }, { displayPolicy: input.displayPolicy, availableCols: input.layout.availableColumns })
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
