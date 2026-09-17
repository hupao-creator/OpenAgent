import type { DeepReadonly, HarnessBartContextContributor } from '@openagent/contracts'
import type { BartEvaluationModelIdentity } from './evaluation-facts.js'
import { formatBartEvaluationFactsForNativeModels } from './evaluation-policy.js'
import type { BartEvaluationSource } from './evaluation-source.js'

/** Native model matching stays inside Plugin Kit; Core receives final advice. */
export function createBartEvaluationContext<Settings>(options: {
  readonly source: BartEvaluationSource
  readonly loadIdentities: (input: {
    readonly settings: DeepReadonly<Settings>
    readonly cwd: string
    readonly signal: AbortSignal
  }) => Promise<readonly BartEvaluationModelIdentity[]>
}): HarnessBartContextContributor<Settings> {
  return async ({ settings, cwd, signal }) => {
    signal.throwIfAborted()
    try {
      const loaded = await waitWithAbort(options.loadIdentities({ settings, cwd, signal }), signal)
      signal.throwIfAborted()
      validateIdentities(loaded)
      if (loaded.length === 0) return undefined
      const identities = structuredClone(loaded)
      const facts = await waitWithAbort(options.source.waitForBootstrap(identities.map(identity => [
        identity.selector,
        ...(identity.displayName ? [identity.displayName] : []),
        ...(identity.aliases ?? [])
      ]), signal), signal)
      signal.throwIfAborted()
      if (facts.availability !== 'available') return undefined
      return formatBartEvaluationFactsForNativeModels(facts, identities.map(identity => ({
        label: identity.displayName && identity.displayName !== identity.selector
          ? `${identity.selector} (${identity.displayName})`
          : identity.selector,
        identity
      })))
    } catch {
      // Advisory acquisition must not become a prerequisite for native settings.
      signal.throwIfAborted()
      return undefined
    }
  }
}

function validateIdentities(identities: readonly BartEvaluationModelIdentity[]): void {
  if (identities.length > 4096 || Buffer.byteLength(JSON.stringify(identities)) > 2 * 1024 * 1024) {
    throw new Error('Plugin evaluation identities exceed the bounded acquisition limit')
  }
  for (const identity of identities) {
    const values = [identity.selector, ...(identity.displayName === undefined ? [] : [identity.displayName]), ...(identity.aliases ?? [])]
    if ((identity.aliases?.length ?? 0) > 64 || values.some(value =>
      typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0') || Buffer.byteLength(value) > 1024
    )) throw new Error('Plugin evaluation identity must be a canonical bounded string')
  }
}

/** Cancel this contribution without taking ownership of shared source work. */
function waitWithAbort<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted)
      reject(signal.reason)
    }
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(value => {
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', aborted)
      reject(error)
    })
    if (signal.aborted) aborted()
  })
}
