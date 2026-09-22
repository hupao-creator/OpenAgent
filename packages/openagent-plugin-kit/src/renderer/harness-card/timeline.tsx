import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Paperclip
} from 'lucide-react'
import { useI18n } from '../i18n.js'

const MarkdownBody = lazy(() => import('../components/MarkdownBody.js'))
const INITIAL_VISIBLE_ROWS = 120
const OLDER_ROW_BATCH = 100
const INITIAL_ACTIVITY_ROWS = 3
const ACTIVITY_ROW_BATCH = 48

/** A Plugin-rendered timeline slot; no role, status, or native payload crosses this boundary. */
export interface ThreadTimelineRow {
  readonly id: string
  readonly createdAt: number
  readonly node: ReactNode
}

/** Historical timeline windowing and scroll-anchor preservation over opaque row nodes. */
export function HarnessMessageTimeline(props: {
  readonly timelineKey: string
  readonly rows: readonly ThreadTimelineRow[]
  readonly toolbar?: ReactNode
  readonly emptyState?: ReactNode
  readonly className?: string
  /** Preserve reading position while an overlay owns navigation. */
  readonly suspended?: boolean
  readonly followOutput?: boolean
  readonly followKey?: string
  /** Keep history readable while retaining the explicit jump-to-latest action. */
  readonly followPaused?: boolean
  readonly onJumpToLatest?: () => void
  readonly showOlderRows?: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  const followingRef = useRef(true)
  const suspendedPosition = useRef<{ top: number; following: boolean } | undefined>(undefined)
  const [showLatest, setShowLatest] = useState(false)
  const prependAnchorRef = useRef<{ height: number; scrollTop: number } | undefined>(undefined)
  const rows = useMemo(() => orderRowsByTimeline(props.rows), [props.rows])
  const [window, setWindow] = useState({
    timelineKey: props.timelineKey,
    count: INITIAL_VISIBLE_ROWS,
    tailLength: rows.length
  })
  const currentWindow = window.timelineKey === props.timelineKey
  const visibleCount = currentWindow
    ? window.count + Math.max(0, rows.length - window.tailLength)
    : INITIAL_VISIBLE_ROWS
  const firstVisibleIndex = Math.max(0, rows.length - visibleCount)
  const visibleRows = useMemo(
    () => rows.slice(firstVisibleIndex),
    [firstVisibleIndex, rows]
  )

  useEffect(() => {
    prependAnchorRef.current = undefined
    setWindow((current) => current.timelineKey === props.timelineKey &&
      current.count === INITIAL_VISIBLE_ROWS && current.tailLength === rows.length
      ? current
      : {
          timelineKey: props.timelineKey,
          count: INITIAL_VISIBLE_ROWS,
          tailLength: rows.length
        })
  }, [props.timelineKey])

  const loadOlderRows = useCallback((): void => {
    const element = scrollRef.current
    if (element) {
      prependAnchorRef.current = { height: element.scrollHeight, scrollTop: element.scrollTop }
    }
    setWindow((current) => ({
      timelineKey: props.timelineKey,
      count: (current.timelineKey === props.timelineKey
        ? Math.max(current.count, visibleCount)
        : INITIAL_VISIBLE_ROWS) + OLDER_ROW_BATCH,
      tailLength: rows.length
    }))
  }, [props.timelineKey, rows.length, visibleCount])

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current
    const element = scrollRef.current
    if (!anchor || !element) return
    element.scrollTop = anchor.scrollTop + element.scrollHeight - anchor.height
    prependAnchorRef.current = undefined
  }, [visibleCount])

  useLayoutEffect(() => {
    if (props.suspended) {
      suspendedPosition.current = {
        top: scrollRef.current?.scrollTop ?? 0,
        following: followingRef.current
      }
      followingRef.current = false
    } else if (suspendedPosition.current) {
      if (scrollRef.current) {
        const scroll = scrollRef.current
        scroll.scrollTop = suspendedPosition.current.top
        const distance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight
        // Keep the saved reading position. Resume an existing following session
        // only if it still reaches the tail; otherwise offer the new output.
        followingRef.current = suspendedPosition.current.following && distance <= 1
        setShowLatest(distance >= 64)
      }
      suspendedPosition.current = undefined
    }
  }, [props.suspended])

  useLayoutEffect(() => {
    followingRef.current = true
    setShowLatest(false)
  }, [props.timelineKey])

  useLayoutEffect(() => {
    if (props.followPaused !== undefined) followingRef.current = !props.followPaused
  }, [props.followPaused])

  useLayoutEffect(() => {
    if (props.suspended || props.followPaused || !props.followOutput || !scrollRef.current) return
    const scroll = scrollRef.current
    if (props.followKey) followingRef.current = true
    if (!followingRef.current) return
    const focus = scroll.querySelector<HTMLElement>('[data-timeline-focus]')
    if (focus) {
      scroll.scrollTop += focus.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16
      followingRef.current = false
      setShowLatest(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= 64)
    } else {
      scroll.scrollTop = scroll.scrollHeight
      setShowLatest(false)
    }
  }, [props.timelineKey, props.followOutput, props.followKey, props.followPaused])

  useEffect(() => {
    const scroll = scrollRef.current
    const column = scroll?.querySelector('.message-column')
    if (props.suspended || !props.followOutput || !scroll || !column || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (prependAnchorRef.current) return
      if (!props.followPaused && followingRef.current) scroll.scrollTop = scroll.scrollHeight
      setShowLatest(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= 64)
    })
    observer.observe(column)
    return () => observer.disconnect()
  }, [props.followOutput, props.timelineKey, props.suspended, props.followPaused])

  return <>
    <div
      className={`message-scroll ${props.className || ''}`}
      ref={scrollRef}
      role="log"
      aria-label={t('消息时间线')}
      aria-live="off"
      onScroll={props.followOutput && !props.suspended ? (event) => {
        const scroll = event.currentTarget
        const atLatest = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64
        followingRef.current = !props.followPaused && atLatest
        setShowLatest(!atLatest)
      } : undefined}
    >
      {rows.length === 0 && !props.toolbar ? (
        props.emptyState
      ) : (
        <div className="message-column">
          {props.showOlderRows !== false && firstVisibleIndex > 0 ? (
            <button className="load-older-messages" onClick={loadOlderRows} type="button">
              {t('显示更早的 {count} 条消息', {
                count: Math.min(OLDER_ROW_BATCH, firstVisibleIndex)
              })}
            </button>
          ) : null}
          {props.toolbar}
          {!rows.length ? props.emptyState : null}
          <div className="message-list" role="list" aria-label={t('已加载消息')}>
            {visibleRows.map((row) => <Fragment key={row.id}>{row.node}</Fragment>)}
          </div>
        </div>
      )}
    </div>
    {props.followOutput && showLatest ? <button
        className="thread-detail-jump"
        type="button"
        onClick={() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
          followingRef.current = true
          setShowLatest(false)
          props.onJumpToLatest?.()
        }}
      ><ChevronDown size={13} />{t('回到最新')}</button> : null}
  </>
}

