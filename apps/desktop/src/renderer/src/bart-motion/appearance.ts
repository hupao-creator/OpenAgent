import { type BartLogoLayout, type BartLogoShape } from './character-model'

export type BartBodyMaterial = 'solid' | 'liquidGlass'

/** Restrict renderer input to the same portable colour format as the colour picker. */
export function bartColor(value: string | undefined, fallback: string): string {
  return value && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : fallback
}

export function tintOf(hex: string, alpha: number): { r: number; g: number; b: number; a: number } {
  if (!/^#[\da-f]{6}$/i.test(hex) || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new RangeError('Bart tint requires #rrggbb and an alpha between 0 and 1')
  }
  const value = Number.parseInt(hex.slice(1), 16)
  return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255, a: alpha }
}

export function supportsBartGlass(layout: BartLogoLayout, shape: BartLogoShape, intervention?: string): boolean {
  return layout === 'mark' && shape === 'circle' && !intervention
}
