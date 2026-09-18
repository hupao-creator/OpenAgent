import {
  fitOverviewCanvasTransform,
  IDENTITY_CANVAS_TRANSFORM,
  OVERVIEW_SCALE_FLOOR,
  overviewContentNeedsRefit,
  panOverviewCanvasToRect,
  type OverviewCanvasTransform,
  type OverviewContentBox,
  type OverviewViewportBox
} from '../../../shared/thread-overview-canvas'
import {
  getOverviewMotionCoordinator,
  type OverviewStageLease
} from './coordinator'
import { cameraMove, cameraTransformCss, sampleCamera, type CameraFrame } from './camera-track'

export interface OverviewCameraState {
  transform: OverviewCanvasTransform
  /** 用户接管后环境驾驶停止。 */
  manual: boolean
}

interface OverviewCameraSnapshot extends OverviewCameraState {
  /** 返回观察窗口及其自动取景期间，允许用户立即交还控制。 */
  returning: boolean
}

/** 宿主持有一个运行期书签；切集合时替换，不保存各标签的视角历史。 */
export interface OverviewCameraMemory {
  current: { sceneKey: string; view: OverviewCameraState } | null
}

const CAMERA_ANIMATION_MS = 360
const RETURN_HOLD_MS = 600
const RETURN_OWNER = 'camera:restore-auto'
const REFIT_MIN_INTERVAL_MS = 600
const REFIT_TRAILING_MS = 160
/** 节流取景动画的租约 owner；deferRefit/requestRefit 据此识别可撤销的在途取景。 */
const REFIT_OWNER = 'camera:throttled-refit'

type CameraListener = () => void

/**
 * 单座摄像机驾驶舱。已知的程序化变换一次提交给原生合成器。
 *
 * 两条通知通道：`subscribe`/`getSnapshot` 是 React 店面，只在控制状态变化或变换落定（动画结束、cut、直接对齐）时更新——动画与手势的
 * 手势仍提交 DOM；自动播放无 Host 帧循环。`live` 按准备好的轨道与时钟求值，
 * 只供新的输入/测量读取，不能成为动画下一帧的前置条件。
 */
export class OverviewCameraCockpit {
  private state: OverviewCameraState | null = null
  private settledState: OverviewCameraSnapshot | null = null
  private readonly listeners = new Set<CameraListener>()
  private readonly frameListeners = new Set<CameraListener>()
  private animationAbort: AbortController | null = null
  private animationOwner: string | null = null
  private refitTimer = 0
  private returnEpoch = 0
  private returning = false
  private visible = true
  private lastRefitAt = -Infinity
  private bounds: { content: OverviewContentBox; viewport: OverviewViewportBox } | null = null
  private minimumScale = OVERVIEW_SCALE_FLOOR
  private plane: HTMLElement | null = null
  private track: { frames: readonly CameraFrame[]; started: number; duration: number; animation?: Animation; token: symbol } | null = null

  /** One DOM writer for automatic motion, direct cuts and user gestures. */
  bindPlane(plane: HTMLElement): () => void {
    this.plane = plane
    plane.style.transform = this.state ? cameraTransformCss(this.state.transform) : ''
    return () => {
      if (this.plane !== plane) return
      this.cancelEnvironmentMotion()
      this.plane = null
    }
  }

  /** A prepared generation owns this same camera until its valid Host handoff. */
  playPrepared(frames: readonly CameraFrame[], duration: number, started: number): { release(): void } {
    this.cancelReturn()
    this.cancelEnvironmentMotion()
    this.clearRefitTimer()
    const token = Symbol('camera-track')
    const animation = this.plane?.animate?.(frames.map(frame => ({
      transform: cameraTransformCss(frame), offset: frame.at / duration
    })), { duration, fill: 'both', easing: 'linear' })
    if (!animation) throw new Error('Overview camera surface unavailable')
    animation.startTime = started - performance.timeOrigin
    this.track = { frames, duration, started, animation, token }
    return { release: () => {
      if (this.track?.token !== token) return
      this.settleTrack()
    } }
  }

