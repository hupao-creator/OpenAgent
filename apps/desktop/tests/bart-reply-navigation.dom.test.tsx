// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  I18nProvider, ThreadDetailFrame, ThreadDetailSurface, ThreadDetailTurn,
  type ThreadDetailRow
} from '@openagent/plugin-kit/renderer'
import { projectCodexBartPresentation, codexBartReplyAnchor } from '../../../packages/harness-codex/src/shared/bart-presentation'
import { projectClaudeBartPresentation, claudeBartReplyAnchor } from '../../../packages/harness-claude/src/shared/bart-presentation'
import { projectPiBartPresentation, piBartReplyAnchor } from '../../../packages/harness-pi/src/shared/bart-presentation'
import { CodexThreadView } from '../../../packages/harness-codex/src/renderer/ThreadView'
import { ClaudeThreadView } from '../../../packages/harness-claude/src/renderer/ThreadView'
import { PiThreadView } from '../../../packages/harness-pi/src/renderer/ThreadView'
import { createCodexPreview } from '../playgrounds/thread-detail/src/native-fixtures/codex'
import { createClaudePreview } from '../playgrounds/thread-detail/src/native-fixtures/claude'
import { BartThreadView } from '../src/renderer/src/components/BartThreadView'
import { Composer } from '../src/renderer/src/components/Composer'
import { AppI18nProvider } from '../src/renderer/src/i18n'
import type { AgentThreadRecord, BartThreadRecord } from '@openagent/contracts'
import type { HarnessRendererThreadActions, HarnessRendererThreadInput } from '@openagent/contracts/renderer'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const actions = {
  interrupt: vi.fn(async () => undefined),
  respond: vi.fn(async () => undefined),
  invokeHarnessExtension: async () => null,
  forkThread: async () => ({ threadId: 'fork' }),
  openExternal: async () => undefined,
  openFollowUp: vi.fn()
} satisfies HarnessRendererThreadActions

/** The Harness host receives Core's Thread union; a Bart Dock Thread is its `bart` variant. */
const asBart = (thread: AgentThreadRecord): BartThreadRecord => ({ ...thread, bart: true, transcript: [] })

function turn(id: string, rows: ThreadDetailRow[]): ReactNode {
  return <ThreadDetailTurn id={id} active={false} createdAt={1} updatedAt={2} status="Completed" rows={rows} />
}
const content = (id: string, text: string): ThreadDetailRow => ({ id, kind: 'content', node: <p>{text}</p> })

function surface(requestId: string, anchorId?: string, rowId?: string): React.JSX.Element {
  return <I18nProvider locale="en-US"><ThreadDetailFrame navigation={{ label: 'Overview', onBack: () => {} }}>
    <ThreadDetailSurface
      threadId="bart"
      title="Bart"
      running={false}
      rows={[
        {
          id: 'old-turn', createdAt: 1,
          subpage: { title: 'Earlier question', summary: 'Earlier answer' },
          node: turn('old-turn', [content('old-answer', 'Earlier answer')])
        },
        { id: 'new-turn', createdAt: 2, node: turn('new-turn', [content('new-answer', 'Latest answer')]) }
      ]}
      readingTarget={{ requestId, ...(anchorId === undefined ? {} : { anchorId }), ...(rowId === undefined ? {} : { rowId }) }}
    />
  </ThreadDetailFrame></I18nProvider>
}

/** jsdom reports every box as 0; the locate step measures, so the test supplies the boxes. */
function box(element: Element, top: number): void {
  element.getBoundingClientRect = () => ({ top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) })
}

