import { describe, expect, it } from 'vitest'
import type { AgentThreadRecord, JsonValue } from '@openagent/contracts'
import { projectCodexOverview } from '../src/renderer/overview.js'
import { createEmptyCodexState, settleCodexExecution, stageCodexExecution } from '../src/shared/state.js'
import { codexSessionState } from '../src/shared/session-state.js'

function totalLabel(totalTokens: number): string | undefined {
  const state = stageCodexExecution(
    createEmptyCodexState(1),
    'execution-1',
    { parts: [{ kind: 'text', text: 'Audit' }] },
    2,
    'user-1'
  )
  state.turns[0] = { ...state.turns[0]!, usage: { inputTokens: totalTokens, cachedInputTokens: 100, outputTokens: 0 } }
  const thread: AgentThreadRecord<'codex'> = {
    id: 'codex-overview', harnessId: 'codex', revision: 1, archived: false, title: 'Audit',
    tags: [], cwd: '/workspace', settings: {}, sessionState: state as unknown as JsonValue,
    observation: {
      latestExecution: { executionId: 'execution-1', status: 'running', startedAt: 2 },
      backgroundWork: null
    },
    createdAt: 1, updatedAt: 2
  }
  const projection = projectCodexOverview({ thread, layout: { availableColumns: 2 } })
    .view.presentation.projection
  expect(projection.identity?.usage?.parts.map(part => part.id)).toEqual(['total'])
  return projection.identity?.usage?.parts.find((part) => part.id === 'total')?.value
}

describe('Codex overview token abbreviation', () => {
  it('abbreviates token totals with K, M and B suffixes without a cache ratio', () => {
    expect([999, 18_527, 1_445_200, 2_500_000_000].map(totalLabel))
      .toEqual(['999', '18.5K', '1.4M', '2.5B'])
  })
})

describe('Codex fork overview', () => {
  it.each([false, true])('shows inherited context only until the child starts (started=%s)', started => {
    const history = settleCodexExecution(stageCodexExecution(createEmptyCodexState(1),
      'source-execution', { parts: [{ kind: 'text', text: 'Source question' }] }, 2, 'source-message'),
    'source-execution', 'completed', 3)
    const fork = { ...createEmptyCodexState(3), forkHistory: [{
      ...history.turns[0]!, answer: 'Inherited answer', usage: { inputTokens: 100, outputTokens: 50 }
    }] }
    const state = started ? stageCodexExecution(fork, 'child-execution',
      { parts: [{ kind: 'text', text: 'Child task' }] }, 4, 'child-message') : fork
    const sessionState = state as unknown as JsonValue
    const thread: AgentThreadRecord<'codex'> = {
      id: 'child', harnessId: 'codex', revision: 0, archived: false, title: 'Fork',
      tags: [], cwd: '/workspace', settings: {}, sessionState,
      observation: codexSessionState.project(sessionState), createdAt: 3, updatedAt: state.updatedAt
    }
    const overview = projectCodexOverview({ thread, layout: { availableColumns: 2 } })
    const expected = started ? 'Child task' : 'Inherited answer'
    expect(overview.excerpt).toBe(expected)
    expect(overview.view.identity.message?.text).toBe(expected)
    expect(overview.view.status).toBe(started ? 'running' : 'idle')
    expect(overview.view.presentation.projection.identity?.usage).toBeUndefined()
    expect(overview.view.pendingInteractionId).toBeUndefined()
    if (!started) expect(overview.view.identity.runtime).toBeUndefined()
  })
})
