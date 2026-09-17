/** Internal spatial references used during resource preparation. */
export type BartAnchorRef =
  | { type: 'dock' }
  | { type: 'thread'; threadId: string; attach?: 'center' | 'edge' | 'status' | 'excerpt-end' }
  /** 已解析的内容平面坐标点。 */
  | { type: 'point'; x: number; y: number }

export type BartRouteSpec =
  | { mode: 'overfly'; arc?: 'current' | 'short' }
  | {
      mode: 'avoid'
      obstacleKinds?: readonly ['thread-card']
      clearancePx?: number
      fallback: 'overfly'
    }
