// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentThreadRecord } from '@openagent/contracts'
import type { RendererReport } from '../src/shared/renderer-state-contracts'
import { createOpenAgentState, isAgentThreadRecord, reduceOpenAgentState, type OpenAgentState } from '../src/shared/openagent-state'
import { createDefaultOpenAgentSettings } from '../src/shared/openagent-settings'
import { ConversationOverview } from '../src/renderer/src/components/ConversationOverview'
import {
  bartGenerationThreadTarget
} from '../src/renderer/src/components/BartThreadGeneration'
import {
  deriveOverviewItems,
  overviewLayoutSnapshot
} from '../src/renderer/src/conversation-overview-layout'
import { getBartSpatialRegistry } from '../src/renderer/src/bart-motion/registry'
import { AppI18nProvider as I18nProvider } from '../src/renderer/src/i18n'
import {
  getOverviewCameraCockpit,
  settleOverviewResize,
  stageOverviewLayoutMotion
} from '../src/renderer/src/overview-motion'
import type {
  HarnessOverviewThread,
  HarnessOverviewThreadInput
} from '@openagent/contracts/renderer'

import { fakeSnapshots, withPreviewMessage, withPreviewTokenUsage } from '../playgrounds/single-thread/src/fake-snapshots'
import { OVERVIEW_LAYOUT_PLANNER } from '../src/renderer/src/overview-layout-planner'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Harness Plugin overview Core seam', () => {
  it('isolates clock, buffer and usage updates from other cards and the layout planner', async () => {
    vi.useFakeTimers()
    const captured = fakeSnapshots.find(scene => scene.harness === 'claude' && scene.scenario === 'running')!.state.threads[0] as AgentThreadRecord
    const first = { ...captured, id: 'live-a', createdAt: 1, updatedAt: 1 }
    const second = { ...captured, id: 'live-b', createdAt: 2, updatedAt: 2 }
    const report: RendererReport = { id: 'stable-report', title: 'Report', previewText: 'Summary', tags: [],
      archived: false, createdAt: 3, updatedAt: 3,
      relatedExecutions: [{ threadId: first.id, executionId: 'older-execution' }] }
    const onRender = vi.fn()
    const onCardRender = vi.fn()
    const plan = vi.fn(OVERVIEW_LAYOUT_PLANNER.plan)
    const common = { embedded: true, interrupt: async () => {}, respond: async () => {}, onSelect: () => {},
      onFollowUpOpen: vi.fn(), onRender, onCardRender, transitionId: null, reports: [report],
      layoutPlanner: { ...OVERVIEW_LAYOUT_PLANNER, plan } }
    const other = { thread: second }
    const view = render(<ConversationOverview {...common} threads={[{ thread: first }, other]} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    onRender.mockClear(); onCardRender.mockClear(); plan.mockClear()
    // The one-second clock remains inside its own leaf.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(onRender).not.toHaveBeenCalled()
    expect(onCardRender).not.toHaveBeenCalled()
    const updated = withPreviewTokenUsage(first, 100)
    view.rerender(<ConversationOverview {...common} threads={[{ thread: updated }, other]} />)
    expect(onCardRender.mock.calls.map(([id]) => id)).toEqual(['live-a'])
    expect(plan).not.toHaveBeenCalled()
    const buffered = withPreviewMessage(updated, 'a'.repeat(1200) + 'tail', 1)
    view.rerender(<ConversationOverview {...common} threads={[{ thread: buffered }, other]} />)
    onRender.mockClear(); onCardRender.mockClear()
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(document.querySelector('[data-thread-id="live-a"] .thread-card-excerpt-text')?.textContent).toBe('tail')
    expect(onRender).not.toHaveBeenCalled()
    expect(onCardRender).not.toHaveBeenCalled()
    expect(plan).not.toHaveBeenCalled()
    // Semantic relation changes must still refresh the Report.
    view.rerender(<ConversationOverview {...common} threads={[{ thread: { ...buffered, title: 'Renamed' } }, other]} />)
    expect(onCardRender.mock.calls.map(([id]) => id)).toEqual(['live-a', 'stable-report'])
    expect(screen.getByRole('button', { name: '打开关联 Thread：Renamed' })).toBeVisible()
  })

  it('localizes Core overview actions and the single thread open layer in en-US', () => {
    render(
      <I18nProvider locale="en-US">
        <ConversationOverview
          embedded
          interrupt={async () => undefined}
          onRestartDevelopment={() => undefined}
          onSelect={() => undefined}
          respond={async () => undefined}
          threads={[threadInput('thread-a')]}
          transitionId={null}
        />
      </I18nProvider>
    )

    expect(screen.getByRole('button', { name: 'Restart Dev Electron' })).toBeVisible()
    expect(screen.getByRole('button', {
      name: 'Open Thread thread-a, item 1 of 1'
    })).toBeVisible()
  })

  it.each([false, true])('omits the Agent archive action when archived=%s', (archived) => {
    render(<I18nProvider locale="en-US">
      <ConversationOverview embedded threads={[threadInput('thread-a', { archived })]}
        view={archived ? 'archived' : 'default'} onSetThreadArchived={() => {}}
        interrupt={async () => {}} respond={async () => {}} onSelect={() => {}} transitionId={null} />
    </I18nProvider>)
    expect(screen.queryByRole('button', { name: `${archived ? 'Unarchive' : 'Archive'}: Thread thread-a` })).toBeNull()
  })

  it('keeps one Core motion anchor while the Plugin owns all card content and actions', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onFollowUpOpen = vi.fn()
    const interrupt = vi.fn(async () => {})
    const source = threadInput('thread-a', {
      observation: {
        latestExecution: {
          executionId: 'execution-a',
          status: 'running',
          startedAt: 10
        },
        backgroundWork: null
      }
    })

    render(
      <ConversationOverview
        embedded
        interrupt={interrupt}
        onFollowUpOpen={onFollowUpOpen}
        onSelect={onSelect}
        respond={async () => {}}
        threads={[source]}
        transitionId={null}
      />
    )

    const anchors = document.querySelectorAll('[data-overview-card-id="thread-a"]')
    expect(anchors).toHaveLength(1)
    const shell = anchors[0] as HTMLElement
    expect(getBartSpatialRegistry().threadCardElement('thread-a')).toBe(shell)

    await user.click(within(shell).getByRole('button', { name: /打开 Thread thread-a/ }))
    expect(onSelect).toHaveBeenCalledWith('thread-a')

    const followUp = within(shell).getByRole('button', { name: '发送消息' })
    expect(followUp).toHaveAttribute('title', '发送消息')
    expect(followUp).toHaveTextContent('')
    expect(followUp.children).toHaveLength(1)
    expect(followUp.firstElementChild).toHaveClass('lucide-send')
    await user.click(followUp)
    expect(onFollowUpOpen).toHaveBeenLastCalledWith('thread-a')
    await user.keyboard('{Enter} ')
    expect(onFollowUpOpen).toHaveBeenCalledTimes(3)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('derives the card attention status from the public waiting observation', () => {
    const source: HarnessOverviewThreadInput = {
      thread: agentThread('thread-waiting', {
        observation: {
          latestExecution: {
            executionId: 'execution-waiting',
            status: 'waiting-for-user',
            startedAt: 10,
            interactions: [{
              id: 'interaction-1',
              kind: 'question',
              title: 'Question',
              actions: [{ id: 'submit', intent: 'submit', label: 'Submit' }],
              questions: []
            }]
          },
          backgroundWork: null
        }
      })
    }

    render(
      <ConversationOverview
        embedded
        interrupt={async () => {}}
        onSelect={() => {}}
        respond={async () => {}}
        threads={[source]}
        transitionId={null}
      />
    )

    expect(document.querySelector('[data-overview-card-id="thread-waiting"]'))
      .toHaveAttribute('data-thread-status', 'attention')
  })

  it('opens every expanded report association with its exact execution, and marks deleted targets unavailable', async () => {
    const user = userEvent.setup()
    const onOpenRelatedExecution = vi.fn()
    const report: RendererReport = {
      id: 'report-links', title: 'Report links', tags: [], createdAt: 2, updatedAt: 3,
      archived: false, previewText: 'Report',
      relatedExecutions: ['one', 'two', 'three', 'deleted'].map(id => ({ threadId: id, executionId: `execution-${id}` }))
    }
    render(<ConversationOverview embedded threads={[]} reports={[report]}
      reportRelationThreads={['one', 'two', 'three'].map(id => threadInput(id))}
      onOpenRelatedExecution={onOpenRelatedExecution} interrupt={async () => {}}
      respond={async () => {}} onSelect={() => {}} transitionId={null} />)
    expect(screen.queryByRole('button', { name: '打开关联 Thread：Thread three' })).toBeNull()
    const toggle = screen.getByRole('button', { name: '查看全部 4 个关联' })
    const region = screen.getByRole('region', { name: '关联的 Agent Thread' })
    expect(within(region).getAllByRole('button')).toHaveLength(2)
    expect(toggle).toHaveAttribute('aria-controls', region.id)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(region).getAllByRole('button')).toHaveLength(4)
    await user.click(screen.getByRole('button', { name: '打开关联 Thread：Thread three' }))
    expect(onOpenRelatedExecution).toHaveBeenCalledWith('three', 'execution-three')
    expect(screen.getByRole('button', { name: /已删除的 Agent Thread/ })).toBeDisabled()
    expect(screen.getByText('已删除')).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: '查看全部 4 个关联' })).toHaveFocus()
    expect(screen.getByRole('button', { name: '查看全部 4 个关联' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: '打开关联 Thread：Thread three' })).toBeNull()
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: '收起关联' }))
    expect(within(region).getAllByRole('button')).toHaveLength(2)
  })


  it('localizes report links and retains reading without an archive entry', async () => {
    const user = userEvent.setup()
    const onOpenReport = vi.fn()
    const onSetReportArchived = vi.fn()
    const report: RendererReport = {
      id: 'english-report', title: 'Long report title', tags: [], createdAt: 2, updatedAt: 3,
      archived: false, previewText: 'The original report summary',
      relatedExecutions: ['one', 'two', 'three'].map(id => ({ threadId: id, executionId: `execution-${id}` }))
    }
    const common = { embedded: true, threads: [], interrupt: async () => {}, respond: async () => {},
      onSelect: () => {}, transitionId: null, onOpenReport, onSetReportArchived }
    const view = render(<I18nProvider locale="en-US"><ConversationOverview {...common} reports={[report]} /></I18nProvider>)
    expect(screen.getByText('The original report summary')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'View all 3 links' }))
    await user.click(screen.getByRole('button', { name: 'Collapse links' }))
    expect(screen.queryByRole('button', { name: 'Archive report: Long report title' })).toBeNull()
    expect(onSetReportArchived).not.toHaveBeenCalled()
    expect(onOpenReport).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Long report title.*report/i }))
    expect(onOpenReport).toHaveBeenCalledWith('english-report')
    view.rerender(<I18nProvider locale="en-US"><ConversationOverview {...common} reports={[{ ...report, relatedExecutions: [] }]} /></I18nProvider>)
    expect(screen.queryByRole('button', { name: /View all|Collapse links/ })).toBeNull()
    expect(screen.getByText('The original report summary')).toBeVisible()
  })

  it('updates Default and Archived cards and counts together from a committed latest-only Report archive', async () => {
    const initial = createOpenAgentState({ bartThreadId: 'bart', hostHarnessId: 'codex', bartThreadSettings: {},
      bartCwd: '/bart', createdAt: 1, selectedThreadId: null, settings: createDefaultOpenAgentSettings() })
    const latest = (id: string, executionId: string) => agentThread(id, { observation: {
      latestExecution: { executionId, status: 'completed', startedAt: 1, finishedAt: 2 }, backgroundWork: null
    } })
    let state: OpenAgentState = { ...initial, threads: [...initial.threads, latest('current', 'E1'), latest('historical', 'E2')], reports: [{
      id: 'report-archive', title: 'Delivery', html: '<p>Retained</p>', tags: [], createdAt: 1, updatedAt: 2, archived: false,
      relatedExecutions: ['current', 'historical'].map(threadId => ({ threadId, executionId: 'E1' }))
    }] }
    const common = { embedded: true, onSelect: () => {}, interrupt: async () => {}, respond: async () => {}, transitionId: null }
    const onArchive = vi.fn()
    const props = () => ({ threads: state.threads.filter(isAgentThreadRecord).map(thread => ({ thread })),
      reports: state.reports.map(report => ({ ...report, previewText: 'Retained' })) })
    const ui = (view: 'default' | 'archived') => <ConversationOverview {...common} {...props()} view={view}
      onViewChange={() => {}} onSetReportArchived={onArchive} />
    const rendered = render(ui('default'))
    expect(document.querySelector('[data-overview-card-id="current"]')).toBeNull()
    expect(document.querySelector('[data-overview-card-id="historical"]')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已归档，共 0 张卡片' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '归档报告：Delivery' })).toBeNull()
    // Pending/rejected requests do not optimistically uncover the covered Agent.
    expect(screen.getByText('Retained')).toBeVisible()
    expect(document.querySelector('[data-overview-card-id="current"]')).toBeNull()
    state = reduceOpenAgentState(state, { type: 'archive-report', reportId: 'report-archive', relatedThreadIds: ['current', 'historical'] })
    rendered.rerender(ui('default'))
    expect(screen.queryByText('Retained')).toBeNull()
    expect(document.querySelector('[data-overview-card-id="current"]')).toBeNull()
    expect(document.querySelector('[data-overview-card-id="historical"]')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已归档，共 1 张卡片' })).toBeVisible()
    rendered.rerender(ui('archived'))
    expect(screen.getByText('Retained')).toBeVisible()
    expect(document.querySelector('[data-overview-card-id="current"]')).toBeNull()
    expect(document.querySelector('[data-overview-card-id="historical"]')).toBeNull()
    expect(screen.getByRole('button', { name: '已归档，共 1 张卡片' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('leaves expanded relation scrolling and scrollbar gestures to the browser in canvas mode', async () => {
    for (const [property, dimension] of [['clientWidth', 400], ['clientHeight', 400], ['offsetWidth', 800], ['offsetHeight', 1600]] as const) {
      vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains(property.startsWith('client') ? 'thread-overview-scroll' : 'thread-overview-grid') ||
          (!property.startsWith('client') && this.hasAttribute('data-overview-card-id')) ? dimension : 0
      })
    }
    const user = userEvent.setup()
    const report: RendererReport = {
      id: 'many-links', title: 'Many links', tags: [], createdAt: 1, updatedAt: 2, archived: false, previewText: '',
      relatedExecutions: Array.from({ length: 12 }, (_, index) => ({ threadId: `thread-${index}`, executionId: `e-${index}` }))
    }
    render(<ConversationOverview threads={[]} reports={[report]} initialLayoutContext={{ availableCols: 1 }}
      reportRelationThreads={report.relatedExecutions.map(link => threadInput(link.threadId))}
      interrupt={async () => {}} respond={async () => {}} onSelect={() => {}} transitionId={null} />)
    await user.click(screen.getByRole('button', { name: '查看全部 12 个关联' }))
    const camera = getOverviewCameraCockpit()
    expect(camera.live).not.toBeNull()
    const before = { ...camera.live!.transform }
    const relations = screen.getByRole('region', { name: '关联的 Agent Thread' })
    const innerWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })
    act(() => { relations.querySelector('li')!.dispatchEvent(innerWheel) })
    expect(innerWheel.defaultPrevented).toBe(false)
    expect(camera.live!.transform).toEqual(before)

    const scroll = document.querySelector<HTMLElement>('.thread-overview-scroll')!
    const capture = vi.fn()
    scroll.setPointerCapture = capture
    const scrollbarDown = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    act(() => { relations.dispatchEvent(scrollbarDown) })
    expect(scrollbarDown.defaultPrevented).toBe(false)
    expect(capture).not.toHaveBeenCalled()

    const outerWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: 200, clientY: 200 })
    act(() => { scroll.dispatchEvent(outerWheel) })
    expect(outerWheel.defaultPrevented).toBe(true)
    expect(camera.live!.transform.scale).toBeGreaterThan(before.scale)
    const panDown = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    act(() => { scroll.dispatchEvent(panDown) })
    expect(panDown.defaultPrevented).toBe(true)
    expect(capture).toHaveBeenCalledOnce()
  })

  it('omits archived send and archive actions while retaining the active send entry', () => {
    const common = { embedded: true, interrupt: async () => {}, respond: async () => {},
      onSelect: () => {}, transitionId: null, onSetThreadArchived: vi.fn(), onFollowUpOpen: vi.fn() }
    const view = render(<ConversationOverview {...common} threads={[threadInput('thread-a')]} />)
    expect(screen.getByRole('button', { name: '发送消息' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '归档：Thread thread-a' })).toBeNull()
    view.rerender(<ConversationOverview {...common} view="archived" threads={[threadInput('thread-a', { archived: true })]} />)
    expect(screen.queryByRole('button', { name: '发送消息' })).toBeNull()
    expect(screen.queryByRole('button', { name: '取消归档：Thread thread-a' })).toBeNull()
  })

  it('keeps only the Archived view action and toggles it back to default', async () => {
    const user = userEvent.setup()
    const onViewChange = vi.fn()
    const onSettings = vi.fn()
    const common = {
      embedded: true,
      interrupt: async () => {},
      onSelect: () => {},
      onSettings,
      onViewChange,
      reports: [],
      respond: async () => {},
      transitionId: null
    }
    const failedObservation = {
      latestExecution: {
        executionId: 'execution-failed',
        status: 'failed' as const,
        startedAt: 10,
        finishedAt: 20
      },
      backgroundWork: null
    }
    const threads = [
      threadInput('default-thread'),
      threadInput('interrupted-thread', {
        observation: {
          latestExecution: {
            executionId: 'execution-interrupted',
            status: 'interrupted' as const,
            startedAt: 10,
            finishedAt: 20
          },
          backgroundWork: null
        }
      }),
      // Core auto-archived this Thread when its latest Execution failed.
      threadInput('failed-thread', { observation: failedObservation, archived: true }),
      // Explicitly restored after that failure: still failed, still in Default.
      threadInput('restored-failed-thread', { observation: failedObservation }),
      threadInput('archived-thread', { archived: true })
    ]
    const { rerender } = render(
      <ConversationOverview {...common} threads={threads} view="default" />
    )

    expect(screen.queryByRole('button', { name: /默认/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /失败/ })).toBeNull()
    expect(screen.getByRole('button', { name: '已归档，共 2 张卡片' }))
      .toHaveAttribute('aria-pressed', 'false')
    const settings = screen.getByRole('button', { name: '设置' })
    expect(settings).toBeVisible()
    await user.click(settings)
    expect(onSettings).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-overview-card-id="default-thread"]')).toBeInTheDocument()
    expect(document.querySelector('[data-overview-card-id="interrupted-thread"]')).toBeInTheDocument()
    expect(document.querySelector('[data-overview-card-id="failed-thread"]')).toBeNull()
    expect(document.querySelector('[data-overview-card-id="restored-failed-thread"]')).toBeInTheDocument()
    expect(document.querySelector('[data-overview-card-id="archived-thread"]')).toBeNull()

    const archived = screen.getByRole('button', { name: '已归档，共 2 张卡片' })
    await user.click(archived)
    expect(onViewChange).toHaveBeenLastCalledWith('archived')
    rerender(<ConversationOverview {...common} threads={threads} view="archived" />)
    expect(archived).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelector('[data-overview-card-id="failed-thread"]')).toBeInTheDocument()
    expect(document.querySelector('[data-overview-card-id="archived-thread"]')).toBeInTheDocument()
    expect(document.querySelector('[data-overview-card-id="restored-failed-thread"]')).toBeNull()
    expect(document.querySelector('[data-overview-card-id="default-thread"]')).toBeNull()

    await user.click(archived)
    expect(onViewChange).toHaveBeenLastCalledWith('default')
    rerender(<ConversationOverview {...common} threads={threads} view="default" />)
    expect(archived).toHaveAttribute('aria-pressed', 'false')
    expect(document.querySelector('[data-overview-card-id="default-thread"]')).toBeInTheDocument()
  })

  it('keeps the archived filter switch visible in an empty Archived collection', () => {
    const onViewChange = vi.fn()
    render(<ConversationOverview threads={[]} reports={[]} view="archived" onViewChange={onViewChange}
      interrupt={async () => {}} respond={async () => {}} onSelect={() => {}} transitionId={null} />)
    expect(screen.getByText('没有已归档的 Thread')).toBeVisible()
    expect(screen.getByRole('button', { name: '已归档，共 0 张卡片' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: '默认，共 0 张卡片' })).toBeNull()
    expect(screen.queryByRole('button', { name: /失败/ })).toBeNull()
    expect(onViewChange).not.toHaveBeenCalled()
  })

  it('retains a clear-tag control when a selected tag has no candidates in this view', async () => {
    const user = userEvent.setup()
    const onTagChange = vi.fn()
    render(<ConversationOverview threads={[]} view="archived" selectedTag="project" tagFilters={[]}
      onTagChange={onTagChange} interrupt={async () => {}} respond={async () => {}}
      onSelect={() => {}} transitionId={null} />)
    expect(screen.getByText('没有 project 会话')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '全部' }))
    expect(onTagChange).toHaveBeenCalledWith('')
  })

  it('freezes only identity and structure in layout snapshots', () => {
    const thread = agentThread('thread-a', {
      sessionState: { privateMarker: 'must-not-enter-motion-fifo' }
    })
    const source: HarnessOverviewThread = {
      thread,
      envelope: {
        footprint: { columns: 2, rows: 2 },
        structureKey: 'codex:expanded',
        excerpt: 'latest semantic content'
      }
    }
    const report: RendererReport = {
      id: 'report-a',
      title: 'Latest report title',
      tags: [],
      createdAt: 2,
      updatedAt: 3,
      archived: false,
      previewText: 'report semantic content',
      relatedExecutions: [{ threadId: 'thread-a', executionId: 'execution-a' }]
    }
    const snapshot = overviewLayoutSnapshot(
      deriveOverviewItems({
        threads: [source],
        reports: [report],
        transitionId: null,
        layoutContext: { availableCols: 2 }
      })
    )

    expect(snapshot.items).toEqual([
      {
        kind: 'card',
        key: 'thread:thread-a',
        entityId: 'thread-a',
        cardIndex: 0,
        size: { cols: 2, rows: 2 },
        structureKey: 'codex:expanded'
      },
      {
        kind: 'report',
        key: 'report:report-a',
        entityId: 'report-a',
        cardIndex: 1,
        size: { cols: 1, rows: 1 }
      }
    ])
    expect(JSON.stringify(snapshot)).not.toContain('must-not-enter-motion-fifo')
    expect(JSON.stringify(snapshot)).not.toContain('latest semantic content')
    expect(JSON.stringify(snapshot)).not.toContain('report semantic content')
  })

  it('renders Report relations from Harness identity and the running Core fact only', () => {
    const report: RendererReport = {
      id: 'report-a',
      title: 'Report A',
      tags: [],
      createdAt: 2,
      updatedAt: 3,
      archived: false,
      previewText: 'Result',
      relatedExecutions: [{ threadId: 'thread-a', executionId: 'execution-a' }]
    }
    render(
      <ConversationOverview
        embedded
        interrupt={async () => {}}
        onSelect={() => {}}
        reportRelationThreads={[threadInput('thread-a')]}
        reports={[report]}
        respond={async () => {}}
        threads={[]}
        transitionId={null}
      />
    )

    const relation = document.querySelector<HTMLElement>('.report-overview-relations li')
    expect(relation).toHaveAttribute('data-status', 'idle')
    expect(relation).not.toHaveTextContent('Codex')
    expect(relation?.querySelector('.report-overview-relation-provider')).toHaveAttribute('title', 'Codex')
    expect(relation).not.toHaveTextContent('已完成')
    expect(relation?.querySelector('img')).toHaveAttribute('data-provider', 'codex')
  })

  it('keeps A → B → A as distinct structure signatures without freezing Plugin content', () => {
    const thread = agentThread('thread-a')
    const signature = (structureKey: string): string => overviewLayoutSnapshot(
      deriveOverviewItems({
        threads: [{
          thread,
          envelope: {
            footprint: { columns: 1, rows: 1 },
            structureKey,
            excerpt: `content-${structureKey}`
          }
        }],
        transitionId: null,
        layoutContext: { availableCols: 2 }
      })
    ).signature

    expect([signature('A'), signature('B'), signature('A')]).toEqual([
      expect.stringContaining('A'),
      expect.stringContaining('B'),
      expect.stringContaining('A')
    ])
    expect(signature('A')).not.toBe(signature('B'))
  })

  it('turns a same-footprint structure change into one existing resize beat', () => {
    const grid = document.createElement('div')
    const card = document.createElement('article')
    card.dataset.overviewCardId = 'thread-a'
    grid.append(card)
    const rect = { left: 10, top: 20, width: 360, height: 200 }

    const motions = stageOverviewLayoutMotion(
      grid,
      new Map([['thread-a', rect]]),
      new Map([['thread-a', rect]]),
      new Set(['thread-a'])
    )

    expect(motions).toHaveLength(1)
    expect(motions[0]).toMatchObject({
      id: 'thread-a',
      inserted: false,
      resizeDirection: 'shrink',
      moved: false
    })
    expect(card).toHaveAttribute('data-overview-motion-recomposing', 'true')
    settleOverviewResize(motions)
    expect(card).not.toHaveAttribute('data-overview-motion-recomposing')
  })

  it('builds the historical generation proxy from only Core facts and the overview envelope', () => {
    const target = bartGenerationThreadTarget({
      thread: agentThread('thread-a', {
        cwd: '/private/worktrees/thread-a',
        worktree: { baseCwd: '/Users/demo/OpenAgent', native: true }
      }),
      envelope: {
        footprint: { columns: 1, rows: 1 },
        structureKey: 'codex:base',
        excerpt: 'bounded Plugin excerpt'
      }
    })

    expect(target).toMatchObject({
      kind: 'thread',
      id: 'thread-a',
      harnessId: 'codex',
      running: false,
      worktree: true,
      cwdText: '…/demo/OpenAgent',
      bodyText: 'bounded Plugin excerpt'
    })
    expect(target).not.toHaveProperty('provider')
    expect(target).not.toHaveProperty('status')
    expect(target).not.toHaveProperty('modelText')
    expect(target).not.toHaveProperty('steerText')
  })

  it('honors every monotonic filter-focus request, including repeated Cmd/Ctrl+K requests', () => {
    const common = {
      embedded: true,
      interrupt: async (): Promise<void> => undefined,
      onSelect: (): void => undefined,
      respond: async (): Promise<void> => undefined,
      tagFilters: [{ tag: 'alpha', count: 1, isCwdTag: false }],
      threads: [threadInput('thread-a')],
      transitionId: null
    } as const
    const view = render(
      <>
        <input aria-label="outside focus target" />
        <ConversationOverview {...common} focusFilterRequestKey={0} />
      </>
    )
    const outside = screen.getByRole('textbox', { name: 'outside focus target' })
    const filter = document.querySelector<HTMLButtonElement>('.thread-tag-filter-option')
    expect(filter).not.toBeNull()

    outside.focus()
    view.rerender(
      <>
        <input aria-label="outside focus target" />
        <ConversationOverview {...common} focusFilterRequestKey={1} />
      </>
    )
    expect(filter).toHaveFocus()

    outside.focus()
    view.rerender(
      <>
        <input aria-label="outside focus target" />
        <ConversationOverview {...common} focusFilterRequestKey={2} />
      </>
    )
    expect(filter).toHaveFocus()
  })

  it('does not focus the filter on mount, and consumes a handled focus request', () => {
    const consumed = vi.fn()
    const common = {
      embedded: true,
      interrupt: async (): Promise<void> => undefined,
      onSelect: (): void => undefined,
      respond: async (): Promise<void> => undefined,
      tagFilters: [{ tag: 'alpha', count: 1, isCwdTag: false }],
      threads: [threadInput('thread-a')],
      transitionId: null
    } as const
    const view = render(
      <>
        <input aria-label="outside focus target" />
        <ConversationOverview {...common} focusFilterRequestKey={0} onFocusFilterRequestConsumed={consumed} />
      </>
    )
    const outside = screen.getByRole('textbox', { name: 'outside focus target' })
    const filter = document.querySelector<HTMLButtonElement>('.thread-tag-filter-option')
    expect(filter).not.toBeNull()

    outside.focus()
    expect(filter).not.toHaveFocus()
    expect(consumed).not.toHaveBeenCalled()

    view.rerender(
      <>
        <input aria-label="outside focus target" />
        <ConversationOverview {...common} focusFilterRequestKey={1} onFocusFilterRequestConsumed={consumed} />
      </>
    )
    expect(filter).toHaveFocus()
    expect(consumed).toHaveBeenCalledTimes(1)
  })

  it('drives the horizontally overflowed tag strip with a plain vertical wheel', () => {
    render(
      <ConversationOverview
        embedded
        interrupt={async (): Promise<void> => undefined}
        onSelect={(): void => undefined}
        respond={async (): Promise<void> => undefined}
        tagFilters={[{ tag: 'alpha', count: 1, isCwdTag: false }]}
        threads={[threadInput('thread-a')]}
        transitionId={null}
      />
    )
    const groups = document.querySelector<HTMLElement>('.thread-tag-filter-groups')
    expect(groups).not.toBeNull()
    if (!groups) return

    // jsdom 没有布局，溢出与滚动位置都得自己造。
    let scrolled = 0
    Object.defineProperty(groups, 'scrollWidth', { value: 400, configurable: true })
    Object.defineProperty(groups, 'clientWidth', { value: 200, configurable: true })
    Object.defineProperty(groups, 'scrollLeft', {
      get: () => scrolled,
      set: (value: number) => {
        scrolled = value
      },
      configurable: true
    })

    const overflowed = new WheelEvent('wheel', { deltaY: 60, cancelable: true, bubbles: true })
    groups.dispatchEvent(overflowed)
    expect(overflowed.defaultPrevented).toBe(true)
    expect(scrolled).toBe(60)

    // 没有溢出时不该吞掉滚轮，否则鼠标停在筛选栏上就滚不动俯瞰。
    Object.defineProperty(groups, 'scrollWidth', { value: 200, configurable: true })
    const idle = new WheelEvent('wheel', { deltaY: 60, cancelable: true, bubbles: true })
    groups.dispatchEvent(idle)
    expect(idle.defaultPrevented).toBe(false)
    expect(scrolled).toBe(60)
  })

  it('orders the header as toolbar then filter so tab order matches the narrow layout', () => {
    render(
      <ConversationOverview
        embedded
        interrupt={async (): Promise<void> => undefined}
        onSelect={(): void => undefined}
        respond={async (): Promise<void> => undefined}
        tagFilters={[{ tag: 'alpha', count: 1, isCwdTag: false }]}
        threads={[threadInput('thread-a')]}
        transitionId={null}
      />
    )
    const header = document.querySelector('.thread-overview-header')
    expect(header).not.toBeNull()
    expect(header?.children[0]?.className).toContain('thread-overview-floating-chrome')
    expect(header?.children[1]?.className).toContain('thread-tag-filter-bar')
  })

  it('consumes a delete placeholder once its one-shot layout has been presented', async () => {
    const consumed = vi.fn()
    const common = {
      embedded: true,
      interrupt: async (): Promise<void> => undefined,
      onDeletePlaceholdersConsumed: consumed,
      onSelect: (): void => undefined,
      respond: async (): Promise<void> => undefined,
      transitionId: null
    } as const
    const view = render(
      <ConversationOverview
        {...common}
        threads={[threadInput('thread-a'), threadInput('thread-b')]}
      />
    )

    view.rerender(
      <ConversationOverview
        {...common}
        deletedIndexes={{ 'thread-a': 0 }}
        operations={[{
          id: 'delete-a',
          kind: 'delete',
          phase: 'completed',
          threadId: 'thread-a'
        }]}
        threads={[threadInput('thread-b')]}
      />
    )

    await waitFor(() => expect(consumed).toHaveBeenCalledTimes(1))
  })
})

function threadInput(
  id: string,
  overrides: Partial<AgentThreadRecord> = {}
): HarnessOverviewThreadInput {
  return { thread: agentThread(id, overrides) }
}

function agentThread(
  id: string,
  overrides: Partial<AgentThreadRecord> = {}
): AgentThreadRecord {
  return {
    id,
    archived: false,
    harnessId: 'codex',
    revision: 1,
    sessionState: null,
    observation: { latestExecution: null, backgroundWork: null },
    title: `Thread ${id}`,
    tags: [],
    cwd: '/Users/demo/OpenAgent',
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}
