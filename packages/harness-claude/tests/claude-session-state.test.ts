import { describe, expect, it, vi } from 'vitest'
import { createClaudeMainPlugin } from '../src/main/index.js'
import { encodeClaudeThreadState } from '../src/main/thread/state.js'
import { parseClaudeThreadState, type ClaudeThreadState, type ClaudeTurn } from '../src/shared/state.js'
import { claudePublicInteractionId } from '../src/shared/public-interactions.js'

function adapter() {
  return createClaudeMainPlugin({
    resolveExecutable: async () => '/unused/claude',
    environment: async () => ({})
  }).sessionState
}

function turn(executionId: string, createdAt: number, status: ClaudeTurn['status']): ClaudeTurn {
  return {
    executionId, createdAt, updatedAt: createdAt + 10,
    ...(status === 'running' ? {} : { finishedAt: createdAt + 5 }),
    prompts: [executionId], promptAttachments: [[]], text: `${executionId} answer`,
    lastAssistantMessage: { id: `${executionId}-answer`, text: `${executionId} answer` }, reasoning: '',
    status, plan: [], activities: [], interactions: [], notices: [], timeline: []
  }
}

function session(turns: ClaudeTurn[]): ClaudeThreadState {
  return { version: 1, turns, nativeNotifications: [] }
}

function freeze<Value>(value: Value): Value {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}

describe('Claude persisted Session observation authority', () => {
  it.each(['completed', 'failed', 'interrupted'] as const)(
    'preserves the last assistant message through %s settlement and historical lookup', outcome => {
      const answer = `  ## Result\n\n${'Long answer\n'.repeat(300)}`
      const current = turn('current', 10, 'running')
      current.text = `Starting work.\n${answer}`
      current.error = 'Native error is not the answer'
      current.lastAssistantMessage = { id: 'last', text: answer }
      const { settle, project, resolveExecution } = adapter()
      if (outcome === 'completed') {
        current.status = 'completed'
        current.finishedAt = current.updatedAt = 30
      }
      const encoded = encodeClaudeThreadState(session([current]))
      const settled = outcome === 'completed' ? encoded : settle({ sessionState: encoded,
        executionId: 'current', outcome, finishedAt: 30 })
      expect(project(settled).latestExecution).toMatchObject({ status: outcome, summary: answer })
      const stored = parseClaudeThreadState(JSON.parse(JSON.stringify(settled)))
      stored.turns.push(turn('next', 40, 'running'))
      expect(resolveExecution(encodeClaudeThreadState(stored), 'current')?.summary).toBe(answer)
    }
  )

  it.each([undefined, { id: 'last-empty', text: '' }])(
    'does not substitute aggregate text, prompt or error for missing assistant text: %j', lastAssistantMessage => {
      const current = turn('empty', 10, 'failed')
      if (lastAssistantMessage === undefined) delete current.lastAssistantMessage
      else current.lastAssistantMessage = lastAssistantMessage
      current.error = 'Native error'
      expect(adapter().project(encodeClaudeThreadState(session([current]))).latestExecution)
        .toEqual({ executionId: 'empty', startedAt: 10, finishedAt: 15, status: 'failed', error: 'Native error' })
    }
  )

  it('reconstructs the last persisted execution and immutable finish time independently of the clock', () => {
    const state = session([turn('older', 10, 'failed'), turn('latest', 100, 'completed')])
    state.turns[0]!.updatedAt = 90_000
    state.turns[1]!.updatedAt = 100_000
    state.runtime = { backgroundTasks: [{ id: 'old-task', description: 'Old task', status: 'running' }] }
    const encoded = freeze(encodeClaudeThreadState(state))
    const project = adapter().project
    const expected = {
      latestExecution: {
        executionId: 'latest', startedAt: 100, finishedAt: 105,
        status: 'completed', summary: 'latest answer'
      },
      backgroundWork: { status: 'running' }
    }
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Projection read the clock') })
    try {
      expect(project(encoded)).toEqual(expected)
      expect(project(JSON.parse(JSON.stringify(encoded)))).toEqual(expected)
    } finally { clock.mockRestore() }
    state.runtime.backgroundTasks![0]!.status = 'completed'
    expect(project(encodeClaudeThreadState(state))).toEqual({ ...expected, backgroundWork: null })
  })

  it('projects Session background work even without any foreground execution', () => {
    const state = session([])
    state.runtime = { backgroundTasks: [{ id: 'task', description: 'Task', status: 'in_progress' }] }
    expect(adapter().project(encodeClaudeThreadState(state))).toEqual({
      latestExecution: null, backgroundWork: { status: 'running' }
    })
  })

  it('derives all pending interaction identities from the persisted execution', () => {
    const state = session([turn('persisted-execution', 10, 'running')])
    state.turns[0]!.interactions = [{
      id: 'native/approval?private', kind: 'permission', title: 'Allow?', status: 'pending'
    }]
    const project = adapter().project
    const encoded = freeze(encodeClaudeThreadState(state))
    expect(project(encoded)).toMatchObject({
      latestExecution: {
        executionId: 'persisted-execution', status: 'waiting-for-user',
        interactions: [{ id: claudePublicInteractionId('persisted-execution', 'native/approval?private') }]
      }
    })
    expect(project(encoded)).toEqual(project(JSON.parse(JSON.stringify(encoded))))
    expect(JSON.stringify(project(encoded))).not.toContain('native/approval?private')
  })

  it('settles only the named nonterminal execution without disturbing Session background work', () => {
    const state = session([turn('older', 10, 'running'), turn('latest', 100, 'completed')])
    state.turns[0]!.activities = [{
      id: 'old-foreground', kind: 'tool', label: 'Foreground tool', status: 'running'
    }, {
      id: 'old-background', taskId: 'background', kind: 'task', label: 'Background task', status: 'running'
    }]
    state.turns[0]!.interactions = [{ id: 'permission', kind: 'permission', title: 'Allow?', status: 'pending' }]
    state.runtime = { backgroundTasks: [{ id: 'background', description: 'Still running', status: 'running' }] }
    const encoded = freeze(encodeClaudeThreadState(state))
    const before = JSON.stringify(encoded)
    const { settle, project } = adapter()
    const input = { sessionState: encoded, executionId: 'older', outcome: 'interrupted' as const, finishedAt: 200 }
    const settled = settle(input)
    expect(settle(input)).toEqual(settled)
    expect(JSON.stringify(encoded)).toBe(before)
    const parsed = parseClaudeThreadState(settled)
    expect(parsed.turns[0]).toMatchObject({
      status: 'interrupted', finishedAt: 200,
      activities: [{ status: 'cancelled' }, { status: 'running' }],
      interactions: [{ status: 'cancelled' }]
    })
    expect(parsed.turns[1]).toEqual(state.turns[1])
    expect(parsed.runtime).toEqual(state.runtime)
    expect(project(settled)).toEqual(project(encoded))
    expect(settle({ ...input, sessionState: settled, outcome: 'failed', finishedAt: 300 })).toEqual(settled)
    expect(settle({ ...input, executionId: 'missing' })).toEqual(encoded)
  })

  it('rejects terminal state without its durable completion time and a running turn with one', () => {
    const terminal = session([turn('terminal', 10, 'completed')])
    delete terminal.turns[0]!.finishedAt
    expect(() => adapter().project(terminal as never)).toThrow('finishedAt')
    const running = session([turn('running', 10, 'running')])
    running.turns[0]!.finishedAt = 11
    expect(() => adapter().project(running as never)).toThrow('finishedAt')
  })
})
