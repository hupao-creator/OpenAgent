/**
 * 空间注册表：Dock 与已挂载 Thread 卡片的统一坐标来源。
 *
 * 坐标统一为未缩放的 Overview 内容平面 CSS 像素；摄像机与原生滚动只改变
 * 平面到 App root 的映射。每个移动段开始前生成一次 scene snapshot；运动帧
 * 不查询或测量 DOM。卡片注销（卸载/删除）会通知订阅者，活动段据此按
 * 「目标删除」中止。
 */

import type { BartAnchorRef } from './types'
import type { BartObstacle } from './planner'
import type { DockRect } from '../components/bart-dock-placement'
import type { ThreadCardAnchorName, ThreadCardAnchorMeasure, ThreadCardAnchorRect } from '@openagent/plugin-kit/renderer'
import { getOverviewMotionCoordinator } from '../overview-motion'

interface BartRect {
  x: number
  y: number
  width: number
  height: number
}

/** 场景快照中的障碍（规划器的纯几何输入）。 */
type BartSceneObstacle = BartObstacle

interface BartSceneSnapshot {
  /** 内容平面坐标下的可视视口（俯瞰滚动容器，缺省为 root 自身）。 */
  readonly viewport: BartRect
  resolve(ref: BartAnchorRef): BartRect | null
  obstacles(excludeIds: ReadonlySet<string>, kinds?: readonly 'thread-card'[]): BartSceneObstacle[]
}

export class BartSpatialRegistry {
  private root: HTMLElement | null = null
  private dock: HTMLElement | null = null
  private scroll: HTMLElement | null = null
  private readonly threadCards = new Map<string, HTMLElement>()
  private readonly cardAnchors = new Map<string, Map<ThreadCardAnchorName, ThreadCardAnchorMeasure>>()
  private readonly cardVisibility = new Map<string, (hidden: boolean) => void>()
  private readonly hiddenCards = new Set<string>()

  private readonly unregisterListeners = new Set<(threadId: string) => void>()
  private readonly layoutListeners = new Set<() => void>()

  setRoot(root: HTMLElement | null): void {
    if (this.root === root) return
    this.root = root
    this.notifyLayout()
  }

  registerDock(element: HTMLElement | null): void {
    this.dock = element
  }

  registerScrollContainer(element: HTMLElement | null): void {
    this.scroll = element
    this.notifyLayout()
  }

  registerThreadAnchor(threadId: string, name: ThreadCardAnchorName, measure: ThreadCardAnchorMeasure | null): void {
    if (measure) {
      const anchors = this.cardAnchors.get(threadId) ?? new Map()
      anchors.set(name, measure)
      this.cardAnchors.set(threadId, anchors)
    } else {
      this.cardAnchors.get(threadId)?.delete(name)
    }
  }

  setThreadGenerationHidden(threadId: string, hidden: boolean): void {
    if (hidden) this.hiddenCards.add(threadId)
    else this.hiddenCards.delete(threadId)
    this.cardVisibility.get(threadId)?.(hidden)
  }

  rootElement(): HTMLElement | null {
    return this.root?.isConnected ? this.root : null
  }

  subscribeLayout(listener: () => void): () => void {
    this.layoutListeners.add(listener)
    return () => this.layoutListeners.delete(listener)
  }

  notifyLayout(): void {
    for (const listener of [...this.layoutListeners]) listener()
  }

  /** callback ref 约定：element 为 null 时注销（卸载）。 */
  registerThreadCard(
    threadId: string,
    element: HTMLElement | null,
    setGenerationHidden?: (hidden: boolean) => void
  ): void {
    if (element) {
      if (setGenerationHidden) {
        this.cardVisibility.set(threadId, setGenerationHidden)
        setGenerationHidden(this.hiddenCards.has(threadId))
      }
      if (this.threadCards.get(threadId) === element) return
      this.threadCards.set(threadId, element)
      this.notifyLayout()
      return
    }
    if (!this.threadCards.delete(threadId)) return
    this.cardAnchors.delete(threadId)
    this.cardVisibility.delete(threadId)
    this.hiddenCards.delete(threadId)
    this.notifyLayout()
    for (const listener of [...this.unregisterListeners]) listener(threadId)
  }

