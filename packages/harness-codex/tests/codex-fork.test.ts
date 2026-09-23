import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonValue, type AgentThreadRecord, type JsonValue } from '@openagent/contracts'
import { createAgentOpenContext } from '@openagent/test-kit'
import { createCodexMainPlugin } from '../src/main/index.js'
import { createEmptyCodexState, decodeCodexState, settleCodexExecution, stageCodexExecution } from '../src/shared/state.js'
import type { CodexThreadSettings } from '../src/shared/types.js'

const executable = resolve(import.meta.dirname, '../../../apps/desktop/tests/fixtures/fake-codex-app-server.mjs')
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup(environment: Record<string, string> = {}) {
  await chmod(executable, 0o755)
  const root = await mkdtemp(join(tmpdir(), 'codex-fork-'))
  directories.push(root)
  const logPath = join(root, 'wire.jsonl')
  const plugin = createCodexMainPlugin({
    resolveExecutable: async () => executable,
    environment: async () => ({ ...process.env, FAKE_CODEX_LOG: logPath, ...environment }),
    dataRoot: root, temporaryWorkspaceRoot: root
  })
  const state = settleCodexExecution(stageCodexExecution({
    ...createEmptyCodexState(1), primarySessionId: 'native-source'
  }, 'source-execution', { parts: [{ kind: 'text', text: 'Original question.' }] }, 2, 'source-message'),
  'source-execution', 'completed', 3)
  const source: AgentThreadRecord<'codex', CodexThreadSettings> = {
    id: 'source', harnessId: 'codex', title: 'Source', tags: [], archived: false,
    revision: 0, cwd: root, settings: { model: 'gpt-5.4', sandbox: 'read-only', approvalPolicy: 'never' },
    sessionState: json(state), observation: plugin.sessionState.project(json(state)), createdAt: 1, updatedAt: 3
  }
  return {
    plugin, source,
    wire: async () => (await readFile(logPath, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
  }
}

describe('Codex Agent Thread fork', () => {
  it('persists a native fork without a turn, retains history, and resumes only the child', async () => {
    const { plugin, source, wire } = await setup()
    const before = structuredClone(source)
    try {
      const result = await plugin.forkThread!({ source, request: {}, signal: new AbortController().signal })
      const state = decodeCodexState(result.sessionState)
      expect(source).toEqual(before)
      expect(state.primarySessionId).toBe('thread-fork-1')
      expect(state.turns).toEqual([])
      expect(state.forkHistory).toEqual(decodeCodexState(source.sessionState).turns)
      expect(plugin.sessionState.project(result.sessionState)).toEqual({ latestExecution: null, backgroundWork: null })
      expect(plugin.sessionState.resolveExecution(result.sessionState, 'source-execution')).toBeNull()
      const initialWire = await wire()
      expect(initialWire.filter(message => message.method === 'thread/fork')).toEqual([
        expect.objectContaining({ params: expect.objectContaining({
          threadId: 'native-source', cwd: source.cwd, model: 'gpt-5.4',
          sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false, developerInstructions: ''
        }) })
      ])
      expect(initialWire.some(message => message.method === 'turn/start' || message.method === 'thread/start')).toBe(false)

      let child: AgentThreadRecord<'codex', CodexThreadSettings> = {
        ...source, id: 'child', sessionState: result.sessionState,
        observation: plugin.sessionState.project(result.sessionState)
      }
      const handle = await plugin.openThread(createAgentOpenContext({
        sessionState: plugin.sessionState, getRecord: () => child, setRecord: next => { child = next }
      }))
      try {
        await handle.send({ executionId: 'child-execution', input: { parts: [{ kind: 'text', text: 'Explore an alternative.' }] }, signal: new AbortController().signal })
        await vi.waitFor(() => expect(child.observation.latestExecution?.status).toBe('completed'))
        const messages = await wire()
        expect(messages.filter(message => message.method === 'thread/fork')).toHaveLength(1)
        expect(messages.find(message => message.method === 'thread/resume')?.params?.threadId).toBe('thread-fork-1')
        expect(messages.find(message => message.method === 'turn/start')?.params?.threadId).toBe('thread-fork-1')
        expect(decodeCodexState(child.sessionState).forkHistory).toEqual(state.forkHistory)
        expect(source).toEqual(before)
      } finally { await handle.dispose() }
    } finally { await plugin.dispose?.() }
  })

  it.each(['missing-session', 'busy', 'injected', 'selector', 'cancelled', 'malformed-response'] as const)(
    'rejects %s forks', async kind => {
      const { plugin, source } = await setup(kind === 'malformed-response' ? { FAKE_CODEX_MISSING_THREAD_ID: 'fork' } : {})
      const state = decodeCodexState(source.sessionState)
      const controller = new AbortController()
      let sessionState: JsonValue = source.sessionState
      if (kind === 'missing-session') sessionState = json(createEmptyCodexState())
      if (kind === 'busy') sessionState = json(stageCodexExecution(state, 'active', { parts: [{ kind: 'text', text: 'Busy.' }] }, 4, 'active-message'))
      if (kind === 'injected') sessionState = json({ ...state, nativeToolConfiguration: 'a'.repeat(64), nativeToolMode: 'exclusive' })
      if (kind === 'cancelled') controller.abort(new Error('cancelled fork'))
      try {
        await expect(plugin.forkThread!({
          source: { ...source, sessionState }, request: kind === 'selector' ? { checkpointId: 'old' } : {}, signal: controller.signal
        })).rejects.toThrow()
      } finally { await plugin.dispose?.() }
    }
  )

  it('retains inherited history on another fork without acquiring its execution identities', async () => {
    const { plugin, source } = await setup()
    const state = decodeCodexState(source.sessionState)
    const inherited = { ...state.turns[0]!, executionId: 'grandparent-execution' }
    try {
      const result = await plugin.forkThread!({
        source: { ...source, sessionState: json({ ...state, forkHistory: [inherited] }) },
        request: {}, signal: new AbortController().signal
      })
      expect(decodeCodexState(result.sessionState).forkHistory?.map(turn => turn.executionId))
        .toEqual(['grandparent-execution', 'source-execution'])
      expect(plugin.sessionState.resolveExecution(result.sessionState, 'grandparent-execution')).toBeNull()
    } finally { await plugin.dispose?.() }
  })
})

function json(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw new Error('Invalid test JSON')
  return value
}
