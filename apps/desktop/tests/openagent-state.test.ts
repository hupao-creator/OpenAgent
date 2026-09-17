import { describe, expect, it } from 'vitest'
import type { AgentThreadRecord, ThreadPublicObservation } from '@openagent/contracts'
import {
  createOpenAgentState,
  isOpenAgentState,
  MAX_TAG_POOL_SIZE,
  readAgentThread,
  readBartThread,
  reduceOpenAgentState,
  threadSettingsSourceFingerprint,
  type OpenAgentState
} from '../src/shared/openagent-state'
import { createDefaultOpenAgentSettings } from '../src/shared/openagent-settings'

describe('OpenAgent state', () => {
  it('keeps exactly one Bart distinguished only by kind', () => {
    let state = initialState()
    state = reduceOpenAgentState(state, {
      type: 'add-agent-thread',
      thread: agentThread()
    })

    expect(state.threads).toHaveLength(2)
    expect(readBartThread(state)).toMatchObject({
      id: 'bart-thread-1',
      bart: true,
      harnessId: 'codex'
    })
    expect(readAgentThread(state, 'thread-1')).not.toHaveProperty('bart')
    expect(Object.isFrozen(state.threads)).toBe(true)

    const missingFlag = structuredClone(state) as unknown as {
      threads: Array<Record<string, unknown>>
    }
    delete missingFlag.threads[0].bart
    expect(isOpenAgentState(missingFlag)).toBe(false)

    const duplicateBart = structuredClone(state) as unknown as {
      threads: Array<Record<string, unknown>>
    }
    duplicateBart.threads[1].bart = true
    duplicateBart.threads[1].transcript = []
    expect(isOpenAgentState(duplicateBart)).toBe(false)
  })

  it('adds and selects a forked Agent Thread in one state transition', () => {
    const sourceState = reduceOpenAgentState(initialState(), {
      type: 'add-agent-thread',
      thread: { ...agentThread(), id: 'source-thread' }
    })
    const state = reduceOpenAgentState(sourceState, {
      type: 'add-and-select-agent-thread',
      sourceThreadId: 'source-thread',
      expectedSourceRevision: 0,
      thread: agentThread()
    })

    expect(state.selectedThreadId).toBe('thread-1')
    expect(readAgentThread(state, 'thread-1')).toMatchObject({
      id: 'thread-1',
      revision: 0
    })
    expect(() => reduceOpenAgentState(state, {
      type: 'add-and-select-agent-thread',
      sourceThreadId: 'source-thread',
      expectedSourceRevision: 1,
      thread: { ...agentThread(), id: 'stale-fork' }
    })).toThrow('revision 已变化')
  })

  it('keeps cwd and worktree facts immutable across Agent metadata replacement', () => {
    const original = {
      ...agentThread(),
      worktree: {
        baseCwd: '/workspace',
        name: 'audit',
        native: false,
        cwd: '/workspace-worktrees/audit'
      }
    } satisfies AgentThreadRecord<'codex', { model: string }>
    const state = reduceOpenAgentState(initialState(), {
      type: 'add-agent-thread',
      thread: original
    })

    for (const replacement of [
      { ...original, revision: 1, updatedAt: 3, cwd: '/other-workspace' },
      {
        ...original,
        revision: 1,
        updatedAt: 3,
        worktree: { ...original.worktree, cwd: '/workspace-worktrees/replaced' }
      },
      { ...original, revision: 1, updatedAt: 3, worktree: undefined }
    ]) {
      expect(() => reduceOpenAgentState(state, {
        type: 'replace-agent-thread',
        threadId: original.id,
        expectedRevision: 0,
        thread: replacement
      })).toThrow('身份字段不可替换')
    }

    const renamed = reduceOpenAgentState(state, {
      type: 'replace-agent-thread',
      threadId: original.id,
      expectedRevision: 0,
      thread: { ...original, revision: 1, updatedAt: 3, title: 'Renamed' }
    })
    expect(readAgentThread(renamed, original.id)).toMatchObject({
      title: 'Renamed',
      cwd: original.cwd,
      worktree: original.worktree
    })
  })

  it('commits session state and its public projection together at one revision for Bart and Agent Threads', () => {
    let state = reduceOpenAgentState(initialState(), {
      type: 'add-agent-thread',
      thread: agentThread()
    })
    state = reduceOpenAgentState(state, {
      type: 'replace-thread-session-state',
      threadId: 'thread-1',
      expectedRevision: 0,
      sessionState: { messages: ['agent'] },
      observation: runningObservation('agent'),
      updatedAt: 3
    })
    state = reduceOpenAgentState(state, {
      type: 'replace-thread-session-state',
      threadId: 'bart-thread-1',
      expectedRevision: 0,
      sessionState: { messages: ['bart'] },
      observation: runningObservation('bart'),
      updatedAt: 3
    })
    expect(readAgentThread(state, 'thread-1')).toMatchObject({
      revision: 1,
      sessionState: { messages: ['agent'] },
      observation: { latestExecution: { executionId: 'agent', status: 'running' } }
    })
    expect(readBartThread(state)).toMatchObject({
      revision: 1,
      sessionState: { messages: ['bart'] },
      observation: { latestExecution: { executionId: 'bart', status: 'running' } }
    })
    expect(() => reduceOpenAgentState(state, {
      type: 'replace-thread-session-state',
      threadId: 'bart-thread-1',
      expectedRevision: 0,
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      updatedAt: 4
    })).toThrow('revision 已变化')
    expect(readBartThread(state)).toMatchObject({
      revision: 1,
      sessionState: { messages: ['bart'] },
      observation: { latestExecution: { executionId: 'bart', status: 'running' } }
    })
  })

  it('detaches both halves of a committed pair from mutable Plugin inputs', () => {
    const sourceState = initialState()
    const sessionState = { messages: ['original'] }
    const observation = runningObservation('execution-1')
    const committed = reduceOpenAgentState(sourceState, {
      type: 'replace-thread-session-state', threadId: 'bart-thread-1', expectedRevision: 0,
      sessionState, observation, updatedAt: 3
    })

    sessionState.messages.push('changed after commit')
    observation.latestExecution.executionId = 'different-execution'
    expect(readBartThread(committed)).toMatchObject({
      revision: 1,
      sessionState: { messages: ['original'] },
      observation: { latestExecution: { executionId: 'execution-1', status: 'running' } }
    })
    expect(readBartThread(sourceState)).toMatchObject({
      revision: 0,
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null }
    })
  })

  it('rejects invalid session state without publishing its otherwise valid projection', () => {
    const state = initialState()
    expect(() => reduceOpenAgentState(state, {
      type: 'replace-thread-session-state', threadId: 'bart-thread-1', expectedRevision: 0,
      sessionState: { invalid: undefined } as unknown as AgentThreadRecord['sessionState'],
      observation: runningObservation('must-not-publish'), updatedAt: 3
    })).toThrow('sessionState')
    expect(readBartThread(state)).toMatchObject({
      revision: 0,
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null }
    })
  })

  it('clears Bart by replacing its Thread identity and fences the old identity', () => {
    let state = reduceOpenAgentState(initialState(), {
      type: 'append-bart-transcript-item',
      threadId: 'bart-thread-1',
      item: {
        type: 'message',
        id: 'message-1',
        role: 'user',
        content: 'hello',
        status: 'complete',
        createdAt: 2
      },
      updatedAt: 2
    })
    expect(readBartThread(state).revision).toBe(1)
    state = reduceOpenAgentState(state, {
      type: 'replace-bart-thread',
      expectedThreadId: 'bart-thread-1',
      threadId: 'bart-thread-2',
      hostHarnessId: 'claude',
      settings: {
        ...state.settings,
        locale: 'en-US',
        bart: { ...state.settings.bart, hostHarnessPreference: 'claude' }
      },
      threadSettings: { permissionMode: 'bypassPermissions' },
      cwd: '/workspace/.bart',
      createdAt: 4
    })

    expect(readBartThread(state)).toEqual({
      id: 'bart-thread-2',
      bart: true,
      harnessId: 'claude',
      revision: 0,
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      title: 'Bart',
      tags: [],
      cwd: '/workspace/.bart',
      settings: { permissionMode: 'bypassPermissions' },
      transcript: [],
      createdAt: 4,
      updatedAt: 4
    })
    expect(state.selectedThreadId).toBe('bart-thread-2')
    expect(() => reduceOpenAgentState(state, {
      type: 'append-bart-transcript-item',
      threadId: 'bart-thread-1',
      item: {
        type: 'message', id: 'late', role: 'assistant', content: '',
        status: 'complete', createdAt: 5
      },
      updatedAt: 5
    })).toThrow('Bart Thread 已替换')
  })

  it('completes one pending Bart tool operation deterministically', () => {
    let state = reduceOpenAgentState(initialState(), {
      type: 'append-bart-transcript-item',
      threadId: 'bart-thread-1',
      item: {
        type: 'tool-operation',
        id: 'operation-1',
        executionId: 'execution-1',
        callId: 'call-1',
        name: 'thread_status',
        arguments: { threadId: 'thread-1' },
        createdAt: 2
      },
      updatedAt: 2
    })
    state = reduceOpenAgentState(state, {
      type: 'complete-bart-tool-operation',
      threadId: 'bart-thread-1',
      executionId: 'execution-1',
      callId: 'call-1',
      result: { status: 'done' },
      completedAt: 3,
      updatedAt: 3
    })
    expect(readBartThread(state).revision).toBe(2)
    expect(readBartThread(state).transcript[0]).toMatchObject({
      type: 'tool-operation',
      completedAt: 3,
      result: { status: 'done' }
    })
  })

  it('settles transient Bart audit output left by a process restart', () => {
    let state = reduceOpenAgentState(initialState(), {
      type: 'append-bart-transcript-item',
      threadId: 'bart-thread-1',
      item: {
        type: 'message',
        id: 'message-streaming',
        role: 'assistant',
        content: 'partial',
        createdAt: 2,
        status: 'streaming',
        executionId: 'execution-stale'
      },
      updatedAt: 2
    })
    state = reduceOpenAgentState(state, {
      type: 'settle-stale-bart-runtime',
      threadId: 'bart-thread-1',
      updatedAt: 4
    })
    expect(readBartThread(state).revision).toBe(2)
    expect(readBartThread(state).transcript[0]).toMatchObject({
      type: 'message',
      status: 'cancelled',
      content: 'partial'
    })
  })

  it('replaces the statically typed application settings shell', () => {
    const state = reduceOpenAgentState(initialState(), {
      type: 'replace-settings',
      settings: {
        ...createDefaultOpenAgentSettings(),
        locale: 'en-US'
      }
    })
    expect(state.settings.locale).toBe('en-US')
    expect(() => reduceOpenAgentState(state, {
      type: 'replace-settings',
      settings: {
        ...state.settings,
        bart: { ...state.settings.bart, hostHarnessPreference: 'claude' }
      }
    })).toThrow('必须同时替换')
  })

  it('rejects a tag pool beyond the fixed product limit', () => {
    const tagPool = Array.from({ length: MAX_TAG_POOL_SIZE + 1 }, (_, index) => ({
      name: `tag-${index}`,
      description: `Tag ${index}`
    }))
    expect(() => reduceOpenAgentState(initialState(), {
      type: 'replace-tag-pool', tagPool
    })).toThrow('Tag pool 不符合当前格式')
  })

  it('uses NFKC and case folding for every persisted Thread tag identity', () => {
    expect(() => reduceOpenAgentState(initialState(), {
      type: 'add-agent-thread',
      thread: {
        ...agentThread(),
        tags: ['Ｃｏｄｅｘ', 'codex']
      }
    })).toThrow('Agent Thread 不符合当前格式')

    expect(() => reduceOpenAgentState(initialState(), {
      type: 'replace-tag-pool',
      tagPool: [
        { name: 'ＡＩ', description: 'full width' },
        { name: 'ai', description: 'ascii' }
      ]
    })).toThrow('Tag pool 不符合当前格式')

    const withDuplicateReportTags = {
      ...structuredClone(initialState()),
      reports: [{
        id: 'report-1',
        title: 'Report',
        html: '<p>report</p>',
        relatedExecutions: [],
        tags: ['Ｒｅｖｉｅｗ', 'review'],
        createdAt: 2,
        updatedAt: 2,
        archived: false
      }]
    }
    expect(isOpenAgentState(withDuplicateReportTags)).toBe(false)
  })

  it('rejects non-round-trippable public observations without changing revision', () => {
    const state = reduceOpenAgentState(initialState(), {
      type: 'add-agent-thread',
      thread: agentThread()
    })
    const interaction = {
      id: 'interaction-1',
      kind: 'question',
      title: 'Question',
      actions: [{ id: 'submit', intent: 'submit', label: 'Submit' }],
      questions: [{
        id: 'choice',
        prompt: 'Choose',
        multiple: false,
        allowOther: false,
        secret: false,
        options: [{ value: 'a', label: 'A' }]
      }]
    }
    const invalidObservations: unknown[] = [
      {
        latestExecution: {
          executionId: 'execution-1', status: 'running', startedAt: 2,
          summary: undefined
        },
        backgroundWork: null
      },
      {
        latestExecution: {
          executionId: 'execution-1', status: 'failed', startedAt: 2,
          finishedAt: 3, error: undefined
        },
        backgroundWork: null
      },
      {
        latestExecution: {
          executionId: 'execution-1', status: 'waiting-for-user', startedAt: 2,
          interactions: [{ ...interaction, description: undefined }]
        },
        backgroundWork: null
      },
      {
        latestExecution: {
          executionId: 'execution-1', status: 'waiting-for-user', startedAt: 2,
          interactions: [{
            ...interaction,
            questions: [{ ...interaction.questions[0], header: undefined }]
          }]
        },
        backgroundWork: null
      },
      {
        latestExecution: {
          executionId: 'execution-1', status: 'waiting-for-user', startedAt: 2,
          interactions: [{
            ...interaction,
            questions: [{
              ...interaction.questions[0],
              options: [{ ...interaction.questions[0].options[0], description: undefined }]
            }]
          }]
        },
        backgroundWork: null
      }
    ]
    for (const observation of invalidObservations) {
      const persisted = {
        ...state,
        threads: state.threads.map(thread => thread.id === 'thread-1'
          ? { ...thread, observation }
          : thread)
      }
      expect(isOpenAgentState(persisted)).toBe(false)
      expect(() => reduceOpenAgentState(state, {
        type: 'replace-thread-session-state',
        threadId: 'thread-1',
        expectedRevision: 0,
        sessionState: { messages: ['must-not-publish'] },
        observation: observation as AgentThreadRecord['observation'],
        updatedAt: 3
      })).toThrow('observation')
      expect(readAgentThread(state, 'thread-1')).toMatchObject({
        revision: 0,
        sessionState: null,
        observation: { latestExecution: null, backgroundWork: null }
      })
    }

    const accepted = {
      latestExecution: {
        executionId: 'execution-1',
        status: 'waiting-for-user' as const,
        startedAt: 2,
        interactions: [interaction]
      },
      backgroundWork: null
    }
    const roundTripped = JSON.parse(JSON.stringify(accepted))
    expect(roundTripped).toEqual(accepted)
    const next = reduceOpenAgentState(state, {
      type: 'replace-thread-session-state',
      threadId: 'thread-1',
      expectedRevision: 0,
      sessionState: { messages: ['waiting-for-answer'] },
      observation: roundTripped,
      updatedAt: 3
    })
    expect(readAgentThread(next, 'thread-1')).toMatchObject({
      revision: 1,
      sessionState: { messages: ['waiting-for-answer'] },
      observation: accepted
    })
  })
})

