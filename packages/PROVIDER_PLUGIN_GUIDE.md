# Provider Plugins

A Harness owns execution, native sessions and its built-in subscription. A Provider Plugin owns an independently connected model service. Native subscription catalogs and quota remain in the Harness; they are never fallback quota for an external service.

`@openagent/provider-*` packages export a pure `./manifest` descriptor and a `./main` module. The desktop registry generator discovers these packages from dependencies, separately from Harnesses. A Provider descriptor declares compatible Harness ids, versioned injection formats and supported connection scopes. The Harness module separately declares the formats and scopes it can apply; binding requires agreement.

`ProviderConnections` is the Main-process entry point. Create it with registered modules and connection configurations, then use `forHarness` to obtain access for a compatible Harness. The bound connection exposes generated injection configuration, resolved model identities and account telemetry. Service recognition, credential isolation, request coalescing, cancellation and telemetry caching stay inside this boundary. A caller does not assemble vendor requests or alias rules.

The first adapters support Harness-scoped connections, matching their current instance-scoped runtime configuration. The contract also represents Thread scope; selecting it on an unsupported pair fails explicitly. The module does not invent per-Thread isolation for an adapter that cannot provide it.

## Internal connection configuration

Set `OPENAGENT_PROVIDER_CONFIG` to a JSON file path. This is a Main-only internal entry point; no new settings UI is included.

```json
{
  "connections": [
    { "id": "work", "providerId": "deepseek", "apiKeyEnv": "WORK_DEEPSEEK_KEY", "model": "deepseek-flash", "scope": "harness" }
  ],
  "bindings": { "claude": "work", "codex": "work", "pi": "work" }
}
```

The credential is read from the named environment variable in Main. Do not put credentials in public settings or native session records. One connection reused by multiple Harnesses shares one account capacity pool; distinct connections retain independent state. Configuration is loaded at startup, so restart after changing it.

Without an explicit binding, Harness adapters can report their effective native backend. The registry recognizes a supported service by its endpoint, never by model names. This discovery is read-only. Unknown backends remain unknown, and failed Provider telemetry must not invoke native subscription quota. An explicit binding always takes precedence.

## Injection and evaluation

Providers generate native configuration for a declared injection format. Harnesses validate and apply it in their own isolated runtime directories and retain control of process lifecycle. The Host contains no DeepSeek-specific injection branches.

Call identifiers remain unchanged in API requests. `evaluationRelease` names the actual canonical evaluation release; null means unmeasured and suppresses name-based fallback. The same resolved identity drives both AA acquisition and final context matching. Reasoning/effort evaluation configurations remain separate facts. DeepSeek mappings include source and verification time and are updated with the plugin. V4 Pro 0813 maps to the AA `deepseek-v4-pro` release, distinct from the older `deepseek-v4-pro-0424` release.

## Test Provider

`@openagent/provider-mock` implements the same contract against the local scripted LLM server. It is marked test-only, accepts only an HTTP `127.0.0.1` origin with an explicit port, and is excluded from production configuration. Headless tests opt in explicitly. Its native injection, configurable model id and HTTP account telemetry exercise the same binding path as real providers.

Use `mockProviderAccess` from the test kit for fixtures and the native injection acceptance runner for actual CLI requests, tool continuation, disposal and resume. Deterministic mock evidence establishes adapter behavior; it does not claim that a live service was exercised.
