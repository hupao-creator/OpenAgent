import { describe, expect, it } from 'vitest'
import type { AgentThreadRecord, JsonValue } from '@openagent/contracts'
import { projectCodexOverview } from '../src/renderer/overview.js'
import { createEmptyCodexState, stageCodexExecution } from '../src/shared/state.js'

function totalLabel(totalTokens: number): string | undefined {
  const state = stageCodexExecution(
    createEmptyCodexState(1),
    'execution-1',
    { parts: [{ kind: 'text', text: 'Audit' }] },
    2,
    'user-1'
  )
  state.turns[0] = { ...state.turns[0]!, usage: { inputTokens: totalTokens, outputTokens: 0 } }
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
  return projection.identity?.usage?.parts.find((part) => part.id === 'total')?.value
}

describe('Codex overview token abbreviation', () => {
  it('abbreviates token totals with K, M and B suffixes', () => {
    expect([999, 18_527, 1_445_200, 2_500_000_000].map(totalLabel))
      .toEqual(['999', '18.5K', '1.4M', '2.5B'])
  })
})