function initialState() {
  return createOpenAgentState({
    bartThreadId: 'bart-thread-1',
    hostHarnessId: 'codex',
    bartThreadSettings: { model: 'gpt-5' },
    bartCwd: '/workspace/.bart',
    createdAt: 1,
    selectedThreadId: 'bart-thread-1',
    settings: createDefaultOpenAgentSettings()
  })
}

function agentThread(): AgentThreadRecord<'codex', { model: string }> {
  return {
    id: 'thread-1', harnessId: 'codex', archived: false, revision: 0, title: 'Thread', tags: [],
    cwd: '/workspace', settings: { model: 'gpt-5' }, sessionState: null,
    observation: { latestExecution: null, backgroundWork: null },
    createdAt: 2, updatedAt: 2
  }
}

it('applies field metadata to the latest streaming state without replacing the session pair', () => {
  let state = reduceOpenAgentState(initialState(), {
    type: 'add-agent-thread', thread: { ...agentThread(), titlePending: true }
  })
  const source = readAgentThread(state, 'thread-1')
  state = reduceOpenAgentState(state, {
    type: 'replace-thread-session-state', threadId: source.id,
    expectedRevision: source.revision, sessionState: { latest: 'streamed' },
    observation: runningObservation('streamed'), updatedAt: 10
  })
  state = reduceOpenAgentState(state, {
    type: 'update-agent-thread-metadata', threadId: source.id,
    title: 'Classified title', emoji: '🔎', tags: ['analysis'], updatedAt: 3
  })
  expect(readAgentThread(state, source.id)).toMatchObject({
    title: 'Classified title', emoji: '🔎', tags: ['analysis'],
    sessionState: { latest: 'streamed' },
    observation: { latestExecution: { executionId: 'streamed', status: 'running' } },
    updatedAt: 10, revision: 2
  })
  expect(readAgentThread(state, source.id)).not.toHaveProperty('titlePending')
})

