// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Fragment } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The Harness views below resolve the package build, so the Kit is taken from the
// same graph: a deep `src` import would give the test a second, unrelated context.
import {
  I18nProvider, groupThreadExecutionRows, threadExecutionRunIds, type ThreadDetailRow
} from '@openagent/plugin-kit/renderer'
import type { AgentThreadRecord } from '@openagent/contracts'
import { createCodexPreview } from '../playgrounds/thread-detail/src/native-fixtures/codex'
import { createClaudePreview } from '../playgrounds/thread-detail/src/native-fixtures/claude'
import { CodexThreadView } from '../../../packages/harness-codex/src/renderer/ThreadView'
import { ClaudeThreadView } from '../../../packages/harness-claude/src/renderer/ThreadView'

let frameId = 0
const frames = new Map<number, FrameRequestCallback>()
beforeEach(() => {
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function flushFrames(): void {
  for (let pass = 0; frames.size && pass < 50; pass += 1) {
    act(() => {
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach(callback => callback(performance.now()))
    })
  }
}
function work(id: string, text = id): ThreadDetailRow {
  return { id, kind: 'work', node: <p>{text}</p> }
}
function content(rows: readonly ThreadDetailRow[], locale: 'en-US' | 'zh-CN' = 'en-US') {
  const runs = threadExecutionRunIds(rows, row => row.kind === 'work')
  return <I18nProvider locale={locale}>{groupThreadExecutionRows(rows, runs).map(row =>
    <Fragment key={row.id}>{row.node}</Fragment>
  )}</I18nProvider>
}

describe('mixed execution disclosure', () => {
  it('has one collapsed entry even for a singleton, and preserves state while streaming', () => {
    const view = render(content([work('r1')]))
    const summary = screen.getByRole('button', { name: 'Execution process' })
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('r1')).toBeNull()
    fireEvent.click(summary)
    summary.focus()
    expect(screen.getByText('r1')).toBeVisible()
    view.rerender(content([work('r1', 'updated reasoning'), work('a1'), work('r2')]))
    flushFrames()
    expect(screen.getByRole('button', { name: 'Execution process' })).toBe(summary)
    expect(summary).toHaveAttribute('aria-expanded', 'true')
    expect(summary).toHaveFocus()
    expect([...view.container.querySelectorAll('[data-thread-row-id]')].map(node => node.getAttribute('data-thread-row-id')))
      .toEqual(['r1', 'a1', 'r2'])
    expect(screen.getByText('updated reasoning')).toBeVisible()
    fireEvent.click(summary)
    view.rerender(content([work('r1'), work('a1'), work('r2'), work('a2')]))
    flushFrames()
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(view.container.querySelectorAll('[data-thread-row-id]')).toHaveLength(0)
  })

  it('retains bounded materialization and the caller-owned order', () => {
    const rows = Array.from({ length: 200 }, (_, i) => work(`row-${i}`))
    const view = render(content(rows))
    expect(view.container.querySelectorAll('[data-thread-row-id]')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Execution process' }))
    expect(view.container.querySelectorAll('[data-thread-row-id]')).toHaveLength(3)
    flushFrames()
    expect([...view.container.querySelectorAll('[data-thread-row-id]')].map(node => node.getAttribute('data-thread-row-id')))
      .toEqual(rows.map(row => row.id))
  })

  it('keeps prose, requests and errors outside the disclosure', () => {
    const rows: ThreadDetailRow[] = [
      work('r1'),
      { id: 'answer', kind: 'content', node: <p>Answer</p> },
      work('a1'),
      { id: 'request', kind: 'attention', node: <button>Approve</button> },
      work('r2'),
      { id: 'error', kind: 'attention', node: <p role="alert">Failure</p> }
    ]
    const view = render(content(rows))
    expect(screen.getAllByRole('button', { name: 'Execution process' })).toHaveLength(3)
    expect(screen.getByText('Answer')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Approve' }).closest('.thread-execution-process')).toBeNull()
    expect(screen.getByRole('alert').closest('.thread-execution-process')).toBeNull()
    expect(view.container.querySelectorAll('[data-thread-row-id]')).toHaveLength(0)
  })

  it('localizes the shared entry without replacing its owner', () => {
    const view = render(content([work('r1')]))
    const summary = screen.getByRole('button', { name: 'Execution process' })
    fireEvent.click(summary)
    view.rerender(content([work('r1')], 'zh-CN'))
    expect(screen.getByRole('button', { name: '执行过程' })).toBe(summary)
    expect(summary).toHaveAttribute('aria-expanded', 'true')
  })
})

for (const [harnessId, fixture, View] of [
  ['codex', createCodexPreview, CodexThreadView],
  ['claude', createClaudePreview, ClaudeThreadView]
] as const) {
  for (const source of harnessId === 'claude' ? ['timeline', 'unreferenced'] : ['timeline']) {
    it.each(['current', 'history'] as const)(`${harnessId} folds failed ${source} tools in %s reading`, (mode) => {
      const input = fixture({ threadId: 'failed-tool', phase: 'completed', history: true, answer: 'Final answer' })
      const state = JSON.parse(JSON.stringify(input.sessionState))
      state.turns = state.turns.slice(mode === 'history' ? -2 : -1)
      const turn = state.turns[0]
      const reference = turn.timeline.find((item: { kind: string }) => item.kind === 'activity')
      const original = harnessId === 'claude' ? reference.activity
        : turn.activities.find((item: { id: string }) => item.id === reference.activityId)
      const activity = { ...original, kind: 'command', label: 'Failed shell command', status: 'failed', detail: 'Command exited with code 1' }
      turn.activities = [activity]
      turn.timeline = turn.timeline.flatMap((item: { id: string; kind: string }) => item.kind !== 'activity'
        ? [item]
        : source === 'unreferenced' || item.id !== reference.id ? []
          : [harnessId === 'claude' ? { ...reference, activity } : { ...reference, activityId: activity.id }])
      const thread: AgentThreadRecord = {
        archived: false, id: 'failed-tool', harnessId, title: 'Failed tool', cwd: '/workspace', tags: [],
        settings: {}, revision: 1, createdAt: 1, updatedAt: 2, ...input, sessionState: state
      }
      const actions = { interrupt: vi.fn(), openFollowUp: vi.fn(), respond: vi.fn(), forkThread: vi.fn(), invokeHarnessExtension: vi.fn(), openExternal: vi.fn() }
      const view = render(<I18nProvider locale="en-US"><View thread={thread} actions={actions}
        readingTarget={{ requestId: mode, executionId: turn.executionId, mode }}
      /></I18nProvider>)
      const page = within(mode === 'history'
        ? view.container.querySelector<HTMLElement>('.thread-detail-subpage')! : view.container)
      expect(page.queryByText('Failed shell command')).toBeNull()
      fireEvent.click(page.getByRole('button', { name: 'Show work' }))
      expect(page.queryByText('Failed shell command')).toBeNull()
      for (const summary of page.getAllByRole('button', { name: 'Execution process' })) {
        expect(summary).toHaveAttribute('aria-expanded', 'false')
        fireEvent.click(summary)
      }
      flushFrames()
      const tool = page.getByRole('button', { name: /Failed shell command/ })
      expect(tool.closest('.thread-execution-process')).not.toBeNull()
      fireEvent.click(tool)
      expect(page.getByText('Command exited with code 1')).toBeVisible()
      fireEvent.click(page.getByRole('button', { name: 'Hide work' }))
      expect(page.queryByText('Failed shell command')).toBeNull()
      expect(page.queryByText('Command exited with code 1')).toBeNull()
    })
  }

  it.each(['current', 'history'] as const)(`${harnessId} merges visually adjacent native rows in %s reading`, async (mode) => {
    const input = fixture({ threadId: 'mixed', phase: mode === 'history' ? 'completed' : 'running', history: mode === 'history', answer: '' })
    const state = JSON.parse(JSON.stringify(input.sessionState))
    state.turns = state.turns.slice(mode === 'history' ? -2 : -1)
    const turn = state.turns[0]
    const reasoning = turn.timeline.find((item: { kind: string }) => item.kind === 'reasoning')
    const reference = turn.timeline.find((item: { kind: string }) => item.kind === 'activity')
    const user = turn.timeline.find((item: { kind: string }) => item.kind === 'user-message')
    expect(reasoning).toBeDefined()
    expect(reference).toBeDefined()
    expect(user).toBeDefined()
    const original = harnessId === 'claude' ? reference.activity
      : turn.activities.find((item: { id: string }) => item.id === reference.activityId)
    const activities = [1, 2].map(index => ({ ...original, id: `native-${index}`, status: 'completed' }))
    turn.activities = activities
    // Claude rejects a timeline whose timestamps move backwards, and the fixture's
    // own values cannot be reused across the rebuilt rows, so number them here.
    const base = Math.max(turn.createdAt, reasoning.createdAt, reference.createdAt, user.createdAt)
    turn.timeline = [
      { ...reasoning, id: 'r1', createdAt: base, content: 'Reasoning one' },
      harnessId === 'claude' ? { ...reference, id: 'a1', createdAt: base + 1, activity: activities[0] }
        : { ...reference, id: 'a1', createdAt: base + 1, activityId: activities[0].id },
      { ...reasoning, id: 'r2', createdAt: base + 2, content: 'Reasoning two' },
      harnessId === 'claude' ? { ...reference, id: 'a2', createdAt: base + 3, activity: activities[1] }
        : { ...reference, id: 'a2', createdAt: base + 3, activityId: activities[1].id }
    ]
    const thread: AgentThreadRecord = {
      archived: false, id: 'mixed', harnessId, title: 'Mixed', cwd: '/workspace', tags: [],
      settings: {}, revision: 1, createdAt: 1, updatedAt: 2, ...input
    }
    const actions = { interrupt: vi.fn(), openFollowUp: vi.fn(), respond: vi.fn(), forkThread: vi.fn(), invokeHarnessExtension: vi.fn(), openExternal: vi.fn() }
    const renderThread = () => <I18nProvider locale="en-US"><View
      thread={{ ...thread, sessionState: JSON.parse(JSON.stringify(state)) }} actions={actions}
      readingTarget={{ requestId: mode, executionId: turn.executionId, mode }}
    /></I18nProvider>
    const view = render(renderThread())
    const page = within(mode === 'history'
      ? view.container.querySelector<HTMLElement>('.thread-detail-subpage')! : view.container)
    const showWork = page.queryByRole('button', { name: 'Show work' })
    if (showWork) fireEvent.click(showWork)
    const summary = page.getByRole('button', { name: 'Execution process' })
    fireEvent.click(summary)
    flushFrames()
    summary.focus()
    const group = summary.closest('.thread-execution-process')!
    const expectMerged = () => {
      expect(page.getAllByRole('button', { name: 'Execution process' })).toHaveLength(1)
      expect(page.getByRole('button', { name: 'Execution process' })).toBe(summary)
      expect(summary).toHaveAttribute('aria-expanded', 'true')
      expect([...group.querySelectorAll('[data-thread-row-id]')].map(node => node.getAttribute('data-thread-row-id')))
        .toEqual(['r1', 'a1', 'r2', 'a2'])
    }
    expectMerged()
    // Empty assistant events arrive between streamed tools but show no prose.
    turn.timeline.splice(1, 0, { id: 'empty-assistant', kind: 'assistant', content: '  ', status: 'complete', createdAt: base + 1,
      ...(harnessId === 'codex' ? { itemId: 'empty-assistant' } : {}) })
    view.rerender(renderThread())
    flushFrames()
    expectMerged()
    expect(summary).toHaveFocus()
    // A displayed user message splits the group; hiding it joins the same work.
    turn.timeline.splice(1, 0, { ...user, id: 'user-boundary', createdAt: base + 1 })
    view.rerender(renderThread())
    flushFrames()
    expectMerged()
    fireEvent.click(page.getByRole('button', { name: 'Show user messages' }))
    expect(page.getAllByRole('button', { name: 'Execution process' })).toHaveLength(2)
    fireEvent.click(page.getByRole('button', { name: 'Hide user messages' }))
    flushFrames()
    expectMerged()
    // Internal prompts stay hidden regardless of the display switch.
    if (harnessId === 'claude') turn.internalPromptIndexes = [user.promptIndex]
    else turn.messages.find((message: { id: string }) => message.id === user.messageId).internal = true
    view.rerender(renderThread())
    fireEvent.click(page.getByRole('button', { name: 'Show user messages' }))
    flushFrames()
    expectMerged()
    // A real assistant paragraph remains outside and separates the disclosures.
    turn.timeline.find((item: { id: string }) => item.id === 'empty-assistant').content = 'Visible progress update'
    view.rerender(renderThread())
    expect(page.getAllByRole('button', { name: 'Execution process' })).toHaveLength(2)
    await waitFor(() => {
      flushFrames()
      expect(page.getByText('Visible progress update').closest('.thread-execution-process')).toBeNull()
    })
  })
}
