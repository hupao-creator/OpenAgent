import type { BartDockRole } from '../bart-role'

export type BartTimedState = Exclude<BartDockRole['kind'], 'idle'>
export type BartDisplayTiming = Readonly<Record<BartTimedState, { readonly minimumDisplayMs: number }>>

/** Provisional values; each state can be tuned without changing the queue. */
export const DEFAULT_BART_DISPLAY_TIMING: BartDisplayTiming = {
  running: { minimumDisplayMs: 800 },
  reasoning: { minimumDisplayMs: 800 },
  tool: { minimumDisplayMs: 800 }
}

export function validateDisplayTiming(timing: BartDisplayTiming): void {
  for (const kind of ['running', 'reasoning', 'tool'] as const) {
    const value = timing[kind]?.minimumDisplayMs
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid Bart ${kind} minimumDisplayMs`)
  }
}

/** A state supplies its next release deadline. The queue only advances FIFO. */
const releaseRules: Record<BartTimedState, (elapsed: number, minimum: number) => number> = {
  running: (elapsed, minimum) => Math.max(0, minimum - elapsed),
  tool: (elapsed, minimum) => Math.max(0, minimum - elapsed),
  // Reasoning is a streaming decoration, not a transcript reader. Its current
  // rule deliberately releases without waiting for source completion or glyphs.
  reasoning: (elapsed, minimum) => Math.max(0, minimum - elapsed)
}

export function releaseDelay(role: BartDockRole, elapsed: number, timing: BartDisplayTiming): number {
  return role.kind === 'idle' ? 0 : releaseRules[role.kind](elapsed, timing[role.kind].minimumDisplayMs)
}
