import type { MotionRevealFrame } from './worker-types'

/** Fade the moving edge without fading settled ink back out. Holds finish the
 * trailing glyphs, including the final line before the full-card handoff. */
export function softenWritingReveal(frames: readonly MotionRevealFrame[], width: number): MotionRevealFrame[] {
  if (frames.length < 2) return [...frames]
  const input = [...frames]
  const terminal = input.at(-1)!
  while (input.length > 1 && input.at(-1)!.x === terminal.x &&
    input.at(-1)!.top === terminal.top && input.at(-1)!.bottom === terminal.bottom) input.pop()
  const lastGlyph = input.at(-1)!
  // The production mask ends with an atomic full-block cut. Let the last ink
  // settle first, then make that same cut at an equal timestamp.
  const settledAt = Math.max(terminal.at, lastGlyph.at + 120)
  input.push({ ...lastGlyph, at: settledAt }, { ...terminal, at: settledAt })
  const output: MotionRevealFrame[] = []
  for (const frame of input) {
    const previous = output.at(-1)
    const sameLine = previous && frame.top === previous.top && frame.bottom === previous.bottom
    if (sameLine && frame.x === previous.x && frame.at > previous.at) {
      const finish = Math.min(frame.at, previous.at + 120)
      if (finish < frame.at) output.push({ ...previous, at: finish, feather: 0 })
      output.push({ ...frame, feather: 0 })
    } else {
      // A growing feather must never overtake its advancing edge, otherwise
      // a newly resumed phrase would make already revealed pixels disappear.
      const feather = sameLine ? Math.min(width, Math.max(0, (previous.feather ?? 0) + frame.x - previous.x)) : 0
      output.push({ ...frame, feather })
    }
  }
  output[output.length - 1] = { ...output.at(-1)!, feather: 0 }
  return output
}
