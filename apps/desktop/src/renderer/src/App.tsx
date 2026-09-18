import type { OverviewCameraMemory } from './overview-motion/camera'
import { useCameraTransition } from './bart-thread-transition/use-camera-transition'
import './bart-thread-transition/transition.css'
import { createOverviewOrchestrationStore } from './overview-orchestration-store'
import { synchronizeRendererState } from '../../shared/renderer-state-sync'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { flushSync } from 'react-dom'
import { createBartComposerStore, ATTACHMENT_LIMIT_ERROR, ATTACHMENT_IMPORT_BUSY_ERROR } from './bart-composer-store'
import type { AgentThreadRecord } from '@openagent/contracts'
import type { ThreadInteractionResponseRequest } from '../../shared/desktop-api'
import {
  createRendererStateStore
} from '../../shared/renderer-store'
import { RendererStoreProvider, useRendererState, useRendererStoreApi, useRendererAgentCatalog } from './renderer-store-context'
import type {
  RendererAppState,
  RendererBartThreadRecord,
  RendererStateMutation,
  RendererThreadRecord
} from '../../shared/renderer-state-contracts'
import { threadDirectoryTag } from '@openagent/contracts'
import { bartVisualOperations, overviewTransitionChanged } from './bart-visual-state'
import { AppShell, SubscribedAgentThreadWorkspace, SubscribedBartThreadView, SubscribedBartDock, SubscribedConversationOverview, SubscribedBartThreadGenerations } from './components/RendererSurfaces'
import type { BartDockReply, BartDockThreadFollowUpTarget } from './components/BartDock'
import { BartLiquidStage } from './liquid/BartLiquidStage'
import {
  bartGenerationReportTarget,
  bartGenerationThreadTarget,
  type BartGenerationTarget
} from './components/BartThreadGeneration'
import {
  type ConversationTagFilter
} from './components/ConversationOverview'
import { HarnessSettingsPage } from './components/HarnessSettingsPage'
import { BartCrossPageFlight, type BartFlightDirection } from './components/BartCrossPageFlight'
import { getOverviewMotionCoordinator } from './overview-motion'
import type { SettingsPagePhase } from './components/use-settings-page-transition'
import { ReportThreadView } from './components/ReportThreadView'
import {
  deriveOverviewItems,
  overviewLayoutSnapshot,
  tagKey,
  selectOverviewItems,
  type OverviewView,
  type OverviewLayoutSnapshot
} from './conversation-overview-layout'
import {
  harnessRendererTranslations,
  projectHarnessOverviewThread,
  useHarnessPresentationResources
} from './harness-composition'
import { runThemeTransition } from './theme-transition'
import type { OpenAgentSettings } from '../../shared/openagent-settings'
import { useI18n } from '@openagent/plugin-kit/renderer'
import { AppI18nProvider } from './i18n'
import {
  type HarnessRendererThreadInput,
  type HarnessOverviewThread,
  type HarnessOverviewThreadInput,
  type OverviewLayoutContext
} from '@openagent/contracts/renderer'

type SessionTransitionDirection = 'to-overview' | 'to-thread'

const SESSION_TRANSITION_CLASSES = [
  'session-transition-to-overview',
  'session-transition-to-thread'
] as const

interface OverviewViewSnapshot {
  readonly open: boolean
  readonly selectedTags: readonly string[]
  readonly view: OverviewView
  readonly sceneKey: string
}

interface ProjectedOverviewAggregate {
  readonly snapshot: OverviewLayoutSnapshot
  readonly projectedThreads: readonly HarnessOverviewThread[]
  readonly items: ReturnType<typeof deriveOverviewItems>['items']
}

export default function App(): React.JSX.Element {
  const [store] = useState(() => createRendererStateStore(''))
  return <RendererStoreProvider store={store}><AppContent /></RendererStoreProvider>
}

