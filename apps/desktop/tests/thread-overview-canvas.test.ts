import { describe, expect, it } from 'vitest'
import {
  fitOverviewCanvasTransform,
  OVERVIEW_SCALE_FLOOR,
  overviewContentNeedsRefit,
  overviewRectVisibleInViewport,
  panOverviewCanvasToRect,
  panOverviewCanvasTransform,
  zoomOverviewCanvasTransform
} from '../src/shared/thread-overview-canvas'

const viewport = { width: 1000, height: 800 }

function content(width: number, height: number, left = 0, top = 0) {
  return { left, top, width, height }
}

describe('自动 fit', () => {
  it('allows the playground to fit a large layout and zoom without snapping to the application floor', () => {
    const box = content(2240, 1858)
    const preview = { width: 560, height: 800 }
    const fit = fitOverviewCanvasTransform(box, preview, 0.05)
    expect(fit.scale).toBeLessThan(OVERVIEW_SCALE_FLOOR)
    expect(fit.x).toBeGreaterThanOrEqual(0)
    expect(fit.y).toBeGreaterThanOrEqual(0)
    expect(fit.x + box.width * fit.scale).toBeLessThanOrEqual(preview.width)
    expect(fit.y + box.height * fit.scale).toBeLessThanOrEqual(preview.height)
    const zoom = zoomOverviewCanvasTransform(fit, { x: 280, y: 400 }, fit.scale * 1.1, 0.05)
    expect(zoom.scale).toBeCloseTo(fit.scale * 1.1)
  })
  it('缩小到完整可见并居中，放大上限 100%', () => {
    const box = content(1400, 1200, 60, 20)
    const fit = fitOverviewCanvasTransform(box, viewport)
    expect(fit.scale).toBeLessThan(1)
    expect(fit.scale).toBeGreaterThanOrEqual(OVERVIEW_SCALE_FLOOR)
    // 内容缩放后水平/垂直都居中。
    expect(fit.x + box.left * fit.scale).toBeCloseTo((viewport.width - box.width * fit.scale) / 2)
    expect(fit.y + box.top * fit.scale).toBeCloseTo((viewport.height - box.height * fit.scale) / 2)

    const small = fitOverviewCanvasTransform(content(400, 300), viewport)
    expect(small.scale).toBe(1)
  })

  it('fit 到地板仍放不下时钳制在地板并保持视觉中心（对称溢出）', () => {
    const box = content(10000, 10000)
    const fit = fitOverviewCanvasTransform(box, viewport)
    expect(fit.scale).toBe(OVERVIEW_SCALE_FLOOR)
    const scaledWidth = box.width * fit.scale
    const scaledHeight = box.height * fit.scale
    expect(fit.x).toBeCloseTo((viewport.width - scaledWidth) / 2)
    expect(fit.y).toBeCloseTo((viewport.height - scaledHeight) / 2)
    expect(fit.x).toBeLessThan(0)
    expect(fit.y).toBeLessThan(0)
  })
})

describe('手动缩放与平移', () => {
  it('单卡片可自由移出视野，缩放仍保持光标锚点', () => {
    const start = { scale: 1, x: 320, y: 279.6 }
    const panned = panOverviewCanvasTransform(start, 1500, -2000)
    expect(panned).toEqual({ scale: 1, x: 1820, y: -1720.4 })
    const zoomed = zoomOverviewCanvasTransform(panned, { x: 20, y: 40 }, 0.6)
    expect(zoomed).toEqual({ scale: 0.6, x: 1100, y: -1016.24 })
  })
  it('滚轮缩放统一钳制在 [地板, 100%]，光标下的内容点保持不动', () => {
    const box = content(1000, 2000)
    const start = fitOverviewCanvasTransform(box, viewport)
    const cursor = { x: 500, y: 400 }
    const zoomedOut = zoomOverviewCanvasTransform(start, cursor, 0.01)
    expect(zoomedOut.scale).toBe(OVERVIEW_SCALE_FLOOR)
    const zoomedIn = zoomOverviewCanvasTransform(start, cursor, 99)
    expect(zoomedIn.scale).toBe(1)

    // 光标锚定：不触发钳制的中等缩放，光标处平面坐标不变。
    const mid = zoomOverviewCanvasTransform(start, cursor, start.scale * 1.1)
    const planePointBefore = (cursor.x - start.x) / start.scale
    const planePointAfter = (cursor.x - mid.x) / mid.scale
    expect(planePointAfter).toBeCloseTo(planePointBefore)
  })


})

describe('新卡片 pan 与溢出指示', () => {
  it('pan 到卡片：保持缩放，以最小位移让目标完整进入取景区域', () => {
    const start = { scale: 1, x: 0, y: 0 }
    const card = { left: 0, top: 2000, width: 300, height: 176 }
    const panned = panOverviewCanvasToRect(start, viewport, card)
    expect(panned.scale).toBe(1)
    expect(panned).toEqual({ scale: 1, x: 24, y: -1400 })
  })

  it('视口外的卡片被判定为不可见', () => {
    const transform = { scale: 1, x: 0, y: 0 }
    expect(
      overviewRectVisibleInViewport({ left: 0, top: 100, width: 300, height: 176 }, transform, viewport)
    ).toBe(true)
    expect(
      overviewRectVisibleInViewport({ left: 0, top: 900, width: 300, height: 176 }, transform, viewport)
    ).toBe(false)
  })
})

describe('节流取景舒适带', () => {
  it('忽略带内小变化，只在溢出或明显过度留白时请求 refit', () => {
    const box = content(900, 900, 50, 0)
    const fitted = fitOverviewCanvasTransform(box, viewport)
    expect(overviewContentNeedsRefit(box, viewport, fitted)).toBe(false)
    expect(
      overviewContentNeedsRefit(content(900, 1500, 50, 0), viewport, fitted)
    ).toBe(true)
    expect(
      overviewContentNeedsRefit(content(500, 400, 250, 200), viewport, {
        scale: OVERVIEW_SCALE_FLOOR,
        x: 0,
        y: 0
      })
    ).toBe(true)
  })
})
