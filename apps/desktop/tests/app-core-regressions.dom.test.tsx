// @vitest-environment jsdom
import { createRendererStateMutation } from '../src/shared/renderer-state-patch'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BartDraftAttachment } from '../src/shared/attachments'
import type { DesktopApi } from '../src/shared/desktop-api'
import type { AgentThreadRecord, PublicInteraction } from '@openagent/contracts'
import type { RendererAppState, RendererStateMutation } from '../src/shared/renderer-state-contracts'
import { createDefaultOpenAgentSettings } from '../src/shared/openagent-settings'


vi.mock('../src/renderer/src/bart-thread-transition/camera-scene', () => ({
  captureCameraAssets: vi.fn(), createCameraScene: vi.fn()
}))
import { captureCameraAssets, createCameraScene, type CameraAssets } from '../src/renderer/src/bart-thread-transition/camera-scene'

// The camera owns the way into the thread. Tests that do not exercise it get a
// shot that lands at once, so opening Bart reaches the real page without a
// captured frame. Suites that drive the camera replace both mocks themselves.
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  vi.mocked(captureCameraAssets).mockReset().mockResolvedValue({} as CameraAssets)
  vi.mocked(createCameraScene).mockReset().mockReturnValue({ ready: Promise.resolve(), dispose: vi.fn(),
    play: () => ({ started: Promise.resolve(performance.timeOrigin + performance.now()),
      performed: Promise.resolve() }) })
})
afterEach(() => vi.unstubAllGlobals())

vi.mock('../src/renderer/src/bart-visual-operation', () => ({
  projectBartVisualOperations: () => []
}))
vi.mock('../src/renderer/src/components/AgentThreadWorkspace', () => ({
  AgentThreadWorkspace: (props: {
    readonly thread: AgentThreadRecord
    readonly onFollowUp: (threadId: string) => void
    readonly onBack: () => void
    readonly readingTarget?: { executionId: string; requestId: string; mode?: 'current' | 'history' }
  }) => {
    const [workVisible, setWorkVisible] = React.useState(false)
    return (
      <div>
        <span>agent workspace {props.thread.id}</span>
        <span data-testid="reading-target">{props.readingTarget?.executionId ?? "current"}</span>
        <span data-testid="reading-mode">{props.readingTarget?.mode ?? "current"}</span>
        <button onClick={props.onBack}>back overview</button>
        {workVisible ? <span>work details</span> : null}
        <button onClick={() => props.onFollowUp(props.thread.id)}>open follow-up</button>
        <button onClick={() => setWorkVisible(true)}>show work</button>
      </div>
    )
  }
}))
vi.mock('../src/renderer/src/components/ConversationOverview', () => ({
  ConversationOverview: vi.fn((props: {
    readonly focusFilterRequestKey?: number
    readonly onSelect: (threadId: string) => void
    readonly onViewChange: (view: 'default' | 'archived') => void
    readonly view: string
    readonly onOpenRelatedExecution: (threadId: string, executionId: string) => void
    readonly onTagChange: (tag: string) => void
    readonly selectedTag?: string
    readonly tagFilters?: readonly { readonly tag: string }[]
    readonly threads: readonly { readonly thread: AgentThreadRecord }[]
  }) => (
    <div>
      overview
      <span data-testid="overview-view">{props.view}</span>
      <button onClick={() => props.onOpenRelatedExecution("agent", "e1")}>read report execution</button>
      <button onClick={() => props.onTagChange('workspace')}>select workspace</button>
      <button onClick={() => props.onTagChange('active-tag')}>select active tag</button>
      <button onClick={() => props.onViewChange('default')}>show default</button>
      <button onClick={() => props.onViewChange('archived')}>show archived</button>
      {props.threads.map(({ thread }) => (
        <button key={thread.id} onClick={() => props.onSelect(thread.id)}>
          open {thread.id}
        </button>
      ))}
      <span data-testid="selected-tag">{props.selectedTag || '(all)'}</span>
      <span data-testid="tag-filters">{props.tagFilters?.map(({ tag }) => tag).join('|')}</span>
      <span data-testid="focus-request-key">{props.focusFilterRequestKey}</span>
    </div>
  ))
}))
vi.mock('../src/renderer/src/components/HarnessSettingsPage', () => ({
  HarnessSettingsPage: (props: { open: boolean }) => props.open ? <div>settings visible</div> : null
}))
vi.mock('../src/renderer/src/components/ReportThreadView', () => ({
  ReportThreadView: () => null
}))
vi.mock('../src/renderer/src/components/BartThreadGeneration', () => ({
  BartThreadGenerations: vi.fn(() => null),
  bartGenerationReportTarget: (value: unknown) => value,
  bartGenerationThreadTarget: (value: unknown) => value
}))
vi.mock('../src/renderer/src/components/BartThreadView', () => ({
  buildAgentInput: () => ({ parts: [] }),
  BartThreadView: (props: {
    readonly attachments: readonly BartDraftAttachment[]
    readonly inputValue: string
    readonly onInputChange: (text: string) => void
    readonly error: string
    readonly onBack: () => void
    readonly onPasteFiles: (files: File[]) => void
  }) => (
    <div>
      <input aria-label="thread draft" value={props.inputValue} onChange={event => props.onInputChange(event.target.value)} />
      <span data-testid="thread-attachment-count">{props.attachments.length}</span>
      <span>{props.error}</span>
      <button onClick={props.onBack}>close bart</button>
      <button onClick={() => props.onPasteFiles(files(2))}>paste in thread</button>
    </div>
  )
}))
vi.mock('../src/renderer/src/components/BartDock', () => ({
  BartDock: (props: {
    readonly inputValue: string
    readonly bartAttachments: readonly BartDraftAttachment[]
    readonly onChooseFiles: () => void
    readonly onInputChange: (value: string) => void
    readonly interaction?: {
      readonly threadId: string
      readonly intervention: { readonly id: string; readonly title: string }
    }
    readonly onInteractionResponse?: (request: {
      threadId: string
      interactionId: string
      actionId: string
    }) => Promise<void>
    readonly onPasteFiles: (files: File[]) => void
    readonly onSubmit: () => Promise<void>
    readonly onThreadFollowUpSubmit?: (threadId: string, prompt: string) => Promise<void>
    readonly onThreadOpenChange: (open: boolean) => void
  }) => (
    <div>
      <span data-testid="dock-text">{props.inputValue}</span>
      <span data-testid="dock-attachment-count">{props.bartAttachments.length}</span>
      <button onClick={props.onChooseFiles}>choose attachment</button>
      <button onClick={() => props.onPasteFiles(files(19))}>paste nineteen</button>
      <button onClick={() => props.onPasteFiles(files(2))}>paste two</button>
      <button onClick={() => props.onInputChange('Create a real thread')}>type request</button>
      <button onClick={() => void props.onSubmit()}>submit request</button>
      <button onClick={() => props.onThreadOpenChange(true)}>open bart</button>
      {props.interaction ? (
        <>
          <span>{props.interaction.intervention.title}</span>
          <button onClick={() => void props.onInteractionResponse?.({
            threadId: props.interaction!.threadId,
            interactionId: props.interaction!.intervention.id,
            actionId: 'allow'
          }).catch(() => undefined)}>respond interaction</button>
        </>
      ) : null}
      <button onClick={() => void props.onThreadFollowUpSubmit?.(
        'agent',
        'rejected follow-up'
      ).catch(() => undefined)}>submit follow-up</button>
    </div>
  )
}))
vi.mock('../src/renderer/src/harness-composition', () => ({
  harnessRendererTranslations: {},
  projectHarnessOverviewThread: vi.fn(({ thread, displayPolicy }: { readonly thread: { readonly id: string }; readonly displayPolicy?: { readonly hideInterventions: boolean } }) => ({
    thread,
    envelope: {
      footprint: { columns: 1, rows: 1 },
      structureKey: `thread:${thread.id}:${(thread as AgentThreadRecord).title}${displayPolicy?.hideInterventions === false ? ':interactive' : ''}`,
      excerpt: ''
    }
  })),
  projectHarnessBartPresentation: vi.fn(() => undefined),
  useHarnessPresentationResources: vi.fn(() => ({}))
}))

