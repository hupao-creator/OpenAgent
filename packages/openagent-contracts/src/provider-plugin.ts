import type { JsonObject } from './agent-core/values.js'
import type { BartTelemetrySnapshot } from './bart-telemetry.js'

/** Main-process connection configuration. Never serialize credentials into Thread state. */
export interface ProviderConnectionConfiguration {
  readonly id: string
  readonly providerId: string
  readonly apiKey: string
  readonly model?: string
  readonly baseUrl?: string
  readonly scope?: 'harness' | 'thread'
}

export interface ProviderHarnessTarget {
  readonly harnessId: string
  readonly format: string
  readonly scopes: readonly ('harness' | 'thread')[]
}

export interface ProviderPluginDescriptor {
  readonly id: string
  readonly displayName: string
  readonly testOnly?: boolean
  readonly harnesses: readonly ProviderHarnessTarget[]
}

/** Provider-generated native configuration; the Harness owns applying it and launching. */
export interface ProviderInjection {
  readonly format: string
  readonly environment: Readonly<Record<string, string>>
  readonly configuration: JsonObject
  readonly model: string
  readonly modelAliases?: Readonly<Record<string, string>>
}

export interface ProviderModelIdentity {
  readonly selector: string
  readonly displayName: string
  /** Null is authoritative absence of a known evaluation release, never a fuzzy-match fallback. */
  readonly evaluationRelease: string | null
  readonly source: string
  readonly verifiedAt: string
}

/** Harness-observed effective backend. Absence of evidence does not establish a subscription. */
export type HarnessBackendObservation =
  | { readonly kind: 'native' }
  | { readonly kind: 'unknown' }
  | {
    readonly kind: 'external'
    readonly baseUrl?: string
    readonly apiKey?: string
    readonly model?: string
    readonly modelAliases?: Readonly<Record<string, string>>
  }

export interface ProviderPluginHost {
  readonly fetch: (url: string | URL, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>
  readonly now: () => number
}

/** One service connection hides vendor policy, native injection recipes and account protocols. */
export interface ProviderConnection {
  readonly models: readonly ProviderModelIdentity[]
  injection(harnessId: string): ProviderInjection
  identify(selector: string, harnessId: string): ProviderModelIdentity
  readTelemetry(signal: AbortSignal): Promise<BartTelemetrySnapshot>
}

export interface ProviderPluginModule {
  readonly descriptor: ProviderPluginDescriptor
  /** Recognize the service, not a model name or a credential's spelling. */
  recognizes(observation: HarnessBackendObservation): boolean
  connect(configuration: ProviderConnectionConfiguration, host: ProviderPluginHost): ProviderConnection
}

/** Bound, credential-opaque account authority shared by compatible Harnesses. */
export interface ProviderBinding {
  readonly kind: 'provider'
  readonly providerId: string
  readonly connectionId: string
  readonly scope: 'harness' | 'thread'
  readonly models: readonly ProviderModelIdentity[]
  /** Only explicit bindings inject. Discovery observes native configuration without rewriting it. */
  readonly injection?: ProviderInjection
  identify(selector: string): ProviderModelIdentity
  readTelemetry(signal: AbortSignal): Promise<BartTelemetrySnapshot>
}

export type HarnessBackend = ProviderBinding | { readonly kind: 'native' } | { readonly kind: 'unknown' }

export interface HarnessProviderAccess {
  readonly explicit?: ProviderBinding
  resolve(observation: HarnessBackendObservation): HarnessBackend
}
