import type { Properties } from 'hast'

export type MarkdownDomOperation =
  | { type: 'clear' }
  | {
      type: 'insert'
      parentId: number
      index: number
      node: MarkdownDomNode
    }
  | { type: 'remove'; parentId: number; index: number }
  | { type: 'set-text'; nodeId: number; value: string }
  | { type: 'set-properties'; nodeId: number; properties: Properties }
  | {
      type: 'update-mermaid'
      nodeId: number
      source: string
      closed: boolean
    }

export type MarkdownDomNode =
  | { id: number; type: 'text'; value: string }
  | { id: number; type: 'element'; tagName: string; properties: Properties }
  | {
      id: number
      type: 'mermaid'
      /** Chart text inside the fence, without the fence lines or container prefixes. */
      source: string
      /** A closing fence line exists and has been confirmed by a following newline. */
      closed: boolean
    }

interface MarkdownRenderRequest {
  type: 'render'
  clientId: string
  revision: number
  content: string
  reset: boolean
  /** When false, `mermaid` fences stay ordinary code and no chart is requested. */
  mermaid: boolean
}

interface MarkdownCancelRequest {
  type: 'cancel'
  clientId: string
}

export type MarkdownWorkerRequest = MarkdownRenderRequest | MarkdownCancelRequest

export interface MarkdownWorkerMetrics {
  parseDuration: number
  transformDuration: number
  diffDuration: number
  parsedChars: number
  reusedChars: number
  operationCount: number
}

export interface MarkdownRenderResponse {
  type: 'rendered'
  clientId: string
  revision: number
  reset: boolean
  operations: MarkdownDomOperation[]
  metrics: MarkdownWorkerMetrics
}

interface MarkdownErrorResponse {
  type: 'error'
  clientId: string
  revision: number
  message: string
}

export type MarkdownWorkerResponse = MarkdownRenderResponse | MarkdownErrorResponse
