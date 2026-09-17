import { getOverviewMotionCoordinator } from './coordinator'

/**
 * 俯瞰卡片的布局动效原语：FLIP 冻结、resize / reflow / entry / exit 节拍与共享时长曲线。
 * 由 ConversationOverview 编排（租约、FIFO 队列、相机），也由 Thread Card Lab 直接复用，
 * 使实验室里的尺寸切换就是生产那一套动画本身，而不是另写一份近似实现。
 */

const GRID_REFLOW_ANIMATION_MS = 260
const GROWTH_REFLOW_MOVE_MS = 360
const GROWTH_REFLOW_WAVE_STAGGER_MS = 70
const GRID_REFLOW_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'
const CARD_ENTRY_ANIMATION_MS = 220
const CARD_EXIT_ANIMATION_MS = 160

interface OverviewPlaneRect {
  left: number
  top: number
  width: number
  height: number
}

export function measureOverviewCardRects(root: HTMLElement | null): Map<string, OverviewPlaneRect> {
  const rects = new Map<string, OverviewPlaneRect>()
  const appRoot = root?.closest<HTMLElement>('.app-shell') ?? root?.closest<HTMLElement>('.thread-overview')
  if (!root || !appRoot) return rects
  const rootRect = appRoot.getBoundingClientRect()
  const coordinator = getOverviewMotionCoordinator()
  for (const element of root.querySelectorAll<HTMLElement>('[data-overview-card-id]')) {
    const id = element.dataset.overviewCardId
    if (!id) continue
    const rect = element.getBoundingClientRect()
    const plane = coordinator.rootRectToPlane({
      x: rect.left - rootRect.left,
      y: rect.top - rootRect.top,
      width: rect.width,
      height: rect.height
    })
    rects.set(id, {
      left: plane.x,
      top: plane.y,
      width: plane.width,
      height: plane.height
    })
  }
  return rects
}

export interface OverviewCardMotion {
  element: HTMLElement
  id: string
  dx: number
  dy: number
  from: OverviewPlaneRect | null
  to: OverviewPlaneRect
  inserted: boolean
  resizeDirection: 'grow' | 'shrink' | null
  moved: boolean
  reflowMode: 'move' | 'straight' | 'detour' | 'crossfade'
}

/**
 * 目标布局提交后先把现有卡片视觉冻结在旧几何，并把新卡藏在入场首帧。
 * 后续 shrink → per-card reflow → grow → entry 各自持有独立舞台租约；这里本身不播放动画。
 */
export function stageOverviewLayoutMotion(
  grid: HTMLElement | null,
  fromRects: Map<string, OverviewPlaneRect>,
  toRects: Map<string, OverviewPlaneRect>,
  sizeChanged: ReadonlySet<string>
): OverviewCardMotion[] {
  if (!grid) return []
  const cards: OverviewCardMotion[] = []
  for (const element of grid.querySelectorAll<HTMLElement>('[data-overview-card-id]')) {
    const id = element.dataset.overviewCardId
    if (!id) continue
    const from = fromRects.get(id)
    const to = toRects.get(id)
    if (!to) continue
    if (!from) {
      markOverviewMotionElement(element)
      element.style.opacity = '0'
      element.style.transform = 'translateY(14px) scale(0.97)'
      cards.push({
        element,
        id,
        dx: 0,
        dy: 0,
        from: null,
        to,
        inserted: true,
        resizeDirection: null,
        moved: false,
        reflowMode: 'move'
      })
      continue
    }
    const dx = from.left - to.left
    const dy = from.top - to.top
    const resized = sizeChanged.has(id) && to.width > 0 && to.height > 0
    const moved = Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01
    if (!moved && !resized) continue
    const resizeDirection = resized
      ? to.width > from.width + 0.01 || to.height > from.height + 0.01
        ? 'grow'
        : 'shrink'
      : null
    markOverviewMotionElement(element)
    // FLIP 的 dx/dy 是按左上角计算的；与卡片默认的 center origin 混用会让
    // 尺寸首帧围绕中心漂进相邻格。布局动画期间固定左上角，才能精确复现旧 rect。
    element.style.transformOrigin = 'top left'
    element.style.transform = overviewCardTransform(dx, dy)
    // 换形走真实盒子尺寸，不走 transform 缩放，也不走 clip 裁剪：
    // - scale(1, 0.32) 会把已经按目标排好版的新内容整体压扁再拉开，字重行距圆角全被
    //   非等比拉伸；
    // - clip 虽然不形变，却会让人先看到一张被切断的半截卡。
    // 盒子改成真值动画，同时把卡内结构先隐去，外框到位后再淡入——几何在动的时候，
    // 屏幕上没有任何需要被压扁或切断的内容。
    if (resized) {
      element.dataset.overviewMotionRecomposing = 'true'
      element.style.width = `${from.width}px`
      element.style.height = `${from.height}px`
    }
    cards.push({
      element,
      id,
      dx,
      dy,
      from,
      to,
      inserted: false,
      resizeDirection,
      moved,
      reflowMode: 'move'
    })
  }
  return cards
}

