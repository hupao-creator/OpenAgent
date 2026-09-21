import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { getBartSpatialRegistry } from '../bart-motion/registry'
import { getBartPresenceCoordinator } from '../bart-motion/presence'
import { getOverviewCameraCockpit, getOverviewMotionCoordinator } from '../overview-motion'
import {
  clipRect,
  createDockAvoidanceGate,
  dockAutoTransitionDuration,
  dockBodyIsFree,
  dockTargetsAreOscillating,
  DOCK_AUTO_MOVE_COOLDOWN_MS,
  nudgeDockPlacement,
  resolveDockPlacement,
  resolveDockOcclusion,
  resolveDockAvoidanceGate,
  type DockAvoidanceGate,
  type DockObstacle,
  type DockPlacementInput,
  type DockRect
} from './bart-dock-placement'
import { ArrowUp, History, PenLine, Plus } from 'lucide-react'
import {
  BART_CAPSULE_ATTACHMENT_HEIGHT,
  BART_CAPSULE_EXIT_MS,
  BART_CAPSULE_INSET,
  BART_CAPSULE_LINE_HEIGHT,
  BART_CAPSULE_MIN_LINES,
  bartCapsuleHeight,
  bartCapsuleLines
} from '../bart-composer-geometry'
import type { BartDraftAttachment } from '../../../shared/attachments'
import type { ThreadInteractionResponseRequest } from '../../../shared/desktop-api'
import type { BartVisualOperation } from '../bart-visual-operation'
import type { JsonValue } from '@openagent/contracts'
import type { HarnessBartActivity } from '@openagent/contracts/renderer'
import { extractPastePayload, insertTextAtSelection } from '../composer-paste'
import { isBartDraftSubmittable } from '../composer-draft'
import {
  useInteractionAnswers,
  type InteractionAnswerState,
  type InteractionQuestionSpec
} from '@openagent/plugin-kit/renderer'
import {
  BartLogo,
  type BartLogoActivity,
  type BartInterventionVisualState,
  type BartLogoLayout,
  type BartLogoPhase
} from './BartLogo'
import { AttachmentChips } from './AttachmentChips'
import { BartRoleDecoration } from './BartRoleDecoration'
import type { BartReasoningOptions } from '../bart-motion/reasoning-geometry'
import { BartReplyBadge } from './BartReplyBadge'
import { markBartReplyRead, useBartReplyRead } from '../bart-reply-read-state'
import { resolveBartRole } from '../bart-role'
import { useWindowVisible } from '../window-presence'
import { useBartDisplay, type BartActivityContext, type BartDisplayTiming } from '../use-bart-display'
import { ProviderLogo } from './ProviderLogo'
import { useI18n } from '@openagent/plugin-kit/renderer'
import './BartDock.css'

export interface BartDockInteractionRequest {
  threadId: string
  threadTitle: string
  intervention: BartDockIntervention
}

/** The latest successful final answer the Dock may remind the user about. */
export interface BartDockReply {
  /** Stable identity of the answer; a new identity is a new reminder. */
  readonly id: string
  /** Read-record key: Bart thread + Harness + reply identity. */
  readonly readKey: string
  /** Bounded excerpt; the bubble never streams the answer. */
  readonly excerpt: string
  /** Execution that produced the answer, for the navigation request. */
  readonly executionId: string
  /** Harness-produced navigation target; Core only carries it back untouched. */
  readonly target?: JsonValue
}

export interface BartDockThreadFollowUpTarget {
  threadId: string
  threadTitle: string
  provider: string
  initialDraft: string
  requestKey: number
}

interface BartDockIntervention {
  id: string
  title: string
  detail?: string
  actions: Array<{
    id: string
    label: string
    intent?: 'allow' | 'deny' | 'submit' | 'cancel'
  }>
  questions?: InteractionQuestionSpec[]
  submitActionId?: string
}

type BartDockInteractionResponse = (
  request: ThreadInteractionResponseRequest
) => void | Promise<void>

interface BartInterventionMeta {
  responseStatus: 'pending' | 'responded' | 'fallback'
  action?: 'allow' | 'deny' | 'submit' | 'cancel'
  sourceConversationId: string
  sourceRunId: string
  interactionId: string
  respondedAt?: number
}

interface BartDockProps {
  activityContext: BartActivityContext
  displayTiming?: BartDisplayTiming
  /** Lab comparison overrides; the application uses the locked defaults. */
  reasoningOptions?: BartReasoningOptions
  threadOpen: boolean
  passiveVisible?: boolean
  /** The parent camera currently covers the mounted Dock. */
  presentationCovered?: boolean
  reply?: BartDockReply | null
  sessionIdle: boolean
  inputOpen: boolean
  inputValue: string
  bartAttachments: readonly BartDraftAttachment[]
  inputDisabled?: boolean
  submitting?: boolean
  operations?: readonly BartVisualOperation[]
  foregroundActivity?: HarnessBartActivity | null
  running?: boolean
  intervention?: BartInterventionMeta
  interaction?: BartDockInteractionRequest
  threadFollowUp?: BartDockThreadFollowUpTarget
  onThreadOpenChange: (open: boolean) => void
  onInputOpenChange: (open: boolean) => void
  onInputChange: (value: string) => void
  onReplyOpen?: (reply: BartDockReply) => void
  onChooseFiles: () => void
  onPasteFiles?: (files: File[]) => void
  onRemoveBartAttachment: (id: string) => void
  onSubmit: () => void | Promise<void>
  onInteractionResponse?: BartDockInteractionResponse
  onThreadFollowUpClose?: () => void
  onThreadFollowUpSubmit?: (threadId: string, prompt: string) => Promise<void>
}

interface DockPosition {
  left: number
  top: number
}

interface DockDrag {
  pointerId: number
  startX: number
  startY: number
  originLeft: number
  originTop: number
  moved: boolean
}

const DOCK_POSITION_STORAGE_KEY = 'openagent.bart-dock-position.v3'
const DOCK_EDGE_GAP = 8
const DOCK_COLLISION_CLEARANCE = 12
const DOCK_AVOIDANCE_DEBOUNCE_MS = 80
const DOCK_BUSY_RETRY_MS = 120
const DOCK_BUSY_RETRY_LIMIT = 4
const DOCK_OSCILLATION_SILENCE_MS = 5_000
const BART_INTERVENTION_RESULT_MS = 1_800

type DockMotion = 'auto' | 'drag' | 'none'
/** The Dock's two inline composers; only one of them is ever present. */
type CapsuleKind = 'draft' | 'follow-up'

/**
 * How long the capsule takes to collapse back into the Dock, read from the
 * stylesheet: the animation and this timer have to agree, and the motion is what
 * decides how long it takes. The Dock runs that animation — it is what carries
 * Bart on the way down — so the duration is read from the Dock and the capsule
 * inherits it.
 */
function capsuleExitDuration(dock: HTMLElement | null): number {
  const declared = Number.parseFloat(
    dock ? getComputedStyle(dock).getPropertyValue('--bart-dock-capsule-exit-duration') : ''
  )
  return Number.isFinite(declared) && declared > 0 ? declared : BART_CAPSULE_EXIT_MS
}
const subscribeDockPresence = (listener: () => void): (() => void) =>
  getBartPresenceCoordinator().subscribeDockVisibility(listener)
