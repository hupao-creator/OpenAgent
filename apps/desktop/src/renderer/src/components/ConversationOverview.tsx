import type { OverviewCameraMemory } from '../overview-motion/camera'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties
} from 'react'
import { flushSync } from 'react-dom'
import { OverviewFilterTransition } from './OverviewFilterTransition'
import { OverviewFilterMotion } from '../overview-motion/filter-motion'
import { focusForKeyboardNavigation } from '../button-focus-visibility'
import {
  Archive,
  Folder,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  RotateCcw,
  Settings,
  Shrink,
} from 'lucide-react'
import type { ThreadInteractionResponseRequest } from '../../../shared/desktop-api'
import type { AgentThreadRecord } from '@openagent/contracts'
import {
  overviewRectVisibleInViewport,
  panOverviewCanvasTransform,
  zoomOverviewCanvasTransform,
  type OverviewContentBox,
  type OverviewViewportBox
} from '../../../shared/thread-overview-canvas'
import {
  clearOverviewLayoutMotionStyles,
  getOverviewCameraCockpit,
  getOverviewMotionCoordinator,
  measureOverviewCardRects,
  settleOverviewCardEntry,
  settleOverviewCardExit,
  stageOverviewLayoutMotion,
  startOverviewCardEntryAnimation,
  startOverviewCardExitAnimation,
  type OverviewStageLease
} from '../overview-motion'
import { getBartSpatialRegistry } from '../bart-motion/registry'
import type { BartVisualOperation } from '../bart-visual-operation'
import { ThreadCardAnchorProvider, ThreadCardFollowUpProvider, useI18n, type ThreadCardAnchorRegistrar } from '@openagent/plugin-kit/renderer'
import { BartLogo } from './BartLogo'
import {
  type BartGenerationTarget,
  type BartGenerationWork
} from './BartThreadGeneration'
import { ReportCard, type ReportRelatedThread } from './ReportCard'
import type { RendererReport } from '../../../shared/renderer-state-contracts'
import {
  deriveOverviewItems,
  overviewLayoutSnapshot,
  selectOverviewItems,
  type OverviewView,
  tagKey,
  type OverviewItem,
  type OverviewLayoutItem,
  type OverviewLayoutSnapshot
} from '../conversation-overview-layout'
import {
  HarnessOverviewCardHost,
  projectExecutionTokenUsage,
  projectHarnessOverviewThread,
  threadActions
} from '../harness-composition'
import {
  OVERVIEW_CARD_GEOMETRY,
  type HarnessOverviewEnvelope,
  type HarnessOverviewThread,
  type HarnessOverviewThreadInput,
  type OverviewCardSize,
  type OverviewLayoutContext
} from '@openagent/contracts/renderer'
import { providerVisualTheme } from '../provider-visual-theme'
import {
  OVERVIEW_LAYOUT_PLANNER, overviewGridPositionStyle, planOverviewSnapshot, planOverviewSnapshotAsync, type OverviewGridPosition,
  type OverviewLayoutPlanner, type OverviewLayoutPlanningState, type PlannedOverviewLayout
} from '../overview-layout-planner'
import type { LayoutPlacement } from '../overview-layout'
import { plannedOverviewMotionBeats } from '../overview-motion/planned-layout-motion'

export interface ConversationTagFilter {
  tag: string
  count: number
  isCwdTag: boolean
  /** Other spellings that select this exact member set. */
  aliases?: readonly string[]
  /** Stable identity of the member set; independent of its displayed tag. */
  selectionKey?: string
}

function tagFilterSelectionKey(filter: ConversationTagFilter): string {
  return filter.selectionKey || `tag:${tagKey(filter.tag)}`
}

function tagFilterMatchesSelection(filter: ConversationTagFilter, selectedTag: string): boolean {
  const selectedKey = tagKey(selectedTag)
  return tagKey(filter.tag) === selectedKey ||
    (filter.aliases || []).some((alias) => tagKey(alias) === selectedKey)
}

/** 同一张卡的生成工作只投递一次；后到的那份与先到的合并去重。 */
function mergeGenerationTargets(
  left: readonly BartGenerationTarget[],
  right: readonly BartGenerationTarget[]
): readonly BartGenerationTarget[] {
  if (!right.length) return left
  const merged = [...left]
  for (const target of right) {
    if (!merged.some((existing) => existing.id === target.id)) merged.push(target)
  }
  return merged
}

/** App 在 mutation 边界捕获的纯几何 revision，避免批处理吞掉 A → B → A。 */
export interface ConversationOverviewLayoutRevision {
  revision: number
  sceneKey: string
  snapshot: OverviewLayoutSnapshot
  /** 该 mutation 新建且来源为 Bart 的 thread；仅供生成动画。 */
  generationTargets?: readonly BartGenerationTarget[]
}

export interface ConversationOverviewProps {
  readonly threads: readonly HarnessOverviewThreadInput[]
  /**
   * Report Thread 卡片。与 agent thread 混合成同一条 createdAt 升序序列；
   * 先按当前视图和标签筛选，再按显式 Execution 关联收纳独立 Thread 卡片。
   */
  readonly reports?: readonly RendererReport[]
  /** 未经 tag 筛选的 Thread 输入，专供 Report 卡片解析关联列表。 */
  readonly reportRelationThreads?: readonly HarnessOverviewThreadInput[]
  onOpenReport?: (reportId: string) => void
  /** 报告卡片上的软归档/恢复入口；缺省即不渲染该入口。 */
  onSetReportArchived?: (reportId: string, archived: boolean) => void
  readonly view?: OverviewView
  /** Destination view count after its own tag choices are applied. */
  readonly archivedCount?: number
  readonly onViewChange?: (view: OverviewView) => void
  readonly onSetThreadArchived?: (threadId: string, archived: boolean) => void
  readonly onOpenRelatedExecution?: (threadId: string, executionId: string) => void
  /** Current target of the single Bart Dock follow-up route. */
  readonly followUpThreadId?: string | null
  readonly onFollowUpOpen?: (threadId: string, initialDraft?: string) => void
  readonly onFollowUpClose?: () => void
  readonly operations?: readonly BartVisualOperation[]
  readonly deletedIndexes?: Readonly<Record<string, number>>
  /** A deletion placeholder has reached the presented layout and its index is one-shot consumed. */
  readonly onDeletePlaceholdersConsumed?: () => void
  readonly interrupt: (threadId: string) => Promise<void>
  readonly respond: (request: ThreadInteractionResponseRequest) => Promise<unknown>
  readonly transitionId: string | null
  readonly tagFilters?: readonly ConversationTagFilter[]
  readonly selectedTag?: string
  /** Diagnostic override; application tag switches use spatial reflow. */
  readonly tagTransition?: 'spatial' | 'directional' | 'none'
  /** Playback rate for the spatial-motion playground; production defaults to 1. */
  readonly tagTransitionPlaybackRate?: number
  // Controls the initial filter focus.
  readonly embedded?: boolean
  readonly onTagChange?: (tag: string) => void
  readonly onSelect: (id: string) => void
  readonly onSettings?: (event: React.MouseEvent<HTMLButtonElement>) => void
  readonly onRestartDevelopment?: () => void
  /** 上次已提交的离散布局；重新进入 overview 时用它避开零宽视口的临时单列态。 */
  readonly initialLayoutContext?: OverviewLayoutContext
  /** 布局运动的场景身份；变化时立即切幕并丢弃旧场景的排队节拍。 */
  readonly motionSceneKey?: string
  /** Monotonic keyboard-focus request; unlike a boolean it supports repeated Cmd/Ctrl+K. */
  readonly focusFilterRequestKey?: number
  /** 请求已被消费；宿主借此把 key 归零，使请求保持一次性。 */
  readonly onFocusFilterRequestConsumed?: () => void
  /**
   * 请求将某个 thread 卡片滚动进可视区（Bart 生成动画开始前使用）。
   * key 变化时执行一次最小位移滚动；卡片已在视口内则不滚动。
   */
  readonly revealRequest?: { readonly id: string; readonly key: number } | null
  /** Bart 生成动画已 attach、等待生成的卡片：渲染期保持隐藏。 */
  readonly generationHiddenIds?: readonly string[]
  /** 布局 revision 展开时已按正确位置登记的 Bart 生成节拍。 */
  readonly onGenerationMotionQueued?: (work: BartGenerationWork) => void
  readonly layoutRevisions?: readonly ConversationOverviewLayoutRevision[]
  readonly onLayoutRevisionsConsumed?: (throughRevision: number) => void
  /** Reports the discrete context used by this live projection to App's mutation boundary. */
  readonly onLayoutContextChange?: (context: OverviewLayoutContext) => void
  /** Optional policy override for tests and diagnostics; production uses the compact solver. */
  readonly layoutPlanner?: OverviewLayoutPlanner
  readonly initialPlacements?: readonly LayoutPlacement[]
  readonly onLayoutPresented?: (sceneKey: string, placements: readonly LayoutPlacement[]) => void
  readonly onLayoutPlanningState?: (state: OverviewLayoutPlanningState) => void
  /** Optional preview zoom floor; default preserves the application's readable card size. */
  readonly canvasScaleFloor?: number
  /** 宿主拥有的运行期视角书签，不随 Overview 卸载。 */
  readonly cameraMemory?: OverviewCameraMemory
  /** 转场可预挂载隐藏画面，自动返回停留从真正可见时开始。 */
  readonly cameraVisible?: boolean
  /** Test/profiling hook; omitted by the application. */
  readonly onRender?: () => void
  /** Test/profiling hook; omitted by the application. */
  readonly onCardRender?: (id: string) => void
}

