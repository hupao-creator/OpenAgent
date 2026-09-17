// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider, ThreadDetailSurface } from '@openagent/plugin-kit/renderer'
import { ClaudeTurnView } from '../src/renderer/thread/TurnView.js'
import { claudeRendererTranslations } from '../src/renderer/translations.js'
import { parseClaudeThreadState, type ClaudeTurn } from '../src/shared/state.js'

afterEach(cleanup)

describe('Claude current timeline', () => {
  it.each([
    ['completed', 'completed', 'Completed'],
    ['failed', 'failed', 'Failed'],
    ['interrupted', 'cancelled', 'Cancelled']
  ] as const)('renders persisted %s entity state over stale running/pending history', (
    outcome, activityStatus, label
  ) => {
    const turn: ClaudeTurn = {
      executionId: 'execution-1', createdAt: 1, updatedAt: 2, finishedAt: 2,
      prompts: [], promptAttachments: [], text: '', reasoning: '',
      status: outcome, plan: [], notices: [],
      activities: [{
        id: 'settled-task', taskId: 'settled-task', kind: 'task',
        label: 'Settled task', status: activityStatus
      }],
      interactions: [{
        id: 'settled-permission', kind: 'permission', title: 'Settled permission', status: 'cancelled'
      }],
      timeline: []
    }
    turn.timeline = [{
      id: 'task-start', kind: 'activity', createdAt: 1,
      activity: { ...turn.activities[0]!, status: 'running' }
    }, {
      id: 'permission-pending', kind: 'interaction', createdAt: 2,
      interaction: { ...turn.interactions[0]!, status: 'pending' }
    }]
    renderClaudeTurn(turn)

    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))
    expect(screen.getByRole('button', { name: `Settled task ${label}` })).toBeInTheDocument()
    const interaction = screen.getByText('Settled permission').closest('div')!
    expect(within(interaction).getByText('Cancelled')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop task' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
  })

  it('merges adjacent native activity rows into one disclosure without merging across a boundary', () => {
    const turn: ClaudeTurn = {
      executionId: 'execution-merge', createdAt: 1, updatedAt: 4, finishedAt: 4,
      prompts: [], promptAttachments: [], text: '', reasoning: '',
      status: 'completed', plan: [], notices: [], interactions: [],
      activities: [],
      timeline: []
    }
    turn.activities = [
      { id: 'tool-read', kind: 'file', label: 'Read project routes', status: 'completed' },
      { id: 'tool-search', kind: 'search', label: 'Search filter components', status: 'completed' },
      { id: 'tool-edit', kind: 'tool', label: 'Add status filter', status: 'completed' }
    ]
    turn.timeline = [
      { id: 'activity-read', kind: 'activity', createdAt: 1, activity: turn.activities[0]! },
      { id: 'activity-search', kind: 'activity', createdAt: 2, activity: turn.activities[1]! },
      { id: 'answer', kind: 'assistant', createdAt: 3, content: 'Done.', status: 'complete' },
      { id: 'activity-edit', kind: 'activity', createdAt: 4, activity: turn.activities[2]! }
    ]
    const container = renderClaudeTurn(turn)
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))

    const groups = container.querySelectorAll('.activity-group')
    expect(groups).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Claude execution activity' }))
    expect(groups[0]!.querySelectorAll('.claude-renderer-activity-row')).toHaveLength(2)
    expect(screen.getByText('Read project routes').closest('.activity-group')).toBe(groups[0])
    expect(screen.getByText('Search filter components').closest('.activity-group')).toBe(groups[0])
    expect(screen.getByText('Add status filter').closest('.activity-group')).toBeNull()
    expect(groups[0]!.querySelector('.activity-group-state svg')?.getAttribute('class'))
      .toContain('lucide-wrench')
  })

  it.each([
    ['failed', 'lucide-circle-alert', '1 Failed'],
    ['cancelled', 'lucide-circle-stop', '1 Cancelled']
  ] as const)('carries a settled %s into the collapsed group summary', (status, glyph, named) => {
    const turn: ClaudeTurn = {
      executionId: `execution-${status}`, createdAt: 1, updatedAt: 3, finishedAt: 3,
      prompts: [], promptAttachments: [], text: '', reasoning: '',
      status: 'completed', plan: [], notices: [], interactions: [],
      activities: [
        { id: 'tool-read', kind: 'file', label: 'Read project routes', status: 'completed' },
        { id: 'tool-edit', kind: 'tool', label: 'Add status filter', status }
      ],
      timeline: []
    }
    turn.timeline = [
      { id: 'activity-read', kind: 'activity', createdAt: 1, activity: turn.activities[0]! },
      { id: 'activity-edit', kind: 'activity', createdAt: 2, activity: turn.activities[1]! }
    ]
    const container = renderClaudeTurn(turn)
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))

    const group = container.querySelector('.activity-group')!
    expect(group.querySelector('.activity-group-body')?.classList.contains('open')).toBe(false)
    expect(group.querySelector('.activity-group-state svg')?.getAttribute('class')).toContain(glyph)
    expect(group.querySelector('.activity-group-summary')?.getAttribute('aria-label'))
      .toBe(`Claude execution activity · ${named}`)
  })

  it('keeps an internal prompt as a boundary between activity groups', () => {
    const turn: ClaudeTurn = {
      executionId: 'execution-internal', createdAt: 1, updatedAt: 4, finishedAt: 4,
      prompts: ['First ask', 'Steering nudge', 'Second ask'],
      promptAttachments: [[], [], []],
      internalPromptIndexes: [1],
      text: '', reasoning: '',
      status: 'completed', plan: [], notices: [], interactions: [],
      activities: [],
      timeline: []
    }
    turn.activities = [
      { id: 'tool-read', kind: 'file', label: 'Read project routes', status: 'completed' },
      { id: 'tool-edit', kind: 'tool', label: 'Add status filter', status: 'completed' }
    ]
    turn.timeline = [
      { id: 'activity-read', kind: 'activity', createdAt: 1, activity: turn.activities[0]! },
      { id: 'internal-prompt', kind: 'user-message', createdAt: 2, promptIndex: 1 },
      { id: 'activity-edit', kind: 'activity', createdAt: 3, activity: turn.activities[1]! }
    ]
    const container = renderClaudeTurn(turn)
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))

    expect(container.querySelectorAll('.activity-group')).toHaveLength(0)
    expect(screen.getByText('Read project routes')).toBeInTheDocument()
    expect(screen.getByText('Add status filter')).toBeInTheDocument()
    expect(screen.queryByText('Steering nudge')).not.toBeInTheDocument()
  })

  it('keeps a projected-away entry as a boundary between activity groups', () => {
    const turn: ClaudeTurn = {
      executionId: 'execution-projected', createdAt: 1, updatedAt: 4, finishedAt: 4,
      prompts: [], promptAttachments: [], text: '', reasoning: '',
      status: 'completed', plan: [], notices: [], interactions: [],
      activities: [],
      timeline: []
    }
    turn.activities = [
      { id: 'tool-read', kind: 'file', label: 'Read project routes', status: 'completed' },
      { id: 'tool-edit', kind: 'tool', label: 'Add status filter', status: 'completed' }
    ]
    turn.timeline = [
      { id: 'activity-read', kind: 'activity', createdAt: 1, activity: turn.activities[0]! },
      { id: 'diff-1', kind: 'diff', createdAt: 2, content: 'Routes changed' },
      { id: 'activity-edit', kind: 'activity', createdAt: 3, activity: turn.activities[1]! }
    ]
    const container = renderClaudeTurn(turn)
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))

    expect(container.querySelectorAll('.activity-group')).toHaveLength(0)
    expect(screen.getByText('Read project routes')).toBeInTheDocument()
    expect(screen.getByText('Add status filter')).toBeInTheDocument()
  })

  it('hands focus to the group summary when a live row becomes a group', () => {
    const view = render(<ClaudeTurnTree turn={focusTurn(false)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))
    const row = view.container.querySelector<HTMLElement>('.claude-renderer-activity-row .activity-summary')!
    row.focus()
    expect(row).toHaveFocus()

    view.rerender(<ClaudeTurnTree turn={focusTurn(true)} />)

    expect(view.container.querySelectorAll('.activity-group')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Claude execution activity' })).toHaveFocus()
  })

  it('leaves focus alone when the row already lost it before becoming a group', () => {
    const view = render(<ClaudeTurnTree turn={focusTurn(false)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }))
    const row = view.container.querySelector<HTMLElement>('.claude-renderer-activity-row .activity-summary')!
    row.focus()
    row.blur()
    expect(document.activeElement).toBe(document.body)

    view.rerender(<ClaudeTurnTree turn={focusTurn(true)} />)

    expect(view.container.querySelectorAll('.activity-group')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Claude execution activity' })).not.toHaveFocus()
  })
})

