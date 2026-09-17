import {
  IDENTITY_CANVAS_TRANSFORM,
  type OverviewCanvasTransform
} from '../../../shared/thread-overview-canvas'

export interface OverviewStageLease {
  readonly owner: string
  release(): void
}

interface PendingStageLease {
  owner: string
  signal?: AbortSignal
  resolve: (lease: OverviewStageLease) => void
  reject: (error: Error) => void
  onAbort: () => void
}

const MAX_PENDING_STAGES = 512

export interface OverviewPlaneMapping {
  /** 内容平面原点在 App root 本地坐标中的位置。 */
  x: number
  y: number
  /** 内容平面 CSS 像素到 App root CSS 像素的统一缩放。 */
  scale: number
}

const IDENTITY_PLANE_MAPPING: OverviewPlaneMapping = { x: 0, y: 0, scale: 1 }

/**
 * Overview 运动协调器。
 *
 * 它不是通用动画框架，只保存三个跨组件共享的事实：唯一全局运动 FIFO、
 * scene-cut 代次，以及内容平面到 App root 的当前坐标映射。动画 payload 仍由
 * 各自组件显式持有；这里的租约就是全局队列项的执行凭证，不是第二层调度。
 */
export class OverviewMotionCoordinator {
  private activeLease: OverviewStageLeaseImpl | null = null
  private readonly leaseQueue: PendingStageLease[] = []
  private sceneEpochValue = 0
  private readonly sceneCutListeners = new Set<(epoch: number, source?: string) => void>()
  private readonly stageIdleListeners = new Set<() => void>()
  private cameraActive = false
  private cameraTransform: OverviewCanvasTransform = IDENTITY_CANVAS_TRANSFORM
  private planeBase = { x: 0, y: 0 }
  private planeMappingValue: OverviewPlaneMapping = IDENTITY_PLANE_MAPPING
  private readonly planeMappingListeners = new Set<() => void>()

  readonly subscribePlaneMapping = (listener: () => void): (() => void) => {
    this.planeMappingListeners.add(listener)
    return () => this.planeMappingListeners.delete(listener)
  }

  acquireStage(owner: string, signal?: AbortSignal): Promise<OverviewStageLease> {
    if (signal?.aborted) return Promise.reject(abortError())
    if (this.leaseQueue.length >= MAX_PENDING_STAGES) return Promise.reject(new Error('Overview stage queue is full'))
    if (!this.activeLease) {
      const lease = this.grant(owner, signal)
      return Promise.resolve(lease)
    }
    const reservation = this.createPendingLease(owner, signal)
    this.leaseQueue.push(reservation.pending)
    return reservation.promise
  }

  /**
   * 把当前队列项展开出的后继节拍紧邻插入其后。
   *
   * 布局 revision 只有轮到全局队列时才能测量目标 DOM，因此无法在最初入队时
   * 预先知道 resize / reflow / entry 的完整集合。它在 plan/commit 项执行时展开
   * 后继节拍；这些节拍必须排在已经等待的 Bart、camera 或下一条 revision 前，
   * 否则一次尚未落定的布局变化会被别的运动从中间穿插。
   */
  reserveStagesAfter(
    activeLease: OverviewStageLease,
    owners: readonly string[],
    signal?: AbortSignal
  ): readonly Promise<OverviewStageLease>[] {
    if (this.activeLease !== activeLease) {
      throw new Error('Overview stage continuations require the active lease')
    }
    if (!owners.length) return []
    if (this.leaseQueue.length + owners.length > MAX_PENDING_STAGES) throw new Error('Overview stage queue is full')
    if (signal?.aborted) return owners.map(() => Promise.reject(abortError()))
    const reservations = owners.map((owner) => this.createPendingLease(owner, signal))
    this.leaseQueue.unshift(...reservations.map((reservation) => reservation.pending))
    return reservations.map((reservation) => reservation.promise)
  }

  /** 舞台当前被租约占用。摄像机入场用它决定「动画入场」还是「直接对齐」。 */
  get stageBusy(): boolean {
    return this.activeLease !== null
  }

  /**
   * 在当前租约释放且没有可交接的排队租约后通知一次。
   *
   * 交接中的 lease 不会先发布 idle，避免依赖这个信号的布局测量在连续节拍
   * 之间读取到一个并不存在的空闲窗口。
   */
  subscribeStageIdle(listener: () => void): () => void {
    this.stageIdleListeners.add(listener)
    return () => this.stageIdleListeners.delete(listener)
  }

  cutScene(source?: string): number {
    this.sceneEpochValue += 1
    for (const listener of [...this.sceneCutListeners]) listener(this.sceneEpochValue, source)
    return this.sceneEpochValue
  }

  onSceneCut(listener: (epoch: number, source?: string) => void): () => void {
    this.sceneCutListeners.add(listener)
    return () => this.sceneCutListeners.delete(listener)
  }

  /** 摄像机每次实际变换（含 rAF 中间帧）都从这里提交。 */
  setCameraView(active: boolean, transform: OverviewCanvasTransform): void {
    this.cameraActive = active
    this.cameraTransform = active ? transform : IDENTITY_CANVAS_TRANSFORM
    this.rebuildPlaneMapping()
  }

