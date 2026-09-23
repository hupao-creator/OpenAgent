# Harness plugin packages

首次新增仓库内插件，请按 [Harness Plugin 开发指南](HARNESS_PLUGIN_GUIDE.md)
完成最小实现、注册、运行与验证；本页维护包边界和注册规则。

Harness plugins are workspace packages under `packages/harness-<id>/`. Shared
contracts live in `packages/openagent-contracts/` (published as
`@openagent/contracts`); host-owned shared primitives live in
`packages/openagent-plugin-kit/` (`@openagent/plugin-kit`). Core
(`apps/desktop/src/`) never imports `@openagent/harness-*` directly — the only
exception is the generated registry
(`apps/desktop/src/generated/harness-registry*.ts`).

The project has not launched. State loading accepts only the current schema and
active Harness composition. Do not add compatibility adapters, automatic state
migration, archived-state backups, or fallback settings for retired plugins.

## Package layout

Each `packages/harness-<id>/` directory is one provider-specific Harness
plugin. Core owns the plugin contracts and composition roots; a provider owns
everything below its package. Every provider uses the same top-level source
boundaries:

```text
packages/harness-<id>/
├── package.json   # exports: ".", "./manifest", "./main", "./renderer"
└── src/
    ├── manifest.ts # Default-exports the one process-neutral descriptor
    ├── shared/    # Process-neutral descriptor, settings types, and durable state
    ├── main/      # Main plugin entry point and provider capabilities
    │   ├── runtime/ # Native CLI, process, protocol, and server integration
    │   └── thread/  # Harness Thread lifecycle adaptation lives in main/thread
    ├── bart/    # Optional context and telemetry helpers
    └── renderer/  # Provider-owned thread, overview, and settings UI
```

## Dependency rules

- `src/shared/` must remain process-neutral. It may depend on
  `@openagent/contracts` and `@openagent/plugin-kit/shared`, but never on
  `main/`, `renderer/`, Electron, or Node-only APIs.
- `src/main/` may depend on `shared/`, the Core Main plugin contract in
  `@openagent/contracts`, and Main-side primitives from
  `@openagent/plugin-kit`. Native CLI and protocol details live in
  `main/runtime/`; Thread lifecycle adaptation lives in `main/thread/`.
  Prompt completion, settings resolution, and tool bridges remain direct Main
  plugin capabilities.
- `src/bart/` may depend on `shared/` and the Core Bart contract in
  `@openagent/contracts`, with shared Bart policy and telemetry helpers from
  `@openagent/plugin-kit/bart` (or `/bart/main` for Node hashing). It must not
  import provider renderer code. It ships
  inside the Main module bundle rather than as a separate package entry.
- `src/renderer/` may depend on `shared/`, the Core renderer contracts in
  `@openagent/contracts`, and renderer primitives from
  `@openagent/plugin-kit`. It must not import provider Main or Bart code.
- Packages must not import another Harness plugin package. Cross-provider
  behavior belongs in a Core composition layer.

A boundary may contain additional subdirectories when its implementation
grows, without changing the public layout above.

`@openagent/contracts` owns DTOs, capability interfaces, and public boundary
validation, including the shared public-observation limits. Bart routing,
evaluation types/matching/formatting, and telemetry policy belong to `@openagent/plugin-kit/bart`;
they are not part of the contracts package. `@openagent/plugin-kit/bart/main`
owns evaluation acquisition and cache leases, consumed internally by Plugin Main.
Core receives final evaluation advice through `bartContextEntries.evaluation`; it
never transports native model catalogs, identity lists or evaluation generations.
Evaluation cannot restrict native legal configuration. Plugin Main disposal releases
the lease.

Main modules expose an explicit `availability.probe`, independent of settings
presentation and model-catalog loading. The Desktop composition resolves runtime
provider overrides once and supplies them through `HarnessPluginHostContext`.
Plugin-kit must not load `.env` or select an application-wide provider implicitly.

Session state and public observation share one commit boundary. Plugins expose
`sessionState.project(state)` and a pure `settle` transition for Core cleanup;
commands and native events call `context.sessionState.commit(state)`. The Host
never interprets private facts and persists each payload with its derived
observation in one Thread revision.