function AppContent(): React.JSX.Element {
  const store = useRendererStoreApi()
  const camera = useCameraTransition()
  const { open: bartThreadOpen, finish: finishBartNavigation, play: playBartCamera, getTarget: getBartTarget } = camera
  const settings = useRendererState((current) => current.settings)
  const defaultCwd = useRendererState((current) => current.defaultCwd)
  const reports = useRendererState((current) => current.reports)
  const selectedThreadId = useRendererState((current) => current.selectedThreadId)
  const agentThreadIds = useRendererState((current) => current.agentThreadIds)
  const bartThreadId = useRendererState((current) => current.bartThreadId)
  const bartHarnessId = useRendererState((current) => current.bartThreadId
    ? current.threadsById[current.bartThreadId]?.harnessId : undefined)
  const bartExecution = useRendererState((current) => current.executions.find(
    (execution) => execution.threadId === current.bartThreadId
  ) ?? null)
  const [hydrated, setHydrated] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [operationError, setOperationError] = useState('')
  // Every write to the app-wide notice takes a stamp of its own, so a report
  // that outlives its operation can take down exactly its own message: a later
  // failure that happens to read the same is a different notice to the reader.
  const noticeStamps = useRef(0)
  const reportOperationError = useCallback((message: string): void => {
    noticeStamps.current += 1
    setOperationError(message)
  }, [])
  // Hands the settings page a dismissal that retires the report it just made
  // and nothing else: another operation may have replaced that notice by the
  // time the retried write lands, and that replacement is a live problem.
  const reportSettingsSaveError = useCallback((message: string): (() => void) => {
    reportOperationError(message)
    const stamp = noticeStamps.current
    return () => { if (noticeStamps.current === stamp) reportOperationError('') }
  }, [reportOperationError])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsPhase, setSettingsPhase] = useState<SettingsPagePhase>('closed')
  const [bartFlightActive, setBartFlightActive] = useState(false)
  const [bartFlight, setBartFlight] = useState<BartFlightDirection | null>(null)
  const bartFlightRef = useRef(bartFlight)
  bartFlightRef.current = bartFlight
  // Set when the page reports its collapse as finished while Bart is still flying.
  const bartFlightHoldsCloseRef = useRef(false)
  // Read as the flight departs, to tell a settings page opened over the Overview
  // from one opened over a thread: the Dock is mounted in both.
  const overviewRenderedRef = useRef(false)
  const onSettingsPhase = useCallback((phase: SettingsPagePhase): void => {
    setSettingsPhase(phase)
    if (phase === 'opening') bartFlightHoldsCloseRef.current = false
    // No Overview underneath means no journey: the Dock stays mounted behind a
    // thread view and merely conceals itself, so its ink box still measures and
    // the copy would leave from a seat the user cannot see.
    if (!overviewRenderedRef.current) return
    // Consecutive phase events alternate, so each open and each close is a fresh
    // request; the flight clearing itself back to rest is what keeps them fresh.
    if (phase === 'opening' || phase === 'closing') {
      getOverviewMotionCoordinator().cutScene('bart-cross-page')
      setBartFlight(phase === 'opening' ? 'to-seat' : 'to-dock')
    }
  }, [])
  const onBartFlightActive = useCallback((active: boolean, direction: BartFlightDirection): void => {
    if (bartFlightRef.current !== direction) return
    setBartFlightActive(active)
    if (active) return
    // A request is a transition out of rest, so the landed flight clears itself:
    // left standing, a repeated direction would be the identical value, and React
    // would bail out of the re-render that starts the flight.
    setBartFlight(null)
    if (!bartFlightHoldsCloseRef.current) return
    // The copy has landed on the Dock, so the page may go now: `settingsOpen` is
    // what un-conceals the Dock, and doing it any earlier shows two Barts at once.
    bartFlightHoldsCloseRef.current = false
    setSettingsOpen(false)
  }, [])
  const closeSettings = useCallback((): void => {
    if (bartFlightActive) { bartFlightHoldsCloseRef.current = true; return }
    setSettingsOpen(false)
  }, [bartFlightActive])
  const settingsOriginRef = useRef<HTMLElement | null>(null)
  const openSettings = useCallback((event?: React.MouseEvent<HTMLButtonElement>): void => {
    if (settingsOpen) return
    finishBartNavigation(getBartTarget())
    settingsOriginRef.current = event?.currentTarget ?? Array.from(document.querySelectorAll<HTMLElement>('[data-settings-trigger]'))
      .find((element) => element.getBoundingClientRect().width > 0 && !element.closest('[inert]')) ?? null
    setSettingsOpen(true)
  }, [settingsOpen, finishBartNavigation, getBartTarget])
  const [openReportId, setOpenReportId] = useState<string | null>(null)
  const [selectedTag, setSelectedTag] = useState('')
  const [overviewTaskView, setOverviewTaskView] = useState<OverviewView>('default')
  const [readingTarget, setReadingTarget] = useState<HarnessRendererThreadInput['readingTarget']>()
  // Bart session navigation is its own channel: an Agent thread's reading
  // request must not survive into the Dock's session and vice versa. The
  // request remembers the session it was made in, so a session that gets
  // replaced — a clear starts a new Bart Thread — cannot hand its located
  // message to the next one.
  const [bartReading, setBartReading] = useState<{
    readonly threadId: string | null
    readonly target: HarnessRendererThreadInput['readingTarget']
  }>()
  const [transitionSessionId, setTransitionSessionId] = useState<string | null>(null)
  const [sessionTransitionDirection, setSessionTransitionDirection] =
    useState<SessionTransitionDirection | null>(null)
  const [bartInputOpen, setBartInputOpen] = useState(false)
  const [overviewFilterFocusRequestKey, setOverviewFilterFocusRequestKey] = useState(0)
  const [threadFollowUpId, setThreadFollowUpId] = useState<string | null>(null)
  const [threadFollowUpDraft, setThreadFollowUpDraft] = useState('')
  const [threadFollowUpRequestKey, setThreadFollowUpRequestKey] = useState(0)
  const [composer] = useState(createBartComposerStore)
  const [orchestration] = useState(createOverviewOrchestrationStore)
  const overviewCameraMemory = useRef<OverviewCameraMemory['current']>(null)
  const beforeStateCommitRef = useRef<(
    current: RendererAppState, next: RendererAppState, mutation: RendererStateMutation
  ) => void>(() => {})
  const presentationResources = useHarnessPresentationResources(
    settings,
    window.openAgent.loadHarnessSettingsPresentation,
    defaultCwd
  )

  const selectedAgentId = selectedThreadId && agentThreadIds.includes(selectedThreadId)
    ? selectedThreadId : null
  const agentThreads = useRendererState((current) =>
    (!bartThreadOpen || camera.busy) && !openReportId && !selectedAgentId ? current.agentThreads : EMPTY_AGENT_THREADS
  )
  const allOverviewInputs = useMemo<HarnessOverviewThreadInput[]>(
    () => agentThreads.map((thread) => ({
      thread, displayPolicy: { hideInterventions: settings.bart.autoIntervention }
    })), [agentThreads, settings.bart.autoIntervention]
  )
  const agentCatalog = useRendererAgentCatalog()
  const catalogThreadInputs = useMemo(
    () => agentCatalog.map((thread) => ({ thread })), [agentCatalog]
  )
  const tagFilters = useMemo(() => {
    const candidates = selectOverviewItems(catalogThreadInputs, reports, overviewTaskView, [], false)
    return buildConversationTagFilters(candidates.threads, candidates.reports).map(filter => ({
      ...filter,
      count: selectOverviewItems(catalogThreadInputs, reports, overviewTaskView,
        [filter.tag, ...(filter.aliases ?? [])]).count
    }))
  }, [catalogThreadInputs, reports, overviewTaskView])
  const selectedTagFilter = useMemo(
    () => tagFilters.find((filter) => selectedTag && tagFilterMatchesSelection(filter, selectedTag)),
    [selectedTag, tagFilters]
  )
  const selectedTagValues = useMemo(
    () => selectedTagFilter ? [selectedTagFilter.tag, ...(selectedTagFilter.aliases ?? [])]
      : selectedTag ? [selectedTag] : [], [selectedTagFilter, selectedTag]
  )
  const filteredThreadInputs = useMemo(
    () => filterOverviewThreadsByTag(allOverviewInputs, selectedTagValues),
    [allOverviewInputs, selectedTagValues]
  )
  const filteredReports = useMemo(() => reports.filter(report => !selectedTagValues.length ||
    report.tags.some(tag => selectedTagValues.some(selected => tagKey(selected) === tagKey(tag)))),
    [reports, selectedTagValues])
  const openReport = openReportId
    ? reports.find((report) => report.id === openReportId)
    : undefined
  const overviewRendered = !bartThreadOpen && !camera.busy && !openReport && !selectedAgentId
  overviewRenderedRef.current = overviewRendered
  // An external route/theme change invalidates the captured scene. Settle
  // outside React commit so the destination can hand off atomically.
  useEffect(() => {
    let current = true
    queueMicrotask(() => { if (current) finishBartNavigation(getBartTarget()) })
    return () => { current = false }
  }, [selectedAgentId, openReportId, bartThreadId, settings.appearance, finishBartNavigation, getBartTarget])
  const selectedDirectoryTag = overviewRendered && selectedTagFilter?.isCwdTag
    ? selectedTagFilter.tag
    : ''
  const overviewSceneKey = [selectedTagFilter?.selectionKey || selectedTag, overviewTaskView].join('\0')
  const overviewViewRef = useRef<OverviewViewSnapshot>({
    open: overviewRendered, selectedTags: selectedTagValues, view: overviewTaskView, sceneKey: overviewSceneKey
  })
  overviewViewRef.current = {
    open: overviewRendered, selectedTags: selectedTagValues, view: overviewTaskView, sceneKey: overviewSceneKey
  }

  const followUpThreadRecord = useRendererState((current) => threadFollowUpId
    ? current.threadsById[threadFollowUpId] : undefined)
  const threadFollowUpTarget = useMemo<BartDockThreadFollowUpTarget | undefined>(() => {
    if (!threadFollowUpId) return undefined
    const thread = followUpThreadRecord
    return thread && !isBartThread(thread) && !thread.archived ? {
      threadId: thread.id,
      threadTitle: thread.title,
      provider: thread.harnessId,
      initialDraft: threadFollowUpDraft,
      requestKey: threadFollowUpRequestKey
    } : undefined
  }, [followUpThreadRecord, threadFollowUpDraft, threadFollowUpId, threadFollowUpRequestKey])

  useEffect(() => synchronizeRendererState({
    store,
    load: () => window.openAgent.loadState(),
    subscribe: listener => window.openAgent.onStateMutation(listener),
    beforeCommit: (current, next, mutation) => beforeStateCommitRef.current(current, next, mutation),
    hydrated: () => {
      setLoadError('')
      setHydrated(true)
    },
    failed: cause => { setLoadError(errorMessage(cause)); setHydrated(true) }
  }), [store])

  const beforeStateCommit = useCallback((
    current: RendererAppState, next: RendererAppState, mutation: RendererStateMutation
  ): void => {
    if (!overviewTransitionChanged(current, next, mutation)) return
    const previousDeletedIndexes = orchestration.getState().deletedIndexes
    const nextThreadIds = new Set(next.threads.map((thread) => thread.id))
    const removed = current.threads.find(
      (thread) => !isBartThread(thread) && !nextThreadIds.has(thread.id)
    )
    if (removed && !isBartThread(removed)) {
      const index = [
        ...current.threads.flatMap((thread) => isBartThread(thread)
          ? []
          : [{ id: thread.id, createdAt: thread.createdAt }]),
        ...current.reports.map((report) => ({ id: report.id, createdAt: report.createdAt }))
      ]
        .sort((left, right) => left.createdAt - right.createdAt)
        .findIndex((entry) => entry.id === removed.id)
      orchestration.setDeletedIndexes(index >= 0 ? { [removed.id]: index } : {})
    }
    const view = overviewViewRef.current
    if (view.open) {
      const before = projectOverviewAggregate(
        current,
        view,
        orchestration.getState().layoutContext,
        previousDeletedIndexes
      )
      const after = projectOverviewAggregate(
        next,
        view,
        orchestration.getState().layoutContext,
        orchestration.getState().deletedIndexes
      )
      if (before.snapshot.signature !== after.snapshot.signature) {
        const generationTargets = newGenerationTargets(mutation, after)
        orchestration.appendRevision({
          sceneKey: view.sceneKey,
          snapshot: after.snapshot,
          ...(generationTargets.length ? { generationTargets } : {})
        })
      }
    }
  }, [])
  beforeStateCommitRef.current = beforeStateCommit

  useEffect(() => {
    if (openReportId && !openReport) setOpenReportId(null)
  }, [openReport, openReportId])
  useEffect(() => {
    if (threadFollowUpId && !threadFollowUpTarget) setThreadFollowUpId(null)
  }, [threadFollowUpId, threadFollowUpTarget])
  useEffect(() => {
    for (const work of orchestration.getState().works) work.controller.abort()
    orchestration.reset()
  }, [orchestration, overviewSceneKey, overviewRendered])
  useEffect(() => () => {
    for (const work of orchestration.getState().works) work.controller.abort()
    orchestration.reset()
  }, [orchestration])

  const run = useCallback(async (operation: () => Promise<unknown>): Promise<void> => {
    reportOperationError('')
    try {
      await operation()
    } catch (cause) {
      reportOperationError(errorMessage(cause))
    }
  }, [])
  const respondToDockInteraction = useCallback(async (
    request: ThreadInteractionResponseRequest
  ): Promise<void> => {
    reportOperationError('')
    try {
      await window.openAgent.respondToThreadInteraction(request)
    } catch (cause) {
      reportOperationError(errorMessage(cause))
      throw cause
    }
  }, [])
  const followUpThread = useCallback(async (
    threadId: string,
    prompt: string
  ): Promise<void> => {
    reportOperationError('')
    try {
      const target = store.getState().threadsById[threadId]
      if (!target || (!isBartThread(target) && target.archived)) throw new Error('此 Thread 已归档，取消归档后才能追加任务。')
      await window.openAgent.followUpThread({
        threadId,
        input: { parts: [{ kind: 'text', text: prompt }] }
      })
    } catch (cause) {
      reportOperationError(errorMessage(cause))
      throw cause
    }
  }, [])
  const runSessionTransition = useCallback((
    update: () => void | Promise<void>,
    direction?: SessionTransitionDirection
  ): void => {
    const transitionDocument = document as Document & {
      startViewTransition?: (
        callback: () => void | Promise<void>
      ) => { finished: Promise<unknown> }
    }
    const root = document.documentElement
    const transitionClass = direction ? `session-transition-${direction}` : undefined
    let started = false
    root.classList.remove(...SESSION_TRANSITION_CLASSES)
    if (transitionClass) root.classList.add(transitionClass)
    const cleanup = (): void => {
      if (transitionClass) root.classList.remove(transitionClass)
      if (started) setSessionTransitionDirection(null)
    }
    if (!direction || !transitionDocument.startViewTransition) {
      void Promise.resolve(update()).finally(cleanup)
      return
    }
    try {
      flushSync(() => setSessionTransitionDirection(direction))
      started = true
      const transition = transitionDocument.startViewTransition(async () => {
        await update()
        // IPC mutations are authoritative. Flush the state queued by the
        // mutation listener before View Transition captures its new frame.
        flushSync(() => undefined)
      })
      void transition.finished.then(cleanup, cleanup)
    } catch {
      cleanup()
      void update()
    }
  }, [])
  // Main owns the appearance; the renderer only blurs the swap it performs.
  const saveSettings = useCallback((next: OpenAgentSettings): Promise<void> => {
    const apply = (): Promise<void> => window.openAgent.updateAppSettings(next)
    return next.appearance === store.getState().settings.appearance
      ? apply()
      : runThemeTransition(next.appearance, apply)
  }, [store])

  const showOverview = useCallback((focusFilter = false): void => {
    if (focusFilter) {
      setOverviewFilterFocusRequestKey((current) => current + 1)
    }
    setBartInputOpen(false)
    setThreadFollowUpId(null)
    if (!selectedAgentId && !openReport && (bartThreadOpen || camera.busy)) {
      void playBartCamera(false)
      void run(() => window.openAgent.updateUiState({ selectedThreadId: null }))
      return
    }
    finishBartNavigation(false)
    flushSync(() => setTransitionSessionId(store.getState().selectedThreadId))
    runSessionTransition(async () => {
      setOpenReportId(null)
      await run(() => window.openAgent.updateUiState({ selectedThreadId: null }))
    }, 'to-overview')
  }, [run, runSessionTransition, store, selectedAgentId, openReport, bartThreadOpen, camera.busy, playBartCamera, finishBartNavigation])
  const backToOverview = useCallback(() => showOverview(false), [showOverview])
  // 聚焦请求是一次性的：overview 消费掉就归零，避免它在别的重挂载路径上重放。
  const consumeOverviewFilterFocusRequest = useCallback((): void => {
    setOverviewFilterFocusRequestKey(0)
  }, [])
  const openThread = useCallback((threadId: string, executionId?: string): void => {
    const target = store.getState().threadsById[threadId]
    if (!target) { reportOperationError('关联 Thread 已删除，无法打开。'); return }
    setReadingTarget(executionId ? { executionId, requestId: crypto.randomUUID(),
      mode: target.observation.latestExecution?.executionId === executionId ? 'current' : 'history'
    } : undefined)
    finishBartNavigation(false)
    setBartInputOpen(false)
    setThreadFollowUpId(null)
    flushSync(() => setTransitionSessionId(threadId))
    runSessionTransition(async () => {
      setOpenReportId(null)
      await run(() => window.openAgent.updateUiState({ selectedThreadId: threadId }))
    }, 'to-thread')
  }, [run, runSessionTransition, store])
  const openReportThread = useCallback((reportId: string): void => {
    finishBartNavigation(false)
    setBartInputOpen(false)
    setThreadFollowUpId(null)
    flushSync(() => setTransitionSessionId(reportId))
    runSessionTransition(() => setOpenReportId(reportId), 'to-thread')
  }, [runSessionTransition])
  const closeReportThread = useCallback((): void => {
    if (!openReportId) return
    flushSync(() => setTransitionSessionId(openReportId))
    runSessionTransition(() => setOpenReportId(null), 'to-overview')
  }, [openReportId, runSessionTransition])
  const setBartThreadOpen = useCallback((
    open: boolean,
    readingRequest?: HarnessRendererThreadInput['readingTarget']
  ): void => {
    if (open && !store.getState().threads.some(isBartThread)) return
    // Ordinary entry is a fresh session reading: only a caller that located a
    // specific message may hand one over.
    setBartReading({ threadId: store.getState().bartThreadId, target: readingRequest })
    setBartInputOpen(false)
    setThreadFollowUpId(null)
    if (!selectedAgentId && !openReport && !settingsOpen) void playBartCamera(open)
    else finishBartNavigation(open)
  }, [store, selectedAgentId, openReport, settingsOpen, playBartCamera, finishBartNavigation])
  // Opening a reminder is a located entry: the owning Harness resolves the
  // message target it produced, and Core only carries it back.
  const openBartReply = useCallback((reply: BartDockReply): void => {
    const thread = bartThreadId ? store.getState().threadsById[bartThreadId] : undefined
    setBartThreadOpen(true, {
      executionId: reply.executionId,
      requestId: crypto.randomUUID(),
      mode: thread?.observation.latestExecution?.executionId === reply.executionId
        ? 'current' : 'history',
      ...(reply.target === undefined ? {} : { message: reply.target })
    })
  }, [bartThreadId, setBartThreadOpen, store])
  const openThreadFollowUp = useCallback((
    threadId: string,
    initialDraft = ''
  ): void => {
    if (!store.getState().threads.some((thread) => thread.id === threadId && !isBartThread(thread) && !thread.archived)) return
    setBartInputOpen(false)
    setThreadFollowUpDraft(initialDraft)
    setThreadFollowUpRequestKey((current) => current + 1)
    setThreadFollowUpId(threadId)
  }, [store])
  const closeThreadFollowUp = useCallback(() => setThreadFollowUpId(null), [])

  const chooseBartFiles = useCallback((): void => {
    void run(() => composer.chooseFiles(window.openAgent, store.getState().defaultCwd))
  }, [composer, run, store])
  const pasteBartFiles = useCallback((files: File[]): void => {
    void run(() => composer.pasteFiles(window.openAgent, files))
  }, [composer, run])
  const sendBartMessage = useCallback(async (): Promise<void> => {
    reportOperationError('')
    try { await composer.submit(window.openAgent, selectedDirectoryTag) }
    catch (cause) { reportOperationError(errorMessage(cause)); throw cause }
  }, [composer, selectedDirectoryTag])
  const cancelBart = useCallback(async (): Promise<void> => {
    if (bartExecution) await run(() => window.openAgent.cancelBartTask())
  }, [bartExecution, run])
  const clearBart = useCallback((): void => {
    if (!bartExecution) void run(() => composer.clear(window.openAgent))
  }, [bartExecution, composer, run])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (settingsOpen) return
      const modifier = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
      if (!modifier || event.isComposing) return
      if (event.key.toLocaleLowerCase() === 'b') {
        if (isFocusInNonBartTextInput()) return
        event.preventDefault()
        if (event.shiftKey) {
          if (threadFollowUpId) setThreadFollowUpId(null)
          else if (getBartTarget() || camera.busy) {
            setBartThreadOpen(false)
            setBartInputOpen(true)
          } else setBartInputOpen((current) => !current)
        } else setBartThreadOpen(!getBartTarget())
      } else if (event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        showOverview(true)
      } else if (event.key === ',') {
        event.preventDefault()
        openSettings()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [camera.busy, getBartTarget, setBartThreadOpen, showOverview, threadFollowUpId, settingsOpen, openSettings])


  const setReportArchived = useCallback((reportId: string, archived: boolean) => {
    void run(() => window.openAgent.setReportArchived(reportId, archived))
  }, [run])
  const setThreadArchived = useCallback((threadId: string, archived: boolean) => {
    void run(() => window.openAgent.setThreadArchived(threadId, archived))
  }, [run])

  if (!hydrated) {
    return (
      <AppI18nProvider
        locale={settings.locale}
        translations={harnessRendererTranslations}
      >
        <BootScreen />
      </AppI18nProvider>
    )
  }
  if (loadError || !bartThreadId) {
    return (
      <AppI18nProvider
        locale={settings.locale}
        translations={harnessRendererTranslations}
      >
        <FatalScreen error={loadError} missingBart={!bartThreadId} />
      </AppI18nProvider>
    )
  }

  return (
    <AppI18nProvider
      locale={settings.locale}
      translations={harnessRendererTranslations}
    >
      <LocalizedOperationError source={operationError}>
        {(localizedOperationError) => (
        <AppShell
          ref={camera.stageRef}
          data-bart-camera-active={camera.active || undefined}
          data-bart-camera-preparing={camera.preparing || undefined}
          data-bart-camera-inside={bartThreadOpen || undefined}
          className={[
            'app-shell',
            `platform-${window.openAgent.platform || 'unknown'}`,
            overviewRendered || camera.busy ? 'thread-overview-active' : '',
            bartThreadOpen ? 'bart-thread-active' : ''
          ].filter(Boolean).join(' ')}
          data-session-transition={sessionTransitionDirection || undefined}
        >
          <BartLiquidStage
            /* The whole workspace is the substrate the glass samples; the Dock stays
               in `children`, so the actor itself is never part of the captured tree. */
            backdrop={
              <main className="app-workspace">
                {bartThreadOpen || camera.busy ? (
                  <div data-bart-camera-session className="bart-camera-surface"
                    tabIndex={-1} inert={!bartThreadOpen || camera.active} aria-hidden={!bartThreadOpen || camera.active}
                    data-camera-hidden={!bartThreadOpen || camera.active || undefined}>
                  <SubscribedBartThreadView
                    composer={composer}
                    error={localizedOperationError}
                    execution={bartExecution}
                    key={bartThreadId}
                    onBack={backToOverview}
                    onCancel={cancelBart}
                    onChooseFiles={chooseBartFiles}
                    onClear={clearBart}
                    onPasteFiles={pasteBartFiles}
                    onRemoveAttachment={composer.removeAttachment}
                    onSettings={openSettings}
                    onSubmit={() => void sendBartMessage().catch(() => undefined)}
                    readingTarget={bartReading?.threadId === bartThreadId ? bartReading.target : undefined}
                    respond={window.openAgent.respondToThreadInteraction}
                    threadId={bartThreadId}
                  />
                  </div>
                ) : null}
                {!bartThreadOpen || camera.busy ? openReport ? (
                  <ReportThreadView
                    onBack={closeReportThread}
                    onSettings={openSettings}
                    report={openReport}
                    suppressed={settingsOpen}
                  />
                ) : selectedAgentId ? (
                  <SubscribedAgentThreadWorkspace
                    interrupt={window.openAgent.interruptThread}
                    key={selectedAgentId}
                    readingTarget={readingTarget}
                    onBack={backToOverview}
                    onFollowUp={openThreadFollowUp}
                    respond={window.openAgent.respondToThreadInteraction}
                    threadId={selectedAgentId}
                  />
                ) : (
                  <div data-bart-camera-overview className="bart-camera-surface"
                    tabIndex={-1} inert={bartThreadOpen || camera.active} aria-hidden={bartThreadOpen || camera.active}
                    data-camera-hidden={bartThreadOpen || camera.active || undefined}>
                  <SubscribedConversationOverview
                    orchestration={orchestration}
                    cameraMemory={overviewCameraMemory}
                    cameraVisible={overviewRendered && !settingsOpen}
                    embedded={false}
                    focusFilterRequestKey={overviewRendered ? overviewFilterFocusRequestKey : 0}
                    onFocusFilterRequestConsumed={consumeOverviewFilterFocusRequest}
                    followUpThreadId={threadFollowUpId}
                    initialLayoutContext={orchestration.getState().layoutContext}
                    interrupt={window.openAgent.interruptThread}
                    motionSceneKey={overviewSceneKey}
                    onGenerationMotionQueued={orchestration.enqueue}
                    onLayoutContextChange={orchestration.setLayoutContext}
                    onLayoutRevisionsConsumed={orchestration.consumeRevisions}
                    onDeletePlaceholdersConsumed={orchestration.clearDeletedIndexes}
                    onFollowUpClose={closeThreadFollowUp}
                    onFollowUpOpen={openThreadFollowUp}
                    onOpenReport={openReportThread}
                    onRestartDevelopment={undefined}
                    onSelect={openThread}
                    onSetReportArchived={setReportArchived}
                    onSettings={openSettings}
                    view={overviewTaskView}
                    onViewChange={setOverviewTaskView}
                    onOpenRelatedExecution={openThread}
                    onSetThreadArchived={setThreadArchived}
                    onTagChange={setSelectedTag}
                    reportRelationThreads={allOverviewInputs}
                    reports={filteredReports}
                    respond={window.openAgent.respondToThreadInteraction}
                    selectedTag={selectedTag}
                    tagFilters={tagFilters}
                    threads={filteredThreadInputs}
                    transitionId={transitionSessionId}
                  />
                  </div>
                ) : null}
              </main>
            }
            style={{ position: 'absolute', inset: 0 }}
          >
            <div data-bart-camera-dock inert={bartThreadOpen || camera.active} aria-hidden={bartThreadOpen || camera.active} style={{ opacity: bartThreadOpen || camera.active ? 0 : undefined }}>
            <SubscribedBartDock
              composer={composer}
              inputDisabled={false}
              inputOpen={bartInputOpen}
              onChooseFiles={chooseBartFiles}
              onInputOpenChange={setBartInputOpen}
              onInteractionResponse={respondToDockInteraction}
              onReplyOpen={openBartReply}
              onPasteFiles={pasteBartFiles}
              onRemoveBartAttachment={composer.removeAttachment}
              onSubmit={sendBartMessage}
              onThreadFollowUpClose={closeThreadFollowUp}
              onThreadFollowUpSubmit={followUpThread}
              onThreadOpenChange={setBartThreadOpen}
              passiveVisible={(overviewRendered || camera.busy) && !settingsOpen}
              presentationCovered={bartThreadOpen || camera.active}
              running={Boolean(bartExecution)}
              threadFollowUp={threadFollowUpTarget}
              threadOpen={bartThreadOpen && !camera.busy}
            />
            </div>
          </BartLiquidStage>

          <SubscribedBartThreadGenerations
            orchestration={orchestration}
            overviewOpen={overviewRendered}
            reports={reports}
            inputs={allOverviewInputs}
          />

          {localizedOperationError && !bartThreadOpen ? (
            <button
              className="operation-error-toast"
              /* The workspace is inside the stage's positioned overlay now, and a
                 positioned box paints over in-flow siblings whatever the order —
                 so this stays positioned too, or the shell's own surface hides it. */
              style={{ position: 'relative', zIndex: 1 }}
              onClick={() => reportOperationError('')}
              type="button"
            >{localizedOperationError}</button>
          ) : null}

          <HarnessSettingsPage
            origin={settingsOriginRef.current}
            activeHostHarnessId={bartHarnessId}
            bartInFlight={bartFlightActive}
            defaultCwd={defaultCwd}
            onClearHistory={() => window.openAgent.clearAllHistory()}
            onClose={closeSettings}
            onPhaseChange={onSettingsPhase}
            onSave={saveSettings}
            onSaveError={reportSettingsSaveError}
            loadHarnessInstallations={window.openAgent.detectHarnessInstallations}
            open={settingsOpen}
            resources={presentationResources}
            value={settings}
          />
          <BartCrossPageFlight direction={bartFlight} onActiveChange={onBartFlightActive}
            readyToLand={bartFlight !== 'to-dock' || !settingsOpen || settingsPhase === 'closed'} />
        </AppShell>
        )}
      </LocalizedOperationError>
    </AppI18nProvider>
  )
}

