import { describe, expect, it, vi } from 'vitest'
import type { CodexRuntime } from '../src/main/runtime/index.js'
import type {
  CodexAppServer,
  CodexTurnOptions
} from '../src/main/runtime/app-server.js'
import { openCodexThread } from '../src/main/thread/thread-handle.js'
import { codexSessionState } from '../src/shared/session-state.js'
import { decodeCodexState } from '../src/shared/state.js'
import type { CodexThreadSettings } from '../src/shared/types.js'
import type { AgentThreadRecord } from '@openagent/contracts'
import { createAgentOpenContext } from '@openagent/test-kit'

describe('Codex Thread lifecycle', () => {
  it('cancels a follow-up waiting for the first turn without cancelling primary admission', async () => {
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    let turnOptions: CodexTurnOptions | undefined
    const steer = vi.fn(async () => undefined)
    const startTurn = vi.fn(async (options: CodexTurnOptions) => {
      turnOptions = options
      options.emit({ type: 'session', sessionId: 'native-primary' })
      await startGate
      return {
        sessionId: 'native-primary',
        steer,
        cancel: async () => { options.emit({ type: 'done', outcome: 'interrupted' }) }
      }
    })
    const server = {
      startTurn,
      subscribeNativeActivity: () => () => undefined,
      dispose: async () => undefined
    } as unknown as CodexAppServer
    const runtime = {
    context: {},
      server: async () => ({ executable: '/fake/codex', server })
    } as unknown as CodexRuntime
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'thread-pending-primary',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Pending primary turn',
      tags: [],
      cwd: '/fake/workspace',
      settings: {},
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const handle = await openCodexThread(runtime, createAgentOpenContext({
      sessionState: codexSessionState,
      getRecord: () => record,
      setRecord: (next) => { record = next }
    }))
    const starting = handle.send({
      executionId: 'execution-primary',
      input: { parts: [{ kind: 'text', text: 'Start the primary turn.' }] },
      signal: new AbortController().signal
    })
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce())
    const followUp = new AbortController()
    let result: { error?: unknown; completed?: true } | undefined
    const following = handle.send({
      executionId: 'execution-primary',
      input: { parts: [{ kind: 'text', text: 'Cancelled follow-up.' }] },
      signal: followUp.signal
    }).then(
      () => { result = { completed: true } },
      (error: unknown) => { result = { error } }
    )

    try {
      followUp.abort()
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()

      expect(result).toMatchObject({ error: { name: 'AbortError' } })
      expect(turnOptions?.admissionSignal?.aborted).toBe(false)
      expect(turnOptions?.signal.aborted).toBe(false)
      expect(decodeCodexState(record.sessionState).turns[0]?.messages).toHaveLength(1)
      expect(steer).not.toHaveBeenCalled()
    } finally {
      releaseStart()
      await starting
      await following
      await handle.dispose()
    }
  })
})