Main and Renderer share the internal Thread configuration profile and native
field definitions. Creation requests may instead expose Harness-owned presets;
the Harness resolves these into native settings. `settings.describe` supplies the Thread creation schema and
current legal choices; `resolveThreadSettings` performs normalization, merging
and native validation for GUI and Bart. Core supplies only task, workspace and
schedule fields. There is no separate Bart settings parser or configuration subset.
Native catalog choices in the schema are scoped examples: another target workspace
or executable may support different models and options. Static constraints remain
in the schema; the same resolver validates actual target-native choices for every
caller.

The descriptor declares `threadCapabilities` for instructions, Thread context,
per-send context and custom-tool modes. Core requires all three injection kinds
and `exclusive` tools to host Bart. Task targets need their ordinary availability,
independently of host qualification. Ordinary `openThread` accepts generic
`injection`, and its Handle owns native registration, bridging, interaction and
cleanup. `exclusive` limits exposed tools; native permission/question handling
continues through waiting-user and `respond`.

Settings content presence is supplied by the owning Harness through
`settings.hasThreadContent(sessionState)`. Core may use that boolean fact when
resolving and atomically guarding a settings update; it must not infer content
from the shape or nullness of opaque `sessionState`.

Shared renderer components receive optional host services through
`RendererCapabilitiesProvider`; they do not depend on `window.openAgent`.
Card owners register semantic spatial anchors (`status`, `excerpt-end`) through
`ThreadCardAnchorProvider`. Host animation code consumes these measurements and
registered visibility operations without reading another component's private
DOM structure or CSS geometry.

Harness-native modes own automatic approval. Pending permissions and questions
remain visible and actionable in overview cards, Thread detail and the Bart dock.
Bart does not evaluate or answer pending interactions in the background. Core
projection caches use Thread identity and column count.

Desktop persistence uses independent Thread, Report, settings, and UI records;
see [state persistence boundaries](../apps/desktop/docs/STATE_PERSISTENCE.md).

## Entry points

A plugin package exposes four entry points through its `package.json`
`exports` map, plus `./package.json` for metadata discovery. Each module entry
has `types` and `default` paths to built files under `dist/`:

- `.` is the process-neutral shared barrel.
- `./manifest` defaults to the pure `HarnessPluginDescriptor`. Its id must match
  the package suffix (`@openagent/harness-<id>`), using a lower-case letter
  followed by lower-case letters, digits or hyphens. The existing
  `shared/descriptor.ts` remains the single source of descriptor data.
  This entry must not import Main/Renderer implementations or perform I/O.
- `./main` defaults to one `HarnessMainPluginModule`.
- `./renderer` defaults to one `HarnessRendererPluginModule`.

The process entries may keep their existing named exports. Current packages use
small `src/main/entry.ts` and `src/renderer/entry.ts` barrels which default-export
the existing module and re-export its named API. Re-exports are supported; no
cross-package naming convention or declaration-text layout is required.

The generated registries use unique local import aliases, bind every module to
its package's expected id, and validate id, display name, generic Thread capabilities,
uniqueness and registry completeness before exposing the module arrays.

The module contract shapes are defined in `@openagent/contracts`:
`src/harness-module.ts` for the Main module and
`src/renderer/harness-module.ts` for the Renderer module. Concrete generic parameters stay inside
the owning package; the Host aggregates the type-erased modules and re-enters
provider types only at its provider-neutral JSON boundaries.

## Registering a new plugin

Adding a plugin never means editing a Core-owned provider list:

1. Create a new workspace package at `packages/harness-<id>/` with the layout
  and entry points above, depending on `@openagent/contracts` and
  `@openagent/plugin-kit`.
2. Declare it in `apps/desktop/package.json` `dependencies`. Declaration order
  is registration order — it drives both the generated registry and the UI
  ordering.
3. Regenerate the registry with `pnpm --dir apps/desktop generate:registry`.
  This command always runs dependency-ordered package builds first, then emits
  `apps/desktop/src/generated/harness-registry*.ts`. Build, typecheck, test and
  benchmark entry points call it explicitly, without relying on lifecycle hooks.
  Commit the generated files with the source changes.

