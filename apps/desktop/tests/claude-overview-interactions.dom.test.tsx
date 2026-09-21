// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { expectOverviewPolicyToggle } from './overview-display-policy-support'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeOverviewCard,
  projectClaudeOverview
} from '../../../packages/harness-claude/src/renderer'
import { toPublicClaudeInteraction, claudePublicInteractionId, claudePublicQuestionId as questionId, claudePublicOptionId as optionId } from '../../../packages/harness-claude/src/shared/public-interactions'
import type { ClaudeInteraction, ClaudeThreadState } from '../../../packages/harness-claude/src/shared/state'
import { isJsonObject, type AgentThreadRecord, type JsonObject } from '@openagent/contracts'
import type { HarnessRendererThreadActions } from '@openagent/contracts/renderer'

afterEach(cleanup)

describe('Claude overview interactions', () => {
  it.each(['question', 'permission'])('toggles the %s extension through the Core overview policy', async (kind) => {
    await expectOverviewPolicyToggle(kind === 'permission' ? waitingClaudeThread() : waitingClaudeThread({
      id: 'policy-question', kind: 'question', title: 'Choose', status: 'pending',
      questions: [{ header: 'Target', question: 'Where?', multiSelect: false, options: [{ label: 'Here' }] }]
    }))
  })
  it('refreshes token totals without cached percentages from running usage snapshots', () => {
    const thread = {
      ...waitingClaudeThread(),
      observation: {
        latestExecution: { executionId: 'execution-overview', startedAt: 1, status: 'running' as const },
        backgroundWork: null
      }
    }
    thread.sessionState.turns[0]!.interactions = []
    const card = () => <ClaudeOverviewCard
      thread={thread}
      projection={projectClaudeOverview({ thread, layout: { availableColumns: 2 } }).view}
      actions={{ ...overviewActions(), openThread: vi.fn() }}
    />
    const view = render(card())
    for (const [input, output, cached, cacheWrite, total] of [
      [10, 1, 3, 2, 16],
      [10, 2, 3, 2, 17],
      [10, 4, 3, 2, 19],
      [30, 5, 6, 4, 45],
      [30, 6, 6, 4, 46]
    ] as const) {
      thread.sessionState.turns[0]!.usage = {
        inputTokens: input, outputTokens: output, cachedTokens: cached, cacheWriteTokens: cacheWrite
      }
      view.rerender(card())
      const numbers = view.container.querySelectorAll('.thread-card-identity-usage .thread-card-rolling-number')
      expect([...numbers].map(number => number.getAttribute('aria-label'))).toEqual([String(total)])
      expect(view.container.querySelector('.thread-card-identity-usage')).not.toHaveTextContent('cached')
    }
  })

  it('abbreviates token totals with K, M and B suffixes', () => {
    const thread = {
      ...waitingClaudeThread(),
      observation: {
        latestExecution: { executionId: 'execution-overview', startedAt: 1, status: 'running' as const },
        backgroundWork: null
      }
    }
    thread.sessionState.turns[0]!.interactions = []
    const card = () => <ClaudeOverviewCard
      thread={thread}
      projection={projectClaudeOverview({ thread, layout: { availableColumns: 2 } }).view}
      actions={{ ...overviewActions(), openThread: vi.fn() }}
    />
    const view = render(card())
    for (const [total, label] of [
      [999, '999'],
      [18_527, '18.5K'],
      [1_445_200, '1.4M'],
      [2_500_000_000, '2.5B']
    ] as const) {
      thread.sessionState.turns[0]!.usage = {
        inputTokens: total, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0
      }
      view.rerender(card())
      const numbers = view.container.querySelectorAll('.thread-card-identity-usage .thread-card-rolling-number')
      expect(numbers[0]!.getAttribute('aria-label')).toBe(label)
    }
  })

  it('keeps task context while waiting and replaces reasoning when the answer arrives', () => {
    const thread = waitingClaudeThread()
    const turn = thread.sessionState.turns[0]!
    turn.statusLabel = 'Waiting for your response'
    const excerpt = () => projectClaudeOverview({ thread, layout: { availableColumns: 2 } }).excerpt
    expect(excerpt()).toBe('Run command')
    turn.reasoning = 'Checking the workspace'
    expect(excerpt()).toBe('Checking the workspace')
    turn.text = 'Verified current workspace'
    expect(excerpt()).toBe('Verified current workspace')
  })

  it('keeps native Workflow phases and agents in the baseline composed card', () => {
    const thread = waitingClaudeThread()
    const state = thread.sessionState
    state.turns[0]!.interactions = []
    state.turns[0]!.activities = [{
      id: 'workflow', kind: 'agent', label: 'Workflow', status: 'running',
      detail: JSON.stringify({ phases: ['Inspect', 'Verify'], total: 2 })
    }, { id: 'worker', kind: 'subagent', label: 'Native worker', status: 'running' }]
    const runningThread: AgentThreadRecord<'claude'> = {
      ...thread,
      observation: {
        latestExecution: { executionId: 'execution-overview', startedAt: 1, status: 'running' },
        backgroundWork: null
      }
    }
    const projection = projectClaudeOverview({ thread: runningThread, layout: { availableColumns: 2 } })
    expect(projection.footprint).toEqual({ columns: 2, rows: 2 })
    const view = render(<ClaudeOverviewCard
      thread={runningThread} projection={projection.view}
      actions={{ ...overviewActions(), openThread: vi.fn() }}
    />)
    expect(screen.getByText('Inspect')).toBeInTheDocument()
    expect(screen.getByText('Verify')).toBeInTheDocument()
    expect(screen.getByText('Native worker')).toBeInTheDocument()
    expect(view.container.querySelector('.thread-card-workflow-phase-cell')).toBeInTheDocument()
    expect(view.container.querySelector('.thread-card-workflow-agent-cell')).toBeInTheDocument()
  })

  it('uses the latest timeline text instead of the accumulated opening commentary', () => {
    const thread = waitingClaudeThread()
    const turn = thread.sessionState.turns[0]!
    turn.text = 'Old commentary'
    turn.reasoning = 'Old reasoning'
    const excerpt = () => projectClaudeOverview({ thread, layout: { availableColumns: 2 } }).excerpt
    turn.timeline.push({ id: 'new-reasoning', kind: 'reasoning', content: 'Latest reasoning', createdAt: 1 })
    expect(excerpt()).toBe('Latest reasoning')
    turn.timeline.push({ id: 'new-answer', kind: 'assistant', status: 'streaming',
      content: 'Old prefix '.repeat(100) + '最新😀', createdAt: 1 })
    expect(excerpt()).toMatch(/最新😀$/u)
    expect(excerpt()).not.toContain('Old commentary')
    turn.timeline.push({ id: 'final-answer', kind: 'assistant', status: 'complete',
      content: 'Final answer', createdAt: 1 })
    turn.status = 'completed'
    turn.finishedAt = turn.updatedAt
    expect(excerpt()).toBe('Final answer')
  })

  it.each(['{Enter}', ' '])(
    'lets a nested permission button handle %s without opening the Thread',
    async (key) => {
      const user = userEvent.setup()
      const openThread = vi.fn()
      const respond = vi.fn().mockResolvedValue(undefined)
      const thread = waitingClaudeThread()
      const projection = projectClaudeOverview({
        thread,
        layout: { availableColumns: 2 }
      })
      expect(projection.footprint).toEqual({ columns: 2, rows: 1 })
      render(
        <ClaudeOverviewCard
          thread={thread}
          projection={projection.view}
          actions={{
            ...overviewActions({ respond }),
            openThread
          }}
        />
      )

      expect(screen.getByText('pwd')).toBeInTheDocument()
      const deny = screen.getByRole('button', { name: '拒绝' })
      deny.focus()
      await user.keyboard(key)

      await waitFor(() => expect(respond).toHaveBeenCalledWith({
        interactionId: claudePublicInteractionId('execution-overview', 'permission-overview'),
        actionId: 'deny'
      }))
      expect(JSON.stringify(respond.mock.calls)).not.toContain('permission-overview')
      expect(openThread).not.toHaveBeenCalled()
    }
  )

  it('answers a native Claude question inline without changing option values or opening the Thread', async () => {
    const user = userEvent.setup()
    const openThread = vi.fn()
    const respond = vi.fn().mockResolvedValue(undefined)
    const thread = waitingClaudeThread({
      id: 'question-overview',
      kind: 'question',
      title: 'Choose the native target',
      status: 'pending',
      questions: [{
        header: 'Target',
        question: 'Where should Claude continue?',
        multiSelect: false,
        options: [{
          label: 'native-workspace-value',
          description: 'Native option description'
        }]
      }, {
        header: 'Checks',
        question: 'Which checks should Claude run?',
        multiSelect: true,
        options: [{
          label: 'native-test-value'
        }, {
          label: 'native-lint-value'
        }]
      }]
    })
    const projection = projectClaudeOverview({
      thread,
      layout: { availableColumns: 2 }
    })
    render(
      <ClaudeOverviewCard
        thread={thread}
        projection={projection.view}
        actions={{ ...overviewActions({ respond }), openThread }}
      />
    )

    await user.click(screen.getByRole('button', { name: /native-workspace-value/ }))
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await user.click(screen.getByRole('button', { name: /native-test-value/ }))
    await user.click(screen.getByRole('button', { name: /native-lint-value/ }))
    await user.click(screen.getByRole('button', { name: '提交回答' }))

    await waitFor(() => expect(respond).toHaveBeenCalledWith({
      interactionId: claudePublicInteractionId('execution-overview', 'question-overview'),
      actionId: 'submit',
      answers: {
        [claudePublicQuestionId(0)]: claudePublicOptionId(0, 0),
        [claudePublicQuestionId(1)]: [
          claudePublicOptionId(1, 0),
          claudePublicOptionId(1, 1)
        ]
      }
    }))
    expect(JSON.stringify(respond.mock.calls)).not.toContain('question-overview')
    expect(openThread).not.toHaveBeenCalled()
  })
})