export function startOverviewResizeAnimations(
  cards: OverviewCardMotion[],
  clickBlockUntil: Map<string, number>,
  atFinalPosition = false
): Animation[] {
  const now = Date.now()
  return cards.flatMap((card) => {
    if (typeof card.element.animate !== 'function') return []
    clickBlockUntil.set(card.id, now + GRID_REFLOW_ANIMATION_MS)
    const dx = atFinalPosition ? 0 : card.dx
    const dy = atFinalPosition ? 0 : card.dy
    const held = overviewCardTransform(dx, dy)
    const from = card.from ?? card.to
    return [
      card.element.animate(
        [
          { width: `${from.width}px`, height: `${from.height}px`, transform: held },
          { width: `${card.to.width}px`, height: `${card.to.height}px`, transform: held }
        ],
        {
          duration: GRID_REFLOW_ANIMATION_MS,
          fill: 'forwards',
          easing: GRID_REFLOW_EASING
        }
      )
    ]
  })
}

export function settleOverviewResize(cards: OverviewCardMotion[], atFinalPosition = false): void {
  for (const card of cards) {
    card.element.style.transform = overviewCardTransform(
      atFinalPosition ? 0 : card.dx,
      atFinalPosition ? 0 : card.dy
    )
    card.element.style.width = `${card.to.width}px`
    card.element.style.height = `${card.to.height}px`
    delete card.element.dataset.overviewMotionRecomposing
  }
}

/**
 * 尺寸增长引起的整片 reflow 共用一个节拍：末端先动，后续依赖以短 stagger 跟上；
 * grow 卡等自己的落位路径基本清空后才展开。这样密集网格读作一股让位波，而不是
 * 五六张卡各自占用一个 FIFO 节拍、到最后才补一次尺寸变化。
 */
export function startOverviewGrowthReflowAnimations(
  waves: readonly (readonly OverviewCardMotion[])[],
  growing: readonly OverviewCardMotion[],
  clickBlockUntil: Map<string, number>
): Animation[] {
  const now = Date.now()
  const animations: Animation[] = []
  const waveIndexById = new Map<string, number>()
  for (let waveIndex = 0; waveIndex < waves.length; waveIndex += 1) {
    const delay = waveIndex * GROWTH_REFLOW_WAVE_STAGGER_MS
    for (const card of waves[waveIndex]) {
      waveIndexById.set(card.id, waveIndex)
      clickBlockUntil.set(card.id, now + delay + GROWTH_REFLOW_MOVE_MS)
      if (typeof card.element.animate !== 'function') continue
      animations.push(
        card.element.animate(overviewExpansionDisplacementKeyframes(card), {
          duration: GROWTH_REFLOW_MOVE_MS,
          delay,
          fill: 'forwards',
          easing: GRID_REFLOW_EASING
        })
      )
    }
  }
  for (const card of growing) {
    const waveIndex = waveIndexById.get(card.id)
    const delay = waveIndex === undefined
      ? stationaryGrowthDelay(card, waves)
      : waveIndex * GROWTH_REFLOW_WAVE_STAGGER_MS + GROWTH_REFLOW_MOVE_MS
    clickBlockUntil.set(card.id, now + delay + GRID_REFLOW_ANIMATION_MS)
    if (typeof card.element.animate !== 'function') continue
    const from = card.from ?? card.to
    animations.push(
      card.element.animate(
        [
          { width: `${from.width}px`, height: `${from.height}px` },
          { width: `${card.to.width}px`, height: `${card.to.height}px` }
        ],
        {
          duration: GRID_REFLOW_ANIMATION_MS,
          delay,
          fill: 'forwards',
          easing: GRID_REFLOW_EASING
        }
      )
    )
  }
  return animations
}

