import { MOTION_LIMITS } from '../bart-motion/runtime-limits'

/** Both pages and the padded character share the window's texture budget. */
export function cameraSnapshotRatio(width: number, height: number, dock: { width: number; height: number }, deviceRatio: number): number {
  const pixels = width * height * 2 + dock.width * dock.height
  // Leave room for rounding and other prepared assets in the same Worker.
  const budget = MOTION_LIMITS.textureBytes * .9
  return Math.min(deviceRatio || 1, 2, MOTION_LIMITS.textureSide / Math.max(width, height, dock.width, dock.height),
    Math.sqrt(budget / (pixels * 4)))
}
