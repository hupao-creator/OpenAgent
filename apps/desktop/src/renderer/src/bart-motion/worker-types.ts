import type { MotionTimeline } from './motion-timeline'
import type { DispatchDescription } from './dispatch-canvas'
import type { BartWebGLPose } from './webgl-renderer'
import type { BartLogoActivity, BartLogoPhase, BartLogoLayout, BartInterventionVisualState } from './character-model'
import type { CameraDive } from '../bart-thread-transition/camera-model'
import type { CameraFrame } from '../overview-motion/camera-track'

export interface CharacterDescription {
  activity: BartLogoActivity
  phase: BartLogoPhase
  key?: string
  layout?: BartLogoLayout
  intervention?: BartInterventionVisualState
  role?: string
  animate?: boolean
  eyeMotion?: { key: number; duration: number; points: readonly { at: number; x: number; y: number; scaleX?: number; scaleY?: number }[] }
  travelTrail?: { key: number; duration: number; style: 'streaks' | 'wake';
    points: readonly { at: number; direction: number; strength: number }[] }
}

/** Internal, prepared scene data. No DOM nodes, callbacks, or Host continuations. */
export interface MotionRect { x: number; y: number; width: number; height: number }
export interface MotionPoseFrame { at: number; pose: BartWebGLPose }
export interface MotionMatrixFrame { at: number; a: number; b: number; c: number; d: number; e: number; f: number; opacity?: number }
export interface MotionRevealFrame { at: number; x: number; top: number; bottom: number; feather?: number }
export interface MotionTexture {
  id: string
  rect: MotionRect
  from: number
  /** Fade a complete card when the batch has exhausted its writing budget. */
  fadeIn?: number
  /** Optional inclusive endpoint for a decoration visible only at departure/return. */
  until?: number
  /** A completed texture remains visible until Host acknowledges the whole scene. */
  reveal?: readonly MotionRevealFrame[]
}
export interface MotionProgram {
  duration: number
  cameraDive?: CameraDive
  poses: readonly MotionPoseFrame[]
  textures: readonly MotionTexture[]
  phases: readonly { at: number; name: string }[]
  /** Root-relative motion of the real overview plane and its prepared textures. */
  camera?: readonly CameraFrame[]
  viewport?: MotionRect
  character?: {
    destination: string
    aimAt: number
    description: CharacterDescription
    matrices: readonly MotionMatrixFrame[]
    /** Typesetting character stays above the revealed card textures. */
    aboveTextures?: boolean
  }
}
export interface MotionRuntimeStats {
  surfaces: number
  gpuSurfaces: number
  pixels: number
  textureBytes: number
  textures: number
  draws: number
  scheduled: boolean
  visible: number
}
export type MotionWorkerRequest =
  | { type: 'inspect'; surface: string }
  | { type: 'attach'; surface: string; canvas: OffscreenCanvas; width: number; height: number; pixelRatio: number; kind: 'scene' | 'raster-scene' | 'character' }
  | { type: 'load'; surface: string; request: number; assets: { id: string; bitmap: ImageBitmap }[] }
  | { type: 'borrow-character'; surface: string; source: string; request: number }
  | { type: 'land-character'; surface: string; run: number; request: number }
  | { type: 'play'; surface: string; run: number; program: MotionProgram }
  | { type: 'redirect'; surface: string; previous: number; run: number; timeline: MotionTimeline;
      destination?: { id: string; description: CharacterDescription } }
  | { type: 'character'; surface: string; description: CharacterDescription; request: number }
  | { type: 'visibility'; surface: string; visible: boolean }
  | { type: 'resize'; surface: string; width: number; height: number; pixelRatio?: number }
  | { type: 'dispatch'; surface: string; description: DispatchDescription; request: number }
  | { type: 'release'; surface: string; run: number }
  | { type: 'detach'; surface: string }
export type MotionWorkerResponse =
  | { type: 'inspected'; surface: string; stats: MotionRuntimeStats }
  | { type: 'attached'; surface: string }
  | { type: 'loaded'; surface: string; request: number }
  | { type: 'rejected'; surface: string; request: number; message: string }
  | { type: 'started'; surface: string; run: number; elapsed: number; origin: number }
  | { type: 'performed'; surface: string; run: number; elapsed: number }
  | { type: 'phase'; surface: string; run: number; elapsed: number; name: string }
  | { type: 'failed'; surface: string; message: string }
