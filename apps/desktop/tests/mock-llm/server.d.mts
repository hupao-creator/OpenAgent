import type { ProviderConnectionConfiguration } from '@openagent/contracts'

export function createAcceptanceLlm(options?: {
  artifactPath?: string
  beforeReply?: (request: unknown) => unknown
  model?: string
  apiKey?: string
  remaining?: number
}): Promise<{
  readonly url: string
  readonly connection: ProviderConnectionConfiguration
  readonly accountRequests: number
  close(): Promise<void>
}>