function orderRowsByTimeline(rows: readonly ThreadTimelineRow[]): ThreadTimelineRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => left.row.createdAt - right.row.createdAt || left.index - right.index)
    .map(({ row }) => row)
}

/** Historical user-message bubble; message semantics and attachments remain Plugin slots. */
export function ThreadTimelineUserMessage(props: {
  readonly id: string
  readonly children: ReactNode
  readonly steeringLabel?: ReactNode
  readonly attachments?: ReactNode
  readonly ariaPosition?: { readonly index: number; readonly total: number }
}): React.JSX.Element {
  return (
    <article
      className={'message user-message ' + (props.steeringLabel ? 'steering-message' : '')}
      data-message-id={props.id}
      role="listitem"
      aria-posinset={props.ariaPosition?.index}
      aria-setsize={props.ariaPosition?.total}
    >
      <div>
        {props.steeringLabel ? <span className="steering-label">{props.steeringLabel}</span> : null}
        <div>{props.children}</div>
        {props.attachments}
      </div>
    </article>
  )
}

/** Historical assistant row; body ordering is supplied by the concrete Plugin. */
export function ThreadTimelineAssistantMessage(props: {
  readonly id: string
  readonly mark?: ReactNode
  readonly children: ReactNode
  readonly className?: string
  readonly ariaPosition?: { readonly index: number; readonly total: number }
}): React.JSX.Element {
  return (
    <article
      className={`message assistant-message ${props.className || ''}`}
      data-message-id={props.id}
      role="listitem"
      aria-posinset={props.ariaPosition?.index}
      aria-setsize={props.ariaPosition?.total}
    >
      {props.mark}
      <div className="assistant-content">{props.children}</div>
    </article>
  )
}

