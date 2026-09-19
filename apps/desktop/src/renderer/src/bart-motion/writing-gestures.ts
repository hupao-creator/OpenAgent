export type WritingGesture = 'sprint' | 'spring' | 'glide'
export const writingTrailStyle = (style: WritingGesture): 'streaks' | 'wake' | undefined =>
  style === 'spring' ? 'streaks' : style === 'glide' ? 'wake' : undefined

export const smooth = (p: number): number => {
  const t = Math.max(0, Math.min(1, p))
  return t ** 3 * (10 - 15 * t + 6 * t ** 2)
}

export interface WritingGestureInput {
  activity: number
  direction: number
  launch: number
  brake: number
  envelope: number
}

/** Drive is sampled from the path, so the body leans into the actual travel
 * direction and relaxes at a stop. There is no independent bobbing clock. */
export function sampleWritingGesture(style: WritingGesture, input: WritingGestureInput) {
  const { activity: drive, direction, launch, brake, envelope } = input
  let angle: number, sx: number, sy: number, y: number, eyeX: number
  if (style === 'sprint') {
    angle = direction * drive * .18
    sx = 1 + .12 * drive
    sy = 1 - .075 * drive
    y = 0
    eyeX = direction * drive * 36
  } else if (style === 'spring') {
    const stretch = launch * drive, gather = launch * (1 - drive), settle = brake * (1 - drive)
    angle = direction * (drive * .23 + stretch * .025)
    sx = 1 + .15 * drive + .04 * stretch - .035 * gather - .02 * settle
    sy = 1 - .105 * drive - .025 * stretch + .025 * gather + .015 * settle
    y = 0
    eyeX = direction * (drive * 38 + stretch * 3)
  } else {
    angle = direction * drive * .1
    sx = 1 + .18 * drive
    sy = 1 - .12 * drive
    y = 0
    eyeX = direction * drive * 40
  }
  return { angle: angle * envelope, sx: 1 + (sx - 1) * envelope, sy: 1 + (sy - 1) * envelope,
    x: direction * drive * 1.3 * envelope, y: y * envelope,
    eyeX: eyeX * envelope, eyeY: 7 * drive * envelope,
    trailStrength: smooth((drive - .12) / .88) * envelope }
}

/** Use a wider velocity window than glyph spacing, avoiding a body pulse on every letter. */
export function writingDrive(velocity: (at: number) => number, at: number): Omit<WritingGestureInput, 'envelope'> {
  const value = velocity(at), past = Math.abs(velocity(at - 75)), next = Math.abs(velocity(at + 75))
  // Ordinary reading speed still has a visible forward stance, with a smooth
  // release to zero rather than a minimum pose that snaps off at punctuation.
  const speed = Math.abs(value)
  return { activity: .4 * smooth(speed / .04) + .6 * smooth(speed / .18), direction: Math.sign(value),
    launch: Math.max(0, Math.min(1, (next - past) / .2)),
    brake: Math.max(0, Math.min(1, (past - next) / .2)) }
}