it('guards settings by configuration and workspace without interpreting private state', () => {
  let state = reduceOpenAgentState(initialState(), {
    type: 'add-agent-thread', thread: { ...agentThread(), sessionState: { stream: 'one' } }
  })
  const source = readAgentThread(state, 'thread-1')
  const expectedSource = threadSettingsSourceFingerprint(source)
  state = reduceOpenAgentState(state, {
    type: 'replace-thread-session-state', threadId: source.id,
    expectedRevision: source.revision, sessionState: { stream: 'two' },
    observation: runningObservation('stream-two'), updatedAt: 10
  })
  expect(threadSettingsSourceFingerprint(readAgentThread(state, source.id)))
    .toBe(threadSettingsSourceFingerprint(source))
  state = reduceOpenAgentState(state, {
    type: 'update-agent-thread-settings', threadId: source.id,
    expectedSource, settings: { model: 'new-model' }, updatedAt: 3
  })
  expect(readAgentThread(state, source.id)).toMatchObject({
    settings: { model: 'new-model' }, sessionState: { stream: 'two' },
    observation: { latestExecution: { executionId: 'stream-two', status: 'running' } },
    updatedAt: 10
  })
  expect(() => reduceOpenAgentState(state, {
    type: 'update-agent-thread-settings', threadId: source.id,
    expectedSource, settings: { model: 'stale' }, updatedAt: 11
  })).toThrow('settings source conflict')
})

