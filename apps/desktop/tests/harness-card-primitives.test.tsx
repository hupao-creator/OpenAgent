// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CheckCircle2, LoaderCircle } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HarnessThreadCard,
  HarnessToolActivityGroup,
  ThreadActivityRow,
  ThreadCardProviderStatus,
  ThreadCardStateLabel,
  ThreadTimelineAssistantMessage,
  composeThreadCard,
  tokenizeCommandLine,
  type ThreadCardProjection
} from '@openagent/plugin-kit/renderer'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('historical Harness card presentation primitives', () => {
  it('updates the latest execution clock while live and freezes it at the committed end', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const presentation = composeThreadCard({ kind: 'standard', identity: {}, extensions: [] }, { availableCols: 2 })
    const card = (endedAt?: number) => <HarnessThreadCard
      identity={{
        title: 'Latest execution', model: 'model', excerpt: '',
        runtime: { startedAt: 8_000, ...(endedAt === undefined ? {} : { endedAt }) }
      }}
      presentation={presentation}
    />
    const { rerender } = render(card())
    expect(screen.getByLabelText('已运行 2秒')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(2_000))
    expect(screen.getByLabelText('已运行 4秒')).toBeInTheDocument()
    rerender(card(11_000))
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByLabelText('已运行 3秒')).toBeInTheDocument()
    expect(screen.queryByLabelText('已运行 1分04秒')).not.toBeInTheDocument()
  })

  it('composes a deterministic complete rectangle from structure only', () => {
    const projection: ThreadCardProjection = {
      kind: 'standard',
      identity: {
        usage: {
          parts: [{ id: 'total', label: 'Total ', value: '18.5k', numericValue: 18_527 }]
        }
      },
      extensions: [
        {
          kind: 'todo',
          steps: [{ step: 'Inspect history', status: 'inProgress' }]
        },
        {
          kind: 'derived',
          rows: [{
            id: 'shell',
            kind: 'shell',
            label: 'rg --files apps/desktop',
            status: 'running',
            commandLine: true
          }]
        }
      ]
    }
    const first = composeThreadCard(projection, { availableCols: 2 })
    const changedCopy = composeThreadCard({
      ...projection,
      identity: {
        usage: {
          parts: [{ id: 'total', label: 'Total ', value: '100k', numericValue: 99_999 }]
        }
      },
      extensions: [
        { kind: 'todo', steps: [{ step: 'Different copy', status: 'completed' }] },
        projection.extensions[1]
      ]
    }, { availableCols: 2 })

    expect(first.size).toEqual({ cols: 2, rows: 2 })
    expect(changedCopy.key).toBe(first.key)
    expect(first.composition.kind).toBe('standard')
    expect(tokenizeCommandLine('rg --json "card"').map(({ text }) => text).join('')).toBe(
      'rg --json "card"'
    )
  })

  it('retains the historical identity, extension, usage, and intervention DOM', () => {
    const respond = vi.fn()
    const presentation = composeThreadCard({
      kind: 'standard',
      identity: {
        latestTool: { kind: 'command', name: 'Shell', status: 'running', summary: 'pnpm test' },
        usage: {
          parts: [
            { id: 'total', suffix: 'tokens', description: 'Reported input and output', value: '18.5k', numericValue: 18_527 },
            { id: 'cache', suffix: 'cached', value: '58.6%', numericValue: 0.586 }
          ]
        }
      },
      extensions: [{
        kind: 'intervention',
        intervention: {
          id: 'permission-1',
          title: 'Choose command policy',
          submitActionId: 'submit',
          actions: [{ id: 'submit', label: 'Submit' }],
          questions: [{
            id: 'policy',
            prompt: 'Allow command?',
            multiple: false,
            allowOther: false,
            secret: false,
            options: [{ id: 'allow', label: 'Allow', value: 'allow' }]
          }]
        }
      }]
    }, { availableCols: 2 })

    const { container } = render(
      <HarnessThreadCard
        identity={{
          title: 'Restore Overview',
          providerStatus: (
            <ThreadCardProviderStatus
              brandKey="fixture"
              label="Fixture Harness"
              logoSource="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
              statusClassName="running"
            />
          ),
          state: (
            <ThreadCardStateLabel
              className="attention"
              icon={<LoaderCircle size={13} />}
            >
              Needs attention
            </ThreadCardStateLabel>
          ),
          model: 'model-x',
          effort: 'high',
          cwd: '/tmp/OpenAgent',
          usesWorktree: true,
          excerpt: 'Latest committed answer'
        }}
        presentation={presentation}
        onInterventionResponse={respond}
      />
    )

    expect(container.querySelector('.thread-card-layout')).toBeInTheDocument()
    expect(container.querySelector('.thread-card-identity')).toHaveAttribute('data-identity-size', '1x2')
    expect(container.querySelector('.thread-card-extension.extension-intervention')).toBeInTheDocument()
    expect(container.querySelector('.thread-card-identity-usage')).toHaveTextContent('18.5ktokens · 58.6%cached')
    expect(screen.getByTitle('Reported input and output')).toHaveTextContent('18.5ktokens')
    expect(container.querySelector('.thread-card-identity-tool')).toHaveTextContent('pnpm test')
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(respond).toHaveBeenCalledWith({
      actionId: 'submit',
      answers: { policy: 'allow' }
    })
  })

  it('groups opaque Plugin activity nodes without interpreting their native kind or status', () => {
    const activity = (id: string, label: string, running = false) => ({
      id,
      running,
      node: (
        <ThreadActivityRow
          id={id}
          className={(running ? 'running' : 'completed') + ' t3code-activity'}
          state={running
            ? <LoaderCircle aria-label="live" size={12} />
            : <CheckCircle2 aria-label="done" size={12} />}
          label={label}
        />
      )
    })
    const group = (items: ReturnType<typeof activity>[]) => (
      <ThreadTimelineAssistantMessage id="assistant" className="t3code-assistant-message">
        <HarnessToolActivityGroup
          groupId="tools"
          items={items}
          summary="Two native activities"
          summaryLabel="Two native activities, one live"
          summaryState={<LoaderCircle size={12} />}
        />
      </ThreadTimelineAssistantMessage>
    )
    const { rerender } = render(group([
      activity('native-a', 'Plugin-owned running activity', true),
      activity('native-b', 'Plugin-owned completed activity')
    ]))

    expect(screen.getByText('Plugin-owned running activity')).toBeInTheDocument()
    expect(screen.queryByText('Plugin-owned completed activity')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Two native activities, one live' }))
    expect(screen.getByText('Plugin-owned completed activity')).toBeInTheDocument()
    screen.getByRole('button', { name: /Plugin-owned completed activity/ }).focus()
    rerender(group([
      activity('native-c', 'Replacement activity'),
      activity('native-d', 'Another replacement')
    ]))
    expect(screen.getByRole('button', { name: 'Two native activities, one live' })).toHaveFocus()
  })
})