export function startOverviewReflowAnimations(
  cards: OverviewCardMotion[],
  clickBlockUntil: Map<string, number>
): Animation[] {
  const now = Date.now()
  return cards.flatMap((card) => {
    if (typeof card.element.animate !== 'function') return []
    clickBlockUntil.set(card.id, now + GRID_REFLOW_ANIMATION_MS)
    return [
      card.element.animate(
        overviewReflowKeyframes(card),
        {
          duration: GRID_REFLOW_ANIMATION_MS,
          fill: 'forwards',
          easing: GRID_REFLOW_EASING
        }
      )
    ]
  })
}

/**
 * Dense grid 的目标位置经常正被另一张待移动卡占用。按「先腾空目标、再接力」
 * 排序，避免所有卡同时走直线时互相穿过；异常的环退化为稳定 DOM 顺序。
 */
export function orderOverviewReflowCards(
  cards: OverviewCardMotion[],
  fixedObstacles: readonly OverviewPlaneRect[]
): OverviewCardMotion[] {
  return orderOverviewReflowWaves(cards, fixedObstacles).flat()
}

/** 同一层里目标格已经腾空的卡可以并行移动；层与层之间用短 stagger 接力。 */
export function orderOverviewReflowWaves(
  cards: OverviewCardMotion[],
  fixedObstacles: readonly OverviewPlaneRect[]
): OverviewCardMotion[][] {
  const remaining = [...cards]
  const waves: OverviewCardMotion[][] = []
  const settledTargets: OverviewPlaneRect[] = []
  while (remaining.length) {
    const ready = remaining.filter((card) => {
      const target = overviewReflowRect(card, 'target')
      return remaining.every(
        (other) => other === card || !overviewPlaneRectsOverlap(target, overviewReflowRect(other, 'source'))
      )
    })
    if (!ready.length) {
      // 真正的换位环没有可先腾出的目标格：每张卡沿相反侧的短弧绕行，身份始终
      // 可见；不能在旧/新格位各 fade 一次，否则连续 revision 会让同一格闪烁。
      for (const card of remaining) card.reflowMode = 'detour'
      waves.push([...remaining])
      break
    }
    const readyIds = new Set(ready.map((card) => card.id))
    const pending = remaining.filter((card) => !readyIds.has(card.id))
    for (const card of ready) {
      const peerSources = ready.flatMap((peer) =>
        peer === card ? [] : [overviewReflowRect(peer, 'source')]
      )
      const obstacles = [
        ...fixedObstacles,
        ...settledTargets,
        ...pending.map((other) => overviewReflowRect(other, 'source')),
        ...peerSources
      ]
      if (overviewReflowPathIntersects(card, obstacles)) card.reflowMode = 'crossfade'
    }
    waves.push(ready)
    settledTargets.push(...ready.map((card) => overviewReflowRect(card, 'target')))
    remaining.splice(0, remaining.length, ...pending)
  }
  return waves
}

export function overviewReflowRect(card: OverviewCardMotion, position: 'source' | 'target'): OverviewPlaneRect {
  const anchor = position === 'source' ? card.from ?? card.to : card.to
  const size = card.resizeDirection === 'grow' ? card.from ?? card.to : card.to
  return {
    left: anchor.left,
    top: anchor.top,
    width: size.width,
    height: size.height
  }
}

