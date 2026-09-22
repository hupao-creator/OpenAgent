import { createHmac, randomBytes } from 'node:crypto'
import type {
  BartTelemetrySnapshot, HarnessBackendObservation, HarnessProviderAccess,
  ProviderBinding, ProviderConnection, ProviderConnectionConfiguration,
  ProviderHarnessTarget, ProviderPluginHost, ProviderPluginModule
} from '@openagent/contracts'

interface Account {
  readonly configuration: ProviderConnectionConfiguration
  readonly plugin: ProviderPluginModule
  readonly connection: ProviderConnection
  cached?: BartTelemetrySnapshot
  pending?: Promise<BartTelemetrySnapshot>
}

/**
 * The Main-only connection boundary. Callers bind once and consume facts; this
 * module owns discovery, compatibility, account isolation, coalescing and cancellation.
 * Native subscriptions never become entries in this registry.
 */
export class ProviderConnections {
  private readonly plugins = new Map<string, ProviderPluginModule>()
  private readonly accounts = new Map<string, Account>()
  private readonly secret = randomBytes(32)
  private readonly lifecycle = new AbortController()
  private readonly host: ProviderPluginHost

  constructor(
    plugins: readonly ProviderPluginModule[],
    configurations: readonly ProviderConnectionConfiguration[] = [],
    host: Partial<ProviderPluginHost> = {}
  ) {
    this.host = { fetch: host.fetch ?? fetch, now: host.now ?? Date.now }
    for (const plugin of plugins) {
      const id = plugin.descriptor.id
      if (!id || this.plugins.has(id)) throw new Error('Duplicate or invalid Provider registration')
      this.plugins.set(id, plugin)
    }
    for (const configuration of configurations) {
      if (!configuration.id || configuration.id.startsWith('discovered:') || this.accounts.has(configuration.id)) {
        throw new Error('Duplicate or invalid Provider connection id')
      }
      if (!configuration.apiKey?.trim()) throw new Error('Provider connection requires a credential')
      this.open({ ...configuration })
    }
  }

  forHarness(target: ProviderHarnessTarget, connectionId?: string): HarnessProviderAccess {
    this.lifecycle.signal.throwIfAborted()
    const explicit = connectionId === undefined ? undefined : this.accounts.get(connectionId)
    if (connectionId !== undefined && !explicit) throw new Error('Unknown Provider connection')
    const binding = explicit ? this.bind(explicit, target, true) : undefined
    return {
      ...(binding ? { explicit: binding } : {}),
      resolve: observation => {
        this.lifecycle.signal.throwIfAborted()
        if (binding) return binding
        if (observation.kind !== 'external') return { kind: observation.kind }
        const matches = [...this.plugins.values()].filter(plugin => plugin.recognizes(observation))
        if (matches.length !== 1) return { kind: 'unknown' }
        const plugin = matches[0]!
        // Account identity excludes model and Harness: the same credential at
        // the same service shares one balance. The HMAC never exposes the key.
        const id = 'discovered:' + createHmac('sha256', this.secret)
          .update(JSON.stringify([plugin.descriptor.id, new URL(observation.baseUrl!).origin, observation.apiKey ?? '']))
          .digest('hex')
        const account = this.accounts.get(id) ?? this.open({
          id, providerId: plugin.descriptor.id,
          apiKey: observation.apiKey ?? '', baseUrl: observation.baseUrl
        })
        return this.bind(account, target, false, observation)
      }
    }
  }

  dispose(): void {
    this.lifecycle.abort(new Error('Provider connections disposed'))
    this.accounts.clear()
  }

  private open(configuration: ProviderConnectionConfiguration): Account {
    const plugin = this.plugins.get(configuration.providerId)
    if (!plugin) throw new Error('Unregistered Provider')
    const account = { configuration, plugin, connection: plugin.connect(configuration, this.host) }
    this.accounts.set(configuration.id, account)
    return account
  }

  private bind(
    account: Account, target: ProviderHarnessTarget, explicit: boolean,
    observation?: Extract<HarnessBackendObservation, { kind: 'external' }>
  ): ProviderBinding {
    const support = account.plugin.descriptor.harnesses.find(entry =>
      entry.harnessId === target.harnessId && entry.format === target.format)
    const scope = account.configuration.scope ?? target.scopes.find(value => support?.scopes.includes(value))
    if (!support || !scope || !target.scopes.includes(scope) || !support.scopes.includes(scope)) {
      throw new Error('Provider and Harness do not support the configured injection or connection scope')
    }
    const injection = explicit ? account.connection.injection(target.harnessId) : undefined
    if (injection && injection.format !== target.format) throw new Error('Provider injection format mismatch')
    return Object.freeze({
      kind: 'provider' as const,
      providerId: account.configuration.providerId,
      connectionId: account.configuration.id,
      scope,
      models: account.connection.models,
      ...(injection ? { injection } : {}),
      identify: (selector: string) => {
        // Native short aliases are resolved using the effective Harness settings,
        // before asking the service what version it actually serves.
        const actual = observation?.modelAliases?.[selector] ?? injection?.modelAliases?.[selector] ??
          (selector === 'default' ? observation?.model ?? injection?.model ?? selector : selector)
        const identity = account.connection.identify(actual, target.harnessId)
        return { ...identity, selector }
      },
      readTelemetry: (signal: AbortSignal) => this.telemetry(account, signal)
    })
  }

  private async telemetry(account: Account, signal: AbortSignal): Promise<BartTelemetrySnapshot> {
    signal.throwIfAborted()
    this.lifecycle.signal.throwIfAborted()
    if (account.cached && this.host.now() - account.cached.observedAt < 15_000) return structuredClone(account.cached)
    if (!account.pending) {
      const pending = account.connection.readTelemetry(this.lifecycle.signal).catch((): BartTelemetrySnapshot => ({
        source: `${account.plugin.descriptor.displayName} account telemetry`, observedAt: this.host.now(),
        availability: 'error', windows: [], limitReached: null,
        error: 'Provider account telemetry is unavailable.',
        note: 'Capacity is unknown. Native subscription quota is not a substitute.'
      })).then(snapshot => {
        this.lifecycle.signal.throwIfAborted()
        account.cached = structuredClone(snapshot)
        return snapshot
      }).finally(() => { if (account.pending === pending) account.pending = undefined })
      account.pending = pending
    }
    return structuredClone(await withAbort(account.pending, signal))
  }
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(value => { signal.removeEventListener('abort', aborted); resolve(value) },
      error => { signal.removeEventListener('abort', aborted); reject(error) })
    if (signal.aborted) aborted()
  })
}
