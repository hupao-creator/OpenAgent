import { describe, expect, it } from 'vitest'
import { codexSessionState } from '../../../packages/harness-codex/src/shared/session-state'
import { claudeSessionStateAdapter } from '../../../packages/harness-claude/src/main/thread/observation'
import { createCodexPreview } from '../playgrounds/thread-detail/src/native-fixtures/codex'
import { createClaudePreview } from '../playgrounds/thread-detail/src/native-fixtures/claude'

for (const [name, adapter, fixture] of [
  ['codex', codexSessionState, createCodexPreview],
  ['claude', claudeSessionStateAdapter, createClaudePreview]
] as const) {
  describe(`${name} owning Session Execution lookup`, () => {
    it.each(['running', 'approval', 'question', 'completed', 'failed', 'interrupted', 'background'] as const)(
      'resolves a historical completed Execution while the latest is %s after persistence roundtrip', (phase) => {
        const input = fixture({ threadId: 'lookup', phase, history: true, answer: 'Latest output' })
        const state = JSON.parse(JSON.stringify(input.sessionState))
        const old = state.turns[0]
        const before = JSON.stringify(state)
        const execution = adapter.resolveExecution(state, old.executionId)
        expect(execution).toMatchObject({ executionId: old.executionId, status: 'completed', startedAt: old.createdAt, finishedAt: old.finishedAt })
        expect(adapter.resolveExecution(state, input.observation.latestExecution!.executionId)).toEqual(adapter.project(state).latestExecution)
        expect(adapter.resolveExecution(state, 'another-threads-execution')).toBeNull()
        expect(JSON.stringify(state)).toBe(before)
      }
    )
    it('returns no Execution for a fresh Session', () => {
      expect(adapter.resolveExecution(null, 'missing')).toBeNull()
      const input = fixture({ threadId: 'empty', phase: 'empty', history: false, answer: '' })
      expect(adapter.resolveExecution(input.sessionState, 'missing')).toBeNull()
    })
  })
}