Core code and tests need no changes for a new plugin. Runtime fields (Thread
records, service parameters) always carry the Harness id as a plain `string`;
the generated `HarnessId` union type is used only for registry indexing,
product settings, and IPC input validation (`isHarnessId` as the fallback).

## Harness verification assets

Plugin-owned verification lives inside the owning package; host policy and
shared contracts live in the Desktop app; test-only shared machinery lives in
`packages/test-kit/` (`@openagent/test-kit`, never imported by production code):

- `packages/harness-<id>/tests/` — every guarantee that holds only for this
  Harness (protocol, state, permissions, transport, telemetry payloads). Run
  them with `pnpm --filter @openagent/harness-<id> test`; root `pnpm test` and
  `pnpm typecheck` include every package through `pnpm -r`.
- `packages/harness-<id>/src/test-support/` (exported as `./test-support`) —
  the Harness's native test adapter (`HarnessNativeTestAdapter` from
  `@openagent/test-kit`): scenario capabilities, least-privilege/permissive
  Thread settings, native tool names and scenario dialect, recorder wrapper
  args, session identity, native model evidence parsing, and failure-scenario
  settings. Generic runners (`tests/bart-headless`,
  `tests/harness-injection-native.mjs`,
  `playgrounds/single-thread/capture-scenarios.mjs`) derive the registered set
  from `loadNativeTestAdapters()` — a registered Harness without an adapter is
  a named failure, never a silent skip. Production code must not import
  `./test-support`, and the adapter must not enter the production descriptor.
- Host policy tests express roles (Bart host, non-host, task target) through
  declared capabilities; see `docs/harness-verification-migration.md` for the
  ownership mapping and composition-variant verification.

## Build and development consistency

`scripts/build-packages.mjs` owns build scheduling; the registry generator only
validates metadata and aggregates it. TypeScript handles normal incremental
compilation. A local snapshot of actual `dist/` output hashes detects deleted or
modified artifacts, including non-exported modules. On the first build or an
invalid snapshot, the public `tsc --build --clean` command clears affected
incremental state; this supports inherited/JSONC configuration without depending
on the pre-TypeScript-7 JavaScript compiler API. Snapshots are recorded only after
successful builds. Asset copying remains part of each package's build script.

Both root and desktop-local `dev`, and desktop `test:watch`, start the package
watch coordinator. It builds before launching the desktop/test runner, watches
package source, assets and configuration, serializes rebuilds, and regenerates
metadata after successful builds. It ignores `dist/` and `node_modules/` changes
to avoid feedback loops and owns child process shutdown. Electron/Vite still
handles application rebuilds and renderer updates after package outputs change.

A declared Harness with missing or invalid exports/manifest is an error, never an
optional omission. Harness dependencies belong in `dependencies`, not only in
`devDependencies`. Discovery failures leave the prior registries untouched, and
unchanged generated files are not rewritten.

### Renderer resources

Import `@openagent/plugin-kit/renderer/styles.css` alongside the renderer entry
when hosting the shared cards, timeline, Markdown, interactions, or executable
settings controls. The package ships these structural styles; hosts supply the
CSS theme properties (colors, typography, timing, and card geometry). Desktop
Thread/Composer layout is owned by `components/thread-workspace.css`; the
Thread playground consumes that frame without loading the application shell or
overview stylesheet.

The kit's i18n engine includes reusable component vocabulary. Desktop product
copy lives in `src/renderer/src/translations.ts` and is injected by
`AppI18nProvider`; Harness catalogs remain in their packages. Standalone shared
components therefore do not depend on desktop settings/report/Bart copy.

## Harness property contracts

New Harness drivers follow the [M9 extension procedure](../apps/desktop/docs/property-governance.md#extending-and-changing-contracts) and [owner-specific fixture inventory](../apps/desktop/docs/harness-property-testing.md). Declare native capabilities and limits, assert public projections from independent fixture expectations, and retain fault/shrink/replay plus per-sample cleanup evidence. Pi is not yet part of the original three-Harness property baseline.
