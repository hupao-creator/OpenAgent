import { createContext, memo, useContext, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import { ChevronLeft, ChevronRight, Eye, EyeOff, ListFilter } from 'lucide-react'
import { useI18n } from '../i18n.js'
import { HarnessMessageTimeline, type ThreadTimelineRow } from './timeline.js'
import { formatThreadWorkDuration } from './thread-view.js'
import { threadDocumentHeading, threadDocumentSummary } from './document-summary.js'
import { useTextSwap } from './text-swap.js'
import { groupThreadExecutionRows } from './execution-process.js'
import './thread-detail.css'

const FrameContext = createContext(false)
const NavigationContext = createContext<{ readonly label: string; readonly onBack: () => void } | undefined>(undefined)
const SUBPAGE_EMOJIS = ['🌿', '🪐', '🧩', '🎨', '🦊', '🌊', '🍋', '🪁', '💡', '🌻', '🐳', '🏕️']
function subpageEmoji(id: string): string {
  let hash = 2166136261
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return SUBPAGE_EMOJIS[(hash >>> 0) % SUBPAGE_EMOJIS.length]!
}

/** Host-owned page bounds for a thread page. */
export function ThreadDetailFrame(props: {
  readonly children: ReactNode
  readonly className?: string
  readonly id?: string
  readonly style?: CSSProperties
  readonly ref?: Ref<HTMLElement>
  readonly navigation?: { readonly label: string; readonly onBack: () => void }
}): React.JSX.Element {
  const nested = useContext(FrameContext)
  const inheritedNavigation = useContext(NavigationContext)
  return <FrameContext.Provider value={true}>
    <section
      className={`${props.className ?? ''}${nested ? '' : ' thread-detail-frame'}`}
      id={props.id}
      ref={props.ref}
      style={props.style}
    ><NavigationContext.Provider value={props.navigation ?? inheritedNavigation}>{props.children}</NavigationContext.Provider></section>
  </FrameContext.Provider>
}

function ThreadPageBreadcrumb(props: {
  readonly parent: string
  readonly title: string
  readonly onBack: () => void
  readonly autoFocus?: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  return <nav className="thread-detail-breadcrumb" aria-label={t('页面路径')}>
    <button type="button" onClick={props.onBack} autoFocus={props.autoFocus} title={props.parent}>
      <ChevronLeft size={14} aria-hidden="true" /><span>{props.parent}</span>
    </button>
    <span aria-hidden="true">/</span>
    <span className="thread-detail-breadcrumb-current" aria-current="page" title={props.title}>{props.title}</span>
  </nav>
}

/** Plugins classify their own native rows and supply opaque rendered content. */
export interface ThreadDetailRow {
  readonly id: string
  readonly kind: 'user' | 'work' | 'content' | 'attention'
  readonly node: ReactNode
}

const VisibilityContext = createContext({
  userMessages: false,
  work: false,
  workTurnId: undefined as string | undefined
})

export function useThreadDetailVisibility(): {
  readonly userMessages: boolean
  readonly work: boolean
  /** Automatic expansion is limited to this turn; manual expansion covers all turns. */
  readonly workTurnId?: string
} {
  return useContext(VisibilityContext)
}

const EMPTY_THREAD_ART = String.raw`       .            *
            /\_/\
           ( o.o )       .
            > ^ <
       .-------------.
       |             |
       |   > hello   |
       |_____________|
        /___________\
`.trimEnd()

export function ThreadDetailEmptyState(): React.JSX.Element {
  const { t } = useI18n()
  return <div className="thread-detail-empty-state">
    <pre role="img" aria-label={t('一只小猫坐在电脑后面，等待新的想法。')}>{EMPTY_THREAD_ART}</pre>
  </div>
}

export interface ThreadDocumentRow extends ThreadTimelineRow {
  /** Supplied only for historical turns by the owning Harness. */
  readonly subpage?: { readonly title: string; readonly entryTitle?: string; readonly summary: ReactNode; readonly completedAt?: number }
}

/** Parsed only when its history entry is mounted by the timeline window. */
export const ThreadDocumentSummary = memo(function ThreadDocumentSummary(props: {
  readonly markdown: string
}): React.JSX.Element {
  return <>{threadDocumentSummary(props.markdown)}</>
})

/** How long a located read-in keeps retrying against an inert surface. */
const LOCATE_RETRY_MS = 4_000

/** Document layout only. Decoding, row ordering and actions belong to the Plugin. */
export function ThreadDetailSurface(props: {
  readonly threadId: string
  /**
   * Harness-resolved row: null means unavailable, omitted means current document.
   * `anchorId` is the Plugin-resolved row identity the reader should stop at; it
   * is already private-plugin knowledge, never a Core selector.
   */
  readonly readingTarget?: {
    readonly requestId: string
    readonly rowId?: string | null
    readonly anchorId?: string | null
  }
  readonly title: string
  readonly icon?: ReactNode
  readonly rows: readonly ThreadDocumentRow[]
  readonly running: boolean
  readonly runningTurnId?: string
  readonly actions?: ReactNode
  readonly emptyState?: ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const navigation = useContext(NavigationContext)
  const [history, setHistory] = useState({ threadId: props.threadId, open: false })
  const historyOpen = history.threadId === props.threadId && history.open
  const historyCount = props.rows.filter((row) => row.subpage).length
  if (history.threadId !== props.threadId) setHistory({ threadId: props.threadId, open: false })
  const [readingState, setReadingState] = useState<{
    threadId: string
    requestId?: string
    rowId?: string | null
    anchorId?: string | null
  }>(() => ({ threadId: props.threadId, ...props.readingTarget }))
  const requestChanged = readingState.threadId !== props.threadId ||
    readingState.requestId !== props.readingTarget?.requestId
  // Consume each navigation request once. Streaming updates cannot move the reader.
  const currentReading = requestChanged
    ? { threadId: props.threadId, ...props.readingTarget } : readingState
  if (requestChanged) setReadingState(currentReading)
  const opener = useRef<HTMLButtonElement | null>(null)
  const historyToggle = useRef<HTMLButtonElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const locatedRequestRef = useRef<string | undefined>(undefined)
  const selectedPage = typeof currentReading.rowId === 'string'
    ? props.rows.find((row) => row.id === currentReading.rowId && row.subpage) : undefined
  const unavailable = currentReading.rowId !== undefined && !selectedPage
  const readingPage = Boolean(selectedPage) || unavailable
  const restoreFocus = useRef(false)
  useLayoutEffect(() => {
    if (!readingPage && restoreFocus.current) {
      const target = opener.current?.isConnected ? opener.current : historyToggle.current
      target?.focus({ preventScroll: true })
      restoreFocus.current = false
    }
  }, [readingPage])
  // Locate the requested message once per request. Streaming updates, state
  // refreshes and relayouts must never move the reader a second time. The
  // camera hands this surface over while it is still `inert`, where focus is
  // refused, so the hand-over is retried until the surface accepts it — only
  // while the surface is inert, so a claim from anywhere else stands, and only
  // for as long as the anchor could still arrive.
  useLayoutEffect(() => {
    const requestId = currentReading.requestId
    if (!requestId || requestId === locatedRequestRef.current) return
    locatedRequestRef.current = requestId
    const anchorId = currentReading.anchorId
    const surface = surfaceRef.current
    if (!anchorId || !surface) return
    const deadline = performance.now() + LOCATE_RETRY_MS
    let frame = 0
    let located = false
    const locate = (): void => {
      if (!located) {
        const anchor = Array.from(surface.querySelectorAll<HTMLElement>('[data-thread-row-id]'))
          .find((element) => element.dataset.threadRowId === anchorId)
        if (anchor) {
          const scroll = anchor.closest<HTMLElement>('.message-scroll')
          if (scroll) {
            scroll.scrollTop += anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16
          }
          located = true
        }
      }
      // A history page focuses its own breadcrumb opener; the current document
      // has none, so it hands focus to the reading area instead of the composer.
      const page = readingPage
        ? undefined
        : surface.querySelector<HTMLElement>('.thread-detail-parent-page')
      if (page && document.activeElement !== page) page.focus({ preventScroll: true })
      const pending = !located ||
        (page !== undefined && document.activeElement !== page && surface.closest('[inert]') !== null)
      if (!pending || performance.now() >= deadline) return
      frame = window.requestAnimationFrame(locate)
    }
    locate()
    return () => { window.cancelAnimationFrame(frame) }
  }, [currentReading.requestId, currentReading.anchorId, readingPage])
  const closePage = (): void => {
    setReadingState({ ...currentReading, rowId: undefined })
    restoreFocus.current = true
  }
  // Keep row identities in the window while folded, so reopening does not
  // discard loaded history; only the summary nodes are left unmounted.
  const pageRows = props.rows.map((row, index) => row.subpage ? {
    ...row,
    node: historyOpen ? <button className="thread-detail-subpage-link" title={row.subpage.entryTitle ?? threadDocumentHeading(row.subpage.title).entryTitle} type="button" onClick={(event) => {
      opener.current = event.currentTarget
      setReadingState({ ...currentReading, rowId: row.id })
    }}>
      <span className="thread-detail-subpage-copy">
        <span className="thread-detail-subpage-title">{row.subpage.entryTitle ?? threadDocumentHeading(row.subpage.title).entryTitle}</span>
        <span className="thread-detail-subpage-summary">{row.subpage.summary}</span>
        {row.subpage.completedAt !== undefined ? <ThreadCompletionTime at={row.subpage.completedAt} /> : null}
      </span>
    </button> : null
  } : { ...row, node: <>
    {historyOpen && props.rows[index - 1]?.subpage ? <hr className="thread-detail-history-divider" /> : null}
    {row.node}
  </> })
  const [userMessages, setUserMessages] = useState(false)
  const title = useTextSwap<HTMLHeadingElement>(props.title)
  const [disclosure, setDisclosure] = useState<{
    threadId: string
    runningTurnId?: string
    work?: boolean
  }>({
    threadId: props.threadId,
    runningTurnId: props.runningTurnId
  })
  // Reset synchronously at execution boundaries: completed work never flashes open.
  const boundaryChanged = disclosure.threadId !== props.threadId ||
    disclosure.runningTurnId !== props.runningTurnId
  const manualWork = boundaryChanged ? undefined : disclosure.work
  const work = manualWork ?? Boolean(props.runningTurnId)
  const workTurnId = manualWork === undefined ? props.runningTurnId : undefined
  if (boundaryChanged) {
    setDisclosure({ threadId: props.threadId, runningTurnId: props.runningTurnId })
    if (disclosure.threadId !== props.threadId) setUserMessages(false)
  }
  const visibility = useMemo(() => ({
    userMessages, work, workTurnId
  }), [userMessages, work, workTurnId])
  return (
    <VisibilityContext.Provider value={visibility}>
      <div className="thread-detail thread-detail-theme" ref={surfaceRef}>
        {props.running ? <span className="thread-detail-running-indicator" role="status">{t('运行中')}</span> : null}
        <div className="thread-detail-parent-page" tabIndex={-1} inert={readingPage} style={{ height: '100%', visibility: readingPage ? 'hidden' : undefined }}>
        <HarnessMessageTimeline
          timelineKey={props.threadId}
          rows={pageRows}
          followOutput
          followPaused={historyOpen}
          showOlderRows={historyOpen}
          onJumpToLatest={() => setHistory({ threadId: props.threadId, open: false })}
          suspended={readingPage}
          followKey={props.runningTurnId}
          emptyState={props.emptyState ?? <ThreadDetailEmptyState />}
          toolbar={<>
            {navigation ? <ThreadPageBreadcrumb parent={navigation.label} title={props.title} onBack={navigation.onBack} /> : null}
            <header className="thread-detail-document">
              <div className="thread-detail-page-icon" aria-hidden="true">{props.icon ?? '📝'}</div>
              <h2 ref={title.ref} className={title.className || undefined}>{title.content}</h2>
              {props.actions ? <div className="thread-detail-plugin-actions">{props.actions}</div> : null}
            </header>
            {props.rows.length ? <div className="thread-detail-toolbar" role="group" aria-label={t('消息显示')}>
              {historyCount > 0 ? <button
                ref={historyToggle}
                className="thread-detail-history-toggle"
                aria-expanded={historyOpen}
                onClick={(event) => {
                  const scroll = event.currentTarget.closest<HTMLElement>('.message-scroll')
                  if (scroll) scroll.scrollTop = 0
                  setHistory({ threadId: props.threadId, open: !historyOpen })
                }}
                type="button"
              >
                <ChevronRight size={13} aria-hidden="true" />
                {historyCount === 1 ? t('前 1 轮对话') : t('前 {count} 轮对话', { count: historyCount })}
              </button> : null}
              <button
                aria-pressed={userMessages}
                onClick={() => setUserMessages((value) => !value)}
                type="button"
              >
                {userMessages ? <EyeOff size={12} /> : <Eye size={12} />}
                {userMessages ? t('隐藏用户消息') : t('显示用户消息')}
              </button>
              <button
                aria-pressed={work}
                onClick={() => setDisclosure({
                  threadId: props.threadId, runningTurnId: props.runningTurnId, work: !work
                })}
                type="button"
              >
                <ListFilter size={12} />
                {work ? t('收起执行过程') : t('显示执行过程')}
              </button>
            </div> : null}
          </>}
        />
        </div>
        {unavailable ? <section className="thread-detail-subpage" onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); closePage() }
        }}>
          <ThreadPageBreadcrumb parent={props.title} title={t('历史执行不可用')} onBack={closePage} autoFocus />
          <p role="alert">{t('无法找到报告关联的历史执行。')}</p>
        </section> : null}
        {selectedPage ? <ThreadHistoryPage
          key={JSON.stringify([props.threadId, currentReading.requestId, selectedPage.id])}
          threadId={props.threadId}
          parent={props.title}
          page={selectedPage}
          onBack={closePage}
        /> : null}
      </div>
    </VisibilityContext.Provider>
  )
}

