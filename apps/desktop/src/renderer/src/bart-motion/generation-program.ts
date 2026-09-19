import { planRoute } from './planner'
import { smoothStep } from './geometry'
import type { PreparedMotionCard } from './card-assets'
import type { BartWebGLPose } from './webgl-renderer'
import type { CharacterDescription, MotionMatrixFrame, MotionPoseFrame, MotionProgram, MotionTexture } from './worker-types'
import { cameraMove, type CameraFrame } from '../overview-motion/camera-track'

export function compileGenerationProgram(cards: readonly PreparedMotionCard[], dock: { x: number; y: number; radius: number },
  viewport?: MotionProgram['viewport'], detailedCards = cards.length): MotionProgram {
  const poses: MotionPoseFrame[] = [], textures: MotionTexture[] = []
  const phases: MotionProgram['phases'][number][] = []
  let time = 0
  const camera: CameraFrame[] = [{ at: 0, x: 0, y: 0, scale: 1 }]
  let view = { x: 0, y: 0, scale: 1 }
  let pose: BartWebGLPose = { ...dock, directionX: 1, directionY: 0, stretch: 0, alpha: 1 }
  const key = (at: number, next: BartWebGLPose): void => { pose = next; poses.push({ at, pose }) }
  const fly = (to: { x: number; y: number }, duration: number, targetRadius = 16): void => {
    const from = pose
    const { path } = planRoute({ from, to, random: () => 0.6 })
    const samples = Math.ceil(duration / 8)
    for (let index = 0; index <= samples; index++) {
      const t = index / samples, eased = t * t * (3 - 2 * t)
      const point = path.pointAt(eased)
      const tangent = path.tangentAt(eased), radius = from.radius + (targetRadius - from.radius) * eased
      key(time + duration * t, { ...from, ...point, radius, width: radius * 2, height: radius * 2, cornerRadius: radius,
        directionX: tangent.x, directionY: tangent.y, stretch: Math.sin(Math.PI * t) * 0.45,
        shapeMix: 0, surfaceMix: 0, eyeAlpha: 1, borderAlpha: 0, shadowAlpha: 0 })
    }
    time += duration
  }
  key(0, pose)
  for (const [index, card] of cards.slice(0, detailedCards).entries()) {
    const { rect } = card
    if (viewport) {
      // Every known destination is framed in advance, including cards outside
      // the initial viewport. Previously revealed textures follow the same
      // camera as the real DOM plane without a per-card Host continuation.
      const pan = (start: number, size: number, low: number, extent: number): number =>
        size > extent - 48 ? low + (extent - size) / 2 - start :
          Math.min(0, low + extent - 24 - start - size) + Math.max(0, low + 24 - start)
      const next = { x: view.x + pan(rect.x + view.x, rect.width, viewport.x, viewport.width),
        y: view.y + pan(rect.y + view.y, rect.height, viewport.y, viewport.height), scale: 1 }
      camera.push(...cameraMove(view, next, 360).map(frame => ({ ...frame, at: time + frame.at })))
      view = next
    }
    phases.push({ at: time, name: `fly:${index}` })
    fly({ x: rect.x + rect.width / 2 + view.x, y: rect.y + rect.height / 2 + view.y }, 490, dock.radius)
    phases.push({ at: time, name: `morph:${index}` })
    const orb = pose
    // Preserve the original inflate → stretch → overshoot → settle silhouette.
    // These are compiled once; the Worker interpolates them at display cadence.
    const stops = [
      { at: 0, width: orb.radius * 2, height: orb.radius * 2, corner: orb.radius },
      { at: .12, width: 106, height: 100, corner: 50 },
      { at: .36, width: Math.min(168, rect.width * .58), height: Math.min(126, rect.height * .72), corner: 46 },
      { at: .62, width: rect.width * .88, height: rect.height * .92, corner: 31 },
      { at: .82, width: rect.width + 12, height: rect.height - 4, corner: 20 },
      { at: .93, width: rect.width - 4, height: rect.height + 3, corner: 23 },
      { at: 1, width: rect.width, height: rect.height, corner: 22 }
    ]
    const samples = [...new Set([...Array.from({ length: 34 }, (_, step) => step / 33), ...stops.map(stop => stop.at)])].sort((a, b) => a - b)
    for (const t of samples) {
      const nextIndex = Math.max(1, stops.findIndex(stop => stop.at >= t))
      const from = stops[nextIndex - 1], to = stops[nextIndex]
      const p = smoothStep((t - from.at) / (to.at - from.at))
      key(time + t * 260, { ...orb, width: from.width + (to.width - from.width) * p,
        height: from.height + (to.height - from.height) * p, cornerRadius: from.corner + (to.corner - from.corner) * p,
        stretch: t < .18 ? Math.sin(t / .18 * Math.PI) * .08 : 0,
        shapeMix: smoothStep(t / .72), surfaceMix: smoothStep((t - .5) / .32),
        eyeAlpha: 1 - smoothStep((t - .56) / .28), borderAlpha: smoothStep((t - .7) / .2),
        shadowAlpha: smoothStep((t - .68) / .2) })
    }
    time += 260
    phases.push({ at: time, name: `reveal:${index}` })
    textures.push(...card.textures.map(texture => ({ ...texture, from: time + texture.from,
      reveal: texture.reveal?.map(frame => ({ ...frame, at: time + frame.at })) })))
    for (const point of card.caret) key(time + point.at, { x: point.x + view.x, y: point.y + view.y, radius: 9,
      directionX: 1, directionY: 0, stretch: 0, alpha: 1 })
    time += card.duration
    key(time, pose)
  }
  if (detailedCards < cards.length) {
    // Finish the remaining known cards together without accelerating their text
    // or scheduling more flights. All textures stay on the same overview plane.
    for (const [index, card] of cards.slice(detailedCards).entries()) {
      phases.push({ at: time, name: `fade:${detailedCards + index}` })
      textures.push(...card.textures.map(texture => ({ ...texture, from: time, reveal: undefined, fadeIn: 240 })))
    }
    key(time, pose)
    time += 240
    key(time, pose)
  }
  phases.push({ at: time, name: 'return' })
  fly(dock, 520, dock.radius)
  key(time, { ...pose, radius: dock.radius, width: dock.radius * 2, height: dock.radius * 2 })
  phases.push({ at: time, name: 'waiting-host' })
  camera.push({ ...view, at: time })
  return { duration: time, poses, textures, phases, camera: viewport ? camera : undefined, viewport }
}

/** The resident keeps its springs, expression and clocks while card geometry
 * takes over the visible silhouette. Returning restores that same resident. */
export function withGenerationCharacter(program: MotionProgram, dock: { x: number; y: number; radius: number },
  native: Omit<MotionMatrixFrame, 'at'>, destination: string, description: CharacterDescription): MotionProgram {
  const matrices = program.poses.map(({ at, pose }) => {
    // Geometry, rather than phase lookup, disambiguates equal-time cuts from
    // the full card to its caret. Keep the live resident throughout typesetting.
    const opacity = 1 - smoothStep((pose.shapeMix ?? 0) / .08)
    const scale = pose.radius / dock.radius
    return { at, a: native.a * scale, b: native.b * scale, c: native.c * scale, d: native.d * scale,
      e: pose.x + (native.e - dock.x) * scale, f: pose.y + (native.f - dock.y) * scale, opacity }
  })
  const poses = program.poses.map(frame => ({ ...frame,
    pose: { ...frame.pose, alpha: (frame.pose.shapeMix ?? 0) > 0 ? frame.pose.alpha : 0 } }))
  return { ...program, poses, character: { destination, description, matrices, aimAt: program.duration, aboveTextures: true } }
}
