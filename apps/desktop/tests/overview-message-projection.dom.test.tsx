import { expect, it } from 'vitest'
import type { AgentThreadRecord } from '@openagent/contracts'
import { isJsonValue } from '@openagent/contracts'
import { projectClaudeOverview } from '../../../packages/harness-claude/src/renderer/OverviewCard'
import { projectCodexOverview } from '../../../packages/harness-codex/src/renderer/overview'
import { decodeCodexState } from '../../../packages/harness-codex/src/shared/state'
import { parseClaudeThreadState } from '../../../packages/harness-claude/src/shared/state'
import { fakeSnapshots, withPreviewMessage, withPreviewTokenUsage } from '../playgrounds/single-thread/src/fake-snapshots'

it.each(['claude', 'codex'])('keeps the full current %s message separate from the bounded envelope', harness => {
  const project = harness === 'claude' ? projectClaudeOverview : projectCodexOverview
  const captured = fakeSnapshots.find(scene => scene.harness === harness && scene.scenario === 'running')!.state.threads[0] as AgentThreadRecord
  const full = '**raw**\n' + '😀'.repeat(1400)
  const thread = withPreviewMessage(captured, full, 1)
  const initial = project({ thread, layout: { availableColumns: 2 } })
  expect(initial.view.identity.message?.text).toBe(full)
  expect(Array.from(initial.excerpt).length).toBeLessThanOrEqual(601)
  const usage = project({ thread: withPreviewTokenUsage(thread, 100), layout: { availableColumns: 2 } })
  expect(usage.view.identity.message).toEqual(initial.view.identity.message)
  const appended = project({ thread: withPreviewMessage(thread, full + 'tail', 1), layout: { availableColumns: 2 } })
  expect(appended.view.identity.message?.id).toBe(initial.view.identity.message?.id)
  expect(appended.view.identity.message?.text).toBe(full + 'tail')
  const next = project({ thread: withPreviewMessage(thread, 'next', 2), layout: { availableColumns: 2 } })
  expect(next.view.identity.message?.id).not.toBe(initial.view.identity.message?.id)
  expect(next.view.identity.message?.text).toBe('next')
})

it('aggregates Claude text segments belonging to the same native message', () => {
  const captured = fakeSnapshots.find(scene => scene.harness === 'claude' && scene.scenario === 'running')!.state.threads[0] as AgentThreadRecord
  const state = parseClaudeThreadState(withPreviewMessage(captured, 'first', 1).sessionState)
  const turn = state.turns.at(-1)!
  const assistant = turn.timeline[0]!
  if (assistant.kind !== 'assistant') throw new Error('Expected assistant fixture')
  const session = { ...state, turns: [{ ...turn, timeline: [assistant,
    { kind: 'reasoning', id: 'reasoning', content: 'private reasoning', createdAt: turn.createdAt },
    { ...assistant, id: 'segment-2', content: '\nsecond' }] }] }
  if (!isJsonValue(session)) throw new Error('Expected JSON fixture')
  const projection = projectClaudeOverview({ thread: { ...captured, sessionState: session }, layout: { availableColumns: 2 } })
  expect(projection.view.identity.message?.text).toBe('first\nsecond')
})

it.each(['claude', 'codex'])('keeps %s message identity when execution status settles', harness => {
  const project = harness === 'claude' ? projectClaudeOverview : projectCodexOverview
  const captured = fakeSnapshots.find(scene => scene.harness === harness && scene.scenario === 'running')!.state.threads[0] as AgentThreadRecord
  const preview = withPreviewMessage(captured, 'earlier assistant', 1)
  const state = harness === 'claude' ? parseClaudeThreadState(preview.sessionState) : decodeCodexState(preview.sessionState)
  const turn = state.turns.at(-1)!
  const timeline = [...turn.timeline, { id: 'latest-reasoning', kind: 'reasoning', content: 'current reasoning', createdAt: turn.createdAt }]
  const live = { ...state, turns: [{ ...turn, timeline }] }
  const done = { ...state, turns: [{ ...turn, timeline, status: 'completed', finishedAt: turn.updatedAt }] }
  if (!isJsonValue(live) || !isJsonValue(done)) throw new Error('Expected JSON fixture')
  const before = project({ thread: { ...preview, sessionState: live }, layout: { availableColumns: 2 } })
  const after = project({ thread: { ...preview, sessionState: done }, layout: { availableColumns: 2 } })
  expect(after.view.identity.message).toEqual(before.view.identity.message)
  expect(after.view.identity.message?.text).toBe('current reasoning')
})
