import { BODY_COLOR, CENTER } from '../bart-motion/character-model'
import { bartColor, tintOf } from '../bart-motion/appearance'
import { glassFor, type LiquidTheme } from './glass-recipe'

/** The circle in buildShape(), in the logo's 640 × 640 coordinate system. */
export const BART_BODY_RADIUS = 164
export const BART_BODY_DIAMETER = 2 * BART_BODY_RADIUS
export const BART_GLASS_CORNER = { cornerRadius: BART_BODY_RADIUS, cornerSmoothing: 0 }

/** Keep the Lab's canonical recipe separate from the 42px toolbar recipe. */
export function bartGlassFor(theme: LiquidTheme, color = BODY_COLOR, scale = 1) {
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Bart glass scale must be positive')
  const base = glassFor(theme)
  const fromBar = BART_BODY_DIAMETER / 42
  return {
    ...base,
    blur: 8,
    bezelWidth: Math.round(base.bezelWidth * fromBar) * scale,
    thickness: Math.round(base.thickness * fromBar) * scale,
    shadowBlur: Math.round(base.shadowBlur * fromBar) * scale,
    shadowOffsetY: Math.round(base.shadowOffsetY * fromBar) * scale,
    tint: tintOf(bartColor(color, BODY_COLOR), 0.8)
  }
}

export interface BartGlassBox { left: number; top: number; diameter: number }
export interface Affine2D { a: number; b: number; c: number; d: number; e: number; f: number }

/** Transform a circle, not the bounding box of the SVG (which may be letterboxed).
 * Non-uniform scale/skew cannot be represented by Glass's circular primitive. */
export function bartGlassBox(matrix: Affine2D): BartGlassBox | null {
  const values = [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]
  if (!values.every(Number.isFinite)) return null
  const xScale = Math.hypot(matrix.a, matrix.b), yScale = Math.hypot(matrix.c, matrix.d)
  if (xScale <= 0 || Math.abs(xScale - yScale) > xScale * 0.001
    || Math.abs(matrix.a * matrix.c + matrix.b * matrix.d) > xScale * yScale * 0.001) return null
  const radius = BART_BODY_RADIUS * xScale
  return {
    left: matrix.a * CENTER.x + matrix.c * CENTER.y + matrix.e - radius,
    top: matrix.b * CENTER.x + matrix.d * CENTER.y + matrix.f - radius,
    diameter: radius * 2
  }
}