export function ThreadTimelineMarkdown(props: {
  readonly children: string
  readonly streaming?: boolean
}): React.JSX.Element {
  return (
    <Suspense fallback={<div className="markdown-body markdown-fallback" aria-busy="true">{props.children}</div>}>
      <MarkdownBody content={props.children} streaming={props.streaming === true} />
    </Suspense>
  )
}

export function ThreadTimelineArtifactDisclosure(props: {
  readonly className: string
  readonly title: ReactNode
  readonly icon?: ReactNode
  readonly defaultOpen?: boolean
  readonly children: ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen === true)
  return (
    <section className={`agent-artifact ${props.className} thread-surface-artifact`}>
      <button
        className="artifact-summary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        type="button"
      >
        {props.icon}
        <strong>{props.title}</strong>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open ? <div className="artifact-body">{props.children}</div> : null}
    </section>
  )
}

export function ThreadTimelineNotice(props: {
  readonly className?: string
  readonly children: ReactNode
}): React.JSX.Element {
  return <div className={`message-notice ${props.className || ''}`}><CircleAlert size={13} />{props.children}</div>
}

export function ThreadTimelineError(props: {
  readonly children: ReactNode
}): React.JSX.Element {
  return <div className="message-error"><CircleAlert size={15} /><span>{props.children}</span></div>
}

/** Historical attachment-chip DOM over Plugin-owned attachment nodes. */
export function ThreadTimelineAttachments(props: {
  readonly children: ReactNode
}): React.JSX.Element {
  return <div className="message-attachments">{props.children}</div>
}

export function ThreadTimelineAttachment(props: {
  readonly title?: string
  readonly children: ReactNode
}): React.JSX.Element {
  return <span className="message-attachment" title={props.title}><Paperclip size={10} /> {' '}{props.children}</span>
}

/**
 * Historical activity disclosure row. Icon, state glyph/class, and labels are
 * all presentation slots chosen from Plugin-private facts.
 */
