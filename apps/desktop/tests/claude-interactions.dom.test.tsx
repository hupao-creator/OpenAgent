// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeThreadView,
  claudeRendererPlugin
} from '../../../packages/harness-claude/src/renderer'
import { toPublicClaudeInteraction, claudePublicInteractionId, claudePublicQuestionId, claudePublicOptionId } from '../../../packages/harness-claude/src/shared/public-interactions'
import { appendTimelineText, recordClaudeActivity, settleClaudeTurn } from '../../../packages/harness-claude/src/main/thread/timeline'
import { forkClaudeThread } from '../../../packages/harness-claude/src/main/fork'
import { harnessRendererTranslations } from '../src/renderer/src/harness-composition'
import { I18nProvider } from '@openagent/plugin-kit/renderer'
import {
  parseClaudeThreadState,
  type ClaudeInputAttachment,
  type ClaudeInteraction,
  type ClaudeThreadState
} from '../../../packages/harness-claude/src/shared/state'
/*
 * This is a Plugin-local integration test: the pure fork derivation and the
 * Renderer must agree on the same current-v1 private state shape.
 */
import { isJsonObject, type AgentThreadRecord, type JsonObject } from '@openagent/contracts'
import type { ClaudeThreadSettings } from '../../../packages/harness-claude/src/shared/settings'
import type { HarnessRendererThreadActions } from '@openagent/contracts/renderer'

afterEach(cleanup)

/** Merged work rows live inside a folded disclosure until the reader opens it. */
function showExecutionProcesses(): void {
  for (const summary of document.querySelectorAll<HTMLElement>(
    '.thread-execution-process .activity-group-summary[aria-expanded="false"]'
  )) fireEvent.click(summary)
}

