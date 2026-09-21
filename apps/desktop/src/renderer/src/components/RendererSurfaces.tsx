import type { OverviewOrchestrationStore } from '../overview-orchestration-store'
import { headPoints, type HarnessOverviewThreadInput } from '@openagent/contracts/renderer'
import { projectHarnessOverviewThread } from '../harness-composition'
import { BartThreadGenerations } from './BartThreadGeneration'
import { useStore } from 'zustand'
import type { BartComposerStore } from '../bart-composer-store'
import { useLayoutEffect, useMemo, type ComponentProps } from 'react'
import type { PublicInteraction } from '@openagent/contracts'
import type { NormalizedRendererState } from '../../../shared/renderer-store'
import type { RendererBartThreadRecord, RendererThreadRecord } from '../../../shared/renderer-state-contracts'
import { useRendererState, useRendererStoreApi } from '../renderer-store-context'
import { BartDisplayQueue } from '../bart-display/queue'
import { connectBartDisplay } from '../bart-display/source'
import { bartVisualOperations, sameVisualOperations } from '../bart-visual-state'
import { projectBartVisualOperations, type BartVisualOperation } from '../bart-visual-operation'
import { projectHarnessBartPresentation } from '../harness-composition'
import { bartReplyReadKey } from '../bart-reply-read-state'
import { AgentThreadWorkspace } from './AgentThreadWorkspace'
import { BartThreadView } from './BartThreadView'
import { BartDock, type BartDockInteractionRequest } from './BartDock'
import { ConversationOverview } from './ConversationOverview'

/** The revision marker remains observable by the production benchmark without
 * making the navigation/composer owner subscribe to every streaming token. */
export function AppShell(props: ComponentProps<'div'>): React.JSX.Element {
  const revision = useRendererState((state) => state.revision)
  return <div {...props} data-state-revision={revision} />
}

export function SubscribedAgentThreadWorkspace(
  props: Omit<ComponentProps<typeof AgentThreadWorkspace>, 'thread'> & { readonly threadId: string }
): React.JSX.Element | null {
  const thread = useRendererState((state) => state.threadsById[props.threadId])
  return thread && !isBartThread(thread) ? <AgentThreadWorkspace {...props} thread={thread} /> : null
}

export function SubscribedBartThreadView(
  props: Omit<ComponentProps<typeof BartThreadView>, 'thread' | 'attachments' | 'clearing' | 'inputValue' | 'onInputChange' | 'submitting'> & { readonly threadId: string; readonly composer: BartComposerStore }
): React.JSX.Element | null {
  const thread = useRendererState((state) => state.threadsById[props.threadId])
  const inputValue = useStore(props.composer, state => state.text)
  const attachments = useStore(props.composer, state => state.attachments)
  const submitting = useStore(props.composer, state => state.submitting)
  const clearing = useStore(props.composer, state => state.clearing)
  return thread && isBartThread(thread) ? <BartThreadView {...props} thread={thread}
    inputValue={inputValue} attachments={attachments} submitting={submitting} clearing={clearing}
    onInputChange={props.composer.setText} /> : null
}

export function SubscribedBartDock(
  props: Omit<ComponentProps<typeof BartDock>, 'displayQueue' | 'activityContext' | 'interaction' | 'reply' | 'operations' | 'foregroundActivity' | 'bartAttachments' | 'inputValue' | 'onInputChange' | 'sessionIdle' | 'submitting'> & { readonly composer: BartComposerStore }
): React.JSX.Element {
  const store = useRendererStoreApi()
  const displayQueue = useMemo(() => new BartDisplayQueue(), [])
  useLayoutEffect(() => connectBartDisplay(displayQueue, store), [displayQueue, store])
  const inputValue = useStore(props.composer, state => state.text)
  const bartAttachments = useStore(props.composer, state => state.attachments)
  const submitting = useStore(props.composer, state => state.submitting)
  const bart = useRendererState((state) => {
    const thread = state.bartThreadId ? state.threadsById[state.bartThreadId] : undefined
    return thread && isBartThread(thread) ? thread : undefined
  })
  // The Dock follows this Execution, including the gap before its first event.
  // Spatial choreography below keeps its own delivery history independently.
  const operations = useMemo(() => projectBartVisualOperations(
    bart?.transcript.filter((item) => item.executionId === bart.observation.latestExecution?.executionId) ?? []
  ), [bart])
  const presentation = useMemo(() => (bart ? projectHarnessBartPresentation(bart) : undefined), [bart])
  const reply = useMemo(() => {
    if (!bart || !presentation?.reply) return undefined
    // Only a successful final reply reaches the reminder. Errors keep their own
    // channel inside the Bart session and never become a read answer.
    const excerpt = compactBartMessage(presentation.reply.excerpt)
    if (!excerpt) return undefined
    return {
      id: presentation.reply.id,
      readKey: bartReplyReadKey(bart.id, bart.harnessId, presentation.reply.id),
      excerpt,
      executionId: presentation.reply.executionId,
      target: presentation.reply.target
    }
  }, [bart, presentation])
  const interaction = useMemo(() => pendingBartDockInteraction(bart), [bart])
  const execution = bart?.observation.latestExecution ?? null
  const executionActive = execution
    ? execution.status === 'running' || execution.status === 'waiting-for-user'
    : props.running
  return <BartDock {...props} displayQueue={displayQueue} inputValue={inputValue} bartAttachments={bartAttachments}
    activityContext={{ threadKey: JSON.stringify([bart?.id, bart?.harnessId]), execution }}
    submitting={submitting} sessionIdle={!executionActive && !submitting}
    onInputChange={props.composer.setText} interaction={interaction} reply={reply}
    operations={operations} foregroundActivity={presentation?.activity} />
}

