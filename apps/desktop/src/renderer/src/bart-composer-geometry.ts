/**
 * The Dock's input capsule geometry. A draft is a textarea that grows with its
 * content and stops at five lines, and every number that decides how tall the
 * capsule becomes lives here — the Dock reads the rendered field back through
 * `bartCapsuleLines`, and publishes both constants to CSS so the stylesheet
 * cannot drift from the measurement.
 */
export const BART_CAPSULE_LINE_HEIGHT = 20
export const BART_CAPSULE_INSET = 13
export const BART_CAPSULE_MIN_LINES = 1
export const BART_CAPSULE_MAX_LINES = 5
/**
 * The attachments row above the field. It is the one part of the capsule that
 * is not measured — a chip is as tall as its own contents — so its height is
 * fixed here and published like the rest. The measured field height alone is
 * not the capsule: this row must also fit in the available input space.
 */
export const BART_CAPSULE_ATTACHMENT_HEIGHT = 39
/**
 * The capsule collapses back into the Dock when the input closes. The Dock has
 * to keep it mounted for exactly this long. The motion decides that, so the
 * stylesheet owns the number and the Dock reads it back; this is the stand-in
 * for when there is no stylesheet to read, as in jsdom.
 */
export const BART_CAPSULE_EXIT_MS = 240

/**
 * The rows a field of this height is showing; the field's own padding is
 * included. The reading stops at one row but not at the cap: a field may hold
 * more rows than the capsule is willing to show, and `bartCapsuleHeight` is
 * what decides that.
 */
export function bartCapsuleLines(measuredHeight: number): number {
  if (!Number.isFinite(measuredHeight)) return BART_CAPSULE_MIN_LINES
  const content = measuredHeight - BART_CAPSULE_INSET * 2
  return Math.max(Math.round(content / BART_CAPSULE_LINE_HEIGHT), BART_CAPSULE_MIN_LINES)
}

/** The capsule height for a line count, bounded to the row range a draft may reach. */
export function bartCapsuleHeight(lines: number): number {
  return boundedLines(lines) * BART_CAPSULE_LINE_HEIGHT + BART_CAPSULE_INSET * 2
}

function boundedLines(lines: number): number {
  if (!Number.isFinite(lines)) return BART_CAPSULE_MIN_LINES
  return Math.min(Math.max(Math.floor(lines), BART_CAPSULE_MIN_LINES), BART_CAPSULE_MAX_LINES)
}

/** The composer owns its available space; opening it never displaces Bart. */
export function bartCapsulePlacement(
  body: { top: number; bottom: number },
  bounds: { top: number; bottom: number },
  minimumHeight: number
) {
  const gap = 20
  const below = Math.max(0, bounds.bottom - body.bottom - gap)
  const above = Math.max(0, body.top - gap - bounds.top)
  const side = below >= minimumHeight || below >= above ? 'below' : 'above'
  return {
    side,
    anchor: side === 'below' ? body.bottom + gap : body.top - gap,
    room: Math.max(minimumHeight, side === 'below' ? below : above)
  }
}
