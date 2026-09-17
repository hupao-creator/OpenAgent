import { describe, expect, it, vi } from 'vitest'
import type { AgentThreadRecord } from '@openagent/contracts'
import type { CodexRuntime } from '../src/main/runtime/index.js'
import type { CodexAppServer, CodexTurnOptions } from '../src/main/runtime/app-server.js'
import { openCodexThread } from '../src/main/thread/thread-handle.js'
import { codexSessionState } from '../src/shared/session-state.js'
import { createEmptyCodexState } from '../src/shared/state.js'
import type { CodexThreadSettings } from '../src/shared/types.js'
import { createAgentOpenContext } from '@openagent/test-kit'

describe('Codex Thread Read behavioral constraints', () => {
  it.each(['read-only', 'workspace-write'] as const)(
    'forbids even read-only tool calls without changing the %s source settings',
    async sandbox => {
      const settings: CodexThreadSettings = {
        executablePath: '/pinned/codex',
        sandbox,
        approvalPolicy: 'never'
      }
      let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
        id: 'read-behavior', harnessId: 'codex', archived: false, revision: 0,
        title: 'Read behavior', tags: [], cwd: '/workspace', settings,
        sessionState: JSON.parse(JSON.stringify({
          ...createEmptyCodexState(1),
          primarySessionId: 'native-source'
        })),
        observation: { latestExecution: null, backgroundWork: null },
        createdAt: 1, updatedAt: 1
      }
      const startTurn = vi.fn(async (options: CodexTurnOptions) => {
        options.emit({ type: 'text-final', itemId: 'answer', text: 'History answer.' })
        options.emit({ type: 'done', outcome: 'completed' })
        return { sessionId: 'read-fork', cancel: async () => undefined, steer: async () => undefined }
      })
      const dispose = vi.fn(async () => undefined)
      const runtime = {
        server: vi.fn(async () => ({
          executable: '/pinned/codex',
          server: { startTurn, dispose } as unknown as CodexAppServer
        }))
      } as unknown as CodexRuntime
      const handle = await openCodexThread(runtime, createAgentOpenContext({
        sessionState: codexSessionState,
        getRecord: () => record,
        setRecord: next => { record = next }
      }))
      try {
        const before = structuredClone(record)
        await expect(handle.read('What happened?', new AbortController().signal))
          .resolves.toBe('History answer.')
        expect(startTurn).toHaveBeenCalledOnce()
        const options = startTurn.mock.calls[0]![0]
        const input = options.inputs[0]!
        if (input.type !== 'text') throw new Error('Expected a text read prompt')
        // No-writes alone still permits read-only search / MCP tools. Keep the
        // explicit no-tools rule in the question, not in the cacheable prefix.
        expect(input.text).toContain('Do not call tools.')
        expect(input.text).toContain('If the history lacks the answer, say so')
        expect(input.text).toContain('do not continue its task')
        expect(input.text).toContain('Do not modify files, run commands')
        expect(input.text).toContain('Question: What happened?')
        expect(options.forkFromSessionId).toBe('native-source')
        expect(options.settings).toEqual({ ...settings, ephemeral: true })
        expect(options.toolMode).toBeUndefined()
        expect(record).toEqual(before)
        expect(dispose).toHaveBeenCalledOnce()
      } finally {
        await handle.dispose()
      }
    }
  )
})
