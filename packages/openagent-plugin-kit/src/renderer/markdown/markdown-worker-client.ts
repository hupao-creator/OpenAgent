import type {
  MarkdownWorkerRequest,
  MarkdownWorkerResponse
} from './markdown-worker-types.js'

type Listener = (response: MarkdownWorkerResponse) => void
type LocalProcessor = import('./incremental-markdown.js').IncrementalMarkdownProcessor

let worker: Worker | undefined
const listeners = new Map<string, Listener>()
const localProcessors = new Map<string, LocalProcessor>()
const localQueues = new Map<string, Promise<void>>()

function getWorker(): Worker | undefined {
  if (typeof Worker === 'undefined') return undefined
  if (!worker) {
    worker = new Worker(new URL('./markdown.worker.js', import.meta.url), {
      type: 'module',
      name: 'openagent-markdown'
    })
    worker.onmessage = (event: MessageEvent<MarkdownWorkerResponse>): void => {
      listeners.get(event.data.clientId)?.(event.data)
    }
  }
  return worker
}

export function subscribeMarkdownWorker(clientId: string, listener: Listener): () => void {
  listeners.set(clientId, listener)
  return () => {
    if (listeners.get(clientId) === listener) listeners.delete(clientId)
  }
}

export function postMarkdownWorker(request: MarkdownWorkerRequest): void {
  const sharedWorker = getWorker()
  if (sharedWorker) {
    sharedWorker.postMessage(request)
    return
  }
  runLocal(request)
}

function runLocal(request: MarkdownWorkerRequest): void {
  if (request.type === 'cancel') {
    localProcessors.delete(request.clientId)
    localQueues.delete(request.clientId)
    return
  }
  // Serialized per client. Loading the processor yields, and an unanswered
  // request must never be rendered against a processor a later one replaced.
  const queued = localQueues.get(request.clientId) ?? Promise.resolve()
  localQueues.set(
    request.clientId,
    queued.then(async () => {
      if (!listeners.has(request.clientId)) return
      try {
        let processor = localProcessors.get(request.clientId)
        if (!processor || request.reset) {
          const { IncrementalMarkdownProcessor } = await import('./incremental-markdown.js')
          processor = new IncrementalMarkdownProcessor()
          localProcessors.set(request.clientId, processor)
        }
        const result = processor.render(request.content, request.reset, {
          mermaid: request.mermaid
        })
        listeners.get(request.clientId)?.({
          type: 'rendered',
          clientId: request.clientId,
          revision: request.revision,
          reset: request.reset,
          operations: result.operations,
          metrics: result.metrics
        })
      } catch (error) {
        listeners.get(request.clientId)?.({
          type: 'error',
          clientId: request.clientId,
          revision: request.revision,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    })
  )
}
