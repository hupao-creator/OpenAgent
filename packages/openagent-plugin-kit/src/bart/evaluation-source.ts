import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BartEvaluationFactsSnapshot } from './evaluation-facts.js'
import { ArtificialAnalysisModelFacts } from './artificial-analysis-model-facts.js'
import { BartEvaluationFactsStore } from './evaluation-facts-store.js'

export interface BartEvaluationSource {
  waitForBootstrap(identities: readonly (readonly string[])[], signal: AbortSignal): Promise<BartEvaluationFactsSnapshot>
}

interface SharedClient {
  readonly facts: ArtificialAnalysisModelFacts
  readonly initialized: Promise<void>
  references: number
}
const clients = new Map<string, SharedClient>()
const closing = new Map<string, Promise<void>>()

/** The evaluation module owns this local cache, independently of Plugin directories. */
export function defaultBartEvaluationCacheRoot(): string {
  return join(process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches')
      : process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'OpenAgent', 'model-evaluation')
}

/** One bounded, serialized acquisition/store per cache root, released by Plugin Main. */
export function acquireBartEvaluationSource(cacheRoot = defaultBartEvaluationCacheRoot()): BartEvaluationSource & { dispose(): Promise<void> } {
  const key = resolve(cacheRoot)
  let client = clients.get(key)
  if (!client) {
    if (clients.size >= 32) throw new Error('Too many active model evaluation cache roots')
    const facts = new ArtificialAnalysisModelFacts({ store: new BartEvaluationFactsStore(key) })
    client = {
      facts,
      initialized: (closing.get(key) ?? Promise.resolve()).then(() => facts.initialize()),
      references: 0
    }
    clients.set(key, client)
  }
  client.references++
  const owned = client
  const lifecycle = new AbortController()
  const pending = new Set<Promise<BartEvaluationFactsSnapshot>>()
  let disposed = false
  let disposal: Promise<void> | undefined
  return {
    waitForBootstrap(identities, signal) {
      const combined = AbortSignal.any([signal, lifecycle.signal])
      const operation = (async () => {
        if (disposed) throw new Error('Plugin model evaluation source is disposed')
        await owned.initialized
        combined.throwIfAborted()
        return owned.facts.waitForBootstrap(identities, combined)
      })()
      pending.add(operation)
      void operation.finally(() => pending.delete(operation)).catch(() => undefined)
      return operation
    },
    dispose() {
      if (disposal) return disposal
      disposed = true
      lifecycle.abort(new Error('Plugin model evaluation source is disposed'))
      const drained = Promise.allSettled([...pending]).then(() => undefined)
      owned.references--
      if (owned.references > 0) return disposal = drained
      clients.delete(key)
      const operation = Promise.all([drained, owned.initialized.then(() => owned.facts.dispose())]).then(() => undefined)
      closing.set(key, operation)
      disposal = operation.finally(() => {
        if (closing.get(key) === operation) closing.delete(key)
      })
      return disposal
    }
  }
}