function overviewPlaneRectsOverlap(a: OverviewPlaneRect, b: OverviewPlaneRect): boolean {
  return (
    Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left) > 0.5 &&
    Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top) > 0.5
  )
}

function overviewReflowPathIntersects(
  card: OverviewCardMotion,
  obstacles: readonly OverviewPlaneRect[]
): boolean {
  const source = overviewReflowRect(card, 'source')
  const target = overviewReflowRect(card, 'target')
  const points = [{ left: source.left, top: source.top }]
  if (Math.abs(card.dx) >= 0.01 && Math.abs(card.dy) >= 0.01) {
    points.push(card.dy < 0
      ? { left: source.left, top: target.top }
      : { left: target.left, top: source.top })
  }
  points.push({ left: target.left, top: target.top })
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    const sweep: OverviewPlaneRect = {
      left: Math.min(from.left, to.left),
      top: Math.min(from.top, to.top),
      width: Math.abs(from.left - to.left) + source.width,
      height: Math.abs(from.top - to.top) + source.height
    }
    if (obstacles.some((obstacle) => overviewPlaneRectsOverlap(sweep, obstacle))) return true
  }
  return false
}

/** 跨行重排沿空白行折一次：向下先走纵向，向上先走横向。 */
function overviewReflowKeyframes(card: OverviewCardMotion): Keyframe[] {
  const start = overviewCardTransform(card.dx, card.dy)
  const end = overviewCardTransform(0, 0)
  if (card.reflowMode === 'straight') return [{ transform: start }, { transform: end }]
  if (card.reflowMode === 'detour') return overviewDetourKeyframes(card)
  if (card.reflowMode === 'crossfade') {
    return [
      { transform: start, opacity: 1, offset: 0 },
      { transform: overviewCardTransform(card.dx, card.dy, 0.97), opacity: 0, offset: 0.38 },
      { transform: overviewCardTransform(0, 0, 0.97), opacity: 0, offset: 0.62 },
      { transform: end, opacity: 1, offset: 1 }
    ]
  }
  if (Math.abs(card.dx) < 0.01 || Math.abs(card.dy) < 0.01) {
    return [{ transform: start }, { transform: end }]
  }
  const movingDown = card.dy < 0
  const waypoint = movingDown
    ? overviewCardTransform(card.dx, 0)
    : overviewCardTransform(0, card.dy)
  const firstLeg = movingDown ? Math.abs(card.dy) : Math.abs(card.dx)
  const waypointOffset = Math.min(0.75, Math.max(0.25, firstLeg / (Math.abs(card.dx) + Math.abs(card.dy))))
  return [
    { transform: start, offset: 0 },
    { transform: waypoint, offset: waypointOffset },
    { transform: end, offset: 1 }
  ]
}

function overviewExpansionDisplacementKeyframes(card: OverviewCardMotion): Keyframe[] {
  if (
    card.reflowMode !== 'move' ||
    Math.abs(card.dx) < 0.01 ||
    Math.abs(card.dy) < 0.01 ||
    card.dy > 0
  ) {
    return overviewReflowKeyframes(card)
  }
  return [
    { transform: overviewCardTransform(card.dx, card.dy), offset: 0 },
    { transform: overviewCardTransform(card.dx, card.dy * 0.18), offset: 0.32 },
    { transform: overviewCardTransform(card.dx * 0.86, 0), offset: 0.5 },
    { transform: overviewCardTransform(0, 0), offset: 1 }
  ]
}

function overviewDetourKeyframes(card: OverviewCardMotion): Keyframe[] {
  const distance = Math.hypot(card.dx, card.dy)
  if (distance < 0.01) return [{ transform: overviewCardTransform(0, 0) }]
  const clearance = Math.min(56, Math.max(28, distance * 0.12))
  const midpointX = card.dx * 0.5 + (card.dy / distance) * clearance
  const midpointY = card.dy * 0.5 - (card.dx / distance) * clearance
  return [
    { transform: overviewCardTransform(card.dx, card.dy), offset: 0 },
    { transform: overviewCardTransform(midpointX, midpointY, 0.985), offset: 0.5 },
    { transform: overviewCardTransform(0, 0), offset: 1 }
  ]
}

