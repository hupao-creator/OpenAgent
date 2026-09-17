import { describe, expect, it } from 'vitest'
import { cameraSnapshotRatio } from '../src/renderer/src/bart-thread-transition/camera-snapshot-budget'
import { MOTION_LIMITS } from '../src/renderer/src/bart-motion/runtime-limits'

describe('camera snapshots share one bounded texture allocation', () => {
  it.each([
    [1920, 1080, 2], [3840, 2160, 1], [3840, 2160, 2], [2560, 1440, 2], [6016, 3384, 1]
  ])('fits two pages and the padded Dock at %i × %i, DPR %i', (width, height, dpr) => {
    const dock = { width: 592, height: 402 }
    const ratio = cameraSnapshotRatio(width, height, dock, dpr)
    const sizes = [[width, height], [width, height], [dock.width, dock.height]]
      .map(([w, h]) => [Math.round(w * ratio), Math.round(h * ratio)])
    expect(sizes.reduce((sum, [w, h]) => sum + w * h * 4, 0)).toBeLessThan(MOTION_LIMITS.textureBytes)
    expect(Math.max(...sizes.flat())).toBeLessThanOrEqual(MOTION_LIMITS.textureSide)
  })
  it('keeps native density when all captures fit', () => {
    expect(cameraSnapshotRatio(1180, 780, { width: 592, height: 402 }, 2)).toBe(2)
  })
})