describe('locate the message a reply target points at', () => {
  it('scrolls the anchor to the top of the reading area, focuses it once, and ignores missing anchors', () => {
    const view = render(surface('idle'))
    const scroll = view.container.querySelector('.thread-detail-parent-page .message-scroll')!
    const anchor = view.container.querySelector('[data-thread-row-id="new-answer"]')!
    box(scroll, 100)
    box(anchor, 900)
    scroll.scrollTop = 0
    view.rerender(surface('locate', 'new-answer'))
    expect(scroll.scrollTop).toBe(784)
    expect(document.activeElement).toBe(view.container.querySelector('.thread-detail-parent-page'))

    // Streaming relayout and refreshes must not move the reader a second time.
    box(anchor, 1_400)
    scroll.scrollTop = 784
    view.rerender(surface('locate', 'new-answer'))
    expect(scroll.scrollTop).toBe(784)

    // An anchor that no longer resolves degrades to the turn without stealing focus.
    view.rerender(surface('stale', 'deleted-answer'))
    expect(scroll.scrollTop).toBe(784)
    expect(document.activeElement).toBe(view.container.querySelector('.thread-detail-parent-page'))
  })

  it('retries the hand-over until the camera stops holding the surface inert', async () => {
    // jsdom does not honour `inert`, so the refusal the camera causes is modelled
    // by refusing focus from inside an inert ancestor.
    const original = HTMLElement.prototype.focus
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, ...args) {
      if (this.closest('[inert]') === null) original.call(this, ...args)
    })
    const view = render(surface('idle'))
    const frame = view.container.querySelector('.thread-detail-frame')!
    frame.setAttribute('inert', '')
    act(() => view.rerender(surface('locate', 'new-answer')))
    const page = view.container.querySelector('.thread-detail-parent-page')
    expect(document.activeElement).not.toBe(page)

    frame.removeAttribute('inert')
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    expect(document.activeElement).toBe(page)
  })

  it('locates inside the opened history page instead of the parent document', () => {
    // Opening a history page remounts its subtree, so the measurement is stubbed on
    // the prototype instead of on nodes that the next render replaces.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const top = this.matches('[data-thread-row-id]') ? 500 : 100
      return { top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) }
    })
    const view = render(surface('idle'))
    view.rerender(surface('open-history', 'old-answer', 'old-turn'))
    const subpage = view.container.querySelector('.thread-detail-subpage')!
    expect(subpage.querySelector('[data-thread-row-id="old-answer"]')).not.toBeNull()
    act(() => view.rerender(surface('locate-history', 'old-answer', 'old-turn')))
    const scroll = view.container.querySelector('.thread-detail-subpage .message-scroll')!
    expect(scroll.scrollTop).toBe(384)
    expect(document.activeElement).not.toBe(view.container.querySelector('.thread-detail-parent-page'))
  })

  it('keeps an ordinary open unchanged when no anchor is carried', () => {
    const view = render(surface('ordinary'))
    expect(view.container.querySelector('.thread-detail-subpage')).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })
})

const codexThread = (answer: string, history: boolean): AgentThreadRecord => {
  const input = createCodexPreview({ threadId: 'nav-codex', phase: 'completed', history, answer })
  return {
    archived: false, id: 'nav-codex', harnessId: 'codex', title: 'Navigation', cwd: '/workspace',
    tags: [], settings: {}, revision: 1, createdAt: 1, updatedAt: 2, ...input
  }
}

const claudeThread = (answer: string, history: boolean): AgentThreadRecord => {
  const input = createClaudePreview({ threadId: 'nav-claude', phase: 'completed', history, answer })
  return {
    archived: false, id: 'nav-claude', harnessId: 'claude', title: 'Navigation', cwd: '/workspace',
    tags: [], settings: {}, revision: 1, createdAt: 1, updatedAt: 2, ...input
  }
}

const piThread = (): AgentThreadRecord => ({
  archived: false, id: 'nav-pi', harnessId: 'pi', title: 'Navigation', cwd: '/workspace',
  tags: [], settings: {}, revision: 1, createdAt: 1, updatedAt: 4,
  observation: { latestExecution: { executionId: 'new', status: 'completed', startedAt: 3, finishedAt: 4 }, backgroundWork: null },
  sessionState: {
    version: 1,
    executions: [
      { executionId: 'old', status: 'completed', startedAt: 1, finishedAt: 2 },
      { executionId: 'new', status: 'completed', startedAt: 3, finishedAt: 4 }
    ],
    latestExecutionId: 'new',
    messages: [
      { id: 'u', executionId: 'old', role: 'user', text: 'Earlier question' },
      { id: 'a-old', executionId: 'old', role: 'assistant', text: 'Earlier answer' },
      { id: 'u-new', executionId: 'new', role: 'user', text: 'Latest question' },
      { id: 'a-new', executionId: 'new', role: 'assistant', text: 'Latest answer' }
    ]
  }
})