it('keeps Other inline, focuses and collapses it, and submits text-only and multiple questions', async () => {
  const respond = vi.fn(async () => undefined)
  const presentation = composeThreadCard({ kind: 'standard', identity: {}, extensions: [{
    kind: 'intervention', intervention: {
      id: 'questions', title: 'Questions', submitActionId: 'send',
      actions: [{ id: 'send', label: 'Send' }, { id: 'cancel', label: 'Cancel' }],
      questions: [
        { id: 'scope', prompt: 'Scope?', multiple: true, allowOther: true, secret: false,
          options: [{ id: 'native-id', value: 'native-value', label: 'Project' }] },
        { id: 'free', prompt: 'Details?', multiple: false, allowOther: true, secret: false, options: [] }
      ]
    }
  }] }, { availableCols: 1 })
  const { container } = render(<HarnessThreadCard identity={{ title: 'Question task', model: 'Model', excerpt: '' }}
    presentation={presentation} onInterventionResponse={respond} />)
  const other = screen.getByRole('button', { name: '其它…' })
  const slot = other.parentElement
  fireEvent.click(other)
  const editor = screen.getByRole('textbox', { name: 'Scope?' })
  expect(editor).toHaveFocus()
  expect(editor.parentElement).toBe(slot)
  expect(screen.queryByRole('button', { name: '其它…' })).toBeNull()
  fireEvent.keyDown(editor, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: '其它…' }))
  fireEvent.blur(screen.getByRole('textbox', { name: 'Scope?' }))
  expect(screen.getByRole('button', { name: '其它…' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Project' }))
  fireEvent.click(screen.getByRole('button', { name: '其它…' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Scope?' }), { target: { value: '  custom  ' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Details?' }), { target: { value: 'plain response' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
  expect(respond).toHaveBeenCalledWith({ actionId: 'send', answers: { scope: ['native-value', 'custom'], free: 'plain response' } })
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  expect(container.querySelectorAll('.interaction-question')).toHaveLength(1)
})

it('fits questions and combined extensions into one available column', () => {
  const question = { kind: 'intervention' as const, intervention: { id: 'q', title: 'Q', actions: [],
    questions: [{ id: 'q1', prompt: 'Choose', multiple: false, allowOther: true, secret: false, options: [] }] } }
  const derived = { kind: 'derived' as const, rows: [{ id: 'bg', kind: 'task' as const, label: 'Background', status: 'running' as const, commandLine: false }] }
  for (const extensions of [[question], [question, derived]]) {
    const card = composeThreadCard({ kind: 'standard', identity: {}, extensions }, { availableCols: 1 })
    expect(card.size.cols).toBe(1)
    if (card.composition.kind !== 'standard') throw new Error('Expected standard composition')
    expect(card.composition.placements.every(item => item.col === 0)).toBe(true)
  }
})

it('removes interventions before packing while preserving identity, plans and derived work', () => {
  const projection: ThreadCardProjection = { kind: 'standard', identity: {}, extensions: [
    { kind: 'intervention', intervention: { id: 'permission', title: 'Allow?', actions: [] } },
    { kind: 'todo', steps: [{ step: 'Check workspace', status: 'inProgress' }] },
    { kind: 'derived', rows: [{ id: 'bg', kind: 'task', label: 'Background', status: 'running', commandLine: false }] }
  ] }
  const expected = { ...projection, extensions: projection.extensions.slice(1) }
  for (const availableCols of [1, 2, 3]) {
    const hidden = composeThreadCard(projection, { availableCols, displayPolicy: { hideInterventions: true } })
    expect(hidden).toEqual(composeThreadCard(expected, { availableCols }))
    expect(composeThreadCard(projection, { availableCols, displayPolicy: { hideInterventions: false } }).projection)
      .toEqual(projection)
  }
  expect(projection.extensions).toHaveLength(3)
})