function overviewActions(
  overrides: Partial<HarnessRendererThreadActions> = {}
): HarnessRendererThreadActions {
  return {
    interrupt: async () => undefined,
    invokeHarnessExtension: async () => null,
    forkThread: async () => ({ threadId: 'unused-fork' }),
    openExternal: async () => undefined,
    openFollowUp: () => undefined,
    respond: async () => undefined,
    ...overrides
  }
}

function waitingClaudeThread(
  interaction: ClaudeInteraction = {
    id: 'permission-overview',
    kind: 'permission',
    title: 'Allow Bash?',
    description: 'Inspect current directory',
    input: { command: 'pwd' },
    status: 'pending'
  }
): AgentThreadRecord<'claude'> & { sessionState: ClaudeThreadState & JsonObject } {
  return {
    id: 'claude-overview-thread',
    harnessId: 'claude',
    revision: 1, archived: false,
    title: 'Claude approval',
    tags: [],
    cwd: '/tmp',
    sessionState: checkedClaudeState({
      version: 1,
      turns: [{
        executionId: 'execution-overview',
        createdAt: 1,
        updatedAt: 2,
        prompts: ['Run command'],
        promptAttachments: [[]],
        text: '',
        reasoning: '',
        status: 'running',
        plan: [],
        activities: [],
        interactions: [interaction],
        notices: [],
        timeline: []
      }],
      nativeNotifications: []
    }),
    observation: {
      latestExecution: {
        executionId: 'execution-overview',
        startedAt: 1,
        status: 'waiting-for-user',
        interactions: [toPublicClaudeInteraction('execution-overview', interaction)]
      },
      backgroundWork: null
    },
    settings: {},
    createdAt: 1,
    updatedAt: 2
  }
}

function claudePublicQuestionId(index: number): string {
  return questionId('execution-overview', 'question-overview', index)
}

function checkedClaudeState(value: ClaudeThreadState): ClaudeThreadState & JsonObject {
  if (!isJsonObject(value)) throw new Error('Claude overview fixture is not JSON')
  return value
}

function claudePublicOptionId(questionIndex: number, optionIndex: number): string {
  return optionId('execution-overview', 'question-overview', questionIndex, optionIndex)
}
