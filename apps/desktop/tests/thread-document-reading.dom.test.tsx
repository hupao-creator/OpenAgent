// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { memo } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  I18nProvider, ThreadDetailFrame, ThreadDetailSurface, ThreadDetailTurn,
  ThreadTokenUsage, threadDocumentSummary, type ThreadDocumentRow
} from '@openagent/plugin-kit/renderer'
import { createCodexPreview } from '../playgrounds/thread-detail/src/native-fixtures/codex'
import { createClaudePreview } from '../playgrounds/thread-detail/src/native-fixtures/claude'
import { CodexThreadView } from '../../../packages/harness-codex/src/renderer/ThreadView'
import { ClaudeThreadView } from '../../../packages/harness-claude/src/renderer/ThreadView'
import { BartThreadView } from '../src/renderer/src/components/BartThreadView'
import { AppI18nProvider } from '../src/renderer/src/i18n'
import { AgentThreadWorkspace } from '../src/renderer/src/components/AgentThreadWorkspace'
import type { AgentThreadRecord } from '@openagent/contracts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Adjacent work is merged into a folded 执行过程 entry; the reader has to open it. */
function openExecutionProcesses(scope: HTMLElement): void {
  for (const summary of scope.querySelectorAll<HTMLElement>(
    'button[aria-label="执行过程"][aria-expanded="false"]'
  )) fireEvent.click(summary)
}

function expandHistory(): void {
  fireEvent.click(screen.getByRole('button', { name: /previous turns?|前 \d+ 轮对话/, expanded: false }))
}