describe('each Harness resolves its own opaque target to a rendered row', () => {
  it('locates the Codex native assistant item', () => {
    const thread = codexThread('Latest answer', false)
    const state = thread.sessionState as never
    const reply = projectCodexBartPresentation(state).reply!
    const anchor = codexBartReplyAnchor(state, reply.target)
    expect(anchor).toBeTruthy()
    const view = render(<AppI18nProvider locale="zh-CN"><CodexThreadView actions={actions} thread={thread}
      readingTarget={{ requestId: 'codex-reply', executionId: reply.executionId, mode: 'current', message: reply.target }} /></AppI18nProvider>)
    expect(view.container.querySelector(`[data-thread-row-id="${anchor}"]`)).not.toBeNull()
    expect(document.activeElement).toBe(view.container.querySelector('.thread-detail-parent-page'))
  })

  it('locates the rendered segment of a multi-segment Claude answer', () => {
    const thread = claudeThread('Latest answer', false)
    const state = JSON.parse(JSON.stringify(thread.sessionState))
    const turn = state.turns.at(-1)
    // One native assistant message emitted as two segments around an interruption,
    // as Claude does when a tool call splits its prose.
    const at = turn.createdAt
    turn.timeline = [
      { id: `${turn.executionId}:prompt`, kind: 'user-message', promptIndex: 0, createdAt: at },
      { id: 'seg-1', kind: 'assistant', messageId: 'native-1', content: 'First half. ', status: 'complete', createdAt: at + 1_000 },
      { id: 'seg-reasoning', kind: 'reasoning', content: 'Thinking between halves.', createdAt: at + 2_000 },
      { id: 'seg-2', kind: 'assistant', messageId: 'native-1', content: 'Second half.', status: 'complete', createdAt: at + 3_000 }
    ]
    turn.text = 'First half. Second half.'
    const reply = projectClaudeBartPresentation(state).reply!
    expect(reply.excerpt).toBe('First half. Second half.')
    expect(reply.target).toEqual({ executionId: turn.executionId, messageId: 'native-1' })
    // Only the last segment is a rendered answer row: earlier ones sit behind the work disclosure.
    const anchor = claudeBartReplyAnchor(state, reply.target)
    expect(anchor).toBe('seg-2')
    const view = render(<AppI18nProvider locale="zh-CN"><ClaudeThreadView actions={actions}
      thread={{ ...thread, sessionState: state }}
      readingTarget={{ requestId: 'claude-reply', executionId: reply.executionId, mode: 'current', message: reply.target }} /></AppI18nProvider>)
    expect(view.container.querySelector('[data-thread-row-id="seg-2"]')).not.toBeNull()
    expect(view.container.querySelector('[data-thread-row-id="seg-1"]')).toBeNull()
    expect(document.activeElement).toBe(view.container.querySelector('.thread-detail-parent-page'))
  })

  it('locates the Pi native assistant message', () => {
    const thread = piThread()
    const state = thread.sessionState as never
    const reply = projectPiBartPresentation(state).reply!
    expect(reply.target).toEqual({ executionId: 'new', messageId: 'a-new' })
    expect(piBartReplyAnchor(state, reply.target)).toBe('a-new')
    const view = render(<AppI18nProvider locale="zh-CN"><PiThreadView actions={actions} thread={asBart(thread)}
      readingTarget={{ requestId: 'pi-reply', executionId: reply.executionId, mode: 'current', message: reply.target }} /></AppI18nProvider>)
    expect(view.container.querySelector('[data-thread-row-id="a-new"]')).not.toBeNull()
    expect(document.activeElement).toBe(view.container.querySelector('.thread-detail-parent-page'))
  })

  it('reaches past a completed Pi turn with no answer to the earlier unread one', () => {
    const thread = piThread()
    const state = JSON.parse(JSON.stringify(thread.sessionState))
    // The newer execution settled without an assistant row of its own.
    state.messages = state.messages.filter((message: { id: string }) => message.id !== 'a-new')
    expect(projectPiBartPresentation(state).reply).toMatchObject({ executionId: 'old' })
  })

  it('keeps a stale, foreign or malformed target from moving the reader', () => {
    const thread = codexThread('Latest answer', false)
    const state = thread.sessionState as never
    expect(codexBartReplyAnchor(state, { executionId: 'gone', itemId: 'x' })).toBeUndefined()
    expect(codexBartReplyAnchor(state, { executionId: 'execution-0', itemId: 'missing' })).toBeUndefined()
    expect(codexBartReplyAnchor(state, 'not-a-target')).toBeUndefined()
    expect(codexBartReplyAnchor(state, undefined)).toBeUndefined()
    const claude = claudeThread('Latest answer', false).sessionState as never
    expect(claudeBartReplyAnchor(claude, { executionId: 'gone', messageId: 'x' })).toBeUndefined()
    const pi = piThread().sessionState as never
    expect(piBartReplyAnchor(pi, { executionId: 'gone', messageId: 'a-new' })).toBeUndefined()
    expect(piBartReplyAnchor(pi, { executionId: 'new', messageId: 'u-new' })).toBeUndefined()
  })
})

