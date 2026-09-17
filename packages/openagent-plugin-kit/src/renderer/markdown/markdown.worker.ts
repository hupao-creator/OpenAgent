/// <reference lib="webworker" />

import { IncrementalMarkdownProcessor } from './incremental-markdown.js'
import type {
  MarkdownWorkerRequest,
  MarkdownWorkerResponse
} from './markdown-worker-types.js'

const processors = new Map<string, IncrementalMarkdownProcessor>()

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>): void => {
  const request = event.data
  if (request.type === 'cancel') {
    processors.delete(request.clientId)
    return
  }

  try {
    let processor = processors.get(request.clientId)
    if (!processor || request.reset) {
      processor = new IncrementalMarkdownProcessor()
      processors.set(request.clientId, processor)
    }
    const result = processor.render(request.content, request.reset, {
      mermaid: request.mermaid
    })
    const response: MarkdownWorkerResponse = {
      type: 'rendered',
      clientId: request.clientId,
      revision: request.revision,
      reset: request.reset,
      operations: result.operations,
      metrics: result.metrics
    }
    self.postMessage(response)
  } catch (error) {
    const response: MarkdownWorkerResponse = {
      type: 'error',
      clientId: request.clientId,
      revision: request.revision,
      message: error instanceof Error ? error.message : String(error)
    }
    self.postMessage(response)
  }
}