const dockIsVisible = (): boolean => !getBartPresenceCoordinator().isDockHidden
/** Persistent Bart character, unread reply badge, and input capsule. */
export const BartDock = memo(function BartDock({
  activityContext,
  displayTiming,
  reasoningOptions,
  threadOpen,
  passiveVisible = true,
  presentationCovered = false,
  reply,
  sessionIdle,
  inputOpen,
  inputValue,
  bartAttachments,
  inputDisabled = false,
  submitting = false,
  operations,
  foregroundActivity,
  running = false,
  intervention,
  interaction,
  threadFollowUp,
  onThreadOpenChange,
  onInputOpenChange,
  onInputChange,
  onReplyOpen,
  onChooseFiles,
  onPasteFiles,
  onRemoveBartAttachment,
  onSubmit,
  onInteractionResponse,
  onThreadFollowUpClose,
  onThreadFollowUpSubmit
}: BartDockProps): React.JSX.Element {
  const { t } = useI18n()
  const windowVisible = useWindowVisible()
  const spatiallyVisible = useSyncExternalStore(subscribeDockPresence, dockIsVisible)
  const dockRef = useRef<HTMLElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dragRef = useRef<DockDrag | null>(null)
  const composingRef = useRef(false)
  // null means the CSS default is still the dynamic home; only a persisted or dragged
  // position is kept here as an explicit user home.
  const homeRef = useRef<DockPosition | null>(null)
  const positionRef = useRef<DockPosition | null>(null)
  const avoidanceTimerRef = useRef<number | undefined>(undefined)
  const avoidanceFrameRef = useRef<number | undefined>(undefined)
  const avoidanceWakeTimerRef = useRef<number | undefined>(undefined)
  const avoidanceWakeDeadlineRef = useRef<number | undefined>(undefined)
  const avoidanceRunnerRef = useRef<() => void>(() => undefined)
  const busyRetryCountRef = useRef(0)
  const avoidanceSampleSignatureRef = useRef<string | null>(null)
  const avoidanceGateRef = useRef({
    inlineInputVisible: false,
    interactionVisible: false,
    concealed: false,
    passiveVisible: true
  })
  const autoAvoidanceRef = useRef<DockAvoidanceGate>(createDockAvoidanceGate())
  const [position, setPosition] = useState<DockPosition | null>(null)
  const [hiddenInterventionKey, setHiddenInterventionKey] = useState<string>()
  const executionActive = activityContext.execution?.status === 'running' || activityContext.execution?.status === 'waiting-for-user'
  const operation = executionActive
    ? operations?.findLast((candidate) => candidate.phase === 'running') || operations?.at(-1)
    : undefined
  const dedicatedRouteActive = operation?.phase === 'running'
  // Only an active Core route owns the body. Finished routes yield even when
  // the next foreground event has not arrived yet.
  const activeOperation = dedicatedRouteActive ? operation : undefined
  const displayRunning = submitting || (activityContext.execution
    ? activityContext.execution.status === 'running' : running)
  const currentActivity = activityContext.execution?.status === 'running' &&
    foregroundActivity?.executionId === activityContext.execution.executionId ? foregroundActivity : null
  const latestRole = resolveBartRole(currentActivity, dedicatedRouteActive, displayRunning)
  const actionLabel = threadOpen ? t('返回之前的 thread') : t('进入 Bart 历史对话')
  const interactionKind = interaction?.intervention.questions?.length
    ? 'question' as const
    : 'permission' as const
  const interactionKey = interaction
    ? `${interaction.threadId}:${interaction.intervention.id}`
    : undefined
  const interactionVisible = Boolean(interaction)
  const threadFollowUpVisible = Boolean(threadFollowUp) && !threadOpen && !interactionVisible
  const bartInputVisible = inputOpen && !threadOpen && !interactionVisible && !threadFollowUpVisible
  // The capsule collapses back into the Dock on its way out, and that collapse
  // takes longer than the state change does. The composer stays mounted, the
  // Dock stays in its input layout and Bart rides down with it; without this
  // the capsule would vanish mid-air.
  //
  // The presence is worked out while rendering rather than after the fact, so
  // the composer is never unmounted and put back for the collapse — it would
  // meet its own entry animation on the way out.
  const capsuleRequested: CapsuleKind | null = bartInputVisible
    ? 'draft'
    : threadFollowUpVisible ? 'follow-up' : null
  // What the leaving capsule shows. Everything it is built from arrives as
  // props, and the ones that close it clear themselves first: submitting empties
  // the draft and drops the attachments, and closing a follow-up clears its
  // target. Read live, the capsule would collapse from an empty one-line box
  // instead of the shape that was there when the input closed, so the last
  // values that were under a live capsule are kept for its way out.
  // Two things stop that copy from being overwritten by the very clearing it
  // exists to survive: it is not written once the capsule has closed at all, and
  // a submit seals it — the store empties the draft while the input is still
  // open, so `capsuleRequested` alone would not notice. The seal lasts until a
  // capsule is opened again, and while it holds the capsule is rendered and
  // measured from the copy: the clearing arrives as a prop change, and the field
  // would otherwise be measured empty for the frames left before it closes.
  const [capsuleSealed, setCapsuleSealed] = useState(false)
  const retainedCapsule = useRef({ value: inputValue, attachments: bartAttachments, followUp: threadFollowUp })
  if (capsuleRequested && !capsuleSealed) {
    retainedCapsule.current = { value: inputValue, attachments: bartAttachments, followUp: threadFollowUp }
  }
  const [capsuleLeaving, setCapsuleLeaving] = useState<CapsuleKind | null>(null)
  const [lastCapsuleRequest, setLastCapsuleRequest] = useState<CapsuleKind | null>(capsuleRequested)
  if (capsuleRequested !== lastCapsuleRequest) {
    setLastCapsuleRequest(capsuleRequested)
    if (capsuleRequested) {
      setCapsuleLeaving(null)
      setCapsuleSealed(false)
    }
    // A card taking the Dock over is not the input closing: it replaces the
    // capsule, so there is nothing left to collapse into.
    else if (!interactionVisible) setCapsuleLeaving(lastCapsuleRequest)
  }
  // A card arriving while the capsule is on its way out takes the Dock away
  // from it, and that has to be decided before this render commits: the panel
  // and a capsule that is still collapsing would otherwise be painted together
  // once, and the capsule loses the surface that makes it a capsule the moment
  // the Dock leaves its input layout.
  if (interactionVisible && capsuleLeaving) setCapsuleLeaving(null)
  useEffect(() => {
    if (!capsuleLeaving) return
    const timer = window.setTimeout(
      () => setCapsuleLeaving(null),
      capsuleExitDuration(dockRef.current)
    )
    return () => window.clearTimeout(timer)
  }, [capsuleLeaving])
  const draftPresent = bartInputVisible || capsuleLeaving === 'draft'
  const followUpPresent = threadFollowUpVisible || capsuleLeaving === 'follow-up'
  const inlineInputVisible = draftPresent || followUpPresent
  const retaining = capsuleLeaving === 'draft' || capsuleSealed
  const draftValue = retaining ? retainedCapsule.current.value : inputValue
  const draftAttachments = retaining ? retainedCapsule.current.attachments : bartAttachments
  const followUpTarget = threadFollowUp ?? retainedCapsule.current.followUp
  const concealed = !passiveVisible && !interactionVisible && !inlineInputVisible
  const dockLayout: 'mark' | 'input' | 'permission' | 'question' = interactionVisible
    ? interactionKind
    : inlineInputVisible
      ? 'input'
      : 'mark'
  // The capsule is Bart's neighbour, never his shape: the character stays in
  // its resident form while the input is open.
  const logoLayout: BartLogoLayout = interactionVisible ? interactionKind : 'mark'
  avoidanceGateRef.current = { inlineInputVisible, interactionVisible, concealed, passiveVisible }
  const draftSubmittable = isBartDraftSubmittable(inputValue, bartAttachments)
  const interventionState = interventionVisualState(intervention)
  const interventionKey = intervention
    ? `${intervention.sourceConversationId}:${intervention.sourceRunId}:${intervention.interactionId}:${intervention.responseStatus}:${intervention.action || ''}:${intervention.respondedAt || ''}`
    : undefined
  const interventionExpired = Boolean(
    intervention?.responseStatus === 'responded' &&
      intervention.respondedAt &&
      Date.now() - intervention.respondedAt >= BART_INTERVENTION_RESULT_MS
  )
  const visibleInterventionState =
    interventionKey === hiddenInterventionKey || interventionExpired
      ? undefined
      : interventionState
  // The input owns the Dock until it closes — not until its capsule has
  // finished collapsing. Bart and his decoration go back to their own activity
  // the moment the input is closed, and ride the capsule down with it.
  const residentLayoutVisible = dockLayout === 'mark' || capsuleLeaving !== null
  const residentAvailable = residentLayoutVisible &&
    !activeOperation && !visibleInterventionState
  const displayedRole = useBartDisplay(
    latestRole, currentActivity != null, activityContext,
    residentAvailable && windowVisible && spatiallyVisible && !concealed && !threadOpen && !presentationCovered,
    displayTiming
  )
  const role = residentAvailable ? displayedRole : { kind: 'idle' as const }
  // Running alone does not claim thinking; only the Harness activity does.
  const activity: BartLogoActivity =
    activeOperation?.kind || (role.kind === 'reasoning' ? 'thinking' : role.kind === 'running' ? 'idle' : role.kind)
  const phase: BartLogoPhase = activeOperation?.phase || (displayRunning ? 'running' : 'idle')
  const replyRead = useBartReplyRead(reply?.readKey)
  // A new turn hides the previous reminder without reading it, so a failure or
  // a cancel brings the same identity back; a successful turn replaces it.
  const replyReminder = reply && !replyRead && sessionIdle && role.kind === 'idle' &&
    !concealed && spatiallyVisible && !presentationCovered && dockLayout === 'mark'
    ? reply : undefined

  // Entering the visible Bart session consumes the reminder, and so does a new
  // answer that arrives while the session is already open. An open session is
  // never `passiveVisible` — the overview is not rendered behind it — so this
  // asks about the window itself: entering while it is hidden waits instead.
  useEffect(() => {
    if (!reply?.readKey || !threadOpen || !windowVisible) return
    markBartReplyRead(reply.readKey)
  }, [reply?.readKey, threadOpen, windowVisible])

  const applyPosition = useCallback((next: DockPosition, motion: DockMotion, autoDurationMs = 320): void => {
    positionRef.current = next
    const dock = dockRef.current
    if (dock) {
      if (motion === 'auto') {
        dock.style.setProperty('--bart-dock-auto-duration', `${autoDurationMs}ms`)
      }
      dock.dataset.dockLeft = formatPosition(next.left)
      dock.dataset.dockTop = formatPosition(next.top)
      dock.dataset.dockMotion = motion
    }
    setPosition((current) => {
      if (current && Math.abs(current.left - next.left) <= 0.0001 && Math.abs(current.top - next.top) <= 0.0001)
        return current
      return next
    })
  }, [])

  // Bart 运动运行时：Dock 注册为 'dock' anchor（Stage canvas 挂载在
  // app-shell 之后，这里只需保证元素常驻时登记、卸载时注销）。
  useEffect(() => {
    const registry = getBartSpatialRegistry()
    const dock = dockRef.current
    const root = dock?.closest<HTMLElement>('.app-shell') ?? null
    if (root) registry.setRoot(root)
    const logo = dock?.querySelector<HTMLElement>('.bart-dock-logo-motion') ?? null
    if (dock) {
      dock.dataset.dockPlacement = 'home'
      dock.dataset.dockMotion = 'none'
    }
    registry.registerDock(logo)
    return () => getBartSpatialRegistry().registerDock(null)
  }, [])

  useEffect(() => {
    setHiddenInterventionKey(undefined)
    if (
      !interventionKey ||
      intervention?.responseStatus !== 'responded' ||
      !intervention.respondedAt
    ) {
      return
    }
    const remaining = Math.max(
      0,
      intervention.respondedAt + BART_INTERVENTION_RESULT_MS - Date.now()
    )
    const timer = window.setTimeout(() => setHiddenInterventionKey(interventionKey), remaining)
    return () => window.clearTimeout(timer)
  }, [intervention?.respondedAt, intervention?.responseStatus, interventionKey])

  // Opening the input is what takes the cursor, not the capsule being on screen:
  // a capsule that is closed and opened again inside its own exit is on screen
  // the whole time, and the exit took the focus with it.
  useEffect(() => {
    if (bartInputVisible) textareaRef.current?.focus()
  }, [bartInputVisible])

  // The capsule is as tall as the draft is long. The field is measured at its
  // natural height, turned into a row count, and pinned to the height that row
  // count is allowed to occupy; the Dock's own box never changes size, so the
  // capsule simply pushes Bart further up as it grows.
  //
  // The measured height is handed to the stylesheet rather than written to
  // `height` directly: the stylesheet animates it, and it cannot animate a
  // property the Dock keeps overwriting with `auto` to measure.
  //
  // It is written to the Dock, not to the field, because two things are built
  // from it: the capsule under Bart, and Bart's own offset above it. He is the
  // capsule's sibling, so the number has to live where both of them can read it.
  //
  // The field's inset shrinks with the capsule's factor, and the row count is
  // read off the field's own height — so the measurement is taken with the
  // factor pinned to its resting value. Without that, opening the input reads a
  // draft as one row shorter than it is, because the inset it is compared
  // against has not arrived yet.
  const measureCapsule = useCallback((): void => {
    const dock = dockRef.current
    if (!dock) return
    // The attachments row is not measured with the field, so it is published
    // alongside it: the capsule Bart is measured against is both of them.
    //
    // The row is read off the Dock rather than counted, because a draft that is
    // not the capsule on screen keeps its attachments but has no row: the Dock
    // is showing a follow-up, which is only its own one-row prompt. Nothing
    // there means nothing to publish.
    const strip = dock.querySelector<HTMLElement>('.bart-dock-attachment-strip')
    // A row of chips that overflows is a row with a scrollbar, and a scrollbar
    // with a size of its own takes that size out of the row: the chips would be
    // clipped inside the height they were given, and Bart would be lifted by
    // less than the capsule actually shows. Overlay scrollbars take nothing, so
    // this is the design number wherever the platform draws those.
    const gutter = strip ? strip.offsetHeight - strip.clientHeight : 0
    dock.style.setProperty(
      '--bart-dock-capsule-attachment-height',
      `${String(strip ? BART_CAPSULE_ATTACHMENT_HEIGHT + gutter : 0)}px`
    )
    const field = textareaRef.current
    // A follow-up is one fixed row and has no field to measure. Leaving the
    // registered `0px` start value in place would read as a capsule of no
    // height: Bart would wait out a whole slack and the gap above it would come
    // out too large. Its height is known, so publish it.
    if (!field) {
      dock.style.setProperty('--bart-dock-capsule-height', `${String(bartCapsuleHeight(BART_CAPSULE_MIN_LINES))}px`)
      return
    }
    field.style.setProperty('--bart-dock-capsule-open', '1')
    field.style.height = 'auto'
    const lines = bartCapsuleLines(field.scrollHeight)
    field.style.height = ''
    field.style.removeProperty('--bart-dock-capsule-open')
    dock.style.setProperty('--bart-dock-capsule-height', `${String(bartCapsuleHeight(lines))}px`)
  }, [])

  // A leaving capsule is measured from the draft it was showing, not from the
  // draft the close left behind — the store empties it on send — so that it
  // collapses from the shape that was there rather than from a one-line box.
  useLayoutEffect(
    measureCapsule,
    [bartInputVisible, followUpPresent, draftValue, draftAttachments.length, measureCapsule]
  )

  // The draft can also re-wrap without being edited: the Dock narrows with the
  // window, and a narrower field breaks the same text over more rows. Only the
  // width is watched — this effect writes the field's own height, so observing
  // height would feed back into itself.
  useLayoutEffect(() => {
    const field = textareaRef.current
    if (!bartInputVisible || !field || typeof ResizeObserver === 'undefined') return
    let lastWidth: number | undefined
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width
      if (width === undefined || width === lastWidth) return
      lastWidth = width
      measureCapsule()
    })
    observer.observe(field)
    return () => observer.disconnect()
  }, [bartInputVisible, measureCapsule])

  useEffect(() => {
    if (!bartInputVisible) return
    const dismiss = (event: PointerEvent): void => {
      if (dockRef.current?.contains(event.target as Node)) return
      onInputOpenChange(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [bartInputVisible, onInputOpenChange])

  useEffect(() => {
    if (!interactionKey) return
    if (inputOpen) onInputOpenChange(false)
    if (threadFollowUp) onThreadFollowUpClose?.()
  }, [inputOpen, interactionKey, onInputOpenChange, onThreadFollowUpClose, threadFollowUp])

  const clearAvoidanceWake = useCallback((): void => {
    if (avoidanceWakeTimerRef.current !== undefined) {
      window.clearTimeout(avoidanceWakeTimerRef.current)
      avoidanceWakeTimerRef.current = undefined
    }
    avoidanceWakeDeadlineRef.current = undefined
  }, [])

  const resetAutoAvoidance = useCallback((): void => {
    autoAvoidanceRef.current = createDockAvoidanceGate()
    avoidanceSampleSignatureRef.current = null
    clearAvoidanceWake()
  }, [clearAvoidanceWake])

  const scheduleAvoidance = useCallback((retry = false): void => {
    const gate = avoidanceGateRef.current
    if (gate.concealed || !gate.passiveVisible || gate.inlineInputVisible || gate.interactionVisible) {
      clearAvoidanceWake()
      if (avoidanceTimerRef.current !== undefined) {
        window.clearTimeout(avoidanceTimerRef.current)
        avoidanceTimerRef.current = undefined
      }
      if (avoidanceFrameRef.current !== undefined) {
        window.cancelAnimationFrame(avoidanceFrameRef.current)
        avoidanceFrameRef.current = undefined
      }
      return
    }
    if (!retry && !getOverviewMotionCoordinator().stageBusy) busyRetryCountRef.current = 0
    if (avoidanceTimerRef.current !== undefined) {
      window.clearTimeout(avoidanceTimerRef.current)
      avoidanceTimerRef.current = undefined
    }
    if (avoidanceFrameRef.current !== undefined) {
      window.cancelAnimationFrame(avoidanceFrameRef.current)
      avoidanceFrameRef.current = undefined
    }
    avoidanceTimerRef.current = window.setTimeout(() => {
      avoidanceTimerRef.current = undefined
      avoidanceFrameRef.current = window.requestAnimationFrame(() => {
        avoidanceFrameRef.current = undefined
        avoidanceRunnerRef.current()
      })
    }, retry ? DOCK_BUSY_RETRY_MS : DOCK_AVOIDANCE_DEBOUNCE_MS)
  }, [clearAvoidanceWake])

  const scheduleAvoidanceWake = useCallback((delayMs: number): void => {
    const delay = Math.max(0, Math.round(delayMs))
    const deadline = Date.now() + delay
    const currentDeadline = avoidanceWakeDeadlineRef.current
    if (currentDeadline !== undefined && currentDeadline <= deadline) return
    clearAvoidanceWake()
    avoidanceWakeDeadlineRef.current = deadline
    avoidanceWakeTimerRef.current = window.setTimeout(() => {
      avoidanceWakeTimerRef.current = undefined
      avoidanceWakeDeadlineRef.current = undefined
      avoidanceSampleSignatureRef.current = null
      scheduleAvoidance()
    }, delay)
  }, [clearAvoidanceWake, scheduleAvoidance])

  const capturePlacementInput = useCallback((): {
    input: DockPlacementInput
    current: DockPosition
  } | null => {
    const dock = dockRef.current
    const registry = getBartSpatialRegistry()
    const root = registry.rootElement() ?? dock?.closest<HTMLElement>('.app-shell') ?? null
    if (!dock || !root) return null
    const rootRect = root.getBoundingClientRect()
    const rootWidth = root.clientWidth || rootRect.width
    const rootHeight = root.clientHeight || rootRect.height
    const dockRect = dock.getBoundingClientRect()
    const dockWidth = dockRect.width || dock.offsetWidth
    const dockHeight = dockRect.height || dock.offsetHeight
    const surface = dock.querySelector<HTMLElement>('.bart-dock-drag-surface')
    const surfaceRect = surface?.getBoundingClientRect()
    const bodyWidth = surfaceRect?.width || surface?.offsetWidth || 0
    const bodyHeight = surfaceRect?.height || surface?.offsetHeight || 0
    if (!(rootWidth > 0 && rootHeight > 0 && dockWidth > 0 && dockHeight > 0)) return null
    if (!surfaceRect || !(bodyWidth > 0 && bodyHeight > 0)) return null

    const bounds = {
      x: DOCK_EDGE_GAP,
      y: DOCK_EDGE_GAP,
      width: Math.max(0, rootWidth - dockWidth - DOCK_EDGE_GAP * 2),
      height: Math.max(0, rootHeight - dockHeight - DOCK_EDGE_GAP * 2)
    }
    const current = positionRef.current ?? {
      left: dockRect.left - rootRect.left,
      top: dockRect.top - rootRect.top
    }
    const explicitHome = homeRef.current
    const home = explicitHome ?? resolveCssHome(dock, rootWidth, rootHeight, dockWidth, dockHeight)
    const clampedHome = clampDockPosition(home, bounds)
    if (explicitHome) homeRef.current = clampedHome
    const clampedCurrent = clampDockPosition(current, bounds)
    const viewport = registry.viewportRootRect()
    const obstacles = viewport ? collectDockObstacles(root, registry.cardRootRects(), viewport, rootRect) : []
    return {
      input: {
        bounds,
        body: {
          offset: {
            x: surfaceRect.left - dockRect.left,
            y: surfaceRect.top - dockRect.top
          },
          size: { width: bodyWidth, height: bodyHeight }
        },
        obstacles,
        home: { x: clampedHome.left, y: clampedHome.top },
        current: { x: clampedCurrent.left, y: clampedCurrent.top },
        clearance: DOCK_COLLISION_CLEARANCE
      },
      current: clampedCurrent
    }
  }, [])

  const evaluateAvoidance = useCallback((): void => {
    const gate = avoidanceGateRef.current
    const presence = getBartPresenceCoordinator()
    if (gate.concealed || !gate.passiveVisible || gate.inlineInputVisible || gate.interactionVisible || dragRef.current) {
      resetAutoAvoidance()
      return
    }
    if (presence.isDockHidden) {
      resetAutoAvoidance()
      return
    }
    if (getOverviewMotionCoordinator().stageBusy) {
      resetAutoAvoidance()
      if (busyRetryCountRef.current < DOCK_BUSY_RETRY_LIMIT) {
        busyRetryCountRef.current += 1
        scheduleAvoidance(true)
      }
      return
    }
    busyRetryCountRef.current = 0

    const captured = capturePlacementInput()
    if (!captured) return

    if (!positionRef.current) {
      applyPosition(captured.current, 'none')
      dockRef.current?.setAttribute(
        'data-dock-placement',
        sameDockPosition(captured.current, {
          left: captured.input.home.x,
          top: captured.input.home.y
        })
          ? 'home'
          : 'stay'
      )
    }

    const signature = placementInputSignature(captured.input)
    if (avoidanceSampleSignatureRef.current === signature) return
    avoidanceSampleSignatureRef.current = signature
    clearAvoidanceWake()
    const now = Date.now()
    const state = autoAvoidanceRef.current
    const occlusion = resolveDockOcclusion(captured.input, state.occlusionStartedAt !== null)
    const current = positionRef.current ?? captured.current
    const home = { left: captured.input.home.x, top: captured.input.home.y }
    const sample = {
      occluded: occlusion.active,
      homeFree: dockBodyIsFree(captured.input.home, captured.input),
      atHome: sameDockPosition(current, home)
    }
    const resolution = resolveDockAvoidanceGate(state, sample, now)
    autoAvoidanceRef.current = resolution.gate
    if (sample.atHome) {
      autoAvoidanceRef.current = {
        ...autoAvoidanceRef.current,
        targetHistory: [],
        oscillationSilencedUntil: 0
      }
    }
    if (resolution.wakeAt !== undefined) {
      scheduleAvoidanceWake(Math.max(0, resolution.wakeAt - now))
    }
    if (resolution.decision === 'none' || resolution.decision === 'arm') return

    if (resolution.decision === 'escape') {
      const placement = resolveDockPlacement(captured.input)
      const nextPoint = placement.kind === 'displaced'
        ? nudgeDockPlacement(placement.position, captured.input, state.targetHistory.length)
        : placement.position
      const next = { left: nextPoint.x, top: nextPoint.y }
      const moved = !sameDockPosition(current, next)
      const dock = dockRef.current
      if (dock) dock.dataset.dockPlacement = placement.kind
      if (!moved) return
      if (dockTargetsAreOscillating(autoAvoidanceRef.current.targetHistory, nextPoint)) {
        autoAvoidanceRef.current = {
          ...autoAvoidanceRef.current,
          oscillationSilencedUntil: now + DOCK_OSCILLATION_SILENCE_MS,
          targetHistory: []
        }
        scheduleAvoidanceWake(DOCK_OSCILLATION_SILENCE_MS)
        return
      }
      autoAvoidanceRef.current = {
        ...autoAvoidanceRef.current,
        lastAutoMoveAt: now,
        targetHistory: [...autoAvoidanceRef.current.targetHistory.slice(-2), nextPoint]
      }
      const distance = Math.hypot(next.left - current.left, next.top - current.top)
      applyPosition(next, 'auto', dockAutoTransitionDuration(distance))
      scheduleAvoidanceWake(DOCK_AUTO_MOVE_COOLDOWN_MS)
      return
    }

    const homePoint = { x: home.left, y: home.top }
    if (dockTargetsAreOscillating(autoAvoidanceRef.current.targetHistory, homePoint)) {
      autoAvoidanceRef.current = {
        ...autoAvoidanceRef.current,
        oscillationSilencedUntil: now + DOCK_OSCILLATION_SILENCE_MS,
        targetHistory: []
      }
      scheduleAvoidanceWake(DOCK_OSCILLATION_SILENCE_MS)
      return
    }
    const distance = Math.hypot(home.left - current.left, home.top - current.top)
    autoAvoidanceRef.current = {
      ...autoAvoidanceRef.current,
      lastAutoMoveAt: now,
      targetHistory: [],
      homeClearStartedAt: null
    }
    dockRef.current?.setAttribute('data-dock-placement', 'home')
    applyPosition(home, 'auto', dockAutoTransitionDuration(distance))
    scheduleAvoidanceWake(DOCK_AUTO_MOVE_COOLDOWN_MS)
  }, [
    applyPosition,
    capturePlacementInput,
    clearAvoidanceWake,
    resetAutoAvoidance,
    scheduleAvoidance,
    scheduleAvoidanceWake
  ])

  avoidanceRunnerRef.current = evaluateAvoidance

  useEffect(() => {
    const registry = getBartSpatialRegistry()
    const presence = getBartPresenceCoordinator()
    const camera = getOverviewCameraCockpit()
    const motion = getOverviewMotionCoordinator()
    const onLayoutSignal = (): void => scheduleAvoidance()
    const unsubscribeLayout = registry.subscribeLayout(onLayoutSignal)
    const unsubscribeCamera = camera.subscribe(onLayoutSignal)
    const unsubscribeVisibility = presence.subscribeDockVisibility(onLayoutSignal)
    const unsubscribeStageIdle = motion.subscribeStageIdle(onLayoutSignal)
    window.addEventListener('resize', onLayoutSignal)
    scheduleAvoidance()
    return () => {
      unsubscribeLayout()
      unsubscribeCamera()
      unsubscribeVisibility()
      unsubscribeStageIdle()
      window.removeEventListener('resize', onLayoutSignal)
      if (avoidanceTimerRef.current !== undefined) window.clearTimeout(avoidanceTimerRef.current)
      if (avoidanceFrameRef.current !== undefined) window.cancelAnimationFrame(avoidanceFrameRef.current)
      avoidanceTimerRef.current = undefined
      avoidanceFrameRef.current = undefined
      clearAvoidanceWake()
    }
  }, [clearAvoidanceWake, scheduleAvoidance])

  useEffect(() => {
    if (concealed || !passiveVisible || inlineInputVisible || interactionVisible) {
      resetAutoAvoidance()
      avoidanceSampleSignatureRef.current = null
      if (concealed) {
        dragRef.current = null
        dockRef.current?.classList.remove('dragging')
      }
      scheduleAvoidance()
      return
    }
    scheduleAvoidance()
  }, [
    concealed,
    dockLayout,
    inlineInputVisible,
    interactionVisible,
    passiveVisible,
    resetAutoAvoidance,
    scheduleAvoidance
  ])

  useEffect(() => {
    const dock = dockRef.current
    const registry = getBartSpatialRegistry()
    const root = registry.rootElement() ?? dock?.closest<HTMLElement>('.app-shell') ?? null
    if (!dock || !root) return
    try {
      const saved = JSON.parse(localStorage.getItem(DOCK_POSITION_STORAGE_KEY) || 'null') as
        | DockPosition
        | null
      if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return
      const bounds = getDockPositionBounds(root, dock)
      if (!bounds) return
      const next = clampDockPosition(saved, bounds)
      homeRef.current = next
      applyPosition(next, 'none')
      scheduleAvoidance()
    } catch {
      localStorage.removeItem(DOCK_POSITION_STORAGE_KEY)
    }
  }, [applyPosition, scheduleAvoidance])

  useEffect(() => {
    // Expanded interaction layouts are clamped by CSS so a transient 760px body does not
    // overwrite the user's persisted mark position. An explicit drag still updates it.
    const handleResize = (): void => {
      if (concealed || interactionVisible) {
        scheduleAvoidance()
        return
      }
      const dock = dockRef.current
      const registry = getBartSpatialRegistry()
      const root = registry.rootElement() ?? dock?.closest<HTMLElement>('.app-shell') ?? null
      if (!dock || !root) return
      const bounds = getDockPositionBounds(root, dock)
      if (!bounds) return
      if (homeRef.current) homeRef.current = clampDockPosition(homeRef.current, bounds)
      const current = positionRef.current
      if (current) {
        if (homeRef.current || dock.dataset.dockPlacement === 'displaced' || dock.dataset.dockPlacement === 'fallback') {
          applyPosition(clampDockPosition(current, bounds), 'none')
        } else {
          const rootRect = root.getBoundingClientRect()
          const rootWidth = root.clientWidth || rootRect.width
          const rootHeight = root.clientHeight || rootRect.height
          const dockRect = dock.getBoundingClientRect()
          const dynamicHome = resolveCssHome(
            dock,
            rootWidth,
            rootHeight,
            dockRect.width || dock.offsetWidth,
            dockRect.height || dock.offsetHeight
          )
          applyPosition(clampDockPosition(dynamicHome, bounds), 'none')
        }
      }
      scheduleAvoidance()
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [applyPosition, concealed, dockLayout, interactionVisible, scheduleAvoidance])

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    // A finger already on Bart keeps the gesture. The second contact carries a
    // pointer id of its own, so capture does not swallow it, and it would
    // replace the drag in flight — its own lift then arrives as a press that
    // never moved, which now reads as a click.
    if (concealed || event.button !== 0 || dragRef.current) return
    resetAutoAvoidance()
    const dock = dockRef.current
    const registry = getBartSpatialRegistry()
    const root = registry.rootElement() ?? dock?.closest<HTMLElement>('.app-shell') ?? null
    if (!dock || !root) return
    const bounds = dock.getBoundingClientRect()
    const rootBounds = root.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: bounds.left - rootBounds.left,
      originTop: bounds.top - rootBounds.top,
      moved: false
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    dock.classList.add('dragging')
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    const dock = dockRef.current
    const registry = getBartSpatialRegistry()
    const root = registry.rootElement() ?? dock?.closest<HTMLElement>('.app-shell') ?? null
    if (!drag || drag.pointerId !== event.pointerId || !dock || !root) {
      return
    }
    const deltaX = event.clientX - drag.startX
    const deltaY = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(deltaX, deltaY) > 4) drag.moved = true
    const bounds = getDockPositionBounds(root, dock)
    if (!bounds) return
    const next = clampDockPosition(
      { left: drag.originLeft + deltaX, top: drag.originTop + deltaY },
      bounds
    )
    applyPosition(next, 'drag')
  }

  const finishDrag = (event: React.PointerEvent<HTMLElement>, cancelled = false): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    dockRef.current?.classList.remove('dragging')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (positionRef.current) applyPosition(positionRef.current, 'none')
    if (cancelled) return
    if (!drag.moved) {
      // The Dock drags Bart by the very surface he is drawn on, so a press that
      // never travelled is a click on Bart himself. Only the mark layout reads
      // it that way: the others shape this surface around a capsule or an
      // interaction panel, where a tap there belongs to those instead.
      if (dockLayout === 'mark') toggleThread()
      return
    }
    if (positionRef.current) {
      homeRef.current = positionRef.current
      localStorage.setItem(DOCK_POSITION_STORAGE_KEY, JSON.stringify(homeRef.current))
      scheduleAvoidance()
    }
  }

  const toggleThread = (): void => {
    if (threadFollowUpVisible) onThreadFollowUpClose?.()
    onThreadOpenChange(!threadOpen)
  }

  // The menu is only on screen while nothing inline is: an open capsule hides it
  // rather than turning this into a close button, so opening is all it does.
  const toggleInput = (): void => {
    if (threadOpen) onThreadOpenChange(false)
    onInputOpenChange(true)
  }

  const submitInput = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    // The form outlives the input while the capsule collapses, and Enter still
    // reaches it from the field's own key handler.
    if (capsuleLeaving || inputDisabled || submitting || !draftSubmittable) return
    // Submitting empties the draft before the input closes, so what the capsule
    // collapses from is taken here, while it is still on screen, and the copy
    // above is sealed against that clearing until the next capsule opens.
    retainedCapsule.current = { value: inputValue, attachments: bartAttachments, followUp: threadFollowUp }
    setCapsuleSealed(true)
    try {
      await onSubmit()
    } catch {
      setCapsuleSealed(false)
      return
    }
    onInputOpenChange(false)
  }

  const positionedStyle: React.CSSProperties | undefined = position
    ? interactionVisible
      ? {
          left: `clamp(${DOCK_EDGE_GAP}px, ${position.left}px, calc(100% - var(--bart-interaction-width) - ${DOCK_EDGE_GAP}px))`,
          top: `clamp(${DOCK_EDGE_GAP}px, ${position.top}px, calc(100% - var(--bart-interaction-height) - ${DOCK_EDGE_GAP}px))`,
          right: 'auto',
          bottom: 'auto'
        }
      : { left: 0, top: 0, right: 'auto', bottom: 'auto', translate: `${position.left}px ${position.top}px` }
    : undefined

  // The stylesheet's copy of these two numbers is only a readable fallback; the
  // measurement above must win, or the field would scroll a line early. The
  // motion is the other way round — the stylesheet declares it and the timer
  // reads it — so nothing is published for it here.
  const capsuleVars = {
    '--bart-dock-capsule-line-height': `${String(BART_CAPSULE_LINE_HEIGHT)}px`,
    '--bart-dock-capsule-inset': `${String(BART_CAPSULE_INSET)}px`
  } as React.CSSProperties

  return (
    <aside
      ref={dockRef}
      className={`bart-dock ${concealed ? 'concealed' : ''} ${threadOpen ? 'thread-open' : ''} ${inlineInputVisible ? 'input-open' : ''} ${interactionVisible ? 'has-interaction' : ''} ${dockLayout === 'mark' ? 'empty' : ''}`}
      data-activity={activity}
      data-phase={phase}
      data-layout={dockLayout}
      data-capsule-leaving={capsuleLeaving ?? undefined}
      data-role={role.kind}
      data-intervention-state={interactionVisible ? undefined : visibleInterventionState}
      data-interaction-kind={interactionVisible ? interactionKind : undefined}
      style={{ ...positionedStyle, ...capsuleVars }}
      aria-label="Bart"
    >
      <span className="bart-dock-logo-motion">
        <span className="bart-dock-reasoning-motion">
          <BartLogo
            width={400}
            height={210}
            operations={interactionVisible ? undefined : operations}
            running={interactionVisible ? false : displayRunning}
            resolvedActivity={activity}
            resolvedPhase={phase}
            layout={logoLayout}
            interventionState={interactionVisible ? undefined : visibleInterventionState}
            interventionKey={interactionKey || interventionKey}
            roleKind={role.kind}
            motionActive={role.kind !== 'running' || (!concealed && !threadOpen && !presentationCovered && spatiallyVisible)}
          />
        </span>
        <span
          className="bart-dock-drag-surface"
          aria-hidden="true"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => finishDrag(event)}
          onPointerCancel={(event) => finishDrag(event, true)}
          onLostPointerCapture={(event) => finishDrag(event, true)}
        />
      </span>

      {residentLayoutVisible && !concealed && spatiallyVisible && !presentationCovered ? (
        <BartRoleDecoration key={role.kind} role={role} dockRef={dockRef}
          active={windowVisible && !threadOpen} reasoningOptions={reasoningOptions} />
      ) : null}

      {replyReminder ? (
        <BartReplyBadge
          key={replyReminder.id}
          excerpt={replyReminder.excerpt}
          onOpen={() => {
            if (onReplyOpen) onReplyOpen(replyReminder)
            else onThreadOpenChange(true)
          }}
        />
      ) : null}

      {interaction ? (
        <BartDockInteractionPanel
          key={interactionKey}
          request={interaction}
          onRespond={onInteractionResponse}
        />
      ) : null}

      {!inlineInputVisible && !interactionVisible ? (
        <div className="bart-dock-action-menu" role="group" aria-label={t('Bart 快捷操作')}>
          <button
            type="button"
            className="bart-dock-action bart-dock-character"
            data-active={threadOpen ? 'true' : 'false'}
            aria-label={actionLabel}
            aria-expanded={threadOpen}
            aria-controls="bart-thread-view"
            title={`${actionLabel}（⌘/Ctrl B）`}
            onClick={toggleThread}
          >
            <History size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="bart-dock-action bart-dock-message-control"
            aria-label={t('输入 Bart 消息')}
            title={t('输入 Bart 消息（⌘/Ctrl ⇧B）')}
            onClick={toggleInput}
          >
            <PenLine size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {draftPresent ? (
        <form
          className="bart-dock-inline-composer"
          inert={capsuleLeaving !== null}
          onSubmit={submitInput}
        >
          <AttachmentChips
            attachments={draftAttachments}
            onRemove={onRemoveBartAttachment}
            className="bart-dock-attachment-strip"
          />
          <div className="bart-dock-inline-row">
            <button
              type="button"
              className="bart-dock-attach"
              aria-label={t('添加图片或文件')}
              title={t('添加图片或文件')}
              disabled={inputDisabled || capsuleLeaving !== null}
              onClick={onChooseFiles}
            >
              <Plus size={18} strokeWidth={2} aria-hidden="true" />
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              value={draftValue}
              disabled={inputDisabled}
              readOnly={capsuleLeaving !== null}
              aria-label={t('给 Bart 发消息')}
              placeholder="Ask Bart…"
              autoComplete="off"
              spellCheck="false"
              onChange={(event) => onInputChange(event.target.value)}
              onPaste={(event) => {
                // Read-only stops the browser from inserting; this handler does
                // the inserting itself, so it has to be told separately.
                if (capsuleLeaving) return
                const extraction = extractPastePayload<File>(event)
                if (!extraction.shouldPreventDefault) return
                event.preventDefault()
                if (extraction.text && textareaRef.current) {
                  onInputChange(insertTextAtSelection(textareaRef.current, extraction.text))
                }
                onPasteFiles?.(extraction.files)
              }}
              onCompositionStart={() => {
                composingRef.current = true
              }}
              onCompositionEnd={() => {
                composingRef.current = false
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  onInputOpenChange(false)
                  return
                }
                if (event.key !== 'Enter') return
                // Enter sends, Shift+Enter (and an in-flight IME conversion)
                // belongs to the draft.
                if (event.shiftKey || composingRef.current) return
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }}
            />
            <button
              type="submit"
              className="bart-dock-send"
              aria-label={t('发送')}
              title={t('发送')}
              disabled={inputDisabled || submitting || !draftSubmittable}
            >
              <ArrowUp size={18} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
        </form>
      ) : null}

      {followUpPresent && followUpTarget && onThreadFollowUpSubmit ? (
        <BartDockThreadFollowUpComposer
          key={`${followUpTarget.threadId}:${followUpTarget.requestKey}`}
          target={followUpTarget}
          leaving={capsuleLeaving === 'follow-up'}
          onClose={() => onThreadFollowUpClose?.()}
          onSubmit={onThreadFollowUpSubmit}
        />
      ) : null}

      <span
        className="bart-dock-status"
        role="status"
        aria-live="polite"
      >
        {interaction
          ? `${interaction.threadTitle}：${interaction.intervention.title}`
          : threadFollowUpVisible && threadFollowUp
            ? `正在续写 ${threadFollowUp.threadTitle}`
            : 'Bart'}
      </span>
    </aside>
  )
})