// FLIP 动画时长/缓动：placeholder 卸载后其余卡片从旧位置平滑过渡到新位置
/** 与历史连续生成一致：短静默窗把连续 start 合成一个全局 FIFO 批次。 */
const GENERATION_BATCH_GRACE_MS = 350
const CANVAS_WHEEL_ZOOM_INTENSITY = 0.0015
/** 空白处按下到抬起的位移上限；超过即视为拖拽平移，不再当作单击。 */
const CANVAS_BLANK_CLICK_SLOP = 4
const NO_OVERVIEW_REPORTS: readonly RendererReport[] = []
const EMPTY_CONTENT_BOX: OverviewContentBox = {
  left: 0,
  top: 0,
  width: 0,
  height: 0
}

export const ConversationOverview = memo(function ConversationOverview(props: ConversationOverviewProps): React.JSX.Element {
  const { t } = useI18n()
  props.onRender?.()
  const filterRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const tagTransitionRef = useRef({
    tag: props.selectedTag || '',
    direction: ''
  })
  const scrollRef = useRef<HTMLDivElement>(null)
  const [filterMotion] = useState(() => new OverviewFilterMotion())
  const planeRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [viewportBox, setViewportBox] = useState<OverviewViewportBox>({
    width: 0,
    height: 0
  })
  const [contentBox, setContentBox] = useState<OverviewContentBox>(EMPTY_CONTENT_BOX)
  const cameraCockpit = getOverviewCameraCockpit()
  useLayoutEffect(() => {
    cameraCockpit.setScaleFloor(props.canvasScaleFloor)
    return () => cameraCockpit.setScaleFloor()
  }, [cameraCockpit, props.canvasScaleFloor])
  const canvas = useSyncExternalStore(cameraCockpit.subscribe, cameraCockpit.getSnapshot, cameraCockpit.getSnapshot)
  // React 快照只承载就绪性 / 控制状态与落定变换；逐帧变换走
  // cameraCockpit.live 与 subscribeFrame，绝不驱动重渲染。
  const canvasPresent = Boolean(canvas)
  const canvasManual = canvas?.manual ?? false
  const [overflowAttentionCount, setOverflowAttentionCount] = useState(0)
  const overflowAttentionCountRef = useRef(0)
  const viewportBoxRef = useRef(viewportBox)
  viewportBoxRef.current = viewportBox
  const contentBoxRef = useRef(contentBox)
  contentBoxRef.current = contentBox
  const initialCameraBoundsCommittedRef = useRef(false)
  const cameraVisibleRef = useRef(props.cameraVisible !== false)
  cameraVisibleRef.current = props.cameraVisible !== false
  const saveCameraView = useCallback(() => {
    const view = cameraCockpit.live
    if (props.cameraMemory && view && cameraVisibleRef.current) {
      props.cameraMemory.current = { sceneKey: sceneKeyRef.current,
        view: { manual: view.manual, transform: { ...view.transform } } }
    }
  }, [cameraCockpit, props.cameraMemory])
  useLayoutEffect(() => {
    cameraCockpit.setVisible(props.cameraVisible !== false)
  }, [cameraCockpit, props.cameraVisible])
  /** 位置过渡动画中的卡片不响应点击激活：id → 守护截止时间戳。 */
  const cardClickBlockUntilRef = useRef<Map<string, number>>(new Map())
  const layoutAnimationsRef = useRef<Animation[]>([])
  const layoutSceneAbortRef = useRef(new AbortController())
  const pendingLayoutWorkRef = useRef(new Set<symbol>())
  const layoutMotionPendingRef = useRef(false)
  const handledRevealKeyRef = useRef<number | null>(null)
  const revealRequestRef = useRef(props.revealRequest)
  revealRequestRef.current = props.revealRequest
  const onGenerationMotionQueuedRef = useRef(props.onGenerationMotionQueued)
  onGenerationMotionQueuedRef.current = props.onGenerationMotionQueued
  const generationWorkKeyRef = useRef(0)
  const pendingGenerationTargetsRef = useRef<BartGenerationTarget[]>([])
  const generationBatchTimerRef = useRef(0)
  const [locallyPendingGenerationIds, setLocallyPendingGenerationIds] = useState<readonly string[]>([])
  const consumedLayoutRevisionRef = useRef(0)
  const deletePlaceholdersConsumedRef = useRef(props.onDeletePlaceholdersConsumed)
  deletePlaceholdersConsumedRef.current = props.onDeletePlaceholdersConsumed
  // StrictMode replays setup after cleanup. Renew the scene cancellation scope
  // before any layout effect queues work; listeners added to an already-aborted
  // signal would otherwise survive the next cut and restore stale geometry.
  useLayoutEffect(() => {
    if (layoutSceneAbortRef.current.signal.aborted) {
      // 重放前的 cleanup 已作废上一步 setup 登记的布局工作。签名占位和 pending
      // 标志必须一并撤销：否则紧随其后的重放会因签名相同而跳过登记（首屏停在
      // 空布局、没有错误也没有重试入口），被 clear 掉的 token 也再不会把
      // pending 标志降下来。本效果声明在布局效果之前，重放顺序保证先撤销后登记。
      layoutSceneAbortRef.current = new AbortController()
      lastQueuedLayoutSignatureRef.current = presentedLayoutRef.current.signature
      layoutMotionPendingRef.current = false
    }
    return () => {
      layoutSceneAbortRef.current.abort()
      pendingLayoutWorkRef.current.clear()
      for (const animation of layoutAnimationsRef.current) animation.cancel()
      layoutAnimationsRef.current = []
      clearOverviewLayoutMotionStyles(gridRef.current)
      cardClickBlockUntilRef.current.clear()
      saveCameraView()
      initialCameraBoundsCommittedRef.current = false
      cameraCockpit.dispose()
      getOverviewMotionCoordinator().resetPlaneGeometry()
    }
  }, [cameraCockpit, saveCameraView])
  const visibleTagFilters = props.tagFilters || []
  const showTagFilters = visibleTagFilters.length > 0
  const layoutPlanner = props.layoutPlanner ?? OVERVIEW_LAYOUT_PLANNER
  const availableCols = layoutPlanner.context.availableCols
  const layoutContext = useMemo<OverviewLayoutContext>(
    () => ({ availableCols }),
    [availableCols]
  )
  useLayoutEffect(() => {
    props.onLayoutContextChange?.(layoutContext)
  }, [layoutContext, props.onLayoutContextChange])
  const selectedFilter = visibleTagFilters.find(
    (filter) => props.selectedTag && tagFilterMatchesSelection(filter, props.selectedTag)
  )
  const projectedThreads = useMemo(
    () => props.threads.map((thread) => projectHarnessOverviewThread(thread, availableCols)),
    [availableCols, props.threads]
  )
  const view = props.view ?? 'default'
  const selectedTags = selectedFilter ? [selectedFilter.tag, ...(selectedFilter.aliases ?? [])]
    : props.selectedTag ? [props.selectedTag] : []
  const selectedTagsKey = JSON.stringify(selectedTags)
  const collection = useMemo(() => selectOverviewItems(projectedThreads,
    props.reports ?? NO_OVERVIEW_REPORTS, view, selectedTags),
    [projectedThreads, props.reports, view, selectedTagsKey])
  const archivedCount = useMemo(() => props.archivedCount ?? selectOverviewItems(
    projectedThreads, props.reports ?? NO_OVERVIEW_REPORTS, 'archived', selectedTags).count,
    [props.archivedCount, projectedThreads, props.reports, selectedTagsKey])
  const visibleThreads = collection.threads
  const visibleReports = collection.reports
  useEffect(() => {
    if (!props.followUpThreadId) return
    const target = visibleThreads.find(
      ({ thread }) => thread.id === props.followUpThreadId
    )
    if (!props.onFollowUpOpen || !target || target.thread.archived || observationNeedsAttention(target.thread.observation)) {
      props.onFollowUpClose?.()
    }
  }, [
    props.followUpThreadId,
    props.onFollowUpClose,
    props.onFollowUpOpen,
    visibleThreads
  ])
  const reportRelationThreads = props.reportRelationThreads ?? props.threads
  const reportRelationThreadById = useMemo(
    () => new Map(reportRelationThreads.map((source) => [source.thread.id, source])),
    [reportRelationThreads]
  )
  const generationPendingIds = useMemo(
    () => new Set([...(props.generationHiddenIds ?? []), ...locallyPendingGenerationIds]),
    [locallyPendingGenerationIds, props.generationHiddenIds]
  )
  const generationRefitSuppressedRef = useRef(generationPendingIds.size > 0)
  generationRefitSuppressedRef.current = generationPendingIds.size > 0
  const selectedTagKey = props.selectedTag || ''
  const selectedSelectionKey = selectedFilter
    ? tagFilterSelectionKey(selectedFilter)
    : selectedTagKey
  const previousSelectedTag = tagTransitionRef.current.tag
  const tagOrder = ['', ...visibleTagFilters.map(tagFilterSelectionKey)]
  const previousTagIndex = tagOrder.indexOf(previousSelectedTag)
  const selectedTagIndex = tagOrder.indexOf(selectedSelectionKey)
  if (previousSelectedTag !== selectedSelectionKey) {
    tagTransitionRef.current = {
      tag: selectedSelectionKey,
      direction:
        selectedTagIndex >= Math.max(0, previousTagIndex) ? 'tag-filter-enter-forward' : 'tag-filter-enter-backward'
    }
  }
  const tagTransitionDirection = props.tagTransition === 'directional' ? tagTransitionRef.current.direction : ''

  // 只响应显式的键盘请求（Cmd/Ctrl+K）。无条件聚焦会让筛选按钮在进入 overview 时就带上
  // :focus-visible 焦点环，并顺带点亮 :focus-within 的边框。
  // 请求是一次性的：聚焦后立刻回调归零。否则任何绕过 showOverview 的重挂载路径
  // （Cmd/Ctrl+B 开合 Bart、直接关闭 report）都会拿着陈旧的 key 再抢一次焦点。
  useLayoutEffect(() => {
    if ((props.focusFilterRequestKey ?? 0) === 0) return
    focusForKeyboardNavigation(filterRef.current?.querySelector<HTMLButtonElement>('.thread-tag-filter-option.active, button'))
    props.onFocusFilterRequestConsumed?.()
  }, [props.focusFilterRequestKey, props.onFocusFilterRequestConsumed])

  // 鼠标只有一个滚轮轴：横向溢出的标签必须让竖滚也能推动，否则只能用 Shift+滚轮。
  useLayoutEffect(() => {
    const groups = filterRef.current?.querySelector<HTMLElement>('.thread-tag-filter-groups')
    if (!groups) return
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0 || groups.scrollWidth <= groups.clientWidth) return
      event.preventDefault()
      groups.scrollLeft += event.deltaY
    }
    groups.addEventListener('wheel', onWheel, { passive: false })
    return () => groups.removeEventListener('wheel', onWheel)
  }, [showTagFilters])

  const derived = useMemo(
    () =>
      deriveOverviewItems({
        threads: visibleThreads,
        reports: visibleReports,
        operations: props.operations,
        deletedIndexes: props.deletedIndexes,
        transitionId: props.transitionId,
        layoutContext
      }),
    [
      visibleThreads,
      visibleReports,
      props.operations,
      props.deletedIndexes,
      layoutContext,
      props.transitionId
    ]
  )
  const { featuredOperation, items } = derived
  const desiredLayout = useMemo<OverviewLayoutSnapshot>(
    () => overviewLayoutSnapshot(derived),
    [derived]
  )
  const [layoutError, setLayoutError] = useState(false)
  const [presentedLayout, setPresentedLayout] = useState<PlannedOverviewLayout>(() => {
    try { return planOverviewSnapshot(desiredLayout, layoutPlanner, props.initialPlacements) }
    catch { return { ...desiredLayout, signature: '', items: [] } }
  })
  const presentedLayoutRef = useRef(presentedLayout)
  presentedLayoutRef.current = presentedLayout
  const lastQueuedLayoutSignatureRef = useRef(presentedLayout.signature)
  // 规划失败时 revision 已被标记消费，但它的生成工作还没投递。保留最后一次失败
  // 的请求，让重试按原快照连同 generationTargets 一起重新登记，而不是只重投
  // desiredLayout——那会静默丢掉卡片入场后的生成动画。
  const failedLayoutRef = useRef<{
    snapshot: OverviewLayoutSnapshot
    generationTargets: readonly BartGenerationTarget[]
  } | null>(null)
  const onLayoutPlanningStateRef = useRef(props.onLayoutPlanningState)
  onLayoutPlanningStateRef.current = props.onLayoutPlanningState
  useLayoutEffect(() => {
    if (presentedLayout.plan) onLayoutPlanningStateRef.current?.({ plan: presentedLayout.plan })
  }, [presentedLayout])
  const presentedPositions = useMemo(() => new Map(
    presentedLayout.plan?.placements.map(placement => [placement.id, placement])
  ), [presentedLayout.plan])
  // FIFO 只冻结 identity / footprint / structureKey / index；卡片语义内容
  // 始终按 id 从最新 committed Thread / Execution 投影。
  const presentedItems = useMemo(
    () => materializePresentedItems(presentedLayout.items, items),
    [items, presentedLayout.items]
  )
  const presentedCardCount = presentedItems.reduce(
    (count, item) => count + (item.kind === 'card' || item.kind === 'report' ? 1 : 0),
    0
  )
  const syncOverviewPlaneGeometry = useCallback((): void => {
    const plane = planeRef.current
    const root = plane?.closest<HTMLElement>('.app-shell') ?? plane?.closest<HTMLElement>('.thread-overview')
    if (!plane || !root) return
    const coordinator = getOverviewMotionCoordinator(), view = cameraCockpit.live
    coordinator.setCameraView(Boolean(view), view?.transform ?? { x: 0, y: 0, scale: 1 })
    coordinator.syncPlaneGeometry(root, plane)
  }, [cameraCockpit])

  // Bart 空间注册使用同一固定视口，内容位置由摄像机维护。
  useLayoutEffect(() => {
    const registry = getBartSpatialRegistry()
    registry.registerScrollContainer(scrollRef.current)
    return () => registry.registerScrollContainer(null)
  }, [])

  // 视口与内容包围盒测量：只有结构变化会改变网格外框（行高固定），因此
  // 尺寸驱动的 fit 天然只响应结构变化，内容/状态更新不触发。测量值不变时
  // 绝不调用 setState——纯内容更新不允许触发多余的渲染提交。
  const measureOverviewBoxes = useCallback((): void => {
    const scroll = scrollRef.current
    if (!scroll) return
    const nextViewport = {
      width: scroll.clientWidth,
      height: scroll.clientHeight,
      toolbarBottom: Math.max(0, (headerRef.current?.getBoundingClientRect().bottom ?? 0) - scroll.getBoundingClientRect().top)
    }
    const previousViewport = viewportBoxRef.current
    if (previousViewport.width !== nextViewport.width || previousViewport.height !== nextViewport.height ||
        previousViewport.toolbarBottom !== nextViewport.toolbarBottom) {
      viewportBoxRef.current = nextViewport
      setViewportBox(nextViewport)
    }
    const grid = gridRef.current
    const nextContent = measureOverviewContent(grid)
    const previousContent = contentBoxRef.current
    if (
      previousContent.left !== nextContent.left ||
      previousContent.top !== nextContent.top ||
      previousContent.width !== nextContent.width ||
      previousContent.height !== nextContent.height
    ) {
      contentBoxRef.current = nextContent
      setContentBox(nextContent)
    }
    if (!initialCameraBoundsCommittedRef.current && nextContent.width > 0 && nextContent.height > 0 &&
        nextViewport.width > 0 && nextViewport.height > 0) {
      initialCameraBoundsCommittedRef.current = true
      const saved = props.cameraMemory?.current
      if (saved?.sceneKey === sceneKeyRef.current) cameraCockpit.restore(saved.view, nextContent, nextViewport)
      else cameraCockpit.cutTo(nextContent, nextViewport)
    } else cameraCockpit.reconcileBounds(nextContent, nextViewport)
    syncOverviewPlaneGeometry()
    getBartSpatialRegistry().notifyLayout()
  }, [syncOverviewPlaneGeometry, cameraCockpit, props.cameraMemory])

  useLayoutEffect(() => {
    measureOverviewBoxes()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureOverviewBoxes)
    if (scrollRef.current) observer.observe(scrollRef.current)
    if (gridRef.current) observer.observe(gridRef.current)
    if (headerRef.current) observer.observe(headerRef.current)
    return () => observer.disconnect()
  }, [measureOverviewBoxes, presentedLayout.signature])

  /**
   * 处理当前 reveal 请求（canvas 态）：pan 完整落地才标记 handled；被取消或
   * 换景中止的 pan 不标记，留给下一次结构变化重试。
   */
  const performCanvasReveal = useCallback(
    async (lease: OverviewStageLease, signal: AbortSignal): Promise<void> => {
      const request = revealRequestRef.current
      if (!request || handledRevealKeyRef.current === request.key) return
      const element = findThreadElement(gridRef.current, request.id)
      if (!element) return
      const completed = await cameraCockpit.reveal(
        cardPlaneRect(element),
        contentBoxRef.current,
        viewportBoxRef.current,
        lease
      )
      if (completed && !signal.aborted) handledRevealKeyRef.current = request.key
    },
    [cameraCockpit]
  )

  const flushGenerationBatch = useCallback((): void => {
    generationBatchTimerRef.current = 0
    // 已经登记的结构 revision 必须先全部落定，确保串联中的每张目标卡都存在；
    // 这里只延后批次入队，不另建动画消费队列。
    if (pendingLayoutWorkRef.current.size > 0) {
      generationBatchTimerRef.current = window.setTimeout(flushGenerationBatch, 50)
      return
    }
    const targets = pendingGenerationTargetsRef.current.splice(0)
    const onQueued = onGenerationMotionQueuedRef.current
    if (!targets.length || !onQueued) {
      if (targets.length) {
        const ids = new Set(targets.map((target) => target.id))
        setLocallyPendingGenerationIds((current) => current.filter((id) => !ids.has(id)))
      }
      return
    }
    const ordered = [...targets].sort((left, right) => left.createdAt - right.createdAt)
    const key = ++generationWorkKeyRef.current
    const controller = new AbortController()
    const ids = new Set(ordered.map((target) => target.id))
    // 父级 work 与本地 pending 隐藏在同一次 commit 交接，卡片不会在静默窗结束
    // 与生成宿主挂载之间闪出完整内容。
    flushSync(() => {
      onQueued({
        key,
        targets: ordered,
        controller
      })
      setLocallyPendingGenerationIds((current) => current.filter((id) => !ids.has(id)))
    })
  }, [])

  const stageGenerationTargets = useCallback(
    (targets: readonly BartGenerationTarget[]): void => {
      if (!targets.length || !onGenerationMotionQueuedRef.current) return
      // 到这里这批目标才真正进入投递管线：失败快照的暂存记录交付完毕，可以作废。
      failedLayoutRef.current = null
      const existingIds = new Set(pendingGenerationTargetsRef.current.map((target) => target.id))
      const fresh = targets.filter((target) => !existingIds.has(target.id))
      if (!fresh.length) return
      pendingGenerationTargetsRef.current.push(...fresh)
      const freshIds = fresh.map((target) => target.id)
      // 布局节拍末尾的 staged inline style 即将清理；同步挂上 pending 隐藏，
      // 覆盖静默窗和全局 FIFO 等待期。
      flushSync(() => {
        setLocallyPendingGenerationIds((current) => {
          const merged = [...current]
          for (const id of freshIds) if (!merged.includes(id)) merged.push(id)
          return merged
        })
      })
      window.clearTimeout(generationBatchTimerRef.current)
      generationBatchTimerRef.current = window.setTimeout(flushGenerationBatch, GENERATION_BATCH_GRACE_MS)
    },
    [flushGenerationBatch]
  )
  useEffect(
    () => () => {
      window.clearTimeout(generationBatchTimerRef.current)
      generationBatchTimerRef.current = 0
      pendingGenerationTargetsRef.current = []
    },
    []
  )

  const playLayoutRevision = useCallback(
    async (
      snapshot: OverviewLayoutSnapshot,
      planningLease: OverviewStageLease,
      signal: AbortSignal,
      frozenGenerationTargets: readonly BartGenerationTarget[]
    ): Promise<void> => {
      if (signal.aborted) { planningLease.release(); throw abortError() }
      const previous = presentedLayoutRef.current
      let target: PlannedOverviewLayout
      try {
        // Resolve against the last presented revision only when its planning lease arrives.
        target = await planOverviewSnapshotAsync(snapshot, layoutPlanner, previous.plan?.placements ?? [], signal)
      } catch (error) {
        if (signal.aborted) { planningLease.release(); throw abortError() }
        // No verified candidate: keep the last successful geometry and let later revisions retry.
        failedLayoutRef.current = {
          snapshot,
          generationTargets: mergeGenerationTargets(
            failedLayoutRef.current?.generationTargets ?? [],
            frozenGenerationTargets
          )
        }
        setLayoutError(true)
        onLayoutPlanningStateRef.current?.({ error: error instanceof Error ? error.message : String(error) })
        planningLease.release()
        return
      }
      // 失败快照的暂存目标不在这里作废：规划成功不等于它们被投递。只有后续成功
      // 呈现真正把它们交给 stageGenerationTargets 之后，这批目标才算交付完毕。
      setLayoutError(false)
      const fromRects = measureOverviewCardRects(gridRef.current)
      const previousSizes = overviewCardSizes(previous.items)
      const nextSizes = overviewCardSizes(target.items)
      const previousCompositions = overviewCardCompositions(previous.items)
      const nextCompositions = overviewCardCompositions(target.items)
      const coordinator = getOverviewMotionCoordinator()
      type LeaseOutcome = { lease: OverviewStageLease } | { error: unknown }
      type LayoutBeat = {
        owner: string
        play: (lease: OverviewStageLease) => Promise<void>
      }
      const reserveAfter = (lease: OverviewStageLease, owners: readonly string[]): readonly Promise<LeaseOutcome>[] =>
        coordinator.reserveStagesAfter(lease, owners, signal).map((reservation) =>
          reservation.then<LeaseOutcome, LeaseOutcome>(
            (reservedLease) => ({ lease: reservedLease }),
            (error: unknown) => ({ error })
          )
        )
      const takeLease = async (reservation: Promise<LeaseOutcome>): Promise<OverviewStageLease> => {
        const outcome = await reservation
        if ('error' in outcome) throw outcome.error
        return outcome.lease
      }
      const runAnimations = async (animations: Animation[]): Promise<void> => {
        layoutAnimationsRef.current = animations
        if (!animations.length) return
        const cancel = (): void => animations.forEach((animation) => animation.cancel())
        signal.addEventListener('abort', cancel, { once: true })
        try {
          await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
        } finally {
          signal.removeEventListener('abort', cancel)
          if (layoutAnimationsRef.current === animations) layoutAnimationsRef.current = []
        }
      }
      const runAnimationBeat = async (start: () => Animation[], settle?: () => void): Promise<void> => {
        let animations: Animation[] = []
        try {
          animations = start()
          await runAnimations(animations)
          if (signal.aborted) throw abortError()
          settle?.()
        } finally {
          // settle 先把末帧写回 inline style，再取消 fill 动画，避免阶段交界跳帧。
          animations.forEach((animation) => animation.cancel())
        }
      }

      let heldLease: OverviewStageLease | null = planningLease
      try {
        const exits = [...previousSizes.keys()].flatMap((id) => {
          if (nextSizes.has(id)) return []
          const element = findOverviewCardElement(gridRef.current, id)
          return element ? [{ id, element }] : []
        })

        // revision 在 mutation 边界就已进入全局队列。轮到 planning 项后，才把
        // 可感知的退出节拍与 DOM commit 项紧邻展开到同一队列，后到的 Bart、
        // camera 和下一条 revision 不能插进本次布局变化中间。
        let commitLease = planningLease
        if (exits.length) {
          const reservations = reserveAfter(planningLease, [
            ...exits.map(({ id }) => `overview-layout:exit:${id}`),
            `overview-layout:commit:${target.signature}`
          ])
          planningLease.release()
          heldLease = null
          for (let index = 0; index < exits.length; index += 1) {
            const lease = await takeLease(reservations[index])
            heldLease = lease
            const exit = exits[index]
            try {
              await runAnimationBeat(
                () => startOverviewCardExitAnimation(exit.element, cardClickBlockUntilRef.current),
                () => settleOverviewCardExit(exit.element)
              )
            } finally {
              lease.release()
              heldLease = null
            }
          }
          commitLease = await takeLease(reservations[exits.length])
          heldLease = commitLease
        }
        if (signal.aborted) throw abortError()

        // 目标几何只有在全局队列轮到本 revision 时才提交；卡片语义内容没有
        // revision 副本，materialize 始终按 id 合并最新 committed state。
        flushSync(() => {
          presentedLayoutRef.current = target
          setPresentedLayout(target)
        })
        measureOverviewBoxes()
        const toRects = measureOverviewCardRects(gridRef.current)
        const compositionChanged = new Set(
          [...nextCompositions].flatMap(([id, composition]) =>
            previousCompositions.has(id) && previousCompositions.get(id) !== composition
              ? [id]
              : []
          )
        )
        const motionCards = stageOverviewLayoutMotion(
          gridRef.current,
          fromRects,
          toRects,
          compositionChanged
        )
        // 上一次规划失败留下的生成目标搭这趟车：它们所属的卡已经在本快照里，
        // 只是那次没规划出可用几何。卡已不在布局里说明它被删了，直接丢弃。
        const carriedTargets = (failedLayoutRef.current?.generationTargets ?? []).filter((carried) =>
          target.items.some((item) =>
            item.key === `${carried.kind === 'report' ? 'report' : 'thread'}:${carried.id}`
          )
        )
        const generationTargets = onGenerationMotionQueuedRef.current
          ? mergeGenerationTargets(frozenGenerationTargets, carriedTargets)
          : []
        const generationTargetIds = new Set(generationTargets.map((target) => target.id))
        const beats: LayoutBeat[] = []
        for (const beat of plannedOverviewMotionBeats(motionCards, target.plan!.moveOrder, cardClickBlockUntilRef.current)) {
          beats.push({ owner: beat.owner, play: async () => runAnimationBeat(beat.start, beat.settle) })
        }

        // Bart 生成就是该 thread 的入场节拍；pending 卡只建立卡位，不再额外播一
        // 次不可见的通用 fade。其余新卡仍在 reflow 后逐张入场。
        for (const entry of motionCards.filter((card) => card.inserted && !generationTargetIds.has(card.id))) {
          beats.push({
            owner: `overview-layout:entry:${entry.id}`,
            play: async () =>
              runAnimationBeat(
                () => startOverviewCardEntryAnimation(entry, cardClickBlockUntilRef.current),
                () => settleOverviewCardEntry(entry)
              )
          })
        }

        if (cameraCockpit.live) {
          const request = revealRequestRef.current
          beats.push({
            owner: `camera:reveal:${request?.id ?? 'layout'}`,
            play: async (lease) => performCanvasReveal(lease, signal)
          })
        }

        const reservations = reserveAfter(
          commitLease,
          beats.map((beat) => beat.owner)
        )
        if (!beats.length) stageGenerationTargets(generationTargets)
        commitLease.release()
        heldLease = null
        for (let index = 0; index < beats.length; index += 1) {
          const lease = await takeLease(reservations[index])
          heldLease = lease
          try {
            await beats[index].play(lease)
            if (index === beats.length - 1) stageGenerationTargets(generationTargets)
          } finally {
            lease.release()
            heldLease = null
          }
        }

        if (signal.aborted) throw abortError()
        if (target.items.some((item) => item.kind === 'placeholder')) {
          deletePlaceholdersConsumedRef.current?.()
        }
      } finally {
        heldLease?.release()
        clearOverviewLayoutMotionStyles(gridRef.current)
        cardClickBlockUntilRef.current.clear()
        getBartSpatialRegistry().notifyLayout()
      }
    },
    [
      cameraCockpit,
      measureOverviewBoxes,
      performCanvasReveal,
      layoutPlanner,
      stageGenerationTargets
    ]
  )

  const enqueueLayoutRevision = useCallback(
    (target: OverviewLayoutSnapshot, generationTargets: readonly BartGenerationTarget[] = []): boolean => {
      if (lastQueuedLayoutSignatureRef.current === target.signature) return false
      lastQueuedLayoutSignatureRef.current = target.signature
      cameraCockpit.deferRefit()
      const sceneSignal = layoutSceneAbortRef.current.signal
      const controller = new AbortController()
      const abortForSceneCut = (): void => controller.abort()
      sceneSignal.addEventListener('abort', abortForSceneCut, { once: true })
      const token = Symbol(target.signature)
      pendingLayoutWorkRef.current.add(token)
      layoutMotionPendingRef.current = true
      // acquireStage 在捕获 revision 的同一 effect 内调用：布局、Bart 与 camera
      // 的先后顺序从这一刻起只由 OverviewMotionCoordinator 的唯一 FIFO 决定。
      const planningLease = getOverviewMotionCoordinator().acquireStage(
        `overview-layout:plan:${target.signature}`,
        controller.signal
      )
      void (async () => {
        let lease: OverviewStageLease | null = null
        try {
          lease = await planningLease
          await playLayoutRevision(target, lease, controller.signal, generationTargets)
          lease = null
          if (!controller.signal.aborted) {
            cameraCockpit.reconcileBounds(
              contentBoxRef.current,
              viewportBoxRef.current
            )
          }
        } catch (error) {
          if (!isAbortError(error)) throw error
        } finally {
          lease?.release()
          controller.abort()
          sceneSignal.removeEventListener('abort', abortForSceneCut)
          // 已知取舍：finally 里的 return 会吞掉 catch 刻意重新抛出的非 abort 错误。
          // 仅发生在「token 已被他处删除」这一支，且该 IIFE 被 void 掉；改动这里的
          // 错误语义需要先覆盖该分支，否则会把无碍的提前退出变成未处理拒绝。
          // oxlint-disable-next-line eslint/no-unsafe-finally
          if (!pendingLayoutWorkRef.current.delete(token)) return
          layoutMotionPendingRef.current = pendingLayoutWorkRef.current.size > 0
          if (!sceneSignal.aborted && !layoutMotionPendingRef.current && !generationRefitSuppressedRef.current)
            cameraCockpit.requestRefit(
              contentBoxRef.current,
              viewportBoxRef.current
            )
        }
      })()
      return true
    },
    [cameraCockpit, playLayoutRevision]
  )

  const sceneKey =
    props.motionSceneKey ??
    [selectedSelectionKey, view].join('\u0000')
  const sceneKeyRef = useRef(sceneKey)
  useLayoutEffect(() => {
    if (sceneKeyRef.current === sceneKey) return
    sceneKeyRef.current = sceneKey
    if (props.cameraMemory) props.cameraMemory.current = null
    initialCameraBoundsCommittedRef.current = false
    layoutSceneAbortRef.current.abort()
    layoutSceneAbortRef.current = new AbortController()
    pendingLayoutWorkRef.current.clear()
    layoutMotionPendingRef.current = false
    for (const animation of layoutAnimationsRef.current) animation.cancel()
    layoutAnimationsRef.current = []
    clearOverviewLayoutMotionStyles(gridRef.current)
    cardClickBlockUntilRef.current.clear()
    window.clearTimeout(generationBatchTimerRef.current)
    generationBatchTimerRef.current = 0
    pendingGenerationTargetsRef.current = []
    // 切换场景是硬切断，不跨场景搬运运动。失败快照暂存的生成目标同属本场景的待投递
    // 生成工作，必须一起作废：留着它们会在新场景里给早已生成的卡补播一次生成动画。
    failedLayoutRef.current = null
    setLocallyPendingGenerationIds([])
    setLayoutError(false)
    let next: PlannedOverviewLayout
    try { next = planOverviewSnapshot(desiredLayout, layoutPlanner) }
    catch { next = { ...desiredLayout, signature: '', items: [] } }
    lastQueuedLayoutSignatureRef.current = next.signature
    presentedLayoutRef.current = next
    setPresentedLayout(next)
    if (
      Object.keys(props.deletedIndexes || {}).length &&
      !desiredLayout.items.some((item) => item.kind === 'placeholder')
    ) {
      deletePlaceholdersConsumedRef.current?.()
    }
    getOverviewMotionCoordinator().cutScene()
    queueMicrotask(() => {
      if (sceneKeyRef.current !== sceneKey || layoutSceneAbortRef.current.signal.aborted) return
      measureOverviewBoxes()
      cameraCockpit.cutTo(contentBoxRef.current, viewportBoxRef.current)
    })
  }, [cameraCockpit, desiredLayout, measureOverviewBoxes, props.deletedIndexes, props.cameraMemory, layoutPlanner, sceneKey])

  useLayoutEffect(() => {
    // A scene cut replaces the ref before this effect runs: never label old geometry as the new scene.
    if (presentedLayoutRef.current === presentedLayout && presentedLayout.plan) {
      props.onLayoutPresented?.(sceneKey, presentedLayout.plan.placements)
    }
  }, [presentedLayout, props.onLayoutPresented, sceneKey])

  useLayoutEffect(() => {
    let throughRevision = consumedLayoutRevisionRef.current
    for (const revision of props.layoutRevisions ?? []) {
      if (revision.revision <= consumedLayoutRevisionRef.current) continue
      throughRevision = Math.max(throughRevision, revision.revision)
      if (revision.sceneKey !== sceneKey) continue
      // 快照在捕获时刻已冻结；现在立即登记到全局运动 FIFO，不再进入第二套
      // 本地布局队列。
      enqueueLayoutRevision(revision.snapshot, revision.generationTargets)
    }
    if (throughRevision > consumedLayoutRevisionRef.current) {
      consumedLayoutRevisionRef.current = throughRevision
      props.onLayoutRevisionsConsumed?.(throughRevision)
    }
  }, [enqueueLayoutRevision, props.layoutRevisions, props.onLayoutRevisionsConsumed, sceneKey])

  useLayoutEffect(() => {
    enqueueLayoutRevision(desiredLayout)
  }, [desiredLayout, enqueueLayoutRevision])

  // 自动 reveal 与布局、Bart 共用舞台。手动浏览下消费请求，不抢用户视角。
  useLayoutEffect(() => {
    const request = props.revealRequest
    if (!request || handledRevealKeyRef.current === request.key) return
    // 当前 revision 会在 entry/reflow 后把 reveal 紧邻展开到全局队列。这里若
    // 同时登记，会产生重复请求。
    if (layoutMotionPendingRef.current) return
    const element = findThreadElement(gridRef.current, request.id)
    if (!element) return
    if (!canvasPresent) return
    if (canvasManual) {
      handledRevealKeyRef.current = request.key
      return
    }
    const controller = new AbortController()
    const unregisterSceneCut = getOverviewMotionCoordinator().onSceneCut(() => controller.abort())
    void (async () => {
      try {
        const lease = await getOverviewMotionCoordinator().acquireStage(
          `camera:reveal:${request.id}`,
          controller.signal
        )
        try {
          await performCanvasReveal(lease, controller.signal)
        } finally {
          lease.release()
        }
      } catch (error) {
        if (!isAbortError(error)) throw error
      }
    })()
    return () => {
      unregisterSceneCut()
      controller.abort()
    }
  }, [
    canvasManual,
    canvasPresent,
    performCanvasReveal,
    presentedLayout.signature,
    props.revealRequest,
    syncOverviewPlaneGeometry
  ])

  // 普通结构变化只在节拍排空后请求节流取景。
  useLayoutEffect(() => {
    // 布局 revision 中的 bounds 在释放最后一个动画节拍后处理，避免摄像机把
    // overview 自己的布局租约误判为 Bart 等外部连续运动链。
    if (layoutMotionPendingRef.current) return
    cameraCockpit.reconcileBounds(contentBoxRef.current, viewportBoxRef.current)
    // 非布局节拍导致的 bounds 变化（例如窗口 resize）仍需舒适带跟随；
    // 节拍提交中的测量由 runner 排空后的唯一 requestRefit 负责。
    if (
      !layoutMotionPendingRef.current &&
      pendingLayoutWorkRef.current.size === 0 &&
      !generationRefitSuppressedRef.current
    )
      cameraCockpit.requestRefit(contentBoxRef.current, viewportBoxRef.current)
  }, [cameraCockpit, contentBox, viewportBox])

  // reveal 是生成叙事的一部分：卡片交还前，环境 refit 不得把它重新移出视野。
  // 批次结束后再以最新 bounds 做一次舒适带判断。
  useLayoutEffect(() => {
    if (generationPendingIds.size > 0) {
      cameraCockpit.deferRefit()
      return
    }
    if (!layoutMotionPendingRef.current && pendingLayoutWorkRef.current.size === 0)
      cameraCockpit.requestRefit(
        contentBoxRef.current,
        viewportBoxRef.current
      )
  }, [cameraCockpit, generationPendingIds.size])

  // The plane mounts with the first card and is replaced by tag filtering.
  // Bind its actual DOM lifetime, not the lifetime of the Overview component.
  const bindPlane = useCallback((plane: HTMLDivElement) => {
    planeRef.current = plane
    const unbind = cameraCockpit.bindPlane(plane)
    return () => {
      unbind()
      if (planeRef.current === plane) planeRef.current = null
    }
  }, [cameraCockpit])
  useLayoutEffect(() => {
    saveCameraView()
    return cameraCockpit.subscribeFrame(saveCameraView)
  }, [cameraCockpit, saveCameraView])

  const returnCanvasToAuto = useCallback((): void => {
    cameraCockpit.returnToAuto(contentBoxRef.current, viewportBoxRef.current)
  }, [cameraCockpit])

  // 手动模式入口：滚轮以光标为中心连续缩放、拖拽空白平移；空白处只按不拖
  // 视作单击，交还自动视角。任一操作后视口不再自动变换。
  const canvasInteractive = canvasPresent
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || !canvasInteractive) return
    const handleWheel = (event: WheelEvent): void => {
      // Native listeners run before React bubbling; nested scrolling must opt out here.
      if (event.target instanceof Element && event.target.closest('[data-overview-native-scroll]')) return
      event.preventDefault()
      // 增量缩放的基准必须是逐帧真值；React 快照在手势期间是冻结的。
      const state = cameraCockpit.live
      if (!state) return
      const rect = scroll.getBoundingClientRect()
      const cursor = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      }
      cameraCockpit.setManualTransform(
        zoomOverviewCanvasTransform(
          state.transform,
          cursor,
          state.transform.scale * Math.exp(-event.deltaY * CANVAS_WHEEL_ZOOM_INTENSITY),
          props.canvasScaleFloor
        )
      )
    }
    let dragging = false
    let gesturePointerId: number | null = null
    let lastX = 0
    let lastY = 0
    let pressX = 0
    let pressY = 0
    let moved = false
    const handlePointerDown = (event: PointerEvent): void => {
      // 多指时第二根手指不接管手势，否则它自己的抬指会冒充空白单击。
      if (event.button !== 0 || dragging) return
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-overview-native-scroll], [data-overview-card-id], button, a, input, textarea, select')) return
      // Pointer capture keeps the pan stream on the viewport, but it does not cancel
      // Chromium's native selection gesture when the pointer crosses card text.
      event.preventDefault()
      dragging = true
      gesturePointerId = event.pointerId
      moved = false
      lastX = pressX = event.clientX
      lastY = pressY = event.clientY
      scroll.setPointerCapture(event.pointerId)
    }
    const handlePointerMove = (event: PointerEvent): void => {
      if (!dragging || event.pointerId !== gesturePointerId) return
      const deltaX = event.clientX - lastX
      const deltaY = event.clientY - lastY
      lastX = event.clientX
      lastY = event.clientY
      if (Math.abs(event.clientX - pressX) > CANVAS_BLANK_CLICK_SLOP ||
          Math.abs(event.clientY - pressY) > CANVAS_BLANK_CLICK_SLOP) moved = true
      const state = cameraCockpit.live
      if (!state) return
      cameraCockpit.setManualTransform(
        panOverviewCanvasTransform(state.transform, deltaX, deltaY)
      )
    }
    const handlePointerEnd = (event: PointerEvent, canceled = false): void => {
      if (!dragging || event.pointerId !== gesturePointerId) return
      dragging = false
      gesturePointerId = null
      if (scroll.hasPointerCapture(event.pointerId)) {
        scroll.releasePointerCapture(event.pointerId)
      }
      if (canceled || moved) return
      // 空白处单击与「回到自动视图」同一个动作；已经在自动视角时什么也不做。
      const snapshot = cameraCockpit.getSnapshot()
      if (snapshot?.manual || snapshot?.returning) returnCanvasToAuto()
    }
    const handlePointerCancel = (event: PointerEvent): void => handlePointerEnd(event, true)
    scroll.addEventListener('wheel', handleWheel, { passive: false })
    scroll.addEventListener('pointerdown', handlePointerDown)
    scroll.addEventListener('pointermove', handlePointerMove)
    scroll.addEventListener('pointerup', handlePointerEnd)
    scroll.addEventListener('pointercancel', handlePointerCancel)
    return () => {
      scroll.removeEventListener('wheel', handleWheel)
      scroll.removeEventListener('pointerdown', handlePointerDown)
      scroll.removeEventListener('pointermove', handlePointerMove)
      scroll.removeEventListener('pointerup', handlePointerEnd)
      scroll.removeEventListener('pointercancel', handlePointerCancel)
    }
  }, [cameraCockpit, canvasInteractive, props.canvasScaleFloor, returnCanvasToAuto])

  // Preserve the historical canvas overflow cue using only the public
  // waiting-for-user fact; the overview never interprets Harness-private status.
  useLayoutEffect(() => {
    const recount = (): void => {
      const state = cameraCockpit.live
      let count = 0
      if (state) {
        const elements = new Map<string, HTMLElement>()
        for (const element of gridRef.current?.querySelectorAll<HTMLElement>(
          '[data-thread-id]'
        ) ?? []) {
          if (element.dataset.threadId) elements.set(element.dataset.threadId, element)
        }
        for (const item of presentedItems) {
          if (item.kind !== 'card' ||
              !observationNeedsAttention(item.source.thread.observation)) continue
          const element = elements.get(item.source.thread.id)
          if (!element) continue
          const rect = cardPlaneRect(element)
          if (!overviewRectVisibleInViewport(
            rect,
            state.transform,
            viewportBoxRef.current
          )) count += 1
        }
      }
      if (overflowAttentionCountRef.current !== count) {
        overflowAttentionCountRef.current = count
        setOverflowAttentionCount(count)
      }
    }
    let timer = 0
    const schedule = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(recount, 120)
    }
    schedule()
    if (!canvasPresent) return () => window.clearTimeout(timer)
    const unsubscribe = cameraCockpit.subscribeFrame(schedule)
    return () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
  }, [cameraCockpit, canvasPresent, contentBox, presentedItems, viewportBox])

  const onSelectRef = useRef(props.onSelect)
  onSelectRef.current = props.onSelect
  const cardClickAllowed = useCallback((id: string): boolean => {
    const blockedUntil = cardClickBlockUntilRef.current.get(id)
    if (blockedUntil === undefined) return true
    if (Date.now() < blockedUntil) return false
    cardClickBlockUntilRef.current.delete(id)
    return true
  }, [])
  // 位置过渡动画中的卡片不响应点击激活；守护随动画结束自动失效。
  const handleCardOpen = useCallback((id: string): void => {
    if (!cardClickAllowed(id)) return
    onSelectRef.current(id)
  }, [cardClickAllowed])
  const handleFollowUpOpen = useCallback((id: string, initialDraft?: string): void => {
    if (!cardClickAllowed(id)) return
    if (initialDraft === undefined) props.onFollowUpOpen?.(id)
    else props.onFollowUpOpen?.(id, initialDraft)
  }, [cardClickAllowed, props.onFollowUpOpen])
  const handleRelatedExecutionOpen = useCallback((threadId: string, executionId: string): void => {
    if (cardClickAllowed(threadId)) props.onOpenRelatedExecution?.(threadId, executionId)
  }, [cardClickAllowed, props.onOpenRelatedExecution])
  const relatedRowsCache = useRef(new WeakMap<RendererReport, ReportRelatedThread[]>())
  const relatedRows = (report: RendererReport): ReportRelatedThread[] => {
    const next = reportRelatedThreads(report, reportRelationThreadById, t)
    const previous = relatedRowsCache.current.get(report)
    if (previous && sameRelatedThreads(previous, next)) return previous
    relatedRowsCache.current.set(report, next)
    return next
  }
  const onOpenReportRef = useRef(props.onOpenReport)
  onOpenReportRef.current = props.onOpenReport
  const handleReportOpen = useCallback((reportId: string): void => {
    if (!cardClickAllowed(reportId)) return
    onOpenReportRef.current?.(reportId)
  }, [cardClickAllowed])

  const body = (
    <>
      {layoutError && (
        <div className="overview-layout-error no-drag" role="alert">
          <span>{t('布局暂未更新，请重试。')}</span>
          <button type="button" onClick={() => {
            const failed = failedLayoutRef.current
            lastQueuedLayoutSignatureRef.current = ''
            enqueueLayoutRevision(failed?.snapshot ?? desiredLayout, failed?.generationTargets ?? [])
          }}>{t('重试')}</button>
        </div>
      )}
      <div className="thread-overview-scroll" ref={scrollRef}>
        <OverviewFilterTransition selectionKey={selectedSelectionKey} sceneKey={sceneKey}
          memberIds={desiredLayout.items.map(item => item.entityId)}
          enabled={(props.tagTransition ?? 'spatial') === 'spatial' && props.cameraVisible !== false}
          playbackRate={props.tagTransitionPlaybackRate ?? 1} viewport={scrollRef} motion={filterMotion}>
        <div className={'thread-overview-scroll-content ' + tagTransitionDirection} key={selectedSelectionKey || '__all__'}>
          {presentedItems.length === 0 ? (
            <div className="thread-overview-empty">
              <strong>{props.selectedTag
                ? t('没有 {category} 会话', { category: selectedFilter?.tag || props.selectedTag })
                : view === 'archived' ? t('没有已归档的 Thread') : t('还没有会话')}</strong>
              <span>{t('切换视图或标签筛选以查看其他 Thread。')}</span>
            </div>
          ) : (
            // plane transform 由 applyPlaneTransform 命令式维护，不经 React 渲染。
            <div className="thread-overview-plane" ref={bindPlane}>
              <div
                className={'thread-overview-grid' + (presentedLayout.plan ? ' overview-planned-grid' : '')}
                ref={gridRef}
                role="list"
                aria-label={t('会话结果，共 {count} 项', { count: presentedCardCount })}
                style={{
                  '--overview-available-cols': presentedLayout.plan
                    ? Math.max(1, presentedLayout.plan.bounds.col + presentedLayout.plan.bounds.cols)
                    : presentedLayout.availableCols,
                  '--thread-card-column-width': `${OVERVIEW_CARD_GEOMETRY.columnWidth}px`,
                  '--thread-card-row-height': `${OVERVIEW_CARD_GEOMETRY.rowHeight}px`,
                  '--thread-card-gap': `${OVERVIEW_CARD_GEOMETRY.gap}px`
                } as CSSProperties}
              >
                {presentedItems.map((item) => {
                  if (item.kind === 'geometry-placeholder') {
                    return (
                      <div
                        aria-hidden="true"
                        className="overview-grid-card overview-geometry-placeholder"
                        data-overview-card-id={item.entityId}
                        key={item.key}
                        style={{
                          '--thread-index': item.cardIndex,
                          '--thread-card-cols': item.size.cols,
                          '--thread-card-rows': item.size.rows,
                          ...overviewGridPositionStyle(presentedPositions.get(item.entityId))
                        } as CSSProperties}
                      />
                    )
                  }
                  if (item.kind === 'placeholder') {
                    return (
                      <BartOperationPlaceholder
                        cardIndex={item.cardIndex}
                        key={item.key}
                        operation={item.operation}
                        gridPosition={presentedPositions.get(`operation:${item.operation.id}`)}
                      />
                    )
                  }
                  if (item.kind === 'report') {
                    return (
                      <ReportCard
                        key={item.key}
                        report={item.report}
                        gridPosition={presentedPositions.get(item.report.id)}
                        relatedThreads={relatedRows(item.report)}
                        index={item.cardIndex}
                        totalCount={presentedCardCount}
                        transitionTarget={props.transitionId === item.report.id}
                        generationPending={generationPendingIds.has(item.report.id)}
                        onOpen={handleReportOpen}
                        onOpenThread={handleRelatedExecutionOpen}
                        onRender={props.onCardRender}
                      />
                    )
                  }
                  return (
                    <HarnessThreadOverviewCard
                      availableColumns={presentedLayout.availableCols}
                      gridPosition={presentedPositions.get(item.source.thread.id)}
                      generationPending={generationPendingIds.has(item.source.thread.id)}
                      index={item.cardIndex}
                      interrupt={props.interrupt}
                      key={item.key}
                      columns={item.size.cols}
                      rows={item.size.rows}
                      structureKey={item.structureKey}
                      operation={item.operation}
                      onOpen={handleCardOpen}
                      onFollowUpOpen={handleFollowUpOpen}
                      followUpBlocked={
                        !props.onFollowUpOpen || Boolean(item.source.thread.archived) || Boolean(props.followUpThreadId) ||
                          observationNeedsAttention(item.source.thread.observation)
                      }
                      onRender={props.onCardRender}
                      respond={props.respond}
                      source={item.source}
                      totalCount={presentedCardCount}
                      transitionTarget={item.transitionTarget}
                    />
                  )
                })}
              </div>
            </div>
          )}
        </div>
        </OverviewFilterTransition>
        {canvasPresent && overflowAttentionCount > 0 && (
          <div className="thread-overview-overflow-indicator" role="status">
            <CircleAlert size={13} />
            <span>{t('{count} 待介入', { count: overflowAttentionCount })}</span>
          </div>
        )}
      </div>
    </>
  )

  return (
    <section
      className={[
        'thread-overview',
        'overview-canvas',
        canvasManual ? 'overview-canvas-manual' : '',
        showTagFilters ? 'overview-has-tag-filters' : '',
        featuredOperation ? 'bart-managing-threads' : '',
        featuredOperation ? `bart-overview-operation-${featuredOperation.kind}` : '',
        featuredOperation ? `bart-overview-phase-${featuredOperation.phase}` : ''
      ]
        .filter(Boolean)
        .join(' ')}
      role="region"
      aria-label={t('会话俯瞰')}
    >
      <div className="thread-overview-drag-region" aria-hidden="true" />
      <div className="thread-overview-header" ref={headerRef}>
        {/* 窄布局把按钮组排在筛选栏上方，所以 DOM 就先按钮组后筛选栏——否则 Tab 会先
            扫完下面一整排筛选按钮，再跳回上方的按钮组，跟眼睛看到的顺序相反。 */}
        <div className="thread-overview-floating-chrome">
          <div
            className="thread-overview-actions no-drag"
            role="toolbar"
            aria-label={t('俯瞰视图操作')}
          >
            {canvasPresent && (canvasManual || canvas?.returning) && (
              <button className="icon-button" onClick={returnCanvasToAuto} title={t('回到自动视图')} aria-label={t('回到自动视图')}>
                <Shrink size={15} />
              </button>
            )}
            {props.onViewChange && (
              <button className={'icon-button ' + (view === 'archived' ? 'active' : '')}
                onClick={() => props.onViewChange?.(view === 'archived' ? 'default' : 'archived')}
                aria-pressed={view === 'archived'}
                title={`${t('已归档')} (${archivedCount})`}
                aria-label={t('{view}，共 {count} 张卡片', { view: t('已归档'), count: archivedCount })}>
                <Archive size={16} />
              </button>
            )}
            {props.onRestartDevelopment && (
              <button
                className="icon-button"
                onClick={props.onRestartDevelopment}
                title={t('重启 Dev Electron')}
                aria-label={t('重启 Dev Electron')}
              >
                <RotateCcw size={15} />
              </button>
            )}
            {props.onSettings && (
              <button className="icon-button" data-settings-trigger onClick={props.onSettings} title={t('设置')} aria-label={t('设置')}>
                <Settings size={15} />
              </button>
            )}
          </div>
        </div>
        {showTagFilters && (
          <div ref={filterRef} className="thread-tag-filter-bar no-drag" role="group" aria-label={t('按标签筛选')}>
            <button
              type="button"
              className={'thread-tag-filter-option thread-tag-filter-all ' + (!props.selectedTag ? 'active' : '')}
              aria-pressed={!props.selectedTag}
              onClick={() => props.onTagChange?.('')}
            >
              {t('全部')}
            </button>
            <div className="thread-tag-filter-groups">
              <div className="thread-tag-filter-group">
                <div className="thread-tag-filter-options">
                  {visibleTagFilters.map((filter) => {
                    const active = Boolean(
                      props.selectedTag && tagFilterMatchesSelection(filter, props.selectedTag)
                    )
                    const aliases = filter.aliases || []
                    const aliasHint = aliases.length
                      ? t('；别名：{aliases}', { aliases: aliases.join('、') })
                      : ''
                    return (
                      <button
                        type="button"
                        className={
                          'thread-tag-filter-option ' +
                          (active ? 'active ' : '') +
                          (filter.isCwdTag ? 'cwd' : '')
                        }
                        aria-pressed={active}
                        onClick={() => props.onTagChange?.(filter.tag)}
                        key={tagFilterSelectionKey(filter)}
                        title={`${filter.isCwdTag ? t('工作目录标签：') : ''}${filter.tag}${aliasHint}`}
                        data-aliases={aliases.length ? aliases.join(',') : undefined}
                      >
                        {filter.isCwdTag && (
                          <Folder
                            className="thread-tag-filter-cwd-icon"
                            size={11}
                            aria-hidden="true"
                          />
                        )}
                        <span>{filter.tag}</span>
                        <small>{filter.count}</small>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {body}
    </section>
  )
})

export const HarnessThreadOverviewCard = memo(function HarnessThreadOverviewCard(props: {
  readonly source: HarnessOverviewThread
  readonly columns: number
  readonly rows: number
  readonly structureKey: string
  readonly availableColumns: number
  readonly gridPosition?: OverviewGridPosition
  readonly index: number
  readonly totalCount: number
  readonly transitionTarget: boolean
  readonly generationPending: boolean
  readonly operation?: BartVisualOperation
  readonly interrupt: (threadId: string) => Promise<void>
  readonly respond: (request: ThreadInteractionResponseRequest) => Promise<unknown>
  readonly onOpen: (threadId: string) => void
  readonly followUpBlocked: boolean
  readonly onFollowUpOpen: (threadId: string, initialDraft?: string) => void
  readonly onRender?: (threadId: string) => void
  readonly onSetArchived?: (threadId: string, archived: boolean) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { thread } = props.source
  const motionEnvelope = useMemo<HarnessOverviewEnvelope>(() => ({
    footprint: { columns: props.columns, rows: props.rows },
    structureKey: props.structureKey,
    excerpt: props.source.envelope.excerpt
  }), [props.columns, props.rows, props.structureKey, props.source.envelope.excerpt])
  const openThread = useCallback(() => props.onOpen(thread.id), [props.onOpen, thread.id])
  const openFollowUp = useCallback((initialDraft?: string): void => {
    if (thread.archived) return
    if (initialDraft === undefined) props.onFollowUpOpen(thread.id)
    else props.onFollowUpOpen(thread.id, initialDraft)
  }, [props.onFollowUpOpen, thread.id, thread.archived])
  const actions = useMemo(() => threadActions({ harnessId: thread.harnessId, threadId: thread.id,
    interrupt: props.interrupt, openFollowUp, respond: props.respond
  }), [thread.harnessId, thread.id, props.interrupt, openFollowUp, props.respond])
  const providerTheme = providerVisualTheme(thread.harnessId)
  props.onRender?.(thread.id)
  const registerSemanticAnchor = useCallback<ThreadCardAnchorRegistrar>((name, measure) => {
    getBartSpatialRegistry().registerThreadAnchor(thread.id, name, measure)
  }, [thread.id])
  const registerMotionAnchor = useCallback(
    (element: HTMLElement | null): void => {
      getBartSpatialRegistry().registerThreadCard(thread.id, element, hidden => {
        element?.classList.toggle('bart-generation-target', hidden)
      })
    },
    [thread.id]
  )

  return (
    <article
      aria-posinset={props.index + 1}
      aria-setsize={props.totalCount}
      className={[
        'thread-overview-item overview-grid-card thread-card-composed',
        providerTheme.className,
        props.transitionTarget ? 'transition-target' : '',
        props.generationPending ? 'bart-generation-pending' : '',
        props.operation
          ? `bart-operated operation-${props.operation.kind} ${props.operation.phase}`
          : ''
      ].filter(Boolean).join(' ')}
      data-card-cols={props.columns}
      data-card-rows={props.rows}
      data-overview-card-id={thread.id}
      data-provider-theme={providerTheme.id}
      data-thread-id={thread.id}
      data-thread-status={overviewThreadStatus(thread.observation)}
      ref={registerMotionAnchor}
      role="listitem"
      style={{
        '--thread-index': props.index,
        '--thread-card-cols': props.columns,
        '--thread-card-rows': props.rows,
        ...overviewGridPositionStyle(props.gridPosition)
      } as CSSProperties}
    >
      {props.operation ? <BartOperationMotion /> : null}
      <button
        aria-label={t('打开 {title}，第 {position} 项，共 {total} 项', {
          title: thread.title,
          position: props.index + 1,
          total: props.totalCount
        })}
        className="thread-overview-item-open"
        onClick={openThread}
        type="button"
      />
      <ThreadCardAnchorProvider register={registerSemanticAnchor}>
        <ThreadCardFollowUpProvider onOpen={props.followUpBlocked || thread.archived ? null : openFollowUp}>
          <HarnessOverviewCardHost
            displayPolicy={props.source.displayPolicy}
            actions={actions}
            availableColumns={props.availableColumns}
            envelope={motionEnvelope}
            openThread={openThread}
            thread={thread}
          />
        </ThreadCardFollowUpProvider>
      </ThreadCardAnchorProvider>
    </article>
  )
})

function sameRelatedThreads(previous: readonly ReportRelatedThread[], next: readonly ReportRelatedThread[]): boolean {
  return previous.length === next.length && previous.every((row, index) => {
    const other = next[index]!
    return row.id === other.id && row.executionId === other.executionId && row.title === other.title &&
      row.harnessId === other.harnessId && row.running === other.running && row.missing === other.missing &&
      row.usage?.value === other.usage?.value && row.usage?.count === other.usage?.count &&
      row.usage?.suffix === other.usage?.suffix
  })
}

export function reportRelatedThreads(
  report: RendererReport,
  threads: ReadonlyMap<string, HarnessOverviewThreadInput>,
  t: (source: string) => string
): ReportRelatedThread[] {
  return report.relatedExecutions.map(({ threadId, executionId }) => {
    const source = threads.get(threadId)
    return source
      ? {
          id: threadId,
          executionId,
          title: source.thread.title,
          harnessId: source.thread.harnessId,
          usage: projectExecutionTokenUsage(source.thread, executionId),
          running: isPublicExecutionActive(source.thread.observation)
        }
      : {
          id: threadId,
          executionId,
          title: t('已删除的 Agent Thread'),
          missing: true
        }
  })
}

/**
 * Convert the public lifecycle into the small DOM vocabulary used by the
 * overview shell.  `attention` is deliberately derived from
 * `waiting-for-user`; it is not a second Plugin-owned status channel.
 */
function overviewThreadStatus(
  observation: AgentThreadRecord['observation']
): 'running' | 'attention' | 'completed' | 'failed' | 'cancelled' | undefined {
  if (observation.backgroundWork?.status === 'running') return 'running'
  switch (observation.latestExecution?.status) {
    case 'running':
      return 'running'
    case 'waiting-for-user':
      return 'attention'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'cancelled'
    case undefined:
      return undefined
  }
}

function isPublicExecutionActive(
  observation: AgentThreadRecord['observation']
): boolean {
  const status = observation.latestExecution?.status
  return status === 'running' || status === 'waiting-for-user' ||
    observation.backgroundWork?.status === 'running'
}

function observationNeedsAttention(
  observation: AgentThreadRecord['observation']
): boolean {
  return observation.latestExecution?.status === 'waiting-for-user'
}

/** 只测卡片边界；固定 UI 留白由摄像机在屏幕坐标中计算。 */
function measureOverviewContent(grid: HTMLElement | null): OverviewContentBox {
  const rects = [...(grid?.querySelectorAll<HTMLElement>('[data-overview-card-id]') ?? [])]
    .map(cardPlaneRect).filter(rect => rect.width > 0 && rect.height > 0)
  if (!rects.length) return EMPTY_CONTENT_BOX
  const left = Math.min(...rects.map(rect => rect.left))
  const top = Math.min(...rects.map(rect => rect.top))
  return { left, top,
    width: Math.max(...rects.map(rect => rect.left + rect.width)) - left,
    height: Math.max(...rects.map(rect => rect.top + rect.height)) - top }
}

/** 卡片在内容平面坐标系里的包围盒（offset 相对网格，加上网格自身偏移）。 */
function cardPlaneRect(element: HTMLElement): OverviewContentBox {
  const grid = element.closest<HTMLElement>('.thread-overview-grid')
  return {
    left: (grid?.offsetLeft ?? 0) + element.offsetLeft,
    top: (grid?.offsetTop ?? 0) + element.offsetTop,
    width: element.offsetWidth,
    height: element.offsetHeight
  }
}

type PresentedOverviewItem =
  | (Extract<OverviewItem, { readonly kind: 'card' }> & {
      readonly structureKey: string
    })
  | Extract<OverviewItem, { readonly kind: 'report' }>
  | Extract<OverviewItem, { readonly kind: 'placeholder' }>
  | {
      readonly kind: 'geometry-placeholder'
      readonly key: string
      readonly entityId: string
      readonly cardIndex: number
      readonly size: OverviewCardSize
    }

function materializePresentedItems(
  layoutItems: readonly OverviewLayoutItem[],
  latestItems: readonly OverviewItem[]
): PresentedOverviewItem[] {
  const latestThreadsById = new Map(
    latestItems.flatMap((item) =>
      item.kind === 'card' ? [[item.source.thread.id, item] as const] : []
    )
  )
  const latestReportsById = new Map(
    latestItems.flatMap((item) =>
      item.kind === 'report' ? [[item.report.id, item] as const] : []
    )
  )
  const latestPlaceholdersByKey = new Map(
    latestItems.flatMap((item) =>
      item.kind === 'placeholder' ? [[item.key, item] as const] : []
    )
  )
  return layoutItems.flatMap((layoutItem): PresentedOverviewItem[] => {
    if (layoutItem.kind === 'card') {
      const latest = latestThreadsById.get(layoutItem.entityId)
      return latest?.kind === 'card'
        ? [{
            ...latest,
            cardIndex: layoutItem.cardIndex,
            size: layoutItem.size,
            structureKey: layoutItem.structureKey
          }]
        : [{ ...layoutItem, kind: 'geometry-placeholder' }]
    }
    if (layoutItem.kind === 'report') {
      const latest = latestReportsById.get(layoutItem.entityId)
      return latest?.kind === 'report'
        ? [{ ...latest, cardIndex: layoutItem.cardIndex, size: layoutItem.size }]
        : [{ ...layoutItem, kind: 'geometry-placeholder' }]
    }
    const placeholder = latestPlaceholdersByKey.get(layoutItem.key)
    return placeholder
      ? [{ ...placeholder, cardIndex: layoutItem.cardIndex, size: layoutItem.size }]
      : [{ ...layoutItem, kind: 'geometry-placeholder' }]
  })
}

function overviewCardSizes(items: readonly OverviewLayoutItem[]): Map<string, string> {
  return new Map(
    items.map((item) => [item.entityId, `${item.size.cols}x${item.size.rows}`] as const)
  )
}

function overviewCardCompositions(items: readonly OverviewLayoutItem[]): Map<string, string> {
  return new Map(
    items.map((item) => [
      item.entityId,
      item.kind === 'card'
        ? `${item.size.cols}x${item.size.rows}\u0000${item.structureKey}`
        : `${item.size.cols}x${item.size.rows}`
    ] as const)
  )
}

/** Historical sweep/pulse layer shared by attached and detached operations. */
function BartOperationMotion(): React.JSX.Element {
  return (
    <span className="bart-operation-motion" aria-hidden="true">
      <span className="bart-operation-sweep" />
      <span className="bart-operation-pulse" />
    </span>
  )
}

function BartOperationBadge(props: {
  readonly operation: BartVisualOperation
}): React.JSX.Element {
  const { t } = useI18n()
  const StatusIcon = props.operation.phase === 'running'
    ? LoaderCircle
    : props.operation.phase === 'completed'
      ? CheckCircle2
      : CircleAlert
  return (
    <span
      className={'bart-operation-badge ' + props.operation.phase}
      title={props.operation.prompt}
    >
      <BartLogo size={11} operation={props.operation} />
      <span>{bartOperationLabel(props.operation, t)}</span>
      <StatusIcon size={11} />
    </span>
  )
}

function BartOperationPlaceholder(props: {
  readonly operation: BartVisualOperation
  readonly cardIndex: number
  readonly gridPosition?: OverviewGridPosition
}): React.JSX.Element {
  const { t } = useI18n()
  const title = props.operation.title || t('已删除的会话')
  return (
    <article
      className={
        `thread-overview-item overview-grid-card bart-operation-placeholder ` +
        `operation-${props.operation.kind} ${props.operation.phase}`
      }
      data-overview-card-id={`operation:${props.operation.id}`}
      role="listitem"
      style={{
        '--thread-index': props.cardIndex,
        '--thread-card-cols': 1,
        '--thread-card-rows': 1,
        ...overviewGridPositionStyle(props.gridPosition)
      } as CSSProperties}
    >
      <BartOperationMotion />
      <span className="thread-overview-item-head">
        <strong>{title}</strong>
      </span>
      <small>
        <BartLogo size={11} operation={props.operation} />
        <span>{t('Bart 操作')}</span>
      </small>
      <BartOperationBadge operation={props.operation} />
      <span className="thread-overview-excerpt">
        {props.operation.prompt || t('该会话已从工作区移除。')}
      </span>
    </article>
  )
}

function bartOperationLabel(
  operation: BartVisualOperation,
  t: (source: string) => string
): string {
  if (operation.phase === 'failed') return t('操作失败')
  if (operation.phase === 'cancelled') return t('操作已取消')
  const completed = operation.phase === 'completed'
  if (operation.kind === 'list') return completed ? t('会话已刷新') : t('正在刷新')
  if (operation.kind === 'start') return completed ? t('会话已创建') : t('正在创建')
  if (operation.kind === 'send') return completed ? t('任务已追加') : t('正在追加任务')
  if (operation.kind === 'status') return completed ? t('状态已更新') : t('正在检查状态')
  if (operation.kind === 'interrupt') return completed ? t('已请求停止') : t('正在停止任务')
  return completed ? t('会话已删除') : t('正在删除')
}


function abortError(): DOMException {
  return new DOMException('Overview layout beat cancelled', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function findThreadElement(root: Element | null, id: string): HTMLElement | undefined {
  if (!root) return undefined
  return Array.from(root.querySelectorAll<HTMLElement>('[data-thread-id]')).find(
    (element) => element.dataset.threadId === id
  )
}

function findOverviewCardElement(root: Element | null, id: string): HTMLElement | undefined {
  if (!root) return undefined
  return Array.from(root.querySelectorAll<HTMLElement>('[data-overview-card-id]')).find(
    (element) => element.dataset.overviewCardId === id
  )
}