export function SubscribedConversationOverview(
  props: Omit<ComponentProps<typeof ConversationOverview>, 'operations' | 'layoutRevisions' | 'deletedIndexes' | 'generationHiddenIds' | 'revealRequest' | 'initialPlacements' | 'onLayoutPresented'> & {
    readonly orchestration: OverviewOrchestrationStore
  }
): React.JSX.Element {
  const operations = useBartVisualOperations()
  const layoutRevisions = useStore(props.orchestration, state => state.revisions)
  const deletedIndexes = useStore(props.orchestration, state => state.deletedIndexes)
  const generationHiddenIds = useStore(props.orchestration, state => state.hiddenIds)
  const revealRequest = useStore(props.orchestration, state => state.reveal)
  const placement = props.orchestration.getState().placement
  return <ConversationOverview {...props}
    initialPlacements={placement?.sceneKey === props.motionSceneKey ? placement?.placements : undefined}
    onLayoutPresented={props.orchestration.setPlacements} operations={operations} layoutRevisions={layoutRevisions}
    deletedIndexes={deletedIndexes} generationHiddenIds={generationHiddenIds} revealRequest={revealRequest} />
}

export function SubscribedBartThreadGenerations(props: {
  orchestration: OverviewOrchestrationStore
  overviewOpen: boolean
  inputs: readonly HarnessOverviewThreadInput[]
  reports: ComponentProps<typeof BartThreadGenerations>['reports']
}): React.JSX.Element {
  const works = useStore(props.orchestration, state => state.works)
  const availableCols = useStore(props.orchestration, state => state.layoutContext.availableCols)
  const threads = useMemo(() => {
    if (!props.overviewOpen || !works.length) return []
    const targets = new Set(works.flatMap(work => work.targets.filter(target => target.kind === 'thread').map(target => target.id)))
    return props.inputs.filter(input => targets.has(input.thread.id)).map(input =>
      projectHarnessOverviewThread(input, availableCols))
  }, [props.inputs, availableCols, props.overviewOpen, works])
  return <BartThreadGenerations overviewOpen={props.overviewOpen} works={works} threads={threads}
    reports={props.reports} orchestration={props.orchestration} onWorkConsumed={props.orchestration.consumeWork} />
}

function useBartVisualOperations(): readonly BartVisualOperation[] {
  const selector = useMemo(() => {
    let previous: readonly BartVisualOperation[] = []
    return (state: NormalizedRendererState) => {
      const thread = state.bartThreadId ? state.threadsById[state.bartThreadId] : undefined
      const next = thread && isBartThread(thread) ? bartVisualOperations(thread) : []
      if (!sameVisualOperations(previous, next)) previous = next
      return previous
    }
  }, [])
  return useRendererState(selector)
}

/**
 * The Dock projects only its own Bart Thread. Agent interactions stay in the
 * Agent workspace/overview so the same request cannot be answered from two
 * shells. Plugin-private run/session identities never enter the Core renderer.
 */
function pendingBartDockInteraction(
  thread: RendererBartThreadRecord | undefined
): BartDockInteractionRequest | undefined {
  const execution = thread?.observation.latestExecution
  if (!thread || execution?.status !== 'waiting-for-user') return undefined
  for (const interaction of execution.interactions) {
    const intervention = dockIntervention(interaction)
    if (!intervention) continue
    return {
      threadId: thread.id,
      threadTitle: thread.title,
      intervention
    }
  }
  return undefined
}

function dockIntervention(interaction: PublicInteraction):
  BartDockInteractionRequest['intervention'] | undefined {
  if (!interaction.actions.length) return undefined
  const questions = interaction.questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    ...(question.header ? { header: question.header } : {}),
    multiple: question.multiple,
    allowOther: question.allowOther,
    secret: question.secret,
    options: question.options.map((option, index) => ({
      id: `${question.id}:${index}`,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      value: option.value
    }))
  }))
  const submit = interaction.kind === 'question'
    ? interaction.actions.find((action) => action.intent === 'submit')
    : undefined
  if (interaction.kind === 'question' && (!questions.length || !submit)) return undefined
  return {
    id: interaction.id,
    title: interaction.title,
    ...(interaction.description ? { detail: interaction.description } : {}),
    actions: interaction.actions.map((action) => ({ ...action })),
    ...(submit ? { questions, submitActionId: submit.id } : {})
  }
}

/** The reminder shows how a final answer begins; the Harness bounds it first, and this keeps the opening intact. */
function compactBartMessage(value: string): string | undefined {
  const compact = value.replace(/[*_~`>#-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!compact) return undefined
  // Keep the opening whole: a UTF-16 slice could cut a surrogate pair in half.
  const head = headPoints(compact, 140)
  return head === compact ? compact : `${head.trimEnd()}…`
}

function isBartThread(thread: RendererThreadRecord): thread is RendererBartThreadRecord {
  return thread.bart === true
}