function BartDockThreadFollowUpComposer(props: {
  target: BartDockThreadFollowUpTarget
  leaving: boolean
  onClose: () => void
  onSubmit: (threadId: string, prompt: string) => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState(props.target.initialDraft)
  const [submitting, setSubmitting] = useState(false)
  const submissionGenerationRef = useRef(0)

  useEffect(
    () => () => {
      submissionGenerationRef.current += 1
    },
    []
  )

  // What the exiting capsule shows. Sending or closing empties the draft before
  // the parent clears the target, and the capsule is still on screen while it
  // collapses: it should fade out holding the prompt that was there, not the
  // placeholder that replaced it.
  const shownPrompt = useRef(draft)
  if (!props.leaving) shownPrompt.current = draft
  const shownDraft = props.leaving ? shownPrompt.current : draft

  // The capsule is still mounted while it collapses, and it is on its way out:
  // the prompt in it belongs to a form that has already closed.
  const close = (): void => {
    if (props.leaving) return
    submissionGenerationRef.current += 1
    setDraft('')
    setSubmitting(false)
    props.onClose()
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (props.leaving) return
    const prompt = draft.trim()
    if (!prompt || submitting) return
    const generation = submissionGenerationRef.current + 1
    submissionGenerationRef.current = generation
    setSubmitting(true)
    try {
      await props.onSubmit(props.target.threadId, prompt)
      if (submissionGenerationRef.current !== generation) return
      setDraft('')
      props.onClose()
    } catch {
      if (submissionGenerationRef.current === generation) setSubmitting(false)
    }
  }

  return (
    <form
      className="bart-dock-thread-follow-up"
      aria-busy={submitting}
      inert={props.leaving}
      onSubmit={(event) => void submit(event)}
    >
      <span className="bart-dock-thread-follow-up-route" aria-hidden="true">
        {props.target.threadTitle}
      </span>
      <span className="bart-dock-thread-follow-up-row">
        <span className="bart-dock-thread-follow-up-provider" aria-hidden="true">
          <ProviderLogo provider={props.target.provider} />
        </span>
        <input
          autoFocus
          value={shownDraft}
          aria-label={`直接续写 ${props.target.threadTitle}`}
          autoComplete="off"
          placeholder="补充一句…"
          readOnly={submitting || props.leaving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              close()
            }
          }}
        />
        <button
          type="button"
          className="bart-dock-thread-follow-up-exit"
          aria-label="退出 Thread 续写"
          title="退出"
          disabled={props.leaving}
          onClick={close}
        >
          <ThreadFollowUpIcon kind="exit" />
        </button>
        <button
          type="submit"
          className="bart-dock-thread-follow-up-submit"
          aria-label={`发送到 ${props.target.threadTitle}`}
          title={`发送到 ${props.target.threadTitle}`}
          disabled={!draft.trim() || submitting || props.leaving}
        >
          <ThreadFollowUpIcon kind="send" />
        </button>
      </span>
    </form>
  )
}

