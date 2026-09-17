import { describe, expect, it } from 'vitest'
import {
  recordClaudeActivity,
  recordClaudeInteraction,
  settleClaudeTurn
} from '../src/main/thread/timeline.js'
import { failStaleClaudeBackgroundWork } from '../src/main/thread/state.js'
import { CLAUDE_STATE_LIMITS, parseClaudeThreadState, type ClaudeActivity, type ClaudeTurn } from '../src/shared/state.js'
import { claudeActivityRunStarts, projectClaudeTimeline } from '../src/shared/timeline.js'

describe('Claude current entity and checkpoint history boundaries', () => {
  it.each(['', 42, 'x'.repeat(513)])('rejects malformed optional native message identity %j', messageId => {
    const turn = runningTurn()
    const assistant = turn.timeline.find(item => item.kind === 'assistant')!
    expect(() => parseClaudeThreadState({
      version: 1, turns: [{ ...turn, timeline: [{ ...assistant, messageId }] }], nativeNotifications: []
    })).toThrow('messageId')
  })

  it('round-trips legacy text items and still rejects unknown assistant fields', () => {
    const turn = runningTurn()
    const restored = parseClaudeThreadState(JSON.parse(JSON.stringify({
      version: 1, turns: [turn], nativeNotifications: []
    }))).turns[0]!
    expect(restored.timeline).toEqual(turn.timeline)
    const assistant = turn.timeline.find(item => item.kind === 'assistant')!
    expect(() => parseClaudeThreadState({
      version: 1, turns: [{ ...turn, timeline: [{ ...assistant, revisionIdentity: 'invalid' }] }], nativeNotifications: []
    })).toThrow()
  })

  it.each([
    ['completed', 'completed', 'complete'],
    ['failed', 'failed', 'failed'],
    ['interrupted', 'cancelled', 'cancelled']
  ] as const)('settles %s once while preserving earlier checkpoint snapshots', (
    outcome, activityStatus, textStatus
  ) => {
    const turn = runningTurn()
    const firstActivity = turn.timeline.find((item) => item.kind === 'activity')!
    const firstInteraction = turn.timeline.find((item) => item.kind === 'interaction')!
    turn.updatedAt = 5
    settleClaudeTurn(turn, outcome)

    expect(turn.status).toBe(outcome)
    expect(turn.activities[0]?.status).toBe(activityStatus)
    expect(turn.interactions[0]?.status).toBe('cancelled')
    expect(firstActivity.activity.status).toBe('running')
    expect(firstInteraction.interaction.status).toBe('pending')
    expect(turn.timeline.findLast((item) => item.kind === 'activity')?.activity.status)
      .toBe(activityStatus)
    expect(turn.timeline.findLast((item) => item.kind === 'interaction')?.interaction.status)
      .toBe('cancelled')
    expect(turn.timeline.find((item) => item.kind === 'assistant')?.status).toBe(textStatus)

    const restored = parseClaudeThreadState({ version: 1, turns: [turn], nativeNotifications: [] })
      .turns[0]!
    const current = projectClaudeTimeline(restored)
    expect(current.map((item) => item.kind)).toEqual([
      'user-message', 'activity', 'interaction', 'assistant'
    ])
    expect(current[1]).toMatchObject({
      id: firstActivity.id, createdAt: firstActivity.createdAt,
      activity: { status: activityStatus }
    })
    expect(current[2]).toMatchObject({
      id: firstInteraction.id, createdAt: firstInteraction.createdAt,
      interaction: { status: 'cancelled' }
    })

    const settled = structuredClone(turn)
    settleClaudeTurn(turn, outcome)
    expect(turn).toEqual(settled)
  })

  it('uses current state even when a persisted terminal turn has only earlier history snapshots', () => {
    const turn = runningTurn()
    turn.status = 'interrupted'
    turn.activities[0]!.status = 'cancelled'
    turn.interactions[0]!.status = 'cancelled'
    const current = projectClaudeTimeline(turn)
    expect(current.find((item) => item.kind === 'activity')?.activity).toBe(turn.activities[0])
    expect(current.find((item) => item.kind === 'interaction')?.interaction).toBe(turn.interactions[0])
    expect(current.find((item) => item.kind === 'activity')?.activity.status).toBe('cancelled')
    expect(current.find((item) => item.kind === 'interaction')?.interaction.status).toBe('cancelled')
  })

  it('retains an allowed interaction and a completed activity when the enclosing turn is interrupted', () => {
    const turn = runningTurn()
    recordClaudeInteraction(turn, { ...turn.interactions[0]!, status: 'allowed' }, 4)
    recordClaudeActivity(turn, { ...turn.activities[0]!, status: 'completed', detail: 'Final output' }, 4)
    turn.updatedAt = 5
    turn.status = 'interrupted'
    settleClaudeTurn(turn, 'interrupted')
    const current = projectClaudeTimeline(turn)
    expect(current.find((item) => item.kind === 'interaction')?.interaction.status).toBe('allowed')
    expect(current.find((item) => item.kind === 'activity')?.activity)
      .toMatchObject({ status: 'completed', detail: 'Final output' })
  })

  it('records failed stale background work and projects it without changing its first position', () => {
    const turn = runningTurn()
    turn.status = 'completed'
    const state = {
      version: 1 as const,
      turns: [turn],
      nativeNotifications: [],
      runtime: { backgroundTasks: [{ id: 'task-1', description: 'Task', status: 'running' }] }
    }
    expect(failStaleClaudeBackgroundWork(state)).toBe(true)
    expect(state.runtime.backgroundTasks[0]?.status).toBe('failed')
    expect(projectClaudeTimeline(turn)[1]).toMatchObject({
      createdAt: 2, activity: { status: 'failed' }
    })
    expect(turn.timeline.findLast((item) => item.kind === 'activity')?.activity.status).toBe('failed')
    expect(failStaleClaudeBackgroundWork(state)).toBe(false)
  })

  it('does not resurrect removed current entities from historical snapshots', () => {
    const turn = runningTurn()
    turn.activities = []
    turn.interactions = []
    expect(projectClaudeTimeline(turn).map((item) => item.kind)).toEqual(['user-message', 'assistant'])
  })

  it('splits a run of activities that projection made look adjacent', () => {
    const turn = runningTurn()
    const read: ClaudeActivity = { id: 'tool-1', kind: 'tool', label: 'Read', status: 'completed' }
    const edit: ClaudeActivity = { id: 'tool-2', kind: 'tool', label: 'Edit', status: 'completed' }
    turn.activities = [read, edit]
    turn.interactions = []
    turn.timeline = [
      { id: 'act-1', kind: 'activity', createdAt: 1, activity: read },
      { id: 'diff-1', kind: 'diff', createdAt: 2, content: 'Changed' },
      { id: 'act-2', kind: 'activity', createdAt: 3, activity: edit }
    ]
    expect(projectClaudeTimeline(turn).map((item) => item.kind)).toEqual(['activity', 'activity'])
    expect([...claudeActivityRunStarts(turn)]).toEqual(['act-1', 'act-2'])
  })

  it('holds a boundary across an activity snapshot that projection deduplicated', () => {
    const turn = runningTurn()
    const read: ClaudeActivity = { id: 'tool-1', kind: 'tool', label: 'Read', status: 'running' }
    const edit: ClaudeActivity = { id: 'tool-2', kind: 'tool', label: 'Edit', status: 'completed' }
    turn.activities = [read, edit]
    turn.interactions = []
    turn.timeline = [
      { id: 'act-1', kind: 'activity', createdAt: 1, activity: read },
      { id: 'diff-1', kind: 'diff', createdAt: 2, content: 'Changed' },
      { id: 'act-1-update', kind: 'activity', createdAt: 3, activity: { ...read, status: 'completed' } },
      { id: 'act-2', kind: 'activity', createdAt: 4, activity: edit }
    ]
    expect(projectClaudeTimeline(turn).map((item) => item.id)).toEqual(['act-1', 'act-2'])
    expect([...claudeActivityRunStarts(turn)]).toEqual(['act-1', 'act-2'])
  })

  it('holds a boundary across a snapshot whose entity no longer exists', () => {
    const turn = runningTurn()
    const read: ClaudeActivity = { id: 'tool-1', kind: 'tool', label: 'Read', status: 'completed' }
    const edit: ClaudeActivity = { id: 'tool-2', kind: 'tool', label: 'Edit', status: 'completed' }
    const gone: ClaudeActivity = { id: 'tool-gone', kind: 'tool', label: 'Removed', status: 'completed' }
    turn.activities = [read, edit]
    turn.interactions = []
    turn.timeline = [
      { id: 'act-1', kind: 'activity', createdAt: 1, activity: read },
      { id: 'diff-1', kind: 'diff', createdAt: 2, content: 'Changed' },
      { id: 'act-gone', kind: 'activity', createdAt: 3, activity: gone },
      { id: 'act-2', kind: 'activity', createdAt: 4, activity: edit }
    ]
    expect(projectClaudeTimeline(turn).map((item) => item.id)).toEqual(['act-1', 'act-2'])
    expect([...claudeActivityRunStarts(turn)]).toEqual(['act-1', 'act-2'])
  })

  it('can persist multiple settlement snapshots when the bounded history is already full', () => {
    const turn = runningTurn()
    turn.activities.push({ id: 'task-2', kind: 'task', label: 'Second task', status: 'running' })
    turn.timeline = Array.from({ length: CLAUDE_STATE_LIMITS.timelineItemsPerTurn }, (_, index) => ({
      id: `retained-${index}`, kind: 'context-compaction', createdAt: 1
    }))
    settleClaudeTurn(turn, 'interrupted')
    expect(turn.timeline).toHaveLength(CLAUDE_STATE_LIMITS.timelineItemsPerTurn)
    expect(() => parseClaudeThreadState({ version: 1, turns: [turn], nativeNotifications: [] }))
      .not.toThrow()
    expect(turn.timeline.slice(-3).map((item) => item.kind)).toEqual([
      'activity', 'activity', 'interaction'
    ])
  })
})

function runningTurn(): ClaudeTurn {
  const turn: ClaudeTurn = {
    executionId: 'execution-1', createdAt: 1, updatedAt: 4,
    prompts: ['Run'], promptAttachments: [[]], text: 'Answer', reasoning: '',
    status: 'running', plan: [], activities: [], interactions: [], notices: [],
    timeline: [{ id: 'user', kind: 'user-message', createdAt: 1, promptIndex: 0 }]
  }
  recordClaudeActivity(turn, { id: 'task-1', kind: 'task', label: 'Task', status: 'running' }, 2)
  recordClaudeInteraction(turn, { id: 'permission-1', kind: 'permission', title: 'Allow?', status: 'pending' }, 3)
  turn.timeline.push({ id: 'answer', kind: 'assistant', createdAt: 4, content: 'Answer', status: 'streaming' })
  return turn
}
