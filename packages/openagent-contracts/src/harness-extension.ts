import type { JsonValue } from './agent-core/values.js'

/**
 * Provider-neutral command envelope for optional Harness-owned control planes.
 * Core validates and transports this opaque JSON without interpreting it.
 */
export type { HarnessExtensionRequest } from './command-schemas.js'

export interface HarnessExtensionInvocation {
  readonly method: string
  readonly payload: JsonValue
  readonly signal: AbortSignal
}

export interface HarnessExtensionApi {
  invoke(request: HarnessExtensionInvocation): Promise<JsonValue>
  dispose?(): void | Promise<void>
}