  private settleTrack(): void {
    const track = this.track
    if (!track) return
    const transform = sampleCamera(track.frames, performance.timeOrigin + currentTime() - track.started)
    this.track = null
    // Commit the underlying style before removing the held compositor effect.
    this.commit({ transform, manual: this.state?.manual ?? false })
    track.animation?.cancel()
  }

  /** Preview policy; the application keeps its readable-card floor by default. */
  setScaleFloor(minimumScale = OVERVIEW_SCALE_FLOOR): void {
    this.minimumScale = Number.isFinite(minimumScale) && minimumScale > 0 && minimumScale <= 1
      ? minimumScale : OVERVIEW_SCALE_FLOOR
  }

  readonly subscribe = (listener: CameraListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * React 店面快照。只用它读存在性与控制状态；其中的 transform 在动画
   * 与手势期间是滞后的，任何几何计算都必须读 `live`。
   */
  readonly getSnapshot = (): OverviewCameraSnapshot | null => this.settledState

  /** 逐帧变换流（含手势与动画中间帧）；回调内用 `live` 读取当前值。 */
  readonly subscribeFrame = (listener: CameraListener): (() => void) => {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  /** 当前逐帧真值；增量手势数学与 DOM 写入必须用它，不用 React 快照。 */
  get live(): OverviewCameraState | null {
    return this.track && this.state ? { ...this.state,
      transform: sampleCamera(this.track.frames, performance.timeOrigin + currentTime() - this.track.started) } : this.state
  }

  dispose(): void {
    this.cancelReturn()
    this.cancelEnvironmentMotion()
    this.clearRefitTimer()
    this.commit(null)
  }

  reconcileBounds(content: OverviewContentBox, viewport: OverviewViewportBox): void {
    this.bounds = { content, viewport }
    if (!hasGeometry(content, viewport)) {
      this.dispose()
      return
    }
    if (!this.state) this.cutTo(content, viewport)
  }

  /** 新场景立即自动取景，不携带旧集合的手动位置。 */
  cutTo(content: OverviewContentBox, viewport: OverviewViewportBox): void {
    this.cancelReturn()
    this.cancelEnvironmentMotion()
    this.clearRefitTimer()
    this.bounds = { content, viewport }
    this.commit(hasGeometry(content, viewport)
      ? { transform: this.fit(), manual: false } : null)
  }

  private fit(): OverviewCanvasTransform {
    return this.bounds
      ? fitOverviewCanvasTransform(this.bounds.content, this.bounds.viewport, this.minimumScale)
      : IDENTITY_CANVAS_TRANSFORM
  }

  /** 首帧先恢复旧视角；自动跟随在该帧之后保留一个完整观察窗口。 */
  restore(view: OverviewCameraState, content: OverviewContentBox, viewport: OverviewViewportBox): void {
    this.dispose()
    this.bounds = { content, viewport }
    if (!hasGeometry(content, viewport)) return
    this.returning = !view.manual
    this.commit({ manual: view.manual, transform: { ...view.transform } })
    if (view.manual) return
    this.scheduleReturn()
  }

  /** Bart 转场会预挂载隐藏的 Overview；隐藏时间不计入返回观察窗口。 */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    if (!visible) {
      const returning = this.returning
      this.cancelReturn()
      this.returning = returning
      this.clearRefitTimer()
      this.cancelEnvironmentMotion()
    } else if (this.returning) this.scheduleReturn()
    else if (this.bounds) this.requestRefit(this.bounds.content, this.bounds.viewport)
  }

  private scheduleReturn(): void {
    if (!this.visible || !this.returning) return
    const epoch = this.returnEpoch
    // The hold and following move are one effect; a busy Host cannot extend the
    // hold forever. New geometry is a new fact, reconciled after this effect.
    const due = currentTime() + RETURN_HOLD_MS
    void this.animateTo(() => this.fit(), { owner: RETURN_OWNER, due }).then(() => {
          if (this.returnEpoch !== epoch) return
          this.returning = false
          this.commit(this.state)
          // 返回动画期间环境变化只更新 bounds；落定后按最新边界补一次舒适带检查。
          if (this.bounds) this.requestRefit(this.bounds.content, this.bounds.viewport)
    })
  }

  private cancelReturn(): void {
    this.returnEpoch += 1
    this.returning = false
  }

  setManualTransform(transform: OverviewCanvasTransform): void {
    this.cancelReturn()
    this.cancelEnvironmentMotion()
    this.clearRefitTimer()
    if (!this.state) return
    // 手势逐帧变换只走帧通道；manual 标志翻转本身会触发一次 React 更新。
    this.commit({ transform, manual: true }, false)
  }

  returnToAuto(content: OverviewContentBox, viewport: OverviewViewportBox): void {
    this.cancelReturn()
    this.bounds = { content, viewport }
    const state = this.state
    if (!state) return
    this.commit({ ...state, manual: false })
    void this.animateTo(() => this.fit(), { owner: 'camera:return-auto' })
  }

  /** 节拍队列排空后调用；只在舒适带外取景，目标在取得舞台后读取。 */
  requestRefit(content: OverviewContentBox, viewport: OverviewViewportBox): void {
    this.bounds = { content, viewport }
    const state = this.state
    if (!state || state.manual || this.returning || !this.visible) return
    this.clearRefitTimer()
    if (!overviewContentNeedsRefit(content, viewport, state.transform, this.minimumScale)) {
      if (this.animationOwner === REFIT_OWNER) this.cancelEnvironmentMotion()
      return
    }
    const delay = Math.max(REFIT_TRAILING_MS, this.lastRefitAt + REFIT_MIN_INTERVAL_MS - currentTime())
    this.refitTimer = window.setTimeout(() => {
      this.refitTimer = 0
      if (!this.state || this.state.manual) return
      this.lastRefitAt = currentTime()
      void this.animateTo(() => this.fit(), { owner: REFIT_OWNER })
    }, delay)
  }

  /** 新节拍到达：撤销旧尾沿 refit，等队列再次排空后用最新包围盒重判。 */
  deferRefit(): void {
    this.clearRefitTimer()
    if (this.animationOwner === REFIT_OWNER) {
      this.cancelEnvironmentMotion()
    }
  }

  /**
   * reveal pan 属于叙事节拍；已有舞台租约时复用它，避免 Bart 抢在 pan 前起飞。
   * 返回 true 表示请求已满足（pan 落地或本就可见）；被取消返回 false，
   * 调用方不得把取消的 pan 标记为已处理。
   */
  async reveal(
    rect: OverviewContentBox,
    content: OverviewContentBox,
    viewport: OverviewViewportBox,
    lease?: OverviewStageLease
  ): Promise<boolean> {
    this.bounds = { content, viewport }
    const state = this.state
    if (!state || state.manual || this.returning || !this.visible) return true
    return this.animateTo(
      () => panOverviewCanvasToRect(this.state?.transform ?? state.transform, this.bounds?.viewport ?? viewport, rect),
      { owner: 'camera:reveal', lease }
    )
  }

  private async animateTo(
    targetForBounds: () => OverviewCanvasTransform,
    options: {
      owner: string
      lease?: OverviewStageLease
      due?: number
    }
  ): Promise<boolean> {
    // reveal / 显式回到自动都比旧的尾沿 refit 更新；不能让延迟
    // timer 在这些动画中途重新夺回驾驶舱。
    this.clearRefitTimer()
    this.cancelEnvironmentMotion()
    const controller = new AbortController()
    this.animationAbort = controller
    this.animationOwner = options.owner
    let ownedLease: OverviewStageLease | undefined
    try {
      if (!options.lease) {
        ownedLease = await getOverviewMotionCoordinator().acquireStage(
          options.owner,
          controller.signal
        )
      }
      if (controller.signal.aborted) return false
      const from = this.state?.transform ?? IDENTITY_CANVAS_TRANSFORM
      const target = targetForBounds()
      if (sameTransform(from, target) && options.due === undefined) return true
      const delay = Math.max(0, (options.due ?? currentTime()) - currentTime())
      const frames = cameraMove(from, target, CAMERA_ANIMATION_MS, delay)
      const duration = CAMERA_ANIMATION_MS + delay
      const started = performance.timeOrigin + currentTime()
      const token = Symbol('camera-auto')
      const animation = this.plane?.animate?.(frames.map(frame => ({
        transform: cameraTransformCss(frame), offset: frame.at / duration
      })), { duration, fill: 'both', easing: 'linear' })
      if (!animation) {
        // No drawable plane (unmounted or unavailable): show the static result.
        this.commit({ transform: target, manual: this.state?.manual ?? false })
        return true
      }
      animation.startTime = started - performance.timeOrigin
      this.track = { frames, duration, started, animation, token }
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          controller.signal.removeEventListener('abort', onAbort)
        }
        const onAbort = (): void => {
          cleanup()
          if (this.track?.token === token) this.settleTrack()
          reject(abortError())
        }
        controller.signal.addEventListener('abort', onAbort, { once: true })
        void animation.finished.then(() => {
          cleanup()
          if (this.track?.token === token) this.settleTrack()
          resolve()
        }, () => {
          cleanup()
          if (this.track?.token === token) this.settleTrack()
          reject(abortError())
        })
      })
      return true
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error
      return false
    } finally {
      if (this.animationAbort === controller) {
        this.animationAbort = null
        this.animationOwner = null
      }
      ownedLease?.release()
    }
  }

  private cancelEnvironmentMotion(): void {
    const controller = this.animationAbort
    this.animationAbort = null
    this.animationOwner = null
    controller?.abort()
    this.settleTrack()
  }

  private clearRefitTimer(): void {
    if (this.refitTimer) window.clearTimeout(this.refitTimer)
    this.refitTimer = 0
  }

  private commit(state: OverviewCameraState | null, settled = true): void {
    const previous = this.state
    if (!sameCameraState(previous, state)) {
      this.state = state
      if (this.plane) this.plane.style.transform = state ? cameraTransformCss(state.transform) : ''
      getOverviewMotionCoordinator().setCameraView(
        Boolean(state),
        state?.transform ?? IDENTITY_CANVAS_TRANSFORM
      )
      for (const listener of [...this.frameListeners]) listener()
    }
    const presenceChanged =
      Boolean(previous) !== Boolean(state) ||
      previous?.manual !== state?.manual ||
      this.settledState?.returning !== (state ? this.returning : undefined)
    if ((settled || presenceChanged) && (presenceChanged || !sameCameraState(this.settledState, state))) {
      this.settledState = state ? { ...state, returning: this.returning } : null
      for (const listener of [...this.listeners]) listener()
    }
  }
}

function hasGeometry(content: OverviewContentBox, viewport: OverviewViewportBox): boolean {
  return content.width > 0 && content.height > 0 && viewport.width > 0 && viewport.height > 0
}

function sameTransform(left: OverviewCanvasTransform, right: OverviewCanvasTransform): boolean {
  return Math.abs(left.x - right.x) < 0.001 && Math.abs(left.y - right.y) < 0.001 &&
    Math.abs(left.scale - right.scale) < 0.000001
}

function sameCameraState(
  left: OverviewCameraState | null,
  right: OverviewCameraState | null
): boolean {
  return left === right || Boolean(
    left && right &&
    left.manual === right.manual &&
    left.transform.scale === right.transform.scale &&
    left.transform.x === right.transform.x &&
    left.transform.y === right.transform.y
  )
}

function currentTime(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function abortError(): DOMException {
  return new DOMException('Overview camera motion cancelled', 'AbortError')
}

let cockpit: OverviewCameraCockpit | null = null

export function getOverviewCameraCockpit(): OverviewCameraCockpit {
  cockpit ||= new OverviewCameraCockpit()
  return cockpit
}