describe('Claude Plugin-owned interaction renderer', () => {
  it.each(['other-first', 'option-first'] as const)(
    'submits only the latest single-choice answer when switching %s',
    async (order) => {
      const user = userEvent.setup()
      const respond = vi.fn().mockResolvedValue(undefined)
      render(
        <ClaudeThreadView
          thread={claudeThread([{
            id: 'single-choice-request',
            kind: 'question',
            title: 'Choose a destination',
            status: 'pending',
            questions: [{
              question: 'Where should this run?',
              multiSelect: false,
              options: [{ label: 'Local' }]
            }]
          }])}
          actions={stubThreadActions({ respond })}
        />
      )
      const option = screen.getByRole('radio', { name: 'Local' })
      expect(screen.queryByRole('textbox', { name: 'Where should this run?' })).not.toBeInTheDocument()
      if (order === 'other-first') {
        await user.click(screen.getByRole('button', { name: '其它…' }))
        const other = screen.getByRole('textbox', { name: 'Where should this run?' })
        expect(other).toHaveFocus()
        await user.type(other, 'Remote')
        await user.click(option)
        expect(option).toBeChecked()
        expect(screen.queryByRole('textbox', { name: 'Where should this run?' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: '其它…' })).toBeInTheDocument()
      } else {
        await user.click(option)
        await user.click(screen.getByRole('button', { name: '其它…' }))
        const other = screen.getByRole('textbox', { name: 'Where should this run?' })
        expect(other).toHaveFocus()
        expect(option).not.toBeChecked()
        await user.type(other, 'Remote')
        expect(other).toHaveValue('Remote')
      }
      await user.click(screen.getByRole('button', { name: '提交回答' }))
      await waitFor(() => expect(respond).toHaveBeenCalledExactlyOnceWith({
        interactionId: publicInteractionId('single-choice-request'),
        actionId: 'submit',
        answers: {
          [publicQuestionId('single-choice-request', 0)]: order === 'other-first'
            ? publicOptionId('single-choice-request', 0, 0)
            : 'Remote'
        }
      }))
    }
  )

  it.each(['other-first', 'option-first'] as const)(
    'keeps both selected and custom multi-choice answers when switching %s',
    async (order) => {
      const user = userEvent.setup()
      const respond = vi.fn().mockResolvedValue(undefined)
      render(
        <ClaudeThreadView
          thread={claudeThread([{
            id: 'multi-choice-request',
            kind: 'question',
            title: 'Choose destinations',
            status: 'pending',
            questions: [{
              question: 'Where should this run?',
              multiSelect: true,
              options: [{ label: 'Local' }]
            }]
          }])}
          actions={stubThreadActions({ respond })}
        />
      )
      const option = screen.getByRole('checkbox', { name: 'Local' })
      expect(screen.queryByRole('textbox', { name: 'Where should this run?' })).not.toBeInTheDocument()
      if (order === 'option-first') await user.click(option)
      await user.click(screen.getByRole('button', { name: '其它…' }))
      const other = screen.getByRole('textbox', { name: 'Where should this run?' })
      expect(other).toHaveFocus()
      await user.type(other, 'Remote')
      if (order === 'other-first') await user.click(option)
      expect(option).toBeChecked()
      expect(other).toHaveValue('Remote')
      await user.click(screen.getByRole('button', { name: '提交回答' }))
      await waitFor(() => expect(respond).toHaveBeenCalledExactlyOnceWith({
        interactionId: publicInteractionId('multi-choice-request'),
        actionId: 'submit',
        answers: { [publicQuestionId('multi-choice-request', 0)]: [publicOptionId('multi-choice-request', 0, 0), 'Remote'] }
      }))
    }
  )

  it('merges the segments of one native assistant message into a single final answer', () => {
    const thread = claudeThread([])
    const turn = thread.sessionState.turns[0]!
    turn.timeline = []
    turn.updatedAt = 8
    appendTimelineText(turn, 'assistant', 'Same', 2, 'native-answer-1')
    appendTimelineText(turn, 'reasoning', 'Thinking', 3)
    appendTimelineText(turn, 'assistant', ' answer', 4, 'native-answer-1')
    recordClaudeActivity(turn, { id: 'read', kind: 'tool', label: 'Read', status: 'running' }, 5)
    appendTimelineText(turn, 'assistant', '.', 6, 'native-answer-1')
    // A running turn advertises no final answer, not even a partial one.
    expect(claudeRendererPlugin.projectBartDock!({ thread }).reply).toBeNull()
    settleClaudeTurn(turn, 'completed', new Set(), 7)
    thread.sessionState = checkedClaudeState(parseClaudeThreadState(JSON.parse(JSON.stringify(thread.sessionState))))

    const reply = claudeRendererPlugin.projectBartDock!({ thread }).reply
    expect(reply).toEqual({
      id: JSON.stringify(['execution-interactions', 'native-answer-1']),
      executionId: 'execution-interactions',
      excerpt: 'Same answer.',
      target: { executionId: 'execution-interactions', messageId: 'native-answer-1' }
    })
    expect(claudeRendererPlugin.projectBartDock!({ thread }).reply).toEqual(reply)
  })

  it('keeps equal-text final answers apart by their native message identity', () => {
    const build = (messageId: string) => {
      const thread = claudeThread([])
      const turn = thread.sessionState.turns[0]!
      turn.timeline = []
      appendTimelineText(turn, 'assistant', 'Same answer', 2, messageId)
      settleClaudeTurn(turn, 'completed')
      thread.sessionState = checkedClaudeState(parseClaudeThreadState(JSON.parse(JSON.stringify(thread.sessionState))))
      return claudeRendererPlugin.projectBartDock!({ thread }).reply
    }
    const first = build('native-answer-1')
    const second = build('native-answer-2')
    expect(first?.excerpt).toBe('Same answer')
    expect(second?.excerpt).toBe('Same answer')
    expect(first?.id).not.toBe(second?.id)
  })

  it('accepts only the current null handshake before first Plugin state publication', () => {
    const thread: AgentThreadRecord<'claude', ClaudeThreadSettings> = {
      ...claudeThread([]),
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null }
    }
    const view = render(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <ClaudeThreadView
          thread={thread}
          actions={stubThreadActions()}
        />
      </I18nProvider>
    )

    expect(screen.getByRole('img', { name: 'A cat behind a computer, waiting for a new idea.' })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    view.rerender(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <ClaudeThreadView
          thread={{ ...thread, observation: { latestExecution: { executionId: 'starting', status: 'running', startedAt: 1 }, backgroundWork: null } }}
          actions={stubThreadActions()}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('status')).toHaveTextContent('Running')
    expect(() => claudeRendererPlugin.OverviewCard.project({
      thread,
      layout: { availableColumns: 2 }
    })).not.toThrow()
    // A null handshake carries no session state to read, so it advertises no
    // activity and no reply rather than inventing one.
    expect(claudeRendererPlugin.projectBartDock!({ thread })).toEqual({ activity: null, reply: null })

    view.rerender(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <ClaudeThreadView
          thread={{ ...thread, sessionState: undefined as never }}
          actions={stubThreadActions()}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Claude thread state is unavailable')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Claude sessionState 无效')
  })

  it('consumes the Claude interaction catalog in en-US', () => {
    render(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <ClaudeThreadView
          thread={claudeThread([{
            id: 'url-request-en',
            kind: 'elicitation',
            title: 'Connect Example MCP',
            elicitationMode: 'url',
            url: 'https://mcp.example.test/english',
            status: 'pending'
          }])}
          actions={stubThreadActions()}
        />
      </I18nProvider>
    )

    expect(screen.getByText('Complete this request on the external page provided by Claude.'))
      .toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Agree and open' })).toBeInTheDocument()
  })

  it('exposes submit, deny, and cancel for a form elicitation', async () => {
    const user = userEvent.setup()
    const respond = vi.fn().mockResolvedValue(undefined)
    render(
      <ClaudeThreadView
        thread={claudeThread([{
          id: 'form-request',
          kind: 'elicitation',
          title: 'Release form',
          elicitationMode: 'form',
          schema: { type: 'object' },
          status: 'pending'
        }])}
        actions={{ ...stubThreadActions(), respond }}
      />
    )

    expect(screen.getByRole('button', { name: '提交' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '拒绝' }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith({
      interactionId: publicInteractionId('form-request'),
      actionId: 'deny'
    }))
  })

  it('keeps translated plans manually accessible across execution boundaries', () => {
    const source = claudeThread([])
    const state: ClaudeThreadState = source.sessionState
    const historical = {
      ...state.turns[0]!,
      finishedAt: state.turns[0]!.updatedAt,
      status: 'completed' as const,
      plan: [{ step: 'Ship it', status: 'completed' as const }]
    }
    const current = {
      ...state.turns[0]!,
      executionId: 'next-execution',
      status: 'running' as const,
      createdAt: 3,
      updatedAt: 3,
      plan: [{ step: 'Continue working', status: 'inProgress' as const }]
    }
    const completedThread: AgentThreadRecord<'claude', ClaudeThreadSettings> = {
      ...source,
      sessionState: checkedClaudeState({ ...state, turns: [historical] }),
      observation: { latestExecution: null, backgroundWork: null }
    }
    const renderThread = (thread: AgentThreadRecord<'claude', ClaudeThreadSettings>) => (
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <ClaudeThreadView thread={thread} actions={stubThreadActions()} />
      </I18nProvider>
    )
    const view = render(renderThread(completedThread))

    expect(screen.queryByText('Ship it')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))
    expect(screen.getByRole('region', { name: 'Plan' })).toBeInTheDocument()
    expect(screen.queryByLabelText('执行计划')).not.toBeInTheDocument()

    const runningThread: AgentThreadRecord<'claude', ClaudeThreadSettings> = {
      ...completedThread,
      sessionState: checkedClaudeState({ ...state, turns: [historical, current] }),
      observation: {
        latestExecution: { executionId: current.executionId, status: 'running', startedAt: 3 },
        backgroundWork: null
      }
    }
    view.rerender(renderThread(runningThread))
    expect(screen.queryByText('Ship it')).not.toBeInTheDocument()
    expect(screen.getByText('Continue working')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide work' }))
    expect(screen.queryByRole('region', { name: 'Plan' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))
    expect(screen.queryByText('Ship it')).not.toBeInTheDocument()
    expect(screen.getByText('Continue working')).toBeInTheDocument()
    expect(screen.getAllByRole('region', { name: 'Plan' })).toHaveLength(1)

    view.rerender(renderThread({
      ...runningThread,
      sessionState: checkedClaudeState({ ...state, turns: [historical, { ...current, updatedAt: 4 }] })
    }))
    expect(screen.queryByText('Ship it')).not.toBeInTheDocument()
    expect(screen.getByText('Continue working')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '1 previous turn' }))
    const entry = view.container.querySelector('.thread-detail-subpage-link')!
    fireEvent.click(entry)
    const child = view.container.querySelector('.thread-detail-subpage') as HTMLElement
    expect(within(child).queryByText('Ship it')).not.toBeInTheDocument()
    expect(within(child).queryByRole('region', { name: 'Plan' })).not.toBeInTheDocument()
    fireEvent.click(within(child).getByRole('button', { name: 'Show work' }))
    expect(within(child).getByText('Ship it')).toBeVisible()
    expect(within(child).getByRole('region', { name: 'Plan' })).toBeVisible()
    fireEvent.keyDown(child, { key: 'Escape' })
    expect(entry).toHaveFocus()

    const finishedThread: AgentThreadRecord<'claude', ClaudeThreadSettings> = {
      ...runningThread,
      sessionState: checkedClaudeState({ ...state, turns: [historical, { ...current, finishedAt: 5,
      status: 'completed', updatedAt: 5 }] }),
      observation: {
        latestExecution: { executionId: current.executionId, status: 'completed', startedAt: 3, finishedAt: 5 },
        backgroundWork: null
      }
    }
    view.rerender(renderThread(finishedThread))
    expect(screen.queryByRole('region', { name: 'Plan' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))
    expect(screen.getAllByRole('region', { name: 'Plan' })).toHaveLength(1)
    view.rerender(renderThread({ ...finishedThread, id: 'another-thread' }))
    expect(screen.queryByRole('region', { name: 'Plan' })).not.toBeInTheDocument()
  })

  it('keeps each prompt attachment visible in Claude-owned history', () => {
    render(
      <ClaudeThreadView
        thread={claudeThread([], [[{
          id: 'claude-image-1',
          name: 'diagram.png',
          mimeType: 'image/png',
          size: 42,
          kind: 'image'
        }, {
          id: 'claude-file-1',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 256,
          kind: 'file'
        }]])}
        actions={stubThreadActions()}
      />
    )

    expect(screen.queryByText('diagram.png')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '显示用户消息' }))
    expect(screen.getByText('diagram.png')).toHaveAttribute('title', 'image/png · 42 B')
    expect(screen.getByText('notes.txt')).toHaveAttribute('title', 'text/plain · 256 B')
    expect(screen.queryByText(/\/private\/|\/tmp\//)).not.toBeInTheDocument()
  })

  it('keeps cancelled native activities distinct from failures', () => {
    const source = claudeThread([])
    const state: ClaudeThreadState = source.sessionState
    render(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <ClaudeThreadView
          thread={{
            ...source,
            sessionState: checkedClaudeState({
              ...state,
              turns: state.turns.map((turn) => ({
                ...turn,
                finishedAt: turn.updatedAt,
                status: 'interrupted' as const,
                activities: [{
                  id: 'cancelled-native-tool',
                  kind: 'tool' as const,
                  label: 'Cancelled native tool',
                  status: 'cancelled' as const
                }],
                interactions: [{
                  id: 'cancelled-native-request',
                  kind: 'permission' as const,
                  title: 'Cancelled native request',
                  status: 'cancelled' as const
                }]
              }))
            }),
            observation: { latestExecution: null, backgroundWork: null }
          }}
          actions={stubThreadActions()}
        />
      </I18nProvider>
    )

    expect(screen.queryByText('Cancelled native tool')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))
    showExecutionProcesses()
    const activity = screen.getByText('Cancelled native tool').closest('button')
    expect(activity).not.toBeNull()
    expect(within(activity!).getByText('Cancelled')).toBeInTheDocument()
    expect(within(activity!).queryByText('Failed')).not.toBeInTheDocument()
    expect(screen.getByText('Interrupted')).toBeInTheDocument()
    const resolved = screen.getByText('Cancelled native request').closest('div')
    expect(resolved).not.toBeNull()
    expect(within(resolved!).getByText('Cancelled')).toBeInTheDocument()
    expect(within(resolved!).queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders current native snapshots once in occurrence order with latest state', async () => {
    const source = claudeThread([])
    const state: ClaudeThreadState = source.sessionState
    const template = state.turns[0]!
    render(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <ClaudeThreadView
          thread={{
            ...source,
            sessionState: checkedClaudeState({
              ...state,
              turns: [{
                ...template,
                updatedAt: 12,
                prompts: ['Ordered current prompt'],
                promptAttachments: [[]],
                text: 'Ordered current answer',
                finishedAt: 12,
                status: 'completed',
                plan: [{ step: 'Latest current plan', status: 'completed' }],
                activities: [{
                  id: 'current-native-activity-id',
                  kind: 'tool',
                  label: 'Current native activity',
                  status: 'completed',
                  detail: 'Current final activity detail'
                }],
                interactions: [{
                  id: 'current-native-interaction-id',
                  kind: 'dialog',
                  title: 'Current native dialog',
                  status: 'submitted'
                }],
                usage: { totalTokens: 25 },
                timeline: [{
                  id: 'current-user',
                  kind: 'user-message',
                  createdAt: 1,
                  promptIndex: 0
                }, {
                  id: 'current-activity-running',
                  kind: 'activity',
                  createdAt: 2,
                  activity: {
                    id: 'current-native-activity-id',
                    kind: 'tool',
                    label: 'Current native activity',
                    status: 'running',
                    detail: 'Current stale activity detail'
                  }
                }, {
                  id: 'current-interaction-pending',
                  kind: 'interaction',
                  createdAt: 3,
                  interaction: {
                    id: 'current-native-interaction-id',
                    kind: 'dialog',
                    title: 'Current native dialog',
                    status: 'pending'
                  }
                }, {
                  id: 'current-plan-stale',
                  kind: 'plan',
                  createdAt: 4,
                  plan: [{ step: 'Stale current plan', status: 'inProgress' }]
                }, {
                  id: 'current-assistant',
                  kind: 'assistant',
                  createdAt: 5,
                  content: 'Ordered current answer',
                  status: 'complete'
                }, {
                  id: 'current-activity-completed',
                  kind: 'activity',
                  createdAt: 6,
                  activity: {
                    id: 'current-native-activity-id',
                    kind: 'tool',
                    label: 'Current native activity',
                    status: 'completed',
                    detail: 'Current final activity detail'
                  }
                }, {
                  id: 'current-interaction-submitted',
                  kind: 'interaction',
                  createdAt: 7,
                  interaction: {
                    id: 'current-native-interaction-id',
                    kind: 'dialog',
                    title: 'Current native dialog',
                    status: 'submitted'
                  }
                }, {
                  id: 'current-plan-latest',
                  kind: 'plan',
                  createdAt: 8,
                  plan: [{ step: 'Latest current plan', status: 'completed' }]
                }, {
                  id: 'current-usage-stale',
                  kind: 'usage',
                  createdAt: 9,
                  usage: { totalTokens: 2 }
                }, {
                  id: 'current-usage-latest',
                  kind: 'usage',
                  createdAt: 10,
                  usage: { totalTokens: 25 }
                }]
              }]
            }),
            observation: { latestExecution: null, backgroundWork: null }
          }}
          actions={stubThreadActions()}
        />
      </I18nProvider>
    )

    expect(screen.queryByText('Current native activity')).not.toBeInTheDocument()
    expect(screen.queryByText('Ordered current prompt')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show user messages' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))
    showExecutionProcesses()
    fireEvent.click(screen.getByRole('button', { name: 'Current native activity Completed' }))
    expect(screen.getAllByText('Current native activity')).toHaveLength(1)
    expect(screen.getByText('Current final activity detail')).toBeInTheDocument()
    expect(screen.queryByText('Current stale activity detail')).not.toBeInTheDocument()
    expect(screen.getAllByText('Current native dialog')).toHaveLength(1)
    expect(screen.getByText('Submitted')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
    expect(screen.getByText('Latest current plan')).toBeInTheDocument()
    expect(screen.queryByText('Stale current plan')).not.toBeInTheDocument()
    expect(screen.getByText('25 Claude tokens')).toBeInTheDocument()

    const prompt = await screen.findByText('Ordered current prompt')
    const activity = screen.getByText('Current native activity')
    const interaction = screen.getByText('Current native dialog')
    const answer = await screen.findByText('Ordered current answer')
    const plan = screen.getByText('Latest current plan')
    expect(prompt.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    expect(activity.compareDocumentPosition(interaction) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    expect(interaction.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    expect(answer.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })

  it('renders the cropped fork transcript before new turns without reviving source execution identity', async () => {
    const source = claudeThread([])
    const state: ClaudeThreadState = source.sessionState
    const template = state.turns[0]!
    const sourceThread: AgentThreadRecord<'claude', ClaudeThreadSettings> = {
      ...source,
      sessionState: checkedClaudeState({
        ...state,
        primarySessionId: 'source-native-session',
        turns: [{
          ...template,
          executionId: 'source-core-execution-id',
          updatedAt: 20,
          prompts: ['Source prompt through checkpoint'],
          promptAttachments: [[{
            id: 'fork-attachment',
            name: 'source-notes.md',
            mimeType: 'text/markdown',
            size: 64,
            kind: 'file'
          }]],
          text: 'Source answer through checkpoint',
          reasoning: 'Source visible reasoning',
          finishedAt: 20,
          status: 'completed',
          error: 'Source visible recoverable error',
          plan: [{ step: 'Source latest plan', status: 'completed' }],
          planExplanation: 'Source plan explanation',
          activities: [{
            id: 'source-native-activity-id',
            kind: 'command',
            label: 'Source native command',
            status: 'completed',
            detail: 'Source final command output'
          }],
          interactions: [{
            id: 'source-native-interaction-id',
            kind: 'question',
            title: 'Source native question',
            description: 'Source question description',
            status: 'cancelled',
            questions: [{
              question: 'Which source option?',
              header: 'Source choice',
              multiSelect: false,
              options: [{ label: 'Source option' }]
            }]
          }],
          notices: [{
            id: 'source-native-notice-id',
            level: 'warning',
            message: 'Source visible notice'
          }],
          usage: { inputTokens: 10, outputTokens: 2 },
          diff: 'source-latest.diff',
          review: 'Source latest review',
          compacted: true,
          timeline: [{
            id: 'source-timeline-user',
            kind: 'user-message',
            createdAt: 1,
            promptIndex: 0,
            checkpointId: 'source-checkpoint'
          }, {
            id: 'source-timeline-reasoning',
            kind: 'reasoning',
            content: 'Source visible reasoning',
            createdAt: 2
          }, {
            id: 'source-timeline-activity-start',
            kind: 'activity',
            createdAt: 3,
            activity: {
              id: 'source-native-activity-id',
              kind: 'command',
              label: 'Source native command',
              status: 'running',
              detail: 'Source stale command output'
            }
          }, {
            id: 'source-timeline-interaction-pending',
            kind: 'interaction',
            createdAt: 4,
            interaction: {
              id: 'source-native-interaction-id',
              kind: 'question',
              title: 'Source native question',
              description: 'Source question description',
              status: 'pending',
              questions: [{
                question: 'Which source option?',
                header: 'Source choice',
                multiSelect: false,
                options: [{ label: 'Source option' }]
              }]
            }
          }, {
            id: 'source-timeline-plan-stale',
            kind: 'plan',
            createdAt: 5,
            plan: [{ step: 'Source stale plan', status: 'inProgress' }]
          }, {
            id: 'source-timeline-activity-complete',
            kind: 'activity',
            createdAt: 6,
            activity: {
              id: 'source-native-activity-id',
              kind: 'command',
              label: 'Source native command',
              status: 'completed',
              detail: 'Source final command output'
            }
          }, {
            id: 'source-timeline-interaction-cancelled',
            kind: 'interaction',
            createdAt: 7,
            interaction: {
              id: 'source-native-interaction-id',
              kind: 'question',
              title: 'Source native question',
              description: 'Source question description',
              status: 'cancelled',
              questions: [{
                question: 'Which source option?',
                header: 'Source choice',
                multiSelect: false,
                options: [{ label: 'Source option' }]
              }]
            }
          }, {
            id: 'source-timeline-plan-latest',
            kind: 'plan',
            createdAt: 8,
            plan: [{ step: 'Source latest plan', status: 'completed' }],
            explanation: 'Source plan explanation'
          }, {
            id: 'source-timeline-notice',
            kind: 'notice',
            createdAt: 9,
            notice: {
              id: 'source-native-notice-id',
              level: 'warning',
              message: 'Source visible notice'
            }
          }, {
            id: 'source-timeline-usage-stale',
            kind: 'usage',
            createdAt: 10,
            usage: { inputTokens: 1 }
          }, {
            id: 'source-timeline-usage-latest',
            kind: 'usage',
            createdAt: 11,
            usage: { inputTokens: 10, outputTokens: 2 }
          }, {
            id: 'source-timeline-diff-stale',
            kind: 'diff',
            createdAt: 14,
            content: 'source-stale.diff'
          }, {
            id: 'source-timeline-diff-latest',
            kind: 'diff',
            createdAt: 15,
            content: 'source-latest.diff'
          }, {
            id: 'source-timeline-review',
            kind: 'review',
            createdAt: 16,
            content: 'Source latest review'
          }, {
            id: 'source-timeline-context',
            kind: 'context-compaction',
            createdAt: 17
          }, {
            id: 'source-timeline-error',
            kind: 'error',
            createdAt: 18,
            message: 'Source visible recoverable error'
          }, {
            id: 'source-timeline-assistant',
            kind: 'assistant',
            content: 'Source answer through checkpoint',
            createdAt: 19,
            status: 'complete'
          }]
        }, {
          ...template,
          executionId: 'source-core-execution-after-checkpoint',
          createdAt: 30,
          updatedAt: 31,
          prompts: ['Content after checkpoint'],
          promptAttachments: [[]],
          text: 'Answer after checkpoint',
          finishedAt: 31,
          status: 'completed',
          timeline: [{
            id: 'source-timeline-user-after',
            kind: 'user-message',
            createdAt: 30,
            promptIndex: 0,
            checkpointId: 'checkpoint-after'
          }, {
            id: 'source-timeline-assistant-after',
            kind: 'assistant',
            content: 'Answer after checkpoint',
            createdAt: 31,
            status: 'complete'
          }]
        }]
      }),
      observation: {
        latestExecution: {
          executionId: 'source-core-execution-after-checkpoint',
          startedAt: 3,
          finishedAt: 4,
          status: 'completed'
        },
        backgroundWork: null
      },
      updatedAt: 31
    }
    const forkResult = forkClaudeThread({
      source: sourceThread,
      request: { checkpointId: 'source-checkpoint' },
      signal: new AbortController().signal
    })
    const forkState = parseClaudeThreadState(forkResult.sessionState)
    const { pendingFork, ...startedForkState } = forkState
    expect(pendingFork).toEqual({
      sourceSessionId: 'source-native-session',
      checkpointId: 'source-checkpoint'
    })
    const forkedThread: AgentThreadRecord<'claude', ClaudeThreadSettings> = {
      ...source,
      id: 'forked-thread',
      title: forkResult.title || 'Forked thread',
      sessionState: forkResult.sessionState,
      observation: { latestExecution: null, backgroundWork: null }
    }
    const projected = claudeRendererPlugin.OverviewCard.project({
      thread: forkedThread,
      layout: { availableColumns: 2 }
    })
    expect(projected.view.summary).toBe('Source answer through checkpoint')
    expect(projected.view.summary).not.toContain('after checkpoint')
    render(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <ClaudeThreadView
          thread={{
            ...forkedThread,
            sessionState: checkedClaudeState({
              ...startedForkState,
              primarySessionId: 'new-native-session',
              turns: [{
                ...template,
                executionId: 'new-core-execution-id',
                prompts: ['New branch prompt'],
                promptAttachments: [[]],
                text: 'New branch answer',
                status: 'running',
                timeline: []
              }]
            }),
            observation: {
              latestExecution: { executionId: 'new-core-execution-id', status: 'running', startedAt: template.createdAt },
              backgroundWork: null
            }
          }}
          actions={stubThreadActions()}
        />
      </I18nProvider>
    )

    expect(screen.queryByRole('region', { name: 'Fork history from the source Claude session' })).toBeNull()
    expect(await screen.findByText('New branch answer')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Past conversation', expanded: false }))
    const history = screen.getByRole('region', {
      name: 'Fork history from the source Claude session'
    })
    expect(within(history).getByText('Read-only history · not part of the current execution'))
      .toBeInTheDocument()
    expect(within(history).queryByText('source-notes.md')).not.toBeInTheDocument()
    expect(within(history).queryByText('Source native command')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show user messages' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide work' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))
    fireEvent.click(within(history).getByRole('button', { name: 'Source native command Completed' }))
    expect(within(history).getByText('source-notes.md')).toBeInTheDocument()
    expect(within(history).queryByRole('button', { name: /Fork|Stop|background|Submit|Allow/ })).not.toBeInTheDocument()
    expect(await within(history).findByText('Source visible reasoning')).toBeInTheDocument()
    expect(within(history).getByText('Source native command')).toBeInTheDocument()
    expect(within(history).getByText('Source final command output')).toBeInTheDocument()
    expect(within(history).queryByText('Source stale command output')).not.toBeInTheDocument()
    expect(within(history).getByText('Source native question')).toBeInTheDocument()
    expect(within(history).getByText('Source question description')).toBeInTheDocument()
    expect(within(history).getByText('Which source option?')).toBeInTheDocument()
    expect(within(history).getByText('Cancelled')).toBeInTheDocument()
    expect(within(history).getByText('Source latest plan')).toBeInTheDocument()
    expect(within(history).queryByText('Source stale plan')).not.toBeInTheDocument()
    expect(within(history).getByText('Source visible notice')).toBeInTheDocument()
    expect(within(history).getByText('12 Claude tokens')).toBeInTheDocument()
    expect(within(history).queryByText('source-latest.diff')).not.toBeInTheDocument()
    expect(within(history).queryByText('source-stale.diff')).not.toBeInTheDocument()
    expect(await within(history).findByText('Source latest review')).toBeInTheDocument()
    expect(within(history).getByText('Claude compacted the conversation context'))
      .toBeInTheDocument()
    expect(within(history).getByText('Source visible recoverable error')).toBeInTheDocument()
    expect(within(history).queryByText('source-native-session')).not.toBeInTheDocument()
    const sourcePrompt = await screen.findByText('Source prompt through checkpoint')
    const newPrompt = await screen.findByText('New branch prompt')
    expect(sourcePrompt.compareDocumentPosition(newPrompt) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    expect(screen.queryByText('source-core-execution-id')).not.toBeInTheDocument()
    expect(screen.queryByText('Content after checkpoint')).not.toBeInTheDocument()
  })

  it('renders URL elicitation as an external flow and preserves native identity', async () => {
    const user = userEvent.setup()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const respond = vi.fn().mockResolvedValue(undefined)
    render(
      <ClaudeThreadView
        thread={claudeThread([{
          id: 'url-request',
          kind: 'elicitation',
          title: 'Connect Example MCP',
          description: 'Authorize in the provider page',
          elicitationMode: 'url',
          url: 'https://mcp.example.test/flow/123',
          elicitationId: 'native-flow-123',
          serverName: 'example-mcp',
          status: 'pending'
        }])}
        actions={stubThreadActions({ openExternal, respond })}
      />
    )

    expect(screen.getByText('此请求需要在 Claude 提供的外部页面中完成。'))
      .toBeInTheDocument()
    expect(screen.getByText('请求 ID：native-flow-123')).toBeInTheDocument()
    expect(screen.getByText('https://mcp.example.test/flow/123')).toBeInTheDocument()
    expect(screen.queryByText('JSON 表单内容')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '提交' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '同意并打开' }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith({
      interactionId: publicInteractionId('url-request'),
      actionId: 'submit'
    }))
    expect(openExternal).toHaveBeenCalledWith('https://mcp.example.test/flow/123')
    expect(openExternal.mock.invocationCallOrder[0]).toBeLessThan(
      respond.mock.invocationCallOrder[0]!
    )
    await user.click(screen.getByRole('button', { name: '拒绝' }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith({
      interactionId: publicInteractionId('url-request'),
      actionId: 'deny'
    }))
    expect(JSON.stringify(respond.mock.calls)).not.toContain('url-request')
  })

  it('only renders session-wide permission when native suggestions support it', () => {
    render(
      <ClaudeThreadView
        thread={claudeThread([permission('one-shot', 'One-shot permission', false),
          permission('rememberable', 'Rememberable permission', true)])}
        actions={stubThreadActions()}
      />
    )

    expect(screen.getAllByRole('button', { name: '本会话始终允许' })).toHaveLength(1)
    const oneShot = screen.getByText('One-shot permission').closest('section')
    const rememberable = screen.getByText('Rememberable permission').closest('section')
    expect(oneShot).not.toBeNull()
    expect(rememberable).not.toBeNull()
    expect(within(oneShot!).queryByRole('button', { name: '本会话始终允许' }))
      .not.toBeInTheDocument()
    expect(within(rememberable!).getByRole('button', { name: '本会话始终允许' }))
      .toBeInTheDocument()
  })

  it('keeps URL elicitation pending when opening the external page fails', async () => {
    const user = userEvent.setup()
    const openExternal = vi.fn().mockRejectedValue(new Error('Browser unavailable'))
    const respond = vi.fn().mockResolvedValue(undefined)
    render(
      <ClaudeThreadView
        thread={claudeThread([{
          id: 'url-open-failure',
          kind: 'elicitation',
          title: 'External flow',
          elicitationMode: 'url',
          url: 'https://mcp.example.test/failure',
          status: 'pending'
        }])}
        actions={stubThreadActions({ openExternal, respond })}
      />
    )

    await user.click(screen.getByRole('button', { name: '同意并打开' }))
    expect(await screen.findByText('Browser unavailable')).toBeInTheDocument()
    expect(respond).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '同意并打开' })).toBeEnabled()
  })

  it('routes a response from the second parallel panel using that interaction ID', async () => {
    const user = userEvent.setup()
    const respond = vi.fn().mockResolvedValue(undefined)
    render(
      <ClaudeThreadView
        thread={claudeThread([
          permission('parallel-first', 'First permission', false),
          permission('parallel-second', 'Second permission', false)
        ])}
        actions={stubThreadActions({ respond })}
      />
    )

    const second = screen.getByText('Second permission').closest('section')
    expect(second).not.toBeNull()
    await user.click(within(second!).getByRole('button', { name: '允许一次' }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith({
      interactionId: publicInteractionId('parallel-second'),
      actionId: 'allow'
    }))
    expect(JSON.stringify(respond.mock.calls)).not.toContain('parallel-second')
  })

  it('omits the removed runtime and background action controls', () => {
    render(<ClaudeThreadView thread={claudeThread([])} actions={stubThreadActions()} />)
    expect(screen.queryByRole('button', { name: '转到后台' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '运行时' })).not.toBeInTheDocument()
  })

  it('preserves native activity presentation without stop or background controls', () => {
    const source = claudeThread([])
    const state: ClaudeThreadState = source.sessionState
    const template = state.turns[0]!
    render(
      <ClaudeThreadView
        thread={{
          ...source,
          sessionState: checkedClaudeState({
            ...state,
            turns: [{
              ...template,
              updatedAt: 3,
              activities: [{
                id: 'native-agent-tool-use',
                kind: 'agent',
                label: 'Backgroundable native agent',
                status: 'running'
              }, {
                id: 'native-task-activity',
                taskId: 'native-background-task-id',
                kind: 'task',
                label: 'Stoppable native task',
                status: 'running'
              }],
              timeline: [{
                id: 'activity-agent',
                kind: 'activity',
                createdAt: 2,
                activity: {
                  id: 'native-agent-tool-use',
                  kind: 'agent',
                  label: 'Backgroundable native agent',
                  status: 'running'
                }
              }, {
                id: 'activity-task',
                kind: 'activity',
                createdAt: 3,
                activity: {
                  id: 'native-task-activity',
                  taskId: 'native-background-task-id',
                  kind: 'task',
                  label: 'Stoppable native task',
                  status: 'running'
                }
              }]
            }]
          })
        }}
        actions={stubThreadActions()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '显示执行过程' }))
    showExecutionProcesses()
    const agentRow = screen.getByText('Backgroundable native agent')
      .closest<HTMLElement>('.claude-renderer-activity-row')
    const taskRow = screen.getByText('Stoppable native task')
      .closest<HTMLElement>('.claude-renderer-activity-row')
    expect(agentRow).not.toBeNull()
    expect(taskRow).not.toBeNull()
    expect(within(agentRow!).queryByRole('button', { name: '转到后台' })).not.toBeInTheDocument()
    expect(within(taskRow!).queryByRole('button', { name: '停止任务' })).not.toBeInTheDocument()
  })

  it('preserves Session background count and checkpoint fork without a header fork entry', async () => {
    const user = userEvent.setup()
    const runtime = {
      model: 'claude-native-model',
      cwd: '/native/claude/workspace',
      claudeVersion: '9.9.9-native',
      permissionMode: 'native-permission-status',
      effort: 'native-effort-status',
      capabilities: ['native-capability'],
      models: [],
      agents: [],
      commands: [],
      skills: [],
      plugins: [],
      mcpServers: [{
        name: 'native-mcp-name',
        status: 'native-mcp-status',
        serverInfo: 'native-mcp-info'
      }],
      backgroundTasks: [{
        id: 'native-task-id',
        description: 'native-task-description',
        status: 'native-task-status'
      }],
      remoteControl: { enabled: false }
    }
    const forkThread = vi.fn().mockResolvedValue({ threadId: 'claude-fork' })
    const source = claudeThread([])
    const sourceState: ClaudeThreadState = source.sessionState
    const thread: AgentThreadRecord<'claude', ClaudeThreadSettings> = {
      ...source,
      sessionState: checkedClaudeState({
        ...sourceState,
        primarySessionId: 'native-session-id',
        runtime,
        turns: sourceState.turns.map((turn) => ({
          ...turn,
          finishedAt: turn.updatedAt,
          status: 'completed' as const,
          timeline: [{
            id: 'execution-interactions:timeline:user:0',
            kind: 'user-message' as const,
            createdAt: 1,
            promptIndex: 0,
            checkpointId: 'native-checkpoint-id'
          }]
        }))
      }),
      observation: { latestExecution: null, backgroundWork: null }
    }

    render(
      <ClaudeThreadView
        thread={thread}
        actions={stubThreadActions({ forkThread })}
      />
    )

    expect(screen.getByText('1 个后台任务')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '显示执行过程' }))
    expect(screen.getByText('native-task-description')).toBeInTheDocument()
    expect(screen.getByText('native-task-status')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '停止任务' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '运行时' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^分支$/ })).not.toBeInTheDocument()
    expect(forkThread).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '显示用户消息' }))
    await user.click(screen.getByRole('button', { name: '从此处分支' }))
    await waitFor(() => expect(forkThread).toHaveBeenCalledWith({
      checkpointId: 'native-checkpoint-id'
    }))
  })
})

