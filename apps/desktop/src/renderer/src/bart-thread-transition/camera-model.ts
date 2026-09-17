import type { CameraGeometry } from './transitions'

export interface CapturedEye {
  x: number; y: number; width: number; height: number; radius: number
  matrix: number[]
  target: boolean
}

/** Prepared facts only. DOMMatrix and Path2D are rebuilt in the animation Worker. */
export interface CameraDive {
  body: CameraGeometry
  eye: CameraGeometry
  shapes: { path: string; matrix: number[]; fill: string; opacity: number; eye?: CapturedEye }[]
  dock: { x: number; y: number; width: number; height: number }
  background: string
  sessionBackground: string
  inside: boolean
}
