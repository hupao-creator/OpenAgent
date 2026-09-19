export interface MeasuredCharacter {
  left: number
  right: number
  top: number
  bottom: number
  lineHeight: number
  weight: number
  /** Visible character retained for the prepared writing rhythm. */
  text?: string
}

export interface TypesetCaretPoint { x: number; y: number; at: number }

function interval(points: readonly number[], at: number): { index: number; fraction: number } {
  let index = 0
  // Equal timestamps are intentional cuts. Select the last point at that time.
  while (index + 1 < points.length && points[index + 1]! <= at) index++
  const end = points[index + 1]
  return { index, fraction: end === undefined ? 0 : Math.max(0, (at - points[index]!) / (end - points[index]!)) }
}

/** Sample on the DOM paint clock; avoid compositor interpolation of clip-path. */
export function createClipSampler(frames: readonly Keyframe[]): (progress: number) => string {
  const offsets = frames.map(frame => Number(frame.offset))
  const polygons = frames.map(frame => String(frame.clipPath).match(/-?\d+(?:\.\d+)?/g)!.map(Number))
  return progress => {
    const { index, fraction } = interval(offsets, Math.min(1, progress))
    const from = polygons[index]!, to = polygons[index + 1] ?? from
    const values = from.map((value, axis) => value + (to[axis]! - value) * fraction)
    const pairs: string[] = []
    for (let axis = 0; axis < values.length; axis += 2) pairs.push(`${values[axis]}px ${values[axis + 1]}px`)
    return `polygon(${pairs.join(',')})`
  }
}

export function createCaretSampler(
  points: readonly TypesetCaretPoint[],
  containment?: { left: number; top: number; right: number; bottom: number; radius: number; inset: number }
): (at: number) => { x: number; y: number } {
  const times = points.map(point => point.at)
  return at => {
    const { index, fraction } = interval(times, at)
    const from = points[index]!, to = points[index + 1] ?? from
    const point = { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction }
    if (containment) {
      // Bound the whole circle, while the independent reveal front completes.
      const padding = containment.radius + containment.inset
      point.x = Math.max(containment.left + padding, Math.min(containment.right - padding, point.x))
      point.y = Math.max(containment.top + padding, Math.min(containment.bottom - padding, point.y))
    }
    return point
  }
}

/** One block, measured in its final layout. All frames use the same polygon topology. */
export function typesetBlock(
  characters: readonly MeasuredCharacter[],
  bounds: { width: number; height: number; singleLine?: boolean },
  duration: number
): { frames: Keyframe[]; caret: TypesetCaretPoint[] } {
  const lines: Array<{ characters: MeasuredCharacter[]; top: number; bottom: number; center: number }> = []
  for (const character of characters) {
    const center = bounds.singleLine ? bounds.height / 2 : (character.top + character.bottom) / 2
    // Range rectangles describe font metrics, not the full CSS line box. Include
    // the leading and one pixel for fractional positions / glyph ink overshoot.
    const leading = Math.max(0, character.lineHeight - (character.bottom - character.top)) / 2
    const top = bounds.singleLine ? -2 : Math.floor(character.top - leading - 1)
    const bottom = bounds.singleLine ? bounds.height + 2 : Math.ceil(character.bottom + leading + 1)
    const previous = lines.at(-1)
    if (previous && (bounds.singleLine || Math.abs(center - previous.center) < Math.max(4, character.lineHeight / 2))) {
      previous.characters.push(character)
      previous.top = Math.min(previous.top, top)
      previous.bottom = Math.max(previous.bottom, bottom)
    } else lines.push({ characters: [character], top, bottom, center })
  }
  // Neighboring line boxes meet in the whitespace between their glyphs. The
  // complete previous line stays visible when the next one starts.
  for (let index = 1; index < lines.length; index++) {
    const previous = lines[index - 1]!
    const current = lines[index]!
    const boundary = (Math.max(...previous.characters.map(c => c.bottom)) +
      Math.min(...current.characters.map(c => c.top))) / 2
    previous.bottom = Math.min(previous.bottom, boundary)
    current.top = previous.bottom
  }
  const left = Math.min(-2, ...lines.flatMap(line => line.characters.map(c => c.left)))
  const top = Math.min(-2, ...lines.map(line => line.top))
  const right = Math.max(bounds.width + 2, ...characters.map(c => c.right + 1))
  const bottom = Math.max(bounds.height + 2, ...lines.map(line => line.bottom))
  const polygon = (x: number, lineTop: number, lineBottom: number): string =>
    `polygon(${left}px ${top}px,${right}px ${top}px,${right}px ${lineTop}px,${x}px ${lineTop}px,${x}px ${lineBottom}px,${left}px ${lineBottom}px)`
  let previousClip = polygon(left, top, top)
  const frames: Keyframe[] = [{ clipPath: previousClip, offset: 0 }]
  const caret: TypesetCaretPoint[] = []
  const total = characters.reduce((sum, character) => sum + character.weight, 0) || 1
  let weight = 0
  for (const line of lines) {
    const start = weight / total
    const first = line.characters[0]!
    // Same offset: hold the old line until its final frame, then teleport to
    // the new line's left edge. No diagonal reveal or caret travel.
    frames.push({ clipPath: previousClip, offset: start },
      { clipPath: polygon(first.left, line.top, line.bottom), offset: start })
    const previousCaret = caret.at(-1)
    if (previousCaret) caret.push({ ...previousCaret, at: start * duration })
    caret.push({ x: first.left, y: line.center, at: start * duration })
    for (const character of line.characters) {
      weight += character.weight
      const end = weight / total
      previousClip = polygon(character.right, line.top, line.bottom)
      frames.push({ clipPath: previousClip, offset: end })
      caret.push({ x: character.right, y: line.center, at: end * duration })
    }
  }
  frames.push({ clipPath: polygon(right, top, bottom), offset: 1 })
  return { frames, caret }
}