function stubThreadActions(
  overrides: Partial<HarnessRendererThreadActions> = {}
): HarnessRendererThreadActions {
  return {
    interrupt: async () => undefined,
    invokeHarnessExtension: async () => null,
    forkThread: async () => ({ threadId: 'forked-thread' }),
    openExternal: async () => undefined,
    openFollowUp: () => undefined,
    respond: async () => undefined,
    ...overrides
  }
}

function permission(
  id: string,
  title: string,
  canRemember: boolean
): ClaudeInteraction {
  return {
    id,
    kind: 'permission',
    title,
    toolName: 'Bash',
    canRemember,
    status: 'pending'
  }
}

function claudeThread(
  interactions: ClaudeInteraction[],
  promptAttachments: ClaudeInputAttachment[][] = [[]]
): AgentThreadRecord<'claude', ClaudeThreadSettings> & { sessionState: ClaudeThreadState & JsonObject } {
  const publicInteractions = interactions.map(interaction => toPublicClaudeInteraction('execution-interactions', interaction))
  return {
    id: 'claude-interactions-thread',
    harnessId: 'claude',
    revision: 1, archived: false,
    title: 'Claude interactions',
    tags: [],
    cwd: '/tmp',
    sessionState: checkedClaudeState({
      version: 1,
      turns: [{
        executionId: 'execution-interactions',
        createdAt: 1,
        updatedAt: 2,
        prompts: ['Run'],
        promptAttachments,
        text: '',
        reasoning: '',
        status: 'running',
        plan: [],
        activities: [],
        interactions,
        notices: [],
        timeline: []
      }],
      nativeNotifications: []
    }),
    observation: {
      latestExecution: {
        executionId: 'execution-interactions',
        startedAt: 1,
        status: 'waiting-for-user',
        interactions: publicInteractions
      },
      backgroundWork: null
    },
    settings: { executablePath: 'claude' },
    createdAt: 1,
    updatedAt: 2
  }
}

function publicInteractionId(nativeId: string): string {
  return claudePublicInteractionId('execution-interactions', nativeId)
}

function publicQuestionId(nativeId: string, questionIndex: number): string {
  return claudePublicQuestionId('execution-interactions', nativeId, questionIndex)
}

function publicOptionId(nativeId: string, questionIndex: number, optionIndex: number): string {
  return claudePublicOptionId('execution-interactions', nativeId, questionIndex, optionIndex)
}

function checkedClaudeState(value: ClaudeThreadState): ClaudeThreadState & JsonObject {
  if (!isJsonObject(value)) throw new Error('Claude renderer fixture is not JSON')
  return value
}