/** Mounted per history visit, independently of the retained parent document. */
function ThreadHistoryPage(props: {
  readonly threadId: string
  readonly parent: string
  readonly page: ThreadDocumentRow
  readonly onBack: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [userMessages, setUserMessages] = useState(false)
  const [work, setWork] = useState(false)
  const visibility = useMemo(() => ({ userMessages, work, workTurnId: undefined }), [userMessages, work])
  return <section className="thread-detail-subpage" aria-label={props.page.subpage?.title} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); props.onBack() }
  }}>
    <VisibilityContext.Provider value={visibility}>
      <HarnessMessageTimeline
        timelineKey={`${props.threadId}:${props.page.id}`}
        rows={[props.page]}
        toolbar={<>
          <ThreadPageBreadcrumb parent={props.parent} title={props.page.subpage?.title ?? t('历史对话')} onBack={props.onBack} autoFocus />
          <header className="thread-detail-document"><div className="thread-detail-page-icon" aria-hidden="true">{subpageEmoji(props.page.id)}</div><h2>{props.page.subpage?.title}</h2></header>
          <div className="thread-detail-toolbar" role="group" aria-label={t('消息显示')}>
            <button aria-pressed={userMessages} onClick={() => setUserMessages((value) => !value)} type="button">
              {userMessages ? <EyeOff size={12} /> : <Eye size={12} />}
              {userMessages ? t('隐藏用户消息') : t('显示用户消息')}
            </button>
            <button aria-pressed={work} onClick={() => setWork((value) => !value)} type="button">
              <ListFilter size={12} />
              {work ? t('收起执行过程') : t('显示执行过程')}
            </button>
          </div>
        </>}
      />
    </VisibilityContext.Provider>
  </section>
}

