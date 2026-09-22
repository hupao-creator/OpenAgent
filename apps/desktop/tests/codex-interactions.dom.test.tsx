// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { expectOverviewPolicyToggle } from './overview-display-policy-support'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexOverviewCard } from '../../../packages/harness-codex/src/renderer/OverviewCard'
import { CodexThreadView } from '../../../packages/harness-codex/src/renderer/ThreadView'
import { projectCodexOverview } from '../../../packages/harness-codex/src/renderer/overview'
import {
  createEmptyCodexState,
  decodeCodexState,
  reduceCodexEvent,
  stageCodexExecution
} from '../../../packages/harness-codex/src/shared/state'
import type {
  CodexInteraction,
  CodexThreadSettings
} from '../../../packages/harness-codex/src/shared/types'
import { toPublicInteraction, codexPublicInteractionId, codexPublicQuestionId, codexPublicOptionId } from '../../../packages/harness-codex/src/shared/public-interactions'
import { isJsonValue, type JsonValue } from '@openagent/contracts'
import type { AgentThreadRecord, BartThreadRecord } from '@openagent/contracts'
import type { HarnessRendererThreadActions } from '@openagent/contracts/renderer'
import { harnessRendererTranslations, harnessRendererPlugins, projectHarnessBartPresentation } from '../src/renderer/src/harness-composition'
import { I18nProvider } from '@openagent/plugin-kit/renderer'

afterEach(cleanup)