function stationaryGrowthDelay(
  growth: OverviewCardMotion,
  waves: readonly (readonly OverviewCardMotion[])[]
): number {
  let lastBlockingWave = -1
  for (let waveIndex = 0; waveIndex < waves.length; waveIndex += 1) {
    if (waves[waveIndex].some((card) => {
      const source = card.from ?? card.to
      return overviewPlaneRectsOverlap(growth.to, source)
    })) {
      lastBlockingWave = waveIndex
    }
  }
  return lastBlockingWave < 0
    ? 0
    : lastBlockingWave * GROWTH_REFLOW_WAVE_STAGGER_MS + GROWTH_REFLOW_MOVE_MS
}

export function settleOverviewReflow(cards: OverviewCardMotion[]): void {
  for (const card of cards) {
    card.element.style.opacity = '1'
    card.element.style.transform = 'none'
  }
}

export function startOverviewCardEntryAnimation(card: OverviewCardMotion, clickBlockUntil: Map<string, number>): Animation[] {
  if (typeof card.element.animate !== 'function') return []
  clickBlockUntil.set(card.id, Date.now() + CARD_ENTRY_ANIMATION_MS)
  return [
    card.element.animate(
      [
        { opacity: 0, transform: 'translateY(14px) scale(0.97)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' }
      ],
      {
        duration: CARD_ENTRY_ANIMATION_MS,
        fill: 'forwards',
        easing: GRID_REFLOW_EASING
      }
    )
  ]
}

export function settleOverviewCardEntry(card: OverviewCardMotion): void {
  card.element.style.opacity = '1'
  card.element.style.transform = 'none'
}

export function startOverviewCardExitAnimation(element: HTMLElement, clickBlockUntil: Map<string, number>): Animation[] {
  // 退场按俯瞰卡片身份定位，而不是 thread 身份：报告卡同样是俯瞰的一张卡，
  // 必须复用同一条退场节拍。
  const id = element.dataset.overviewCardId
  if (!id || typeof element.animate !== 'function') return []
  markOverviewMotionElement(element)
  clickBlockUntil.set(id, Date.now() + CARD_EXIT_ANIMATION_MS)
  return [
    element.animate(
      [
        { opacity: 1, transform: 'translateY(0) scale(1)' },
        { opacity: 0, transform: 'translateY(-8px) scale(0.98)' }
      ],
      {
        duration: CARD_EXIT_ANIMATION_MS,
        fill: 'forwards',
        easing: GRID_REFLOW_EASING
      }
    )
  ]
}

export function settleOverviewCardExit(element: HTMLElement): void {
  markOverviewMotionElement(element)
  element.style.opacity = '0'
  element.style.transform = 'translateY(-8px) scale(0.98)'
}

/** 只接受等比缩放：非等比缩放会把卡内排版拉伸变形，已在换形节拍里被否掉。 */
function overviewCardTransform(dx: number, dy: number, scale = 1): string {
  return `translate(${dx}px, ${dy}px) scale(${scale})`
}

function markOverviewMotionElement(element: HTMLElement): void {
  element.dataset.overviewMotionStaged = 'true'
}

export function clearOverviewLayoutMotionStyles(grid: HTMLElement | null): void {
  for (const element of grid?.querySelectorAll<HTMLElement>('[data-overview-motion-staged]') ?? []) {
    element.style.removeProperty('opacity')
    element.style.removeProperty('transform')
    element.style.removeProperty('transform-origin')
    element.style.removeProperty('width')
    element.style.removeProperty('height')
    delete element.dataset.overviewMotionRecomposing
    delete element.dataset.overviewMotionStaged
  }
}