  /** 卡片注销通知：锁定中的活动段据此按「目标删除」中止。 */
  onThreadCardUnregister(listener: (threadId: string) => void): () => void {
    this.unregisterListeners.add(listener)
    return () => this.unregisterListeners.delete(listener)
  }

  dockElement(): HTMLElement | null {
    return this.dock?.isConnected ? this.dock : null
  }

  /** Root-local rectangles for every mounted Thread/Report card. */
  cardRootRects(): DockRect[] {
    const root = this.rootElement()
    if (!root) return []
    const rootRect = root.getBoundingClientRect()
    const rects: DockRect[] = []
    for (const element of this.threadCards.values()) {
      if (!element.isConnected) continue
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      rects.push({
        x: rect.left - rootRect.left,
        y: rect.top - rootRect.top,
        width: rect.width,
        height: rect.height
      })
    }
    return rects
  }

  /** Root-local Overview scroll viewport, or the root itself outside Overview. */
  viewportRootRect(): DockRect | null {
    const root = this.rootElement()
    if (!root) return null
    const rootRect = root.getBoundingClientRect()
    const scroll = this.scrollContainer()
    const element = scroll?.isConnected ? scroll : root
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: rect.left - rootRect.left,
      y: rect.top - rootRect.top,
      width: rect.width,
      height: rect.height
    }
  }

  /** 已挂载的 Thread 卡片元素（供业务在快照外做可见性判定）。 */
  threadCardElement(threadId: string): HTMLElement | null {
    const element = this.threadCards.get(threadId)
    return element?.isConnected ? element : null
  }

  /** 俯瞰滚动容器：供视口与可见性判定使用。 */
  scrollContainer(): HTMLElement | null {
    return this.scroll?.isConnected ? this.scroll : null
  }

  private toPlane(domRect: ThreadCardAnchorRect, rootRect: DOMRect): BartRect {
    return getOverviewMotionCoordinator().rootRectToPlane({
      x: domRect.left - rootRect.left,
      y: domRect.top - rootRect.top,
      width: domRect.width,
      height: domRect.height
    })
  }

  snapshot(): BartSceneSnapshot | null {
    const root = this.root
    if (!root || !root.isConnected) return null
    const rootRect = root.getBoundingClientRect()
    const rects = new Map<string, BartRect>()
    const obstacles: BartSceneObstacle[] = []
    const capture = (key: string, element: HTMLElement | null): void => {
      if (!element || !element.isConnected) return
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      rects.set(key, this.toPlane(rect, rootRect))
    }
    capture('dock', this.dock)
    for (const [id, element] of this.threadCards) {
      const before = rects.size
      capture(`thread:${id}`, element)
      if (rects.size > before) {
        obstacles.push({ id, kind: 'thread-card', rect: rects.get(`thread:${id}`)! })
        for (const [name, measure] of this.cardAnchors.get(id) ?? []) {
          const rect = measure()
          if (rect) rects.set(`thread:${id}:${name}`, this.toPlane(rect, rootRect))
        }
      }
    }
    const scroll = this.scrollContainer()
    const viewport = scroll && scroll.isConnected
      ? this.toPlane(scroll.getBoundingClientRect(), rootRect)
      : getOverviewMotionCoordinator().rootRectToPlane({
          x: 0,
          y: 0,
          width: rootRect.width,
          height: rootRect.height
        })

    return {
      viewport,
      resolve(ref: BartAnchorRef): BartRect | null {
        switch (ref.type) {
          case 'dock':
            return rects.get('dock') ?? null
          case 'thread':
            if (ref.attach === 'status' || ref.attach === 'excerpt-end') {
              return rects.get(`thread:${ref.threadId}:${ref.attach}`) ?? null
            }
            return rects.get(`thread:${ref.threadId}`) ?? null
          case 'point':
            return { x: ref.x, y: ref.y, width: 0, height: 0 }
        }
      },
      obstacles(excludeIds: ReadonlySet<string>, kinds?: readonly 'thread-card'[]): BartSceneObstacle[] {
        return obstacles.filter(
          obstacle => !excludeIds.has(obstacle.id) && (!kinds || kinds.includes(obstacle.kind))
        )
      }
    }
  }
}

let singleton: BartSpatialRegistry | null = null

export function getBartSpatialRegistry(): BartSpatialRegistry {
  if (!singleton) singleton = new BartSpatialRegistry()
  return singleton
}