function ThreadFollowUpIcon({ kind }: { kind: 'exit' | 'send' }): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'exit' ? (
        <><path d="m4 4 8 8" /><path d="m12 4-8 8" /></>
      ) : (
        <><path d="M8 13V3" /><path d="m4.5 6.5 3.5-3.5 3.5 3.5" /></>
      )}
    </svg>
  )
}

function BartDockInteractionPanel(props: {
  request: BartDockInteractionRequest
  onRespond?: BartDockInteractionResponse
}): React.JSX.Element {
  const { intervention } = props.request
  const questions = intervention.questions ?? []
  const answers = useInteractionAnswers()
  const [step, setStep] = useState(0)
  const [busyActionId, setBusyActionId] = useState<string>()
  const current = questions[Math.min(step, Math.max(0, questions.length - 1))]
  const currentAnswered = current ? answers.answered(current) : true
  const lastStep = step >= questions.length - 1
  const isQuestion = questions.length > 0

  const respond = async (actionId: string): Promise<void> => {
    if (!props.onRespond || busyActionId) return
    setBusyActionId(actionId)
    try {
      await props.onRespond({
        threadId: props.request.threadId,
        interactionId: intervention.id,
        actionId,
        ...(isQuestion && actionId === intervention.submitActionId
          ? { answers: answers.answersFor(questions) }
          : {})
      })
    } catch {
      // The owning App callback routes the rejection through the existing
      // operation-error surface. Keep this interaction available for retry.
    } finally {
      setBusyActionId(undefined)
    }
  }

  return (
    <section
      className={`bart-dock-interaction bart-dock-interaction--${isQuestion ? 'question' : 'permission'}`}
      aria-label={isQuestion ? 'User Question' : 'Permission 请求'}
      aria-busy={busyActionId ? 'true' : 'false'}
    >
      <div className="bart-dock-interaction-kicker">
        <i aria-hidden="true" />
        <span>{isQuestion ? 'USER QUESTION' : 'PERMISSION'}</span>
        <small title={props.request.threadTitle}>{props.request.threadTitle}</small>
        {questions.length > 1 ? <b>{`${step + 1} / ${questions.length}`}</b> : null}
      </div>

      {current ? (
        <BartDockQuestionField
          question={current}
          state={answers}
          disabled={Boolean(busyActionId)}
        />
      ) : (
        <div className="bart-dock-permission-copy">
          <h2>{intervention.title}</h2>
          {intervention.detail ? (
            <p className="bart-dock-interaction-detail">{intervention.detail}</p>
          ) : null}
        </div>
      )}

      <div className="bart-dock-interaction-actions">
        {isQuestion && !lastStep ? (
          <>
            {step > 0 ? (
              <button
                type="button"
                className="bart-dock-interaction-button"
                disabled={Boolean(busyActionId)}
                onClick={() => setStep((value) => value - 1)}
              >
                上一步
              </button>
            ) : null}
            <button
              type="button"
              className="bart-dock-interaction-button primary"
              disabled={Boolean(busyActionId) || !currentAnswered}
              onClick={() => setStep((value) => value + 1)}
            >
              下一步
            </button>
          </>
        ) : (
          intervention.actions.map((action) => {
            const primary =
              action.intent === 'allow' ||
              action.intent === 'submit' ||
              action.id === intervention.submitActionId
            return (
              <button
                type="button"
                className={`bart-dock-interaction-button${primary ? ' primary' : ''}`}
                data-intent={action.intent}
                disabled={
                  !props.onRespond ||
                  Boolean(busyActionId) ||
                  (action.id === intervention.submitActionId && !currentAnswered)
                }
                key={action.id}
                onClick={() => void respond(action.id)}
              >
                {busyActionId === action.id ? '处理中…' : action.label}
              </button>
            )
          })
        )}
        {isQuestion && lastStep && step > 0 ? (
          <button
            type="button"
            className="bart-dock-interaction-button"
            disabled={Boolean(busyActionId)}
            onClick={() => setStep((value) => value - 1)}
          >
            上一步
          </button>
        ) : null}
      </div>
    </section>
  )
}

