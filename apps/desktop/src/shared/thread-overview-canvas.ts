/**
 * 俯瞰摄像机的纯几何。组件只负责测量 DOM 与应用 transform；
 * 所有数值决策集中在这里，保持可确定性测试。
 *
 * 坐标系：内容平面（plane）原点在视口左上角，未缩放；transform 先缩放后平移，
 * `x/y` 是平面在视口坐标系里的偏移。
 */

export interface OverviewViewportBox {
  width: number
  height: number
  /** 固定工具栏在视口坐标中的实际下沿；不含 Dock。 */
  toolbarBottom?: number
}

/** 网格内容在平面坐标系里的包围盒（只含卡片及卡片间距）。 */
export interface OverviewContentBox {
  left: number
  top: number
  width: number
  height: number
}

export interface OverviewCanvasTransform {
  scale: number
  x: number
  y: number
}

/**
 * 缩放地板：自动 fit 与手动缩放统一钳制在 [地板, 100%]。取 0.6，使卡片上的
 * 介入按钮（≈28px 高）缩放后仍有 ≈17px 命中高度，保持可安全点击。
 */
export const OVERVIEW_SCALE_FLOOR = 0.6
const OVERVIEW_SCALE_MAX = 1

/** 自动取景使用屏幕像素留白；与卡片平面缩放无关。 */
export function overviewFramingRegion(viewport: OverviewViewportBox): OverviewContentBox {
  const margin = viewport.width <= 620 ? 16 : 24
  const left = Math.min(margin, viewport.width / 2)
  const top = Math.min(Math.max(0, viewport.toolbarBottom ?? 0) + margin, viewport.height)
  return { left, top, width: Math.max(0, viewport.width - 2 * left),
    height: Math.max(0, viewport.height - top - margin) }
}

export const IDENTITY_CANVAS_TRANSFORM: OverviewCanvasTransform = { scale: 1, x: 0, y: 0 }

function clampOverviewScale(scale: number, minimumScale = OVERVIEW_SCALE_FLOOR): number {
  if (!Number.isFinite(scale)) return OVERVIEW_SCALE_MAX
  return Math.min(OVERVIEW_SCALE_MAX, Math.max(minimumScale, scale))
}

/**
 * 自动 fit：内容包围盒使用屏幕取景区域；放大上限 100%，缩小钳制到
 * 地板。fit 到地板仍放不下时保持视觉中心（内容居中、对称溢出视口）。
 */
export function fitOverviewCanvasTransform(
  content: OverviewContentBox,
  viewport: OverviewViewportBox,
  minimumScale = OVERVIEW_SCALE_FLOOR
): OverviewCanvasTransform {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return IDENTITY_CANVAS_TRANSFORM
  const region = overviewFramingRegion(viewport)
  const scale = clampOverviewScale(
    Math.min(
      region.width / content.width,
      region.height / content.height
    ), minimumScale
  )
  return centerOverviewContent(content, viewport, scale)
}

function centerOverviewContent(
  content: OverviewContentBox,
  viewport: OverviewViewportBox,
  scale: number
): OverviewCanvasTransform {
  const region = overviewFramingRegion(viewport)
  const remainingHeight = region.height - content.height * scale
  return {
    scale,
    x: region.left + (region.width - content.width * scale) / 2 - content.left * scale,
    y: region.top + remainingHeight * (remainingHeight >= 0 ? 0.4 : 0.5) - content.top * scale
  }
}

/** 以光标为中心缩放；自由浏览不对平移做内容边界钳制。 */
export function zoomOverviewCanvasTransform(
  transform: OverviewCanvasTransform,
  cursor: { x: number; y: number },
  nextScale: number,
  minimumScale = OVERVIEW_SCALE_FLOOR
): OverviewCanvasTransform {
  const scale = clampOverviewScale(nextScale, minimumScale)
  const ratio = scale / transform.scale
  return { scale, x: cursor.x - (cursor.x - transform.x) * ratio,
    y: cursor.y - (cursor.y - transform.y) * ratio }
}

/** 用户自由平移，允许全部内容暂时离开视野。 */
export function panOverviewCanvasTransform(
  transform: OverviewCanvasTransform,
  deltaX: number,
  deltaY: number
): OverviewCanvasTransform {
  return { scale: transform.scale, x: transform.x + deltaX, y: transform.y + deltaY }
}

/** 自动 reveal：保持缩放，以最小位移将目标放入取景区域；过大轴居中溢出。 */
export function panOverviewCanvasToRect(
  transform: OverviewCanvasTransform,
  viewport: OverviewViewportBox,
  rect: OverviewContentBox
): OverviewCanvasTransform {
  const region = overviewFramingRegion(viewport)
  const { scale } = transform
  const revealAxis = (offset: number, start: number, size: number, edge: number, span: number): number => {
    const length = size * scale
    if (length > span) return edge + (span - length) / 2 - start * scale
    return Math.max(edge - start * scale, Math.min(edge + span - (start + size) * scale, offset))
  }
  return { scale, x: revealAxis(transform.x, rect.left, rect.width, region.left, region.width),
    y: revealAxis(transform.y, rect.top, rect.height, region.top, region.height) }
}

/** 卡片在当前 transform 下是否与视口相交（用于「N 待介入」溢出指示）。 */
export function overviewRectVisibleInViewport(
  rect: OverviewContentBox,
  transform: OverviewCanvasTransform,
  viewport: OverviewViewportBox
): boolean {
  const left = transform.x + rect.left * transform.scale
  const top = transform.y + rect.top * transform.scale
  const right = left + rect.width * transform.scale
  const bottom = top + rect.height * transform.scale
  const region = overviewFramingRegion(viewport)
  return right > region.left && bottom > region.top &&
    left < region.left + region.width && top < region.top + region.height
}

/**
 * 舒适带判定：内容溢出视口，或当前取景相较理想 fit 留下了明显过量空白时，
 * 才需要环境驾驶重新取景。小幅结构变化留在带内，不触发整平面动画。
 */
export function overviewContentNeedsRefit(
  content: OverviewContentBox,
  viewport: OverviewViewportBox,
  transform: OverviewCanvasTransform,
  minimumScale = OVERVIEW_SCALE_FLOOR
): boolean {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return false
  }
  const ideal = fitOverviewCanvasTransform(content, viewport, minimumScale)
  // 下限下的不可避免溢出不能导致永远 refit 到相同位置。
  if (Math.abs(ideal.scale - transform.scale) < 1e-6 &&
      Math.abs(ideal.x - transform.x) < 1 && Math.abs(ideal.y - transform.y) < 1) return false
  const region = overviewFramingRegion(viewport)
  const left = transform.x + content.left * transform.scale
  const top = transform.y + content.top * transform.scale
  if (left < region.left - 1 || top < region.top - 1 ||
      left + content.width * transform.scale > region.left + region.width + 1 ||
      top + content.height * transform.scale > region.top + region.height + 1) return true
  return ideal.scale - transform.scale > 0.08 ||
    Math.abs(ideal.x - transform.x) > region.width * 0.1 ||
    Math.abs(ideal.y - transform.y) > region.height * 0.1
}