function focusTurn(settled: boolean): ClaudeTurn {
  const turn: ClaudeTurn = {
    executionId: 'execution-focus', createdAt: 1, updatedAt: 2, finishedAt: settled ? 2 : undefined,
    prompts: [], promptAttachments: [], text: '', reasoning: '',
    status: settled ? 'completed' : 'running', plan: [], notices: [], interactions: [],
    activities: [
      { id: 'tool-read', kind: 'file', label: 'Read project routes', status: settled ? 'completed' : 'running' }
    ],
    timeline: []
  }
  turn.timeline = [{
    id: 'activity-read', kind: 'activity', createdAt: 1, activity: turn.activities[0]!
  }]
  if (!settled) return turn
  turn.activities = [
    { id: 'tool-read', kind: 'file', label: 'Read project routes', status: 'completed' },
    { id: 'tool-edit', kind: 'tool', label: 'Add status filter', status: 'completed' }
  ]
  turn.timeline = [
    { id: 'activity-read', kind: 'activity', createdAt: 1, activity: turn.activities[0]! },
    { id: 'activity-edit', kind: 'activity', createdAt: 2, activity: turn.activities[1]! }
  ]
  return turn
}

function ClaudeTurnTree(props: { readonly turn: ClaudeTurn }): React.JSX.Element {
  const restored = parseClaudeThreadState(JSON.parse(JSON.stringify({
    version: 1, turns: [props.turn], nativeNotifications: []
  }))).turns[0]!
  return (
    <I18nProvider locale="en-US" translations={claudeRendererTranslations}>
      <ThreadDetailSurface
        threadId="claude-thread"
        title="Claude"
        running={false}
        rows={[{
          id: restored.executionId,
          createdAt: restored.createdAt,
          node: <ClaudeTurnView
            active={false}
            waiting={false}
            turn={restored}
            publicInteractionsByNativeId={new Map()}
            actions={{
              interrupt: async () => undefined,
              invokeHarnessExtension: async () => null,
              forkThread: async () => ({ threadId: 'forked-thread' }),
              openExternal: async () => undefined,
              openFollowUp: () => undefined,
              respond: async () => undefined
            }}
          />
        }]}
      />
    </I18nProvider>
  )
}

function renderClaudeTurn(turn: ClaudeTurn): HTMLElement {
  return render(<ClaudeTurnTree turn={turn} />).container
}