import App from '../src/renderer/src/App'
import { BartThreadGenerations, type BartGenerationWork } from '../src/renderer/src/components/BartThreadGeneration'
import { ConversationOverview } from '../src/renderer/src/components/ConversationOverview'
import { useHarnessPresentationResources, projectHarnessOverviewThread, projectHarnessBartPresentation } from '../src/renderer/src/harness-composition'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('App Renderer Core regressions', () => {
  it('measures draft edits at AppContent and the unrelated overview', async () => {
    installApi(appState(false))
    render(<App />)
    await screen.findByText('overview')
    const before = [vi.mocked(useHarnessPresentationResources).mock.calls.length,
      vi.mocked(ConversationOverview).mock.calls.length]
    fireEvent.click(screen.getByRole('button', { name: 'type request' }))
    fireEvent.click(screen.getByRole('button', { name: 'paste two' }))
    await waitFor(() => expect(screen.getByTestId('dock-attachment-count')).toHaveTextContent('2'))
    const delta = [vi.mocked(useHarnessPresentationResources).mock.calls.length - before[0],
      vi.mocked(ConversationOverview).mock.calls.length - before[1]]
    console.log('composer render counts: AppContent, Overview', delta)
    expect(delta).toEqual([0, 0])
  })

  it('reveals the real Bart session through the camera and reverses to Overview', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.mocked(captureCameraAssets).mockResolvedValue({} as CameraAssets)
    let complete!: () => void
    vi.mocked(createCameraScene).mockReturnValue({ ready: Promise.resolve(),
      play: () => ({ started: Promise.resolve(performance.timeOrigin + performance.now()), performed: new Promise<void>(resolve => { complete = resolve }) }), dispose: vi.fn() })
    installApi(appState(false))
    const { container } = render(<App />)
    await screen.findByText('overview')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'open bart' })) })
    expect(container.querySelector('[data-bart-camera-active]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'close bart' })).not.toBeInTheDocument()
    const advance = () => act(async () => { complete() })
    await advance()
    expect(screen.getByRole('button', { name: 'close bart' })).toBeVisible()
    expect(screen.queryByText('overview')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'open bart' })).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'close bart' })) })
    expect(container.querySelector('[data-bart-camera-active]')).not.toBeNull()
    await advance()
    expect(screen.getByText('overview')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'close bart' })).not.toBeInTheDocument()
    expect(container.querySelector('[data-bart-camera-active]')).toBeNull()
  })

  it.each(['b', 'k', 'shift-b'])('keeps an active camera when %s reverses it, including stale completions', async key => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.mocked(captureCameraAssets).mockResolvedValue({} as CameraAssets)
    const completions: (() => void)[] = [], dispose = vi.fn()
    vi.mocked(createCameraScene).mockReturnValue({ ready: Promise.resolve(), dispose,
      play: () => ({ started: Promise.resolve(performance.timeOrigin + performance.now()),
        performed: new Promise<void>(resolve => { completions.push(resolve) }) }) })
    installApi(appState(false))
    const { container } = render(<App />)
    await screen.findByText('overview')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'open bart' })))
    await act(async () => fireEvent.keyDown(window, { key: key === 'shift-b' ? 'b' : key,
      shiftKey: key === 'shift-b', metaKey: true, ctrlKey: true }))
    expect(completions).toHaveLength(2)
    expect(dispose).not.toHaveBeenCalled()
    expect(container.querySelector('[data-bart-camera-active]')).not.toBeNull()
    await act(async () => completions[0]())
    expect(container.querySelector('[data-bart-camera-active]')).not.toBeNull()
    await act(async () => completions[1]())
    expect(container.querySelector('[data-bart-camera-active]')).toBeNull()
    expect(dispose).toHaveBeenCalledOnce()
    expect(screen.getByText('overview')).toBeVisible()
  })

  it.each(['reverse', 'settings', 'selection'] as const)('cancels pending capture on %s without a late navigation', async action => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    let resolve!: (assets: CameraAssets) => void
    vi.mocked(captureCameraAssets).mockReturnValue(new Promise(yes => { resolve = yes }))
    const fixture = installApi(appState(false))
    const { container } = render(<App />)
    await screen.findByText('overview')
    fireEvent.click(screen.getByRole('button', { name: 'open bart' }))
    expect(container.querySelector('[data-bart-camera-preparing]')).not.toBeNull()
    await act(async () => {
      if (action === 'selection') fixture.emit({ ...fixture.current(), revision: 2, selectedThreadId: 'agent' })
      else fireEvent.keyDown(window, { key: action === 'reverse' ? 'b' : ',', metaKey: true, ctrlKey: true })
    })
    await act(async () => resolve({} as CameraAssets))
    expect(container.querySelector('[data-bart-camera-preparing], [data-bart-camera-active]')).toBeNull()
    if (action === 'reverse') {
      expect(screen.getByText('overview')).toBeVisible()
      expect(screen.queryByRole('button', { name: 'close bart' })).not.toBeInTheDocument()
    } else {
      expect(screen.getByRole('button', { name: 'close bart' })).toBeVisible()
      if (action === 'settings') expect(screen.getByText('settings visible')).toBeVisible()
    }
  })

  it.each([false, true])('uses immediate Bart overlays over Agent and restores its durable selection (capsule: %s)', async capsule => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const fixture = installApi(appState(true))
    const { container } = render(<App />)
    await screen.findByText('agent workspace agent')
    fireEvent.keyDown(window, { key: 'b', metaKey: true, ctrlKey: true })
    expect(screen.getByRole('button', { name: 'close bart' })).toBeVisible()
    expect(container.querySelector('[data-bart-camera-preparing], [data-bart-camera-active]')).toBeNull()
    const captures = vi.mocked(captureCameraAssets).mock.calls.length
    fireEvent.keyDown(window, { key: 'b', shiftKey: capsule, metaKey: true, ctrlKey: true })
    expect(vi.mocked(captureCameraAssets).mock.calls.length).toBe(captures)
    expect(screen.getByText('agent workspace agent')).toBeVisible()
    expect(fixture.current().selectedThreadId).toBe('agent')
    expect(fixture.updateUiState).not.toHaveBeenCalled()
  })

  it('keeps the whole Dock inaccessible inside Bart and restores it on return', async () => {
    installApi(appState(false))
    render(<App />)
    await screen.findByText('overview')
    fireEvent.click(screen.getByRole('button', { name: 'open bart' }))
    await screen.findByRole('button', { name: 'close bart' })
    expect(screen.queryByRole('button', { name: 'open bart' })).not.toBeInTheDocument()
    expect(screen.getByTestId('dock-text').closest('[inert]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'close bart' }))
    expect(await screen.findByRole('button', { name: 'open bart' })).toBeVisible()
  })

  it('shares the same draft across Dock and full Bart page switches', async () => {
    installApi(appState(false))
    render(<App />)
    await screen.findByText('overview')
    fireEvent.click(screen.getByRole('button', { name: 'type request' }))
    fireEvent.click(screen.getByRole('button', { name: 'paste two' }))
    await waitFor(() => expect(screen.getByTestId('dock-attachment-count')).toHaveTextContent('2'))
    fireEvent.click(screen.getByRole('button', { name: 'open bart' }))
    await screen.findByRole('button', { name: 'close bart' })
    expect(screen.getByLabelText('thread draft')).toHaveValue('Create a real thread')
    expect(screen.getByTestId('thread-attachment-count')).toHaveTextContent('2')
    fireEvent.change(screen.getByLabelText('thread draft'), { target: { value: 'edited on page' } })
    fireEvent.click(screen.getByRole('button', { name: 'close bart' }))
    await screen.findByRole('button', { name: 'open bart' })
    expect(screen.getByTestId('dock-text')).toHaveTextContent('edited on page')
    expect(screen.getByTestId('dock-attachment-count')).toHaveTextContent('2')
  })

  it('projects newly queued generation work with the latest resized column count', async () => {
    installApi(appState(false))
    render(<App />)
    await screen.findByText('overview')
    const overview = vi.mocked(ConversationOverview).mock.calls.at(-1)![0]
    const rootRenders = vi.mocked(useHarnessPresentationResources).mock.calls.length
    act(() => overview.onLayoutContextChange?.({ availableCols: 3 }))
    act(() => overview.onGenerationMotionQueued?.({
      key: 1, targets: [{ id: 'agent', kind: 'thread', harnessId: 'codex', running: false,
        worktree: false, createdAt: 1, title: 'Agent', metaText: '', cwdText: '', bodyText: '' }],
      controller: new AbortController()
    }))
    expect(vi.mocked(projectHarnessOverviewThread)).toHaveBeenLastCalledWith(
      expect.objectContaining({ thread: expect.objectContaining({ id: 'agent' }) }), 3)
    act(() => overview.onLayoutContextChange?.({ availableCols: 2 }))
    expect(vi.mocked(projectHarnessOverviewThread)).toHaveBeenLastCalledWith(
      expect.objectContaining({ thread: expect.objectContaining({ id: 'agent' }) }), 2)
    expect(vi.mocked(useHarnessPresentationResources).mock.calls.length).toBe(rootRenders)
  })

  it('clears generation work, hidden IDs, reveal and revisions on scene changes, leaving Overview and unmount', async () => {
    installApi(appState(false))
    const mounted = render(<App />)
    await screen.findByText('overview')
    const orchestration = vi.mocked(BartThreadGenerations).mock.calls.at(-1)![0].orchestration!
    const enqueue = (key: number) => {
      const controller = new AbortController()
      const work: BartGenerationWork = {
        key, targets: [{ id: 'report-' + key, kind: 'report', createdAt: key,
          title: 'report', metaText: '', cwdText: '', bodyText: '' }],
        controller
      }
      act(() => {
        orchestration.enqueue(work)
        orchestration.requestReveal('report-' + key)
        orchestration.setDeletedIndexes({ removed: 0 })
      })
      return controller
    }
    const first = enqueue(1)
    fireEvent.click(screen.getByRole('button', { name: 'show archived' }))
    expect(first.signal.aborted).toBe(true)
    expect(orchestration.getState()).toMatchObject({ works: [], hiddenIds: [], reveal: null, revisions: [], deletedIndexes: {} })
    const second = enqueue(2)
    fireEvent.click(screen.getByRole('button', { name: 'open bart' }))
    await screen.findByRole('button', { name: 'close bart' })
    expect(second.signal.aborted).toBe(true)
    expect(orchestration.getState()).toMatchObject({ works: [], hiddenIds: [], reveal: null })
    fireEvent.click(screen.getByRole('button', { name: 'close bart' }))
    const third = enqueue(3)
    mounted.unmount()
    expect(third.signal.aborted).toBe(true)
    expect(orchestration.getState()).toMatchObject({ works: [], hiddenIds: [], reveal: null })
  })

  it('streams Bart through its own subscriber without projecting or rendering the Agent overview', async () => {
    const fixture = installApi(appState(false))
    render(<App />)
    await screen.findByText('overview')
    const overviewRenders = vi.mocked(ConversationOverview).mock.calls.length
    const projections = vi.mocked(projectHarnessOverviewThread).mock.calls.length
    const dockProjections = vi.mocked(projectHarnessBartPresentation).mock.calls.length
    const next = { ...fixture.current(), revision: 2, threads: fixture.current().threads.map((thread) =>
      thread.id === 'bart' ? { ...thread, revision: 2, sessionState: { text: 'next token' } } : thread
    ) }

    act(() => fixture.emit(next))

    expect(document.querySelector('.app-shell')).toHaveAttribute('data-state-revision', '2')
    expect(vi.mocked(projectHarnessBartPresentation).mock.calls.length).toBeGreaterThan(dockProjections)
    expect(vi.mocked(ConversationOverview).mock.calls.length).toBe(overviewRenders)
    expect(vi.mocked(projectHarnessOverviewThread).mock.calls.length).toBe(projections)
  })

  it('keeps every A → B → A layout revision across one React render batch', async () => {
    const fixture = installApi(appState(false))
    render(<App />)
    await screen.findByText('overview')
    act(() => {
      for (const title of ['B', 'Agent']) {
        fixture.emit({ ...fixture.current(), revision: fixture.current().revision + 1,
          threads: fixture.current().threads.map((thread) => thread.id === 'agent'
            ? { ...thread, revision: thread.revision + 1, title } : thread)
        })
      }
    })
    const props = vi.mocked(ConversationOverview).mock.calls.at(-1)![0]
    expect(props.layoutRevisions?.map((revision) => revision.snapshot.items.find(
      (item) => item.kind === 'card' && item.entityId === 'agent'
    ))).toEqual([
      expect.objectContaining({ structureKey: 'thread:agent:B' }),
      expect.objectContaining({ structureKey: 'thread:agent:Agent' })
    ])
    expect(document.querySelector('.app-shell')).toHaveAttribute('data-state-revision', '3')
  })

  it('captures settings-only display policy switches in one React batch', async () => {
    const fixture = installApi(appState(false))
    render(<App />)
    await screen.findByText('overview')
    const originalThreads = fixture.current().threads
    act(() => {
      for (const autoIntervention of [false, true]) {
        const current = fixture.current()
        fixture.emit({ ...current, revision: current.revision + 1,
          settings: { ...current.settings, bart: { ...current.settings.bart, autoIntervention } }
        })
      }
    })
    const props = vi.mocked(ConversationOverview).mock.calls.at(-1)![0]
    expect(props.layoutRevisions?.map((revision) => revision.snapshot.items.find(
      (item) => item.kind === 'card' && item.entityId === 'agent'
    ))).toEqual([
      expect.objectContaining({ structureKey: 'thread:agent:Agent:interactive' }),
      expect.objectContaining({ structureKey: 'thread:agent:Agent' })
    ])
    expect(fixture.current().threads).toBe(originalThreads)
    expect(props.threads[0]?.displayPolicy).toEqual({ hideInterventions: true })
    const projections = vi.mocked(projectHarnessOverviewThread).mock.calls.length
    act(() => {
      const current = fixture.current()
      fixture.emit({ ...current, revision: current.revision + 1,
        settings: { ...current.settings, locale: 'en-US' }
      })
    })
    expect(vi.mocked(projectHarnessOverviewThread).mock.calls.length).toBe(projections)
  })

  it('reserves the remaining chooser capacity and rejects an overflowing paste before staging', async () => {
    const fixture = installApi(appState(false))
    render(<App />)
    await screen.findByText('overview')

    fireEvent.click(screen.getByRole('button', { name: 'paste nineteen' }))
    await waitFor(() => expect(screen.getByTestId('dock-attachment-count')).toHaveTextContent('19'))
    expect(fixture.stageBartAttachments).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'paste two' }))
    expect(fixture.stageBartAttachments).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('附件数量不能超过 20 个')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'choose attachment' }))
    await waitFor(() => expect(fixture.chooseFiles).toHaveBeenCalledWith('/workspace', 1))
    await waitFor(() => expect(screen.getByTestId('dock-attachment-count')).toHaveTextContent('20'))
  })

  it('localizes attachment errors in both the dock shell and Bart thread', async () => {
    const fixture = installApi(appState(false, 'en-US'))
    render(<App />)
    await screen.findByText('overview')

    fireEvent.click(screen.getByRole('button', { name: 'paste nineteen' }))
    await waitFor(() => expect(fixture.stageBartAttachments).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'paste two' }))
    expect(await screen.findByText('You can attach at most 20 files.')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'open bart' }))
    await screen.findByRole('button', { name: 'close bart' })
    fireEvent.click(screen.getByRole('button', { name: 'paste in thread' }))
    expect(await screen.findByText('You can attach at most 20 files.')).toBeVisible()
  })

  it('returns to overview when the thread selected before Bart has been deleted', async () => {
    const fixture = installApi(appState(true))
    render(<App />)
    await screen.findByText('agent workspace agent')

    fireEvent.click(screen.getByRole('button', { name: 'open bart' }))
    await screen.findByRole('button', { name: 'close bart' })
    expect(fixture.updateUiState).not.toHaveBeenCalled()
    expect(fixture.current().selectedThreadId).toBe('agent')

    fixture.emit({
      ...fixture.current(),
      revision: fixture.current().revision + 1,
      threads: fixture.current().threads.filter((thread) => thread.id !== 'agent'),
      selectedThreadId: null
    })
    fireEvent.click(screen.getByRole('button', { name: 'close bart' }))

    expect(fixture.updateUiState).toHaveBeenCalledExactlyOnceWith({ selectedThreadId: null })
    await screen.findByText('overview')
  })

  it('keeps the durable Agent selection behind the Bart overlay and across reload', async () => {
    const fixture = installApi(appState(true))
    const first = render(<App />)
    await screen.findByText('agent workspace agent')

    fireEvent.click(screen.getByRole('button', { name: 'open bart' }))
    await screen.findByRole('button', { name: 'close bart' })
    expect(fixture.current().selectedThreadId).toBe('agent')
    expect(fixture.updateUiState).not.toHaveBeenCalled()

    first.unmount()
    render(<App />)
    expect(await screen.findByText('agent workspace agent')).toBeVisible()
    expect(fixture.current().selectedThreadId).toBe('agent')
  })

  it('remounts the Agent workspace by selected Thread id so display state stays isolated', async () => {
    const state = appState(true)
    const second = agentThread('agent-b', {
      cwd: '/workspace-b',
      createdAt: 3,
      updatedAt: 3
    })
    const fixture = installApi({ ...state, threads: [...state.threads, second] })
    render(<App />)
    await screen.findByText('agent workspace agent')

    fireEvent.click(screen.getByRole('button', { name: 'show work' }))
    expect(screen.getByText('work details')).toBeVisible()
    fixture.emit({
      ...fixture.current(),
      revision: fixture.current().revision + 1,
      selectedThreadId: 'agent-b'
    })
    expect(await screen.findByText('agent workspace agent-b')).toBeVisible()

    expect(screen.queryByText('work details')).not.toBeInTheDocument()
  })

  it('builds tag filters from only the current task/archive view and clears a stale selection', async () => {
    const base = appState(false)
    const currentReport = report('current-report', false, ['report-current'])
    const archivedReport = report('archived-report', true, ['report-archived'])
    const fixture = installApi({
      ...base,
      threads: [
        base.threads[0]!,
        agentThread('active', { cwd: '/work/active-tag', tags: ['active-tag'] }),
        agentThread('completed', {
          cwd: '/work/completed-tag',
          tags: ['completed-tag'],
          observation: {
            latestExecution: {
              executionId: 'execution-completed',
              status: 'completed',
              startedAt: 2,
              finishedAt: 3
            },
            backgroundWork: null
          }
        })
      ],
      reports: [currentReport, archivedReport]
    })
    render(<App />)
    await screen.findByText('overview')

    expect(screen.getByTestId('tag-filters')).toHaveTextContent('active-tag')
    expect(screen.getByTestId('tag-filters')).toHaveTextContent('report-current')
    expect(screen.getByTestId('tag-filters')).toHaveTextContent('completed-tag')
    expect(screen.getByTestId('tag-filters')).not.toHaveTextContent('report-archived')

    fireEvent.click(screen.getByRole('button', { name: 'select active tag' }))
    expect(screen.getByTestId('selected-tag')).toHaveTextContent('active-tag')
    fireEvent.click(screen.getByRole('button', { name: 'show archived' }))
    await waitFor(() => expect(screen.getByTestId('tag-filters')).toHaveTextContent('report-archived'))
    expect(screen.getByTestId('selected-tag')).toHaveTextContent('active-tag')
    expect(screen.getByTestId('tag-filters')).not.toHaveTextContent('completed-tag')
    expect(screen.getByTestId('tag-filters')).not.toHaveTextContent('report-current')
    expect(fixture.current().selectedThreadId).toBeNull()
  })

  it('refreshes catalog tags for execution status and background-work changes', async () => {
    const base = appState(false)
    const fixture = installApi({ ...base, threads: [base.threads[0]!, agentThread('agent', {
      cwd: '/work/active-tag', tags: ['active-tag']
    })] })
    render(<App />)
    await screen.findByText('overview')
    expect(screen.getByTestId('tag-filters')).toHaveTextContent('active-tag')

    const updateObservation = (background: boolean): void => fixture.emit({
      ...fixture.current(), revision: fixture.current().revision + 1,
      threads: fixture.current().threads.map((thread) => thread.id === 'agent' ? {
        ...thread, revision: thread.revision + 1,
        observation: {
          latestExecution: { executionId: 'done', status: 'completed' as const, startedAt: 2, finishedAt: 3 },
          backgroundWork: background ? { status: 'running' as const } : null
        }
      } : thread)
    })
    act(() => updateObservation(false))
    expect(screen.getByTestId('tag-filters')).toHaveTextContent('active-tag')
    act(() => updateObservation(true))
    expect(screen.getByTestId('tag-filters')).toHaveTextContent('active-tag')
  })

  it('issues a fresh overview filter focus request for every Cmd/Ctrl+K', async () => {
    installApi(appState(false))
    render(<App />)
    await screen.findByText('overview')
    expect(screen.getByTestId('focus-request-key')).toHaveTextContent('0')

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(screen.getByTestId('focus-request-key')).toHaveTextContent('1'))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(screen.getByTestId('focus-request-key')).toHaveTextContent('2'))
  })

  it('keeps Agent interactions out of the Dock, then wires the Bart public interaction without a run id', async () => {
    const state = appState(true)
    const interaction: PublicInteraction = {
      id: 'public-permission',
      kind: 'permission',
      title: 'Approve shell command',
      description: 'Run the requested command',
      actions: [
        { id: 'allow', intent: 'allow', label: 'Allow' },
        { id: 'deny', intent: 'deny', label: 'Deny' }
      ],
      questions: []
    }
    const fixture = installApi({
      ...state,
      threads: state.threads.map((thread) => thread.id === 'agent'
        ? {
            ...thread,
            observation: {
              latestExecution: {
                executionId: 'execution-waiting',
                status: 'waiting-for-user' as const,
                startedAt: 2,
                interactions: [interaction]
              },
              backgroundWork: null
            }
          }
        : thread)
    })
    fixture.respondToThreadInteraction.mockRejectedValueOnce(new Error('interaction rejected'))
    render(<App />)
    await screen.findByText('agent workspace agent')
    expect(screen.queryByText('Approve shell command')).not.toBeInTheDocument()

    fixture.emit({
      ...fixture.current(),
      revision: fixture.current().revision + 1,
      threads: fixture.current().threads.map((thread) => thread.id === 'bart'
        ? {
            ...thread,
            revision: thread.revision + 1,
            observation: {
              latestExecution: {
                executionId: 'bart-execution-waiting',
                status: 'waiting-for-user' as const,
                startedAt: 3,
                interactions: [interaction]
              },
              backgroundWork: null
            }
          }
        : thread)
    })

    expect(await screen.findByText('Approve shell command')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'respond interaction' }))
    await waitFor(() => expect(fixture.respondToThreadInteraction).toHaveBeenCalledWith({
      threadId: 'bart',
      interactionId: 'public-permission',
      actionId: 'allow'
    }))
    expect(await screen.findByText('interaction rejected')).toBeVisible()
    expect(JSON.stringify(fixture.respondToThreadInteraction.mock.calls)).not.toContain('runId')
    fireEvent.click(screen.getByRole('button', { name: 'open bart' }))
    expect(screen.queryByRole('button', { name: 'respond interaction' })).not.toBeInTheDocument()
    expect(screen.getByText('Approve shell command').closest('[inert]')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true, metaKey: true })
    expect(screen.getByRole('button', { name: 'respond interaction' })).toBeVisible()
  })

  it('rejects a composer opened before archival, then restores submission after unarchive', async () => {
    const fixture = installApi(appState(true))
    render(<App />)
    await screen.findByText('agent workspace agent')
    fireEvent.click(screen.getByRole('button', { name: 'open follow-up' }))
    const setArchived = (archived: boolean) => act(() => fixture.emit({
      ...fixture.current(), revision: fixture.current().revision + 1,
      threads: fixture.current().threads.map(thread => thread.id === 'agent'
        ? { ...thread, revision: thread.revision + 1, archived } : thread)
    }))
    setArchived(true)
    fireEvent.click(screen.getByRole('button', { name: 'submit follow-up' }))
    expect(await screen.findByText('此 Thread 已归档，取消归档后才能追加任务。')).toBeVisible()
    expect(fixture.followUpThread).not.toHaveBeenCalled()
    setArchived(false)
    fireEvent.click(screen.getByRole('button', { name: 'submit follow-up' }))
    await waitFor(() => expect(fixture.followUpThread).toHaveBeenCalledOnce())
  })

  it('compares a report execution at click time and preserves reading target, view and tag across updates', async () => {
    const base = appState(false)
    const fixture = installApi({ ...base, threads: base.threads.map(thread => thread.id === 'agent' ? {
      ...thread, tags: ['active-tag'], observation: { backgroundWork: null,
        latestExecution: { executionId: 'e1', status: 'completed' as const, startedAt: 1, finishedAt: 2 } }
    } : thread) })
    render(<App />)
    await screen.findByText('overview')
    fireEvent.click(screen.getByRole('button', { name: 'select active tag' }))
    fireEvent.click(screen.getByRole('button', { name: 'show archived' }))
    fireEvent.click(screen.getByRole('button', { name: 'read report execution' }))
    await screen.findByText('agent workspace agent')
    expect(screen.getByTestId('reading-target')).toHaveTextContent('e1')
    expect(screen.getByTestId('reading-mode')).toHaveTextContent('current')
    fireEvent.click(screen.getByRole('button', { name: 'back overview' }))
    await screen.findByText('overview')
    expect(screen.getByTestId('overview-view')).toHaveTextContent('archived')
    expect(screen.getByTestId('selected-tag')).toHaveTextContent('active-tag')
    const latest = (executionId: string) => act(() => fixture.emit({
      ...fixture.current(), revision: fixture.current().revision + 1,
      threads: fixture.current().threads.map(thread => thread.id === 'agent' ? {
        ...thread, revision: thread.revision + 1, observation: { backgroundWork: null,
          latestExecution: { executionId, status: 'running' as const, startedAt: 3 } }
      } : thread)
    }))
    latest('e2')
    fireEvent.click(screen.getByRole('button', { name: 'read report execution' }))
    await screen.findByText('agent workspace agent')
    expect(screen.getByTestId('reading-target')).toHaveTextContent('e1')
    expect(screen.getByTestId('reading-mode')).toHaveTextContent('history')
    latest('e3')
    expect(screen.getByTestId('reading-target')).toHaveTextContent('e1')
    fireEvent.click(screen.getByRole('button', { name: 'back overview' }))
    await screen.findByText('overview')
    expect(screen.getByTestId('overview-view')).toHaveTextContent('archived')
    expect(screen.getByTestId('selected-tag')).toHaveTextContent('active-tag')
  })

  it('freezes the current-view decision at click even when a new Execution starts before navigation commits', async () => {
    const base = appState(false)
    const fixture = installApi({ ...base, threads: base.threads.map(thread => thread.id === 'agent' ? {
      ...thread, observation: { backgroundWork: null,
        latestExecution: { executionId: 'e1', status: 'completed' as const, startedAt: 1, finishedAt: 2 } }
    } : thread) })
    fixture.updateUiState.mockImplementationOnce(async update => fixture.emit({
      ...fixture.current(), revision: fixture.current().revision + 1, selectedThreadId: update.selectedThreadId!,
      threads: fixture.current().threads.map(thread => thread.id === 'agent' ? {
        ...thread, revision: thread.revision + 1, observation: { backgroundWork: null,
          latestExecution: { executionId: 'e2', status: 'running' as const, startedAt: 3 } }
      } : thread)
    }))
    render(<App />)
    await screen.findByText('overview')
    fireEvent.click(screen.getByRole('button', { name: 'read report execution' }))
    await screen.findByText('agent workspace agent')
    expect(screen.getByTestId('reading-target')).toHaveTextContent('e1')
    expect(screen.getByTestId('reading-mode')).toHaveTextContent('current')
  })

  it('routes a rejected direct Thread follow-up through the existing operation error toast', async () => {
    const fixture = installApi(appState(true))
    fixture.followUpThread.mockRejectedValueOnce(new Error('follow-up rejected'))
    render(<App />)
    await screen.findByText('agent workspace agent')

    fireEvent.click(screen.getByRole('button', { name: 'open follow-up' }))
    fireEvent.click(screen.getByRole('button', { name: 'submit follow-up' }))

    expect(await screen.findByText('follow-up rejected')).toBeVisible()
    expect(fixture.followUpThread).toHaveBeenCalledWith({
      threadId: 'agent',
      input: { parts: [{ kind: 'text', text: 'rejected follow-up' }] }
    })
  })

  it('restores platform chrome and sends the selected workspace identity to Bart', async () => {
    const fixture = installApi(appState(false))
    render(<App />)
    await screen.findByText('overview')

    expect(document.querySelector('.app-shell')).toHaveClass('platform-darwin')
    fireEvent.click(screen.getByRole('button', { name: 'select workspace' }))
    fireEvent.click(screen.getByRole('button', { name: 'type request' }))
    fireEvent.click(screen.getByRole('button', { name: 'submit request' }))

    await waitFor(() => expect(fixture.submitBartMessage).toHaveBeenCalledWith({
      input: { parts: [] },
      directoryTag: 'workspace'
    }))
  })
})