function rows(count: number): ThreadDocumentRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`, createdAt: index,
    subpage: index < count - 1 ? { title: `Question ${index}`, summary: `Answer ${index}`, completedAt: 1788832871000 } : undefined,
    node: <ThreadDetailTurn id={`turn-${index}`} active={false} createdAt={index} updatedAt={index + 1} status="Completed" rows={[
      { id: 'prompt', kind: 'user', node: <p>Full prompt {index}</p> },
      { id: 'work', kind: 'work', node: <pre>Complete code {index}</pre> },
      { id: 'answer', kind: 'content', node: <p>Full answer {index}</p> }
    ]} />
  }))
}
function doc(count: number, threadId = 'first', back = vi.fn()) {
  return <I18nProvider locale="en-US"><ThreadDetailFrame navigation={{ label: 'Overview', onBack: back }}>
    <ThreadDetailSurface threadId={threadId} title="Document" running={false} rows={rows(count)} />
  </ThreadDetailFrame></I18nProvider>
}

describe('document navigation', () => {
  it('opens exact complete content, returns scroll/focus, and forgets pages across threads', () => {
    const back = vi.fn()
    const view = render(doc(5, 'first', back))
    expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(0)
    expect(screen.getByText('Full answer 4')).toBeVisible()
    expect(view.container.querySelectorAll('hr')).toHaveLength(0)
    expandHistory()
    expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(4)
    expect(view.container.querySelectorAll('.thread-detail-turn')).toHaveLength(1)
    expect(view.container.querySelectorAll('hr')).toHaveLength(1)
    const scroll = view.container.querySelector('.message-scroll')!
    scroll.scrollTop = 123
    const opener = screen.getByRole('button', { name: /Question 2/ })
    fireEvent.click(opener)
    const page = view.container.querySelector('.thread-detail-subpage') as HTMLElement
    expect(within(page).queryByText('Full prompt 2')).toBeNull()
    expect(within(page).queryByText('Complete code 2')).toBeNull()
    fireEvent.click(within(page).getByRole('button', { name: 'Show user messages' }))
    fireEvent.click(within(page).getByRole('button', { name: 'Show work' }))
    expect(within(page).getByText('Full prompt 2')).toBeVisible()
    expect(within(page).getByText('Complete code 2')).toBeVisible()
    expect(within(page).getByText('Full answer 2')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Document' })).toHaveFocus()
    scroll.scrollTop = 7 // Simulate layout/scroll anchoring while the parent is hidden.
    fireEvent.keyDown(page, { key: 'Escape' })
    expect(scroll.scrollTop).toBe(123)
    expect(opener).toHaveFocus()
    fireEvent.click(opener)
    fireEvent.click(screen.getByRole('button', { name: 'Document' }))
    expect(opener).toHaveFocus()
    fireEvent.click(opener)
    view.rerender(doc(5, 'second', back))
    expect(view.container.querySelector('.thread-detail-subpage')).toBeNull()
    expect(screen.getByRole('button', { name: '4 previous turns' })).toHaveAttribute('aria-expanded', 'false')
    expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
    expect(back).toHaveBeenCalledOnce()
  })

  it.each([false, true])('isolates independent history toggles from parent visibility=%s and resets every visit', (parentVisible) => {
    const view = render(doc(5))
    expandHistory()
    if (parentVisible) {
      fireEvent.click(screen.getByRole('button', { name: 'Show user messages' }))
      fireEvent.click(screen.getByRole('button', { name: 'Show work' }))
    }
    for (const index of [1, 1, 2]) {
      const opener = screen.getByRole('button', { name: new RegExp(`Question ${index}`) })
      fireEvent.click(opener)
      const page = within(view.container.querySelector('.thread-detail-subpage') as HTMLElement)
      const check = (user: boolean, work: boolean) => {
        expect(page.getByRole('button', { name: user ? 'Hide user messages' : 'Show user messages' })).toHaveAttribute('aria-pressed', String(user))
        expect(page.getByRole('button', { name: work ? 'Hide work' : 'Show work' })).toHaveAttribute('aria-pressed', String(work))
        expect(Boolean(page.queryByText(`Full prompt ${index}`))).toBe(user)
        expect(Boolean(page.queryByText(`Complete code ${index}`))).toBe(work)
        expect(page.getByText(`Full answer ${index}`)).toBeVisible()
      }
      check(false, false)
      fireEvent.click(page.getByRole('button', { name: 'Show work' }))
      check(false, true)
      fireEvent.click(page.getByRole('button', { name: 'Show user messages' }))
      check(true, true)
      fireEvent.click(page.getByRole('button', { name: 'Hide work' }))
      check(true, false)
      fireEvent.click(page.getByRole('button', { name: 'Hide user messages' }))
      check(false, false)
      fireEvent.click(page.getByRole('button', { name: 'Show work' }))
      fireEvent.click(page.getByRole('button', { name: 'Show user messages' }))
      fireEvent.click(page.getByRole('button', { name: 'Document' }))
      expect(opener).toHaveFocus()
      expect(screen.getByRole('button', { name: parentVisible ? 'Hide user messages' : 'Show user messages' })).toHaveAttribute('aria-pressed', String(parentVisible))
      expect(screen.getByRole('button', { name: parentVisible ? 'Hide work' : 'Show work' })).toHaveAttribute('aria-pressed', String(parentVisible))
      expect(Boolean(screen.queryByText('Full prompt 4'))).toBe(parentVisible)
      expect(Boolean(screen.queryByText('Complete code 4'))).toBe(parentVisible)
    }
  })

  it('retains history choices during publications and resets on new navigation requests or Threads', () => {
    const content = (requestId: string, rowId = 'turn-1', threadId = 'requested') => <I18nProvider locale="en-US">
      <ThreadDetailSurface threadId={threadId} title="Requested" rows={rows(5)} running runningTurnId="turn-4" readingTarget={{ requestId, rowId }} />
    </I18nProvider>
    const view = render(content('first'))
    const page = () => within(view.container.querySelector('.thread-detail-subpage') as HTMLElement)
    expect(page().getByRole('button', { name: 'Show work' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(page().getByRole('button', { name: 'Show work' }))
    fireEvent.click(page().getByRole('button', { name: 'Show user messages' }))
    view.rerender(content('first'))
    expect(page().getByRole('button', { name: 'Hide work' })).toHaveAttribute('aria-pressed', 'true')
    expect(page().getByRole('button', { name: 'Hide user messages' })).toHaveAttribute('aria-pressed', 'true')
    for (const [request, row, thread] of [['second', 'turn-1', 'requested'], ['third', 'turn-2', 'requested'], ['third', 'turn-2', 'another']]) {
      view.rerender(content(request!, row!, thread!))
      expect(page().getByRole('button', { name: 'Show work' })).toHaveAttribute('aria-pressed', 'false')
      expect(page().getByRole('button', { name: 'Show user messages' })).toHaveAttribute('aria-pressed', 'false')
      fireEvent.click(page().getByRole('button', { name: 'Show work' }))
      fireEvent.click(page().getByRole('button', { name: 'Show user messages' }))
    }
  })

  it('retains windowing, loaded history and reading position across entry/return and new turns', () => {
    const view = render(doc(160))
    expect(screen.queryByRole('button', { name: /Show .* older messages/ })).toBeNull()
    expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(0)
    expandHistory()
    expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(119)
    fireEvent.click(screen.getByRole('button', { name: /Show .* older messages/ }))
    expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(159)
    const opener = screen.getByRole('button', { name: /Question 0 / })
    fireEvent.click(opener)
    view.rerender(doc(161))
    expect(view.container.querySelector('.thread-detail-subpage')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Document' }))
    expect(opener).toHaveFocus()
    expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(160)
    expect(screen.getByText('Full answer 160')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '160 previous turns' }))
    expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(0)
    expandHistory()
    expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(160)
  })

  it('returns an explicitly located history page to the collapsed latest document', () => {
    const view = render(<I18nProvider locale="en-US">
      <ThreadDetailSurface threadId="linked" title="Linked" rows={rows(5)} running={false}
        readingTarget={{ requestId: 'report', rowId: 'turn-1' }} />
    </I18nProvider>)
    expect(within(view.container.querySelector('.thread-detail-subpage') as HTMLElement).getByText('Full answer 1')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Linked' }))
    expect(view.container.querySelector('.thread-detail-subpage')).toBeNull()
    expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(0)
    expect(screen.getByRole('button', { name: '4 previous turns' })).toHaveFocus()
    expect(screen.getByText('Full answer 4')).toBeVisible()
  })

  it('offers the new live turn after returning from history without stealing the saved position', () => {
    const content = (count: number, runningTurnId?: string) => <I18nProvider locale="en-US">
      <ThreadDetailSurface threadId="live" title="Live" rows={rows(count)} running={Boolean(runningTurnId)} runningTurnId={runningTurnId} />
    </I18nProvider>
    const view = render(content(5))
    expandHistory()
    const scroll = view.container.querySelector('.thread-detail-parent-page .message-scroll')!
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 500 })
    scroll.scrollTop = 123
    fireEvent.click(screen.getByRole('button', { name: /Question 2/ }))
    view.rerender(content(6, 'turn-5'))
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 2000 })
    fireEvent.click(screen.getByRole('button', { name: 'Live' }))
    expect(scroll.scrollTop).toBe(123)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(scroll.scrollTop).toBe(2000)
    expect(screen.getByRole('button', { name: '5 previous turns' })).toHaveAttribute('aria-expanded', 'false')
    expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(0)
  })

  it.each([500, 1200])('keeps expanded history paused after return at initial height %i', (initialHeight) => {
    const notifications: Array<() => void> = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notifications.push(callback) }
      observe() {}
      disconnect() {}
    })
    const view = render(<I18nProvider locale="en-US">
      <ThreadDetailSurface threadId="stream" title="Stream" rows={rows(5)} running runningTurnId="turn-4" />
    </I18nProvider>)
    expandHistory()
    const scroll = view.container.querySelector('.thread-detail-parent-page .message-scroll')!
    let height = initialHeight
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => height })
    scroll.scrollTop = 0
    fireEvent.scroll(scroll)
    fireEvent.click(screen.getByRole('button', { name: /Question 2/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Stream' }))
    expect(scroll.scrollTop).toBe(0)
    height = 2000
    act(() => notifications.at(-1)!())
    expect(scroll.scrollTop).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(scroll.scrollTop).toBe(2000)
    expect(screen.getByRole('button', { name: '4 previous turns' })).toHaveAttribute('aria-expanded', 'false')
    height = 2400
    act(() => notifications.at(-1)!())
    expect(scroll.scrollTop).toBe(2400)
  })

  it('renders summary content only in the loaded window and retains mounted summaries during streaming', () => {
    const seen: string[] = []
    const Summary = memo(function Summary({ id }: { id: string }) { seen.push(id); return <>Summary {id}</> })
    const content = (answer: string) => <I18nProvider locale="en-US"><ThreadDetailSurface threadId="window" title="Window" running rows={
      Array.from({ length: 1000 }, (_, index) => ({
        id: `row-${index}`, createdAt: index,
        subpage: index < 999 ? { title: `Title ${index}`, summary: <Summary id={`row-${index}`} /> } : undefined,
        node: <p>{answer}</p>
      }))
    } /></I18nProvider>
    const view = render(content('First token'))
    expect(seen).toHaveLength(0)
    expandHistory()
    expect(seen).toHaveLength(119)
    expect(seen[0]).toBe('row-880')
    view.rerender(content('First token and more streamed text'))
    expect(seen).toHaveLength(119)
    fireEvent.click(view.container.querySelector('.load-older-messages')!)
    expect(seen).toHaveLength(219)
    expect(seen).toContain('row-780')
    view.rerender(content('Another streamed token'))
    expect(seen).toHaveLength(219)
  })

  it.each([0, 1])('has no orphan divider for %i turns', (count) => {
    const view = render(doc(count))
    expect(view.container.querySelector('hr')).toBeNull()
    expect(view.container.querySelector('.thread-detail-subpage-link')).toBeNull()
    expect(screen.queryByRole('button', { name: /previous turns/ })).toBeNull()
  })

  it('converts Markdown to readable text without changing full content', () => {
    expect(threadDocumentSummary('## Hello **world**\n\n[site](https://example.org) ![diagram](image.png)\n\n```ts\nconst a = 1\n```\n\n<script>bad()</script>')).toBe('Hello world site diagram const a = 1')
  })

  it('bounds long summaries while preserving the entire historical answer', () => {
    const answer = 'A long paragraph. '.repeat(10000) + 'END OF COMPLETE ANSWER'
    const summary = threadDocumentSummary(answer)
    expect(summary.length).toBeLessThan(2000)
    const view = render(<ThreadDetailSurface threadId="long" title="Long" running={false} rows={[
      { id: 'old', createdAt: 1, subpage: { title: 'Long question', summary }, node: <article>{answer}</article> },
      { id: 'new', createdAt: 2, node: <p>Latest</p> }
    ]} />)
    expandHistory()
    fireEvent.click(screen.getByRole('button', { name: /Long question/ }))
    expect(view.container.querySelector('.thread-detail-subpage article')?.textContent).toBe(answer)
  })

  it('keeps the single overview breadcrumb when a Harness renderer fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onBack = vi.fn()
    const thread: AgentThreadRecord = { archived: false, id: 'broken', harnessId: 'codex', title: 'Broken document', cwd: '/workspace', tags: [], settings: {}, revision: 1, createdAt: 1, updatedAt: 2, sessionState: {}, observation: { latestExecution: null, backgroundWork: null } }
    render(<I18nProvider locale="en-US"><AgentThreadWorkspace
      thread={thread} onBack={onBack} interrupt={async () => undefined} respond={async () => undefined} onFollowUp={() => undefined}
    /></I18nProvider>)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getAllByRole('navigation', { name: 'Page path' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('requires both known counts and renders usage without adding subsets', () => {
    const view = render(<I18nProvider locale="en-US"><ThreadTokenUsage input={100} output={20} cached={40} reasoning={5} /></I18nProvider>)
    expect(screen.getByText('120 tokens')).toHaveAttribute('title', 'Input: 100 · Output: 20 · Cache read: 40 · Reasoning: 5')
    view.rerender(<ThreadTokenUsage input={100} />)
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(<ThreadTokenUsage input={0} output={0} />)
    expect(screen.getByText('0 tokens')).toBeInTheDocument()
  })
})

const adapters = [
  ['codex', createCodexPreview, CodexThreadView],
  ['claude', createClaudePreview, ClaudeThreadView]
] as const
const actions = { interrupt: vi.fn(async () => undefined), respond: vi.fn(async () => undefined), invokeHarnessExtension: async () => null, forkThread: async () => ({ threadId: 'fork' }), openExternal: async () => undefined, openFollowUp: vi.fn() }

describe('shared history controls in Agent and Bart shells', () => {
  for (const harnessId of ['codex', 'claude', 'pi'] as const) {
    it.each(['agent', 'bart'] as const)(`${harnessId} %s keeps historical categories independent`, async (shell) => {
      const fixture = adapters.find(([id]) => id === harnessId)?.[1]
      const input: Pick<AgentThreadRecord, 'observation' | 'sessionState'> = fixture ? fixture({ threadId: 'shell', phase: 'completed', history: true, answer: 'Latest answer' }) : {
        observation: { latestExecution: { executionId: 'new', status: 'completed' as const, startedAt: 3, finishedAt: 4 }, backgroundWork: null },
        sessionState: { version: 1, executions: [
          { executionId: 'old', status: 'completed', startedAt: 1, finishedAt: 2 },
          { executionId: 'new', status: 'completed', startedAt: 3, finishedAt: 4 }
        ], latestExecutionId: 'new', messages: [
          { id: 'u', executionId: 'old', role: 'user', text: 'Earlier **question**' },
          { id: 'w', executionId: 'old', role: 'tool', text: 'Plugin output', toolName: 'Read file' },
          { id: 'a', executionId: 'old', role: 'assistant', text: 'Earlier **answer**', thinking: 'Historical **reasoning**' },
          { id: 'n', executionId: 'new', role: 'assistant', text: 'Latest answer', thinking: 'Current reasoning' }
        ] }
      }
      const thread: AgentThreadRecord = { archived: false, id: 'shell', harnessId, title: 'Shell document', cwd: '/workspace', tags: [], settings: {}, revision: 1, createdAt: 1, updatedAt: 4, ...input }
      const view = render(<AppI18nProvider locale="zh-CN">{shell === 'agent'
        ? <AgentThreadWorkspace thread={thread} onBack={vi.fn()} interrupt={actions.interrupt} respond={actions.respond} onFollowUp={vi.fn()} />
        : <BartThreadView thread={{ ...thread, bart: true, transcript: [] }} attachments={[]} clearing={false} error="" execution={null} inputValue="" submitting={false}
          onBack={vi.fn()} onCancel={actions.interrupt} onChooseFiles={vi.fn()} onClear={vi.fn()} onInputChange={vi.fn()} onPasteFiles={vi.fn()} onRemoveAttachment={vi.fn()} onSettings={vi.fn()} onSubmit={vi.fn()} respond={actions.respond} />
      }</AppI18nProvider>)
      // Native thinking is work, never part of the answer: hidden until work is shown.
      if (harnessId === 'pi') {
        expect(screen.queryByText('思考过程')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: '显示执行过程' }))
        openExecutionProcesses(view.container)
        expect(screen.getByText('思考过程')).toBeVisible()
        fireEvent.click(screen.getByRole('button', { name: '收起执行过程' }))
        expect(screen.queryByText('思考过程')).toBeNull()
      }
      expandHistory()
      fireEvent.click(view.container.querySelector('.thread-detail-subpage-link')!)
      const element = view.container.querySelector('.thread-detail-subpage') as HTMLElement
      const page = within(element)
      expect(page.getByRole('button', { name: '显示用户消息' })).toHaveAttribute('aria-pressed', 'false')
      expect(page.getByRole('button', { name: '显示执行过程' })).toHaveAttribute('aria-pressed', 'false')
      expect(element.querySelector('.thread-detail-user')).toBeNull()
      expect(element.querySelector('.thread-detail-work')).toBeNull()
      if (harnessId === 'pi') expect(page.queryByText('思考过程')).toBeNull()
      const answerText = () => Array.from(element.querySelectorAll('.thread-detail-content')).map(node => node.textContent).join('')
      await waitFor(() => expect(answerText()).toBeTruthy())
      const answer = answerText()
      fireEvent.click(page.getByRole('button', { name: '显示用户消息' }))
      expect(element.querySelector('.thread-detail-user')).toBeVisible()
      expect(element.querySelector('.thread-detail-work')).toBeNull()
      fireEvent.click(page.getByRole('button', { name: '显示执行过程' }))
      expect(element.querySelector('.thread-detail-work')).toBeVisible()
      if (harnessId === 'pi') {
        openExecutionProcesses(element)
        fireEvent.click(page.getByText('思考过程'))
        expect(await page.findByText('reasoning')).toBeVisible()
        fireEvent.click(page.getByRole('button', { name: '收起执行过程' }))
        expect(page.queryByText('思考过程')).toBeNull()
        expect(page.queryByText('reasoning')).toBeNull()
        fireEvent.click(page.getByRole('button', { name: '显示执行过程' }))
      }
      expect(page.getByRole('button', { name: '隐藏用户消息' })).toHaveAttribute('aria-pressed', 'true')
      expect(page.getByRole('button', { name: '收起执行过程' })).toHaveAttribute('aria-pressed', 'true')
      await waitFor(() => expect(answerText()).toBe(answer))
    })
  }
})

for (const [harnessId, fixture, View] of adapters) {
  describe(`${harnessId} document projection`, () => {
    it('opens an exact report Execution, retains it across new work, and reports missing history', () => {
      const input = fixture({ threadId: 'report', phase: 'completed', history: false, localFive: true, answer: '' })
      const state = JSON.parse(JSON.stringify(input.sessionState))
      const executionId = state.turns[1].executionId
      const thread: AgentThreadRecord = { archived: false, id: 'report', harnessId, title: 'Report target', cwd: '/workspace', tags: [], settings: {}, revision: 1, createdAt: 1, updatedAt: 2, ...input, sessionState: state }
      const back = vi.fn()
      const content = (requestId: string, target = executionId) => <I18nProvider locale="en-US"><ThreadDetailFrame navigation={{ label: 'Overview', onBack: back }}>
        <View thread={{ ...thread, sessionState: JSON.parse(JSON.stringify(state)) }} actions={actions} readingTarget={{ requestId, executionId: target, mode: 'history' }} />
      </ThreadDetailFrame></I18nProvider>
      const view = render(content('open-old'))
      const expectedRow = executionId
      expect(view.container.querySelector('.thread-detail-subpage [data-turn-id]')).toHaveAttribute('data-turn-id', expectedRow)
      expect(view.container.querySelector('.thread-detail-subpage [data-timeline-focus] button:not([disabled])')).toBeNull()
      const next = structuredClone(state.turns.at(-1))
      next.executionId = 'new-execution'
      state.turns.push(next)
      view.rerender(content('open-old'))
      expect(view.container.querySelector('.thread-detail-subpage [data-turn-id]')).toHaveAttribute('data-turn-id', expectedRow)
      // Removing the bound history cannot silently send the reader to the latest turn.
      state.turns.splice(1, 1)
      view.rerender(content('open-old'))
      expect(screen.getByRole('alert')).toHaveTextContent('The historical execution linked by this report could not be found.')
      fireEvent.click(screen.getByRole('button', { name: 'Report target' }))
      expect(view.container.querySelector('.thread-detail-subpage')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
      expect(back).toHaveBeenCalledOnce()
      view.rerender(content('missing-target', 'missing-execution'))
      expect(screen.getByRole('alert')).toHaveTextContent('could not be found')
    })

    it('validates a current reference and keeps the click-time mode when the latest publication changes', () => {
      const input = fixture({ threadId: 'navigation-race', phase: 'completed', history: false, localFive: true, answer: '' })
      const state = JSON.parse(JSON.stringify(input.sessionState))
      const executionId = state.turns[0].executionId
      const thread: AgentThreadRecord = { archived: false, id: 'navigation-race', harnessId, title: 'Navigation race', cwd: '/workspace', tags: [], settings: {}, revision: 1, createdAt: 1, updatedAt: 2, ...input }
      const content = (mode: 'current' | 'history') => <I18nProvider locale="en-US"><View thread={{ ...thread, sessionState: JSON.parse(JSON.stringify(state)) }} actions={actions} readingTarget={{ requestId: mode, executionId, mode }} /></I18nProvider>
      // Host clicked the current Execution before the newer snapshot reached this renderer.
      const view = render(content('current'))
      expect(view.container.querySelector('.thread-detail-subpage')).toBeNull()
      view.rerender(content('history'))
      expect(view.container.querySelector('.thread-detail-subpage [data-turn-id]')).toHaveAttribute('data-turn-id', executionId)
      // A latest public observation is not proof that its native historical row still exists.
      const latestId = thread.observation.latestExecution!.executionId
      state.turns.pop()
      view.rerender(<I18nProvider locale="en-US"><View thread={{ ...thread, sessionState: state }} actions={actions} readingTarget={{ requestId: 'missing-current', executionId: latestId, mode: 'current' }} /></I18nProvider>)
      expect(screen.getByRole('alert')).toHaveTextContent('could not be found')
      expect(view.container.querySelector('.thread-detail-subpage [data-turn-id]')).toBeNull()
    })

    it('opens the latest report Execution normally and consumes each navigation request once', () => {
      const input = fixture({ threadId: 'latest-report', phase: 'completed', history: false, localFive: true, answer: '' })
      const state = JSON.parse(JSON.stringify(input.sessionState))
      const executionId = state.turns.at(-1).executionId
      const thread: AgentThreadRecord = { archived: false, id: 'latest-report', harnessId, title: 'Latest report', cwd: '/workspace', tags: [], settings: {}, revision: 1, createdAt: 1, updatedAt: 2, ...input }
      const content = (requestId: string) => <I18nProvider locale="en-US"><View thread={{ ...thread, sessionState: JSON.parse(JSON.stringify(state)) }} actions={actions} readingTarget={{ requestId, executionId, mode: 'current' }} /></I18nProvider>
      const view = render(content('latest'))
      expect(view.container.querySelector('.thread-detail-subpage')).toBeNull()
      expandHistory()
      fireEvent.click(view.container.querySelector('.thread-detail-subpage-link')!)
      const oldPage = view.container.querySelector('.thread-detail-subpage [data-turn-id]')!.getAttribute('data-turn-id')
      view.rerender(content('latest'))
      expect(view.container.querySelector('.thread-detail-subpage [data-turn-id]')).toHaveAttribute('data-turn-id', oldPage)
      view.rerender(content('reopen-latest'))
      expect(view.container.querySelector('.thread-detail-subpage')).toBeNull()
    })

    it('bounds a very long entry title but keeps the selected heading and breadcrumb title complete', () => {
      const input = fixture({ threadId: 'large-prompt', phase: 'completed', history: false, localFive: true, answer: '' })
      const state = JSON.parse(JSON.stringify(input.sessionState))
      const prompt = 'Long question '.repeat(50000) + 'EXACT END'
      if (harnessId === 'claude') state.turns[0].prompts[0] = prompt
      else state.turns[0].messages.find((message: { role: string }) => message.role === 'user').content = prompt
      const thread: AgentThreadRecord = { archived: false, id: 'large-prompt', harnessId, title: 'Long prompt', cwd: '/workspace', tags: [], settings: {}, revision: 1, createdAt: 1, updatedAt: 2, ...input, sessionState: state }
      const view = render(<I18nProvider locale="en-US"><View thread={thread} actions={actions} /></I18nProvider>)
      expandHistory()
      const entry = view.container.querySelector('.thread-detail-subpage-link')!
      expect(entry.querySelector('.thread-detail-subpage-title')!.textContent!.length).toBeLessThan(300)
      expect(entry.getAttribute('title')!.length).toBeLessThan(300)
      fireEvent.click(entry)
      const child = view.container.querySelector('.thread-detail-subpage')!
      expect(child.querySelector('h2')!.textContent).toBe(prompt)
      expect(child.querySelector('.thread-detail-breadcrumb-current')!.getAttribute('title')).toBe(prompt)
    })

    it('renders the recorded five-turn fixture without invented usage', () => {
      const input = fixture({ threadId: 'recorded', phase: 'completed', history: false, localFive: true, answer: '' })
      const thread: AgentThreadRecord = { archived: false, id: 'recorded', harnessId, title: 'Recorded', cwd: '/workspace', tags: [], settings: {}, revision: 1, createdAt: 1, updatedAt: 2, ...input }
      const view = render(<I18nProvider locale="en-US"><View thread={thread} actions={actions} /></I18nProvider>)
      expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(0)
      expandHistory()
      expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(4)
      expect(view.container.querySelector('.thread-detail-token-usage')).toBeNull()
    })

    it('uses the native usage and distinguishes absent from zero', () => {
      const input = fixture({ threadId: 'usage', phase: 'completed', history: false, answer: 'Usage answer' })
      const state = JSON.parse(JSON.stringify(input.sessionState))
      state.turns[0].usage = harnessId === 'codex'
        ? { inputTokens: 40, outputTokens: 20, cachedInputTokens: 10, reasoningTokens: 7 }
        : { inputTokens: 40, outputTokens: 20, cachedTokens: 10, cacheWriteTokens: 5, reasoningTokens: 7 }
      const thread: AgentThreadRecord = { archived: false, id: 'usage', harnessId, title: 'Usage', cwd: '/workspace', tags: [], settings: {}, revision: 1, createdAt: 1, updatedAt: 2, ...input, sessionState: state }
      const content = () => <I18nProvider locale="en-US"><View thread={{ ...thread, sessionState: JSON.parse(JSON.stringify(state)) }} actions={actions} /></I18nProvider>
      const view = render(content())
      const expected = harnessId === 'codex' ? '60 tokens' : harnessId === 'claude' ? '75 tokens' : '82 tokens'
      expect(view.container.querySelector('.thread-detail-turn-footer > .thread-detail-token-usage')).toHaveTextContent(expected)
      delete state.turns[0].usage.outputTokens
      view.rerender(content())
      expect(view.container.querySelector('.thread-detail-turn-footer > .thread-detail-token-usage')).toBeNull()
    })

    it.each(['running', 'approval', 'question', 'failed', 'interrupted', 'background'] as const)('keeps %s current state outside history', (phase) => {
      const input = fixture({ threadId: 'active', phase, history: true, answer: 'Live answer' })
      const state = JSON.parse(JSON.stringify(input.sessionState))
      state.turns = state.turns.slice(-5)
      const thread: AgentThreadRecord = { archived: false, id: 'active', harnessId, title: 'Live document', cwd: '/workspace', tags: [], settings: {}, revision: 1, createdAt: 1, updatedAt: 2, ...input, sessionState: state }
      const view = render(<I18nProvider locale="en-US"><View thread={thread} actions={actions} /></I18nProvider>)
      expandHistory()
      expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(4)
      expect(view.container.querySelectorAll('.thread-detail-turn')).toHaveLength(1)
      if (phase === 'approval' || phase === 'question') expect(view.container.querySelector('[data-timeline-focus]')).not.toBeNull()
      if (phase === 'failed' || phase === 'interrupted') expect(view.container.querySelector('.thread-detail-turn-footer .thread-detail-completed-time')).toBeNull()
      const entry = view.container.querySelector('.thread-detail-subpage-link')!
      fireEvent.click(entry)
      const page = view.container.querySelector('.thread-detail-subpage')!
      expect(page.querySelector('[data-timeline-focus] button:not([disabled])')).toBeNull()
      expect(actions.respond).not.toHaveBeenCalled()
    })

    it('projects five turns and immutable completion time, opens Markdown and attachments', async () => {
      const input = fixture({ threadId: 'native', phase: 'completed', history: true, answer: 'Latest answer' })
      const state = JSON.parse(JSON.stringify(input.sessionState))
      state.turns = state.turns.slice(-5)
      const historical = state.turns[0]
      const finishedAt = historical.finishedAt
      historical.updatedAt = finishedAt + 500000
      if (state.updatedAt !== undefined) state.updatedAt = Math.max(state.updatedAt, historical.updatedAt)
      const thread: AgentThreadRecord = { archived: false, id: 'native', harnessId, title: 'Native document', cwd: '/workspace', tags: [], settings: {}, revision: 1, createdAt: 1, updatedAt: 2, ...input, sessionState: state }
      const view = render(<I18nProvider locale="en-US"><View thread={thread} actions={actions} /></I18nProvider>)
      expandHistory()
      const entries = view.container.querySelectorAll('.thread-detail-subpage-link')
      expect(entries).toHaveLength(4)
      expect(entries[0]!.querySelector('time')).toHaveAttribute('datetime', new Date(finishedAt).toISOString())
      fireEvent.click(entries[0]!)
      const page = view.container.querySelector('.thread-detail-subpage')!
      expect(page.querySelector('.user-message')).toBeNull()
      fireEvent.click(within(page as HTMLElement).getByRole('button', { name: 'Show user messages' }))
      fireEvent.click(within(page as HTMLElement).getByRole('button', { name: 'Show work' }))
      expect(page.querySelector('.user-message')).not.toBeNull()
      expect(page.querySelector('.message-attachment')).not.toBeNull()
      expect(page.querySelector('.thread-detail-turn')).not.toBeNull()
      expect(actions.respond).not.toHaveBeenCalled()
    })
  })
}