export function ThreadActivityRow(props: {
  readonly id: string
  readonly className?: string
  readonly state: ReactNode
  readonly icon?: ReactNode
  readonly label: ReactNode
  readonly detail?: ReactNode
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={`activity ${props.className || ''}`} data-activity-id={props.id}>
      <div className="activity-row">
        <button
          className="activity-summary"
          aria-expanded={props.detail ? expanded : undefined}
          onClick={() => props.detail && setExpanded((value) => !value)}
          type="button"
        >
          <span className="activity-state">{props.state}</span>
          {props.icon}
          <span className="activity-label">{props.label}</span>
          {props.detail ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
        </button>
      </div>
      {props.detail ? (
        <div className={'activity-detail-wrap' + (expanded ? ' open' : '')}>
          {expanded ? <pre className="activity-detail">{props.detail}</pre> : null}
        </div>
      ) : null}
    </div>
  )
}

export interface ThreadActivitySlot {
  readonly id: string
  readonly node: ReactNode
  /** Pure disclosure fact: keeps a live row visible while the group is folded. */
  readonly running?: boolean
}

/** Historical grouped disclosure and bounded materialization over opaque activity nodes. */
export function HarnessToolActivityGroup(props: {
  readonly groupId: string
  readonly items: readonly ThreadActivitySlot[]
  readonly summary: ReactNode
  readonly summaryLabel: string
  readonly summaryState: ReactNode
  readonly summaryClassName?: string
  readonly className?: string
  readonly defaultExpanded?: boolean
  /** Keep the same disclosure owner when a single streaming item grows into a run. */
  readonly alwaysGroup?: boolean
  /** Lets a parent hand focus back when it swaps a lone row out for this group. */
  readonly summaryRef?: RefObject<HTMLButtonElement | null>
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(props.defaultExpanded === true)
  const [materializedCount, setMaterializedCount] = useState(
    props.defaultExpanded ? Math.min(INITIAL_ACTIVITY_ROWS, props.items.length) : 0
  )
  const [eagerItemIds, setEagerItemIds] = useState<Set<string>>(() =>
    new Set(props.defaultExpanded
      ? props.items.filter((item) => item.running).map((item) => item.id)
      : [])
  )
  const bodyId = useId()
  const groupSummaryRef = useRef<HTMLButtonElement>(null)
  const assignSummaryRef = useCallback((node: HTMLButtonElement | null) => {
    groupSummaryRef.current = node
    if (props.summaryRef) props.summaryRef.current = node
  }, [props.summaryRef])
  const focusedOpaqueNodeRef = useRef<HTMLElement | null>(null)
  const toggleExpanded = useCallback(() => {
    if (expanded) {
      setExpanded(false)
      setMaterializedCount(0)
      setEagerItemIds(new Set())
    } else {
      setMaterializedCount(Math.min(INITIAL_ACTIVITY_ROWS, props.items.length))
      setEagerItemIds(new Set(
        props.items.filter((item) => item.running).map((item) => item.id)
      ))
      setExpanded(true)
    }
  }, [expanded, props.items])

  useEffect(() => {
    if (!expanded || materializedCount >= props.items.length) return
    const frame = requestAnimationFrame(() => {
      setMaterializedCount((current) => Math.min(
        props.items.length,
        current + ACTIVITY_ROW_BATCH
      ))
    })
    return () => cancelAnimationFrame(frame)
  }, [expanded, materializedCount, props.items.length])

  useLayoutEffect(() => {
    if (!expanded) return
    setEagerItemIds((current) => {
      let changed = false
      const next = new Set(current)
      for (const item of props.items) {
        if (!item.running || next.has(item.id)) continue
        next.add(item.id)
        changed = true
      }
      return changed ? next : current
    })
  }, [expanded, props.items])

  useLayoutEffect(() => {
    const focusedNode = focusedOpaqueNodeRef.current
    if (!focusedNode || focusedNode.isConnected) return
    const focusWasLost = document.activeElement === document.body ||
      !(document.activeElement instanceof HTMLElement) ||
      !document.activeElement.isConnected
    if (focusWasLost) groupSummaryRef.current?.focus()
    focusedOpaqueNodeRef.current = null
  })

  if (props.items.length === 0) return null
  if (props.items.length === 1 && !props.alwaysGroup) return <>{props.items[0].node}</>
  const pinned = props.items.filter((item) => item.running)
  const materializing = expanded && materializedCount < props.items.length
  const visible = materializing
    ? props.items.filter((item, index) => index < materializedCount || eagerItemIds.has(item.id))
    : props.items
  return (
    <section
      className={`activity-group ${props.className || ''}`}
      data-activity-group-id={props.groupId}
      onFocusCapture={(event) => {
        const target = event.target
        if (target instanceof HTMLElement && target !== groupSummaryRef.current) {
          focusedOpaqueNodeRef.current = target
        }
      }}
    >
      <button
        ref={assignSummaryRef}
        className="activity-group-summary"
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        aria-label={props.summaryLabel}
        title={props.summaryLabel}
        onClick={toggleExpanded}
      >
        <span className={`activity-group-state ${props.summaryClassName || ''}`}>
          {props.summaryState}
        </span>
        <span className="activity-group-text">{props.summary}</span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {!expanded && pinned.length ? (
        <div className="activity-group-pinned">
          {pinned.map((item) => <Fragment key={item.id}>{item.node}</Fragment>)}
        </div>
      ) : null}
      <div
        className={'activity-group-body' + (expanded ? ' open' : '')}
        id={bodyId}
        inert={!expanded}
        aria-busy={materializing || undefined}
      >
        {expanded ? (
          <div className="activity-group-rows">
            {visible.map((item) => <Fragment key={item.id}>{item.node}</Fragment>)}
          </div>
        ) : null}
      </div>
    </section>
  )
}