function files(count: number): File[] {
  return Array.from({ length: count }, (_, index) => new File(
    [`attachment-${index}`],
    `attachment-${index}.txt`,
    { type: 'text/plain' }
  ))
}

function appState(
  selectedAgent: boolean,
  locale: 'zh-CN' | 'en-US' = 'zh-CN'
): RendererAppState {
  const bart = {
    id: 'bart',
    bart: true as const,
    harnessId: 'codex' as const,
    revision: 1,
    sessionState: {},
    observation: { latestExecution: null, backgroundWork: null },
    title: 'Bart',
    tags: [],
    cwd: '/workspace/.bart',
    settings: {},
    transcript: [],
    createdAt: 1,
    updatedAt: 1
  }
  const agent = agentThread('agent', { title: 'Agent', createdAt: 2, updatedAt: 2 })
  return {
    revision: 1,
    defaultCwd: '/workspace',
    threads: [bart, agent],
    executions: [],
    reports: [],
    selectedThreadId: selectedAgent ? agent.id : null,
    settings: {
      ...createDefaultOpenAgentSettings(),
      locale
    }
  }
}

function installApi(initial: RendererAppState): {
  readonly chooseFiles: ReturnType<typeof vi.fn<DesktopApi['chooseFiles']>>
  readonly followUpThread: ReturnType<typeof vi.fn<DesktopApi['followUpThread']>>
  readonly respondToThreadInteraction: ReturnType<typeof vi.fn<DesktopApi['respondToThreadInteraction']>>
  readonly stageBartAttachments: ReturnType<typeof vi.fn<DesktopApi['stageBartAttachments']>>
  readonly submitBartMessage: ReturnType<typeof vi.fn<DesktopApi['submitBartMessage']>>
  readonly updateUiState: ReturnType<typeof vi.fn<DesktopApi['updateUiState']>>
  current(): RendererAppState
  emit(state: RendererAppState): void
} {
  let state = initial
  let listener: ((mutation: RendererStateMutation) => void) | undefined
  let attachmentId = 0
  const stageBartAttachments = vi.fn<DesktopApi['stageBartAttachments']>(async (selected) =>
    selected.map((file) => ({
      id: `staged-${++attachmentId}`,
      path: `/staged/${attachmentId}/${file.name}`,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      kind: 'document'
    }))
  )
  const chooseFiles = vi.fn<DesktopApi['chooseFiles']>(async () => [{
    id: `chosen-${++attachmentId}`,
    path: `/staged/${attachmentId}/chosen.txt`,
    name: 'chosen.txt',
    mimeType: 'text/plain',
    size: 1,
    kind: 'document'
  }])
  const emit = (next: RendererAppState): void => {
    const mutation = createRendererStateMutation(state, next)
    state = next
    listener?.(mutation)
  }
  const updateUiState = vi.fn<DesktopApi['updateUiState']>(async (update) => {
    emit({
      ...state,
      revision: state.revision + 1,
      selectedThreadId: update.selectedThreadId === undefined
        ? state.selectedThreadId
        : update.selectedThreadId
    })
  })
  const submitBartMessage = vi.fn<DesktopApi['submitBartMessage']>(async () => undefined)
  const followUpThread = vi.fn<DesktopApi['followUpThread']>(async () => undefined)
  const respondToThreadInteraction = vi.fn<DesktopApi['respondToThreadInteraction']>(
    async () => undefined
  )
  window.openAgent = {
    platform: 'darwin',
    loadState: vi.fn(async () => state),
    onStateMutation: vi.fn((next) => {
      listener = next
      return () => {
        listener = undefined
      }
    }),
    chooseFiles,
    stageBartAttachments,
    submitBartMessage,
    followUpThread,
    respondToThreadInteraction,
    updateUiState
  } as unknown as DesktopApi
  return {
    chooseFiles,
    followUpThread,
    respondToThreadInteraction,
    stageBartAttachments,
    submitBartMessage,
    updateUiState,
    current: () => state,
    emit
  }
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
    sessionState: {},
    observation: { latestExecution: null, backgroundWork: null },
    title: id,
    tags: [],
    cwd: '/workspace',
    settings: {},
    createdAt: 2,
    updatedAt: 2,
    ...overrides
  }
}

function report(
  id: string,
  archived: boolean,
  tags: readonly string[]
): RendererAppState['reports'][number] {
  return {
    id,
    title: id,
    tags,
    relatedExecutions: [],
    createdAt: archived ? 5 : 4,
    updatedAt: archived ? 5 : 4,
    archived,
    previewText: id
  }
}