describe('Codex renderer interactions', () => {
  it.each(['question', 'permission'])('toggles the %s extension through the Core overview policy', async (kind) => {
    await expectOverviewPolicyToggle(kind === 'question' ? codexQuestionThread()
      : codexInteractionThread(codexPermissionInteraction()))
  })
  it('keeps Codex overview context on the latest execution without changing Bart dock summaries', () => {
    let state = stageCodexExecution(createEmptyCodexState(1), 'old-run', {
      parts: [{ kind: 'text', text: 'Previous task' }]
    }, 2, 'old-prompt')
    state.turns[0] = {
      ...state.turns[0]!, status: 'completed', finishedAt: 2, answer: 'Earlier answer',
      timeline: [{ id: 'answer-old', itemId: 'answer-old', kind: 'assistant', content: 'Earlier answer', status: 'complete', createdAt: 2 }]
    }
    state = stageCodexExecution(state, 'new-run', {
      parts: [{ kind: 'text', text: 'Current task' }]
    }, 3, 'new-prompt')
    const thread: AgentThreadRecord<'codex'> = {
      id: 'codex-overview', harnessId: 'codex', revision: 1, archived: false, title: 'Audit',
      tags: [], cwd: '/workspace', settings: {}, sessionState: state as unknown as JsonValue,
      observation: { latestExecution: { executionId: 'new-run', status: 'running', startedAt: 3 }, backgroundWork: null },
      createdAt: 1, updatedAt: 3
    }
    const excerpt = () => harnessRendererPlugins.codex.projectOverview({
      thread: structuredClone(thread)
    }, 2)?.envelope.excerpt
    expect(excerpt()).toBe('Current task')
    expect(harnessRendererPlugins.codex.projectBartDock(thread)?.reply?.excerpt).toBe('Earlier answer')
    state.turns[1] = { ...state.turns[1]!, reasoning: 'Current reasoning' }
    expect(excerpt()).toBe('Current reasoning')
    state.turns[1] = { ...state.turns[1]!, answer: 'Current answer' }
    expect(excerpt()).toBe('Current answer')
  })

  it('projects the Bart Dock response from Harness-owned plugin state', () => {
    const staged = stageCodexExecution(
      createEmptyCodexState(1),
      'execution-1',
      { parts: [{ kind: 'text', text: 'Question' }] },
      2,
      'message-1'
    )
    const thread: BartThreadRecord<'codex', CodexThreadSettings> = {
      id: 'bart-thread',
      bart: true,
      harnessId: 'codex',
      revision: 1,
      title: 'Bart',
      tags: [],
      cwd: '/tmp/bart',
      settings: {},
      sessionState: JSON.parse(JSON.stringify({
        ...staged,
        turns: staged.turns.map(turn => ({
          ...turn,
          answer: 'Answer stored only in Codex sessionState.',
          timeline: [{ id: 'answer-1', itemId: 'answer-1', kind: 'assistant', content: 'Answer stored only in Codex sessionState.', status: 'complete', createdAt: 2 }],
          status: 'completed',
          finishedAt: 2
        }))
      })),
      observation: {
        latestExecution: {
          executionId: 'execution-1',
          status: 'completed',
          startedAt: 2,
          finishedAt: 3
        },
        backgroundWork: null
      },
      transcript: [],
      createdAt: 1,
      updatedAt: 3
    }

    expect(projectHarnessBartPresentation(thread)?.reply?.excerpt)
      .toBe('Answer stored only in Codex sessionState.')
  })

  it('follows native message order and authoritative final text in the overview', () => {
    let state = stageCodexExecution(createEmptyCodexState(1), 'stream-run', {
      parts: [{ kind: 'text', text: 'Current task' }]
    }, 2, 'prompt')
    let at = 2
    const excerpt = () => projectCodexOverview({ thread: {
      id: 'stream-card', harnessId: 'codex', revision: at, title: 'Audit', tags: [],
      cwd: '/workspace', settings: {}, sessionState: state as unknown as JsonValue,
      observation: { latestExecution: null, backgroundWork: null }, createdAt: 1, updatedAt: at
    }, layout: { availableColumns: 2 } }).excerpt
    const event = (value: Parameters<typeof reduceCodexEvent>[2]) => {
      state = reduceCodexEvent(state, 'stream-run', value, ++at, `event-${at}`)
    }
    event({ type: 'text-delta', itemId: 'commentary', delta: 'First commentary' })
    event({ type: 'reasoning-delta', delta: 'Latest reasoning' })
    expect(excerpt()).toBe('Latest reasoning')
    event({ type: 'text-delta', itemId: 'answer', delta: 'Old prefix '.repeat(100) + '最新😀' })
    expect(excerpt()).toMatch(/最新😀$/u)
    expect(excerpt()).not.toContain('First commentary')
    event({ type: 'text-final', itemId: 'answer', text: 'Authoritative final answer' })
    event({ type: 'done', outcome: 'completed' })
    expect(excerpt()).toBe('Authoritative final answer')
  })

  it('accepts only the current null handshake before first Plugin state publication', () => {
    const thread: AgentThreadRecord<'codex', CodexThreadSettings> = {
      ...codexQuestionThread(),
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null }
    }
    const view = render(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <CodexThreadView
          thread={thread}
          actions={stubThreadActions()}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('img', { name: 'A cat behind a computer, waiting for a new idea.' })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    view.rerender(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <CodexThreadView
          thread={{ ...thread, observation: { latestExecution: { executionId: 'starting', status: 'running', startedAt: 1 }, backgroundWork: null } }}
          actions={stubThreadActions()}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('status')).toHaveTextContent('Running')
    view.rerender(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <CodexThreadView thread={codexQuestionThread()} actions={stubThreadActions()} />
      </I18nProvider>
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(() => projectCodexOverview({
      thread,
      layout: { availableColumns: 2 }
    })).not.toThrow()
    expect(() => projectCodexOverview({
      thread: { ...thread, sessionState: undefined as never },
      layout: { availableColumns: 2 }
    })).toThrow(/Codex sessionState/)
  })

  it('preserves native question and notice copy even when a catalog contains matching keys', () => {
    const base = codexQuestionThread()
    const state = decodeCodexState(base.sessionState)
    const turn = state.turns[0]!
    const interaction = turn.interactions[0]!
    const question = interaction.questions[0]!
    const option = question.options[0]!
    const updatedInteraction: CodexInteraction = {
      ...interaction,
      title: '原生标题',
      detail: '原生详情',
      actions: interaction.actions.map((action) => ({
        ...action,
        label: action.id === 'submit' ? '原生提交' : '原生取消'
      })),
      questions: [{
        ...question,
        header: '原生标题栏',
        prompt: '原生问题',
        options: [{
          ...option,
          label: '原生选项',
          description: '原生说明'
        }]
      }]
    }
    const thread: AgentThreadRecord<'codex', CodexThreadSettings> = {
      ...base,
      sessionState: checkedJson({
        ...state,
        updatedAt: 4,
        turns: [{
          ...turn,
          updatedAt: 4,
          interactions: [updatedInteraction],
          notices: [{ id: 'notice-native', level: 'info', message: '原生通知' }],
          timeline: [...turn.timeline, {
            id: 'timeline-native-notice',
            kind: 'notice',
            noticeId: 'notice-native',
            createdAt: 4
          }]
        }]
      }),
      observation: waitingObservation(updatedInteraction)
    }
    const translations = {
      'en-US': {
        ...harnessRendererTranslations['en-US'],
        原生标题: 'WRONG title translation',
        原生详情: 'WRONG detail translation',
        原生标题栏: 'WRONG header translation',
        原生问题: 'WRONG prompt translation',
        原生选项: 'WRONG option translation',
        原生说明: 'WRONG description translation',
        原生通知: 'WRONG notice translation'
      }
    }

    render(
      <I18nProvider locale="en-US" translations={translations}>
        <CodexThreadView
          thread={thread}
          actions={stubThreadActions()}
        />
      </I18nProvider>
    )

    for (const copy of [
      '原生标题',
      '原生详情',
      '原生标题栏',
      '原生问题',
      '原生选项',
      '原生说明'
    ]) {
      expect(screen.getByText(copy)).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))
    expect(screen.getByText('原生通知')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
    expect(screen.queryByText(/WRONG/)).not.toBeInTheDocument()
  })

  it('preserves native runtime model and status labels in the overview', () => {
    const base = codexQuestionThread()
    const state = decodeCodexState(base.sessionState)
    const turn = state.turns[0]!
    const thread: AgentThreadRecord<'codex', CodexThreadSettings> = {
      ...base,
      sessionState: checkedJson({
        ...state,
        turns: [{
          ...turn,
          status: 'running',
          statusLabel: '原生状态',
          runtimeModel: '原生模型',
          interactions: [],
          timeline: turn.timeline.filter((item) => item.kind !== 'interaction')
        }]
      }),
      observation: {
        latestExecution: {
          executionId: turn.executionId,
          status: 'running',
          startedAt: turn.createdAt
        },
        backgroundWork: null
      }
    }
    const projection = projectCodexOverview({
      thread,
      layout: { availableColumns: 2 }
    })
    const translations = {
      'en-US': {
        ...harnessRendererTranslations['en-US'],
        原生状态: 'WRONG status translation',
        原生模型: 'WRONG model translation'
      }
    }

    render(
      <I18nProvider locale="en-US" translations={translations}>
        <CodexOverviewCard
          thread={thread}
          projection={projection.view}
          actions={{
            ...stubThreadActions(),
            openThread: () => undefined
          }}
        />
      </I18nProvider>
    )

    expect(projection.view.statusLabel).toBe('原生状态')
    expect(screen.queryByText('原生状态')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Codex · Running' })).toBeInTheDocument()
    expect(screen.getByText('原生模型')).toBeInTheDocument()
    expect(screen.queryByText(/WRONG/)).not.toBeInTheDocument()
  })

  it('localizes Plugin-produced interaction actions in en-US', () => {
    render(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <CodexThreadView
          thread={codexInteractionThread(codexFormInteraction())}
          actions={stubThreadActions()}
        />
      </I18nProvider>
    )

    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it.each([
    ['Thread', 'thread'],
    ['Overview', 'overview']
  ] as const)('submits stable option ids from the %s surface', async (_label, surface) => {
    const user = userEvent.setup()
    const respond = vi.fn(async () => undefined)
    const thread = codexQuestionThread()

    if (surface === 'thread') {
      render(
        <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
          <CodexThreadView
            thread={thread}
            actions={stubThreadActions({ respond })}
          />
        </I18nProvider>
      )
    } else {
      const projection = projectCodexOverview({
        thread,
        layout: { availableColumns: 2 }
      })
      render(
        <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
          <CodexOverviewCard
            thread={thread}
            projection={projection.view}
            actions={{
              ...stubThreadActions({ respond }),
              openThread: () => undefined
            }}
          />
        </I18nProvider>
      )
    }

    expect(document.body.innerHTML).not.toContain('question-1')
    expect(document.body.innerHTML).not.toContain('scope:option:0')
    await user.click(screen.getByRole('button', { name: /Workspace/ }))
    await user.click(screen.getByRole('button', { name: 'Submit' }))

    expect(respond).toHaveBeenCalledWith({
      interactionId: codexPublicInteractionId('question-1'),
      actionId: 'submit',
      answers: { [codexPublicQuestionId('question-1', 'scope')]: codexPublicOptionId('question-1', 'scope', 'scope:option:0') }
    })
    expect(JSON.stringify(respond.mock.calls)).not.toContain('question-1')
    expect(JSON.stringify(respond.mock.calls)).not.toContain('scope:option:0')
  })

  it.each([
    ['Thread', 'thread'],
    ['Overview', 'overview']
  ] as const)(
    'keeps a rejected %s response visible and locks the successful retry',
    async (_label, surface) => {
      const user = userEvent.setup()
      let attempt = 0
      const respond = vi.fn(() => {
        attempt += 1
        return attempt === 1
          ? Promise.reject(new Error('Native Codex rejected this response'))
          : new Promise<void>(() => undefined)
      })
      const thread = codexInteractionThread(codexPermissionInteraction())

      if (surface === 'thread') {
        render(
          <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
            <CodexThreadView
              thread={thread}
              actions={stubThreadActions({ respond })}
            />
          </I18nProvider>
        )
      } else {
        const projection = projectCodexOverview({
          thread,
          layout: { availableColumns: 2 }
        })
        render(
          <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
            <CodexOverviewCard
              thread={thread}
              projection={projection.view}
              actions={{
                ...stubThreadActions({ respond }),
                openThread: () => undefined
              }}
            />
          </I18nProvider>
        )
      }

      const allow = screen.getByRole('button', { name: 'Allow once' })
      await user.click(allow)
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Native Codex rejected this response'
      )
      expect(allow).toBeEnabled()

      await user.click(allow)
      expect(respond).toHaveBeenCalledTimes(2)
      expect(allow).toBeDisabled()
      fireEvent.click(allow)
      expect(respond).toHaveBeenCalledTimes(2)
    }
  )

  it('renders a normal values question as plain text even when deny and submit actions exist', async () => {
    const user = userEvent.setup()
    const respond = vi.fn(async () => undefined)
    const form = codexFormInteraction()
    const interaction: CodexInteraction = {
      id: 'ordinary-input', kind: 'user-input', title: 'Choose a value',
      blocksTurn: true, status: 'pending', actions: form.actions,
      questions: [{ id: 'values', prompt: 'Environment', secret: false, allowOther: true, options: [] }]
    }
    render(<CodexThreadView
      thread={codexInteractionThread(interaction)}
      actions={stubThreadActions({ respond })}
    />)
    await user.type(screen.getByRole('textbox'), 'staging')
    await user.click(screen.getByRole('button', { name: '提交' }))
    expect(respond).toHaveBeenCalledWith({
      interactionId: codexPublicInteractionId('ordinary-input'), actionId: 'submit',
      answers: { [codexPublicQuestionId('ordinary-input', 'values')]: 'staging' }
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['提交', 'submit'],
    ['拒绝', 'deny'],
    ['取消', 'cancel']
  ] as const)('completes a form elicitation with the %s action', async (label, actionId) => {
    const user = userEvent.setup()
    const respond = vi.fn(async () => undefined)
    render(
      <CodexThreadView
        thread={codexInteractionThread(codexFormInteraction())}
        actions={stubThreadActions({ respond })}
      />
    )

    expect(screen.getByText(/"environment"/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    if (actionId === 'submit') {
      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: '{"environment":"staging","replicas":2}' }
      })
    }
    await user.click(screen.getByRole('button', { name: label }))

    expect(respond).toHaveBeenCalledWith({
      interactionId: codexPublicInteractionId('elicitation-form-1'),
      actionId,
      ...(actionId === 'submit'
        ? { answers: { [codexPublicQuestionId('elicitation-form-1', 'deployment-input')]: '{"environment":"staging","replicas":2}' } }
        : {})
    })
    expect(JSON.stringify(respond.mock.calls)).not.toContain('elicitation-form-1')
  })

  it.each([
    ['提交', 'submit'],
    ['拒绝', 'deny'],
    ['取消', 'cancel']
  ] as const)('completes a URL elicitation with the %s action', async (label, actionId) => {
    const user = userEvent.setup()
    const respond = vi.fn(async () => undefined)
    render(
      <CodexThreadView
        thread={codexInteractionThread(codexUrlInteraction())}
        actions={stubThreadActions({ respond })}
      />
    )

    expect(screen.getByText('https://example.test/form')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: label }))

    expect(respond).toHaveBeenCalledWith({
      interactionId: codexPublicInteractionId('elicitation-url-1'),
      actionId
    })
    expect(JSON.stringify(respond.mock.calls)).not.toContain('elicitation-url-1')
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

function codexQuestionThread(): AgentThreadRecord<'codex', CodexThreadSettings> {
  const interaction: CodexInteraction = {
    id: 'question-1',
    kind: 'user-input',
    title: 'Codex 需要补充信息',
    blocksTurn: true,
    status: 'pending',
    actions: [
      { id: 'submit', intent: 'submit', label: '提交' },
      { id: 'cancel', intent: 'cancel', label: '取消' }
    ],
    questions: [{
      id: 'scope',
      header: 'Scope',
      prompt: 'Which scope?',
      secret: false,
      allowOther: false,
      options: [{
        id: 'scope:option:0',
        label: 'Workspace',
        description: 'Current workspace'
      }]
    }]
  }
  return codexInteractionThread(interaction)
}

function codexFormInteraction(): CodexInteraction {
  const schema = {
    type: 'object',
    properties: {
      environment: { type: 'string' },
      replicas: { type: 'integer' }
    },
    required: ['environment']
  }
  return {
    id: 'elicitation-form-1',
    kind: 'mcp-elicitation',
    elicitation: { mode: 'form', requestedSchema: schema, questionId: 'deployment-input' },
    title: 'Provide deployment details',
    blocksTurn: true,
    status: 'pending',
    actions: [
      { id: 'submit', intent: 'submit', label: '提交' },
      { id: 'deny', intent: 'deny', label: '拒绝' },
      { id: 'cancel', intent: 'cancel', label: '取消' }
    ],
    questions: [{
      id: 'deployment-input',
      prompt: 'JSON form values',
      secret: false,
      allowOther: true,
      options: []
    }]
  }
}

function codexPermissionInteraction(): CodexInteraction {
  return {
    id: 'approval-1',
    kind: 'command-approval',
    title: 'Run verification',
    detail: 'pnpm test',
    blocksTurn: true,
    status: 'pending',
    actions: [
      { id: 'allow-once', intent: 'allow', label: '允许一次' },
      { id: 'cancel', intent: 'cancel', label: '取消' }
    ],
    questions: []
  }
}

function codexUrlInteraction(): CodexInteraction {
  return {
    id: 'elicitation-url-1',
    kind: 'mcp-elicitation',
    elicitation: { mode: 'url', url: 'https://example.test/form' },
    title: 'Open the external form',
    blocksTurn: true,
    status: 'pending',
    actions: [
      { id: 'submit', intent: 'submit', label: '提交' },
      { id: 'deny', intent: 'deny', label: '拒绝' },
      { id: 'cancel', intent: 'cancel', label: '取消' }
    ],
    questions: []
  }
}

function codexInteractionThread(
  interaction: CodexInteraction
): AgentThreadRecord<'codex', CodexThreadSettings> {
  const staged = stageCodexExecution(
    createEmptyCodexState(1),
    'execution-1',
    { parts: [{ kind: 'text', text: 'Ask me a question.' }] },
    2,
    'message-1'
  )
  const state = reduceCodexEvent(
    staged,
    'execution-1',
    { type: 'interaction-opened', interaction },
    3,
    'event-1'
  )
  return {
    id: 'codex-question-thread',
    harnessId: 'codex',
    revision: 1, archived: false,
    sessionState: checkedJson(state),
    observation: waitingObservation(interaction),
    title: 'Codex question test',
    tags: [],
    cwd: '/Users/demo/OpenAgent',
    settings: {},
    createdAt: 1,
    updatedAt: 3
  }
}

function waitingObservation(interaction: CodexInteraction): AgentThreadRecord['observation'] {
  return {
    latestExecution: {
      executionId: 'execution-1',
      startedAt: 2,
      status: 'waiting-for-user',
      interactions: [toPublicInteraction(interaction)]
    },
    backgroundWork: null
  }
}

function checkedJson(value: unknown): JsonValue {
  const clone: unknown = structuredClone(value)
  if (!isJsonValue(clone)) throw new Error('Codex renderer fixture is not JSON')
  return clone
}