describe('Core passes the carried target through the Bart shell', () => {
  function shell(readingTarget?: HarnessRendererThreadInput['readingTarget']) {
    const thread = codexThread('Latest answer', false)
    const reply = projectCodexBartPresentation(thread.sessionState as never).reply!
    const anchor = codexBartReplyAnchor(thread.sessionState as never, reply.target)!
    const view = render(<AppI18nProvider locale="zh-CN"><BartThreadView
      attachments={[]}
      clearing={false}
      error=""
      execution={null}
      inputValue=""
      onBack={vi.fn()}
      onCancel={async () => undefined}
      onChooseFiles={vi.fn()}
      onClear={vi.fn()}
      onInputChange={vi.fn()}
      onPasteFiles={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onSettings={vi.fn()}
      onSubmit={vi.fn()}
      readingTarget={readingTarget}
      respond={vi.fn(async () => undefined)}
      submitting={false}
      thread={asBart(thread)}
    /></AppI18nProvider>)
    return { view, anchor, reply }
  }

  it('hands the Harness target to the harness host unchanged', () => {
    const { view, anchor } = shell(undefined)
    expect(view.container.querySelector(`[data-thread-row-id="${anchor}"]`)).not.toBeNull()
  })

  it('leaves the composer its entry focus on a plain open', () => {
    const { view } = shell(undefined)
    expect(document.activeElement).toBe(view.container.querySelector('.composer textarea'))
  })

  it('gives the located message the focus instead of the composer', () => {
    const thread = codexThread('Latest answer', false)
    const reply = projectCodexBartPresentation(thread.sessionState as never).reply!
    const { view, anchor } = shell(
      { requestId: 'shell', executionId: reply.executionId, mode: 'current', message: reply.target }
    )
    const row = view.container.querySelector(`[data-thread-row-id="${anchor}"]`)
    expect(row).not.toBeNull()
    // The reading area, not the composer, owns focus so the message is not scrolled away by it.
    expect(document.activeElement).not.toBe(view.container.querySelector('.composer textarea'))
    expect(document.activeElement).toBe(view.container.querySelector('.thread-detail-parent-page'))
    expect(document.activeElement === row || document.activeElement?.contains(row!)).toBe(true)
  })

  it('still hands the composer focus when a later request asks for it', () => {
    const composer = (focusRequestKey: number, suppressInitialFocus: boolean) =>
      <AppI18nProvider locale="zh-CN"><Composer
        value=""
        focusRequestKey={focusRequestKey}
        suppressInitialFocus={suppressInitialFocus}
        provider="codex"
        running={false}
        bartAttachments={[]}
        onChange={vi.fn()}
        onChooseFiles={vi.fn()}
        onRemoveBartAttachment={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
      /></AppI18nProvider>
    const view = render(composer(0, true))
    expect(document.activeElement).not.toBe(view.container.querySelector('textarea'))
    // Suppression only covers the entry focus; a follow-up request re-focuses.
    view.rerender(composer(1, true))
    expect(document.activeElement).toBe(view.container.querySelector('textarea'))
  })
})