const EMPTY_AGENT_THREADS: readonly AgentThreadRecord[] = []

function BootScreen(): React.JSX.Element {
  const { t } = useI18n()
  return <main className="boot-screen"><span>{t('正在连接 Agent…')}</span></main>
}

function FatalScreen(props: {
  readonly error: string
  readonly missingBart: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="app-fatal" role="alert">
      <strong>{t('OpenAgent 状态无法加载')}</strong>
      <p>{props.error || (props.missingBart
        ? t('统一 threads 中缺少 Bart record。')
        : '')}</p>
    </div>
  )
}

function LocalizedOperationError(props: {
  readonly source: string
  readonly children: (localized: string) => ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  // IPC/native errors are provider-owned text and must remain byte-for-byte
  // visible. Only copy created by this Core component is translated here.
  const localized = props.source === ATTACHMENT_LIMIT_ERROR ||
    props.source === ATTACHMENT_IMPORT_BUSY_ERROR ||
    props.source === '此 Thread 已归档，取消归档后才能追加任务。' ||
    props.source === '关联 Thread 已删除，无法打开。'
    ? t(props.source)
    : props.source
  return <>{props.children(localized)}</>
}

function projectOverviewAggregate(
  state: RendererAppState,
  view: OverviewViewSnapshot,
  context: OverviewLayoutContext,
  deletedIndexes: Readonly<Record<string, number>>
): ProjectedOverviewAggregate {
  const inputs = state.threads.flatMap((thread): HarnessOverviewThreadInput[] =>
    isBartThread(thread) ? [] : [{
      thread, displayPolicy: { hideInterventions: state.settings.bart.autoIntervention }
    }]
  )
  const selected = selectOverviewItems(inputs, state.reports, view.view, view.selectedTags)
  const projectedThreads = selected.threads.map(input => projectHarnessOverviewThread(input, context.availableCols))
  const reports = selected.reports
  const bart = state.threads.find(isBartThread)
  const derived = deriveOverviewItems({
    threads: projectedThreads,
    reports,
    operations: bart
      ? bartVisualOperations(bart)
      : [],
    deletedIndexes,
    transitionId: null,
    layoutContext: context
  })
  return {
    snapshot: overviewLayoutSnapshot(derived),
    projectedThreads,
    items: derived.items
  }
}

function newGenerationTargets(
  mutation: RendererStateMutation,
  projection: ProjectedOverviewAggregate
): BartGenerationTarget[] {
  const target = mutation.effect?.type === 'bart-generation'
    ? mutation.effect.target
    : undefined
  if (!target) return []
  if (target.kind === 'thread') {
    const source = projection.projectedThreads.find(
      (candidate) => candidate.thread.id === target.id
    )
    return source ? [bartGenerationThreadTarget(source)] : []
  }
  const report = projection.items.find(
    (item) => item.kind === 'report' && item.report.id === target.id
  )
  return report?.kind === 'report'
    ? [bartGenerationReportTarget(report.report)]
    : []
}

function buildConversationTagFilters(
  threads: readonly HarnessOverviewThreadInput[],
  reports: readonly RendererAppState['reports'][number][]
): ConversationTagFilter[] {
  const tags = new Map<string, ConversationTagFilter & { members: Set<string> }>()
  const collect = (candidates: readonly string[], member: string, cwdKey = ''): void => {
    const seen = new Set<string>()
    for (const tag of candidates) {
      const key = tagKey(tag)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const current = tags.get(key)
      const members = current?.members || new Set<string>()
      members.add(member)
      tags.set(key, {
        tag: current?.tag || tag,
        count: members.size,
        isCwdTag: Boolean(current?.isCwdTag || key === cwdKey),
        members
      })
    }
  }
  for (const { thread } of threads) {
    const cwdTag = threadDirectoryTag(thread)
    collect([cwdTag, ...thread.tags], `thread:${thread.id}`, tagKey(cwdTag))
  }
  for (const report of reports) collect(report.tags, `report:${report.id}`)
  const membersInWideTags = new Set<string>()
  for (const filter of tags.values()) {
    if (filter.members.size <= 1) continue
    for (const member of filter.members) membersInWideTags.add(member)
  }
  const groups = new Map<string, Array<ConversationTagFilter & { members: Set<string> }>>()
  for (const filter of tags.values()) {
    if (filter.members.size === 1 && membersInWideTags.has([...filter.members][0])) continue
    const memberKey = JSON.stringify([...filter.members].sort())
    groups.set(memberKey, [...(groups.get(memberKey) || []), filter])
  }
  return [...groups.entries()].map(([selectionKey, group]) => {
    const sorted = [...group].sort(
      (left, right) => Number(right.isCwdTag) - Number(left.isCwdTag) ||
        tagKey(left.tag).localeCompare(tagKey(right.tag)) || left.tag.localeCompare(right.tag)
    )
    const [main, ...aliases] = sorted
    return {
      tag: main.tag,
      count: main.members.size,
      isCwdTag: main.isCwdTag,
      aliases: aliases.map((filter) => filter.tag).sort(),
      selectionKey: `members:${selectionKey}`
    }
  }).sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
}

function tagFilterMatchesSelection(filter: ConversationTagFilter, selectedTag: string): boolean {
  const selectedKey = tagKey(selectedTag)
  return tagKey(filter.tag) === selectedKey ||
    (filter.aliases || []).some((alias) => tagKey(alias) === selectedKey)
}

function filterOverviewThreadsByTag(
  threads: readonly HarnessOverviewThreadInput[],
  selectedTags: readonly string[]
): HarnessOverviewThreadInput[] {
  const selectedKeys = new Set(selectedTags.map(tagKey).filter(Boolean))
  if (!selectedKeys.size) return [...threads]
  return threads.filter(({ thread }) =>
    selectedKeys.has(tagKey(threadDirectoryTag(thread))) ||
    thread.tags.some((tag) => selectedKeys.has(tagKey(tag)))
  )
}

function isFocusInNonBartTextInput(): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return false
  const isTextInput = active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' ||
    active.tagName === 'SELECT' || active.isContentEditable
  return isTextInput && !active.closest('.bart-dock') && !active.closest('#bart-thread-view')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isBartThread(thread: RendererThreadRecord): thread is RendererBartThreadRecord {
  return thread.bart === true
}