export const ThreadDetailTurn = memo(function ThreadDetailTurn(props: {
  readonly id: string
  readonly rows: readonly ThreadDetailRow[]
  /** Harness-owned execution membership; grouping follows visible row order. */
  readonly executionRunIds?: ReadonlyMap<string, string>
  readonly createdAt: number
  readonly updatedAt: number
  readonly status: ReactNode
  readonly completedAt?: number
  readonly usage?: ReactNode
  readonly active: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const visibility = useThreadDetailVisibility()
  const workVisible = visibility.work &&
    (!visibility.workTurnId || visibility.workTurnId === props.id)
  const visibleRows = props.rows.filter(row =>
    (row.kind !== 'user' || visibility.userMessages) &&
    (row.kind !== 'work' || workVisible))
  const rows = props.executionRunIds
    ? groupThreadExecutionRows(visibleRows, props.executionRunIds) : visibleRows
  return (
    <section className="thread-detail-turn" data-turn-id={props.id} aria-label={t('对话轮次')}>
      {rows.map((row) => {
        return <div key={row.id} data-thread-row-id={row.id} className={`thread-detail-row thread-detail-${row.kind}`}>{row.node}</div>
      })}
      {!props.active ? <footer className="thread-detail-turn-footer">
        {props.completedAt !== undefined ? <>
          <ThreadCompletionTime at={props.completedAt} />
        </> : <><span>{props.status}</span>
        <span>·</span>
        <time dateTime={new Date(props.updatedAt).toISOString()}>
          {formatThreadTimestamp(props.updatedAt)}
        </time>
        <span>·</span>
        <span>{t('已运行 {duration}', {
          duration: formatThreadWorkDuration(props.createdAt, props.updatedAt)
        })}</span></>}
        {props.usage}
      </footer> : null}
    </section>
  )
})

/** Header, body and actions remain Plugin-owned slots, including native-only forms. */
export function ThreadDetailRequest(props: {
  readonly className?: string
  readonly children: ReactNode
}): React.JSX.Element {
  return <section className={`thread-detail-request ${props.className || ''}`} data-timeline-focus>{props.children}</section>
}

/** Fixed local calendar format; no UTC conversion or synthetic fallback time. */
export function formatThreadTimestamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function ThreadCompletionTime({ at }: { readonly at: number }): React.JSX.Element {
  const { t } = useI18n()
  return <time className="thread-detail-completed-time" aria-label={`${t('完成时间：')} ${formatThreadTimestamp(at)}`} dateTime={new Date(at).toISOString()}>{formatThreadTimestamp(at)}</time>
}

/** Counts have already been established by the owning Harness. */
export function ThreadTokenUsage(props: {
  readonly input?: number
  readonly output?: number
  readonly cached?: number
  readonly cacheWrite?: number
  readonly reasoning?: number
}): React.JSX.Element | null {
  const { t } = useI18n()
  const valid = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0
  if (!valid(props.input) || !valid(props.output)) return null
  const detail = [
    `${t('输入')}: ${props.input}`, `${t('输出')}: ${props.output}`,
    ...(valid(props.cached) ? [`${t('缓存读取')}: ${props.cached}`] : []),
    ...(valid(props.cacheWrite) ? [`${t('缓存写入')}: ${props.cacheWrite}`] : []),
    ...(valid(props.reasoning) ? [`${t('推理')}: ${props.reasoning}`] : [])
  ].join(' · ')
  return <span className="thread-detail-token-usage" tabIndex={0} title={detail} aria-label={`${props.input + props.output} tokens; ${detail}`}>
    {props.input + props.output} tokens
  </span>
}