  /**
   * DOM 提交、原生滚动或 root resize 后同步一次不带 camera transform 的平面基点。
   * 动画帧只使用这个缓存和显式 camera transform，不读取 DOM。
   */
  syncPlaneGeometry(root: HTMLElement, plane: HTMLElement): void {
    const rootRect = root.getBoundingClientRect()
    const planeRect = plane.getBoundingClientRect()
    const transform = this.cameraActive ? this.cameraTransform : IDENTITY_CANVAS_TRANSFORM
    this.planeBase = {
      x: planeRect.left - rootRect.left - transform.x,
      y: planeRect.top - rootRect.top - transform.y
    }
    this.rebuildPlaneMapping()
  }

  resetPlaneGeometry(): void {
    this.cameraActive = false
    this.cameraTransform = IDENTITY_CANVAS_TRANSFORM
    this.planeBase = { x: 0, y: 0 }
    this.publishPlaneMapping(IDENTITY_PLANE_MAPPING)
  }

  get planeMapping(): OverviewPlaneMapping {
    return this.planeMappingValue
  }

  rootPointToPlane(point: { x: number; y: number }): { x: number; y: number } {
    const mapping = this.planeMappingValue
    return {
      x: (point.x - mapping.x) / mapping.scale,
      y: (point.y - mapping.y) / mapping.scale
    }
  }

  planePointToRoot(point: { x: number; y: number }): { x: number; y: number } {
    const mapping = this.planeMappingValue
    return {
      x: mapping.x + point.x * mapping.scale,
      y: mapping.y + point.y * mapping.scale
    }
  }

  rootRectToPlane(rect: {
    x: number
    y: number
    width: number
    height: number
  }): { x: number; y: number; width: number; height: number } {
    const origin = this.rootPointToPlane(rect)
    const scale = this.planeMappingValue.scale
    return {
      x: origin.x,
      y: origin.y,
      width: rect.width / scale,
      height: rect.height / scale
    }
  }

  private rebuildPlaneMapping(): void {
    const transform = this.cameraActive ? this.cameraTransform : IDENTITY_CANVAS_TRANSFORM
    this.publishPlaneMapping({
      x: this.planeBase.x + transform.x,
      y: this.planeBase.y + transform.y,
      scale: transform.scale
    })
  }

  private publishPlaneMapping(mapping: OverviewPlaneMapping): void {
    const previous = this.planeMappingValue
    if (
      previous.x === mapping.x &&
      previous.y === mapping.y &&
      previous.scale === mapping.scale
    ) return
    this.planeMappingValue = mapping
    for (const listener of [...this.planeMappingListeners]) listener()
  }

  private grant(owner: string, signal?: AbortSignal): OverviewStageLeaseImpl {
    const lease = new OverviewStageLeaseImpl(owner, () => this.releaseLease(lease))
    this.activeLease = lease
    if (signal) {
      const releaseOnAbort = (): void => lease.release()
      signal.addEventListener('abort', releaseOnAbort, { once: true })
      lease.setAbortCleanup(() => signal.removeEventListener('abort', releaseOnAbort))
    }
    return lease
  }

  private createPendingLease(owner: string, signal?: AbortSignal): {
    pending: PendingStageLease
    promise: Promise<OverviewStageLease>
  } {
    let pending!: PendingStageLease
    const promise = new Promise<OverviewStageLease>((resolve, reject) => {
      pending = {
        owner,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.leaseQueue.indexOf(pending)
          if (index >= 0) this.leaseQueue.splice(index, 1)
          reject(abortError())
        }
      }
    })
    signal?.addEventListener('abort', pending.onAbort, { once: true })
    return { pending, promise }
  }

  private releaseLease(lease: OverviewStageLeaseImpl): void {
    if (this.activeLease !== lease) return
    this.activeLease = null
    let next = this.leaseQueue.shift()
    while (next) {
      next.signal?.removeEventListener('abort', next.onAbort)
      if (next.signal?.aborted) {
        next.reject(abortError())
        next = this.leaseQueue.shift()
        continue
      }
      next.resolve(this.grant(next.owner, next.signal))
      return
    }
    for (const listener of [...this.stageIdleListeners]) listener()
  }
}

class OverviewStageLeaseImpl implements OverviewStageLease {
  private released = false
  private abortCleanup: (() => void) | null = null

  constructor(
    readonly owner: string,
    private readonly onRelease: () => void
  ) {}

  setAbortCleanup(cleanup: () => void): void {
    this.abortCleanup = cleanup
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.abortCleanup?.()
    this.abortCleanup = null
    this.onRelease()
  }
}

function abortError(): DOMException {
  return new DOMException('Overview motion cancelled', 'AbortError')
}

let coordinator: OverviewMotionCoordinator | null = null

export function getOverviewMotionCoordinator(): OverviewMotionCoordinator {
  coordinator ||= new OverviewMotionCoordinator()
  return coordinator
}