function BartDockQuestionField(props: {
  question: InteractionQuestionSpec
  state: InteractionAnswerState
  disabled: boolean
}): React.JSX.Element {
  const { question, state } = props
  const selected = state.picked(question)
  const role = question.multiple ? 'checkbox' : 'radio'
  return (
    <div className="bart-dock-question">
      <h2>{question.header || question.prompt}</h2>
      {question.header ? (
        <p className="bart-dock-interaction-detail">{question.prompt}</p>
      ) : null}
      {question.options.length ? (
        <div
          className="bart-dock-question-options"
          role={question.multiple ? 'group' : 'radiogroup'}
          aria-label={question.header || question.prompt}
        >
          {question.options.map((option) => {
            const checked = selected.includes(option.value)
            return (
              <button
                type="button"
                role={role}
                aria-checked={checked}
                className={checked ? 'active' : undefined}
                disabled={props.disabled}
                key={option.id}
                onClick={() => state.toggle(question, option.value)}
              >
                <i className="bart-dock-question-indicator" aria-hidden="true" />
                <span>
                  <b>{option.label}</b>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
              </button>
            )
          })}
          {question.allowOther ? (
            <button
              type="button"
              role={role}
              aria-checked={state.otherOpen(question)}
              className={state.otherOpen(question) ? 'active' : undefined}
              disabled={props.disabled}
              onClick={() => state.toggleOther(question)}
            >
              <i className="bart-dock-question-indicator" aria-hidden="true" />
              <span>
                <b>其它…</b>
                <small>输入自己的回答</small>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
      {state.otherOpen(question) ? (
        <input
          autoFocus
          className="bart-dock-question-input"
          disabled={props.disabled}
          onChange={(event) => state.writeOther(question, event.target.value)}
          placeholder={question.options.length ? '输入你的回答' : '输入回答'}
          type={question.secret ? 'password' : 'text'}
          value={state.otherText(question)}
        />
      ) : null}
    </div>
  )
}

export function interventionVisualState(
  intervention: BartInterventionMeta | undefined
): BartInterventionVisualState | undefined {
  if (!intervention || intervention.responseStatus === 'fallback') return undefined
  if (intervention.responseStatus === 'pending') return 'processing'
  if (intervention.action === 'allow') return 'allow'
  if (intervention.action === 'deny' || intervention.action === 'cancel') return 'deny'
  if (intervention.action === 'submit') return 'answer'
  return undefined
}

function getDockPositionBounds(root: HTMLElement, dock: HTMLElement): DockPlacementInput['bounds'] | null {
  const rootRect = root.getBoundingClientRect()
  const rootWidth = root.clientWidth || rootRect.width
  const rootHeight = root.clientHeight || rootRect.height
  const dockRect = dock.getBoundingClientRect()
  const dockWidth = dockRect.width || dock.offsetWidth
  const dockHeight = dockRect.height || dock.offsetHeight
  if (!(rootWidth > 0 && rootHeight > 0 && dockWidth > 0 && dockHeight > 0)) return null
  return {
    x: DOCK_EDGE_GAP,
    y: DOCK_EDGE_GAP,
    width: Math.max(0, rootWidth - dockWidth - DOCK_EDGE_GAP * 2),
    height: Math.max(0, rootHeight - dockHeight - DOCK_EDGE_GAP * 2)
  }
}

function clampDockPosition(
  position: DockPosition,
  bounds: DockPlacementInput['bounds']
): DockPosition {
  return {
    left: clamp(position.left, bounds.x, bounds.x + bounds.width),
    top: clamp(position.top, bounds.y, bounds.y + bounds.height)
  }
}

function resolveCssHome(
  dock: HTMLElement,
  rootWidth: number,
  rootHeight: number,
  dockWidth: number,
  dockHeight: number
): DockPosition {
  let right = 18
  let bottom = 14
  try {
    const styles = getComputedStyle(dock)
    right = parseCssPixel(styles.getPropertyValue('--bart-dock-home-right')) ?? right
    bottom = parseCssPixel(styles.getPropertyValue('--bart-dock-home-bottom')) ?? bottom
  } catch {
    // CSS is not available in a few non-browser consumers; retain the desktop default.
  }
  return {
    left: rootWidth - dockWidth - right,
    top: rootHeight - dockHeight - bottom
  }
}

function collectDockObstacles(
  root: HTMLElement,
  cardRects: readonly DockPlacementInput['obstacles'][number][],
  viewport: DockPlacementInput['bounds'],
  rootRect: DOMRect
): DockPlacementInput['obstacles'] {
  const obstacles: DockObstacle[] = []
  const add = (rect: DockRect, kind: DockObstacle['kind']): void => {
    const clipped = clipRect(rect, viewport)
    if (clipped) obstacles.push({ ...clipped, kind })
  }
  for (const rect of cardRects) add(rect, 'thread-card')
  for (const element of root.querySelectorAll<HTMLElement>(
    '.thread-tag-filter-bar, .thread-overview-floating-chrome'
  )) {
    if (!element.isConnected) continue
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    add({
      x: rect.left - rootRect.left,
      y: rect.top - rootRect.top,
      width: rect.width,
      height: rect.height
    }, 'chrome')
  }
  return obstacles
}

function placementInputSignature(input: DockPlacementInput): string {
  const round = (value: number): number => Math.round(value * 2) / 2
  return JSON.stringify({
    bounds: [input.bounds.x, input.bounds.y, input.bounds.width, input.bounds.height].map(round),
    body: [
      input.body.offset.x,
      input.body.offset.y,
      input.body.size.width,
      input.body.size.height
    ].map(round),
    obstacles: input.obstacles.map((rect) => ({
      rect: [rect.x, rect.y, rect.width, rect.height].map(round),
      kind: rect.kind || ''
    })),
    home: [input.home.x, input.home.y].map(round),
    current: [input.current.x, input.current.y].map(round),
    clearance: round(input.clearance)
  })
}

function parseCssPixel(value: string): number | null {
  const match = value.trim().match(/^(-?(?:\d+\.?\d*|\.\d+))px$/)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

function formatPosition(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function sameDockPosition(left: DockPosition, right: DockPosition): boolean {
  return Math.abs(left.left - right.left) <= 0.5 && Math.abs(left.top - right.top) <= 0.5
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}
