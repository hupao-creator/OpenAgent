import type { MotionProgram } from './worker-types'

/** Per window budgets. Rejection restores static business UI; it never falls back to a Host frame loop. */
export const MOTION_LIMITS = {
  surfaces: 96,
  gpuSurfaces: 2,
  surfacePixels: 16 * 1024 * 1024,
  softwareRasterPixels: 4096,
  textureBytes: 64 * 1024 * 1024,
  texturesPerSurface: 256,
  textureSide: 4096,
  programFrames: 32768,
  programDuration: 120000,
  preparationTimeout: 10000,
  sealTimeout: 2000,
  sceneCards: 16,
  queuedScenes: 8
} as const

export function validateMotionProgram(program: MotionProgram, assetIds: ReadonlySet<string>): void {
  if (!Number.isFinite(program.duration) || program.duration <= 0 || program.duration > MOTION_LIMITS.programDuration) {
    throw new Error('Bart program duration outside budget')
  }
  const frames = program.poses.length + program.phases.length + (program.camera?.length ?? 0) + (program.character?.matrices.length ?? 0) + program.textures.reduce((sum, texture) => sum + 1 + (texture.reveal?.length ?? 0), 0)
  if (frames > MOTION_LIMITS.programFrames) throw new Error('Bart program exceeds frame budget')
  const times = (values: readonly { at: number }[]): void => {
    let previous = -1
    for (const value of values) {
      if (!Number.isFinite(value.at) || value.at < previous || value.at < 0 || value.at > program.duration) {
        throw new Error('Bart program has invalid time order')
      }
      previous = value.at
    }
  }
  times(program.poses); times(program.phases)
  if (program.cameraDive) {
    const dive = program.cameraDive
    const matrix = (values: number[]): boolean => values.length === 6 && values.every(Number.isFinite)
    if (!assetIds.has('camera-overview') || !assetIds.has('camera-session') || !assetIds.has('camera-dock') || dive.shapes.length > 8 ||
      !dive.dock || !Object.values(dive.dock).every(Number.isFinite) || dive.dock.width <= 0 || dive.dock.height <= 0 ||
      ![dive.body, dive.eye].every(value => Object.values(value).every(Number.isFinite) && value.radius > 0 && value.width > 0 && value.height > 0) ||
      !dive.shapes.every(shape => matrix(shape.matrix) && shape.path.length < 65536 && Number.isFinite(shape.opacity) &&
        (!shape.eye || (matrix(shape.eye.matrix) && [shape.eye.x, shape.eye.y, shape.eye.width, shape.eye.height, shape.eye.radius].every(Number.isFinite))))) {
      throw new Error('Bart camera facts or assets are invalid')
    }
  }
  if (program.character) {
    const character = program.character
    times(character.matrices)
    if (!character.matrices.length || character.matrices[0].at !== 0 ||
      character.matrices.at(-1)!.at !== program.duration || !Number.isFinite(character.aimAt) ||
      character.aimAt < 0 || character.aimAt > program.duration ||
      !character.matrices.every(frame => Object.values(frame).every(Number.isFinite) &&
        (frame.opacity === undefined || frame.opacity >= 0 && frame.opacity <= 1))) throw new Error('Bart character flight is invalid')
  }
  if (program.camera) {
    times(program.camera)
    if (!program.camera.every(frame => Object.values(frame).every(Number.isFinite) && frame.scale > 0)) throw new Error('Bart camera is invalid')
  }
  if (program.viewport && (!Object.values(program.viewport).every(Number.isFinite) || program.viewport.width <= 0 || program.viewport.height <= 0)) throw new Error('Bart viewport is invalid')
  for (const frame of program.poses) {
    if (!Object.values(frame.pose).every(Number.isFinite) || frame.pose.radius <= 0) throw new Error('Bart pose is invalid')
  }
  for (const texture of program.textures) {
    if (!assetIds.has(texture.id)) throw new Error('Bart program references a missing texture')
    if (!Object.values(texture.rect).every(Number.isFinite) || texture.rect.width <= 0 || texture.rect.height <= 0 ||
      !Number.isFinite(texture.from) || texture.from < 0 || texture.from > program.duration) throw new Error('Bart texture placement is invalid')
    if (texture.until !== undefined && (!Number.isFinite(texture.until) || texture.until < texture.from || texture.until > program.duration)) throw new Error('Bart texture interval is invalid')
    if (texture.fadeIn !== undefined && (!Number.isFinite(texture.fadeIn) || texture.fadeIn <= 0 ||
      texture.from + texture.fadeIn > program.duration)) throw new Error('Bart texture fade is invalid')
    if (texture.reveal) {
      times(texture.reveal)
      if (!texture.reveal.every(frame => Object.values(frame).every(Number.isFinite) &&
        (frame.feather === undefined || frame.feather >= 0 && frame.feather <= 64))) throw new Error('Bart reveal is invalid')
    }
  }
}
