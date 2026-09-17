import type { ComponentProps } from 'react'
import type { BartToolOperation, JsonValue, ThreadPublicObservation } from '@openagent/contracts'
import { createBartComposerStore } from '../../src/renderer/src/bart-composer-store'
import { SubscribedBartDock } from '../../src/renderer/src/components/RendererSurfaces'
import { RendererStoreProvider } from '../../src/renderer/src/renderer-store-context'
import { AppI18nProvider } from '../../src/renderer/src/i18n'
import { createInitialRendererState } from '../../src/shared/renderer-state'
import {
  applyRendererStateStoreMutation,
  createRendererStateStore,
  hydrateRendererStateStore,
  rendererAppState
} from '../../src/shared/renderer-store'
import { createRendererStateMutation } from '../../src/shared/renderer-state-patch'
import {
  createEmptyCodexState,
  reduceCodexEvent,
  stageCodexExecution
} from '../../../../packages/harness-codex/src/shared/state'
import type { CodexHarnessState, CodexTurn } from '../../../../packages/harness-codex/src/shared/types'

export const BART_REPLY_THREAD_ID = 'bart-reply-thread'
export const BART_REPLY_EXECUTION_ID = 'execution-1'
export const BART_REPLY_ITEM_ID = 'answer-1'
export const BART_REPLY_ANSWER = 'An unchanged assistant answer.'

function completed(executionId: string, startedAt: number, finishedAt: number): ThreadPublicObservation {
  return { latestExecution: { executionId, status: 'completed', startedAt, finishedAt }, backgroundWork: null }
}

function running(executionId: string, startedAt: number): ThreadPublicObservation {
  return { latestExecution: { executionId, status: 'running', startedAt }, backgroundWork: null }
}

/** A completed Turn whose single assistant item is the final answer. */
function answered(turn: CodexTurn, answer: string, itemId: string, at: number): CodexTurn {
  return {
    ...turn,
    status: 'completed',
    updatedAt: at,
    finishedAt: at,
    answer,
    timeline: [{
      id: itemId, itemId, kind: 'assistant', content: answer, status: 'complete', createdAt: at
    }]
  }
}

/**
 * The Bart Dock fed by the production Codex projection: one completed Turn that
 * produces the final-reply reminder, plus the native transitions around it (a
 * new Turn, its failure, its answer). The Dock owns the reminder; the Projection
 * owns the answer identity, so every helper here goes through the real Store.
 *
 * Every native transition takes one tick of a single monotone clock, because the
 * Harness state validator requires each Turn to sit inside the envelope
 * `updatedAt` it is persisted with.
 */
export function createBartReplyFixture() {
  const store = createRendererStateStore('')
  const composer = createBartComposerStore()
  let clock = 1
  const tick = (): number => (clock += 1)

  const staged = stageCodexExecution(
    createEmptyCodexState(1), BART_REPLY_EXECUTION_ID, { parts: [{ kind: 'text', text: 'hello' }] }, tick(), 'user-1'
  )
  const firstAt = tick()
  let state: CodexHarnessState = {
    ...staged,
    updatedAt: firstAt,
    turns: [answered(staged.turns[0]!, BART_REPLY_ANSWER, BART_REPLY_ITEM_ID, firstAt)]
  }
  let observation = completed(BART_REPLY_EXECUTION_ID, firstAt - 1, firstAt)
  let operations: BartToolOperation[] = []

  hydrateRendererStateStore(store, {
    ...createInitialRendererState(''),
    revision: 1,
    threads: [{
      id: BART_REPLY_THREAD_ID, bart: true as const, harnessId: 'codex', revision: 1,
      title: 'Bart', tags: [], cwd: '/tmp', settings: {}, sessionState: state as unknown as JsonValue,
      observation, transcript: [], createdAt: 1, updatedAt: firstAt
    }]
  })

  const publish = (next: CodexHarnessState, nextObservation: ThreadPublicObservation): void => {
    const before = rendererAppState(store.getState())
    const previous = before.threads[0]!
    if (previous.bart !== true) throw new Error('Expected the Bart fixture thread')
    state = { ...next, updatedAt: clock }
    observation = nextObservation
    applyRendererStateStoreMutation(store, createRendererStateMutation(before, {
      ...before,
      revision: before.revision + 1,
      threads: [{
        ...previous, revision: previous.revision + 1, sessionState: JSON.parse(JSON.stringify(state)),
        observation, transcript: operations, updatedAt: clock
      }]
    }))
  }

  const startTurn = (executionId: string): void => {
    const at = tick()
    state = stageCodexExecution(state, executionId, { parts: [{ kind: 'text', text: 'follow-up' }] }, at, `${executionId}-prompt`)
    publish(state, running(executionId, at))
  }

  const acceptEvent = (executionId: string, event: Parameters<typeof reduceCodexEvent>[2]): void => {
    const at = tick()
    publish(reduceCodexEvent(state, executionId, event, at, `event-${at}`), observation)
  }

  const recordOperation = (operation: BartToolOperation): void => {
    operations = [...operations.filter((entry) => entry.id !== operation.id), operation]
    tick()
    publish(state, observation)
  }

  const finishTurn = (executionId: string, text: string, itemId = `${executionId}-answer`): void => {
    const at = tick()
    publish({
      ...state,
      turns: state.turns.map((turn) => turn.executionId === executionId ? answered(turn, text, itemId, at) : turn)
    }, completed(executionId, at - 1, at))
  }

  const failTurn = (executionId: string, error: string): void => {
    const at = tick()
    const turn = state.turns.find((entry) => entry.executionId === executionId)
    publish({
      ...state,
      turns: state.turns.map((entry) => entry.executionId === executionId
        ? { ...entry, status: 'failed' as const, updatedAt: at, finishedAt: at } : entry)
    }, {
      latestExecution: { executionId, status: 'failed', startedAt: turn?.createdAt ?? at - 1, finishedAt: at, error },
      backgroundWork: null
    })
  }

  const element = (props: Partial<ComponentProps<typeof SubscribedBartDock>> = {}): React.JSX.Element => (
    <AppI18nProvider locale="en-US"><RendererStoreProvider store={store}>
      <SubscribedBartDock
        composer={composer}
        inputOpen={false}
        onChooseFiles={() => {}}
        onInputOpenChange={() => {}}
        onRemoveBartAttachment={() => {}}
        onSubmit={() => {}}
        onThreadOpenChange={() => {}}
        threadOpen={false}
        {...props}
      />
    </RendererStoreProvider></AppI18nProvider>
  )

  return { store, element, startTurn, finishTurn, failTurn, acceptEvent, recordOperation }
}