function runningObservation(executionId: string) {
  return {
    latestExecution: { executionId, status: 'running' as const, startedAt: 3 },
    backgroundWork: null
  }
}

describe('Issue #139 automatic archive for failed Agent Threads', () => {
  const failed = (executionId: string, startedAt: number) => ({
    latestExecution: {
      executionId, status: 'failed' as const, startedAt, finishedAt: startedAt + 1, summary: 'boom'
    },
    backgroundWork: null
  })
  const started = (executionId: string, startedAt: number) => ({
    latestExecution: { executionId, status: 'running' as const, startedAt },
    backgroundWork: null
  })
  const commit = (
    state: OpenAgentState, observation: ThreadPublicObservation, updatedAt = 10
  ) => {
    const source = readAgentThread(state, 'thread-1')
    return reduceOpenAgentState(state, {
      type: 'replace-thread-session-state', threadId: source.id,
      expectedRevision: source.revision, sessionState: { kept: 'content' },
      observation, updatedAt
    })
  }
  const seeded = () => reduceOpenAgentState(initialState(), {
    type: 'add-agent-thread', thread: agentThread()
  })

  it('archives the Thread in the same commit that publishes the failure and keeps the error readable', () => {
    const state = commit(commit(seeded(), started('execution-1', 3)), failed('execution-1', 3))
    expect(readAgentThread(state, 'thread-1')).toMatchObject({
      archived: true,
      sessionState: { kept: 'content' },
      observation: {
        latestExecution: { executionId: 'execution-1', status: 'failed', summary: 'boom' }
      }
    })
  })

  it('does not re-archive the same failed Execution after an explicit unarchive', () => {
    let state = commit(commit(seeded(), started('execution-1', 3)), failed('execution-1', 3))
    state = reduceOpenAgentState(state, {
      type: 'set-agent-thread-archived', threadId: 'thread-1', archived: false
    })
    expect(readAgentThread(state, 'thread-1').archived).toBe(false)
    const repeated = commit(state, failed('execution-1', 3))
    expect(readAgentThread(repeated, 'thread-1').archived).toBe(false)
    const restarted = commit(repeated, failed('execution-1', 3), 11)
    expect(readAgentThread(restarted, 'thread-1').archived).toBe(false)
  })

  it('archives again when a later Execution fails', () => {
    let state = commit(commit(seeded(), started('execution-1', 3)), failed('execution-1', 3))
    state = reduceOpenAgentState(state, {
      type: 'set-agent-thread-archived', threadId: 'thread-1', archived: false
    })
    state = commit(state, started('execution-2', 5))
    expect(readAgentThread(state, 'thread-1').archived).toBe(false)
    state = commit(state, failed('execution-2', 5))
    expect(readAgentThread(state, 'thread-1').archived).toBe(true)
  })

  it('leaves an interrupted or waiting Execution in Default', () => {
    let state = commit(commit(seeded(), started('execution-1', 3)), {
      latestExecution: {
        executionId: 'execution-1', status: 'interrupted' as const, startedAt: 3, finishedAt: 4
      },
      backgroundWork: null
    })
    expect(readAgentThread(state, 'thread-1').archived).toBe(false)
    state = commit(commit(state, started('execution-2', 5)), {
      latestExecution: {
        executionId: 'execution-2', status: 'waiting-for-user' as const, startedAt: 5,
        interactions: [{
          id: 'interaction-1', kind: 'question' as const, title: 'Approve?',
          actions: [{ id: 'action-1', intent: 'submit' as const, label: 'Submit' }],
          questions: []
        }]
      },
      backgroundWork: null
    })
    expect(readAgentThread(state, 'thread-1').archived).toBe(false)
  })

  it('ignores a late failure for a superseded Execution', () => {
    let state = commit(commit(seeded(), started('execution-1', 3)), started('execution-2', 5))
    state = commit(state, failed('execution-1', 3))
    expect(readAgentThread(state, 'thread-1').archived).toBe(false)
    expect(readAgentThread(state, 'thread-1').observation.latestExecution)
      .toMatchObject({ executionId: 'execution-1', status: 'failed' })
  })

  it('never auto-archives Bart, which is not an Agent Thread', () => {
    const base = initialState()
    const state = reduceOpenAgentState(base, {
      type: 'replace-thread-session-state', threadId: 'bart-thread-1',
      expectedRevision: readBartThread(base).revision,
      sessionState: { turn: 'failed' }, observation: failed('execution-bart', 3), updatedAt: 10
    })
    expect(readBartThread(state).observation.latestExecution)
      .toMatchObject({ executionId: 'execution-bart', status: 'failed' })
    expect(readBartThread(state)).not.toHaveProperty('archived')
  })
})
